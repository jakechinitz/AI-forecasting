/**
 * AI Infrastructure Supply Chain - Calculation Engine
 *
 * CLEAN REWRITE (v33):
 * - FIX: GPU/Component "potential" is consistently PHYSICS-based (includes inventory for STOCK nodes).
 * - FIX: "unmetDemand" is consistently PHYSICS shortfall: Plan - PhysicsPotential.
 * - ADD: "unmetRealized" captures execution shortfall: Plan - Actual (blocked by anything).
 * - FIX: Component backlogs persist AND can clear (physics-based queue: backlog = max(0, backlog + plan - potential)).
 * - FIX: Training demand included in GPU requirement, and DC/Inference split respects training.
 * - ADD: Binding constraint recorded each month (which node is actually binding deploy).
 * - FIX: Scenario overrides for installed base/backlog/inventory are fully applied per node.
 */

import { NODES } from '../data/nodes.js';
import {
  GLOBAL_PARAMS,
  DEMAND_ASSUMPTIONS,
  EFFICIENCY_ASSUMPTIONS,
  TRANSLATION_INTENSITIES,
  getBlockKeyForMonth,
  calculateStackedYield,
  calculateSimpleYield
} from '../data/assumptions.js';

// ============================================
// 1. PHYSICS & ONTOLOGY
// ============================================

const PHYSICS_DEFAULTS = {
  flopsPerToken: 140e9,
  flopsPerGpu: 2e15,
  utilizationInference: 0.35,
  utilizationTraining: 0.50,
  secondsPerMonth: 2.6e6,
  hoursPerMonth: 720
};

const NODE_MAP = new Map(NODES.map(n => [n.id, n]));

const STOCK_NODES = new Set([
  'gpu_datacenter', 'gpu_inference',
  'hbm_stacks', 'dram_server', 'ssd_datacenter',
  'advanced_wafers', 'abf_substrate',
  'cpu_server', 'dpu_nic', 'switch_asics',
  'optical_transceivers', 'infiniband_cables',
  'rack_pdu', 'transformers_lpt', 'backup_power',
  'datacenter_mw'
]);

const THROUGHPUT_NODES = new Set([
  'cowos_capacity',
  'osat_capacity',
  'server_assembly',
  'hybrid_bonding',
  'liquid_cooling',
  'dc_construction',
  'euv_tools'
]);

const QUEUE_NODES = new Set([
  'grid_interconnect',
  'dc_ops_staff',
  'ml_engineers'
]);

const EXPECTED_UNITS = {
  'hbm_stacks': 'Stacks',
  'datacenter_mw': 'MW',
  'advanced_wafers': 'Wafers',
  'abf_substrate': 'Units',
  'cowos_capacity': 'Wafers/Month',
  'server_assembly': 'Servers/Month',
  'grid_interconnect': 'MW',
  'hybrid_bonding': 'Bonds/WaferOps'
};

function getNodeType(nodeId) {
  if (STOCK_NODES.has(nodeId)) return 'STOCK';
  if (THROUGHPUT_NODES.has(nodeId)) return 'THROUGHPUT';
  if (QUEUE_NODES.has(nodeId)) return 'QUEUE';
  return 'STOCK';
}

// ============================================
// 2. CORE UTILITIES
// ============================================

const EPSILON = 1e-10;

// “How fast do we try to close installed base gaps”
const CATCHUP_MONTHS = 24;

// Buffer policy (inventory target) — doesn’t affect PHYSICS potential,
// only affects inventory management for STOCK nodes.
const DEFAULT_BUFFER_MONTHS = 2;

// For GPU installed base backlog paydown (policy-ish)
const GPU_BACKLOG_PAYDOWN_MONTHS = 6;

// For component backlogs, we keep them physics-based; no special paydown needed.

