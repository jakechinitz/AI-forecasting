/**
 * AI Infrastructure Supply Chain - Calculation Engine
 *
 * This module implements all core calculations for the forecasting model.
 * It uses the CORRECTED formulas from the patch spec:
 *
 * EFFICIENCY MULTIPLIERS:
 *   M_t = (1-m)^(t/12)  - Model efficiency (compute/token) DECREASES - NUMERATOR
 *   S_t = (1+s)^(t/12)  - Systems throughput INCREASES - DENOMINATOR
 *   H_t = (1+h)^(t/12)  - Hardware throughput INCREASES - DENOMINATOR
 *
 * YIELD MODELS:
 *   Simple: Y = 1 - yield_loss
 *   Stacked (HBM): Y(t) = Y_target - (Y_target - Y_initial) * 2^(-t/HL)
 *
 * MARKET CLEARING:
 *   Tightness = (Demand + Backlog) / (Supply + Inventory + ε)
 *   Price_Index = f(Tightness, contracting regime)
 *
 * SUBSTITUTION (with damping):
 *   SubTarget = min(SubMax, SubK * max(0, P_signal - 1))
 *   SubShare_t = SubShare_{t-1} + λ * (SubTarget - SubShare_{t-1})
 *
 * STOCK VS FLOW FIX:
 *   For GPUs and other "stock" assets, we track installed base separately
 *   from shipments (flow). Demand = purchase demand, not required base.
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
const EPSILON = 1e-10;  // Small value to prevent division by zero

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Deep merge objects - scenario overrides merge into base assumptions
 * Arrays are replaced, not concatenated
 */
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

// NOTE: Component node demand is derived from TRANSLATION_INTENSITIES and gpuToComponentDemands.
// Node inputIntensity values for these components are informational only to avoid double-counting.

// ============================================
// CALIBRATION PARAMETERS
// These ensure month-0 demand matches reality
// ============================================
const CALIBRATION = {
  // Target REQUIRED base at month 0 — what the market needs
  // Used for calibration multiplier computation
  targetRequiredBaseGpuDc_2025: 2000000,  // 2M GPUs required by market

  // Starting INSTALLED base — what's actually deployed
  // Below required base = real-world GPU shortage at month 0
  // Gap of 500K represents the backlog/shortage visible in Jan 2026
  startingInstalledBaseGpuDc: 1500000,  // 1.5M GPUs actually installed

  targetUtilization: 0.70,
  // This will be computed at simulation start
  globalAccelHoursMultiplier: 1
};

// ============================================
// GROWTH CACHE - Fix for block spikes
// Cumulative growth computed month-by-month
// ============================================
const growthCache = new Map();

// ============================================
// EFFICIENCY CACHE - Fix for block spikes
// Cumulative efficiency computed month-by-month
// ============================================
const efficiencyCache = new Map();

/**
 * Clear all caches (call when assumptions change)
 */
export function clearGrowthCache() {
  growthCache.clear();
  efficiencyCache.clear();
  intensityCache.length = 0;
  continualLearningCache.length = 0;
}

// ============================================
// CORE CALCULATION FUNCTIONS
// ============================================

/**
 * Calculate efficiency multipliers for a given month
 * FIXED: Uses piecewise cumulative efficiency to avoid block boundary spikes
 * Each multiplier is computed month-by-month, similar to demand growth
 */
export function calculateEfficiencyMultipliers(month, assumptions) {
  // Initialize cache if needed
  const cacheKey = JSON.stringify(assumptions || 'default');
  if (!efficiencyCache.has(cacheKey)) {
    efficiencyCache.set(cacheKey, {
      M_inference: [1],  // month 0 = 1
      M_training: [1],
      S_inference: [1],
      S_training: [1],
      H: [1]
    });
  }

  const cache = efficiencyCache.get(cacheKey);

  // Build up multipliers month by month if needed
  for (let m = cache.M_inference.length; m <= month; m++) {
    const blockKey = getBlockKeyForMonth(m);
    const block = assumptions?.[blockKey] || EFFICIENCY_ASSUMPTIONS[blockKey];

    // Get annual rates from the active block
    // Defaults match assumptions.js year1 (deployed efficiency rates)
    const m_infer = resolveAssumptionValue(block?.modelEfficiency?.m_inference?.value, 0.18);
    const m_train = resolveAssumptionValue(block?.modelEfficiency?.m_training?.value, 0.10);
    const s_infer = resolveAssumptionValue(block?.systemsEfficiency?.s_inference?.value, 0.10);
    const s_train = resolveAssumptionValue(block?.systemsEfficiency?.s_training?.value, 0.08);
    const h = resolveAssumptionValue(block?.hardwareEfficiency?.h?.value, 0.15);

    // Convert annual rates to monthly multipliers
    // M_t: (1-m)^(1/12) - decreases each month
    // S_t, H_t: (1+s)^(1/12) - increases each month
    const monthlyM_infer = Math.pow(1 - m_infer, 1 / 12);
    const monthlyM_train = Math.pow(1 - m_train, 1 / 12);
    const monthlyS_infer = Math.pow(1 + s_infer, 1 / 12);
    const monthlyS_train = Math.pow(1 + s_train, 1 / 12);
    const monthlyH = Math.pow(1 + h, 1 / 12);

    // Compound from previous month
    cache.M_inference[m] = cache.M_inference[m - 1] * monthlyM_infer;
    cache.M_training[m] = cache.M_training[m - 1] * monthlyM_train;
    cache.S_inference[m] = cache.S_inference[m - 1] * monthlyS_infer;
    cache.S_training[m] = cache.S_training[m - 1] * monthlyS_train;
    cache.H[m] = cache.H[m - 1] * monthlyH;
  }

  return {
    // Model efficiency (compute per token) - DECREASES over time
    M_inference: cache.M_inference[month],
    M_training: cache.M_training[month],

    // Systems throughput - INCREASES over time
    S_inference: cache.S_inference[month],
    S_training: cache.S_training[month],

    // Hardware throughput - INCREASES over time
    H: cache.H[month]
  };
}

/**
 * Calculate yield for a node at a given month
 */
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

/**
 * Calculate demand growth multiplier for a given month
 * FIXED: Uses piecewise cumulative growth to avoid block discontinuities
 */
export function calculateDemandGrowth(category, segment, month, assumptions) {
  const key = `${category}:${segment}`;

  // Initialize cache for this key if needed
  if (!growthCache.has(key)) {
    growthCache.set(key, [1]); // month 0 multiplier = 1
  }

  const arr = growthCache.get(key);

  // Build up multipliers month by month
  for (let m = arr.length; m <= month; m++) {
    const blockKey = getBlockKeyForMonth(m);
    const block = assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];

    let rate = 0;
    if (category === 'inference') {
      rate = resolveAssumptionValue(block?.inferenceGrowth?.[segment]?.value, 0.40);
    } else if (category === 'training') {
      rate = resolveAssumptionValue(block?.trainingGrowth?.[segment]?.value, 0.25);
    }

    // Convert annual rate to monthly
    const monthlyRate = Math.pow(1 + rate, 1 / 12) - 1;
    // Compound from previous month
    arr[m] = arr[m - 1] * (1 + monthlyRate);
  }

  return arr[month];
}

/**
 * Calculate capacity at a given month, including committed and dynamic expansions
 * @param node - Node definition
 * @param month - Current month
 * @param scenarioOverrides - Scenario override parameters
 * @param dynamicExpansions - Array of dynamically triggered expansions [{month, capacityAdd}]
 */
