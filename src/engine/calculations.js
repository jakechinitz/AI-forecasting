/**
 * AI Infrastructure Supply Chain - Calculation Engine
 *
 * FINAL STABLE VERSION (v14):
 * 1. STRICT GATING: Component supply = fulfilled (actual allocation), not capacity.
 * 2. STABLE ORDERING: Order = Target - (Inventory + Backlog). Prevents double-ordering.
 * 3. CLEAN START: GPU inventory forced to 0 (ignoring node defaults) to prevent phantom stock.
 * 4. ARCHITECTURE: Closed Loop + Split Backlogs + Inventory Aware Forecast.
 */

import { NODES, getNode, getChildNodes } from '../data/nodes.js';
import {
  GLOBAL_PARAMS,
  DEMAND_ASSUMPTIONS,
  EFFICIENCY_ASSUMPTIONS,
  TRANSLATION_INTENSITIES,
  FIRST_ASSUMPTION_KEY,
  getBlockKeyForMonth,
  calculateMt,
  calculateSt,
  calculateHt,
  calculateStackedYield,
  calculateSimpleYield
} from '../data/assumptions.js';

// ============================================
// CONSTANTS
// ============================================
const EPSILON = 1e-10;
const CATCHUP_MONTHS = 24; // Smooths the "Gap" into a monthly flow
const DEFAULT_BUFFER_MONTHS = 2; // Target months of supply to maintain

const ELASTIC_NODES = new Set([
  'hbm_stacks', 'cowos_capacity', 'grid_interconnect', 'datacenter_mw',
  'advanced_wafers', 'hybrid_bonding', 'abf_substrate', 'osat_capacity',
  'dram_server', 'ssd_datacenter', 'cpu_server', 'dpu_nic', 'switch_asics',
  'optical_transceivers', 'infiniband_cables', 'server_assembly', 'rack_pdu',
  'liquid_cooling', 'transformers_lpt', 'power_generation', 'backup_power',
  'dc_construction', 'dc_ops_staff', 'ml_engineers', 'euv_tools'
]);

// ============================================
// UTILITY FUNCTIONS
// ============================================

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
  if (value === null) return 0;
  return value ?? fallback;
}

function isNonInventoriable(node) {
  return node?.inventoryPolicy === 'queue' || node?.inventoryPolicy === 'non_storable';
}

function getGpuToComponentIntensities() {
  const gpuToComponents = TRANSLATION_INTENSITIES?.gpuToComponents || {};
  return {
    hbmStacksPerGpu: resolveAssumptionValue(gpuToComponents.hbmStacksPerGpu?.value, 8),
    cowosWaferEquivPerGpu: resolveAssumptionValue(gpuToComponents.cowosWaferEquivPerGpu?.value, 1.0),
    hybridBondingPerGpu: resolveAssumptionValue(gpuToComponents.hybridBondingPerGpu?.value, 0.1),
    hybridBondingPackageShare: resolveAssumptionValue(gpuToComponents.hybridBondingPackageShare?.value, 0.2),
    hybridBondingAdoption: {
      initial: resolveAssumptionValue(gpuToComponents.hybridBondingAdoption?.initial, 0.1),
      target: resolveAssumptionValue(gpuToComponents.hybridBondingAdoption?.target, 0.5),
      halflifeMonths: resolveAssumptionValue(gpuToComponents.hybridBondingAdoption?.halflifeMonths, 24)
    },
    advancedWafersPerGpu: resolveAssumptionValue(gpuToComponents.advancedWafersPerGpu?.value, 0.5),
    serverDramGbPerGpu: resolveAssumptionValue(gpuToComponents.serverDramGbPerGpu?.value, 64)
  };
}

function getServerInfraIntensities() {
  const serverToInfra = TRANSLATION_INTENSITIES?.serverToInfra || {};
  return {
    gpusPerServer: resolveAssumptionValue(serverToInfra.gpusPerServer?.value, 8),
    serversPerRack: resolveAssumptionValue(serverToInfra.serversPerRack?.value, 4),
    kwPerGpu: resolveAssumptionValue(serverToInfra.kwPerGpu?.value, 1.0),
    pue: resolveAssumptionValue(serverToInfra.pue?.value, 1.3)
  };
}

function calculateHybridBondingAdoption(month) {
  const { initial, target, halflifeMonths } = getGpuToComponentIntensities().hybridBondingAdoption;
  return target - (target - initial) * Math.pow(2, -month / Math.max(1, halflifeMonths));
}

// ============================================
// CALIBRATION PARAMETERS
// ============================================
const CALIBRATION = {
  targetRequiredBaseGpuDc_2025: 2000000,
  startingInstalledBaseGpuDc: 1200000,
  startingInstalledBaseGpuInference: 300000,
  inferenceShare: 0.30,
  targetUtilization: 0.70,
  globalAccelHoursMultiplier: 1
};

// ============================================
// CACHES
// ============================================
const growthCache = new Map();
const efficiencyCache = new Map();
const intensityCache = [];
const continualLearningCache = [];

export function clearGrowthCache() {
  growthCache.clear();
  efficiencyCache.clear();
  intensityCache.length = 0;
  continualLearningCache.length = 0;
}

// ============================================
// CORE CALCULATION FUNCTIONS
// ============================================

export function calculateEfficiencyMultipliers(month, assumptions) {
  const cacheKey = JSON.stringify(assumptions || 'default');
  if (!efficiencyCache.has(cacheKey)) {
    efficiencyCache.set(cacheKey, {
      M_inference: [1], M_training: [1], S_inference: [1], S_training: [1], H: [1]
    });
  }

  const cache = efficiencyCache.get(cacheKey);

  for (let m = cache.M_inference.length; m <= month; m++) {
    const blockKey = getBlockKeyForMonth(m);
    const block = assumptions?.[blockKey] || EFFICIENCY_ASSUMPTIONS[blockKey];

    const m_infer = resolveAssumptionValue(block?.modelEfficiency?.m_inference?.value, 0.18);
    const m_train = resolveAssumptionValue(block?.modelEfficiency?.m_training?.value, 0.10);
    const s_infer = resolveAssumptionValue(block?.systemsEfficiency?.s_inference?.value, 0.10);
    const s_train = resolveAssumptionValue(block?.systemsEfficiency?.s_training?.value, 0.08);
    const h = resolveAssumptionValue(block?.hardwareEfficiency?.h?.value, 0.15);

    cache.M_inference[m] = cache.M_inference[m - 1] * Math.pow(1 - m_infer, 1 / 12);
    cache.M_training[m] = cache.M_training[m - 1] * Math.pow(1 - m_train, 1 / 12);
    cache.S_inference[m] = cache.S_inference[m - 1] * Math.pow(1 + s_infer, 1 / 12);
    cache.S_training[m] = cache.S_training[m - 1] * Math.pow(1 + s_train, 1 / 12);
    cache.H[m] = cache.H[m - 1] * Math.pow(1 + h, 1 / 12);
  }

  return {
    M_inference: cache.M_inference[month],
    M_training: cache.M_training[month],
    S_inference: cache.S_inference[month],
    S_training: cache.S_training[month],
    H: cache.H[month]
  };
}