function deepMerge(target, source) {
  if (!source) return target;
  if (!target) return source;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function resolveAssumptionValue(value, fallback) {
  return value ?? fallback ?? 0;
}

function sma(values, window) {
  if (values.length === 0) return 0;
  if (values.length < window) return values.reduce((a, b) => a + b, 0) / values.length;
  return values.slice(-window).reduce((a, b) => a + b, 0) / window;
}

function calculatePriceIndex(tightness) {
  const { a, b, minPrice, maxPrice } = GLOBAL_PARAMS.priceIndex;
  if (!Number.isFinite(tightness)) return 1;
  if (tightness >= 1) return Math.min(maxPrice, 1 + a * Math.pow(tightness - 1, b));
  return Math.max(minPrice, 1 - a * Math.pow(1 - tightness, b));
}

// ============================================
// 3. CAPACITY / YIELD
// ============================================

export function clearGrowthCache() {
  // No-op (run-scoped cache used)
}

function dateToMonth(dateStr) {
  const [year, month] = dateStr.split('-').map(Number);
  return (year - GLOBAL_PARAMS.startYear) * 12 + (month - GLOBAL_PARAMS.startMonth);
}

function applyRampProfile(capacityAdd, monthsSinceExpansion, profile, rampDuration) {
  const t = Math.min(monthsSinceExpansion / rampDuration, 1);
  if (profile === 'step') return capacityAdd;
  if (profile === 's-curve') return capacityAdd * (1 / (1 + Math.exp(-((t - 0.5) * 10))));
  return capacityAdd * t; // linear
}

export function calculateCapacity(node, month, scenarioOverrides = {}, dynamicExpansions = []) {
  let capacity = node.startingCapacity || 0;

  (node.committedExpansions || []).forEach(expansion => {
    const onlineMonth = dateToMonth(expansion.date) + (expansion.leadTimeMonths || 0);
    if (month >= onlineMonth) {
      capacity += applyRampProfile(
        expansion.capacityAdd,
        month - onlineMonth,
        node.rampProfile || 'linear',
        6
      );
    }
  });

  dynamicExpansions.forEach(exp => {
    if (month >= exp.month) {
      capacity += applyRampProfile(
        exp.capacityAdd,
        month - exp.month,
        node.rampProfile || 'linear',
        6
      );
    }
  });

  if (scenarioOverrides.supply?.affectedNodes?.includes(node.id)) {
    const shockMonth = scenarioOverrides.supply.shockMonth || 24;
    const reduction = scenarioOverrides.supply.capacityReduction || 0.5;
    if (month >= shockMonth && month < shockMonth + 12) {
      capacity *= (1 - reduction);
    }
  }

  return capacity;
}

function calculateNodeYield(node, month) {
  if (node.yieldModel === 'stacked') {
    return calculateStackedYield(
      node.yieldInitial || 0.65,
      node.yieldTarget || 0.85,
      node.yieldHalflifeMonths || 18,
      month
    );
  }
  return calculateSimpleYield(node.yieldSimpleLoss || 0.03);
}

function calcEffectiveCapacity(node, month, scenarioOverrides, dynamicExpansions) {
  const capacity = calculateCapacity(node, month, scenarioOverrides, dynamicExpansions);
  const y = calculateNodeYield(node, month);
  const util = node.maxCapacityUtilization || 0.95;
  return {
    capacityRaw: capacity,
    capacityEff: capacity * util * y,
    yieldRate: y
  };
}

// ============================================
// 4. DEMAND & EFFICIENCY (GPU REQUIREMENTS)
// ============================================

function getDemandBlockForMonth(month, assumptions) {
  const blockKey = getBlockKeyForMonth(month);
  return assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
}

function calculateInferenceDemand(month, demandBlock) {
  const segments = ['consumer', 'enterprise', 'agentic'];
  const demand = { total: 0 };
  segments.forEach(seg => {
    const base = resolveAssumptionValue(demandBlock?.workloadBase?.inferenceTokensPerMonth?.[seg], 0);
    const growth = resolveAssumptionValue(demandBlock?.inferenceGrowth?.[seg]?.value, 0);
    const value = base * Math.pow(1 + growth, month / 12);
    demand[seg] = value;
    demand.total += value;
  });
  return demand;
}

function calculateTrainingDemand(month, demandBlock) {
  const segments = ['frontier', 'midtier'];
  const demand = {};
  segments.forEach(seg => {
    const base = resolveAssumptionValue(demandBlock?.workloadBase?.trainingRunsPerMonth?.[seg], 0);
    const growth = resolveAssumptionValue(demandBlock?.trainingGrowth?.[seg]?.value, 0);
    demand[seg] = base * Math.pow(1 + growth, month / 12);
  });
  return demand;
}

function getEfficiencyMultipliers(month, assumptions, cache, warnings, warnedSet) {
  if (cache[month]) return cache[month];

  if (month === 0) {
    cache[0] = { M_inference: 1, M_training: 1, S_inference: 1, S_training: 1, H: 1 };
    return cache[0];
  }

  const prev = getEfficiencyMultipliers(month - 1, assumptions, cache, warnings, warnedSet);
  const blockKey = getBlockKeyForMonth(month);
  const block = assumptions?.[blockKey] || EFFICIENCY_ASSUMPTIONS[blockKey];

  // Model efficiency reduces compute per unit of work (cost down)
  const m_infer_annual = resolveAssumptionValue(block?.modelEfficiency?.m_inference?.value, 0.18);
  const m_train_annual = resolveAssumptionValue(block?.modelEfficiency?.m_training?.value, 0.10);

  // Systems/hardware increase throughput (capacity up)
  const s_infer_annual = resolveAssumptionValue(block?.systemsEfficiency?.s_inference?.value, 0.10);
  const h_annual = resolveAssumptionValue(block?.hardwareEfficiency?.h?.value, 0.15);

  const decay_inf = Math.pow(1 - m_infer_annual, 1 / 12);
  const decay_train = Math.pow(1 - m_train_annual, 1 / 12);
  const growth_sys_inf = Math.pow(1 + s_infer_annual, 1 / 12);
  const growth_hw = Math.pow(1 + h_annual, 1 / 12);

  const current = {
    M_inference: prev.M_inference * decay_inf,
    M_training: prev.M_training * decay_train,
    S_inference: prev.S_inference * growth_sys_inf,
    S_training: prev.S_training, // placeholder if you ever add it
    H: prev.H * growth_hw
  };

  // SAFETY: model efficiency multiplier should not increase (would imply worse efficiency)
  if (current.M_inference > prev.M_inference + 1e-9 && !warnedSet.has('eff_sign')) {
    warnings.push(`Sanity Check Fail (Month ${month}): M_inference increased. Check signs.`);
    warnedSet.add('eff_sign');
  }

  cache[month] = current;
  return current;
}

/**
 * Returns { total, inference, training } required GPUs (not split DC vs INF yet)
 */
function calculateRequiredGpusDetailed(month, demandAssumptions, efficiencyAssumptions, effCache, warnings, warnedSet, installedBaseTotal) {
  const block = getDemandBlockForMonth(month, demandAssumptions);

  const inferenceDemand = calculateInferenceDemand(month, block);
  const trainingDemand = calculateTrainingDemand(month, block);

  const eff = getEfficiencyMultipliers(month, efficiencyAssumptions, effCache, warnings, warnedSet);

  // -------- Inference GPUs --------
  const tokens = inferenceDemand.total;

  const flopsPerToken = PHYSICS_DEFAULTS.flopsPerToken;
  const flopsPerGpu = PHYSICS_DEFAULTS.flopsPerGpu;

  const rawFlopsPerGpuMonth =
    flopsPerGpu * PHYSICS_DEFAULTS.utilizationInference * PHYSICS_DEFAULTS.secondsPerMonth;

  // Inference cost: Tokens * (M) in numerator; throughput gains (S,H) in denominator
  const effectiveFlopsPerToken = flopsPerToken * eff.M_inference;
  const effectiveThroughputInference = rawFlopsPerGpuMonth * eff.S_inference * eff.H;

  const requiredInference = (tokens * effectiveFlopsPerToken) / Math.max(effectiveThroughputInference, EPSILON);

  // -------- Training GPUs --------
  // Demand specified as runs/month; intensity specified as GPU-hours per run (assumption)
  const hoursFrontier = resolveAssumptionValue(block?.workloadBase?.trainingComputePerRun?.frontier, 50e6);
  const hoursMidtier = resolveAssumptionValue(block?.workloadBase?.trainingComputePerRun?.midtier, 200000);

  const totalTrainingHours =
    (trainingDemand.frontier * hoursFrontier) + (trainingDemand.midtier * hoursMidtier);

  // Training capacity is GPU-hours/month * util, scaled by hardware efficiency H
  const effectiveGpuHoursPerGpuMonth = PHYSICS_DEFAULTS.hoursPerMonth * PHYSICS_DEFAULTS.utilizationTraining * eff.H;

  // Training compute per unit work reduced by M_training (multiplier in numerator)
  const requiredTraining =
    (totalTrainingHours * eff.M_training) / Math.max(effectiveGpuHoursPerGpuMonth, EPSILON);

  const total = requiredInference + requiredTraining;

  if (month === 0 && !warnedSet.has('calib_info')) {
    warnings.push(
      `INFO: Month 0 GPU Demand: ${formatNumber(total)} (Infer: ${formatNumber(requiredInference)}, Train: ${formatNumber(requiredTraining)}). Installed: ${formatNumber(installedBaseTotal)}.`
    );
    warnedSet.add('calib_info');

    const ratio = total / Math.max(installedBaseTotal, 1);
    if (ratio < 0.1 || ratio > 2.0) {
      warnings.push(`CALIBRATION ALARM: Demand (${formatNumber(total)}) is ${(ratio * 100).toFixed(0)}% of Installed Base.`);
    }
  }

  return { total, inference: requiredInference, training: requiredTraining };
}

// ============================================
// 5. INTENSITY MAP & PREFLIGHT
// ============================================

function buildIntensityMap() {
  const map = {};
  const gpuToComp = TRANSLATION_INTENSITIES.gpuToComponents;
  const serverToInfra = TRANSLATION_INTENSITIES.serverToInfra;

  const kwPerGpu = serverToInfra.kwPerGpu?.value || 1.0;
  const pue = serverToInfra.pue?.value || 1.3;
  const mwPerGpu = (kwPerGpu * pue) / 1000;

  map['hbm_stacks'] = gpuToComp.hbmStacksPerGpu?.value || 8;
  map['datacenter_mw'] = mwPerGpu;

  map['advanced_wafers'] = gpuToComp.advancedWafersPerGpu?.value || 0.3;
  map['abf_substrate'] = NODE_MAP.get('abf_substrate')?.inputIntensity || 0.02;

  map['cowos_capacity'] = gpuToComp.cowosWaferEquivPerGpu?.value || 0.3;

  const hbIntensity = gpuToComp.hybridBondingPerGpu?.value || 0.35;
  const hbShare = gpuToComp.hybridBondingPackageShare?.value || 0.2;
  map['hybrid_bonding'] = hbIntensity * hbShare;

  map['server_assembly'] = 1 / (serverToInfra.gpusPerServer?.value || 8);
  map['grid_interconnect'] = mwPerGpu;

  // Allow node-defined intensities to fill gaps
  NODES.forEach(node => {
    if (node.inputIntensity && !map[node.id]) map[node.id] = node.inputIntensity;
  });

  return map;
}

function runPreflightDiagnostics(map, warnings) {
  let errCount = 0;
  const gpuNode = NODE_MAP.get('gpu_datacenter');
  const gpuStartCap = gpuNode?.startingCapacity || 1;

  NODES.forEach(node => {
    const isEligible = node.group !== 'A' && !['gpu_datacenter', 'gpu_inference'].includes(node.id);
    const isMapped = !!map[node.id];

    if (isMapped && node.startingCapacity === 0 && node.startingInventory === 0 && (!node.committedExpansions || node.committedExpansions.length === 0)) {
      warnings.push(`PREFLIGHT ERROR: Node '${node.id}' starts at 0 and has no expansions. Will clamp sim.`);
      errCount++;
    }

    if (isEligible && !isMapped) {
      const type = getNodeType(node.id);
      if (type !== 'QUEUE') warnings.push(`PREFLIGHT WARNING: Node '${node.id}' is unmapped. It will not constrain.`);
    }
  });

  Object.keys(map).forEach(key => {
    const node = NODE_MAP.get(key);
    if (!node) {
      warnings.push(`PREFLIGHT ERROR: Intensity map references missing node '${key}'.`);
      errCount++;
      return;
    }

    if (node.group === 'A') warnings.push(`PREFLIGHT WARNING: Node '${key}' is mapped but Group A.`);

    if (EXPECTED_UNITS[key]) {
      if (!node.unit) {
        warnings.push(`PREFLIGHT ERROR: Node '${key}' missing unit. Expected '${EXPECTED_UNITS[key]}'.`);
        errCount++;
      } else if (node.unit !== EXPECTED_UNITS[key]) {
        warnings.push(`PREFLIGHT WARNING: Unit mismatch '${key}'. Found '${node.unit}', expected '${EXPECTED_UNITS[key]}'.`);
      }
    }

    const type = getNodeType(key);
    if (type === 'THROUGHPUT' && node.startingCapacity > 0 && map[key] > 0 && gpuStartCap > 0) {
      const impliedGpuSupport = node.startingCapacity / map[key];
      const ratio = impliedGpuSupport / gpuStartCap;
      if (ratio < 0.01 || ratio > 100) {
        warnings.push(`PREFLIGHT WARNING: Magnitude '${key}'. Implied support ${formatNumber(impliedGpuSupport)} vs GPU cap ${formatNumber(gpuStartCap)}.`);
      }
    }
  });

  if (errCount > 0) warnings.push(`PREFLIGHT: Found ${errCount} configuration errors.`);
}

// ============================================
// 6. MAIN SIM LOOP
// ============================================

export function runSimulation(assumptions, scenarioOverrides = {}) {
  const months = GLOBAL_PARAMS.horizonYears * 12;

  const results = {
    months: [],
    nodes: {},
    summary: { shortages: [], gluts: [] },
    warnings: [],
    bindingConstraint: [] // [{month, nodeId, reason, value}]
  };

  const nodeIntensityMap = buildIntensityMap();
  runPreflightDiagnostics(nodeIntensityMap, results.warnings);

  const warnedSet = new Set();

  const demandAssumptions = deepMerge(assumptions?.demand || DEMAND_ASSUMPTIONS, scenarioOverrides?.demand);
  const efficiencyAssumptions = deepMerge(assumptions?.efficiency || EFFICIENCY_ASSUMPTIONS, scenarioOverrides?.efficiency);

  const effCache = [];

  // ----- STATE INIT -----
  const nodeState = {};
  const startOverrides = scenarioOverrides?.startingState || {};

  // Allow per-node overrides:
  // startingState.installedBaseByNode = { gpu_datacenter: ..., gpu_inference: ... }
  // startingState.backlogByNode = { ... }
  // startingState.inventoryByNode = { ... }
  const installedBaseByNode = startOverrides.installedBaseByNode || {};
  const backlogByNode = startOverrides.backlogByNode || {};
  const inventoryByNode = startOverrides.inventoryByNode || {};

  NODES.forEach(node => {
    const type = getNodeType(node.id);

    const defaultInstalled =
      (node.id === 'gpu_datacenter') ? 1200000 :
      (node.id === 'gpu_inference') ? 300000 :
      0;

    const installedBase =
      (installedBaseByNode[node.id] !== undefined)
        ? installedBaseByNode[node.id]
        : defaultInstalled;

    const backlogInit =
      (backlogByNode[node.id] !== undefined)
        ? backlogByNode[node.id]
        : (node.startingBacklog || 0);

    const invDefault = (type === 'STOCK') ? (node.startingInventory || 0) : 0;
    const inventoryInit =
      (inventoryByNode[node.id] !== undefined)
        ? inventoryByNode[node.id]
        : invDefault;

    nodeState[node.id] = {
      type,
      inventory: inventoryInit,
      backlog: backlogInit,
      installedBase,
      dynamicExpansions: [],
      lastExpansionMonth: -Infinity,
      tightnessHistory: []
    };

    results.nodes[node.id] = {
      demand: [], supply: [], capacity: [], inventory: [], backlog: [],
      shortage: [], glut: [], tightness: [], priceIndex: [],
      installedBase: [], requiredBase: [], planDeploy: [], consumption: [],
      supplyPotential: [], potential: [], yield: [],
      unmetDemand: [], unmetRealized: [], // <- consistent across nodes
      gpuDelivered: [], idleGpus: [] // for GPU nodes
    };
  });

  // Helper: for workload “nodes” that are just metrics (if they exist in NODES)
  function pushWorkloadMetrics(nodeId, value) {
    const nodeRes = results.nodes[nodeId];
    if (!nodeRes) return;
    nodeRes.demand.push(value);
    nodeRes.supply.push(null);
    nodeRes.capacity.push(null);
    nodeRes.inventory.push(null);
    nodeRes.backlog.push(null);
    nodeRes.shortage.push(null);
    nodeRes.glut.push(null);
    nodeRes.tightness.push(null);
    nodeRes.priceIndex.push(null);
    nodeRes.installedBase.push(null);
    nodeRes.requiredBase.push(null);
    nodeRes.planDeploy.push(null);
    nodeRes.consumption.push(null);
    nodeRes.supplyPotential.push(null);
    nodeRes.potential.push(null);
    nodeRes.yield.push(null);
    nodeRes.unmetDemand.push(null);
    nodeRes.unmetRealized.push(null);
    nodeRes.gpuDelivered.push(null);
    nodeRes.idleGpus.push(null);
  }

  // ----- MONTH LOOP -----
  for (let month = 0; month < months; month++) {
    results.months.push(month);

    // ---- Demand drivers ----
    const demandBlock = getDemandBlockForMonth(month, demandAssumptions);
    const inferenceDemand = calculateInferenceDemand(month, demandBlock);
    const trainingDemand = calculateTrainingDemand(month, demandBlock);

    // If these are represented as nodes in your NODES file, keep them synced:
    pushWorkloadMetrics('training_frontier', trainingDemand.frontier);
    pushWorkloadMetrics('training_midtier', trainingDemand.midtier);
    pushWorkloadMetrics('inference_consumer', inferenceDemand.consumer);
    pushWorkloadMetrics('inference_enterprise', inferenceDemand.enterprise);
    pushWorkloadMetrics('inference_agentic', inferenceDemand.agentic);

    // ---- Required GPUs (detailed) ----
    const gpuState = nodeState['gpu_datacenter'];
    const infState = nodeState['gpu_inference'];
    const installedTotal = gpuState.installedBase + infState.installedBase;

    const req = calculateRequiredGpusDetailed(
      month,
      demandAssumptions,
      efficiencyAssumptions,
      effCache,
      results.warnings,
      warnedSet,
      installedTotal
    );

    // Training is overwhelmingly “DC” (clusters) — keep it there.
    // Inference GPUs split DC vs inference pool on the remaining inference requirement.
    const requiredDcBase = req.training + 0.7 * req.inference;
    const requiredInfBase = 0.3 * req.inference;

    // =======================================================
    // STEP 0: THE PLAN (GPU deployments)
    // =======================================================
    const dcGap = Math.max(0, requiredDcBase - gpuState.installedBase);
    const infGap = Math.max(0, requiredInfBase - infState.installedBase);

    const dcRetirements = gpuState.installedBase / 48;
    const infRetirements = infState.installedBase / 48;

    // GPU backlog is “unfulfilled baseline deployment” in GPU units
    const gpuBacklogPaydown = gpuState.backlog / GPU_BACKLOG_PAYDOWN_MONTHS;

    const planDeployDc = (dcGap / CATCHUP_MONTHS) + dcRetirements;
    const planDeployInf = (infGap / CATCHUP_MONTHS) + infRetirements;

    const baselinePlan = planDeployDc + planDeployInf;
    const planDeployTotal = baselinePlan + gpuBacklogPaydown;

    // =======================================================
    // STEP 1: PHYSICS POTENTIALS (per component)
    // Potential is ALWAYS physics max:
    //  - STOCK: inv + effCapacity
    //  - THROUGHPUT: effCapacity
    // =======================================================
    const potentials = {}; // component physics potential in component units

    NODES.forEach(node => {
      if (node.group === 'A') return;
      if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') return;

      const state = nodeState[node.id];
      const { capacityEff } = calcEffectiveCapacity(node, month, scenarioOverrides, state.dynamicExpansions);

      const physPotential = (state.type === 'STOCK')
        ? (state.inventory + capacityEff)
        : capacityEff;

      potentials[node.id] = physPotential;
    });

    // =======================================================
    // STEP 2: GATING (deploy GPUs limited by GPU availability & components)
    // =======================================================

    // 2.1 GPU physics availability
    const gpuNode = NODE_MAP.get('gpu_datacenter');
    const gpuEff = calcEffectiveCapacity(gpuNode, month, scenarioOverrides, gpuState.dynamicExpansions);

    const gpuAvailable = gpuState.inventory + gpuEff.capacityEff; // STOCK physics potential
    const demandCeiling = planDeployTotal;

    // 2.2 Component support (convert component potentials -> supported GPU deploys)
    let maxSupported = Infinity;
    let bindingComponent = null;

    Object.entries(nodeIntensityMap).forEach(([nodeId, intensity]) => {
      const pot = potentials[nodeId];
      if (pot === undefined || intensity <= 0) return;
      const supported = pot / intensity;
      if (supported < maxSupported) {
        maxSupported = supported;
        bindingComponent = nodeId;
      }
    });

    if (!Number.isFinite(maxSupported)) maxSupported = Infinity;

    // 2.3 Final deploy
    const deployBoundByPlan = demandCeiling;
    const deployBoundByGpu = gpuAvailable;
    const deployBoundByComponents = maxSupported;

    const actualDeployTotal = Math.min(deployBoundByPlan, deployBoundByGpu, deployBoundByComponents);

    // Track which constraint actually binds the deploy this month
    let bind = { month, nodeId: null, reason: null, value: null };
    if (actualDeployTotal + 1e-9 >= deployBoundByPlan && deployBoundByPlan <= deployBoundByGpu + 1e-9 && deployBoundByPlan <= deployBoundByComponents + 1e-9) {
      bind = { month, nodeId: 'plan', reason: 'plan_ceiling', value: deployBoundByPlan };
    } else if (deployBoundByGpu <= deployBoundByComponents + 1e-9 && deployBoundByGpu <= deployBoundByPlan + 1e-9) {
      bind = { month, nodeId: 'gpu_datacenter', reason: 'gpu_available', value: deployBoundByGpu };
    } else if (deployBoundByComponents <= deployBoundByGpu + 1e-9 && deployBoundByComponents <= deployBoundByPlan + 1e-9) {
      bind = { month, nodeId: bindingComponent, reason: 'component_support', value: deployBoundByComponents };
    }
    results.bindingConstraint.push(bind);

    // Invariant sanity check (kills teleportation silently)
    if (
      actualDeployTotal > deployBoundByPlan + 1e-6 ||
      actualDeployTotal > deployBoundByGpu + 1e-6 ||
      actualDeployTotal > deployBoundByComponents + 1e-6
    ) {
      results.warnings.push(
        `Invariant fail m=${month}: deploy=${actualDeployTotal} plan=${deployBoundByPlan} gpuAvail=${deployBoundByGpu} compSup=${deployBoundByComponents}`
      );
    }

    const blockedByComponents = Math.max(0, Math.min(deployBoundByPlan, deployBoundByGpu) - actualDeployTotal);

    // =======================================================
    // STEP 3: UPDATE GPU STOCKS / INSTALLED BASE
    // =======================================================

    // GPU production policy (STOCK):
    // produce enough to cover actual deploy + buffer.
    // (Physics is gpuEff.capacityEff; policy chooses how much of it you actually use.)
    const gpuBufferTarget = planDeployTotal * DEFAULT_BUFFER_MONTHS;
    const gpuProdTarget = actualDeployTotal + Math.max(0, gpuBufferTarget - gpuState.inventory);
    const gpuProduced = Math.min(gpuEff.capacityEff, gpuProdTarget);

    const preUpdateGpuInventory = gpuState.inventory;
    gpuState.inventory = (gpuState.inventory + gpuProduced) - actualDeployTotal;
    if (gpuState.inventory < -1e-6) {
      results.warnings.push(`Clamp: Negative GPU inventory at month ${month}.`);
      gpuState.inventory = 0;
    }

    // GPU backlog tracks “baseline plan not delivered”
    gpuState.backlog = Math.max(0, gpuState.backlog + baselinePlan - actualDeployTotal);

    // Split DC vs INF based on baselinePlan
    const shareDc = baselinePlan > EPSILON ? (planDeployDc / baselinePlan) : 0.7;
    const actualDc = actualDeployTotal * shareDc;
    const actualInf = actualDeployTotal * (1 - shareDc);

    const blockedDc = blockedByComponents * shareDc;
    const blockedInf = blockedByComponents * (1 - shareDc);

    gpuState.installedBase = Math.max(0, gpuState.installedBase + actualDc - dcRetirements);
    infState.installedBase = Math.max(0, infState.installedBase + actualInf - infRetirements);

    // GPU tightness / expansion
    const gpuPotentialPhysics = gpuAvailable; // inventory + eff cap (physics)
    const gpuTightness = baselinePlan / Math.max(gpuPotentialPhysics, EPSILON);
    const gpuPriceIndex = calculatePriceIndex(gpuTightness);

    gpuState.tightnessHistory.push(gpuTightness);

    if (sma(gpuState.tightnessHistory, 6) > 1.05 && (month - gpuState.lastExpansionMonth > 24)) {
      const expansionAmount = (gpuEff.capacityRaw || 0) * 0.20;
      const leadTime = gpuNode.leadTimeDebottleneck || 24;
      gpuState.dynamicExpansions.push({ month: month + leadTime, capacityAdd: expansionAmount });
      gpuState.lastExpansionMonth = month;
    }

    // Store GPU node series (PHYSICS-consistent)
    [gpuState, infState].forEach((state, idx) => {
      const isDcPool = idx === 0;
      const nodeId = isDcPool ? 'gpu_datacenter' : 'gpu_inference';
      const res = results.nodes[nodeId];

      const share = isDcPool ? shareDc : (1 - shareDc);
      const plan = planDeployTotal * share;
      const actual = isDcPool ? actualDc : actualInf;

      // Physics potential for GPUs this month is gpuAvailable (inventory+cap), then share.
      const potential = gpuPotentialPhysics * share;

      res.demand.push(plan);
      res.planDeploy.push(plan);
      res.supply.push(actual);
      res.consumption.push(actual);

      res.capacity.push(isDcPool ? gpuEff.capacityEff : 0);
      res.supplyPotential.push(potential);
      res.potential.push(potential);

      res.inventory.push(isDcPool ? gpuState.inventory : 0);
      res.backlog.push(gpuState.backlog * share);

      res.installedBase.push(state.installedBase);
      res.requiredBase.push(isDcPool ? requiredDcBase : requiredInfBase);

      res.tightness.push(gpuTightness);
      res.priceIndex.push(gpuPriceIndex);
      res.yield.push(isDcPool ? gpuEff.yieldRate : null);

      res.gpuDelivered.push(actual);
      res.idleGpus.push(isDcPool ? blockedDc : blockedInf);

      // Consistent definitions:
      res.unmetDemand.push(Math.max(0, plan - potential)); // PHYSICS shortfall
      res.unmetRealized.push(Math.max(0, plan - actual));  // Execution shortfall

      res.shortage.push(res.unmetRealized[res.unmetRealized.length - 1] > 0 ? 1 : 0);
      res.glut.push(0);
    });

    // =======================================================
    // STEP 4: UPDATE COMPONENT NODES (PHYSICS-FIRST)
    // - Potential is physics max.
    // - Backlog is physics queue: backlog = max(0, backlog + plan says need - physics could supply).
    // - Inventory evolves based on actual consumption (what the system used).
    // =======================================================

    NODES.forEach(node => {
      if (node.group === 'A') return;
      if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') return;

      const state = nodeState[node.id];
      const nodeRes = results.nodes[node.id];

      const intensity = nodeIntensityMap[node.id] || 0;

      // Plan demand in component units (based on plan GPU deploy)
      const demand = planDeployTotal * intensity;

      // Reality consumption in component units (based on actual GPU deploy)
      const consumption = actualDeployTotal * intensity;

      const eff = calcEffectiveCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
      const effectiveCapacity = eff.capacityEff;

      const inventoryIn = state.inventory;
      const backlogIn = state.backlog;

      // Physics potential supply (component units)
      const potentialSupply = (state.type === 'STOCK')
        ? (inventoryIn + effectiveCapacity)
        : effectiveCapacity;

      // Actual delivered-to-system is limited by consumption (system uses what it uses)
      // and by what exists/flows.
      const deliveredToSystem = Math.min(consumption, potentialSupply);

      // Inventory update for STOCK nodes: assume production is available up to effectiveCapacity.
      // We don’t need a “policy throttle” here because potential is physics and inventory is just accounting.
      if (state.type === 'STOCK') {
        // Production uses full effective capacity (physics). Anything not consumed becomes inventory.
        const available = inventoryIn + effectiveCapacity;
        state.inventory = Math.max(0, available - deliveredToSystem);
      } else {
        state.inventory = 0;
      }

      // Physics backlog update: queue accumulates if plan demand exceeds physics potential supply.
      // Backlog clears when potential exceeds demand.
      state.backlog = Math.max(0, backlogIn + demand - potentialSupply);

      // Tightness uses total load (plan + queued) divided by physics potential.
      const totalLoad = demand + backlogIn;
      const tightness = totalLoad / Math.max(potentialSupply, EPSILON);
      const priceIndex = calculatePriceIndex(tightness);

      state.tightnessHistory.push(tightness);

      // Expansion logic: respond to persistent tightness (physics)
      if (sma(state.tightnessHistory, 6) > 1.10 && (month - state.lastExpansionMonth > 12)) {
        const baseCap = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
        const expansionAmount = baseCap * 0.20;
        const leadTime = node.leadTimeDebottleneck || 12;
        state.dynamicExpansions.push({ month: month + leadTime, capacityAdd: expansionAmount });
        state.lastExpansionMonth = month;
      }

      // Store series
      nodeRes.demand.push(demand);
      nodeRes.planDeploy.push(demand);

      nodeRes.consumption.push(consumption);
      nodeRes.supply.push(deliveredToSystem);

      nodeRes.capacity.push(effectiveCapacity);
      nodeRes.supplyPotential.push(potentialSupply);
      nodeRes.potential.push(potentialSupply);

      nodeRes.inventory.push(state.inventory);
      nodeRes.backlog.push(state.backlog);

      nodeRes.tightness.push(tightness);
      nodeRes.priceIndex.push(priceIndex);
      nodeRes.yield.push(eff.yieldRate);

      // Consistent definitions:
      nodeRes.unmetDemand.push(Math.max(0, demand - potentialSupply));          // PHYSICS shortfall vs plan
      nodeRes.unmetRealized.push(Math.max(0, demand - deliveredToSystem));      // what system “didn’t get” vs plan

      nodeRes.shortage.push(tightness > 1.05 ? 1 : 0);
      nodeRes.glut.push(0);

      nodeRes.installedBase.push(0);
      nodeRes.requiredBase.push(0);
      nodeRes.gpuDelivered.push(0);
      nodeRes.idleGpus.push(0);
    });
  }

  results.summary = analyzeResults(results);
  return results;
}

// ============================================
// 7. ANALYSIS & FORMATTING
// ============================================

function analyzeResults(results) {
  const shortages = [];
  const shortagePersistence = 3;

  Object.entries(results.nodes).forEach(([nodeId, data]) => {
    const node = NODE_MAP.get(nodeId);
    if (!node || node.group === 'A') return;

    let shortageStart = null, peakTightness = 0, shortageDuration = 0, consecShort = 0;

    data.shortage.forEach((isShort, month) => {
      const t = data.tightness[month] || 0;

      if (isShort === 1) {
        consecShort++;
        if (consecShort >= shortagePersistence) {
          if (shortageStart === null) shortageStart = month - shortagePersistence + 1;
          if (t > peakTightness) peakTightness = t;
          shortageDuration++;
        }
      } else {
        if (shortageStart !== null) {
          shortages.push({
            nodeId,
            nodeName: node.name,
            group: node.group,
            startMonth: shortageStart,
            peakTightness,
            duration: shortageDuration,
            severity: peakTightness * shortageDuration
          });
        }
        shortageStart = null;
        peakTightness = 0;
        shortageDuration = 0;
        consecShort = 0;
      }
    });

    if (shortageStart !== null) {
      shortages.push({
        nodeId,
        nodeName: node.name,
        group: node.group,
        startMonth: shortageStart,
        peakTightness,
        duration: shortageDuration,
        severity: peakTightness * shortageDuration
      });
    }
  });

  return { shortages: shortages.slice(0, 20), gluts: [], bottlenecks: [] };
}

export function formatMonth(monthIndex) {
  const year = GLOBAL_PARAMS.startYear + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[month - 1]} ${year}`;
}

export function formatNumber(num, decimals = 1) {
  if (num === null || num === undefined) return '-';
  if (Math.abs(num) >= 1e12) return (num / 1e12).toFixed(decimals) + 'T';
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(decimals) + 'B';
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(decimals) + 'M';
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
}