export function calculateCapacity(node, month, scenarioOverrides = {}, dynamicExpansions = []) {
  let capacity = node.startingCapacity || 0;

  // Add committed expansions (respect node lead times)
  (node.committedExpansions || []).forEach(expansion => {
    const expansionMonth = dateToMonth(expansion.date);
    const leadTimeMonths = expansion.leadTimeMonths ?? node.leadTimeNewBuild ?? 0;
    const onlineMonth = expansionMonth + leadTimeMonths;
    if (month >= onlineMonth) {
      const monthsSinceExpansion = month - onlineMonth;
      const rampedCapacity = applyRampProfile(
        expansion.capacityAdd,
        monthsSinceExpansion,
        node.rampProfile || 'linear',
        6  // Default ramp duration
      );
      capacity += rampedCapacity;
    }
  });

  // Add dynamic (predictive) expansions triggered by the sim
  dynamicExpansions.forEach(expansion => {
    if (month >= expansion.month) {
      const monthsSinceExpansion = month - expansion.month;
      const rampedCapacity = applyRampProfile(
        expansion.capacityAdd,
        monthsSinceExpansion,
        node.rampProfile || 'linear',
        6
      );
      capacity += rampedCapacity;
    }
  });

  // Apply scenario overrides (e.g., geopolitical shock)
  if (scenarioOverrides.supply?.affectedNodes?.includes(node.id)) {
    const shockMonth = scenarioOverrides.supply.shockMonth || 24;
    const reduction = scenarioOverrides.supply.capacityReduction || 0.5;
    const recoveryMonths = scenarioOverrides.supply.recoveryMonths || 36;

    if (month >= shockMonth) {
      const monthsSinceShock = month - shockMonth;
      const recoveryFactor = Math.min(1, monthsSinceShock / recoveryMonths);
      const currentReduction = reduction * (1 - recoveryFactor);
      capacity *= (1 - currentReduction);
    }
  }

  return capacity;
}

/**
 * Apply ramp profile to capacity addition
 */
function applyRampProfile(capacityAdd, monthsSinceExpansion, profile, rampDuration) {
  const t = Math.min(monthsSinceExpansion / rampDuration, 1);

  switch (profile) {
    case 'step':
      return capacityAdd;

    case 'linear':
      return capacityAdd * t;

    case 's-curve':
      // Sigmoid function for S-curve
      const x = (t - 0.5) * 10;  // Scale for sigmoid
      const sigmoid = 1 / (1 + Math.exp(-x));
      return capacityAdd * sigmoid;

    default:
      return capacityAdd * t;
  }
}

/**
 * Convert date string to month index
 */
function dateToMonth(dateStr) {
  const [year, month] = dateStr.split('-').map(Number);
  return (year - GLOBAL_PARAMS.startYear) * 12 + (month - GLOBAL_PARAMS.startMonth);
}

/**
 * Calculate tightness ratio
 * Tightness = (Demand + Backlog) / (Supply + Inventory + ε)
 */
export function calculateTightness(demand, backlog, supply, inventory) {
  return (demand + backlog) / (supply + inventory + EPSILON);
}

/**
 * Calculate price index from tightness
 * Uses the corrected formula with global parameters
 */
export function calculatePriceIndex(tightness, params = GLOBAL_PARAMS.priceIndex) {
  const { a, b, minPrice, maxPrice } = params;

  let price;
  if (tightness <= 1) {
    // Soft market - price decreases
    price = Math.pow(tightness, 0.5);  // Gradual decrease
  } else {
    // Tight market - price spikes
    price = 1 + a * Math.pow(tightness - 1, b);
  }

  return Math.max(minPrice, Math.min(maxPrice, price));
}

/**
 * Calculate substitution share with damping
 * Uses smoothed price signal and sticky adjustment
 */
export function calculateSubstitutionShare(
  currentShare,
  priceSignalSma,
  subMax,
  subK,
  lambda
) {
  const target = Math.min(subMax, subK * Math.max(0, priceSignalSma - 1));
  return currentShare + lambda * (target - currentShare);
}

/**
 * Calculate inventory in units
 */
export function calculateInventory(prevInventory, supply, shipments) {
  return Math.max(0, prevInventory + supply - shipments);
}

/**
 * Calculate months of supply for display
 */
export function calculateMonthsOfSupply(inventoryUnits, forwardDemand, forwardMonths = 3) {
  const avgDemand = forwardDemand.slice(0, forwardMonths).reduce((a, b) => a + b, 0) / forwardMonths;
  return inventoryUnits / (avgDemand + EPSILON);
}

/**
 * Calculate backlog
 */
export function calculateBacklog(prevBacklog, demand, supply) {
  return Math.max(0, prevBacklog + demand - supply);
}

/**
 * Cap monthly GPU deployments using datacenter power deployment velocity.
 * Uses existing datacenter_mw capacity plus server power intensities.
 */
function calculateDeploymentVelocityCap(month, scenarioOverrides, nodeState) {
  const dcNode = NODES.find(node => node.id === 'datacenter_mw');
  if (!dcNode) {
    return Infinity;
  }

  const dcState = nodeState?.[dcNode.id];
  const capacity = calculateCapacity(dcNode, month, scenarioOverrides, dcState?.dynamicExpansions);
  const nodeYield = calculateNodeYield(dcNode, month);
  const maxUtilization = dcNode.maxCapacityUtilization || 0.95;
  const maxPowerMw = capacity * maxUtilization * nodeYield;

  const { kwPerGpu, pue } = getServerInfraIntensities();
  const mwPerGpu = (kwPerGpu * pue) / 1000;

  if (!Number.isFinite(mwPerGpu) || mwPerGpu <= 0) {
    return Infinity;
  }

  return Math.max(0, maxPowerMw / mwPerGpu);
}

/**
 * Simple moving average
 */
export function sma(values, window) {
  if (values.length < window) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  const slice = values.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / window;
}

// ============================================
// DEMAND ENGINE
// ============================================

/**
 * Calculate total inference demand for a given month
 * Returns tokens/month
 * FIXED: Uses runtime assumptions
 */
export function calculateInferenceDemand(month, assumptions) {
  // Read base rates from workloadBase (single source of truth in assumptions.js)
  const blockKey = getBlockKeyForMonth(month);
  const block = assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
  const base = block?.workloadBase?.inferenceTokensPerMonth ||
               DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.inferenceTokensPerMonth;

  const consumerBase = base.consumer;    // 5T tokens/month (Jan 2026)
  const enterpriseBase = base.enterprise; // 6T tokens/month
  const agenticBase = base.agentic;       // 1T tokens/month

  // Growth multipliers - using runtime assumptions
  const consumerGrowth = calculateDemandGrowth('inference', 'consumer', month, assumptions);
  const enterpriseGrowth = calculateDemandGrowth('inference', 'enterprise', month, assumptions);
  const agenticGrowth = calculateDemandGrowth('inference', 'agentic', month, assumptions);

  return {
    consumer: consumerBase * consumerGrowth,
    enterprise: enterpriseBase * enterpriseGrowth,
    agentic: agenticBase * agenticGrowth,
    total: (consumerBase * consumerGrowth) +
           (enterpriseBase * enterpriseGrowth) +
           (agenticBase * agenticGrowth)
  };
}

/**
 * Calculate training demand for a given month
 * Returns accelerator-hours/month
 * FIXED: Uses runtime assumptions
 */
export function calculateTrainingDemand(month, demandAssumptions, efficiencyAssumptions) {
  // Read base rates from workloadBase (single source of truth)
  const blockKey = getBlockKeyForMonth(month);
  const block = demandAssumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
  const baseTrain = block?.workloadBase?.trainingRunsPerMonth ||
                    DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.trainingRunsPerMonth;
  const baseCompute = block?.workloadBase?.trainingComputePerRun ||
                      DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.trainingComputePerRun;

  const frontierBase = baseTrain.frontier;   // runs/month
  const midtierBase = baseTrain.midtier;     // runs/month

  // Compute per run (accelerator-hours)
  const frontierComputePerRun = baseCompute.frontier;  // 1M accelerator-hours per frontier run
  const midtierComputePerRun = baseCompute.midtier;    // 5K accelerator-hours per mid-tier run

  const frontierGrowth = calculateDemandGrowth('training', 'frontier', month, demandAssumptions);
  const midtierGrowth = calculateDemandGrowth('training', 'midtier', month, demandAssumptions);

  // Get efficiency multipliers - using runtime assumptions
  const eff = calculateEfficiencyMultipliers(month, efficiencyAssumptions);

  return {
    frontierRuns: frontierBase * frontierGrowth,
    midtierRuns: midtierBase * midtierGrowth,
    // Apply efficiency: demand * M_t / (S_t * H_t)
    frontierAccelHours: (frontierBase * frontierGrowth * frontierComputePerRun * eff.M_training) /
                        (eff.S_training * eff.H),
    midtierAccelHours: (midtierBase * midtierGrowth * midtierComputePerRun * eff.M_training) /
                       (eff.S_training * eff.H),
    totalAccelHours: 0  // Calculated below
  };
}

