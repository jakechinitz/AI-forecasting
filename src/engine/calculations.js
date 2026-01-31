/**
 * AI Infrastructure Supply Chain - Calculation Engine
 *
 * Rewritten (vNext) to address:
 *  - Demand wildly inconsistent with installed base (deterministic Month-0 demand scaling)
 *  - Inference demand collapsing to ~0 when blocks/paths are missing (hard fallbacks)
 *  - No “immediate shortage” when component pressure is inferred only from actual deployments
 *
 * Design:
 *  - We treat component “demand” as the PLAN (desired GPU deployments), while “supply” is what
 *    physics allows (capacity + yield + inventory).
 *  - Component backlog is tracked as a *planning backlog* (unmet plan vs true potential),
 *    which avoids circularity and makes constraints visible immediately.
 */

import { NODES, getNode, getChildNodes } from '../data/nodes.js';
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
// 1) PHYSICS & ONTOLOGY
// ============================================

const PHYSICS_DEFAULTS = {
  flopsPerToken: 140e9,    // token -> FLOPs (very rough)
  flopsPerGpu: 2e15,       // GPU FLOPs/s (rough “effective”)
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
  // Default to STOCK so it can carry inventory/backlog if it’s actually a stock node
  return 'STOCK';
}

// ============================================
// 2) CORE UTILITIES
// ============================================

const EPSILON = 1e-10;

// Planning knobs
const CATCHUP_MONTHS = 24;
const DEFAULT_BUFFER_MONTHS = 2;

// Aggressive urgency
const BACKLOG_PAYDOWN_MONTHS_GPU = 6;
const BACKLOG_PAYDOWN_MONTHS_COMPONENTS = 6;

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

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
  if (!values || values.length === 0) return 0;
  if (values.length < window) return values.reduce((a, b) => a + b, 0) / values.length;
  return values.slice(-window).reduce((a, b) => a + b, 0) / window;
}

function calculatePriceIndex(tightness) {
  const { a, b, minPrice, maxPrice } = GLOBAL_PARAMS.priceIndex || { a: 1.2, b: 2.2, minPrice: 0.65, maxPrice: 2.0 };
  if (!Number.isFinite(tightness)) return 1;
  if (tightness >= 1) return Math.min(maxPrice, 1 + a * Math.pow(tightness - 1, b));
  return Math.max(minPrice, 1 - a * Math.pow(1 - tightness, b));
}

// ============================================
// 3) DEMAND + EFFICIENCY HELPERS
// ============================================

export function clearGrowthCache() {
  // No-op (run-scoped cache used)
}

function getDemandBlockForMonth(month, assumptions) {
  const blockKey = getBlockKeyForMonth(month);
  return assumptions?.[blockKey] || DEMAND_ASSUMPTIONS?.[blockKey] || DEMAND_ASSUMPTIONS?.base || {};
}

function calculateInferenceDemand(month, demandBlock) {
  const segments = ['consumer', 'enterprise', 'agentic'];

  const out = { total: 0 };
  for (const seg of segments) {
    const base = resolveAssumptionValue(demandBlock?.workloadBase?.inferenceTokensPerMonth?.[seg], 0);
    const growth = resolveAssumptionValue(demandBlock?.inferenceGrowth?.[seg]?.value, 0);
    const value = base * Math.pow(1 + growth, month / 12);
    out[seg] = value;
    out.total += value;
  }

  // Hard fallback so charts never go to 0 unless explicitly configured that way
  if (!Number.isFinite(out.total) || out.total <= 0) {
    const fallback = 1e12; // 1T tokens/month “floor” to keep plots sane
    out.consumer = fallback;
    out.enterprise = 0;
    out.agentic = 0;
    out.total = fallback;
  }

  return out;
}

