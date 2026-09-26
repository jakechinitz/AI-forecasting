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

import { NODES } from '../data/nodes.js';
import { createFinancingModel } from './financing.js';
import {
  GLOBAL_PARAMS,
  FLEET_ANCHOR,
  FINANCING_ASSUMPTIONS,
  DEMAND_ASSUMPTIONS,
  EFFICIENCY_ASSUMPTIONS,
  SUPPLY_ASSUMPTIONS,
  TRANSLATION_INTENSITIES,
  getBlockKeyForMonth,
  calculateStackedYield,
  calculateSimpleYield
} from '../data/assumptions.js';

// ============================================
// 1) PHYSICS & ONTOLOGY
// ============================================

const PHYSICS_DEFAULTS = {
  // Inference: effective tokens/sec per GPU (unified across all segments).
  // All inference compute costs the same per token. Any difference in agentic vs consumer
  // compute intensity is captured in the demand growth rate assumptions, not throughput.
  // Reflects REAL-WORLD serving throughput (memory/bandwidth/KV-cache/latency-constrained),
  // NOT theoretical peak FLOPs. Already accounts for utilization, batching overhead, and latency SLAs.
  //   Frontier-ish models, latency-constrained: ~10-50 tok/s/GPU
  //   Smaller models / high-batch throughput:    ~50-300 tok/s/GPU
  effectiveTokensPerSecPerGpu: {
    consumer: 30,     // unified throughput across all segments
    enterprise: 30,   // unified throughput across all segments
    agentic: 30       // unified throughput (extra compute rolled into growth assumptions)
  },
  // Training: accelerator-hours model (training IS compute-limited, FLOPs matter)
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
  'osat_test',
  'server_assembly',
  'hybrid_bonding',
  'liquid_cooling',
  'dc_construction',
  'euv_tools',
  'off_grid_power'
]);

const QUEUE_NODES = new Set([
  'grid_interconnect',
  'dc_ops_staff'
]);

/**
 * Maps supply chain nodes to supply assumption categories.
 * Nodes in this map get organic capacity growth from SUPPLY_ASSUMPTIONS.
 * Nodes NOT in this map rely on committed + dynamic expansions only.
 */
const SUPPLY_CATEGORY_MAP = {
  gpu_datacenter: 'foundry',
  gpu_inference: 'foundry',
  cowos_capacity: 'packaging',
  hybrid_bonding: 'packaging',
  abf_substrate: 'packaging',
  osat_test: 'packaging',
  advanced_wafers: 'foundry',
  euv_tools: 'foundry',
  hbm_stacks: 'memory',
  dram_server: 'memory',
  ssd_datacenter: 'memory',
  datacenter_mw: 'datacenter',
  server_assembly: 'datacenter',
  rack_pdu: 'datacenter',
  liquid_cooling: 'datacenter',
  grid_interconnect: 'power',
  off_grid_power: 'power',
  transformers_lpt: 'power',
  power_generation: 'power',
  backup_power: 'power',
  dc_construction: 'power',
  dc_ops_staff: 'power',
  cpu_server: 'foundry',
  dpu_nic: 'foundry',
  switch_asics: 'foundry',
  optical_transceivers: 'datacenter',
  infiniband_cables: 'datacenter'
};

/**
 * Substitution pools: nodes mapped to the same pool have their potentials
 * summed in the gating step. This models interchangeable supply sources.
 *
 * power_hookup: grid_interconnect (utility hookup approvals) and off_grid_power
 * (behind-the-meter generation) are alternative ways to energize a datacenter —
 * a GPU needs MW from EITHER path. datacenter_mw (the built facility itself) is
 * NOT a substitute for power: a deployment needs a building AND a hookup, so it
 * gates separately.
 */
const SUBSTITUTION_POOLS = {
  grid_interconnect: 'power_hookup',
  off_grid_power: 'power_hookup'
};

/**
 * Infrastructure nodes provision long-lived capacity tied to the installed
 * fleet, not per-GPU consumables. A replacement GPU reuses the retiring GPU's
 * building, hookup, transformers, and staffing, so demand on these nodes is
 * driven by NET fleet growth (deployments minus retirements), and in gating
 * the capacity freed by retirements supports that many replacement deployments.
 */
const INFRASTRUCTURE_NODES = new Set([
  'datacenter_mw',
  'grid_interconnect',
  'off_grid_power',
  'power_generation',
  'transformers_lpt',
  'backup_power',
  'dc_construction',
  'dc_ops_staff'
]);

const EXPECTED_UNITS = {
  'hbm_stacks': 'stacks/month',
  'datacenter_mw': 'MW',
  'advanced_wafers': 'wafers/month',
  'cowos_capacity': 'wafer-equiv/month',
  'server_assembly': 'servers/month',
  'grid_interconnect': 'MW-approved/month',
  'hybrid_bonding': 'wafer-equiv/month'
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

// Efficiency ceiling (soft knee): gains below the knee are linear; above, logarithmic
// diminishing returns. The knee is set by the ratio of current GPU power to a practical
// floor (~3W = 10× more efficient than the human brain at 30W). Beyond the knee,
// improvements continue but at a dramatically slower pace — reflecting engineering
// diminishing returns rather than a hard thermodynamic wall.
export const CURRENT_GPU_WATTS = 700;
export const THERMODYNAMIC_FLOOR_WATTS = 0.5;
export const MAX_EFFICIENCY_GAIN = CURRENT_GPU_WATTS / THERMODYNAMIC_FLOOR_WATTS;  // ~233×

/**
 * Soft asymptotic efficiency cap with diminishing returns above the knee.
 * Below the knee: gain = raw (linear, unchanged).
 * Above the knee: gain = knee × (1 + ln(raw / knee)) — logarithmic.
 * Continuous at the knee. Always increasing, but dramatically slower above it.
 */
export function softEfficiencyCap(raw, knee) {
  if (raw <= knee) return raw;
  return knee * (1 + Math.log(raw / knee));
}

// Planning knobs
const DEFAULT_CALIBRATION_RATIO = 1.15;
const CATCHUP_MONTHS = 6;
const DEFAULT_BUFFER_MONTHS = 2;

// Inventory management: manufacturers limit carrying inventory to avoid
// capital lockup and carrying costs. CEILING_MONTHS caps inventory at N
// months of consumption; CONSUMPTION_HEADROOM lets producers build ahead
// of current consumption for growth readiness (1.5 = up to 50% headroom).
const INVENTORY_CEILING_MONTHS = 4;
const CONSUMPTION_HEADROOM = 1.5;

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

/**
 * Precompute demand trajectories with proper block-chained compounding.
 * Each month compounds from the PREVIOUS month's value using that block's
 * growth rate, ensuring smooth transitions at block boundaries.
 *
 * Old approach: base * (1+g)^(month/12) caused discontinuities when g changed
 * between blocks (e.g., demand could jump or drop 50%+ overnight).
 */
/**
 * Resolve a growth rate value that may be either a plain number (from scenario overrides)
 * or an object with { value: number } (from assumption blocks).
 */
function resolveGrowthRate(raw, fallback) {
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && raw.value !== undefined) return raw.value;
  return fallback ?? 0;
}

function precomputeDemandTrajectories(totalMonths, demandAssumptions) {
  const inferenceSegs = ['consumer', 'enterprise', 'agentic'];
  const trainingSegs = ['frontier', 'midtier'];
  const block0 = getDemandBlockForMonth(0, demandAssumptions);

  const inference = {};
  for (const seg of inferenceSegs) {
    const base = resolveAssumptionValue(block0?.workloadBase?.inferenceTokensPerMonth?.[seg], 0);
    const arr = new Array(totalMonths);
    arr[0] = Math.max(base, 0);
    for (let m = 1; m < totalMonths; m++) {
      const block = getDemandBlockForMonth(m, demandAssumptions);
      const annualGrowth = resolveGrowthRate(block?.inferenceGrowth?.[seg], 0);
      // intensityGrowth: reasoning chains, tool use, and agent loops increase
      // compute per request over time (more tokens per inference call)
      const intensityAnnual = resolveGrowthRate(block?.intensityGrowth, 0);
      const monthlyFactor = Math.pow(1 + annualGrowth, 1 / 12)
        * Math.pow(1 + intensityAnnual, 1 / 12);
      arr[m] = arr[m - 1] * monthlyFactor;
    }
    inference[seg] = arr;
  }

  const training = {};
  for (const seg of trainingSegs) {
    const base = resolveAssumptionValue(block0?.workloadBase?.trainingRunsPerMonth?.[seg], 0);
    const arr = new Array(totalMonths);
    arr[0] = Math.max(base, 0);
    for (let m = 1; m < totalMonths; m++) {
      const block = getDemandBlockForMonth(m, demandAssumptions);
      const annualGrowth = resolveGrowthRate(block?.trainingGrowth?.[seg], 0);
      const monthlyFactor = Math.pow(1 + annualGrowth, 1 / 12);
      arr[m] = arr[m - 1] * monthlyFactor;
    }
    training[seg] = arr;
  }

  return { inference, training };
}

/**
 * Precompute supply growth multipliers per supply category.
 * These represent organic capacity expansion from SUPPLY_ASSUMPTIONS,
 * chained across time blocks for smooth transitions.
 */
function precomputeSupplyMultipliers(totalMonths, supplyAssumptions) {
  const categories = ['packaging', 'foundry', 'memory', 'datacenter', 'power'];
  const multipliers = {};

  for (const cat of categories) {
    const arr = new Array(totalMonths);
    arr[0] = 1.0;
    for (let m = 1; m < totalMonths; m++) {
      const blockKey = getBlockKeyForMonth(m);
      const block = supplyAssumptions?.[blockKey];
      const annualRate = resolveGrowthRate(block?.expansionRates?.[cat], 0);
      const monthlyFactor = Math.pow(1 + annualRate, 1 / 12);
      arr[m] = arr[m - 1] * monthlyFactor;
    }
    multipliers[cat] = arr;
  }

  return multipliers;
}