/**
 * Throttle training demand based on recent GPU market tightness.
 * Uses prior month tightness to avoid circular dependencies.
 */
function calculateTrainingThrottle(month, results) {
  if (month <= 0) {
    return 1;
  }

  const gpuResults = results?.nodes?.gpu_datacenter;
  const tightnessHistory = gpuResults?.tightness || [];

  if (tightnessHistory.length === 0) {
    return 1;
  }

  const lastIndex = Math.min(month - 1, tightnessHistory.length - 1);
  const lastTightness = tightnessHistory[lastIndex];

  if (!Number.isFinite(lastTightness)) {
    return 1;
  }

  if (lastTightness <= 1) {
    return 1;
  }

  const throttle = 1 / lastTightness;
  return Math.max(0, Math.min(1, throttle));
}

// ============================================
// INTENSITY CACHE - For compute intensity growth
// ============================================
const intensityCache = [];

// ============================================
// CONTINUAL LEARNING CACHE - For fine-tuning/RLHF demand
// ============================================
const continualLearningCache = [];

/**
 * Calculate inference intensity multiplier for a given month
 * This captures increasing compute per token from:
 * - Longer contexts (attention scales quadratically)
 * - Multi-step reasoning / chain-of-thought
 * - Agentic loops and tool use
 * - Higher quality / larger model deployment mix
 *
 * Intensity_t = (1 + i)^(t/12) where i is annual intensity growth rate
 */
export function calculateIntensityMultiplier(month, assumptions) {
  // Build cache up to requested month
  for (let m = intensityCache.length; m <= month; m++) {
    const blockKey = getBlockKeyForMonth(m);
    const block = assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];

    // Default intensity growth: 40% per year (context + reasoning + agents)
    // This partially offsets efficiency gains
    const intensityGrowthRate = resolveAssumptionValue(block?.intensityGrowth?.value, 0.40);

    if (m === 0) {
      intensityCache[m] = 1;
    } else {
      const monthlyRate = Math.pow(1 + intensityGrowthRate, 1 / 12);
      intensityCache[m] = intensityCache[m - 1] * monthlyRate;
    }
  }

  return intensityCache[month];
}

/**
 * Calculate accelerator hours required for inference
 * FIXED: Uses runtime assumptions + intensity multiplier
 */
export function calculateInferenceAccelHours(tokens, month, efficiencyAssumptions, demandAssumptions) {
  const eff = calculateEfficiencyMultipliers(month, efficiencyAssumptions);

  // Base conversion: FLOPs per token at t=0
  const flopsPerToken = 2e9;  // 2 GFLOP per token
  const accelFlopsPerHour = 1e15 * 3600;  // ~1 PFLOP-hour per accel-hour

  // Get intensity multiplier (compute per token grows with context/reasoning/agents)
  const intensity = calculateIntensityMultiplier(month, demandAssumptions);

  // Apply efficiency AND intensity: tokens * flops/token * M_t * Intensity_t / (S_t * H_t * throughput)
  const rawAccelHours = (tokens * flopsPerToken * eff.M_inference * intensity) /
                        (eff.S_inference * eff.H * accelFlopsPerHour);

  return rawAccelHours;
}

/**
 * Calculate continual learning demand for a given month
 * Continual learning includes: fine-tuning, RLHF, RAG updates, periodic retraining
 * Returns: { accelHours, dataTB, networkGbps }
 */
export function calculateContinualLearningDemand(month, demandAssumptions) {
  // Build cache up to requested month
  for (let m = continualLearningCache.length; m <= month; m++) {
    const blockKey = getBlockKeyForMonth(m);
    const block = demandAssumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];

    // Get growth rates
    const computeGrowthRate = resolveAssumptionValue(block?.continualLearning?.computeGrowth?.value, 0.60);
    const dataGrowthRate = resolveAssumptionValue(block?.continualLearning?.dataStorageGrowth?.value, 0.50);
    const networkGrowthRate = resolveAssumptionValue(block?.continualLearning?.networkBandwidthGrowth?.value, 0.45);

    if (m === 0) {
      // Base continual learning demand at month 0 - read from workloadBase
      const baseCL = block?.workloadBase?.continualLearningBase ||
                     DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.continualLearningBase;
      continualLearningCache[m] = {
        accelHours: baseCL.accelHoursPerMonth,  // 150K accel-hours/month
        dataTB: baseCL.dataTB,                   // 1500 TB base storage
        networkGbps: baseCL.networkGbps           // 300 Gbps base bandwidth
      };
    } else {
      const prev = continualLearningCache[m - 1];
      const monthlyComputeRate = Math.pow(1 + computeGrowthRate, 1 / 12);
      const monthlyDataRate = Math.pow(1 + dataGrowthRate, 1 / 12);
      const monthlyNetworkRate = Math.pow(1 + networkGrowthRate, 1 / 12);

      continualLearningCache[m] = {
        accelHours: prev.accelHours * monthlyComputeRate,
        dataTB: prev.dataTB * monthlyDataRate,
        networkGbps: prev.networkGbps * monthlyNetworkRate
      };
    }
  }

  return continualLearningCache[month];
}

/**
 * Calculate effective HBM stacks per GPU based on continual learning adoption
 * Continual learning increases memory demands due to:
 * - Larger working sets for fine-tuning
 * - Checkpoint storage during training
 * - KV cache growth for longer contexts
 *
 * Formula: effectiveStacks = baseStacks * (1 + adoption(t) * (memoryMultiplierAtFull - 1))
 */
export function calculateEffectiveHbmPerGpu(month, demandAssumptions) {
  const { hbmStacksPerGpu } = getGpuToComponentIntensities();
  const baseStacksPerGPU = hbmStacksPerGpu;

  // Read memory multiplier from assumptions (single source of truth)
  const blockKey = getBlockKeyForMonth(month);
  const block = demandAssumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
  const memoryMultiplierAtFullAdoption =
    resolveAssumptionValue(block?.continualLearning?.memoryMultiplierAtFullAdoption?.value, 1.6);

  // Calculate adoption using logistic curve based on continual learning compute growth
  const continualLearning = calculateContinualLearningDemand(month, demandAssumptions);

  // Use accel-hours as proxy for adoption
  // Month 0: base accel-hours (from workloadBase) = 10% adoption
  // Grows toward 90% adoption as compute demand increases
  const baseCL = block?.workloadBase?.continualLearningBase ||
                 DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY].workloadBase.continualLearningBase;
  const baseAccelHours = baseCL.accelHoursPerMonth;
  const growthRatio = continualLearning.accelHours / baseAccelHours;

  // Logistic adoption: a(t) = 0.1 + 0.8 * (growthRatio / (1 + growthRatio))
  // Reaches ~0.9 adoption rate by 2030
  const adoption = 0.1 + 0.8 * (growthRatio / (1 + growthRatio));

  // Calculate effective stacks per GPU
  const effectiveStacksPerGPU = baseStacksPerGPU * (1 + adoption * (memoryMultiplierAtFullAdoption - 1));

  return effectiveStacksPerGPU;
}

// ============================================
// TRANSLATION LAYER
// ============================================

/**
 * Translate accelerator hours to GPU REQUIRED BASE (stock needed)
 */
export function accelHoursToRequiredGpuBase(accelHours, utilization = 0.70) {
  const hoursPerMonth = 720;  // 30 days * 24 hours
  return accelHours / (hoursPerMonth * utilization);
}

/**
 * Translate GPU demand to component demands
 * @param gpuCount - Number of GPUs
 * @param month - Simulation month (for adoption curves)
 * @param effectiveHbmPerGpu - Effective HBM stacks per GPU (increases with continual learning)
 */