function calculateTrainingDemand(month, demandBlock) {
  const segments = ['frontier', 'midtier'];
  const out = {};
  for (const seg of segments) {
    const base = resolveAssumptionValue(demandBlock?.workloadBase?.trainingRunsPerMonth?.[seg], 0);
    const growth = resolveAssumptionValue(demandBlock?.trainingGrowth?.[seg]?.value, 0);
    out[seg] = base * Math.pow(1 + growth, month / 12);
  }
  return out;
}

export function calculateCapacity(node, month, scenarioOverrides = {}, dynamicExpansions = []) {
  let capacity = node?.startingCapacity || 0;

  (node?.committedExpansions || []).forEach(expansion => {
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

  // Optional supply shock
  if (scenarioOverrides?.supply?.affectedNodes?.includes(node.id)) {
    const shockMonth = scenarioOverrides.supply.shockMonth || 24;
    const reduction = scenarioOverrides.supply.capacityReduction || 0.5;
    if (month >= shockMonth && month < shockMonth + 12) {
      capacity *= (1 - reduction);
    }
  }

  return capacity;
}

function applyRampProfile(capacityAdd, monthsSinceExpansion, profile, rampDuration) {
  const t = Math.min(monthsSinceExpansion / rampDuration, 1);
  if (profile === 'step') return capacityAdd;
  if (profile === 's-curve') return capacityAdd * (1 / (1 + Math.exp(-((t - 0.5) * 10))));
  return capacityAdd * t; // linear
}

function dateToMonth(dateStr) {
  const [year, month] = String(dateStr || '').split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return 0;
  return (year - GLOBAL_PARAMS.startYear) * 12 + (month - GLOBAL_PARAMS.startMonth);
}

function calculateNodeYield(node, month) {
  if (!node) return 1;
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

// --- Efficiency multipliers ---
// Convention:
//  - M_* multiplies cost (good -> decreases over time, i.e. decay)
//  - S_* and H multiply throughput (good -> increases over time, i.e. growth)
function getEfficiencyMultipliers(month, assumptions, cache, warnings, warnedSet) {
  if (cache[month]) return cache[month];

  if (month === 0) {
    cache[0] = { M_inference: 1, M_training: 1, S_inference: 1, S_training: 1, H: 1 };
    return cache[0];
  }

  const prev = getEfficiencyMultipliers(month - 1, assumptions, cache, warnings, warnedSet);
  const blockKey = getBlockKeyForMonth(month);
  const block = assumptions?.[blockKey] || EFFICIENCY_ASSUMPTIONS?.[blockKey] || EFFICIENCY_ASSUMPTIONS?.base || {};

  const mInfAnnual = resolveAssumptionValue(block?.modelEfficiency?.m_inference?.value, 0.18);
  const mTrnAnnual = resolveAssumptionValue(block?.modelEfficiency?.m_training?.value, 0.10);

  const sInfAnnual = resolveAssumptionValue(block?.systemsEfficiency?.s_inference?.value, 0.10);
  const sTrnAnnual = resolveAssumptionValue(block?.systemsEfficiency?.s_training?.value, 0.08);

  const hAnnual = resolveAssumptionValue(block?.hardwareEfficiency?.h?.value, 0.15);

  const decayInf = Math.pow(1 - mInfAnnual, 1 / 12);
  const decayTrn = Math.pow(1 - mTrnAnnual, 1 / 12);

  const growSInf = Math.pow(1 + sInfAnnual, 1 / 12);
  const growSTrn = Math.pow(1 + sTrnAnnual, 1 / 12);
  const growH = Math.pow(1 + hAnnual, 1 / 12);

  const cur = {
    M_inference: prev.M_inference * decayInf,
    M_training: prev.M_training * decayTrn,
    S_inference: prev.S_inference * growSInf,
    S_training: prev.S_training * growSTrn,
    H: prev.H * growH
  };

  // Safety: M should not increase (cost multiplier should trend down)
  if (cur.M_inference > prev.M_inference + 1e-9 && !warnedSet.has('eff_sign_inf')) {
    warnings.push(`Sanity Check: Month ${month} M_inference increased. Check sign/inputs.`);
    warnedSet.add('eff_sign_inf');
  }
  if (cur.M_training > prev.M_training + 1e-9 && !warnedSet.has('eff_sign_trn')) {
    warnings.push(`Sanity Check: Month ${month} M_training increased. Check sign/inputs.`);
    warnedSet.add('eff_sign_trn');
  }

  cache[month] = cur;
  return cur;
}

/**
 * Compute required GPUs for month given demand + efficiency, with a persistent demandScale.
 * Returns inference/training components so we can split installed base sensibly.
 */
function computeRequiredGpus(month, demandAssumptions, efficiencyAssumptions, effCache, warnings, warnedSet, demandScale = 1) {
  const block = getDemandBlockForMonth(month, demandAssumptions);

  const inferenceDemand = calculateInferenceDemand(month, block);
  const trainingDemand = calculateTrainingDemand(month, block);

  // Apply persistent scale to workloads (fixes “49k GPUs in 2026” class issues)
  const totalTokens = inferenceDemand.total * demandScale;

  const hoursFrontier = resolveAssumptionValue(block?.workloadBase?.trainingComputePerRun?.frontier, 50e6);
  const hoursMidtier = resolveAssumptionValue(block?.workloadBase?.trainingComputePerRun?.midtier, 200000);

  const frontierRuns = (trainingDemand.frontier || 0) * demandScale;
  const midtierRuns = (trainingDemand.midtier || 0) * demandScale;

  // Physics constants (allow optional overrides via TRANSLATION_INTENSITIES.compute)
  const computeCfg = TRANSLATION_INTENSITIES?.compute || {};
  const flopsPerToken = resolveAssumptionValue(computeCfg.flopsPerToken?.value, PHYSICS_DEFAULTS.flopsPerToken);
  const flopsPerGpu = resolveAssumptionValue(computeCfg.flopsPerGpu?.value, PHYSICS_DEFAULTS.flopsPerGpu);

  const utilInf = resolveAssumptionValue(computeCfg.utilizationInference?.value, PHYSICS_DEFAULTS.utilizationInference);
  const utilTrn = resolveAssumptionValue(computeCfg.utilizationTraining?.value, PHYSICS_DEFAULTS.utilizationTraining);

  const demonstratedSecondsPerMonth = PHYSICS_DEFAULTS.secondsPerMonth;
  const hoursPerMonth = PHYSICS_DEFAULTS.hoursPerMonth;

  const eff = getEfficiencyMultipliers(month, efficiencyAssumptions, effCache, warnings, warnedSet);

  // Inference: required = (tokens * flops/token * M) / (flops/gpu-month * S * H)
  const effectiveFlopsPerToken = flopsPerToken * eff.M_inference;
  const rawFlopsPerGpuMonth = flopsPerGpu * utilInf * demonstratedSecondsPerMonth;
  const effectiveThroughputInf = rawFlopsPerGpuMonth * eff.S_inference * eff.H;

  const requiredInference = (totalTokens * effectiveFlopsPerToken) / Math.max(effectiveThroughputInf, EPSILON);

  // Training: required = (totalAccelHours * M) / (hours/month * util * S * H)
  const totalTrainingHours = (frontierRuns * hoursFrontier) + (midtierRuns * hoursMidtier);
  const denomTraining = hoursPerMonth * utilTrn * eff.S_training * eff.H;
  const requiredTraining = (totalTrainingHours * eff.M_training) / Math.max(denomTraining, EPSILON);

  const requiredTotal = requiredInference + requiredTraining;

  return {
    requiredTotal,
    requiredInference,
    requiredTraining,
    inferenceDemand,
    trainingDemand
  };
}

// ============================================
// 4) INTENSITY MAP + PREFLIGHT
// ============================================

function buildIntensityMap() {
  const map = {};
  const gpuToComp = TRANSLATION_INTENSITIES?.gpuToComponents || {};
  const serverToInfra = TRANSLATION_INTENSITIES?.serverToInfra || {};

  const kwPerGpu = resolveAssumptionValue(serverToInfra.kwPerGpu?.value, 1.0);
  const pue = resolveAssumptionValue(serverToInfra.pue?.value, 1.3);
  const mwPerGpu = (kwPerGpu * pue) / 1000;

  map['hbm_stacks'] = resolveAssumptionValue(gpuToComp.hbmStacksPerGpu?.value, 8);
  map['datacenter_mw'] = mwPerGpu;

  map['advanced_wafers'] = resolveAssumptionValue(gpuToComp.advancedWafersPerGpu?.value, 0.3);
  map['abf_substrate'] = resolveAssumptionValue(
    NODE_MAP.get('abf_substrate')?.inputIntensity,
    resolveAssumptionValue(gpuToComp.abfUnitsPerGpu?.value, 0.02)
  );

  map['cowos_capacity'] = resolveAssumptionValue(gpuToComp.cowosWaferEquivPerGpu?.value, 0.3);

  const hbIntensity = resolveAssumptionValue(gpuToComp.hybridBondingPerGpu?.value, 0.35);
  const hbShare = resolveAssumptionValue(gpuToComp.hybridBondingPackageShare?.value, 0.2);
  map['hybrid_bonding'] = hbIntensity * hbShare;

  const gpusPerServer = resolveAssumptionValue(serverToInfra.gpusPerServer?.value, 8);
  map['server_assembly'] = 1 / Math.max(gpusPerServer, 1);

  map['grid_interconnect'] = mwPerGpu;

  // Fill gaps from node definitions
  for (const node of NODES) {
    if (node?.inputIntensity && map[node.id] === undefined) map[node.id] = node.inputIntensity;
  }

  return map;
}

function runPreflightDiagnostics(map, warnings) {
  let errCount = 0;

  const gpuNode = NODE_MAP.get('gpu_datacenter');
  const gpuStartCap = gpuNode?.startingCapacity || 1;

  for (const node of NODES) {
    const isEligible = node.group !== 'A' && !['gpu_datacenter', 'gpu_inference'].includes(node.id);
    const isMapped = !!map[node.id];

    if (isMapped && (node.startingCapacity || 0) === 0 && (node.startingInventory || 0) === 0 && (!node.committedExpansions || node.committedExpansions.length === 0)) {
      warnings.push(`PREFLIGHT ERROR: Node '${node.id}' starts at 0 and has no expansions.`);
      errCount++;
    }

    if (isEligible && !isMapped) {
      const type = getNodeType(node.id);
      if (type !== 'QUEUE') warnings.push(`PREFLIGHT WARNING: Node '${node.id}' is unmapped. It will not constrain.`);
    }
  }

  for (const key of Object.keys(map)) {
    const node = NODE_MAP.get(key);
    if (!node) {
      warnings.push(`PREFLIGHT ERROR: Intensity map references missing node '${key}'.`);
      errCount++;
      continue;
    }

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
  }

  if (errCount > 0) warnings.push(`PREFLIGHT: Found ${errCount} configuration errors.`);
}

// ============================================
// 5) MAIN SIMULATION LOOP
// ============================================

export function runSimulation(assumptions, scenarioOverrides = {}) {
  const months = (GLOBAL_PARAMS.horizonYears || 10) * 12;

  const results = {
    months: [],
    nodes: {},
    summary: { shortages: [], gluts: [], bottlenecks: [] },
    warnings: []
  };

  const nodeIntensityMap = buildIntensityMap();
  runPreflightDiagnostics(nodeIntensityMap, results.warnings);

  const warnedSet = new Set();
  const effCache = [];

  const demandAssumptions = deepMerge(assumptions?.demand || DEMAND_ASSUMPTIONS, scenarioOverrides?.demand);
  const efficiencyAssumptions = deepMerge(assumptions?.efficiency || EFFICIENCY_ASSUMPTIONS, scenarioOverrides?.efficiency);

  // --- state init ---
  const nodeState = {};
  const startOverrides = scenarioOverrides?.startingState || {};

  const defaultDcInstalled = 1200000;
  const defaultInfInstalled = 300000;

  const dcInstalledOverride = startOverrides.datacenterInstalledBase ?? startOverrides.installedBaseDatacenter ?? startOverrides.installedBase;
  const infInstalledOverride = startOverrides.inferenceInstalledBase ?? startOverrides.installedBaseInference;

  for (const node of NODES) {
    const type = getNodeType(node.id);

    let installedBase = 0;
    if (node.id === 'gpu_datacenter') installedBase = (dcInstalledOverride !== undefined) ? dcInstalledOverride : defaultDcInstalled;
    if (node.id === 'gpu_inference') installedBase = (infInstalledOverride !== undefined) ? infInstalledOverride : defaultInfInstalled;

    const overrideBacklog = startOverrides.backlogByNode?.[node.id];
    const initialBacklog = (overrideBacklog !== undefined) ? overrideBacklog : (node.startingBacklog || 0);

    nodeState[node.id] = {
      type,
      inventory: (type === 'STOCK') ? (node.startingInventory || 0) : 0,
      backlog: initialBacklog,
      installedBase,
      dynamicExpansions: [],
      lastExpansionMonth: -Infinity,
      tightnessHistory: []
    };

    results.nodes[node.id] = {
      demand: [], supply: [], capacity: [], inventory: [], backlog: [],
      shortage: [], glut: [], tightness: [], priceIndex: [],
      installedBase: [], requiredBase: [], planDeploy: [], consumption: [],
      supplyPotential: [], gpuDelivered: [], idleGpus: [], yield: [],
      unmetDemand: [], potential: []
    };
  }

  // --- calibration ---
  const calibrationCfg = {
    enabled: scenarioOverrides?.calibration?.enabled ?? true,
    targetRatio: scenarioOverrides?.calibration?.targetRatio ?? 1.0,
    minScale: scenarioOverrides?.calibration?.minScale ?? 0.02,
    maxScale: scenarioOverrides?.calibration?.maxScale ?? 50
  };

  let demandScale = scenarioOverrides?.calibration?.demandScale ?? null;

  for (let month = 0; month < months; month++) {
    results.months.push(month);

    const demandBlock = getDemandBlockForMonth(month, demandAssumptions);

    const currentInstalled = (nodeState['gpu_datacenter']?.installedBase || 0) + (nodeState['gpu_inference']?.installedBase || 0);

    if (month === 0 && (demandScale === null || demandScale === undefined)) {
      const raw = computeRequiredGpus(0, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, 1);
      const rawReq = Math.max(raw.requiredTotal, 1);
      const desired = currentInstalled * calibrationCfg.targetRatio;

      let suggested = desired / rawReq;
      suggested = clamp(suggested, calibrationCfg.minScale, calibrationCfg.maxScale);

      demandScale = calibrationCfg.enabled ? suggested : 1;

      results.warnings.push(
        `INFO: Month 0 calibration: installed=${formatNumber(currentInstalled)} GPUs, raw required=${formatNumber(raw.requiredTotal)} GPUs. ` +
        `Applying demandScale=${demandScale.toFixed(2)} (enabled=${calibrationCfg.enabled}).`
      );
    }

    const scaleUsed = (demandScale === null || demandScale === undefined) ? 1 : demandScale;

    const req = computeRequiredGpus(month, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed);

    // Allocation: training => DC; inference split by configurable share
    const dcInfShare = resolveAssumptionValue(demandBlock?.allocation?.dcInferenceShare?.value, 0.60);
    const requiredDcBase = req.requiredTraining + (req.requiredInference * dcInfShare);
    const requiredInfBase = req.requiredInference * (1 - dcInfShare);

    // Keep workload series aligned (if these nodes exist)
    const pushWorkload = (nodeId, value) => {
      const r = results.nodes[nodeId];
      if (!r) return;
      r.demand.push(value);
      r.supply.push(null); r.capacity.push(null); r.inventory.push(null); r.backlog.push(null);
      r.shortage.push(null); r.glut.push(null); r.tightness.push(null); r.priceIndex.push(null);
      r.installedBase.push(null); r.requiredBase.push(null); r.planDeploy.push(null); r.consumption.push(null);
      r.supplyPotential.push(null); r.gpuDelivered.push(null); r.idleGpus.push(null); r.yield.push(null);
      r.unmetDemand.push(null); r.potential.push(null);
    };

    pushWorkload('training_frontier', req.trainingDemand.frontier || 0);
    pushWorkload('training_midtier', req.trainingDemand.midtier || 0);
    pushWorkload('inference_consumer', req.inferenceDemand.consumer || 0);
    pushWorkload('inference_enterprise', req.inferenceDemand.enterprise || 0);
    pushWorkload('inference_agentic', req.inferenceDemand.agentic || 0);

    // =======================================================
    // STEP 0: PLAN
    // =======================================================
    const gpuState = nodeState['gpu_datacenter'];
    const infState = nodeState['gpu_inference'];

    const dcGap = Math.max(0, requiredDcBase - gpuState.installedBase);
    const infGap = Math.max(0, requiredInfBase - infState.installedBase);

    const dcRetirements = gpuState.installedBase / 48;
    const infRetirements = infState.installedBase / 48;

    const backlogPaydown = gpuState.backlog / BACKLOG_PAYDOWN_MONTHS_GPU;

    const planDeployDc = (dcGap / CATCHUP_MONTHS) + dcRetirements;
    const planDeployInf = (infGap / CATCHUP_MONTHS) + infRetirements;

    const planDeployTotal = planDeployDc + planDeployInf + backlogPaydown;
    const baselinePlan = planDeployDc + planDeployInf;

    // =======================================================
    // STEP 1: POTENTIALS
    // =======================================================
    const potentials = {};
    for (const node of NODES) {
      if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') continue;
      if (node.group === 'A') continue;

      const state = nodeState[node.id];
      const cap = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
      const y = calculateNodeYield(node, month);
      const effCap = cap * (node.maxCapacityUtilization || 0.95) * y;

      potentials[node.id] = (state.type === 'STOCK') ? (state.inventory + effCap) : effCap;
    }

    // =======================================================
    // STEP 2: GATING
    // =======================================================
    const gpuNode = NODE_MAP.get('gpu_datacenter');
    const gpuCap = calculateCapacity(gpuNode, month, scenarioOverrides, gpuState.dynamicExpansions);
    const gpuYield = calculateNodeYield(gpuNode, month);
    const gpuEffCap = gpuCap * 0.95 * gpuYield;

    const gpuAvailable = gpuState.inventory + gpuEffCap;
    const preUpdateGpuInventory = gpuState.inventory;

    let maxSupported = Infinity;
    let constraintCount = 0;

    for (const [nodeId, intensity] of Object.entries(nodeIntensityMap)) {
      const potential = potentials[nodeId];
      if (potential !== undefined && intensity > 0) {
        const supported = potential / intensity;
        if (supported < maxSupported) maxSupported = supported;
        constraintCount++;
      }
    }

    if (constraintCount === 0 && (month === 0 || month % 12 === 0)) {
      results.warnings.push(`Warning (Month ${month}): No active component constraints found.`);
      maxSupported = Infinity;
    }

    const demandCeiling = planDeployTotal;
    const actualDeployTotal = Math.min(demandCeiling, gpuAvailable, maxSupported);
    const blockedByComponents = Math.max(0, Math.min(demandCeiling, gpuAvailable) - actualDeployTotal);

    // =======================================================
    // STEP 3: UPDATES
    // =======================================================
    const gpuBufferTarget = planDeployTotal * DEFAULT_BUFFER_MONTHS;
    const gpuProdTarget = actualDeployTotal + Math.max(0, gpuBufferTarget - gpuState.inventory);
    const gpuProduced = Math.min(gpuEffCap, gpuProdTarget);

    const oldGpuBacklog = gpuState.backlog;

    gpuState.inventory = (gpuState.inventory + gpuProduced) - actualDeployTotal;
    if (gpuState.inventory < -1e-6) gpuState.inventory = 0;

    gpuState.backlog = Math.max(0, oldGpuBacklog + baselinePlan - actualDeployTotal);

    const shareDc = baselinePlan > EPSILON ? (planDeployDc / baselinePlan) : 0.7;
    const actualDc = actualDeployTotal * shareDc;
    const actualInf = actualDeployTotal * (1 - shareDc);

    const blockedDc = blockedByComponents * shareDc;
    const blockedInf = blockedByComponents * (1 - shareDc);

    gpuState.installedBase = Math.max(0, gpuState.installedBase + actualDc - dcRetirements);
    infState.installedBase = Math.max(0, infState.installedBase + actualInf - infRetirements);

    const gpuTotalLoad = baselinePlan + (oldGpuBacklog / BACKLOG_PAYDOWN_MONTHS_GPU);
    const gpuPotential = preUpdateGpuInventory + gpuEffCap;
    const gpuTightness = gpuTotalLoad / Math.max(gpuPotential, EPSILON);
    const gpuPriceIndex = calculatePriceIndex(gpuTightness);

    gpuState.tightnessHistory.push(gpuTightness);
    if (sma(gpuState.tightnessHistory, 6) > 1.05 && (month - gpuState.lastExpansionMonth > 24)) {
      const expansionAmount = gpuCap * 0.20;
      const leadTime = gpuNode.leadTimeDebottleneck || 24;
      gpuState.dynamicExpansions.push({ month: month + leadTime, capacityAdd: expansionAmount });
      gpuState.lastExpansionMonth = month;
    }

    const storeGpu = (isDc) => {
      const nodeId = isDc ? 'gpu_datacenter' : 'gpu_inference';
      const res = results.nodes[nodeId];
      if (!res) return;

      const share = isDc ? shareDc : (1 - shareDc);

      res.demand.push(planDeployTotal * share);
      res.planDeploy.push(planDeployTotal * share);
      res.supply.push(isDc ? actualDc : actualInf);
      res.capacity.push(isDc ? gpuEffCap : 0);
      res.supplyPotential.push(gpuEffCap * share);
      res.potential.push(gpuEffCap * share);
      res.inventory.push(isDc ? gpuState.inventory : 0);
      res.backlog.push(gpuState.backlog * share);
      res.installedBase.push(isDc ? gpuState.installedBase : infState.installedBase);
      res.requiredBase.push(isDc ? requiredDcBase : requiredInfBase);
      res.consumption.push(actualDeployTotal * share);
      res.gpuDelivered.push(isDc ? actualDc : actualInf);
      res.idleGpus.push(isDc ? blockedDc : blockedInf);
      res.tightness.push(gpuTightness);
      res.priceIndex.push(gpuPriceIndex);
      res.yield.push(gpuYield);
      res.shortage.push((gpuState.backlog > 0) ? 1 : 0);
      res.glut.push(0);
      res.unmetDemand.push(Math.max(0, (planDeployTotal * share) - (isDc ? actualDc : actualInf)));
    };

    storeGpu(true);
    storeGpu(false);

    // Components
    for (const node of NODES) {
      if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') continue;
      if (node.group === 'A') continue;

      const nodeRes = results.nodes[node.id];
      const state = nodeState[node.id];
      const intensity = nodeIntensityMap[node.id] || 0;

      const planDemand = planDeployTotal * intensity;
      const actualConsumption = actualDeployTotal * intensity;

      const cap = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
      const y = calculateNodeYield(node, month);
      const effCap = cap * (node.maxCapacityUtilization || 0.95) * y;

      const inventoryIn = state.inventory;
      const backlogIn = state.backlog;

      const potentialSupply = (state.type === 'STOCK') ? (inventoryIn + effCap) : effCap;

      let production = 0;
      if (state.type === 'STOCK') {
        const bufferTarget = planDemand * DEFAULT_BUFFER_MONTHS;
        const backlogUrgency = backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS;
        const prodNeed = actualConsumption + backlogUrgency + Math.max(0, bufferTarget - inventoryIn);
        production = Math.min(effCap, prodNeed);
      }

      let delivered = 0;
      if (state.type === 'STOCK') {
        const available = inventoryIn + production;
        delivered = Math.min(actualConsumption, available);
        state.inventory = available - delivered;
        if (state.inventory < -1e-6) state.inventory = 0;
      } else {
        delivered = Math.min(actualConsumption, effCap);
        state.inventory = 0;
      }

      const unmetPlanThisMonth = Math.max(0, planDemand - potentialSupply);
      state.backlog = Math.max(0, backlogIn + unmetPlanThisMonth);

      const totalLoad = planDemand + (backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS);
      const tightness = totalLoad / Math.max(potentialSupply, EPSILON);
      const priceIndex = calculatePriceIndex(tightness);

      state.tightnessHistory.push(tightness);
      if (sma(state.tightnessHistory, 6) > 1.10 && (month - state.lastExpansionMonth > 12)) {
        const expansionAmount = cap * 0.20;
        const leadTime = node.leadTimeDebottleneck || 12;
        state.dynamicExpansions.push({ month: month + leadTime, capacityAdd: expansionAmount });
        state.lastExpansionMonth = month;
      }

      if (nodeRes) {
        nodeRes.demand.push(planDemand);
        nodeRes.planDeploy.push(planDemand);
        nodeRes.supply.push(delivered);
        nodeRes.capacity.push(effCap);
        nodeRes.supplyPotential.push(potentialSupply);
        nodeRes.potential.push(potentialSupply);
        nodeRes.inventory.push(state.inventory);
        nodeRes.backlog.push(state.backlog);
        nodeRes.tightness.push(tightness);
        nodeRes.priceIndex.push(priceIndex);
        nodeRes.yield.push(y);
        nodeRes.unmetDemand.push(unmetPlanThisMonth);

        const isShort = tightness > 1.05 || state.backlog > 0;
        nodeRes.shortage.push(isShort ? 1 : 0);
        nodeRes.glut.push(0);

        nodeRes.installedBase.push(0);
        nodeRes.requiredBase.push(0);
        nodeRes.gpuDelivered.push(0);
        nodeRes.idleGpus.push(0);
        nodeRes.consumption.push(actualConsumption);
      }
    }
  }

  results.summary = analyzeResults(results);
  return results;
}

// ============================================
// 6) ANALYSIS & FORMATTING
// ============================================

function analyzeResults(results) {
  const shortages = [];
  const shortagePersistence = 3;

  for (const [nodeId, data] of Object.entries(results.nodes)) {
    const node = NODE_MAP.get(nodeId);
    if (!node || node.group === 'A') continue;

    let shortageStart = null;
    let peakTightness = 0;
    let shortageDuration = 0;
    let consecShort = 0;

    for (let month = 0; month < (data.shortage?.length || 0); month++) {
      const isShort = data.shortage[month] || 0;
      const t = data.tightness?.[month] || 0;

      if (isShort === 1) {
        consecShort++;
        if (consecShort >= shortagePersistence) {
          if (shortageStart === null) shortageStart = month - shortagePersistence + 1;
          peakTightness = Math.max(peakTightness, t);
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
    }

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
  }

  shortages.sort((a, b) => b.severity - a.severity);
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
  if (!Number.isFinite(num)) return '-';
  const abs = Math.abs(num);
  if (abs >= 1e12) return (num / 1e12).toFixed(decimals) + 'T';
  if (abs >= 1e9) return (num / 1e9).toFixed(decimals) + 'B';
  if (abs >= 1e6) return (num / 1e6).toFixed(decimals) + 'M';
  if (abs >= 1e3) return (num / 1e3).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
}