function calculateInferenceDemand(month, trajectories) {
  if (!trajectories) return { consumer: 1e12, enterprise: 0, agentic: 0, total: 1e12 };
  const out = {
    consumer: trajectories.inference.consumer[month] || 0,
    enterprise: trajectories.inference.enterprise[month] || 0,
    agentic: trajectories.inference.agentic[month] || 0,
    total: 0
  };
  out.total = out.consumer + out.enterprise + out.agentic;

  // Hard fallback so charts never go to 0 unless explicitly configured that way
  if (!Number.isFinite(out.total) || out.total <= 0) {
    const fallback = 1e12;
    out.consumer = fallback;
    out.enterprise = 0;
    out.agentic = 0;
    out.total = fallback;
  }

  return out;
}

function calculateTrainingDemand(month, trajectories) {
  if (!trajectories) return { frontier: 0, midtier: 0 };
  return {
    frontier: trajectories.training.frontier[month] || 0,
    midtier: trajectories.training.midtier[month] || 0
  };
}

export function calculateCapacity(node, month, scenarioOverrides = {}, dynamicExpansions = [], supplyMultiplier = 1) {
  // Base capacity grows organically with supply expansion rates
  let capacity = (node?.startingCapacity || 0) * supplyMultiplier;

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

  // Supply shock with gradual recovery (not a cliff)
  if (scenarioOverrides?.supply?.affectedNodes?.includes(node.id)) {
    const shockMonth = scenarioOverrides.supply.shockMonth || 24;
    const reduction = scenarioOverrides.supply.capacityReduction || 0.5;
    const recoveryMonths = scenarioOverrides.supply.recoveryMonths || 36;
    if (month >= shockMonth) {
      const monthsSinceShock = month - shockMonth;
      if (monthsSinceShock < recoveryMonths) {
        const recoveryProgress = monthsSinceShock / recoveryMonths;
        const currentReduction = reduction * (1 - recoveryProgress);
        capacity *= (1 - currentReduction);
      }
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
    cache[0] = { M_inference: 1, M_training: 1, S_inference: 1, S_training: 1, H: 1, H_memory: 1, KW: 1 };
    return cache[0];
  }

  const prev = getEfficiencyMultipliers(month - 1, assumptions, cache, warnings, warnedSet);
  const blockKey = getBlockKeyForMonth(month);
  const block = assumptions?.[blockKey] || EFFICIENCY_ASSUMPTIONS?.[blockKey] || EFFICIENCY_ASSUMPTIONS?.base || {};

  // Handle both { value: number } objects and plain numbers (from scenario overrides)
  const mInfAnnual = resolveGrowthRate(block?.modelEfficiency?.m_inference, 0.18);
  const mTrnAnnual = resolveGrowthRate(block?.modelEfficiency?.m_training, 0.10);

  const sInfAnnual = resolveGrowthRate(block?.systemsEfficiency?.s_inference, 0.10);
  const sTrnAnnual = resolveGrowthRate(block?.systemsEfficiency?.s_training, 0.08);

  const hAnnual = resolveGrowthRate(block?.hardwareEfficiency?.h, 0.15);
  const hMemAnnual = resolveGrowthRate(block?.hardwareEfficiency?.h_memory, 0.10);
  const kwAnnual = resolveGrowthRate(block?.hardwareEfficiency?.kw_growth, 0);

  const decayInf = Math.pow(1 - mInfAnnual, 1 / 12);
  const decayTrn = Math.pow(1 - mTrnAnnual, 1 / 12);

  const growSInf = Math.pow(1 + sInfAnnual, 1 / 12);
  const growSTrn = Math.pow(1 + sTrnAnnual, 1 / 12);
  const growH = Math.pow(1 + hAnnual, 1 / 12);
  const growHMem = Math.pow(1 + hMemAnnual, 1 / 12);
  const growKW = Math.pow(1 + kwAnnual, 1 / 12);

  const cur = {
    M_inference: prev.M_inference * decayInf,
    M_training: prev.M_training * decayTrn,
    S_inference: prev.S_inference * growSInf,
    S_training: prev.S_training * growSTrn,
    H: prev.H * growH,
    H_memory: prev.H_memory * growHMem,
    // IT power per NEW accelerator relative to the opening fleet's kW/accelerator
    KW: prev.KW * growKW
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
function computeRequiredGpus(month, trajectories, demandAssumptions, efficiencyAssumptions, effCache, warnings, warnedSet, demandScale = 1) {
  const block = getDemandBlockForMonth(month, demandAssumptions);

  const inferenceDemand = calculateInferenceDemand(month, trajectories);
  const trainingDemand = calculateTrainingDemand(month, trajectories);

  const computeCfg = TRANSLATION_INTENSITIES?.compute || {};
  const secondsPerMonth = PHYSICS_DEFAULTS.secondsPerMonth;

  const eff = getEfficiencyMultipliers(month, efficiencyAssumptions, effCache, warnings, warnedSet);

  // ==========================================================
  // INFERENCE: tokens/sec/GPU model
  //
  // Real-world inference is memory/bandwidth/KV-cache/latency-SLA constrained,
  // NOT theoretical-FLOP-limited. Using "effective tokens/sec per GPU" directly
  // reflects the bottleneck:
  //   tokens_per_gpu_month = tok/s/GPU × 2.6e6 s/month
  //   required_gpus = total_tokens / tokens_per_gpu_month
  //
  // Efficiency adjustments:
  //   M_inference decays (less compute/token → more tok/s per GPU)
  //   S_inference, H grow (system/hardware throughput gains)
  //   efficiencyGain = (1/M) × S × H  (all > 1 over time)
  // ==========================================================
  const tokPerSecCfg = computeCfg.effectiveTokensPerSecPerGpu || {};
  const consumerTokPerSec = resolveAssumptionValue(
    tokPerSecCfg.consumer?.value ?? tokPerSecCfg.consumer,
    PHYSICS_DEFAULTS.effectiveTokensPerSecPerGpu.consumer
  );
  const enterpriseTokPerSec = resolveAssumptionValue(
    tokPerSecCfg.enterprise?.value ?? tokPerSecCfg.enterprise,
    PHYSICS_DEFAULTS.effectiveTokensPerSecPerGpu.enterprise
  );
  const agenticTokPerSec = resolveAssumptionValue(
    tokPerSecCfg.agentic?.value ?? tokPerSecCfg.agentic,
    PHYSICS_DEFAULTS.effectiveTokensPerSecPerGpu.agentic
  );

  // Efficiency gain: M decays (models get cheaper → more tok/s), S and H grow throughput.
  // H_memory: inference is memory-bandwidth-bound (not compute-bound), so HBM generational
  // improvements (H_memory) directly increase inference tok/s alongside general H gains.
  // Soft efficiency ceiling: below ~233× (700W / 3W), gains are linear. Above the knee,
  // diminishing returns kick in — improvements continue but at logarithmic pace,
  // reflecting practical engineering limits rather than a hard thermodynamic wall.
  //
  // VINTAGE TRACKING: results are in "effective units" = month-0 frontier
  // accelerators. Software gains (1/M × S) apply to the whole fleet, so they
  // reduce required effective units. Hardware gains (H × H_memory) apply only
  // to accelerators installed after month 0; the engine credits each new GPU
  // with its install-month hardware index, so old vintages keep old throughput.
  // The soft efficiency cap is applied to the total and charged to software.
  const hwIndex = eff.H * eff.H_memory;
  const rawEfficiencyGain = (1 / Math.max(eff.M_inference, EPSILON)) * eff.S_inference * hwIndex;
  const efficiencyGain = softEfficiencyCap(rawEfficiencyGain, MAX_EFFICIENCY_GAIN) / Math.max(hwIndex, EPSILON);

  // Per-segment GPU demand (with demandScale applied to token volumes)
  const consumerTokensTotal = (inferenceDemand.consumer || 0) * demandScale;
  const enterpriseTokensTotal = (inferenceDemand.enterprise || 0) * demandScale;
  const agenticTokensTotal = (inferenceDemand.agentic || 0) * demandScale;

  // Edge offload: fraction of inference tokens served on-device (phones, laptops, NPUs).
  // These tokens never hit the datacenter supply chain — no GPUs, no transformers, no cooling.
  // The share is user-configurable per segment and ramps over time (S-curve adoption).
  const edgeOffload = block?.edgeOffload || {};
  const edgeConsumerRaw = clamp(resolveGrowthRate(edgeOffload.consumer, 0), 0, 1);
  const edgeEnterpriseRaw = clamp(resolveGrowthRate(edgeOffload.enterprise, 0), 0, 1);
  const edgeAgenticRaw = clamp(resolveGrowthRate(edgeOffload.agentic, 0), 0, 1);

  // Cap the total edge share of inference tokens (scale segment shares down together)
  const edgeCap = clamp(resolveAssumptionValue(TRANSLATION_INTENSITIES?.edge?.maxShareOfInference?.value, 1), 0, 1);
  const allTokens = consumerTokensTotal + enterpriseTokensTotal + agenticTokensTotal;
  const uncappedEdge = consumerTokensTotal * edgeConsumerRaw + enterpriseTokensTotal * edgeEnterpriseRaw + agenticTokensTotal * edgeAgenticRaw;
  const edgeScale = allTokens > EPSILON && uncappedEdge / allTokens > edgeCap ? (edgeCap * allTokens) / uncappedEdge : 1;
  const edgeConsumer = edgeConsumerRaw * edgeScale;
  const edgeEnterprise = edgeEnterpriseRaw * edgeScale;
  const edgeAgentic = edgeAgenticRaw * edgeScale;

  // Datacenter tokens = total tokens × (1 - edge share)
  const consumerTokens = consumerTokensTotal * (1 - edgeConsumer);
  const enterpriseTokens = enterpriseTokensTotal * (1 - edgeEnterprise);
  const agenticTokens = agenticTokensTotal * (1 - edgeAgentic);

  // Track offloaded tokens for reporting
  const edgeTokensTotal = (consumerTokensTotal * edgeConsumer)
    + (enterpriseTokensTotal * edgeEnterprise)
    + (agenticTokensTotal * edgeAgentic);

  const consumerGpus = consumerTokens / Math.max(consumerTokPerSec * secondsPerMonth * efficiencyGain, EPSILON);
  const enterpriseGpus = enterpriseTokens / Math.max(enterpriseTokPerSec * secondsPerMonth * efficiencyGain, EPSILON);
  const agenticGpus = agenticTokens / Math.max(agenticTokPerSec * secondsPerMonth * efficiencyGain, EPSILON);

  const requiredInference = consumerGpus + enterpriseGpus + agenticGpus;

  // On-device work in the same datacenter-equivalent effective units. It does
  // not need datacenter capacity, but it draws on shared silicon supply
  // (wafers, EUV, DRAM) and uses energy.
  const requiredEdge =
    (consumerTokensTotal * edgeConsumer) / Math.max(consumerTokPerSec * secondsPerMonth * efficiencyGain, EPSILON)
    + (enterpriseTokensTotal * edgeEnterprise) / Math.max(enterpriseTokPerSec * secondsPerMonth * efficiencyGain, EPSILON)
    + (agenticTokensTotal * edgeAgentic) / Math.max(agenticTokPerSec * secondsPerMonth * efficiencyGain, EPSILON);

  // ==========================================================
  // TRAINING: accelerator-hours model (training IS compute-limited)
  // ==========================================================
  const hoursFrontier = resolveAssumptionValue(block?.workloadBase?.trainingComputePerRun?.frontier, 50e6);
  const hoursMidtier = resolveAssumptionValue(block?.workloadBase?.trainingComputePerRun?.midtier, 200000);

  const frontierRuns = (trainingDemand.frontier || 0) * demandScale;
  const midtierRuns = (trainingDemand.midtier || 0) * demandScale;

  const utilTrn = computeCfg.gpuUtilization?.training ?? PHYSICS_DEFAULTS.utilizationTraining;
  const hoursPerMonth = PHYSICS_DEFAULTS.hoursPerMonth;

  const totalTrainingHours = (frontierRuns * hoursFrontier) + (midtierRuns * hoursMidtier);
  // Soft cap training efficiency: compute raw gain = (S*H) / M, apply soft knee.
  // Hardware is credited through the vintage-tracked fleet (same index as
  // inference), so only the software part reduces required effective units.
  const rawTrainingGain = eff.S_training * hwIndex / Math.max(eff.M_training, EPSILON);
  const cappedTrainingGain = softEfficiencyCap(rawTrainingGain, MAX_EFFICIENCY_GAIN) / Math.max(hwIndex, EPSILON);
  const requiredTraining = totalTrainingHours / (hoursPerMonth * utilTrn * cappedTrainingGain);

  return {
    // All in effective units (month-0 frontier accelerators)
    requiredTotal: requiredInference + requiredTraining,
    requiredInference,
    requiredTraining,
    requiredEdge,
    hwIndex,
    kwIndex: eff.KW,
    inferenceDemand,
    trainingDemand,
    edgeOffloadShare: {
      consumer: edgeConsumer,
      enterprise: edgeEnterprise,
      agentic: edgeAgentic
    },
    edgeTokensTotal
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
  map['dram_server'] = resolveAssumptionValue(gpuToComp.serverDramGbPerGpu?.value, 128);
  map['ssd_datacenter'] = resolveAssumptionValue(gpuToComp.ssdTbPerGpu?.value, 2);

  // Hybrid bonding: initial static value (overridden monthly with adoption curve in sim loop)
  const hbIntensity = resolveAssumptionValue(gpuToComp.hybridBondingPerGpu?.value, 0.35);
  const hbAdoptInit = resolveAssumptionValue(gpuToComp.hybridBondingAdoption?.initial, 0.02);
  map['hybrid_bonding'] = hbIntensity * hbAdoptInit;

  const gpusPerServer = resolveAssumptionValue(serverToInfra.gpusPerServer?.value, 8);
  map['server_assembly'] = 1 / Math.max(gpusPerServer, 1);

  map['grid_interconnect'] = mwPerGpu;
  map['off_grid_power'] = mwPerGpu;

  // Infrastructure nodes: propagate demand through datacenter MW chain
  const powerChain = TRANSLATION_INTENSITIES?.powerChain || {};
  const transformersPerMw = resolveAssumptionValue(powerChain.transformersPerMw?.value, 0.02);
  const redundancyFactor = resolveAssumptionValue(powerChain.redundancyFactor?.value, 1.5);

  map['transformers_lpt'] = mwPerGpu * transformersPerMw;
  map['power_generation'] = mwPerGpu;
  map['backup_power'] = mwPerGpu * redundancyFactor;
  const workerMonthsPerMw = resolveAssumptionValue(serverToInfra.workerMonthsPerMw?.value, 400);
  const ftesPerMw = resolveAssumptionValue(serverToInfra.ftesPerMw?.value, 8);
  map['dc_construction'] = mwPerGpu * workerMonthsPerMw;
  map['dc_ops_staff'] = mwPerGpu * ftesPerMw;

  // Downstream deployable nodes with GPU parents: explicitly set per-GPU intensities.
  // These were previously auto-mapped by a "fill gaps" loop, but that loop also pulled in
  // upstream capital equipment (euv_tools) whose inputIntensity is per-wafer, not per-GPU,
  // creating a false ~180K GPU/month hard ceiling.
  map['liquid_cooling'] = resolveAssumptionValue(NODE_MAP.get('liquid_cooling')?.inputIntensity, 0.05);
  map['osat_test'] = resolveAssumptionValue(NODE_MAP.get('osat_test')?.inputIntensity, 1);
  map['rack_pdu'] = resolveAssumptionValue(NODE_MAP.get('rack_pdu')?.inputIntensity, 0.025);
  map['cpu_server'] = resolveAssumptionValue(NODE_MAP.get('cpu_server')?.inputIntensity, 0.5);
  map['dpu_nic'] = resolveAssumptionValue(NODE_MAP.get('dpu_nic')?.inputIntensity, 1);
  map['switch_asics'] = resolveAssumptionValue(NODE_MAP.get('switch_asics')?.inputIntensity, 0.125);
  map['optical_transceivers'] = resolveAssumptionValue(NODE_MAP.get('optical_transceivers')?.inputIntensity, 1);
  map['infiniband_cables'] = resolveAssumptionValue(NODE_MAP.get('infiniband_cables')?.inputIntensity, 4);

  // EUV tools: compound intensity through the wafer chain.
  // inputIntensity (0.00002) is tools-per-wafer, so per-GPU = wafers/GPU × tools/wafer.
  // At compound 0.000006, 4 tools support ~600K GPUs (not the false 180K ceiling from before).
  const advWafersPerGpu = map['advanced_wafers'] || 0.3;
  map['euv_tools'] = advWafersPerGpu * resolveAssumptionValue(
    NODE_MAP.get('euv_tools')?.inputIntensity, 0.00002
  );

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
    warnings: [],
    edgeOffload: {
      tokensOffloaded: [],      // total tokens/month served on-device
      shareConsumer: [],         // edge share for consumer segment
      shareEnterprise: [],       // edge share for enterprise segment
      shareAgentic: []           // edge share for agentic segment
    }
  };

  const nodeIntensityMap = buildIntensityMap();
  runPreflightDiagnostics(nodeIntensityMap, results.warnings);

  const warnedSet = new Set();
  const effCache = [];

  const demandAssumptions = deepMerge(assumptions?.demand || DEMAND_ASSUMPTIONS, scenarioOverrides?.demand);
  const efficiencyAssumptions = deepMerge(assumptions?.efficiency || EFFICIENCY_ASSUMPTIONS, scenarioOverrides?.efficiency);
  const supplyAssumptions = deepMerge(assumptions?.supply || SUPPLY_ASSUMPTIONS, scenarioOverrides?.supplyAssumptions);
  const financingAssumptions = deepMerge(assumptions?.financing || FINANCING_ASSUMPTIONS, scenarioOverrides?.financing);

  // Precompute demand trajectories (block-chained, no discontinuities)
  const demandTrajectories = precomputeDemandTrajectories(months, demandAssumptions);

  // Organic supply growth: running multiplier per node.
  // Base expansion (from SUPPLY_ASSUMPTIONS) always applies — this is exogenous
  // datacenter/foundry/memory growth. When tightness > 1, shortage-driven growth
  // accelerates on top of the base rate via demand elasticity.
  const runningSupplyMult = {};
  for (const node of NODES) {
    if (node.group !== 'A') runningSupplyMult[node.id] = 1.0;
  }

  // Glut thresholds
  const glutThresholds = GLOBAL_PARAMS.glutThresholds || { soft: 0.95, hard: 0.80 };
  const predictiveParams = GLOBAL_PARAMS.predictiveSupply || {};

  // Hybrid bonding adoption curve params (for month-dependent intensity in sim loop)
  const hbAdoption = TRANSLATION_INTENSITIES?.gpuToComponents?.hybridBondingAdoption || {};
  const hbAdoptionInitial = resolveAssumptionValue(hbAdoption.initial, 0.02);
  const hbAdoptionTarget = resolveAssumptionValue(hbAdoption.target, 0.25);
  const hbAdoptionHalflife = resolveAssumptionValue(hbAdoption.halflifeMonths, 36);
  const hbIntensityBase = resolveAssumptionValue(
    TRANSLATION_INTENSITIES?.gpuToComponents?.hybridBondingPerGpu?.value, 0.35
  );

  // --- state init ---
  const nodeState = {};
  const startOverrides = scenarioOverrides?.startingState || {};

  // Opening fleet from FLEET_ANCHOR (Excel funding model: ~24 GW IT end-2025).
  // Three measures per pool: physical accelerators, effective units (each
  // accelerator × its vintage throughput relative to the month-0 frontier), and
  // IT kW. New accelerators add hwIndex effective units and kW0 × kwIndex kW.
  const kw0 = resolveAssumptionValue(TRANSLATION_INTENSITIES?.serverToInfra?.kwPerGpu?.value, FLEET_ANCHOR.kwPerAccelerator || 1.4);
  const frontierTok0 = FLEET_ANCHOR.frontierTokensPerKwhM || 7;
  const anchorPhys = FLEET_ANCHOR.vintages.reduce((sum, v) => sum + (v.gw * 1e6) / kw0, 0);
  const anchorEff = FLEET_ANCHOR.vintages.reduce((sum, v) => sum + ((v.gw * 1e6) / kw0) * (v.tokensPerKwhM / frontierTok0), 0);
  const fleetEffRatio0 = anchorPhys > 0 ? anchorEff / anchorPhys : 1;

  // Split the opening fleet between the datacenter and inference pools in the
  // same proportion as month-0 requirements (training + DC share of inference).
  const raw0 = computeRequiredGpus(0, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, 1);
  const dcInfShare0 = resolveGrowthRate(getDemandBlockForMonth(0, demandAssumptions)?.allocation?.dcInferenceShare, 0.60);
  const dcShare0 = raw0.requiredTotal > EPSILON
    ? (raw0.requiredTraining + raw0.requiredInference * dcInfShare0) / raw0.requiredTotal
    : 0.75;
  const defaultDcInstalled = anchorPhys * dcShare0;
  const defaultInfInstalled = anchorPhys * (1 - dcShare0);

  // Default starting backlogs for base case: reflects current massive shortage
  // (NVIDIA 6-12 month wait lists; every hyperscaler capacity-constrained).
  // Component backlogs are derived from the GPU backlog × per-GPU intensity so
  // they stay consistent with the centralized intensities — change an intensity
  // assumption and the implied component backlog follows automatically.
  const GPU_STARTING_BACKLOG = 4000000;
  const BACKLOG_COMPONENT_IDS = [
    'hbm_stacks', 'cowos_capacity', 'advanced_wafers',
    'dram_server', 'ssd_datacenter', 'server_assembly', 'datacenter_mw'
  ];
  const DEFAULT_STARTING_BACKLOGS = { gpu_datacenter: GPU_STARTING_BACKLOG };
  for (const id of BACKLOG_COMPONENT_IDS) {
    const intensity = nodeIntensityMap[id];
    if (intensity && intensity > 0) {
      DEFAULT_STARTING_BACKLOGS[id] = GPU_STARTING_BACKLOG * intensity;
    }
  }

  const dcInstalledOverride = startOverrides.datacenterInstalledBase ?? startOverrides.installedBaseDatacenter ?? startOverrides.installedBase;
  const infInstalledOverride = startOverrides.inferenceInstalledBase ?? startOverrides.installedBaseInference;

  for (const node of NODES) {
    const type = getNodeType(node.id);

    let installedBase = 0;
    if (node.id === 'gpu_datacenter') installedBase = (dcInstalledOverride !== undefined) ? dcInstalledOverride : defaultDcInstalled;
    if (node.id === 'gpu_inference') installedBase = (infInstalledOverride !== undefined) ? infInstalledOverride : defaultInfInstalled;
    // Opening vintages as monthly cohorts (install month relative to model
    // start), scaled to this pool's share of the fleet.
    const cohorts = [];
    if (installedBase > 0 && anchorPhys > 0) {
      const poolScale = installedBase / anchorPhys;
      for (const v of FLEET_ANCHOR.vintages) {
        const physPerMonth = ((v.gw * 1e6) / kw0) * poolScale / 12;
        for (let k = 0; k < 12; k++) {
          cohorts.push({
            month: (v.year - GLOBAL_PARAMS.startYear) * 12 + k,
            phys: physPerMonth,
            eff: physPerMonth * (v.tokensPerKwhM / frontierTok0),
            kw: physPerMonth * kw0
          });
        }
      }
      cohorts.sort((x, y) => x.month - y.month);
    }
    const installedEff = cohorts.reduce((sum, c) => sum + c.eff, 0) || installedBase * fleetEffRatio0;
    const installedKW = cohorts.reduce((sum, c) => sum + c.kw, 0) || installedBase * kw0;

    const overrideBacklog = startOverrides.backlogByNode?.[node.id];
    const initialBacklog = (overrideBacklog !== undefined) ? overrideBacklog : (DEFAULT_STARTING_BACKLOGS[node.id] ?? node.startingBacklog ?? 0);

    nodeState[node.id] = {
      type,
      inventory: (type === 'STOCK') ? (node.startingInventory || 0) : 0,
      backlog: initialBacklog,
      installedBase,
      installedEff,
      installedKW,
      cohorts,
      cohortHead: 0,
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
    // Month-0 required ÷ installed (effective units). Set so 2026 average
    // required compute ≈ the Excel funding model's 2026 figure (~37.5 GW):
    // the market starts modestly short and the gap widens through the year.
    targetRatio: scenarioOverrides?.calibration?.targetRatio ?? DEFAULT_CALIBRATION_RATIO,
    minScale: scenarioOverrides?.calibration?.minScale ?? 0.02,
    maxScale: scenarioOverrides?.calibration?.maxScale ?? 50
  };

  let demandScale = scenarioOverrides?.calibration?.demandScale ?? null;

  // Helper: compound organic growth for a node, scaled by demand pressure (tightness).
  // Growth is demand-driven (shortage × elasticity) and uncapped by default.
  // Nodes with real parallelism bottlenecks (labor, permitting, materials) define
  // maxAnnualExpansion to encode the actual constraint. Lead time only governs
  // *when* new capacity arrives, not *how much* can be started in parallel.
  // Utilization threshold: capacity expansion (both organic and discrete)
  // throttles when utilization is below this level. No board greenlights a
  // new fab when existing lines are running at 40% — you fill what you have
  // first. Below the floor, expansion stops entirely; between floor and
  // threshold it ramps linearly.
  const UTILIZATION_GATE_THRESHOLD = 0.65;
  const UTILIZATION_GATE_FLOOR = 0.30;
  // Contraction: deeply idle lines in a glutted market get mothballed or
  // repurposed. Up to 10%/yr at full idleness, never below half of the
  // accumulated multiplier (committed/base capacity is not demolished).
  const CONTRACTION_RATE_ANNUAL = 0.10;
  const CONTRACTION_MULT_FLOOR = 0.5;

  const compoundOrganicGrowth = (nodeId, month, tightness, utilization) => {
    const cat = SUPPLY_CATEGORY_MAP[nodeId];
    if (!cat) return;
    const util = (utilization !== undefined && utilization !== null) ? utilization : 1.0;

    // Contraction path: utilization below the investment floor AND a glutted
    // market → capacity slowly exits instead of holding forever.
    if (util < UTILIZATION_GATE_FLOOR && tightness < glutThresholds.soft) {
      const idleFactor = (UTILIZATION_GATE_FLOOR - util) / UTILIZATION_GATE_FLOOR;
      const monthlyDecay = Math.pow(1 - CONTRACTION_RATE_ANNUAL * idleFactor, 1 / 12);
      runningSupplyMult[nodeId] = Math.max(
        runningSupplyMult[nodeId] * monthlyDecay,
        CONTRACTION_MULT_FLOOR
      );
      return;
    }

    const blockKey = getBlockKeyForMonth(month);
    const block = supplyAssumptions?.[blockKey];
    // In a glut, organic base expansion pauses — otherwise capacity keeps
    // compounding until utilization hits the gate (~1.5× overcapacity),
    // making glut a guaranteed end state for every node.
    const baseRate = tightness < glutThresholds.soft
      ? 0
      : resolveGrowthRate(block?.expansionRates?.[cat], 0.15);

    // Scale growth by how severe the shortage is, using the node's long-run elasticity
    const node = NODE_MAP.get(nodeId);
    const elasticity = node?.elasticityLong || 0.5;
    const shortageMagnitude = Math.max(0, tightness - 1.0);
    const dynamicRate = baseRate + (shortageMagnitude * elasticity * 2.0);

    // Cap only if node defines an explicit parallelism constraint
    // (e.g., maxAnnualExpansion: 0.15 for transformers due to skilled labor limits)
    const cappedRate = node?.maxAnnualExpansion != null
      ? Math.min(dynamicRate, node.maxAnnualExpansion)
      : dynamicRate;

    // Utilization gate: throttle investment when existing capacity is underused.
    // Below floor → no expansion. Between floor and threshold → linear ramp.
    // Above threshold → full expansion rate.
    const utilizationFactor = (util >= UTILIZATION_GATE_THRESHOLD)
      ? 1.0
      : Math.max(0, (util - UTILIZATION_GATE_FLOOR) / (UTILIZATION_GATE_THRESHOLD - UTILIZATION_GATE_FLOOR));

    runningSupplyMult[nodeId] *= Math.pow(1 + cappedRate * utilizationFactor, 1 / 12);
  };

  // --- financing layer (port of the Excel funding model) ---
  const pue = resolveAssumptionValue(TRANSLATION_INTENSITIES?.serverToInfra?.pue?.value, 1.3);
  const financing = createFinancingModel(financingAssumptions, { startYear: GLOBAL_PARAMS.startYear, pue });
  const computeLifeMonths = Math.max(12, Math.round((financingAssumptions?.scalars?.computeLifeYears || 6) * 12));
  const startMonthIndex = (GLOBAL_PARAMS.startMonth || 1) - 1;
  results.fleet = {
    installedGW: [], requiredGW: [], deployedGW: [], retiredGW: [],
    fundingCapGW: [], binding: [], installedAccelerators: [],
    fleetTokPerKwhM: [], frontierTokPerKwhM: [], kwPerNewAccelerator: [],
    trainingShare: []
  };
  // On-device (edge) inference: shares wafer/EUV/DRAM supply, adds energy
  const edgeCfg = TRANSLATION_INTENSITIES?.edge || {};
  const edgeWaferX = resolveAssumptionValue(edgeCfg.waferIntensityVsDatacenter?.value, 1.0);
  const edgeDramX = resolveAssumptionValue(edgeCfg.dramIntensityVsDatacenter?.value, 1.0);
  const edgeEnergyX = resolveAssumptionValue(edgeCfg.energyPerTokenVsDatacenter?.value, 0.23);
  const edgeDevices0 = resolveAssumptionValue(edgeCfg.activeDevices?.value, 8.5e9);
  const edgeDeviceGrowth = resolveAssumptionValue(edgeCfg.activeDevices?.growth, 0.02);
  const edgeLifeMonths = Math.max(1, resolveAssumptionValue(edgeCfg.deviceLifeMonths?.value, 36));
  const EDGE_SHARED_NODES = { advanced_wafers: edgeWaferX, euv_tools: edgeWaferX, dram_server: edgeDramX };
  let edgeInstalledEff = null;
  Object.assign(results.fleet, { edgeEquivGW: [], edgePowerGW: [], dcPowerGW: [], edgeTokenShare: [], edgeUnitsDeployed: [], edgeWattsPerDevice: [] });
  const utilPath = financingAssumptions?.paths?.utilization || {};
  const idleShare = financingAssumptions?.scalars?.idlePowerShare ?? 0.5;

  // Diagnostic: annualized GW each gate could support, per month
  results.gates = {};
  const recordGate = (name, gpus, m, kw) => {
    if (!results.gates[name]) results.gates[name] = new Array(months).fill(null);
    results.gates[name][m] = Number.isFinite(gpus) ? gpus * kw / 1e6 * 12 : null;
  };
  let yearAccum = null;

  for (let month = 0; month < months; month++) {
    results.months.push(month);
    const monthOfYear = (startMonthIndex + month) % 12;
    const calendarYear = GLOBAL_PARAMS.startYear + Math.floor((startMonthIndex + month) / 12);

    // Update hybrid bonding intensity with month-dependent adoption curve
    // S-curve: starts at initial share (~2%), ramps toward target (~25%) with halflife of 36 months
    const hbShare = hbAdoptionTarget - (hbAdoptionTarget - hbAdoptionInitial) * Math.pow(2, -month / Math.max(hbAdoptionHalflife, 1));
    nodeIntensityMap['hybrid_bonding'] = hbIntensityBase * hbShare;

    const demandBlock = getDemandBlockForMonth(month, demandAssumptions);

    const currentInstalled = (nodeState['gpu_datacenter']?.installedBase || 0) + (nodeState['gpu_inference']?.installedBase || 0);
    const currentInstalledEff = (nodeState['gpu_datacenter']?.installedEff || 0) + (nodeState['gpu_inference']?.installedEff || 0);

    if (month === 0 && (demandScale === null || demandScale === undefined)) {
      const raw = computeRequiredGpus(0, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, 1);
      const rawReq = Math.max(raw.requiredTotal, 1);
      const desired = currentInstalledEff * calibrationCfg.targetRatio;

      let suggested = desired / rawReq;
      suggested = clamp(suggested, calibrationCfg.minScale, calibrationCfg.maxScale);

      demandScale = calibrationCfg.enabled ? suggested : 1;

      results.warnings.push(
        `INFO: Month 0 calibration: installed=${formatNumber(currentInstalled)} accelerators (${formatNumber(currentInstalledEff)} frontier-equivalent), raw required=${formatNumber(raw.requiredTotal)}. ` +
        `Applying demandScale=${demandScale.toFixed(2)} (enabled=${calibrationCfg.enabled}).`
      );
    }

    const scaleUsed = (demandScale === null || demandScale === undefined) ? 1 : demandScale;

    const req = computeRequiredGpus(month, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed);

    // Track edge offload series
    results.edgeOffload.tokensOffloaded.push(req.edgeTokensTotal || 0);
    results.edgeOffload.shareConsumer.push(req.edgeOffloadShare?.consumer || 0);
    results.edgeOffload.shareEnterprise.push(req.edgeOffloadShare?.enterprise || 0);
    results.edgeOffload.shareAgentic.push(req.edgeOffloadShare?.agentic || 0);

    // Forward-looking demand ratio cache for capacity planning.
    // Uses precomputed trajectories to forecast how much total GPU demand grows
    // over a given look-ahead horizon. Each node uses its own lead time as horizon.
    const demandForecastCache = {};
    const getDemandGrowthRatio = (lookAheadMonths) => {
      if (demandForecastCache[lookAheadMonths] !== undefined) return demandForecastCache[lookAheadMonths];
      const futureMonth = Math.min(month + lookAheadMonths, months - 1);
      if (futureMonth <= month || req.requiredTotal <= EPSILON) {
        demandForecastCache[lookAheadMonths] = 1;
        return 1;
      }
      const futureReq = computeRequiredGpus(futureMonth, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed);
      // Allow ratios below 1 so capacity planning can see demand decline —
      // flooring at 1 made contraction invisible to every expansion decision.
      const ratio = Math.max(futureReq.requiredTotal / req.requiredTotal, 0.1);
      demandForecastCache[lookAheadMonths] = ratio;
      return ratio;
    };

    // Allocation: training => DC; inference split by configurable share
    const dcInfShare = resolveGrowthRate(demandBlock?.allocation?.dcInferenceShare, 0.60);
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

    // Vintage indices for accelerators installed this month
    const hwIdx = Math.max(req.hwIndex || 1, EPSILON);
    const kwNew = kw0 * (req.kwIndex || 1);

    // Per-month intensities: power/infrastructure needs scale with IT kW per
    // new accelerator (intensities were built at the opening fleet's kW).
    const monthIntensity = { ...nodeIntensityMap };
    for (const id of INFRASTRUCTURE_NODES) {
      if (monthIntensity[id] !== undefined) monthIntensity[id] *= (req.kwIndex || 1);
    }

    // 1. Retirements: each monthly cohort retires when it reaches the compute
    //    life (Excel funding model: 6 years; the same input drives depreciation).
    //    Nobody scraps working accelerators early in a shortage.
    const retireCohorts = (pool) => {
      const out = { phys: 0, eff: 0, kw: 0 };
      while (pool.cohortHead < pool.cohorts.length && month - pool.cohorts[pool.cohortHead].month >= computeLifeMonths) {
        const c = pool.cohorts[pool.cohortHead];
        out.phys += c.phys; out.eff += c.eff; out.kw += c.kw;
        pool.cohortHead += 1;
      }
      return out;
    };
    const dcRet = retireCohorts(gpuState);
    const infRet = retireCohorts(infState);
    const dcRetirements = dcRet.phys;
    const infRetirements = infRet.phys;
    const dcEffRetire = dcRet.eff;
    const infEffRetire = infRet.eff;
    const dcKwRetire = dcRet.kw;
    const infKwRetire = infRet.kw;
    const retiredKW = dcKwRetire + infKwRetire;

    // 2. "Do Nothing" outcome in effective units (projected remaining fleet)
    const dcProjectedRemaining = Math.max(0, gpuState.installedEff - dcEffRetire);
    const infProjectedRemaining = Math.max(0, infState.installedEff - infEffRetire);

    // 3. Smart ordering: close the effective-capacity gap over CATCHUP_MONTHS,
    //    converted to physical accelerators at this month's hardware index.
    const planDeployDc = Math.max(0, (requiredDcBase - dcProjectedRemaining) / CATCHUP_MONTHS) / hwIdx;
    const planDeployInf = Math.max(0, (requiredInfBase - infProjectedRemaining) / CATCHUP_MONTHS) / hwIdx;

    // Financing: open the calendar year (fundable capex computed on opening balances)
    if (monthOfYear === 0 || month === 0) {
      const totalEff = gpuState.installedEff + infState.installedEff;
      const totalKW = gpuState.installedKW + infState.installedKW;
      let trainSum = 0, reqSum = 0, reqNextSum = 0;
      for (let m = month; m < Math.min(month + 12, months); m++) {
        const r = computeRequiredGpus(m, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed);
        trainSum += r.requiredTotal > EPSILON ? r.requiredTraining / r.requiredTotal : 0;
        reqSum += r.requiredTotal;
      }
      const yearLen = Math.min(12, months - month);
      for (let m = month + 12; m < Math.min(month + 24, months); m++) {
        reqNextSum += computeRequiredGpus(m, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed).requiredTotal;
      }
      const nextLen = Math.max(0, Math.min(12, months - month - 12));
      const midEff = getEfficiencyMultipliers(Math.min(month + 6, months - 1), efficiencyAssumptions, effCache, results.warnings, warnedSet);
      const reqAvg = reqSum / Math.max(yearLen, 1);
      financing.startYear(calendarYear, {
        openingGW: totalKW / 1e6,
        openingFleetTokPerKwhM: totalKW > EPSILON ? frontierTok0 * kw0 * totalEff / totalKW : frontierTok0,
        frontierTokPerKwhM: frontierTok0 * (midEff.H * midEff.H_memory) / Math.max(midEff.KW, EPSILON),
        trainingShare: trainSum / Math.max(yearLen, 1),
        servedFraction: totalEff > EPSILON ? reqAvg / totalEff : 1,
        priorScarcityRatio: totalEff > EPSILON ? Math.max(0, req.requiredTotal - totalEff) / totalEff : 0,
        preSpendRatio: nextLen > 0 && reqAvg > EPSILON ? (reqNextSum / nextLen) / reqAvg : 1
      });
      yearAccum = { requiredGWSum: 0, months: 0, tokens: 0, edgeEquivGW: 0, edgePowerGW: 0, dcPowerGW: 0, edgeShare: 0, edgeWatts: 0 };
    }

    const backlogPaydown = gpuState.backlog / BACKLOG_PAYDOWN_MONTHS_GPU;

    const planDeployTotal = planDeployDc + planDeployInf + backlogPaydown;
    const baselinePlan = planDeployDc + planDeployInf;

    // =======================================================
    // STEP 1: POTENTIALS (with organic supply growth)
    // =======================================================
    const potentials = {};
    for (const node of NODES) {
      if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') continue;
      if (node.group === 'A') continue;

      const state = nodeState[node.id];
      const sMult = runningSupplyMult[node.id] || 1;
      const cap = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions, sMult);
      const y = calculateNodeYield(node, month);
      const effCap = cap * (node.maxCapacityUtilization || 0.95) * y;

      potentials[node.id] = (state.type === 'STOCK') ? (state.inventory + effCap) : effCap;
    }

    // On-device silicon claims shared wafer/EUV/DRAM supply first (phone and
    // PC makers hold long-term contracts). Devices refresh every edgeLifeMonths.
    if (edgeInstalledEff === null) edgeInstalledEff = req.requiredEdge || 0;
    const edgeRetireEff = edgeInstalledEff / edgeLifeMonths;
    const edgeNeedEff = Math.max(0, (req.requiredEdge || 0) - (edgeInstalledEff - edgeRetireEff));
    const edgeUnits = edgeNeedEff / hwIdx; // physical datacenter-equivalent units at this month's hardware
    const edgeDemand = {};
    let edgeServedFrac = 1;
    for (const [id, x] of Object.entries(EDGE_SHARED_NODES)) {
      const need = edgeUnits * (monthIntensity[id] || 0) * x;
      edgeDemand[id] = need;
      if (need > EPSILON && potentials[id] !== undefined) {
        edgeServedFrac = Math.min(edgeServedFrac, potentials[id] / need);
        potentials[id] = Math.max(0, potentials[id] - need);
      }
    }
    edgeServedFrac = clamp(edgeServedFrac, 0, 1);
    edgeInstalledEff = Math.max(0, edgeInstalledEff - edgeRetireEff + edgeNeedEff * edgeServedFrac);

    // =======================================================
    // STEP 2: GATING
    // =======================================================
    const gpuNode = NODE_MAP.get('gpu_datacenter');
    const gpuSMult = runningSupplyMult['gpu_datacenter'] || 1;
    const gpuCap = calculateCapacity(gpuNode, month, scenarioOverrides, gpuState.dynamicExpansions, gpuSMult);
    const gpuYield = calculateNodeYield(gpuNode, month);
    const gpuEffCap = gpuCap * 0.95 * gpuYield;

    // gpu_inference fab capacity supplies the same accelerator pool. Both fab
    // lines feed one inventory (tracked on gpuState) from which DC and
    // inference deployments draw.
    const infNode = NODE_MAP.get('gpu_inference');
    const infSMult = runningSupplyMult['gpu_inference'] || 1;
    const infCap = calculateCapacity(infNode, month, scenarioOverrides, infState.dynamicExpansions, infSMult);
    const infYield = calculateNodeYield(infNode, month);
    const infEffCap = infCap * 0.95 * infYield;

    const gpuEffCapTotal = gpuEffCap + infEffCap;
    const gpuAvailable = gpuState.inventory + gpuEffCapTotal;

    // Capacity freed by retiring GPUs: replacement deployments reuse the
    // retired units' buildings, hookups, transformers, and staff, so
    // infrastructure only constrains NET fleet additions. Expressed in
    // new-accelerator equivalents (retired kW ÷ kW per new accelerator).
    const totalRetirements = retiredKW / Math.max(kwNew, EPSILON);

    // Off-grid offset: behind-the-meter generation (gas turbines, solar+storage,
    // SMRs) bypasses grid infrastructure entirely. Power generation PPAs and
    // large power transformers are only needed for the grid-connected fraction
    // of total power delivery. As off-grid capacity grows, demand on grid
    // infrastructure (PPAs, LPTs) shrinks proportionally.
    const gridPotential = potentials['grid_interconnect'] || 0;
    const offGridPotential = potentials['off_grid_power'] || 0;
    const totalPowerPotential = gridPotential + offGridPotential;
    const gridShare = totalPowerPotential > EPSILON
      ? gridPotential / totalPowerPotential
      : 1.0; // default to full grid dependency if no power yet

    let maxSupported = Infinity;
    let maxSupportedNode = null;
    let constraintCount = 0;

    // Substitution pooling: grid and off-grid hookups deliver the same MW and
    // have their potentials summed before gating, so off-grid power can absorb
    // demand when the grid interconnect queue is full. Built datacenter
    // capacity (datacenter_mw) gates separately — a building is not a hookup.
    // Infrastructure nodes constrain net fleet additions only: the capacity
    // freed by this month's retirements supports that many replacements.
    const pooledPotentials = {};
    for (const [nodeId, intensity] of Object.entries(monthIntensity)) {
      const potential = potentials[nodeId];
      if (potential === undefined || intensity <= 0) continue;
      // Hybrid bonding is not a hard gate: when bonding capacity is short,
      // designs fall back to CoWoS-only packaging (already required for every
      // accelerator). It still reports demand, tightness and expansion signals.
      if (nodeId === 'hybrid_bonding') continue;
      const pool = SUBSTITUTION_POOLS[nodeId];
      if (pool) {
        if (!pooledPotentials[pool]) pooledPotentials[pool] = { potential: 0, intensity };
        pooledPotentials[pool].potential += potential;
      } else {
        // Grid-dependent infrastructure: scale intensity by grid share so that
        // off-grid MW reduces the constraint from PPAs and transformers.
        const effectiveIntensity = (nodeId === 'power_generation' || nodeId === 'transformers_lpt')
          ? intensity * gridShare
          : intensity;
        let supported = (effectiveIntensity > EPSILON) ? potential / effectiveIntensity : Infinity;
        if (INFRASTRUCTURE_NODES.has(nodeId)) supported += totalRetirements;
        recordGate(NODE_MAP.get(nodeId)?.name || nodeId, supported, month, kwNew);
        if (supported < maxSupported) { maxSupported = supported; maxSupportedNode = NODE_MAP.get(nodeId)?.name || nodeId; }
        constraintCount++;
      }
    }
    for (const [poolName, { potential, intensity }] of Object.entries(pooledPotentials)) {
      // The power_hookup pool is infrastructure: retirements free hookups too.
      const supported = potential / intensity + totalRetirements;
      recordGate(poolName === 'power_hookup' ? 'Power hookups (grid + on-site)' : poolName, supported, month, kwNew);
      if (supported < maxSupported) { maxSupported = supported; maxSupportedNode = poolName === 'power_hookup' ? 'Power hookups (grid + on-site)' : poolName; }
      constraintCount++;
    }

    if (constraintCount === 0 && (month === 0 || month % 12 === 0)) {
      results.warnings.push(`Warning (Month ${month}): No active component constraints found.`);
      maxSupported = Infinity;
    }

    // Funding gate: the year's fundable capex, paced monthly (Excel funding model)
    const fundingCap = financing.capForMonth({
      monthOfYear,
      kwPerNewAccel: kwNew,
      retiredGW: retiredKW / 1e6
    });

    recordGate('GPU supply (fab + inventory)', gpuAvailable, month, kwNew);
    recordGate('Plan (demand)', planDeployTotal, month, kwNew);
    recordGate('Funding', fundingCap, month, kwNew);
    const demandCeiling = planDeployTotal;
    const physicalMax = Math.min(demandCeiling, gpuAvailable, maxSupported);
    const actualDeployTotal = Math.min(physicalMax, fundingCap);
    const blockedByComponents = Math.max(0, Math.min(demandCeiling, gpuAvailable) - Math.min(demandCeiling, gpuAvailable, maxSupported));
    const lostToFundingGW = Math.max(0, physicalMax - actualDeployTotal) * kwNew / 1e6;

    // Binding constraint this month (what set actual deployments)
    let binding = 'Demand';
    if (actualDeployTotal < physicalMax - 1e-6) binding = 'Funding';
    else if (maxSupported <= Math.min(demandCeiling, gpuAvailable) + 1e-6 && maxSupported < demandCeiling - 1e-6) binding = maxSupportedNode ? `Components: ${maxSupportedNode}` : 'Components';
    else if (gpuAvailable < demandCeiling - 1e-6) binding = 'GPU supply';

    // =======================================================
    // STEP 3: UPDATES
    // =======================================================
    // GPU buffer tracks actual deployment, not the unconstrained plan. When
    // components gate deployment below plan, building GPU inventory against the
    // full plan just piles up chips that can't deploy.
    const gpuBufferTarget = actualDeployTotal * DEFAULT_BUFFER_MONTHS;
    const gpuProdTarget = actualDeployTotal + Math.max(0, gpuBufferTarget - gpuState.inventory);
    const gpuProduced = Math.min(gpuEffCapTotal, gpuProdTarget);

    const oldGpuBacklog = gpuState.backlog;

    gpuState.inventory = (gpuState.inventory + gpuProduced) - actualDeployTotal;
    if (gpuState.inventory < -1e-6) gpuState.inventory = 0;

    // GPU backlog grows from all deployment shortfalls (including component
    // gating). This inflates planDeployTotal via backlog paydown, which
    // increases planDemand for components, driving expansion of the bottleneck.
    // The effectiveDemand cap on production prevents this from causing runaway
    // inventory in non-binding components — only the investment signal grows.
    gpuState.backlog = Math.max(0, oldGpuBacklog + baselinePlan - actualDeployTotal);
    // Orders only stay on the books while the capacity is still needed: cap the
    // backlog at the remaining effective gap (in physical accelerators at this
    // month's hardware index). Without this, years of funding- or supply-limited
    // builds pile up a backlog that keeps driving deployments after the fleet
    // has already caught up with demand (the gap was counted twice: once in
    // the plan, once in backlog paydown).
    {
      const installedEffAfter = gpuState.installedEff + infState.installedEff
        + actualDeployTotal * hwIdx - dcEffRetire - infEffRetire;
      const remainingGapPhys = Math.max(0, req.requiredTotal - installedEffAfter) / hwIdx;
      gpuState.backlog = Math.min(gpuState.backlog, remainingGapPhys);
    }

    const shareDc = baselinePlan > EPSILON ? (planDeployDc / baselinePlan) : 0.7;
    const actualDc = actualDeployTotal * shareDc;
    const actualInf = actualDeployTotal * (1 - shareDc);

    const blockedDc = blockedByComponents * shareDc;
    const blockedInf = blockedByComponents * (1 - shareDc);

    gpuState.installedBase = Math.max(0, gpuState.installedBase + actualDc - dcRetirements);
    infState.installedBase = Math.max(0, infState.installedBase + actualInf - infRetirements);
    gpuState.installedEff = Math.max(0, gpuState.installedEff + actualDc * hwIdx - dcEffRetire);
    infState.installedEff = Math.max(0, infState.installedEff + actualInf * hwIdx - infEffRetire);
    gpuState.installedKW = Math.max(0, gpuState.installedKW + actualDc * kwNew - dcKwRetire);
    infState.installedKW = Math.max(0, infState.installedKW + actualInf * kwNew - infKwRetire);
    if (actualDc > 0) gpuState.cohorts.push({ month, phys: actualDc, eff: actualDc * hwIdx, kw: actualDc * kwNew });
    if (actualInf > 0) infState.cohorts.push({ month, phys: actualInf, eff: actualInf * hwIdx, kw: actualInf * kwNew });

    // Tightness compares demand flow against production capacity (flow vs
    // flow). Inventory buffers delivery but is not monthly supply — dividing
    // by (inventory + capacity) made every balanced market read as glut.
    const gpuTotalLoad = baselinePlan + (oldGpuBacklog / BACKLOG_PAYDOWN_MONTHS_GPU);
    const gpuTightness = gpuTotalLoad / Math.max(gpuEffCapTotal, EPSILON);
    const gpuPriceIndex = calculatePriceIndex(gpuTightness);

    // Forward-looking capacity expansion for GPUs
    // Look ahead by GPU lead time, forecast demand using trajectories, trigger build if shortage projected
    gpuState.tightnessHistory.push(gpuTightness);

    // GPU utilization: actual deployment vs combined effective capacity
    const gpuUtilization = gpuEffCapTotal > EPSILON ? actualDeployTotal / gpuEffCapTotal : 1.0;

    // Organic growth: base expansion always applies (exogenous datacenter growth);
    // when tightness > 1 (demand exceeds supply), shortage-driven growth adds on top.
    // Throttled by utilization — don't invest in new lines when existing ones are idle.
    compoundOrganicGrowth('gpu_datacenter', month, gpuTightness, gpuUtilization);
    compoundOrganicGrowth('gpu_inference', month, gpuTightness, gpuUtilization);

    const gpuLeadTime = gpuNode.leadTimeDebottleneck || 6;
    const gpuCooldown = Math.max(Math.floor(gpuLeadTime / 2), 6);
    if ((month - gpuState.lastExpansionMonth) > gpuCooldown && gpuUtilization >= UTILIZATION_GATE_FLOOR) {
      const gpuGrowthRatio = getDemandGrowthRatio(gpuLeadTime);
      const forecastGpuDemand = planDeployTotal * gpuGrowthRatio;
      const gpuFutureMonth = Math.min(month + gpuLeadTime, months - 1);
      const forecastGpuSMult = runningSupplyMult['gpu_datacenter'] || 1;
      const forecastGpuCap = calculateCapacity(gpuNode, gpuFutureMonth, scenarioOverrides, gpuState.dynamicExpansions, forecastGpuSMult);
      const forecastInfSMult = runningSupplyMult['gpu_inference'] || 1;
      const forecastInfCap = calculateCapacity(infNode, gpuFutureMonth, scenarioOverrides, infState.dynamicExpansions, forecastInfSMult);
      const forecastGpuEffCap = (forecastGpuCap * calculateNodeYield(gpuNode, gpuFutureMonth)
        + forecastInfCap * calculateNodeYield(infNode, gpuFutureMonth)) * 0.95;

      if (forecastGpuDemand > forecastGpuEffCap) {
        const gap = forecastGpuDemand - forecastGpuEffCap;
        const expansionAmount = Math.min(gap * 0.5, gpuCap * 0.30);
        gpuState.dynamicExpansions.push({
          month: gpuFutureMonth,
          capacityAdd: Math.max(expansionAmount, gpuCap * 0.05)
        });
        gpuState.lastExpansionMonth = month;
      }
    }

    // Glut detection for GPUs
    const gpuIsShort = gpuState.backlog > 0 || gpuTightness > 1.05;
    const gpuIsGlut = gpuTightness < glutThresholds.soft && gpuState.backlog <= 0;
    const gpuIsHardGlut = gpuTightness < glutThresholds.hard && gpuState.backlog <= 0;

    const storeGpu = (isDc) => {
      const nodeId = isDc ? 'gpu_datacenter' : 'gpu_inference';
      const res = results.nodes[nodeId];
      if (!res) return;

      const share = isDc ? shareDc : (1 - shareDc);

      res.demand.push(planDeployTotal * share);
      res.planDeploy.push(planDeployTotal * share);
      res.supply.push(isDc ? actualDc : actualInf);
      res.capacity.push(isDc ? gpuEffCap : infEffCap);
      res.supplyPotential.push(isDc ? gpuEffCap : infEffCap);
      res.potential.push(isDc ? gpuEffCap : infEffCap);
      res.inventory.push(isDc ? gpuState.inventory : 0);
      res.backlog.push(gpuState.backlog * share);
      res.installedBase.push(isDc ? gpuState.installedBase : infState.installedBase);
      // Required accelerators at the pool's current average vintage mix, so it
      // compares like-for-like with installedBase.
      const pool = isDc ? gpuState : infState;
      const physPerEff = pool.installedEff > EPSILON ? pool.installedBase / pool.installedEff : 1 / hwIdx;
      res.requiredBase.push((isDc ? requiredDcBase : requiredInfBase) * physPerEff);
      res.consumption.push(actualDeployTotal * share);
      res.gpuDelivered.push(isDc ? actualDc : actualInf);
      res.idleGpus.push(isDc ? blockedDc : blockedInf);
      res.tightness.push(gpuTightness);
      res.priceIndex.push(gpuPriceIndex);
      res.yield.push(isDc ? gpuYield : infYield);
      res.shortage.push(gpuIsShort ? 1 : 0);
      res.glut.push(gpuIsGlut ? (gpuIsHardGlut ? 2 : 1) : 0);
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
      const baseIntensity = monthIntensity[node.id] || 0;

      // Grid-dependent infrastructure: scale intensity by grid share. Off-grid
      // generation bypasses PPAs and large transformers, so these nodes only
      // need to serve the grid-connected fraction of total power delivery.
      // Grid and off-grid hookups likewise split the MW demand by share —
      // they are substitutes, so neither sees the full load.
      let intensity = baseIntensity;
      if (node.id === 'power_generation' || node.id === 'transformers_lpt' || node.id === 'grid_interconnect') {
        intensity = baseIntensity * gridShare;
      } else if (node.id === 'off_grid_power') {
        intensity = baseIntensity * (1 - gridShare);
      }

      // Infrastructure demand tracks NET fleet growth: replacement GPUs reuse
      // the retiring units' buildings, hookups, transformers, and staff.
      const isInfra = INFRASTRUCTURE_NODES.has(node.id);
      const planUnits = isInfra ? Math.max(0, planDeployTotal - totalRetirements) : planDeployTotal;
      const actualUnits = isInfra ? Math.max(0, actualDeployTotal - totalRetirements) : actualDeployTotal;

      const edgeNeed = edgeDemand[node.id] || 0;
      const planDemand = planUnits * intensity + edgeNeed;
      const actualConsumption = actualUnits * intensity + edgeNeed * edgeServedFrac;

      // Effective demand: producers respond to what customers actually consume,
      // not the unconstrained order book. When a different component is the fleet
      // bottleneck, actual consumption can be well below planDemand. Producers
      // maintain CONSUMPTION_HEADROOM (1.5×) above current consumption for growth
      // readiness, but won't speculatively produce 2-3× what's being consumed.
      // During bootstrap (no consumption yet), fall back to plan demand.
      const effectiveDemand = actualConsumption > EPSILON
        ? Math.min(planDemand, actualConsumption * CONSUMPTION_HEADROOM)
        : planDemand;

      const sMult = runningSupplyMult[node.id] || 1;
      const cap = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions, sMult);
      const y = calculateNodeYield(node, month);
      const effCap = cap * (node.maxCapacityUtilization || 0.95) * y;

      const inventoryIn = state.inventory;
      const backlogIn = state.backlog;
      const backlogUrgency = backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS;

      const potentialSupply = (state.type === 'STOCK') ? (inventoryIn + effCap) : effCap;

      // Consumption-aware fulfillment: production targets effective demand (what
      // customers actually take + growth headroom), not the unconstrained plan.
      // STOCK nodes cap inventory at INVENTORY_CEILING_MONTHS of consumption to
      // avoid unbounded buildup when a different component is the fleet bottleneck.
      let production = 0;
      let delivered = 0;

      if (state.type === 'STOCK') {
        const inventoryCeiling = effectiveDemand * INVENTORY_CEILING_MONTHS;
        const bufferGap = Math.max(0, inventoryCeiling - inventoryIn);
        const prodNeed = effectiveDemand + backlogUrgency + bufferGap / Math.max(INVENTORY_CEILING_MONTHS, 1);
        production = Math.min(effCap, prodNeed);
        const available = inventoryIn + production;
        delivered = Math.min(effectiveDemand + backlogUrgency, available);
        state.inventory = available - delivered;
        if (state.inventory < -1e-6) state.inventory = 0;
      } else {
        // FLOW / THROUGHPUT / QUEUE — no inventory, deliver against effective demand + backlog
        delivered = Math.min(effectiveDemand + backlogUrgency, effCap);
        state.inventory = 0;
      }

      // Backlog tracks against effective demand (not plan). When actual consumption
      // is well below plan due to a different bottleneck, the "unmet" plan demand
      // is not a real order shortfall — it's phantom demand that nobody needs yet.
      const unmetThisMonth = Math.max(0, effectiveDemand - delivered);
      state.backlog = Math.max(0, backlogIn + effectiveDemand - delivered);

      // Market tightness: uses plan demand for price signals and reporting.
      // Reflects the full order-book pressure that drives market pricing.
      // Compares demand FLOW against production capacity (flow vs flow) —
      // inventory buffers delivery but is not monthly supply, and dividing by
      // (inventory + capacity) made every balanced STOCK market read as glut.
      const totalLoad = planDemand + (backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS);
      const tightness = totalLoad / Math.max(effCap, EPSILON);
      const priceIndex = calculatePriceIndex(tightness);

      // Operational tightness: uses effective demand for capacity expansion.
      // When a different component is the fleet bottleneck (GPU gating), plan
      // demand can be 2-3× actual consumption. Expanding capacity against the
      // unconstrained order book builds factories that sit idle — no board
      // greenlights a new line when the existing one ships 30% of capacity.
      // Operational tightness ensures organic growth and discrete expansion
      // respond to what customers actually take, not phantom demand.
      const operationalLoad = effectiveDemand + (backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS);
      const operationalTightness = operationalLoad / Math.max(effCap, EPSILON);

      // Forward-looking capacity expansion for components
      state.tightnessHistory.push(tightness);

      // Component utilization: delivered output vs effective capacity.
      // For STOCK nodes, use production vs capacity; for FLOW, delivered vs capacity.
      const compUtilization = effCap > EPSILON
        ? (state.type === 'STOCK' ? production : delivered) / effCap
        : 1.0;

      // Organic growth: base expansion always applies; shortage adds extra growth on top.
      // Uses operationalTightness (effective demand) so non-binding components don't
      // expand chasing unconstrained plan demand they'll never ship against.
      // Throttled by utilization — don't build capacity you can't fill.
      compoundOrganicGrowth(node.id, month, operationalTightness, compUtilization);

      const compLeadTime = node.leadTimeDebottleneck || 12;
      const compCooldown = Math.max(Math.floor(compLeadTime / 2), 6);
      if ((month - state.lastExpansionMonth) > compCooldown && compUtilization >= UTILIZATION_GATE_FLOOR) {
        const growthRatio = getDemandGrowthRatio(compLeadTime);
        // Forecast from effective demand, not plan. When GPU gating limits
        // actual deployment, the unconstrained plan inflates forecasts for
        // non-binding components, triggering discrete expansions that produce
        // capacity nobody can use. Effective demand tracks what's actually
        // being consumed (+ headroom), giving a realistic expansion signal.
        const forecastDemand = effectiveDemand * growthRatio;
        const compFutureMonth = Math.min(month + compLeadTime, months - 1);
        const futureSMult = runningSupplyMult[node.id] || 1;
        const futureCap = calculateCapacity(node, compFutureMonth, scenarioOverrides, state.dynamicExpansions, futureSMult);
        const futureEffCap = futureCap * (node.maxCapacityUtilization || 0.95) * calculateNodeYield(node, compFutureMonth);

        if (forecastDemand > futureEffCap) {
          const gap = forecastDemand - futureEffCap;
          // Dynamic expansion: uncapped unless node defines a parallelism limit
          const maxDynamic = node.maxAnnualExpansion != null
            ? cap * (node.maxAnnualExpansion / 12)
            : cap * 1.0;
          const expansionAmount = Math.min(gap * 0.5, maxDynamic);
          // Floor at 5% of capacity for uncapped nodes (keeps progress on shortages);
          // for capped nodes, never exceed the monthly parallelism cap — otherwise
          // the floor would silently bypass maxAnnualExpansion (e.g., grid_interconnect
          // at 10%/yr would still gain 5% per trigger, ~33%/yr effective).
          const expansionFloor = node.maxAnnualExpansion != null
            ? Math.min(cap * 0.05, maxDynamic)
            : cap * 0.05;
          state.dynamicExpansions.push({
            month: month + compLeadTime,
            capacityAdd: Math.max(expansionAmount, expansionFloor)
          });
          state.lastExpansionMonth = month;
        }
      }

      // Glut detection for components
      const isShort = tightness > 1.05 || state.backlog > 0;
      const isGlut = tightness < glutThresholds.soft && state.backlog <= 0;
      const isHardGlut = tightness < glutThresholds.hard && state.backlog <= 0;

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
        nodeRes.unmetDemand.push(unmetThisMonth);

        nodeRes.shortage.push(isShort ? 1 : 0);
        nodeRes.glut.push(isGlut ? (isHardGlut ? 2 : 1) : 0);

        nodeRes.installedBase.push(0);
        nodeRes.requiredBase.push(0);
        nodeRes.gpuDelivered.push(0);
        nodeRes.idleGpus.push(0);
        nodeRes.consumption.push(actualConsumption);
      }
    }

    // ---- Fleet + financing bookkeeping (end of month) ----
    const fleetKW = gpuState.installedKW + infState.installedKW;
    const fleetEff = gpuState.installedEff + infState.installedEff;
    const fleetPhys = gpuState.installedBase + infState.installedBase;
    const kwPerEff = fleetEff > EPSILON ? fleetKW / fleetEff : kwNew / hwIdx;
    const requiredGW = req.requiredTotal * kwPerEff / 1e6;
    const deployedGW = actualDeployTotal * kwNew / 1e6;
    const retiredGW = retiredKW / 1e6;

    results.fleet.installedGW.push(fleetKW / 1e6);
    results.fleet.requiredGW.push(requiredGW);
    results.fleet.deployedGW.push(deployedGW);
    results.fleet.retiredGW.push(retiredGW);
    results.fleet.fundingCapGW.push(Number.isFinite(fundingCap) ? fundingCap * kwNew / 1e6 : null);
    results.fleet.binding.push(binding);
    results.fleet.installedAccelerators.push(fleetPhys);
    results.fleet.fleetTokPerKwhM.push(fleetKW > EPSILON ? frontierTok0 * kw0 * fleetEff / fleetKW : frontierTok0);
    results.fleet.frontierTokPerKwhM.push(frontierTok0 * hwIdx / Math.max(req.kwIndex || 1, EPSILON));
    results.fleet.kwPerNewAccelerator.push(kwNew);
    results.fleet.trainingShare.push(req.requiredTotal > EPSILON ? req.requiredTraining / req.requiredTotal : 0);

    // Energy: average draw = idle share + (1 − idle) × utilization (Excel convention)
    const utilNow = utilPath[calendarYear] ?? utilPath[String(calendarYear)] ?? 0.6;
    const drawFactor = idleShare + (1 - idleShare) * utilNow;
    const edgeEquivGW = (req.requiredEdge || 0) * kwPerEff / 1e6;
    const dcPowerGW = (fleetKW / 1e6) * drawFactor * pue;
    const edgePowerGW = edgeEquivGW * drawFactor * pue * edgeEnergyX;
    const dcTokens = (req.inferenceDemand.consumer || 0) + (req.inferenceDemand.enterprise || 0) + (req.inferenceDemand.agentic || 0);
    results.fleet.edgeEquivGW.push(edgeEquivGW);
    results.fleet.dcPowerGW.push(dcPowerGW);
    results.fleet.edgePowerGW.push(edgePowerGW);
    results.fleet.edgeTokenShare.push(dcTokens > EPSILON ? (req.edgeTokensTotal || 0) / (dcTokens * scaleUsed) : 0);
    results.fleet.edgeUnitsDeployed.push(edgeUnits * edgeServedFrac);
    const devicesNow = edgeDevices0 * Math.pow(1 + edgeDeviceGrowth, month / 12);
    results.fleet.edgeWattsPerDevice.push(devicesNow > 0 ? edgePowerGW * 1e9 / devicesNow : 0);

    financing.recordMonth({ deployedGW, retiredGW, binding, lostToFundingGW });
    if (yearAccum) {
      yearAccum.requiredGWSum += requiredGW;
      yearAccum.months += 1;
      yearAccum.tokens += (req.inferenceDemand.consumer || 0) + (req.inferenceDemand.enterprise || 0) + (req.inferenceDemand.agentic || 0);
      yearAccum.edgeEquivGW += edgeEquivGW;
      yearAccum.edgePowerGW += edgePowerGW;
      yearAccum.dcPowerGW += dcPowerGW;
      yearAccum.edgeShare += results.fleet.edgeTokenShare[month];
      yearAccum.edgeWatts += results.fleet.edgeWattsPerDevice[month];
    }
    if (monthOfYear === 11 || month === months - 1) {
      financing.closeYear({
        tokenDemandIndex: yearAccum ? yearAccum.tokens * scaleUsed : 0,
        requiredGW: yearAccum && yearAccum.months ? yearAccum.requiredGWSum / yearAccum.months : requiredGW,
        requiredGWYearEnd: requiredGW,
        installedGW: fleetKW / 1e6,
        scarcityRatio: fleetEff > EPSILON ? Math.max(0, req.requiredTotal - fleetEff) / fleetEff : 0,
        extras: yearAccum && yearAccum.months ? {
          edgeTokenShare: yearAccum.edgeShare / yearAccum.months,
          edgeEquivGW: yearAccum.edgeEquivGW / yearAccum.months,
          edgePowerGW: yearAccum.edgePowerGW / yearAccum.months,
          dcPowerGW: yearAccum.dcPowerGW / yearAccum.months,
          totalAiPowerGW: (yearAccum.edgePowerGW + yearAccum.dcPowerGW) / yearAccum.months,
          edgeWattsPerDevice: yearAccum.edgeWatts / yearAccum.months
        } : {}
      });
    }
  }

  results.financing = financing.finalize();
  results.annual = results.financing.years;
  results.summary = analyzeResults(results);
  return results;
}

// ============================================
// 6) ANALYSIS & FORMATTING
// ============================================

function analyzeResults(results) {
  const shortages = [];
  const gluts = [];
  const bottlenecks = [];
  const shortagePersistence = 3;
  const glutPersistence = 3;

  for (const [nodeId, data] of Object.entries(results.nodes)) {
    const node = NODE_MAP.get(nodeId);
    if (!node || node.group === 'A') continue;

    // Shortage detection
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

    // Glut detection
    let glutStart = null;
    let minTightness = Infinity;
    let glutDuration = 0;
    let consecGlut = 0;

    for (let month = 0; month < (data.glut?.length || 0); month++) {
      const isGlut = (data.glut[month] || 0) > 0;
      const t = data.tightness?.[month] || 1;

      if (isGlut) {
        consecGlut++;
        if (consecGlut >= glutPersistence) {
          if (glutStart === null) glutStart = month - glutPersistence + 1;
          minTightness = Math.min(minTightness, t);
          glutDuration++;
        }
      } else {
        if (glutStart !== null) {
          gluts.push({
            nodeId,
            nodeName: node.name,
            group: node.group,
            startMonth: glutStart,
            minTightness,
            duration: glutDuration,
            severity: (1 - minTightness) * glutDuration
          });
        }
        glutStart = null;
        minTightness = Infinity;
        glutDuration = 0;
        consecGlut = 0;
      }
    }

    if (glutStart !== null) {
      gluts.push({
        nodeId,
        nodeName: node.name,
        group: node.group,
        startMonth: glutStart,
        minTightness,
        duration: glutDuration,
        severity: (1 - minTightness) * glutDuration
      });
    }

    // Bottleneck detection: nodes with avg tightness > 1.1 in first 24 months
    const early = (data.tightness || []).slice(0, 24);
    const avgEarlyTightness = early.length > 0
      ? early.reduce((a, b) => a + (b || 0), 0) / early.length
      : 0;
    if (avgEarlyTightness > 1.1) {
      const maxTightness = Math.max(...early.map(v => v || 0));
      const shortageMonths = early.filter(v => (v || 0) > 1.05).length;

      // Downstream impact: count child nodes weighted by their tightness contribution
      const children = NODES.filter(n => n.parentNodeIds?.includes(nodeId));
      const downstreamImpact = children.reduce((acc, child) => {
        const childData = results.nodes[child.id];
        const childAvg = childData?.tightness
          ? childData.tightness.slice(0, 24).reduce((a, b) => a + (b || 0), 0) / Math.max(childData.tightness.slice(0, 24).length, 1)
          : 0;
        return acc + (childAvg > 1.0 ? childAvg : 0);
      }, 0);

      bottlenecks.push({
        nodeId,
        nodeName: node.name,
        group: node.group,
        avgTightness: avgEarlyTightness,
        maxTightness,
        shortageMonths,
        downstreamImpact
      });
    }
  }

  shortages.sort((a, b) => b.severity - a.severity);
  gluts.sort((a, b) => b.severity - a.severity);
  bottlenecks.sort((a, b) => b.avgTightness - a.avgTightness);

  return {
    shortages: shortages.slice(0, 20),
    gluts: gluts.slice(0, 20),
    bottlenecks: bottlenecks.slice(0, 10)
  };
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