export function gpuToComponentDemands(gpuCount, month, effectiveHbmPerGpu = 8) {
  const gpuToComponents = getGpuToComponentIntensities();
  const serverInfra = getServerInfraIntensities();
  const hybridBondingAdoption = calculateHybridBondingAdoption(month);
  const gpusPerServer = serverInfra.gpusPerServer;
  const powerMwPerGpu = (serverInfra.kwPerGpu * serverInfra.pue) / 1000;
  const hybridBondingIntensity = gpuToComponents.hybridBondingPerGpu
    * gpuToComponents.hybridBondingPackageShare
    * hybridBondingAdoption;

  return {
    // Semiconductor components
    hbmStacks: gpuCount * effectiveHbmPerGpu,  // HBM stacks per GPU (increases with continual learning)
    cowosWaferEquiv: gpuCount * gpuToComponents.cowosWaferEquivPerGpu,
    advancedWafers: gpuCount * gpuToComponents.advancedWafersPerGpu,
    hybridBonding: gpuCount * hybridBondingIntensity,

    // Memory & storage (per GPU, not per server)
    serverDramGb: gpuCount * gpuToComponents.serverDramGbPerGpu,
    ssdTb: gpuCount * 1,                       // 1 TB SSD per GPU (8 TB / 8-GPU server)

    // Compute & networking
    cpus: gpuCount * 0.25,                     // 2 CPUs per 8-GPU server = 0.25 per GPU
    dpuNics: gpuCount * 1,                     // 1 DPU/NIC per GPU
    switchAsics: gpuCount * 0.125,             // 1 switch per 8 GPUs
    transceivers: gpuCount * 1,                // 1 optical transceiver per GPU
    infinibandCables: gpuCount * 4,            // 4 cables per GPU

    // Packaging & substrates
    abfSubstrate: gpuCount * 0.02,             // 0.02 sqm ABF per GPU
    osatUnits: gpuCount * 1,                   // 1 OSAT test per GPU

    // Server & infrastructure
    servers: gpuCount / gpusPerServer,
    cdus: gpuCount * 0.05,                     // 1 CDU per 20 GPUs
    powerMw: gpuCount * powerMwPerGpu
  };
}

/**
 * Translate data center MW to power infrastructure
 */
export function dcMwToPowerDemands(mw) {
  return {
    transformers: mw * 0.02,           // 1 transformer per 50 MW
    gridApprovals: mw * 1.0,           // 1:1 for MW approvals
    ppas: mw * 1.2,                    // 120% for redundancy
    backupMw: mw * 1.5,               // 150% for N+1
    dcConstruction: mw * 500,          // 500 worker-months per MW
    dcOpsStaff: mw * 0.5              // 0.5 FTE per MW
  };
}

// ============================================
// FULL SIMULATION ENGINE
// ============================================

/**
 * Run the full simulation for all months
 * Returns complete time series data for all nodes
 *
 * FIXES APPLIED:
 * 1. Cumulative growth (no block spikes) - demand AND efficiency
 * 2. Stock vs flow for GPUs (installed base tracking)
 * 3. Runtime assumptions used everywhere
 * 4. Group A excluded from market clearing
 * 5. CALIBRATION: Month-0 demand matches reality
 * 6. Component demand driven by gpuProductionRequirement (purchaseDemand + backlog)
 * 7. Persistence-based shortage/glut detection
 * 8. Deep-merge scenario overrides
 * 9. Hard-gating: GPU delivered = min(raw, HBM, CoWoS, power)
 * 10. Predictive supply elasticity (dynamic expansions from forecast)
 */