export function calculateNodeYield(node, month) {
  if (node.yieldModel === 'stacked') {
    return calculateStackedYield(
      node.yieldInitial ?? 0.65,
      node.yieldTarget ?? 0.85,
      node.yieldHalflifeMonths ?? 18,
      month
    );
  }
  return calculateSimpleYield(node.yieldSimpleLoss ?? 0.03);
}

export function calculateDemandGrowth(category, segment, month, assumptions) {
  const key = `${category}:${segment}`;
  if (!growthCache.has(key)) growthCache.set(key, [1]);

  const arr = growthCache.get(key);

  for (let m = arr.length; m <= month; m++) {
    const blockKey = getBlockKeyForMonth(m);
    const block = assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];

    let rate = 0;
    if (category === 'inference') {
      rate = resolveAssumptionValue(block?.inferenceGrowth?.[segment]?.value, 0.40);
    } else if (category === 'training') {
      rate = resolveAssumptionValue(block?.trainingGrowth?.[segment]?.value, 0.25);
    }

    arr[m] = arr[m - 1] * (1 + (Math.pow(1 + rate, 1 / 12) - 1));
  }
  return arr[month];
}

export function calculateCapacity(node, month, scenarioOverrides = {}, dynamicExpansions = []) {
  let capacity = node.startingCapacity || 0;

  (node.committedExpansions || []).forEach(expansion => {
    const expansionMonth = dateToMonth(expansion.date);
    const leadTimeMonths = expansion.leadTimeMonths ?? node.leadTimeNewBuild ?? 0;
    const onlineMonth = expansionMonth + leadTimeMonths;
    if (month >= onlineMonth) {
      capacity += applyRampProfile(
        expansion.capacityAdd,
        month - onlineMonth,
        node.rampProfile || 'linear',
        6
      );
    }
  });

  dynamicExpansions.forEach(expansion => {
    if (month >= expansion.month) {
      capacity += applyRampProfile(
        expansion.capacityAdd,
        month - expansion.month,
        node.rampProfile || 'linear',
        6
      );
    }
  });

  if (scenarioOverrides.supply?.affectedNodes?.includes(node.id)) {
    const shockMonth = scenarioOverrides.supply.shockMonth || 24;
    const reduction = scenarioOverrides.supply.capacityReduction || 0.5;
    const recoveryMonths = scenarioOverrides.supply.recoveryMonths || 36;
    if (month >= shockMonth) {
      const recoveryFactor = Math.min(1, (month - shockMonth) / recoveryMonths);
      capacity *= (1 - (reduction * (1 - recoveryFactor)));
    }
  }

  return capacity;
}

function applyRampProfile(capacityAdd, monthsSinceExpansion, profile, rampDuration) {
  const t = Math.min(monthsSinceExpansion / rampDuration, 1);
  if (profile === 'step') return capacityAdd;
  if (profile === 's-curve') {
    return capacityAdd * (1 / (1 + Math.exp(-((t - 0.5) * 10))));
  }
  return capacityAdd * t; // linear
}

function dateToMonth(dateStr) {
  const [year, month] = dateStr.split('-').map(Number);
  return (year - GLOBAL_PARAMS.startYear) * 12 + (month - GLOBAL_PARAMS.startMonth);
}

export function calculateTightness(demand, backlog, supply, inventory) {
  return (demand + backlog) / (supply + inventory + EPSILON);
}

export function calculatePriceIndex(tightness, params = GLOBAL_PARAMS.priceIndex) {
  const { a, b, minPrice, maxPrice } = params;
  if (tightness <= 1) return Math.max(minPrice, Math.min(maxPrice, Math.pow(tightness, 0.5)));
  return Math.max(minPrice, Math.min(maxPrice, 1 + a * Math.pow(tightness - 1, b)));
}

export function calculateSubstitutionShare(currentShare, priceSignalSma, subMax, subK, lambda) {
  const target = Math.min(subMax, subK * Math.max(0, priceSignalSma - 1));
  return currentShare + lambda * (target - currentShare);
}

export function calculateInventory(prevInventory, supply, shipments) {
  return Math.max(0, prevInventory + supply - shipments);
}

export function calculateMonthsOfSupply(inventoryUnits, forwardDemand, forwardMonths = 3) {
  const avgDemand = forwardDemand.slice(0, forwardMonths).reduce((a, b) => a + b, 0) / forwardMonths;
  return inventoryUnits / (avgDemand + EPSILON);
}

export function calculateBacklog(prevBacklog, demand, supply) {
  return Math.max(0, prevBacklog + demand - supply);
}

export function sma(values, window) {
  if (values.length < window) return values.reduce((a, b) => a + b, 0) / values.length;
  return values.slice(-window).reduce((a, b) => a + b, 0) / window;
}

// ============================================
// DEMAND ENGINE
// ============================================

export function calculateInferenceDemand(month, assumptions) {
  const blockKey = getBlockKeyForMonth(month);
  const block = assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
  const base = block?.workloadBase?.inferenceTokensPerMonth ||
               DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.inferenceTokensPerMonth;

  const consumerGrowth = calculateDemandGrowth('inference', 'consumer', month, assumptions);
  const enterpriseGrowth = calculateDemandGrowth('inference', 'enterprise', month, assumptions);
  const agenticGrowth = calculateDemandGrowth('inference', 'agentic', month, assumptions);

  return {
    consumer: base.consumer * consumerGrowth,
    enterprise: base.enterprise * enterpriseGrowth,
    agentic: base.agentic * agenticGrowth,
    total: (base.consumer * consumerGrowth) + (base.enterprise * enterpriseGrowth) + (base.agentic * agenticGrowth)
  };
}

