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
 * summed in the gating step. This models interchangeable supply sources
 * (e.g., grid MW and off-grid MW both deliver watts to datacenters).
 * Nodes NOT in this map are gated independently as before.
 */
const SUBSTITUTION_POOLS = {
  grid_interconnect: 'mw_delivery',
  off_grid_power: 'mw_delivery'
};

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

// Planning knobs
const CATCHUP_MONTHS = 6;
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
      const annualRate = resolveAssumptionValue(block?.expansionRates?.[cat]?.value, 0);
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
    cache[0] = { M_inference: 1, M_training: 1, S_inference: 1, S_training: 1, H: 1, H_memory: 1 };
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

  const decayInf = Math.pow(1 - mInfAnnual, 1 / 12);
  const decayTrn = Math.pow(1 - mTrnAnnual, 1 / 12);

  const growSInf = Math.pow(1 + sInfAnnual, 1 / 12);
  const growSTrn = Math.pow(1 + sTrnAnnual, 1 / 12);
  const growH = Math.pow(1 + hAnnual, 1 / 12);
  const growHMem = Math.pow(1 + hMemAnnual, 1 / 12);

  const cur = {
    M_inference: prev.M_inference * decayInf,
    M_training: prev.M_training * decayTrn,
    S_inference: prev.S_inference * growSInf,
    S_training: prev.S_training * growSTrn,
    H: prev.H * growH,
    H_memory: prev.H_memory * growHMem
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
  // Thermodynamic floor: no matter how clever the algorithm or how optimized the silicon,
  // inference cannot go below ~6W per operation (5× more efficient than the human brain
  // at ~30W). Current GPU-class accelerators draw ~700W, so the maximum compound
  // efficiency gain across all axes is bounded by 700W / 6W ≈ 117×.
  const rawEfficiencyGain = (1 / Math.max(eff.M_inference, EPSILON)) * eff.S_inference * eff.H * eff.H_memory;
  const CURRENT_GPU_WATTS = 700;
  const THERMODYNAMIC_FLOOR_WATTS = 6;
  const MAX_EFFICIENCY_GAIN = CURRENT_GPU_WATTS / THERMODYNAMIC_FLOOR_WATTS;
  const efficiencyGain = Math.min(rawEfficiencyGain, MAX_EFFICIENCY_GAIN);

  // Per-segment GPU demand (with demandScale applied to token volumes)
  const consumerTokens = (inferenceDemand.consumer || 0) * demandScale;
  const enterpriseTokens = (inferenceDemand.enterprise || 0) * demandScale;
  const agenticTokens = (inferenceDemand.agentic || 0) * demandScale;

  const consumerGpus = consumerTokens / Math.max(consumerTokPerSec * secondsPerMonth * efficiencyGain, EPSILON);
  const enterpriseGpus = enterpriseTokens / Math.max(enterpriseTokPerSec * secondsPerMonth * efficiencyGain, EPSILON);
  const agenticGpus = agenticTokens / Math.max(agenticTokPerSec * secondsPerMonth * efficiencyGain, EPSILON);

  const requiredInference = consumerGpus + enterpriseGpus + agenticGpus;

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
  const denomTraining = hoursPerMonth * utilTrn * eff.S_training * eff.H;
  // Cap training efficiency the same way: M_training decays (numerator) while S*H grows
  // (denominator), so the effective reduction factor = M / (S*H). Floor it at 1/MAX.
  const rawTrainingFactor = eff.M_training / Math.max(denomTraining, EPSILON);
  const minTrainingFactor = 1 / (hoursPerMonth * utilTrn * MAX_EFFICIENCY_GAIN);
  const requiredTraining = totalTrainingHours * Math.max(rawTrainingFactor, minTrainingFactor);

  return {
    requiredTotal: requiredInference + requiredTraining,
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
  map['dram_server'] = resolveAssumptionValue(gpuToComp.serverDramGbPerGpu?.value, 128);
  map['ssd_datacenter'] = 2;  // TB per GPU

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
  map['dc_construction'] = mwPerGpu * 400;   // ~400 worker-months per MW
  map['dc_ops_staff'] = mwPerGpu * 8;        // ~8 FTEs per MW

  // Downstream deployable nodes with GPU parents: explicitly set per-GPU intensities.
  // These were previously auto-mapped by a "fill gaps" loop, but that loop also pulled in
  // upstream capital equipment (euv_tools) whose inputIntensity is per-wafer, not per-GPU,
  // creating a false ~180K GPU/month hard ceiling.
  map['liquid_cooling'] = resolveAssumptionValue(NODE_MAP.get('liquid_cooling')?.inputIntensity, 0.05);
  map['osat_test'] = resolveAssumptionValue(NODE_MAP.get('osat_test')?.inputIntensity, 1);
  map['rack_pdu'] = resolveAssumptionValue(NODE_MAP.get('rack_pdu')?.inputIntensity, 0.025);
  map['cpu_server'] = resolveAssumptionValue(NODE_MAP.get('cpu_server')?.inputIntensity, 0.25);
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
    warnings: []
  };

  const nodeIntensityMap = buildIntensityMap();
  runPreflightDiagnostics(nodeIntensityMap, results.warnings);

  const warnedSet = new Set();
  const effCache = [];

  const demandAssumptions = deepMerge(assumptions?.demand || DEMAND_ASSUMPTIONS, scenarioOverrides?.demand);
  const efficiencyAssumptions = deepMerge(assumptions?.efficiency || EFFICIENCY_ASSUMPTIONS, scenarioOverrides?.efficiency);
  const supplyAssumptions = deepMerge(assumptions?.supply || SUPPLY_ASSUMPTIONS, scenarioOverrides?.supplyAssumptions);

  // Precompute demand trajectories (block-chained, no discontinuities)
  const demandTrajectories = precomputeDemandTrajectories(months, demandAssumptions);

  // Demand-responsive organic growth: running multiplier per node.
  // Only compounds when node tightness > 1 (demand exceeds supply).
  // Prevents perpetual capacity growth when there's no shortage pressure.
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

  // Realistic 2026 installed base: ~5M datacenter GPUs, ~1.5M inference accelerators
  const defaultDcInstalled = 5000000;
  const defaultInfInstalled = 1500000;

  // Default starting backlogs for base case: reflects current massive shortage
  // NVIDIA 6-12 month wait lists; every hyperscaler capacity-constrained
  // GPU backlog ~4M units, components scaled by their per-GPU intensity
  const DEFAULT_STARTING_BACKLOGS = {
    gpu_datacenter: 4000000,
    hbm_stacks: 32000000,    // 8 stacks/GPU * 4M
    cowos_capacity: 1200000,  // 0.3 wafer-equiv/GPU * 4M
    advanced_wafers: 1200000, // 0.3 wafers/GPU * 4M
    dram_server: 512000000,   // 128 GB/GPU * 4M
    ssd_datacenter: 8000000,  // 2 TB/GPU * 4M
    server_assembly: 500000,  // (1/8 server/GPU) * 4M
    datacenter_mw: 5200       // 0.0013 MW/GPU * 4M
  };

  const dcInstalledOverride = startOverrides.datacenterInstalledBase ?? startOverrides.installedBaseDatacenter ?? startOverrides.installedBase;
  const infInstalledOverride = startOverrides.inferenceInstalledBase ?? startOverrides.installedBaseInference;

  for (const node of NODES) {
    const type = getNodeType(node.id);

    let installedBase = 0;
    if (node.id === 'gpu_datacenter') installedBase = (dcInstalledOverride !== undefined) ? dcInstalledOverride : defaultDcInstalled;
    if (node.id === 'gpu_inference') installedBase = (infInstalledOverride !== undefined) ? infInstalledOverride : defaultInfInstalled;

    const overrideBacklog = startOverrides.backlogByNode?.[node.id];
    const initialBacklog = (overrideBacklog !== undefined) ? overrideBacklog : (DEFAULT_STARTING_BACKLOGS[node.id] ?? node.startingBacklog ?? 0);

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
    targetRatio: scenarioOverrides?.calibration?.targetRatio ?? 1.50,
    minScale: scenarioOverrides?.calibration?.minScale ?? 0.02,
    maxScale: scenarioOverrides?.calibration?.maxScale ?? 50
  };

  let demandScale = scenarioOverrides?.calibration?.demandScale ?? null;

  // Helper: compound organic growth for a node, scaled by demand pressure (tightness).
  // Growth is demand-driven (shortage × elasticity) and uncapped by default.
  // Nodes with real parallelism bottlenecks (labor, permitting, materials) define
  // maxAnnualExpansion to encode the actual constraint. Lead time only governs
  // *when* new capacity arrives, not *how much* can be started in parallel.
  const compoundOrganicGrowth = (nodeId, month, tightness) => {
    const cat = SUPPLY_CATEGORY_MAP[nodeId];
    if (!cat) return;
    const blockKey = getBlockKeyForMonth(month);
    const block = supplyAssumptions?.[blockKey];
    const baseRate = resolveAssumptionValue(block?.expansionRates?.[cat]?.value, 0.15);

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

    runningSupplyMult[nodeId] *= Math.pow(1 + cappedRate, 1 / 12);
  };

  for (let month = 0; month < months; month++) {
    results.months.push(month);

    // Update hybrid bonding intensity with month-dependent adoption curve
    // S-curve: starts at initial share (~2%), ramps toward target (~25%) with halflife of 36 months
    const hbShare = hbAdoptionTarget - (hbAdoptionTarget - hbAdoptionInitial) * Math.pow(2, -month / Math.max(hbAdoptionHalflife, 1));
    nodeIntensityMap['hybrid_bonding'] = hbIntensityBase * hbShare;

    const demandBlock = getDemandBlockForMonth(month, demandAssumptions);

    const currentInstalled = (nodeState['gpu_datacenter']?.installedBase || 0) + (nodeState['gpu_inference']?.installedBase || 0);

    if (month === 0 && (demandScale === null || demandScale === undefined)) {
      const raw = computeRequiredGpus(0, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, 1);
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

    const req = computeRequiredGpus(month, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed);

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
      const ratio = Math.max(futureReq.requiredTotal / req.requiredTotal, 1);
      demandForecastCache[lookAheadMonths] = ratio;
      return ratio;
    };

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

    // 1. Calculate natural decay (what dies this month)
    const dcRetirements = gpuState.installedBase / 48;
    const infRetirements = infState.installedBase / 48;

    // 2. Calculate "Do Nothing" outcome (Projected Remaining Fleet)
    //    If we buy 0 GPUs, this is what we will have left.
    const dcProjectedRemaining = Math.max(0, gpuState.installedBase - dcRetirements);
    const infProjectedRemaining = Math.max(0, infState.installedBase - infRetirements);

    // 3. Smart Ordering Logic
    //    Only buy if Required > Projected.
    //    If Required < Projected, this returns 0 (orders stop, fleet shrinks).
    const planDeployDc = Math.max(0, (requiredDcBase - dcProjectedRemaining) / CATCHUP_MONTHS);
    const planDeployInf = Math.max(0, (requiredInfBase - infProjectedRemaining) / CATCHUP_MONTHS);

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

    // =======================================================
    // STEP 2: GATING
    // =======================================================
    const gpuNode = NODE_MAP.get('gpu_datacenter');
    const gpuSMult = runningSupplyMult['gpu_datacenter'] || 1;
    const gpuCap = calculateCapacity(gpuNode, month, scenarioOverrides, gpuState.dynamicExpansions, gpuSMult);
    const gpuYield = calculateNodeYield(gpuNode, month);
    const gpuEffCap = gpuCap * 0.95 * gpuYield;

    const gpuAvailable = gpuState.inventory + gpuEffCap;
    const preUpdateGpuInventory = gpuState.inventory;

    let maxSupported = Infinity;
    let constraintCount = 0;

    // Substitution pooling: nodes that deliver the same resource (e.g., MW to
    // datacenters) have their potentials summed before gating. This lets
    // off-grid power absorb demand when the grid interconnect queue is full.
    const pooledPotentials = {};
    for (const [nodeId, intensity] of Object.entries(nodeIntensityMap)) {
      const potential = potentials[nodeId];
      if (potential === undefined || intensity <= 0) continue;
      const pool = SUBSTITUTION_POOLS[nodeId];
      if (pool) {
        if (!pooledPotentials[pool]) pooledPotentials[pool] = { potential: 0, intensity };
        pooledPotentials[pool].potential += potential;
      } else {
        const supported = potential / intensity;
        if (supported < maxSupported) maxSupported = supported;
        constraintCount++;
      }
    }
    for (const { potential, intensity } of Object.values(pooledPotentials)) {
      const supported = potential / intensity;
      if (supported < maxSupported) maxSupported = supported;
      constraintCount++;
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

    // Forward-looking capacity expansion for GPUs
    // Look ahead by GPU lead time, forecast demand using trajectories, trigger build if shortage projected
    gpuState.tightnessHistory.push(gpuTightness);

    // Organic growth: only compound when demand exceeds supply
    if (gpuTightness > 1.0) {
      compoundOrganicGrowth('gpu_datacenter', month, gpuTightness);
      compoundOrganicGrowth('gpu_inference', month, gpuTightness);
    }

    const gpuLeadTime = gpuNode.leadTimeDebottleneck || 6;
    const gpuCooldown = Math.max(Math.floor(gpuLeadTime / 2), 6);
    if ((month - gpuState.lastExpansionMonth) > gpuCooldown) {
      const gpuGrowthRatio = getDemandGrowthRatio(gpuLeadTime);
      const forecastGpuDemand = planDeployTotal * gpuGrowthRatio;
      const gpuFutureMonth = Math.min(month + gpuLeadTime, months - 1);
      const forecastGpuSMult = runningSupplyMult['gpu_datacenter'] || 1;
      const forecastGpuCap = calculateCapacity(gpuNode, gpuFutureMonth, scenarioOverrides, gpuState.dynamicExpansions, forecastGpuSMult);
      const forecastGpuEffCap = forecastGpuCap * 0.95 * calculateNodeYield(gpuNode, gpuFutureMonth);

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
      const intensity = nodeIntensityMap[node.id] || 0;

      const planDemand = planDeployTotal * intensity;
      const actualConsumption = actualDeployTotal * intensity;

      const sMult = runningSupplyMult[node.id] || 1;
      const cap = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions, sMult);
      const y = calculateNodeYield(node, month);
      const effCap = cap * (node.maxCapacityUtilization || 0.95) * y;

      const inventoryIn = state.inventory;
      const backlogIn = state.backlog;
      const backlogUrgency = backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS;

      const potentialSupply = (state.type === 'STOCK') ? (inventoryIn + effCap) : effCap;

      // Plan-driven fulfillment: production and delivery are driven by plan demand
      // (what was ordered), not actualConsumption (what downstream used). This
      // decouples supplier ramp-up from GPU gating — suppliers ship against orders
      // and build inventory, rather than idling when a different node is bottlenecked.
      let production = 0;
      let delivered = 0;

      if (state.type === 'STOCK') {
        const bufferTarget = planDemand * DEFAULT_BUFFER_MONTHS;
        const prodNeed = planDemand + backlogUrgency + Math.max(0, bufferTarget - inventoryIn);
        production = Math.min(effCap, prodNeed);
        const available = inventoryIn + production;
        delivered = Math.min(planDemand + backlogUrgency, available);
        state.inventory = available - delivered;
        if (state.inventory < -1e-6) state.inventory = 0;
      } else {
        // FLOW / THROUGHPUT / QUEUE — no inventory, deliver against plan + backlog
        delivered = Math.min(planDemand + backlogUrgency, effCap);
        state.inventory = 0;
      }

      // Backlog = previous backlog + new demand - total fulfilled (covers both new demand and paydown)
      const unmetPlanThisMonth = Math.max(0, planDemand - delivered);
      state.backlog = Math.max(0, backlogIn + planDemand - delivered);

      const totalLoad = planDemand + (backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS);
      const tightness = totalLoad / Math.max(potentialSupply, EPSILON);
      const priceIndex = calculatePriceIndex(tightness);

      // Forward-looking capacity expansion for components
      // Forecast demand at month + leadTime using demand trajectory growth ratio,
      // compare to projected capacity, trigger build if shortage projected
      state.tightnessHistory.push(tightness);

      // Organic growth: only compound when demand exceeds supply for this node
      if (tightness > 1.0) compoundOrganicGrowth(node.id, month, tightness);

      const compLeadTime = node.leadTimeDebottleneck || 12;
      const compCooldown = Math.max(Math.floor(compLeadTime / 2), 6);
      if ((month - state.lastExpansionMonth) > compCooldown) {
        const growthRatio = getDemandGrowthRatio(compLeadTime);
        const forecastDemand = planDemand * growthRatio;
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
          state.dynamicExpansions.push({
            month: month + compLeadTime,
            capacityAdd: Math.max(expansionAmount, cap * 0.05)
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
        nodeRes.unmetDemand.push(unmetPlanThisMonth);

        nodeRes.shortage.push(isShort ? 1 : 0);
        nodeRes.glut.push(isGlut ? (isHardGlut ? 2 : 1) : 0);

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