export function runSimulation(assumptions, scenarioOverrides = {}) {
  // Clear all caches for fresh calculation with new assumptions
  clearGrowthCache();

  const months = GLOBAL_PARAMS.horizonYears * 12;
  const results = {
    months: [],
    nodes: {},
    summary: {
      shortages: [],
      gluts: [],
      bottlenecks: []
    }
  };

  // Extract demand and efficiency assumptions with deep-merge
  // Scenario overrides deep-merge into base assumptions
  const baseDemandAssumptions = assumptions?.demand || DEMAND_ASSUMPTIONS;
  const baseEfficiencyAssumptions = assumptions?.efficiency || EFFICIENCY_ASSUMPTIONS;

  // Deep-merge scenario overrides if provided
  const demandAssumptions = deepMerge(baseDemandAssumptions, scenarioOverrides?.demand);
  const efficiencyAssumptions = deepMerge(baseEfficiencyAssumptions, scenarioOverrides?.efficiency);

  // ============================================
  // CALIBRATION: Compute multiplier so month-0 matches reality
  // Now includes continual learning for calibration parity
  // ============================================
  const rawMonth0Inference = calculateInferenceDemand(0, demandAssumptions);
  const rawMonth0Training = calculateTrainingDemand(0, demandAssumptions, efficiencyAssumptions);
  const rawMonth0Continual = calculateContinualLearningDemand(0, demandAssumptions);
  const rawMonth0InferAccelHours = calculateInferenceAccelHours(rawMonth0Inference.total, 0, efficiencyAssumptions, demandAssumptions);
  const rawMonth0TotalAccelHours = rawMonth0InferAccelHours +
    rawMonth0Training.frontierAccelHours +
    rawMonth0Training.midtierAccelHours +
    rawMonth0Continual.accelHours;  // Include continual learning
  const rawMonth0RequiredBase = accelHoursToRequiredGpuBase(rawMonth0TotalAccelHours);

  // Target accel-hours needed to justify the target REQUIRED base (not installed)
  const targetAccelHours = CALIBRATION.targetRequiredBaseGpuDc_2025 * 720 * CALIBRATION.targetUtilization;
  CALIBRATION.globalAccelHoursMultiplier = targetAccelHours / (rawMonth0TotalAccelHours + EPSILON);

  // Initialize node state
  const nodeState = {};
  NODES.forEach(node => {
    // STOCK VS FLOW FIX: Track installed base for GPU nodes
    const isStockNode = ['gpu_datacenter', 'gpu_inference'].includes(node.id);
    // Initialize with ACTUAL installed base (below required base = shortage)
    const startingInstalledBase = isStockNode ? CALIBRATION.startingInstalledBaseGpuDc : 0;
    const lifetimeMonths = node.lifetimeMonths || 48; // 4 year default lifetime

    nodeState[node.id] = {
      inventory: (scenarioOverrides?.startingState?.inventoryByNode?.[node.id] ??
        node.startingInventory ??
        ((node.inventoryBufferTarget || 0) * (node.startingCapacity || 0) / 4)),
      backlog: (scenarioOverrides?.startingState?.backlogByNode?.[node.id] ??
        node.startingBacklog ?? 0),
      subShare: 0,
      priceHistory: [1],
      tightnessHistory: [],  // Track for persistence
      // Stock tracking
      installedBase: startingInstalledBase,
      lifetimeMonths: lifetimeMonths,
      // Predictive supply elasticity
      dynamicExpansions: [],       // [{month, capacityAdd}] triggered by forecast
      lastTriggerMonth: -Infinity, // Cooldown tracking
      dynamicExpansionCount: 0,    // Cap total dynamic expansions
      lastCapexTriggerMonth: -Infinity,
      capexExpansionCount: 0
    };
    results.nodes[node.id] = {
      demand: [],
      supply: [],           // Actual shipments (what clears)
      supplyPotential: [],  // Max producible (capacity * util * yield)
      gpuDelivered: [],     // GPUs actually usable after gating by components
      idleGpus: [],         // GPUs produced but blocked by component shortages
      tightness: [],
      priceIndex: [],
      inventory: [],
      backlog: [],
      capacity: [],
      yield: [],
      shortage: [],
      glut: [],
      installedBase: [],
      requiredBase: [],     // For stock nodes: required installed base
      gpuPurchases: []      // Track GPU purchases for component demand
    };
  });

  // Unit sanity check (one-time): confirm CoWoS capacity is in wafers/month
  if (!globalThis.__printedUnitsOnce) {
    globalThis.__printedUnitsOnce = true;
    const cowos = NODES.find(n => n.id === 'cowos_capacity');
    console.log('[units] cowos_capacity assumed wafer-equiv/month =', cowos?.startingCapacity,
      '| If not wafers/month, scale values and adjust waferPerGPU accordingly');
  }

  // Run simulation for each month
  for (let month = 0; month < months; month++) {
    results.months.push(month);

    // Calculate workload demands using runtime assumptions
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

    // Calculate total accelerator hours with calibration (now includes intensity growth + continual learning)
    const inferenceAccelHours = calculateInferenceAccelHours(inferenceDemand.total, month, efficiencyAssumptions, demandAssumptions);
    const rawTotalAccelHours = inferenceAccelHours +
                               trainingDemand.frontierAccelHours +
                               trainingDemand.midtierAccelHours +
                               continualLearningDemand.accelHours;
    const totalAccelHours = rawTotalAccelHours * CALIBRATION.globalAccelHoursMultiplier;

    // Translate to GPU REQUIRED BASE (stock needed to run workloads)
    const requiredGpuBase = accelHoursToRequiredGpuBase(totalAccelHours);

    // ============================================
    // PHASE 1: Calculate GPU raw production and demands
    // ============================================
    const gpuNode = NODES.find(n => n.id === 'gpu_datacenter');
    const gpuState = nodeState['gpu_datacenter'];
    const gpuResults = results.nodes['gpu_datacenter'];

    // Calculate GPU capacity and raw shipments (before gating)
    const gpuCapacity = calculateCapacity(gpuNode, month, scenarioOverrides, gpuState.dynamicExpansions);
    const gpuYield = calculateNodeYield(gpuNode, month);
    const gpuMaxUtil = gpuNode.maxCapacityUtilization || 0.95;
    const gpuShipmentsRaw = gpuCapacity * gpuMaxUtil * gpuYield;

    // Calculate GPU purchase demand
    // Demand = current shortfall (gap) + replacement demand (retirements)
    const gpuRetirements = gpuState.installedBase / gpuState.lifetimeMonths;
    const gpuGap = Math.max(0, requiredGpuBase - gpuState.installedBase);
    const gpuDemand = gpuGap + gpuRetirements;

    // OPTION 3: Component demand driven by production requirement
    const gpuProductionRequirement = gpuDemand + gpuState.backlog;
    const deploymentVelocityCap = calculateDeploymentVelocityCap(month, scenarioOverrides, nodeState);
    const gpuPurchasesThisMonth = Math.min(gpuProductionRequirement, deploymentVelocityCap);

    // Calculate effective HBM per GPU (increases with continual learning adoption)
    const effectiveHbmPerGpuThisMonth = calculateEffectiveHbmPerGpu(month, demandAssumptions);

    // Compute component demands from GPU production requirement
    const componentDemands = gpuToComponentDemands(
      gpuPurchasesThisMonth,
      month,
      effectiveHbmPerGpuThisMonth
    );

    // ============================================
    // PHASE 2: Process component nodes to get their supply
    // ============================================
    const componentSupply = {
      hbm_stacks: 0,
      cowos_capacity: 0,
      grid_interconnect: 0,
      datacenter_mw: 0
    };

    const powerDemands = dcMwToPowerDemands(componentDemands.powerMw);

    // Process gating component nodes first
    ['hbm_stacks', 'cowos_capacity', 'grid_interconnect', 'datacenter_mw'].forEach(nodeId => {
      const node = NODES.find(n => n.id === nodeId);
      if (!node) return;

      const state = nodeState[nodeId];
      const nodeResults = results.nodes[nodeId];

      const capacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
      const nodeYield = calculateNodeYield(node, month);
      const maxUtilization = node.maxCapacityUtilization || 0.95;
      const maxProducible = capacity * maxUtilization * nodeYield;

      // Get demand for this component
      let demand = 0;
      if (nodeId === 'hbm_stacks') demand = componentDemands.hbmStacks;
      else if (nodeId === 'cowos_capacity') demand = componentDemands.cowosWaferEquiv;
      else if (nodeId === 'grid_interconnect') demand = powerDemands.gridApprovals;
      else if (nodeId === 'datacenter_mw') demand = componentDemands.powerMw;

      // Calculate actual supply (what can ship given demand and inventory)
      const approvalCap = nodeId === 'datacenter_mw'
        ? componentSupply.grid_interconnect
        : Infinity;
      const inventoryAvailable = nodeId === 'grid_interconnect' ? 0 : state.inventory;
      const backlogIn = state.backlog;
      const availableSupply = maxProducible + inventoryAvailable;
      const fulfilled = Math.min(availableSupply, demand + backlogIn, approvalCap);
      const inventoryOut = Math.max(0, availableSupply - fulfilled);
      const backlogOut = Math.max(0, demand + backlogIn - fulfilled);

      // Store supply for gating calculation
      componentSupply[nodeId] = fulfilled;

      // Calculate tightness
      const tightness = (demand + backlogIn) / Math.max(fulfilled, EPSILON);

      // Update state
      state.priceHistory.push(calculatePriceIndex(tightness));
      state.inventory = nodeId === 'grid_interconnect' ? 0 : inventoryOut;
      state.backlog = backlogOut;
      state.tightnessHistory.push(tightness);

      // Store results
      nodeResults.demand.push(demand);
      nodeResults.supply.push(fulfilled);
      nodeResults.supplyPotential.push(maxProducible);
      nodeResults.gpuDelivered.push(0);
      nodeResults.idleGpus.push(0);
      nodeResults.capacity.push(capacity);
      nodeResults.yield.push(nodeYield);
      nodeResults.tightness.push(tightness);
      nodeResults.priceIndex.push(state.priceHistory[state.priceHistory.length - 1]);
      nodeResults.inventory.push(state.inventory);
      nodeResults.backlog.push(state.backlog);
      nodeResults.installedBase.push(0);
      nodeResults.requiredBase.push(0);
      nodeResults.gpuPurchases.push(0);

      const isShortage = backlogOut > 0 || tightness > 1.05;
      const isGlut = inventoryOut > 0 && tightness < 0.95;
      nodeResults.shortage.push(isShortage ? 1 : 0);
      nodeResults.glut.push(isGlut ? 1 : 0);
    });

    // ============================================
    // PHASE 3: Hard-gate GPU deliveries by bottlenecks
    // ============================================
    // Calculate max deliverable GPUs by each component
    // Continual learning increases HBM demand per GPU
    const effectiveStacksPerGPU = calculateEffectiveHbmPerGpu(month, demandAssumptions);
    const { cowosWaferEquivPerGpu } = getGpuToComponentIntensities();
    const { kwPerGpu, pue } = getServerInfraIntensities();
    const cowosUnitsPerGPU = cowosWaferEquivPerGpu;
    const MWperGPU = (kwPerGpu * pue) / 1000;

    const maxByHBM = componentSupply.hbm_stacks / effectiveStacksPerGPU;
    const maxByCoWoS = componentSupply.cowos_capacity / cowosUnitsPerGPU;
    const maxByPower = componentSupply.datacenter_mw / MWperGPU;

    // GPU delivered = min of production and all gating components
    const gpuAvailableToShip = Math.min(
      gpuShipmentsRaw + gpuState.inventory,
      gpuDemand + gpuState.backlog,
      deploymentVelocityCap
    );
    const gpuDelivered = Math.min(gpuAvailableToShip, maxByHBM, maxByCoWoS, maxByPower);

    // Idle GPUs = produced/shipped but blocked by component constraints
    const idleGpus = Math.max(0, gpuAvailableToShip - gpuDelivered);

    // ============================================
    // PHASE 4: Finalize GPU node results
    // ============================================
    // Calculate tightness based on fulfilled GPUs
    const gpuTightness = (gpuDemand + gpuBacklogIn) / Math.max(gpuDelivered, EPSILON);

    // Update installed base with DELIVERED GPUs (not raw shipments)
    gpuState.installedBase = Math.max(0, gpuState.installedBase + gpuDelivered - gpuRetirements);

    // Update price history
    gpuState.priceHistory.push(calculatePriceIndex(gpuTightness));

    // Update inventory (deliverable inventory only; idle tracked separately)
    // Backlog is demand not met
    const gpuInventoryOut = Math.max(0, gpuAvailableSupply - gpuDelivered);
    const gpuBacklogOut = Math.max(0, gpuDemand + gpuBacklogIn - gpuDelivered);
    gpuState.inventory = gpuInventoryOut;
    gpuState.backlog = gpuBacklogOut;

    // Cap backlog to current shortfall — prevents unbounded backlog growth
    // that would cause installed base to overshoot required base when cleared.
    // As deliveries close the gap, excess orders are effectively cancelled.
    const gpuCurrentShortfall = Math.max(0, requiredGpuBase - gpuState.installedBase);
    gpuState.backlog = Math.min(gpuState.backlog, gpuCurrentShortfall);

    // Store GPU results
    gpuResults.demand.push(gpuDemand);
    gpuResults.supply.push(gpuDelivered);                 // Fulfilled GPU deliveries
    gpuResults.supplyPotential.push(gpuShipmentsRaw);     // Max producible
    gpuResults.gpuDelivered.push(gpuDelivered);           // Actually usable after gating
    gpuResults.idleGpus.push(idleGpus);                   // Blocked by components
    gpuResults.capacity.push(gpuCapacity);
    gpuResults.yield.push(gpuYield);
    gpuResults.tightness.push(gpuTightness);
    gpuResults.priceIndex.push(gpuState.priceHistory[gpuState.priceHistory.length - 1]);
    gpuResults.inventory.push(gpuState.inventory);
    gpuResults.backlog.push(gpuState.backlog);
    gpuResults.installedBase.push(gpuState.installedBase);
    gpuResults.requiredBase.push(requiredGpuBase);
    gpuResults.gpuPurchases.push(gpuPurchasesThisMonth);

    // Track tightness history for persistence-based detection
    gpuState.tightnessHistory.push(gpuTightness);

    // Persistence-based shortage/glut detection
    const gpuIsShortage = gpuBacklogOut > 0 || gpuTightness > 1.05;
    const gpuIsGlut = gpuInventoryOut > 0 && gpuTightness < 0.95;
    gpuResults.shortage.push(gpuIsShortage ? 1 : 0);
    gpuResults.glut.push(gpuIsGlut ? 1 : 0);

    // Process all other nodes (skip already processed: gpu_datacenter, hbm_stacks, cowos_capacity, datacenter_mw)
    const processedNodes = ['gpu_datacenter', 'hbm_stacks', 'cowos_capacity', 'grid_interconnect', 'datacenter_mw'];
    NODES.filter(n => !processedNodes.includes(n.id)).forEach(node => {
      const state = nodeState[node.id];
      const nodeResults = results.nodes[node.id];

      // Skip market clearing for Group A (workload drivers)
      if (node.group === 'A') {
        // For workload nodes, just track demand for display
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
        if (node.id === 'training_frontier' || node.id === 'training_midtier') {
          workloadDemand *= trainingThrottle;
        }

        // Store workload demand but use neutral values for market metrics
        nodeResults.demand.push(workloadDemand);
        nodeResults.supply.push(workloadDemand);          // Supply = demand (no constraint)
        nodeResults.supplyPotential.push(workloadDemand); // Same for workloads
        nodeResults.capacity.push(workloadDemand);
        nodeResults.yield.push(1);
        nodeResults.tightness.push(1);  // Neutral - not a market
        nodeResults.priceIndex.push(1);
        nodeResults.inventory.push(0);
        nodeResults.backlog.push(0);
        nodeResults.shortage.push(0);
        nodeResults.glut.push(0);
        nodeResults.installedBase.push(0);
        nodeResults.requiredBase.push(0);
        nodeResults.gpuPurchases.push(0);
        return; // Skip rest of market clearing
      }

      // Calculate capacity and supply (shipments)
      const capacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
      const nodeYield = calculateNodeYield(node, month);
      const maxUtilization = node.maxCapacityUtilization || 0.95;
      const shipments = capacity * maxUtilization * nodeYield;

      // Calculate demand based on node type
      // ALL nodes explicitly wired via componentDemands or dcMwToPowerDemands
      // No generic parent-based fallthrough for supply chain nodes
      let demand = 0;
      const powerDemands = dcMwToPowerDemands(componentDemands.powerMw);
      let inferenceRetirements = 0;
      let isInferenceNode = false;

      if (node.id === 'gpu_inference') {
        // Similar to datacenter but smaller scale
        inferenceRetirements = state.installedBase / state.lifetimeMonths;
        const inferenceRequiredBase = requiredGpuBase * 0.3;  // 30% of workload
        const gap = Math.max(0, inferenceRequiredBase - state.installedBase);
        demand = gap + inferenceRetirements;
        isInferenceNode = true;

      // --- Semiconductor components (derived from GPU production requirement) ---
      } else if (node.id === 'advanced_wafers') {
        demand = componentDemands.advancedWafers;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'hybrid_bonding') {
        demand = componentDemands.hybridBonding;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'abf_substrate') {
        demand = componentDemands.abfSubstrate;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'osat_capacity') {
        demand = componentDemands.osatUnits;
        nodeResults.installedBase.push(0);

      // --- Memory & storage ---
      } else if (node.id === 'dram_server') {
        demand = componentDemands.serverDramGb;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'ssd_datacenter') {
        demand = componentDemands.ssdTb;
        nodeResults.installedBase.push(0);

      // --- Compute ---
      } else if (node.id === 'cpu_server') {
        demand = componentDemands.cpus;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'dpu_nic') {
        demand = componentDemands.dpuNics;
        nodeResults.installedBase.push(0);

      // --- Networking ---
      } else if (node.id === 'switch_asics') {
        demand = componentDemands.switchAsics;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'optical_transceivers') {
        demand = componentDemands.transceivers;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'infiniband_cables') {
        demand = componentDemands.infinibandCables;
        nodeResults.installedBase.push(0);

      // --- Server manufacturing ---
      } else if (node.id === 'server_assembly') {
        demand = componentDemands.servers;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'rack_pdu') {
        const { serversPerRack } = getServerInfraIntensities();
        demand = componentDemands.servers / Math.max(1, serversPerRack);
        nodeResults.installedBase.push(0);
      } else if (node.id === 'liquid_cooling') {
        demand = componentDemands.cdus;
        nodeResults.installedBase.push(0);

      // --- Power chain (derived from datacenter MW demand) ---
      } else if (node.id === 'transformers_lpt') {
        demand = powerDemands.transformers;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'grid_interconnect') {
        demand = powerDemands.gridApprovals;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'power_generation') {
        demand = powerDemands.ppas;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'backup_power') {
        demand = powerDemands.backupMw;
        nodeResults.installedBase.push(0);

      // --- Data center & facilities ---
      } else if (node.id === 'dc_construction') {
        demand = powerDemands.dcConstruction;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'dc_ops_staff') {
        demand = powerDemands.dcOpsStaff;
        nodeResults.installedBase.push(0);

      // --- Foundry equipment ---
      } else if (node.id === 'euv_tools') {
        // EUV demand: very low intensity per wafer (tools process thousands of wafers)
        demand = componentDemands.advancedWafers * (node.inputIntensity || 0.00001);
        nodeResults.installedBase.push(0);

      // --- Human capital ---
      } else if (node.id === 'ml_engineers') {
        // ML engineer demand scales with GPU installed base
        // ~5 ML engineers per 1000 GPUs in the field
        demand = requiredGpuBase * 0.005;
        nodeResults.installedBase.push(0);

      } else {
        // Safety fallback for any future nodes not yet explicitly wired
        const parentDemands = (node.parentNodeIds || []).map(pid => {
          const parentResult = results.nodes[pid];
          if (parentResult && parentResult.demand.length > 0) {
            return parentResult.demand[parentResult.demand.length - 1] || 0;
          }
          return 0;
        });
        demand = parentDemands.reduce((sum, d) => sum + d, 0) * (node.inputIntensity || 1);
        nodeResults.installedBase.push(0);
      }

      const backlogIn = state.backlog;
      const inventoryIn = isNonInventoriable(node) ? 0 : state.inventory;
      const availableSupply = shipments + inventoryIn;
      const provisionalFulfilled = Math.min(availableSupply, demand + backlogIn);
      const provisionalTightness = (demand + backlogIn) / Math.max(provisionalFulfilled, EPSILON);

      // Update price history and calculate SMA for substitution
      state.priceHistory.push(calculatePriceIndex(provisionalTightness));
      const priceSignalSma = sma(state.priceHistory, GLOBAL_PARAMS.substitution.priceSignalSmaMonths);

      // Calculate substitution if applicable
      if (node.substitutabilityScore > 0 && provisionalTightness > 1) {
        const subK = 0.2;  // Substitution sensitivity
        state.subShare = calculateSubstitutionShare(
          state.subShare,
          priceSignalSma,
          node.substitutabilityScore,
          subK,
          GLOBAL_PARAMS.substitution.adjustmentSpeed
        );
        // Reduce effective demand by substitution
        demand *= (1 - state.subShare);
      }

      const fulfilled = Math.min(availableSupply, demand + backlogIn);
      const inventoryOut = Math.max(0, availableSupply - fulfilled);
      const backlogOut = Math.max(0, demand + backlogIn - fulfilled);
      const tightness = (demand + backlogIn) / Math.max(fulfilled, EPSILON);

      // Update inventory and backlog
      state.inventory = isNonInventoriable(node) ? 0 : inventoryOut;
      state.backlog = backlogOut;

      if (isInferenceNode) {
        state.installedBase = Math.max(0, state.installedBase + fulfilled - inferenceRetirements);
        nodeResults.installedBase.push(state.installedBase);
      }

      // Store results
      // FIX: supply = actualShipments (cleared), supplyPotential = max producible
      nodeResults.demand.push(demand);
      nodeResults.supply.push(fulfilled);                 // What actually shipped (cleared)
      nodeResults.supplyPotential.push(shipments);        // Max producible capacity
      nodeResults.gpuDelivered.push(0);                   // N/A for non-GPU nodes
      nodeResults.idleGpus.push(0);                       // N/A for non-GPU nodes
      nodeResults.capacity.push(capacity);
      nodeResults.yield.push(nodeYield);
      nodeResults.tightness.push(tightness);
      nodeResults.priceIndex.push(state.priceHistory[state.priceHistory.length - 1]);
      nodeResults.inventory.push(state.inventory);
      nodeResults.backlog.push(state.backlog);
      nodeResults.requiredBase.push(0);
      nodeResults.gpuPurchases.push(0);

      // Track tightness history for persistence-based detection
      state.tightnessHistory.push(tightness);

      const isShortage = backlogOut > 0 || tightness > 1.05;
      const isGlut = inventoryOut > 0 && tightness < 0.95;
      nodeResults.shortage.push(isShortage ? 1 : 0);
      nodeResults.glut.push(isGlut ? 1 : 0);
    });

    // ============================================
    // PHASE 4.5: Endogenous capacity response to sustained shortages
    // ============================================
    const capex = GLOBAL_PARAMS.capexTrigger;
    if (capex) {
      NODES.forEach(node => {
        if (!node.startingCapacity || node.group === 'A') return;

        const state = nodeState[node.id];

        if (state.capexExpansionCount >= capex.maxExpansions) return;
        if (month - state.lastCapexTriggerMonth < capex.cooldownMonths) return;

        const recentPrices = state.priceHistory.slice(-capex.persistenceMonths);
        const sustainedTightPricing = recentPrices.length >= capex.persistenceMonths &&
          recentPrices.every(price => price >= capex.priceThreshold);
        if (!sustainedTightPricing) return;

        const currentCapacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
        const expansionAmount = currentCapacity * capex.maxCapacityAddPct;
        if (expansionAmount <= 0) return;

        const leadTime = node.leadTimeDebottleneck || 6;
        const onlineMonth = month + leadTime;

        state.dynamicExpansions.push({
          month: onlineMonth,
          capacityAdd: expansionAmount
        });
        state.lastCapexTriggerMonth = month;
        state.capexExpansionCount++;
      });
    }

    // ============================================
    // PHASE 5: Predictive supply elasticity
    // Trigger dynamic expansions when 6-month forecast shows shortages
    // ============================================
    const ps = GLOBAL_PARAMS.predictiveSupply;
    if (ps) {
      const forecastMonth = Math.min(month + ps.forecastHorizonMonths, months - 1);

      const forecastInference = calculateInferenceDemand(forecastMonth, demandAssumptions);
      const forecastTraining = calculateTrainingDemand(forecastMonth, demandAssumptions, efficiencyAssumptions);
      const forecastContinual = calculateContinualLearningDemand(forecastMonth, demandAssumptions);
      const forecastInferenceAccelHours = calculateInferenceAccelHours(
        forecastInference.total,
        forecastMonth,
        efficiencyAssumptions,
        demandAssumptions
      );
      const forecastTotalAccelHours = (forecastInferenceAccelHours +
        forecastTraining.frontierAccelHours +
        forecastTraining.midtierAccelHours +
        forecastContinual.accelHours) * CALIBRATION.globalAccelHoursMultiplier;
      const forecastRequiredGpuBase = accelHoursToRequiredGpuBase(forecastTotalAccelHours);

      const forecastGpuState = nodeState['gpu_datacenter'];
      const forecastGpuRetirements = forecastGpuState.installedBase / forecastGpuState.lifetimeMonths;
      const forecastGpuGap = Math.max(0, forecastRequiredGpuBase - forecastGpuState.installedBase);
      const forecastGpuDemand = forecastGpuGap + forecastGpuRetirements;
      const forecastGpuProductionRequirement = forecastGpuDemand + forecastGpuState.backlog;
      const forecastDeploymentCap = calculateDeploymentVelocityCap(
        forecastMonth,
        scenarioOverrides,
        nodeState
      );
      const cappedForecastGpuProductionRequirement = Math.min(
        forecastGpuProductionRequirement,
        forecastDeploymentCap
      );

      const forecastEffectiveHbmPerGpu = calculateEffectiveHbmPerGpu(forecastMonth, demandAssumptions);
      const forecastComponentDemands = gpuToComponentDemands(
        cappedForecastGpuProductionRequirement,
        forecastMonth,
        forecastEffectiveHbmPerGpu
      );
      const forecastPowerDemands = dcMwToPowerDemands(forecastComponentDemands.powerMw);

      NODES.forEach(node => {
        if (!node.startingCapacity || node.group === 'A') return;

        const state = nodeState[node.id];

        // Check cooldown and expansion cap
        if (state.dynamicExpansionCount >= ps.maxDynamicExpansions) return;
        if (month - state.lastTriggerMonth < ps.cooldownMonths) return;

        const forecastCapacity = calculateCapacity(node, forecastMonth, scenarioOverrides, state.dynamicExpansions);
        const forecastYield = calculateNodeYield(node, forecastMonth);
        const maxUtilization = node.maxCapacityUtilization || 0.95;
        const forecastSupplyPotential = forecastCapacity * maxUtilization * forecastYield;

        let forecastDemand = 0;
        if (node.id === 'gpu_datacenter') {
          forecastDemand = cappedForecastGpuProductionRequirement;
        } else if (node.id === 'gpu_inference') {
          const inferenceState = nodeState['gpu_inference'];
          const retirements = inferenceState.installedBase / inferenceState.lifetimeMonths;
          const inferenceRequiredBase = forecastRequiredGpuBase * 0.3;
          const gap = Math.max(0, inferenceRequiredBase - inferenceState.installedBase);
          forecastDemand = gap + retirements;
        } else if (node.id === 'hbm_stacks') {
          forecastDemand = forecastComponentDemands.hbmStacks;
        } else if (node.id === 'cowos_capacity') {
          forecastDemand = forecastComponentDemands.cowosWaferEquiv;
        } else if (node.id === 'datacenter_mw') {
          forecastDemand = forecastComponentDemands.powerMw;
        } else if (node.id === 'advanced_wafers') {
          forecastDemand = forecastComponentDemands.advancedWafers;
        } else if (node.id === 'hybrid_bonding') {
          forecastDemand = forecastComponentDemands.hybridBonding;
        } else if (node.id === 'abf_substrate') {
          forecastDemand = forecastComponentDemands.abfSubstrate;
        } else if (node.id === 'osat_capacity') {
          forecastDemand = forecastComponentDemands.osatUnits;
        } else if (node.id === 'dram_server') {
          forecastDemand = forecastComponentDemands.serverDramGb;
        } else if (node.id === 'ssd_datacenter') {
          forecastDemand = forecastComponentDemands.ssdTb;
        } else if (node.id === 'cpu_server') {
          forecastDemand = forecastComponentDemands.cpus;
        } else if (node.id === 'dpu_nic') {
          forecastDemand = forecastComponentDemands.dpuNics;
        } else if (node.id === 'switch_asics') {
          forecastDemand = forecastComponentDemands.switchAsics;
        } else if (node.id === 'optical_transceivers') {
          forecastDemand = forecastComponentDemands.transceivers;
        } else if (node.id === 'infiniband_cables') {
          forecastDemand = forecastComponentDemands.infinibandCables;
        } else if (node.id === 'server_assembly') {
          forecastDemand = forecastComponentDemands.servers;
        } else if (node.id === 'rack_pdu') {
          forecastDemand = forecastComponentDemands.servers * 0.25;
        } else if (node.id === 'liquid_cooling') {
          forecastDemand = forecastComponentDemands.cdus;
        } else if (node.id === 'transformers_lpt') {
          forecastDemand = forecastPowerDemands.transformers;
        } else if (node.id === 'grid_interconnect') {
          forecastDemand = forecastPowerDemands.gridApprovals;
        } else if (node.id === 'power_generation') {
          forecastDemand = forecastPowerDemands.ppas;
        } else if (node.id === 'backup_power') {
          forecastDemand = forecastPowerDemands.backupMw;
        } else if (node.id === 'dc_construction') {
          forecastDemand = forecastPowerDemands.dcConstruction;
        } else if (node.id === 'dc_ops_staff') {
          forecastDemand = forecastPowerDemands.dcOpsStaff;
        } else if (node.id === 'euv_tools') {
          forecastDemand = forecastComponentDemands.advancedWafers * 0.00001;
        } else if (node.id === 'ml_engineers') {
          forecastDemand = forecastRequiredGpuBase * 0.005;
        } else {
          const nodeResults = results.nodes[node.id];
          forecastDemand = nodeResults?.demand?.[nodeResults.demand.length - 1] || 0;
        }

        const forecastDemandGap = forecastDemand - forecastSupplyPotential;
        const demandRatio = forecastDemand / (forecastSupplyPotential + EPSILON);

        if (forecastDemandGap > 0 && demandRatio >= ps.shortageThreshold) {
          const currentCapacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
          const utilizationFactor = Math.max(EPSILON, maxUtilization * forecastYield);
          const capacityGap = forecastDemandGap / utilizationFactor;
          const expansionAmount = Math.max(currentCapacity * ps.expansionFraction, capacityGap);
          const leadTime = node.leadTimeDebottleneck || 6;
          const onlineMonth = month + leadTime;

          state.dynamicExpansions.push({
            month: onlineMonth,
            capacityAdd: expansionAmount
          });
          state.lastTriggerMonth = month;
          state.dynamicExpansionCount++;
        }
      });
    }
  }

  // Analyze results for summary
  results.summary = analyzeResults(results);

  return results;
}