export function calculateTrainingDemand(month, demandAssumptions, efficiencyAssumptions) {
  const blockKey = getBlockKeyForMonth(month);
  const block = demandAssumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
  const baseTrain = block?.workloadBase?.trainingRunsPerMonth ||
                    DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.trainingRunsPerMonth;
  const baseCompute = block?.workloadBase?.trainingComputePerRun ||
                      DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.trainingComputePerRun;

  const frontierGrowth = calculateDemandGrowth('training', 'frontier', month, demandAssumptions);
  const midtierGrowth = calculateDemandGrowth('training', 'midtier', month, demandAssumptions);
  const eff = calculateEfficiencyMultipliers(month, efficiencyAssumptions);

  return {
    frontierRuns: baseTrain.frontier * frontierGrowth,
    midtierRuns: baseTrain.midtier * midtierGrowth,
    frontierAccelHours: (baseTrain.frontier * frontierGrowth * baseCompute.frontier * eff.M_training) / (eff.S_training * eff.H),
    midtierAccelHours: (baseTrain.midtier * midtierGrowth * baseCompute.midtier * eff.M_training) / (eff.S_training * eff.H),
    totalAccelHours: 0
  };
}

function calculateTrainingThrottle(month, results) {
  if (month <= 0) return 1;

  const gpuResults = results?.nodes?.gpu_datacenter;
  const poolTightnessHistory = gpuResults?.poolTightness || [];

  if (poolTightnessHistory.length === 0) return 1;
  const smoothedTightness = sma(poolTightnessHistory, 6);
  if (!Number.isFinite(smoothedTightness) || smoothedTightness <= 1) return 1;

  return Math.max(0.1, Math.min(1, 1 / smoothedTightness));
}

export function calculateIntensityMultiplier(month, assumptions) {
  for (let m = intensityCache.length; m <= month; m++) {
    const blockKey = getBlockKeyForMonth(m);
    const block = assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
    const intensityGrowthRate = resolveAssumptionValue(block?.intensityGrowth?.value, 0.40);

    if (m === 0) intensityCache[m] = 1;
    else intensityCache[m] = intensityCache[m - 1] * Math.pow(1 + intensityGrowthRate, 1 / 12);
  }
  return intensityCache[month];
}

export function calculateInferenceAccelHours(tokens, month, efficiencyAssumptions, demandAssumptions) {
  const eff = calculateEfficiencyMultipliers(month, efficiencyAssumptions);
  const flopsPerToken = 2e9;
  const accelFlopsPerHour = 1e15 * 3600;
  const intensity = calculateIntensityMultiplier(month, demandAssumptions);
  return (tokens * flopsPerToken * eff.M_inference * intensity) / (eff.S_inference * eff.H * accelFlopsPerHour);
}

export function calculateContinualLearningDemand(month, demandAssumptions) {
  for (let m = continualLearningCache.length; m <= month; m++) {
    const blockKey = getBlockKeyForMonth(m);
    const block = demandAssumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
    const computeGrowthRate = resolveAssumptionValue(block?.continualLearning?.computeGrowth?.value, 0.60);
    const dataGrowthRate = resolveAssumptionValue(block?.continualLearning?.dataStorageGrowth?.value, 0.50);
    const networkGrowthRate = resolveAssumptionValue(block?.continualLearning?.networkBandwidthGrowth?.value, 0.45);

    if (m === 0) {
      const baseCL = block?.workloadBase?.continualLearningBase ||
                     DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.continualLearningBase;
      continualLearningCache[m] = {
        accelHours: baseCL.accelHoursPerMonth,
        dataTB: baseCL.dataTB,
        networkGbps: baseCL.networkGbps
      };
    } else {
      const prev = continualLearningCache[m - 1];
      continualLearningCache[m] = {
        accelHours: prev.accelHours * Math.pow(1 + computeGrowthRate, 1 / 12),
        dataTB: prev.dataTB * Math.pow(1 + dataGrowthRate, 1 / 12),
        networkGbps: prev.networkGbps * Math.pow(1 + networkGrowthRate, 1 / 12)
      };
    }
  }
  return continualLearningCache[month];
}

export function calculateEffectiveHbmPerGpu(month, demandAssumptions) {
  const { hbmStacksPerGpu } = getGpuToComponentIntensities();
  const blockKey = getBlockKeyForMonth(month);
  const block = demandAssumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
  const memoryMultiplier = resolveAssumptionValue(block?.continualLearning?.memoryMultiplierAtFullAdoption?.value, 1.6);
  const continualLearning = calculateContinualLearningDemand(month, demandAssumptions);
  const baseCL = block?.workloadBase?.continualLearningBase ||
                 DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.continualLearningBase;
  const growthRatio = continualLearning.accelHours / baseCL.accelHoursPerMonth;
  const adoption = 0.1 + 0.8 * (growthRatio / (1 + growthRatio));
  return hbmStacksPerGpu * (1 + adoption * (memoryMultiplier - 1));
}

// ============================================
// TRANSLATION LAYER
// ============================================

export function accelHoursToRequiredGpuBase(accelHours, utilization = 0.70) {
  return accelHours / (720 * utilization);
}

export function gpuToComponentDemands(gpuCount, month, effectiveHbmPerGpu = 8) {
  const gpuToComponents = getGpuToComponentIntensities();
  const serverInfra = getServerInfraIntensities();
  const hybridBondingAdoption = calculateHybridBondingAdoption(month);
  const gpusPerServer = serverInfra.gpusPerServer;
  const powerMwPerGpu = (serverInfra.kwPerGpu * serverInfra.pue) / 1000;
  const hybridBondingIntensity = gpuToComponents.hybridBondingPerGpu * gpuToComponents.hybridBondingPackageShare * hybridBondingAdoption;

  return {
    hbmStacks: gpuCount * effectiveHbmPerGpu,
    cowosWaferEquiv: gpuCount * gpuToComponents.cowosWaferEquivPerGpu,
    advancedWafers: gpuCount * gpuToComponents.advancedWafersPerGpu,
    hybridBonding: gpuCount * hybridBondingIntensity,
    serverDramGb: gpuCount * gpuToComponents.serverDramGbPerGpu,
    ssdTb: gpuCount * 1,
    cpus: gpuCount * 0.25,
    dpuNics: gpuCount * 1,
    switchAsics: gpuCount * 0.125,
    transceivers: gpuCount * 1,
    infinibandCables: gpuCount * 4,
    abfSubstrate: gpuCount * 0.02,
    osatUnits: gpuCount * 1,
    servers: gpuCount / gpusPerServer,
    cdus: gpuCount * 0.05,
    powerMw: gpuCount * powerMwPerGpu
  };
}

