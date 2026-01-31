/**
 * AI Infrastructure Supply Chain - Calculation Engine
 *
 * FINAL PERFECTED VERSION (v30):
 * * DIAGNOSTICS: Unmet Demand = Plan - Potential (Pinpoints the true bottleneck).
 * * PHYSICS: Throughput nodes strictly clamped to Capacity (No teleportation).
 * * CALIBRATION: Dynamic Installed Base + Actionable Month 0 Info.
 * * SAFETY: Continuous Efficiency Trend Checks.
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
    utilization: 0.35,      
    secondsPerMonth: 2.6e6
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
const CATCHUP_MONTHS = 24; 
const DEFAULT_BUFFER_MONTHS = 2; 
const BACKLOG_PAYDOWN_MONTHS = 24; 

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
  if (tightness >= 1) {
    return Math.min(maxPrice, 1 + a * Math.pow(tightness - 1, b));
  }
  return Math.max(minPrice, 1 - a * Math.pow(1 - tightness, b));
}

// ============================================
// 3. CALCULATION HELPERS
// ============================================

export function clearGrowthCache() {
  // No-op (Run-scoped cache used)
}

function getDemandBlockForMonth(month, assumptions) {
  const blockKey = getBlockKeyForMonth(month);
  return assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
}

function calculateInferenceDemand(month, demandBlock) {
  const segments = ['consumer', 'enterprise', 'agentic'];
  const demand = { total: 0 };
  segments.forEach((segment) => {
    const base = resolveAssumptionValue(
      demandBlock?.workloadBase?.inferenceTokensPerMonth?.[segment],
      0
    );
    const growthRate = resolveAssumptionValue(
      demandBlock?.inferenceGrowth?.[segment]?.value,
      0
    );
    const value = base * Math.pow(1 + growthRate, month / 12);
    demand[segment] = value;
    demand.total += value;
  });
  return demand;
}

function calculateTrainingDemand(month, demandBlock) {
  const segments = ['frontier', 'midtier'];
  const demand = {};
  segments.forEach((segment) => {
    const base = resolveAssumptionValue(
      demandBlock?.workloadBase?.trainingRunsPerMonth?.[segment],
      0
    );
    const growthRate = resolveAssumptionValue(
      demandBlock?.trainingGrowth?.[segment]?.value,
      0
    );
    demand[segment] = base * Math.pow(1 + growthRate, month / 12);
  });
  return demand;
}

export function calculateCapacity(node, month, scenarioOverrides = {}, dynamicExpansions = []) {
  let capacity = node.startingCapacity || 0;

  (node.committedExpansions || []).forEach(expansion => {
    const onlineMonth = dateToMonth(expansion.date) + (expansion.leadTimeMonths || 0);
    if (month >= onlineMonth) {
      capacity += applyRampProfile(expansion.capacityAdd, month - onlineMonth, node.rampProfile || 'linear', 6);
    }
  });

  dynamicExpansions.forEach(exp => {
    if (month >= exp.month) {
      capacity += applyRampProfile(exp.capacityAdd, month - exp.month, node.rampProfile || 'linear', 6);
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

function applyRampProfile(capacityAdd, monthsSinceExpansion, profile, rampDuration) {
  const t = Math.min(monthsSinceExpansion / rampDuration, 1);
  if (profile === 'step') return capacityAdd;
  if (profile === 's-curve') return capacityAdd * (1 / (1 + Math.exp(-((t - 0.5) * 10))));
  return capacityAdd * t; // linear
}

function dateToMonth(dateStr) {
  const [year, month] = dateStr.split('-').map(Number);
  return (year - GLOBAL_PARAMS.startYear) * 12 + (month - GLOBAL_PARAMS.startMonth);
}

function calculateNodeYield(node, month) {
   if (node.yieldModel === 'stacked') {
    return calculateStackedYield(node.yieldInitial||0.65, node.yieldTarget||0.85, node.yieldHalflifeMonths||18, month);
   }
   return calculateSimpleYield(node.yieldSimpleLoss || 0.03);
}

// --- PHYSICS ENGINE ---

function getEfficiencyMultipliers(month, assumptions, cache, warnings, warnedSet) {
  if (cache[month]) return cache[month];
  
  if (month === 0) {
      cache[0] = { M_inference: 1, M_training: 1, S_inference: 1, S_training: 1, H: 1 };
      return cache[0];
  }

  const prev = getEfficiencyMultipliers(month - 1, assumptions, cache, warnings, warnedSet);
  const blockKey = getBlockKeyForMonth(month);
  const block = assumptions?.[blockKey] || EFFICIENCY_ASSUMPTIONS[blockKey];

  const m_infer_annual = resolveAssumptionValue(block?.modelEfficiency?.m_inference?.value, 0.18);
  const m_train_annual = resolveAssumptionValue(block?.modelEfficiency?.m_training?.value, 0.10);
  
  const decay_inf = Math.pow(1 - m_infer_annual, 1/12);
  const decay_train = Math.pow(1 - m_train_annual, 1/12);
  
  const current = {
      M_inference: prev.M_inference * decay_inf,
      M_training: prev.M_training * decay_train,
      S_inference: 1, S_training: 1, H: 1
  };
  
  // SAFETY: Continuous Efficiency Trend Check
  if (current.M_inference > prev.M_inference + 1e-9) {
      if (!warnedSet.has('eff_sign')) {
          warnings.push(`Sanity Check Fail (Month ${month}): Efficiency Multiplier is increasing (compute cost rising). Check signs.`);
          warnedSet.add('eff_sign');
      }
  }
  
  cache[month] = current;
  return current;
}

function calculateRequiredGpus(month, demandAssumptions, efficiencyAssumptions, effCache, warnings, warnedSet, installedBaseTotal) {
    const block = getDemandBlockForMonth(month, demandAssumptions);
    
    // 1. Demand Inputs
    const inferenceDemand = calculateInferenceDemand(month, block);
    const totalTokens = inferenceDemand.total;
    
    // 2. Physics
    const flopsPerToken = PHYSICS_DEFAULTS.flopsPerToken;
    const flopsPerGpu = PHYSICS_DEFAULTS.flopsPerGpu;
    const utilization = PHYSICS_DEFAULTS.utilization;
    const secondsPerMonth = PHYSICS_DEFAULTS.secondsPerMonth;
    
    // 3. Efficiency
    const eff = getEfficiencyMultipliers(month, efficiencyAssumptions, effCache, warnings, warnedSet);
    
    // 4. Calc
    const effectiveFlopsPerToken = flopsPerToken * eff.M_inference; 
    const effectiveFlopsPerGpuMonth = flopsPerGpu * utilization * secondsPerMonth;
    
    const required = (totalTokens * effectiveFlopsPerToken) / effectiveFlopsPerGpuMonth;

    // 5. CALIBRATION GUARD (Dynamic Month 0)
    if (month === 0) {
        // Log Implied Capacity for debugging
        const impliedTokens = (installedBaseTotal * effectiveFlopsPerGpuMonth) / effectiveFlopsPerToken;
        
        // Push INFO (Using warnings array for visibility, prepended with INFO)
        if (!warnedSet.has('calib_info')) {
             warnings.push(`INFO: Month 0 Installed Base (${formatNumber(installedBaseTotal)}) implies capacity for ${formatNumber(impliedTokens)} tokens/month.`);
             warnedSet.add('calib_info');
        }

        const ratio = required / Math.max(installedBaseTotal, 1);
        if (ratio < 0.1 || ratio > 2.0) {
            warnings.push(`CALIBRATION ALARM: Demand (${formatNumber(required)}) is ${(ratio*100).toFixed(0)}% of Installed Base. Adjust Assumptions.`);
        }
    }

    return required;
}

// ============================================
// 4. INTENSITY MAPPING & PREFLIGHT
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
    map['advanced_wafers'] = 0.5; 
    map['abf_substrate'] = 0.02; 
    
    map['cowos_capacity'] = gpuToComp.cowosWaferEquivPerGpu?.value || 1; 
    map['hybrid_bonding'] = 0.1; 
    map['server_assembly'] = 1 / (serverToInfra.gpusPerServer?.value || 8); 

    map['grid_interconnect'] = mwPerGpu; 

    NODES.forEach(node => {
        if (node.inputIntensity && !map[node.id]) {
            map[node.id] = node.inputIntensity;
        }
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
             warnings.push(`PREFLIGHT ERROR: Node '${node.id}' starts at 0 and has no Expansions. Will clamp sim.`);
             errCount++;
        }

        if (isEligible && !isMapped) {
             const type = getNodeType(node.id);
             if (type !== 'QUEUE') { 
                 warnings.push(`PREFLIGHT WARNING: Node '${node.id}' is unmapped. It will not constrain.`);
             }
        }
    });
    
    Object.keys(map).forEach(key => {
        const node = NODE_MAP.get(key);
        
        if (!node) {
            warnings.push(`PREFLIGHT ERROR: Intensity Map references missing node '${key}'.`);
            errCount++;
        } else {
            if (node.group === 'A') {
                warnings.push(`PREFLIGHT WARNING: Node '${key}' is mapped but Group A.`);
            }
            
            if (EXPECTED_UNITS[key]) {
                if (!node.unit) {
                    warnings.push(`PREFLIGHT ERROR: Node '${key}' missing 'unit'. Expected '${EXPECTED_UNITS[key]}'.`);
                    errCount++;
                } else if (node.unit !== EXPECTED_UNITS[key]) {
                    warnings.push(`PREFLIGHT WARNING: Unit Mismatch '${key}'. Found '${node.unit}', expected '${EXPECTED_UNITS[key]}'.`);
                }
            }

            const type = getNodeType(key);
            if (type === 'THROUGHPUT' && node.startingCapacity > 0 && map[key] > 0 && gpuStartCap > 0) {
                const impliedGpuSupport = node.startingCapacity / map[key];
                const ratio = impliedGpuSupport / gpuStartCap;
                if (ratio < 0.01 || ratio > 100) {
                     warnings.push(`PREFLIGHT WARNING: Magnitude '${key}'. Implied Support ${formatNumber(impliedGpuSupport)} vs GPU Cap ${formatNumber(gpuStartCap)}.`);
                }
            }
        }
    });

    if (errCount > 0) {
        warnings.push(`PREFLIGHT: Found ${errCount} configuration errors.`);
    }
}

// ============================================
// 5. MAIN SIMULATION LOOP
// ============================================

export function runSimulation(assumptions, scenarioOverrides = {}) {
  const months = GLOBAL_PARAMS.horizonYears * 12;
  
  const results = {
    months: [],
    nodes: {},
    summary: { shortages: [], gluts: [] },
    warnings: [] 
  };
  
  const nodeIntensityMap = buildIntensityMap();
  runPreflightDiagnostics(nodeIntensityMap, results.warnings);

  const warnedNodes = new Set();
  const demandAssumptions = deepMerge(assumptions?.demand || DEMAND_ASSUMPTIONS, scenarioOverrides?.demand);
  const efficiencyAssumptions = deepMerge(assumptions?.efficiency || EFFICIENCY_ASSUMPTIONS, scenarioOverrides?.efficiency);

  const effCache = []; 

  // --- STATE INITIALIZATION ---
  const nodeState = {};
  NODES.forEach(node => {
    const type = getNodeType(node.id);
    const isGpuNode = node.id === 'gpu_datacenter' || node.id === 'gpu_inference';
    nodeState[node.id] = {
      type: type,
      inventory: (type === 'STOCK') ? (node.startingInventory || 0) : 0,
      backlog: node.startingBacklog || 0,
      installedBase: (node.id === 'gpu_datacenter') ? 1200000 : (node.id === 'gpu_inference' ? 300000 : 0),
      dynamicExpansions: [],
      lastExpansionMonth: -Infinity,
      tightnessHistory: []
    };
    
    results.nodes[node.id] = {
      demand: [], supply: [], capacity: [], inventory: [], backlog: [], 
      shortage: [], glut: [], tightness: [], priceIndex: [],
      installedBase: [], requiredBase: [], planDeploy: [], consumption: [],
      supplyPotential: [], gpuDelivered: [], idleGpus: [], yield: [],
      gpuPurchases: isGpuNode ? [] : null,
      unmetDemand: [] // DIAGNOSTIC METRIC
    };
  });

  // --- MONTHLY LOOP ---
  for (let month = 0; month < months; month++) {
    results.months.push(month);

    // 1. LIVE DEMAND DRIVERS (Dynamic Calibration)
    const demandBlock = getDemandBlockForMonth(month, demandAssumptions);
    const inferenceDemand = calculateInferenceDemand(month, demandBlock);
    const trainingDemand = calculateTrainingDemand(month, demandBlock);
    const currentInstalledBase = nodeState['gpu_datacenter'].installedBase + nodeState['gpu_inference'].installedBase;
    const requiredGpuBase = calculateRequiredGpus(month, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedNodes, currentInstalledBase);
    
    const requiredDcBase = requiredGpuBase * 0.7; 
    const requiredInfBase = requiredGpuBase * 0.3; 

    const pushWorkloadMetrics = (nodeId, demandValue) => {
      const nodeRes = results.nodes[nodeId];
      if (!nodeRes) return;
      nodeRes.demand.push(demandValue);
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
      nodeRes.gpuDelivered.push(null);
      nodeRes.idleGpus.push(null);
      nodeRes.yield.push(null);
      if (nodeRes.gpuPurchases) {
        nodeRes.gpuPurchases.push(null);
      }
      nodeRes.unmetDemand.push(null);
    };

    pushWorkloadMetrics('training_frontier', trainingDemand.frontier);
    pushWorkloadMetrics('training_midtier', trainingDemand.midtier);
    pushWorkloadMetrics('inference_consumer', inferenceDemand.consumer);
    pushWorkloadMetrics('inference_enterprise', inferenceDemand.enterprise);
    pushWorkloadMetrics('inference_agentic', inferenceDemand.agentic);

    // =======================================================
    // STEP 0: THE PLAN
    // =======================================================
    const gpuState = nodeState['gpu_datacenter'];
    const infState = nodeState['gpu_inference'];

    const dcGap = Math.max(0, requiredDcBase - gpuState.installedBase);
    const infGap = Math.max(0, requiredInfBase - infState.installedBase);
    const dcRetirements = gpuState.installedBase / 48;
    const infRetirements = infState.installedBase / 48;

    const backlogPaydown = gpuState.backlog / BACKLOG_PAYDOWN_MONTHS;
    const planDeployDc = (dcGap / CATCHUP_MONTHS) + dcRetirements;
    const planDeployInf = (infGap / CATCHUP_MONTHS) + infRetirements;
    
    const planDeployTotal = planDeployDc + planDeployInf + backlogPaydown;
    const baselinePlan = planDeployDc + planDeployInf;

    // =======================================================
    // STEP 1: POTENTIALS
    // =======================================================
    const potentials = {}; 

    NODES.forEach(node => {
        if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') return;
        if (node.group === 'A') return;

        const state = nodeState[node.id];
        const capacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
        const yieldRate = calculateNodeYield(node, month);
        const effectiveCapacity = capacity * (node.maxCapacityUtilization || 0.95) * yieldRate;

        if (state.type === 'STOCK') {
            potentials[node.id] = state.inventory + effectiveCapacity;
        } else {
            potentials[node.id] = effectiveCapacity;
        }
    });

    // =======================================================
    // STEP 2: GATING
    // =======================================================
    
    // 1. GPU Fab
    const gpuNode = NODE_MAP.get('gpu_datacenter');
    const gpuCap = calculateCapacity(gpuNode, month, scenarioOverrides, gpuState.dynamicExpansions);
    const gpuEffCap = gpuCap * 0.95 * calculateNodeYield(gpuNode, month);
    const gpuAvailable = gpuState.inventory + gpuEffCap;
    
    const preUpdateGpuInventory = gpuState.inventory;

    // 2. Components
    let maxSupported = Infinity;
    let constraintCount = 0; 
    
    Object.entries(nodeIntensityMap).forEach(([nodeId, intensity]) => {
        const potential = potentials[nodeId];
        if (potential !== undefined && intensity > 0) {
            const supported = potential / intensity;
            if (supported < maxSupported) {
                maxSupported = supported; 
            }
            constraintCount++;
        }
    });

    if (constraintCount === 0 && (month === 0 || month % 12 === 0)) {
        results.warnings.push(`Warning (Month ${month}): No active component constraints found.`);
        maxSupported = Infinity; 
    }

    // 3. Final Gating
    const demandCeiling = planDeployTotal; 
    const actualDeployTotal = Math.min(demandCeiling, gpuAvailable, maxSupported);
    const blockedByComponents = Math.max(0, Math.min(demandCeiling, gpuAvailable) - actualDeployTotal);

    // =======================================================
    // STEP 3: CONSUMPTION & UPDATES
    // =======================================================
    
    // A. GPU Update
    const gpuBufferTarget = planDeployTotal * DEFAULT_BUFFER_MONTHS;
    const gpuProdTarget = actualDeployTotal + Math.max(0, gpuBufferTarget - gpuState.inventory);
    const gpuProduced = Math.min(gpuEffCap, gpuProdTarget);
    
    const oldGpuBacklog = gpuState.backlog;
    gpuState.inventory = (gpuState.inventory + gpuProduced) - actualDeployTotal;
    
    if (gpuState.inventory < -1e-6) {
        if (!warnedNodes.has('gpu_datacenter')) {
             results.warnings.push(`Clamp: Negative GPU Inventory detected at month ${month}`);
             warnedNodes.add('gpu_datacenter');
        }
        gpuState.inventory = 0;
    }

    gpuState.backlog = Math.max(0, oldGpuBacklog + baselinePlan - actualDeployTotal);
    
    // Split Ratio (From Baseline Plan)
    const shareDc = baselinePlan > EPSILON ? (planDeployDc / baselinePlan) : 0.7;
    const actualDc = actualDeployTotal * shareDc;
    const actualInf = actualDeployTotal * (1 - shareDc);
    const blockedDc = blockedByComponents * shareDc;
    const blockedInf = blockedByComponents * (1 - shareDc);

    gpuState.installedBase = Math.max(0, gpuState.installedBase + actualDc - dcRetirements);
    infState.installedBase = Math.max(0, infState.installedBase + actualInf - infRetirements);

    // GPU Expansion (Steady State)
    const gpuTotalLoad = baselinePlan; 
    const gpuPotential = preUpdateGpuInventory + gpuEffCap;
    const gpuTightness = gpuTotalLoad / Math.max(gpuPotential, EPSILON);
    const gpuPriceIndex = calculatePriceIndex(gpuTightness);
    const gpuYield = calculateNodeYield(gpuNode, month);
    
    gpuState.tightnessHistory.push(gpuTightness);
    
    if (sma(gpuState.tightnessHistory, 6) > 1.05 && (month - gpuState.lastExpansionMonth > 24)) {
        const expansionAmount = gpuCap * 0.20; 
        const leadTime = gpuNode.leadTimeDebottleneck || 24; 
        gpuState.dynamicExpansions.push({
            month: month + leadTime,
            capacityAdd: expansionAmount
        });
        gpuState.lastExpansionMonth = month;
    }

    [gpuState, infState].forEach((state, idx) => {
        const isDc = idx === 0;
        const res = results.nodes[isDc ? 'gpu_datacenter' : 'gpu_inference'];
        const share = isDc ? shareDc : (1-shareDc);
        
        res.demand.push(planDeployTotal * share); 
        res.supply.push(isDc ? actualDc : actualInf); 
        res.capacity.push(isDc ? gpuEffCap : 0);
        res.supplyPotential.push(gpuEffCap * share);
        res.inventory.push(isDc ? gpuState.inventory : 0);
        res.backlog.push(gpuState.backlog * share);
        res.installedBase.push(state.installedBase);
        res.requiredBase.push(isDc ? requiredDcBase : requiredInfBase);
        res.planDeploy.push(planDeployTotal * share);
        res.consumption.push(actualDeployTotal * share);
        res.gpuDelivered.push(isDc ? actualDc : actualInf);
        res.idleGpus.push(isDc ? blockedDc : blockedInf);
        if (res.gpuPurchases) {
            res.gpuPurchases.push(planDeployTotal * share);
        }
        res.tightness.push(gpuTightness); 
        res.priceIndex.push(gpuPriceIndex);
        res.yield.push(gpuYield);
        res.shortage.push(gpuState.backlog > 0 ? 1 : 0);
        res.unmetDemand.push(Math.max(0, planDeployTotal * share - (isDc ? actualDc : actualInf)));
    });

    // B. Component Updates
    NODES.forEach(node => {
        if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') return;
        if (node.group === 'A') return;

        const state = nodeState[node.id];
        const nodeRes = results.nodes[node.id];
        
        const intensity = nodeIntensityMap[node.id] || 0;
        // DIAGNOSTIC FIX: Demand = Plan * Intensity
        const demand = planDeployTotal * intensity; 
        const consumption = actualDeployTotal * intensity;

        const capacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
        const yieldRate = calculateNodeYield(node, month);
        const effectiveCapacity = capacity * (node.maxCapacityUtilization || 0.95) * yieldRate;

        const inventoryIn = state.inventory; 
        const backlogIn = state.backlog;
        let delivered = 0;
        let unmet = 0;

        if (state.type === 'STOCK') {
            const bufferTarget = consumption * DEFAULT_BUFFER_MONTHS;
            const prodNeed = consumption + Math.max(0, bufferTarget - state.inventory);
            const production = Math.min(effectiveCapacity, prodNeed);
            
            const available = state.inventory + production;
            
            delivered = Math.min(consumption, available); 
            
            if (delivered < consumption - 1e-6) {
                 if (!warnedNodes.has(node.id)) {
                    results.warnings.push(`Logic Error: Unmapped Constraint in ${node.id}. Consumption > Available.`);
                    warnedNodes.add(node.id);
                 }
            }
            
            state.inventory = available - delivered;
            state.backlog = 0; 
            
            // DIAGNOSTIC FIX: Unmet = PlanDemand - Potential
            const maxDeliverable = available; // We could have delivered this much
            unmet = Math.max(0, demand - maxDeliverable);
            
        } else {
            // THROUGHPUT - PHYSICS FIX: Delivered cannot exceed Capacity
            if (consumption > effectiveCapacity + 1e-6) {
                if (!warnedNodes.has(node.id)) {
                    results.warnings.push(`Physics Error: Throughput Overrun in ${node.id}. Delivered clamped to Capacity.`);
                    warnedNodes.add(node.id);
                }
                delivered = effectiveCapacity;
            } else {
                delivered = consumption;
            }

            state.backlog = 0; 
            state.inventory = 0;
            // DIAGNOSTIC FIX: Unmet = PlanDemand - Capacity
            unmet = Math.max(0, demand - effectiveCapacity);
        }

        // C. Expansion Logic
        const totalLoad = demand + backlogIn;
        const potentialSupply = (state.type === 'STOCK') ? (inventoryIn + effectiveCapacity) : effectiveCapacity;
        
        const tightness = totalLoad / Math.max(potentialSupply, EPSILON);
        const priceIndex = calculatePriceIndex(tightness);
        state.tightnessHistory.push(tightness);
        
        if (sma(state.tightnessHistory, 6) > 1.10 && (month - state.lastExpansionMonth > 12)) {
            const expansionAmount = capacity * 0.20; 
            const leadTime = node.leadTimeDebottleneck || 12;
            state.dynamicExpansions.push({
                month: month + leadTime,
                capacityAdd: expansionAmount
            });
            state.lastExpansionMonth = month;
        }

        // D. Store Results
        nodeRes.demand.push(demand);
        nodeRes.supply.push(delivered);
        nodeRes.capacity.push(effectiveCapacity);
        nodeRes.supplyPotential.push(effectiveCapacity);
        nodeRes.inventory.push(state.inventory);
        nodeRes.backlog.push(state.backlog);
        nodeRes.tightness.push(tightness);
        nodeRes.priceIndex.push(priceIndex);
        nodeRes.yield.push(yieldRate);
        nodeRes.unmetDemand.push(unmet); // New Metric
        
        const isShort = tightness > 1.05;
        nodeRes.shortage.push(isShort ? 1 : 0);
        nodeRes.requiredBase.push(0);
        nodeRes.gpuDelivered.push(0);
        nodeRes.idleGpus.push(0);
    });

  } // End Month Loop

  results.summary = analyzeResults(results);
  return results;
}

// ============================================
// ANALYSIS & FORMATTING
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
        if (shortageStart !== null) shortages.push({ nodeId, nodeName: node.name, group: node.group, startMonth: shortageStart, peakTightness, duration: shortageDuration, severity: peakTightness * shortageDuration });
        shortageStart = null; peakTightness = 0; shortageDuration = 0; consecShort = 0;
      }
    });
    if (shortageStart !== null) shortages.push({ nodeId, nodeName: node.name, group: node.group, startMonth: shortageStart, peakTightness, duration: shortageDuration, severity: peakTightness * shortageDuration });
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