/**
 * Analyze simulation results to find shortages, gluts, and bottlenecks
 * FIXED:
 * - Close open-ended periods and exclude Group A
 * - Persistence-based detection (require N consecutive months)
 */
function analyzeResults(results) {
  const shortages = [];
  const gluts = [];
  const bottlenecks = [];

  const shortagePersistence = GLOBAL_PARAMS.glutThresholds.persistenceMonthsSoft;
  const glutPersistence = GLOBAL_PARAMS.glutThresholds.persistenceMonthsSoft;
  const hardGlutPersistence = GLOBAL_PARAMS.glutThresholds.persistenceMonthsHard;

  Object.entries(results.nodes).forEach(([nodeId, data]) => {
    const node = getNode(nodeId);
    if (!node) return;

    // EXCLUDE Group A from shortage/glut analysis (they're demand drivers, not supply nodes)
    if (node.group === 'A') return;

    // Find shortage periods with PERSISTENCE requirement
    let shortageStart = null;
    let peakTightness = 0;
    let shortageDuration = 0;
    let consecutiveShortageMonths = 0;

    data.tightness.forEach((t, month) => {
      if (t > 1.05) {
        consecutiveShortageMonths++;
        if (consecutiveShortageMonths >= shortagePersistence) {
          if (shortageStart === null) shortageStart = month - shortagePersistence + 1;
          if (t > peakTightness) peakTightness = t;
          shortageDuration++;
        }
      } else {
        if (shortageStart !== null && shortageDuration > 0) {
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
        consecutiveShortageMonths = 0;
      }
    });

    // FIX: Close open-ended shortage at horizon end
    if (shortageStart !== null && shortageDuration > 0) {
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

    // Find glut periods with PERSISTENCE requirement
    let glutStart = null;
    let minTightness = 1;
    let glutDuration = 0;
    let consecutiveGlutMonths = 0;
    let isHardGlut = false;

    data.tightness.forEach((t, month) => {
      if (t < GLOBAL_PARAMS.glutThresholds.soft) {
        consecutiveGlutMonths++;
        if (t < GLOBAL_PARAMS.glutThresholds.hard) isHardGlut = true;

        const requiredPersistence = isHardGlut ? hardGlutPersistence : glutPersistence;
        if (consecutiveGlutMonths >= requiredPersistence) {
          if (glutStart === null) glutStart = month - requiredPersistence + 1;
          if (t < minTightness) minTightness = t;
          glutDuration++;
        }
      } else {
        if (glutStart !== null && glutDuration > 0) {
          gluts.push({
            nodeId,
            nodeName: node.name,
            group: node.group,
            startMonth: glutStart,
            minTightness,
            duration: glutDuration,
            severity: (1 - minTightness) * glutDuration,
            isHardGlut
          });
        }
        glutStart = null;
        minTightness = 1;
        glutDuration = 0;
        consecutiveGlutMonths = 0;
        isHardGlut = false;
      }
    });

    // FIX: Close open-ended glut at horizon end
    if (glutStart !== null && glutDuration > 0) {
      gluts.push({
        nodeId,
        nodeName: node.name,
        group: node.group,
        startMonth: glutStart,
        minTightness,
        duration: glutDuration,
        severity: (1 - minTightness) * glutDuration,
        isHardGlut
      });
    }

    // Calculate bottleneck score (uses persistence-based shortage count from results)
    const avgTightness = data.tightness.reduce((a, b) => a + b, 0) / data.tightness.length;
    const maxTightness = Math.max(...data.tightness);
    const shortageMonths = data.shortage.filter(s => s === 1).length;

    if (shortageMonths > 0) {
      // Calculate downstream impact
      const childNodes = getChildNodes(nodeId);
      const downstreamImpact = childNodes.length * avgTightness;

      bottlenecks.push({
        nodeId,
        nodeName: node.name,
        group: node.group,
        avgTightness,
        maxTightness,
        shortageMonths,
        downstreamImpact,
        score: avgTightness * shortageMonths * (1 + downstreamImpact / 10)
      });
    }
  });

  // Sort by severity/score
  shortages.sort((a, b) => b.severity - a.severity);
  gluts.sort((a, b) => b.severity - a.severity);
  bottlenecks.sort((a, b) => b.score - a.score);

  return {
    shortages: shortages.slice(0, 20),
    gluts: gluts.slice(0, 20),
    bottlenecks: bottlenecks.slice(0, 10)
  };
}

/**
 * Format month index to display string
 */
export function formatMonth(monthIndex) {
  const year = GLOBAL_PARAMS.startYear + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[month - 1]} ${year}`;
}

/**
 * Format large numbers for display
 */
export function formatNumber(num, decimals = 1) {
  if (num === null || num === undefined) return '-';
  if (Math.abs(num) >= 1e12) return (num / 1e12).toFixed(decimals) + 'T';
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(decimals) + 'B';
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(decimals) + 'M';
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
}