export function dcMwToPowerDemands(mw) {
  return {
    transformers: mw * 0.02,
    gridApprovals: mw * 1.0,
    ppas: mw * 1.2,
    backupMw: mw * 1.5,
    dcConstruction: mw * 500,
    dcOpsStaff: mw * 0.5
  };
}

// ============================================
// FULL SIMULATION ENGINE
// ============================================

export function runSimulation(assumptions, scenarioOverrides = {}) {
  clearGrowthCache();

  const months = GLOBAL_PARAMS.horizonYears * 12;
  const results = {
    months: [],
    nodes: {},
    summary: { shortages: [], gluts: [], bottlenecks: [] }
  };

  const baseDemandAssumptions = assumptions?.demand || DEMAND_ASSUMPTIONS;
  const baseEfficiencyAssumptions = assumptions?.efficiency || EFFICIENCY_ASSUMPTIONS;
  const demandAssumptions = deepMerge(baseDemandAssumptions, scenarioOverrides?.demand);
  const efficiencyAssumptions = deepMerge(baseEfficiencyAssumptions, scenarioOverrides?.efficiency);

  // Calibration
  const rawMonth0Inference = calculateInferenceDemand(0, demandAssumptions);
  const rawMonth0Training = calculateTrainingDemand(0, demandAssumptions, efficiencyAssumptions);
  const rawMonth0Continual = calculateContinualLearningDemand(0, demandAssumptions);
  const rawMonth0InferAccelHours = calculateInferenceAccelHours(rawMonth0Inference.total, 0, efficiencyAssumptions, demandAssumptions);
  const rawMonth0TotalAccelHours = rawMonth0InferAccelHours +
    rawMonth0Training.frontierAccelHours +
    rawMonth0Training.midtierAccelHours +
    rawMonth0Continual.accelHours;
  const targetAccelHours = CALIBRATION.targetRequiredBaseGpuDc_2025 * 720 * CALIBRATION.targetUtilization;
  CALIBRATION.globalAccelHoursMultiplier = targetAccelHours / (rawMonth0TotalAccelHours + EPSILON);

  // Initialize node state
  const nodeState = {};
  NODES.forEach(node => {
    let startingInstalledBase = 0;
    if (node.id === 'gpu_datacenter') startingInstalledBase = CALIBRATION.startingInstalledBaseGpuDc;
    else if (node.id === 'gpu_inference') startingInstalledBase = CALIBRATION.startingInstalledBaseGpuInference;

    // FIX: PHANTOM INVENTORY REMOVAL
    // We explicitly zero out GPU inventory unless overridden by SCENARIO (ignoring nodes.js defaults).
    // This prevents the "Warehouse of GPUs" bug from suppressing initial orders.
    let initialInventory = 0;
    const isGpu = node.id === 'gpu_datacenter' || node.id === 'gpu_inference';
    
    if (isGpu) {
        // Only use scenario override, otherwise 0. Ignore node.startingInventory.
        initialInventory = scenarioOverrides?.startingState?.inventoryByNode?.[node.id] ?? 0;
    } else {
        initialInventory = scenarioOverrides?.startingState?.inventoryByNode?.[node.id] ?? node.startingInventory ?? ((node.inventoryBufferTarget || 0) * (node.startingCapacity || 0) / 4);
    }

    nodeState[node.id] = {
      inventory: initialInventory,
      
      // Split backlogs
      fabBacklog: 0, 
      deployBacklog: (scenarioOverrides?.startingState?.backlogByNode?.[node.id] ?? node.startingBacklog ?? 0),
      backlog: (scenarioOverrides?.startingState?.backlogByNode?.[node.id] ?? node.startingBacklog ?? 0),

      subShare: 0,
      priceHistory: [1],
      tightnessHistory: [],
      poolTightnessHistory: [],
      installedBase: startingInstalledBase,
      lifetimeMonths: node.lifetimeMonths || 48,
      dynamicExpansions: [],
      lastTriggerMonth: -Infinity,
      dynamicExpansionCount: 0,
      lastCapexTriggerMonth: -Infinity,
      capexExpansionCount: 0
    };
    results.nodes[node.id] = {
      demand: [], supply: [], supplyPotential: [], gpuDelivered: [], idleGpus: [],
      fabOutput: [], fabNeed: [], deployNeed: [],
      tightness: [], poolTightness: [],
      priceIndex: [], inventory: [], backlog: [], capacity: [], yield: [],
      shortage: [], glut: [], installedBase: [], requiredBase: [], gpuPurchases: []
    };
  });

  // Run simulation
  for (let month = 0; month < months; month++) {
    results.months.push(month);

    const inferenceDemand = calculateInferenceDemand(month, demandAssumptions);
    const trainingThrottle = calculateTrainingThrottle(month, results);
    const trainingDemandBase = calculateTrainingDemand(month, demandAssumptions, efficiencyAssumptions);
    const trainingDemand = {
      ...trainingDemandBase,
      frontierRuns: trainingDemandBase.frontierRuns * trainingThrottle,
      midtierRuns: trainingDemandBase.midtierRuns * trainingThrottle,
      frontierAccelHours: trainingDemandBase.frontierAccelHours * trainingThrottle,
      midtierAccelHours: trainingDemandBase.midtierAccelHours * trainingThrottle
    };
    const continualLearningDemand = calculateContinualLearningDemand(month, demandAssumptions);

    const inferenceAccelHours = calculateInferenceAccelHours(inferenceDemand.total, month, efficiencyAssumptions, demandAssumptions);
    const totalAccelHours = (inferenceAccelHours + trainingDemand.frontierAccelHours + trainingDemand.midtierAccelHours + continualLearningDemand.accelHours) * CALIBRATION.globalAccelHoursMultiplier;

    const requiredGpuBase = accelHoursToRequiredGpuBase(totalAccelHours);
    const requiredDcBase = requiredGpuBase * (1 - CALIBRATION.inferenceShare);
    const requiredInfBase = requiredGpuBase * CALIBRATION.inferenceShare;

    // ============================================
    // PHASE 1: Determine Demand Flows
    // ============================================
    const gpuNode = NODES.find(n => n.id === 'gpu_datacenter');
    const gpuState = nodeState['gpu_datacenter'];
    const infState = nodeState['gpu_inference'];
    const gpuResults = results.nodes['gpu_datacenter'];
    const infResults = results.nodes['gpu_inference'];

    // 1. Calculate Demand Flow
    const dcGap = Math.max(0, requiredDcBase - gpuState.installedBase);
    const infGap = Math.max(0, requiredInfBase - infState.installedBase);
    const dcCatchup = dcGap / CATCHUP_MONTHS;
    const infCatchup = infGap / CATCHUP_MONTHS;
    const dcRetirements = gpuState.installedBase / gpuState.lifetimeMonths;
    const infRetirements = infState.installedBase / infState.lifetimeMonths;

    const dcDemandFlow = dcCatchup + dcRetirements;
    const infDemandFlow = infCatchup + infRetirements;
    const deployNeedFlow = dcDemandFlow + infDemandFlow;

    // 2. Integration Need (for Component demand)
    const deployNeedTotal = deployNeedFlow + gpuState.deployBacklog;

    // 3. Fab Order Policy: Order = (Need + Buffer) - (Inventory + OnOrder)
    // FIX: Using Inventory Position (Inventory + Backlog) to prevents Double Ordering overshoot.
    const targetBufferAmount = deployNeedFlow * DEFAULT_BUFFER_MONTHS;
    const targetAvailableToDeploy = deployNeedTotal + targetBufferAmount;
    
    // "inventoryPosition" = what we have + what is already coming down the pipe
    const inventoryPosition = gpuState.inventory + gpuState.fabBacklog;
    const fabOrderFlow = Math.max(0, targetAvailableToDeploy - inventoryPosition);

    // 4. Fab Execution Need (Orders + Fab Backlog)
    const fabNeed = fabOrderFlow + gpuState.fabBacklog;
    
    // ============================================
    // PHASE 1.5: Fab Execution (Procurement)
    // ============================================
    const gpuCapacity = calculateCapacity(gpuNode, month, scenarioOverrides, gpuState.dynamicExpansions);
    const gpuYield = calculateNodeYield(gpuNode, month);
    const gpuShipmentsRaw = gpuCapacity * (gpuNode.maxCapacityUtilization || 0.95) * gpuYield;
    const gpuInventoryIn = gpuState.inventory;

    // Fab fulfills what it can
    const fabFulfilled = Math.min(gpuShipmentsRaw, fabNeed);
    
    // Update Fab Backlog
    gpuState.fabBacklog = Math.max(0, fabNeed - fabFulfilled);

    // Available to Deploy = What Fab made + What was already idle
    const gpuAvailableToDeploy = fabFulfilled + gpuInventoryIn;

    // ============================================
    // PHASE 2: Process Component Nodes
    // ============================================
    
    // Allocation Logic: Based on Fundamental Requirement Share
    const totalRequired = requiredDcBase + requiredInfBase;
    const needShareDc = totalRequired > 0 ? requiredDcBase / totalRequired : (1 - CALIBRATION.inferenceShare);
    const needShareInf = 1 - needShareDc;

    const effectiveHbmPerGpuThisMonth = calculateEffectiveHbmPerGpu(month, demandAssumptions);
    
    // Drive components with deployNeedTotal (backlog included)
    const componentDemands = gpuToComponentDemands(deployNeedTotal, month, effectiveHbmPerGpuThisMonth);

    const componentSupply = { hbm_stacks: 0, cowos_capacity: 0, grid_interconnect: 0, datacenter_mw: 0 };
    const powerDemands = dcMwToPowerDemands(componentDemands.powerMw);

    ['hbm_stacks', 'cowos_capacity', 'grid_interconnect', 'datacenter_mw'].forEach(nodeId => {
      const node = NODES.find(n => n.id === nodeId);
      if (!node) return;
      const state = nodeState[nodeId];
      const nodeResults = results.nodes[nodeId];

      const capacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
      const nodeYield = calculateNodeYield(node, month);
      const maxProducible = capacity * (node.maxCapacityUtilization || 0.95) * nodeYield;

      let demand = 0;
      if (nodeId === 'hbm_stacks') demand = componentDemands.hbmStacks;
      else if (nodeId === 'cowos_capacity') demand = componentDemands.cowosWaferEquiv;
      else if (nodeId === 'grid_interconnect') demand = powerDemands.gridApprovals;
      else if (nodeId === 'datacenter_mw') demand = componentDemands.powerMw;

      const approvalCap = nodeId === 'datacenter_mw' ? componentSupply.grid_interconnect : Infinity;
      const inventoryAvailable = nodeId === 'grid_interconnect' ? 0 : state.inventory;
      
      const availableSupply = maxProducible + inventoryAvailable;
      
      const fulfilled = Math.min(availableSupply, demand + state.backlog, approvalCap);
      const inventoryOut = Math.max(0, availableSupply - fulfilled);
      const backlogOut = Math.max(0, demand + state.backlog - fulfilled);

      // FIX: Use FULFILLED for gating. Using availableSupply breaks logic (ignores demand constraints).
      // Downstream nodes should only see what was actually allocated/delivered.
      componentSupply[nodeId] = fulfilled; 
      
      const tightness = (demand + state.backlog) / Math.max(fulfilled, EPSILON);

      state.priceHistory.push(calculatePriceIndex(tightness));
      state.inventory = nodeId === 'grid_interconnect' ? 0 : inventoryOut;
      state.backlog = backlogOut;
      state.tightnessHistory.push(tightness);

      nodeResults.demand.push(demand);
      nodeResults.supply.push(fulfilled);
      nodeResults.supplyPotential.push(maxProducible);
      nodeResults.capacity.push(capacity);
      nodeResults.tightness.push(tightness);
      nodeResults.priceIndex.push(state.priceHistory[state.priceHistory.length - 1]);
      nodeResults.inventory.push(state.inventory);
      nodeResults.backlog.push(state.backlog);
      nodeResults.shortage.push((backlogOut > 0 || tightness > 1.05) ? 1 : 0);
      nodeResults.glut.push((inventoryOut > 0 && tightness < 0.95) ? 1 : 0);
    });

    // ============================================
    // PHASE 3: Deployment Gating
    // ============================================
    const { cowosWaferEquivPerGpu } = getGpuToComponentIntensities();
    const { kwPerGpu, pue } = getServerInfraIntensities();
    const MWperGPU = (kwPerGpu * pue) / 1000;

    const maxByHBM = componentSupply.hbm_stacks / effectiveHbmPerGpuThisMonth;
    const maxByCoWoS = componentSupply.cowos_capacity / cowosWaferEquivPerGpu;
    const maxByPower = componentSupply.datacenter_mw / MWperGPU;

    const deployableTotal = Math.min(
      gpuAvailableToDeploy,
      deployNeedTotal,
      maxByHBM,
      maxByCoWoS,
      maxByPower
    );

    const poolTightness = deployNeedTotal / Math.max(deployableTotal, EPSILON);

    // Update States
    gpuState.deployBacklog = Math.max(0, deployNeedTotal - deployableTotal);
    gpuState.inventory = Math.max(0, gpuAvailableToDeploy - deployableTotal);
    gpuState.backlog = gpuState.deployBacklog; 

    const dcDelivered = deployableTotal * needShareDc;
    const infDelivered = deployableTotal * needShareInf;

    // ============================================
    // PHASE 4: Finalize GPU Results
    // ============================================

    // --- Datacenter ---
    gpuState.installedBase = Math.max(0, gpuState.installedBase + dcDelivered - dcRetirements);
    gpuState.priceHistory.push(calculatePriceIndex(poolTightness));
    gpuState.poolTightnessHistory.push(poolTightness);
    gpuState.tightnessHistory.push(poolTightness);

    // REPORTING SERIES
    gpuResults.fabOutput.push(fabFulfilled);
    gpuResults.fabNeed.push(fabNeed);
    gpuResults.deployNeed.push(deployNeedTotal);

    // CHART FIX: Demand = Fab Need (Total Pressure)
    gpuResults.demand.push(fabNeed * needShareDc);
    
    gpuResults.supply.push(dcDelivered);
    gpuResults.supplyPotential.push(gpuShipmentsRaw);
    gpuResults.gpuDelivered.push(dcDelivered);
    gpuResults.idleGpus.push(gpuState.inventory);
    gpuResults.capacity.push(gpuCapacity);
    gpuResults.yield.push(gpuYield);
    gpuResults.tightness.push(poolTightness);
    gpuResults.poolTightness.push(poolTightness);
    gpuResults.priceIndex.push(gpuState.priceHistory[gpuState.priceHistory.length - 1]);
    gpuResults.inventory.push(gpuState.inventory); 
    gpuResults.backlog.push(gpuState.deployBacklog);
    gpuResults.installedBase.push(gpuState.installedBase);
    gpuResults.requiredBase.push(requiredDcBase);
    gpuResults.gpuPurchases.push(fabOrderFlow * needShareDc); 
    gpuResults.shortage.push((gpuState.deployBacklog > 0 || poolTightness > 1.05) ? 1 : 0);
    gpuResults.glut.push((gpuState.inventory > 0 && poolTightness < 0.95) ? 1 : 0);

    // --- Inference ---
    infState.installedBase = Math.max(0, infState.installedBase + infDelivered - infRetirements);
    infState.priceHistory.push(calculatePriceIndex(poolTightness));
    infState.inventory = 0;
    infState.backlog = gpuState.deployBacklog * needShareInf;

    // FIX 3: Inference Parity
    infResults.fabOutput.push(fabFulfilled);
    infResults.fabNeed.push(fabNeed);
    infResults.deployNeed.push(deployNeedTotal);

    // CHART FIX: Demand = Fab Need
    infResults.demand.push(fabNeed * needShareInf);
    
    infResults.supply.push(infDelivered);
    infResults.tightness.push(poolTightness);
    infResults.priceIndex.push(infState.priceHistory[infState.priceHistory.length - 1]);
    infResults.backlog.push(infState.backlog);
    infResults.installedBase.push(infState.installedBase);
    infResults.requiredBase.push(requiredInfBase);
    infResults.gpuPurchases.push(fabOrderFlow * needShareInf);
    infResults.shortage.push((infState.backlog > 0 || poolTightness > 1.05) ? 1 : 0);
    infResults.glut.push((poolTightness < 0.95) ? 1 : 0);

    // Process remaining nodes
    const processedNodes = ['gpu_datacenter', 'gpu_inference', 'hbm_stacks', 'cowos_capacity', 'grid_interconnect', 'datacenter_mw'];
    NODES.filter(n => !processedNodes.includes(n.id)).forEach(node => {
      const state = nodeState[node.id];
      const nodeResults = results.nodes[node.id];

      if (node.group === 'A') {
        let workloadDemand = node.baseRate?.value || 0;
        workloadDemand *= calculateDemandGrowth(
          node.id.includes('inference') ? 'inference' : 'training',
          node.id.includes('consumer') ? 'consumer' :
            node.id.includes('enterprise') ? 'enterprise' :
              node.id.includes('agentic') ? 'agentic' :
                node.id.includes('frontier') ? 'frontier' : 'midtier',
          month,
          demandAssumptions
        );
        if (node.id === 'training_frontier' || node.id === 'training_midtier') workloadDemand *= trainingThrottle;
        nodeResults.demand.push(workloadDemand);
        nodeResults.supply.push(workloadDemand);
        return;
      }

      const capacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
      const shipments = capacity * (node.maxCapacityUtilization || 0.95) * calculateNodeYield(node, month);

      let demand = 0;
      if (node.id === 'advanced_wafers') demand = componentDemands.advancedWafers;
      else if (node.id === 'hybrid_bonding') demand = componentDemands.hybridBonding;
      else if (node.id === 'abf_substrate') demand = componentDemands.abfSubstrate;
      else if (node.id === 'osat_capacity') demand = componentDemands.osatUnits;
      else if (node.id === 'dram_server') demand = componentDemands.serverDramGb;
      else if (node.id === 'ssd_datacenter') demand = componentDemands.ssdTb;
      else if (node.id === 'cpu_server') demand = componentDemands.cpus;
      else if (node.id === 'dpu_nic') demand = componentDemands.dpuNics;
      else if (node.id === 'switch_asics') demand = componentDemands.switchAsics;
      else if (node.id === 'optical_transceivers') demand = componentDemands.transceivers;
      else if (node.id === 'infiniband_cables') demand = componentDemands.infinibandCables;
      else if (node.id === 'server_assembly') demand = componentDemands.servers;
      else if (node.id === 'rack_pdu') demand = componentDemands.servers * 0.25;
      else if (node.id === 'liquid_cooling') demand = componentDemands.cdus;
      else if (node.id === 'transformers_lpt') demand = powerDemands.transformers;
      else if (node.id === 'power_generation') demand = powerDemands.ppas;
      else if (node.id === 'backup_power') demand = powerDemands.backupMw;
      else if (node.id === 'dc_construction') demand = powerDemands.dcConstruction;
      else if (node.id === 'dc_ops_staff') demand = powerDemands.dcOpsStaff;
      else if (node.id === 'euv_tools') demand = componentDemands.advancedWafers * 0.00001;
      else if (node.id === 'ml_engineers') demand = requiredGpuBase * 0.005;
      else {
        const parentDemands = (node.parentNodeIds || []).map(pid => {
          const parentResult = results.nodes[pid];
          return parentResult?.demand?.[parentResult.demand.length - 1] || 0;
        });
        demand = parentDemands.reduce((sum, d) => sum + d, 0) * (node.inputIntensity || 1);
      }

      const backlogIn = state.backlog;
      const inventoryIn = isNonInventoriable(node) ? 0 : state.inventory;
      const availableSupply = shipments + inventoryIn;
      const provisionalFulfilled = Math.min(availableSupply, demand + backlogIn);
      const provisionalTightness = (demand + backlogIn) / Math.max(provisionalFulfilled, EPSILON);

      state.priceHistory.push(calculatePriceIndex(provisionalTightness));
      const priceSignalSma = sma(state.priceHistory, GLOBAL_PARAMS.substitution.priceSignalSmaMonths);

      if (node.substitutabilityScore > 0 && provisionalTightness > 1) {
        state.subShare = calculateSubstitutionShare(
          state.subShare, priceSignalSma, node.substitutabilityScore, 0.2, GLOBAL_PARAMS.substitution.adjustmentSpeed
        );
        demand *= (1 - state.subShare);
      }

      const fulfilled = Math.min(availableSupply, demand + backlogIn);
      const inventoryOut = Math.max(0, availableSupply - fulfilled);
      const backlogOut = Math.max(0, demand + backlogIn - fulfilled);
      const tightness = (demand + backlogIn) / Math.max(fulfilled, EPSILON);

      state.inventory = isNonInventoriable(node) ? 0 : inventoryOut;
      state.backlog = backlogOut;
      state.tightnessHistory.push(tightness);

      nodeResults.demand.push(demand);
      nodeResults.supply.push(fulfilled);
      nodeResults.supplyPotential.push(shipments);
      nodeResults.capacity.push(capacity);
      nodeResults.yield.push(calculateNodeYield(node, month));
      nodeResults.tightness.push(tightness);
      nodeResults.priceIndex.push(state.priceHistory[state.priceHistory.length - 1]);
      nodeResults.inventory.push(state.inventory);
      nodeResults.backlog.push(state.backlog);
      nodeResults.shortage.push((backlogOut > 0 || tightness > 1.05) ? 1 : 0);
      nodeResults.glut.push((inventoryOut > 0 && tightness < 0.95) ? 1 : 0);
    });

    // ============================================
    // PHASE 4.5: Capex (Elasticity)
    // ============================================
    const capex = GLOBAL_PARAMS.capexTrigger;
    if (capex) {
      NODES.forEach(node => {
        if (!node.startingCapacity || node.group === 'A' || !ELASTIC_NODES.has(node.id)) return;

        const state = nodeState[node.id];
        if (state.capexExpansionCount >= capex.maxExpansions) return;
        if (month - state.lastCapexTriggerMonth < capex.cooldownMonths) return;

        const recentPrices = state.priceHistory.slice(-capex.persistenceMonths);
        const sustainedTightPricing = recentPrices.length >= capex.persistenceMonths &&
          recentPrices.every(price => price >= capex.priceThreshold);

        if (sustainedTightPricing) {
          const currentCapacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
          state.dynamicExpansions.push({ month: month + (node.leadTimeDebottleneck || 6), capacityAdd: currentCapacity * capex.maxCapacityAddPct });
          state.lastCapexTriggerMonth = month;
          state.capexExpansionCount++;
        }
      });
    }

    // ============================================
    // PHASE 5: Predictive Supply (Inventory/Backlog Aware)
    // ============================================
    const ps = GLOBAL_PARAMS.predictiveSupply;
    if (ps) {
      const forecastMonth = Math.min(month + ps.forecastHorizonMonths, months - 1);
      const forecastInference = calculateInferenceDemand(forecastMonth, demandAssumptions);
      const forecastTraining = calculateTrainingDemand(forecastMonth, demandAssumptions, efficiencyAssumptions);
      const forecastContinual = calculateContinualLearningDemand(forecastMonth, demandAssumptions);
      const forecastTotalAccelHours = (calculateInferenceAccelHours(forecastInference.total, forecastMonth, efficiencyAssumptions, demandAssumptions) +
        forecastTraining.frontierAccelHours + forecastTraining.midtierAccelHours + forecastContinual.accelHours) * CALIBRATION.globalAccelHoursMultiplier;

      const forecastRequiredGpuBase = accelHoursToRequiredGpuBase(forecastTotalAccelHours);
      const forecastRequiredDcBase = forecastRequiredGpuBase * (1 - CALIBRATION.inferenceShare);
      const forecastRequiredInfBase = forecastRequiredGpuBase * CALIBRATION.inferenceShare;

      const forecastGpuState = nodeState['gpu_datacenter'];
      const forecastInfState = nodeState['gpu_inference'];
      
      const forecastDcGap = Math.max(0, forecastRequiredDcBase - forecastGpuState.installedBase);
      const forecastInfGap = Math.max(0, forecastRequiredInfBase - forecastInfState.installedBase);

      const forecastDcCatchup = forecastDcGap / CATCHUP_MONTHS;
      const forecastInfCatchup = forecastInfGap / CATCHUP_MONTHS;

      const forecastDcDemandFlow = forecastDcCatchup + (forecastGpuState.installedBase / forecastGpuState.lifetimeMonths);
      const forecastInfDemandFlow = forecastInfCatchup + (forecastInfState.installedBase / forecastInfState.lifetimeMonths);

      // Forecast Deployment Need
      const forecastDeployNeedTotal = forecastDcDemandFlow + forecastInfDemandFlow + forecastGpuState.deployBacklog;
      
      const forecastComponentDemands = gpuToComponentDemands(forecastDeployNeedTotal, forecastMonth, calculateEffectiveHbmPerGpu(forecastMonth, demandAssumptions));
      const forecastPowerDemands = dcMwToPowerDemands(forecastComponentDemands.powerMw);

      NODES.forEach(node => {
        if (!node.startingCapacity || node.group === 'A' || !ELASTIC_NODES.has(node.id)) return;

        const state = nodeState[node.id];
        if (state.dynamicExpansionCount >= ps.maxDynamicExpansions) return;
        if (month - state.lastTriggerMonth < ps.cooldownMonths) return;

        const forecastCapacity = calculateCapacity(node, forecastMonth, scenarioOverrides, state.dynamicExpansions);
        const forecastSupplyPotential = forecastCapacity * (node.maxCapacityUtilization || 0.95) * calculateNodeYield(node, forecastMonth);

        let forecastDemand = 0;
        if (node.id === 'hbm_stacks') forecastDemand = forecastComponentDemands.hbmStacks;
        else if (node.id === 'cowos_capacity') forecastDemand = forecastComponentDemands.cowosWaferEquiv;
        else if (node.id === 'datacenter_mw') forecastDemand = forecastComponentDemands.powerMw;
        else if (node.id === 'advanced_wafers') forecastDemand = forecastComponentDemands.advancedWafers;
        else if (node.id === 'hybrid_bonding') forecastDemand = forecastComponentDemands.hybridBonding;
        else if (node.id === 'abf_substrate') forecastDemand = forecastComponentDemands.abfSubstrate;
        else if (node.id === 'osat_capacity') forecastDemand = forecastComponentDemands.osatUnits;
        else if (node.id === 'dram_server') forecastDemand = forecastComponentDemands.serverDramGb;
        else if (node.id === 'ssd_datacenter') forecastDemand = forecastComponentDemands.ssdTb;
        else if (node.id === 'cpu_server') forecastDemand = forecastComponentDemands.cpus;
        else if (node.id === 'dpu_nic') forecastDemand = forecastComponentDemands.dpuNics;
        else if (node.id === 'switch_asics') forecastDemand = forecastComponentDemands.switchAsics;
        else if (node.id === 'optical_transceivers') forecastDemand = forecastComponentDemands.transceivers;
        else if (node.id === 'infiniband_cables') forecastDemand = forecastComponentDemands.infinibandCables;
        else if (node.id === 'server_assembly') forecastDemand = forecastComponentDemands.servers;
        else if (node.id === 'rack_pdu') forecastDemand = forecastComponentDemands.servers * 0.25;
        else if (node.id === 'liquid_cooling') forecastDemand = forecastComponentDemands.cdus;
        else if (node.id === 'transformers_lpt') forecastDemand = forecastPowerDemands.transformers;
        else if (node.id === 'grid_interconnect') forecastDemand = forecastPowerDemands.gridApprovals;
        else if (node.id === 'power_generation') forecastDemand = forecastPowerDemands.ppas;
        else if (node.id === 'backup_power') forecastDemand = forecastPowerDemands.backupMw;
        else if (node.id === 'dc_construction') forecastDemand = forecastPowerDemands.dcConstruction;
        else if (node.id === 'dc_ops_staff') forecastDemand = forecastPowerDemands.dcOpsStaff;
        else if (node.id === 'euv_tools') forecastDemand = forecastComponentDemands.advancedWafers * 0.00001;
        else if (node.id === 'ml_engineers') forecastDemand = forecastRequiredGpuBase * 0.005;
        else {
             const nodeResults = results.nodes[node.id];
             forecastDemand = nodeResults?.demand?.[nodeResults.demand.length - 1] || 0;
        }

        // FIX 1: Forecast State Approximation (Roll forward current state)
        const grossShort = forecastDemand - forecastSupplyPotential;
        const currentBl = state.backlog || 0;
        const currentInv = isNonInventoriable(node) ? 0 : (state.inventory || 0);
        
        // Roll forward heuristic: if short, backlog grows; if long, inventory grows
        const blF = Math.max(0, currentBl + Math.max(0, grossShort));
        const invF = Math.max(0, currentInv + Math.max(0, -grossShort));
        
        const netForecastNeed = Math.max(0, forecastDemand + blF - invF);

        const demandRatio = netForecastNeed / (forecastSupplyPotential + EPSILON);
        
        // Trigger based on NET need, preventing over-expansion when inventory is high
        if ((netForecastNeed - forecastSupplyPotential) > 0 && demandRatio >= ps.shortageThreshold) {
          const expansionAmount = Math.max(calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions) * ps.expansionFraction, (netForecastNeed - forecastSupplyPotential) / (node.maxCapacityUtilization || 0.95));
          state.dynamicExpansions.push({ month: month + (node.leadTimeDebottleneck || 6), capacityAdd: expansionAmount });
          state.lastTriggerMonth = month;
          state.dynamicExpansionCount++;
        }
      });
    }
  }

  results.summary = analyzeResults(results);
  return results;
}

// ============================================
// ANALYSIS & FORMATTING (Unchanged)
// ============================================
function analyzeResults(results) {
  const shortages = [], gluts = [], bottlenecks = [];
  const shortagePersistence = GLOBAL_PARAMS.glutThresholds.persistenceMonthsSoft;

  Object.entries(results.nodes).forEach(([nodeId, data]) => {
    const node = getNode(nodeId);
    if (!node || node.group === 'A') return;

    let shortageStart = null, peakTightness = 0, shortageDuration = 0, consecShort = 0;
    data.tightness.forEach((t, month) => {
      if (t > 1.05) {
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
  if (Math.abs(num) >= 1e12) return (num / 1e12).toFixed(decimals) + 'T';
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(decimals) + 'B';
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(decimals) + 'M';
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
}
