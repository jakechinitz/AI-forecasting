/**
 * AI Infrastructure Supply Chain - Calculation Engine
 *
 * Monthly simulation (Jan of the year after FLEET_ANCHOR, 20 years):
 *  1. DEMAND: token and training trajectories → required compute in effective
 *     units (month-0 frontier accelerators). Software efficiency (1/M × S)
 *     applies to the whole fleet; hardware (H × H_memory) only to new vintages.
 *     Month 0 is calibrated so required = targetRatio × installed.
 *     Demand responds to scarcity worse than the opening baseline (price
 *     rationing, decay of unserved demand, optional capability feedback).
 *  2. SUPPLY: each component's capacity grows with its own demand signal
 *     (shortage × elasticity, lead-time forecasts), bounded by shared physical
 *     pools (EUV wafers, DRAM, industry output of power/transformers/labor) and
 *     the few genuine physical growth limits (EUV tools, power generation).
 *  3. CONSTRUCTION: developers start shells to cover expected need at
 *     completion, paced by crews and the budget; projects complete on time or
 *     slip (FACILITY_PIPELINE) and join a stock of empty shells.
 *  4. PROCUREMENT: buyers order chips for scheduled energization plus a
 *     precautionary stock, limited by accelerator and component supply and
 *     funding (construction under way is paid first).
 *  5. ENERGIZATION = min(plan, chips in hand, empty shells, power hookups and
 *     other infrastructure). Bought-but-unplugged chips wait as stranded stock.
 *  6. SPEND & FINANCE: costs.js prices every input (volume × unit price);
 *     financing.js turns the year's unit economics and capital markets into
 *     fundable capex (the budget) and runs the tier waterfalls.
 */

import { NODES } from '../data/nodes.js';
import { createFinancingModel, scarcityPremium } from './financing.js';
import { createCostModel } from './costs.js';
import {
  GLOBAL_PARAMS,
  FLEET_ANCHOR,
  FINANCING_ASSUMPTIONS,
  FINANCING_ASSUMPTIONS_BASE,
  SHARED_SUPPLY_POOLS,
  DEMAND_ASSUMPTIONS,
  EFFICIENCY_ASSUMPTIONS,
  SUPPLY_ASSUMPTIONS,
  BUILD_ASSUMPTIONS,
  COST_ASSUMPTIONS,
  COST_ASSUMPTIONS_BASE,
  TRANSLATION_INTENSITIES,
  getBlockKeyForMonth,
  blendBlockValue,
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
  utilizationTraining: 0.85,
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
 * Maps supply chain nodes to supply assumption categories. Nodes in this map
 * get demand-driven organic growth (plus any baseline rate in
 * SUPPLY_ASSUMPTIONS.expansionRates, which is 0 by default). Nodes NOT in this
 * map rely on committed + dynamic expansions only.
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

/**
 * Nodes that report demand and tightness but never gate deployments:
 *  - hybrid_bonding: when bonding is short, designs fall back to CoWoS-only
 *    packaging, which every accelerator already needs.
 *  - euv_tools: scanners are long-lived capital tools, not a per-accelerator
 *    consumable. The installed base sets the leading-edge wafer ceiling (see
 *    SHARED_SUPPLY_POOLS.leadingEdge), so EUV limits wafer supply, not each
 *    month's accelerator output directly.
 * They are also left out of the bottleneck ranking.
 */
const NON_GATING_NODES = new Set(['hybrid_bonding', 'euv_tools']);

/**
 * Where each node binds in the three-stage build:
 *  - chip side: consumed when accelerators are BOUGHT (per accelerator)
 *  - energization side: needed when bought chips are plugged in (per kW IT,
 *    except liquid cooling, per accelerator)
 *  - datacenter_mw is the construction pipeline's shells; dc_construction is
 *    the crews that build them.
 */
const CHIP_SIDE_NODES = new Set([
  'hbm_stacks', 'dram_server', 'ssd_datacenter', 'cowos_capacity', 'abf_substrate',
  'osat_test', 'advanced_wafers', 'cpu_server', 'dpu_nic', 'switch_asics',
  'optical_transceivers', 'infiniband_cables', 'server_assembly', 'rack_pdu'
]);
const ENERGIZE_SIDE_NODES = new Set([
  'grid_interconnect', 'off_grid_power', 'power_generation', 'transformers_lpt',
  'backup_power', 'dc_ops_staff', 'liquid_cooling'
]);

const POWER_HOOKUP_LABEL = 'Power hookups (grid + on-site)';

const EXPECTED_UNITS = {
  'hbm_stacks': 'stacks/month',
  'datacenter_mw': 'MW/month',
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
// floor of 0.5 W (= 60× more efficient than the 30 W human brain, see
// GLOBAL_PARAMS.brainEquivalency). Beyond the knee, improvements continue but at a
// dramatically slower pace — engineering diminishing returns, not a hard wall.
export const CURRENT_GPU_WATTS = 700;
export const THERMODYNAMIC_FLOOR_WATTS = 0.5;
export const MAX_EFFICIENCY_GAIN = CURRENT_GPU_WATTS / THERMODYNAMIC_FLOOR_WATTS;  // 1400×

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
const DEFAULT_CALIBRATION_RATIO = 1.5;
const CATCHUP_MONTHS = 6;
const DEFAULT_BUFFER_MONTHS = 2;

// Inventory management: manufacturers limit carrying inventory to avoid
// capital lockup and carrying costs. CEILING_MONTHS caps inventory at N
// months of consumption; CONSUMPTION_HEADROOM lets producers build ahead
// of current consumption for growth readiness (1.5 = up to 50% headroom).
const INVENTORY_CEILING_MONTHS = 4;
const CONSUMPTION_HEADROOM = 1.5;

// Component order backlogs are paid down over this many months
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

// Finite number from a raw input ({ value } objects and numeric strings ok)
function numOr(raw, fallback) {
  const v = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

// Cost overrides are keyed by input id: { <id>: { price, change: {...} } }
function mergeCostOverrides(costCfg, overrides) {
  if (!overrides || typeof overrides !== 'object') return costCfg;
  return { ...costCfg, inputs: (costCfg?.inputs || []).map((i) => deepMerge(i, overrides[i.id])) };
}

// Calendar year of a model month, and a lookup into a year-keyed schedule
// ([{ until: <year>, <key>: value }, ...]; the first entry whose `until` is
// ≥ the year applies, and the last entry holds after that).
function calendarYearOf(month) {
  return GLOBAL_PARAMS.startYear + Math.floor(((GLOBAL_PARAMS.startMonth || 1) - 1 + month) / 12);
}

function scheduleValue(schedule, month, key, fallback) {
  if (!Array.isArray(schedule) || !schedule.length) return fallback;
  const year = calendarYearOf(month);
  for (const step of schedule) if (year <= step.until) return step[key];
  return schedule[schedule.length - 1][key];
}

function mostCommon(labels) {
  const counts = {};
  labels.forEach((l) => { counts[l] = (counts[l] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '-';
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

function getDemandBlockForMonth(month, assumptions) {
  return demandBlockByKey(getBlockKeyForMonth(month), assumptions);
}

function demandBlockByKey(blockKey, assumptions) {
  return assumptions?.[blockKey] || DEMAND_ASSUMPTIONS?.[blockKey] || DEMAND_ASSUMPTIONS?.base || {};
}

// A demand-block field blended across block edges (see getBlockWeightsForMonth)
function demandValueAt(month, assumptions, pick) {
  return blendBlockValue(month, (key) => pick(demandBlockByKey(key, assumptions)));
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

/**
 * Scenario scaling: scale the CURRENT assumptions instead of hard-coding
 * values, so scenarios stay relative to base when base changes.
 *   tokenGrowth / trainingGrowth: multiply each segment's annual growth
 *     MULTIPLE (1 + g) by factor, in the listed blocks (default: all).
 *   softwareEfficiency: multiply m_* and s_* rates by factor (all blocks).
 *   hardwareEfficiency: multiply h and h_memory rates by factor (all blocks).
 */
function scaleBlockValues(blocks, spec, fields, transform) {
  if (!spec || !Number.isFinite(spec.factor)) return blocks;
  const out = { ...blocks };
  for (const key of spec.blocks || Object.keys(blocks)) {
    const block = blocks[key];
    if (!block) continue;
    const next = { ...block };
    for (const [group, names] of fields) {
      if (!block[group]) continue;
      next[group] = { ...block[group] };
      for (const name of names) {
        if (block[group][name] === undefined) continue;
        next[group][name] = transform(resolveGrowthRate(block[group][name], 0), spec.factor, name);
      }
    }
    out[key] = next;
  }
  return out;
}

function applyScenarioScaling(demand, efficiency, scaling) {
  if (!scaling) return { demand, efficiency };
  const multiple = (g, f) => Math.max(-0.95, (1 + g) * f - 1);
  let d = scaleBlockValues(demand, scaling.tokenGrowth, [['inferenceGrowth', ['consumer', 'enterprise', 'agentic']]], multiple);
  d = scaleBlockValues(d, scaling.trainingGrowth, [['trainingGrowth', ['frontier', 'midtier']]], multiple);
  const rate = (r, f, name) => (name.startsWith('m_') ? clamp(r * f, 0, 0.9) : Math.max(0, r * f));
  let e = scaleBlockValues(efficiency, scaling.softwareEfficiency,
    [['modelEfficiency', ['m_inference', 'm_training']], ['systemsEfficiency', ['s_inference', 's_training']]], rate);
  e = scaleBlockValues(e, scaling.hardwareEfficiency, [['hardwareEfficiency', ['h', 'h_memory']]], rate);
  return { demand: d, efficiency: e };
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
      const annualGrowth = demandValueAt(m, demandAssumptions, (b) => resolveGrowthRate(b?.inferenceGrowth?.[seg], 0));
      // intensityGrowth: reasoning chains, tool use, and agent loops increase
      // compute per request over time (more tokens per inference call)
      const intensityAnnual = demandValueAt(m, demandAssumptions, (b) => resolveGrowthRate(b?.intensityGrowth, 0));
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
      const annualGrowth = demandValueAt(m, demandAssumptions, (b) => resolveGrowthRate(b?.trainingGrowth?.[seg], 0));
      const monthlyFactor = Math.pow(1 + annualGrowth, 1 / 12);
      arr[m] = arr[m - 1] * monthlyFactor;
    }
    training[seg] = arr;
  }

  return { inference, training };
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

/**
 * Maximum annual capacity expansion for a node in a given month.
 * Nodes may define maxAnnualExpansionSchedule: [{ until: <calendar year>, cap }, ...]
 * (first entry whose `until` ≥ the month's year applies; the last entry holds
 * after that), or a flat maxAnnualExpansion. Returns null when uncapped.
 */
export function getMaxExpansion(node, month) {
  return scheduleValue(node?.maxAnnualExpansionSchedule, month, 'cap', node?.maxAnnualExpansion ?? null);
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
  // ?? not ||: a loss of 0 (intensities already net of yield) must stay 0
  return calculateSimpleYield(node.yieldSimpleLoss ?? 0.03);
}

// Effective monthly output of a node: capacity × max utilization × yield
function effectiveCapacity(node, month, capacity) {
  return capacity * (node?.maxCapacityUtilization ?? 0.95) * calculateNodeYield(node, month);
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
  // Rates blended across block edges (see getBlockWeightsForMonth)
  const blockOf = (key) => assumptions?.[key] || EFFICIENCY_ASSUMPTIONS?.[key] || EFFICIENCY_ASSUMPTIONS?.base || {};
  const rate = (pick, fallback) => blendBlockValue(month, (key) => resolveGrowthRate(pick(blockOf(key)), fallback));

  // Handle both { value: number } objects and plain numbers (from scenario overrides)
  const mInfAnnual = rate((b) => b?.modelEfficiency?.m_inference, 0.18);
  const mTrnAnnual = rate((b) => b?.modelEfficiency?.m_training, 0.10);

  const sInfAnnual = rate((b) => b?.systemsEfficiency?.s_inference, 0.10);
  const sTrnAnnual = rate((b) => b?.systemsEfficiency?.s_training, 0.08);

  const hAnnual = rate((b) => b?.hardwareEfficiency?.h, 0.15);
  const hMemAnnual = rate((b) => b?.hardwareEfficiency?.h_memory, 0.10);
  const kwAnnual = rate((b) => b?.hardwareEfficiency?.kw_growth, 0);

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
  // Soft efficiency ceiling: below 1400× (700 W / 0.5 W), gains are linear. Above the
  // knee, diminishing returns kick in — improvements continue at a logarithmic pace.
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

  // Edge offload: fraction of inference tokens served outside hyperscale
  // datacenters (phones, PCs, Macs, self-hosted small servers). These tokens need
  // no datacenter GPUs, CoWoS, HBM, DC power or cooling, but still draw shared
  // wafer and DRAM supply and use energy (see requiredEdge below and the edge
  // block in runSimulation). Shares are set per segment and per time block; the
  // total is capped at TRANSLATION_INTENSITIES.edge.maxShareOfInference.
  const edgeShareOf = (seg) => clamp(demandValueAt(month, demandAssumptions, (b) => resolveGrowthRate(b?.edgeOffload?.[seg], 0)), 0, 1);
  const edgeConsumerRaw = edgeShareOf('consumer');
  const edgeEnterpriseRaw = edgeShareOf('enterprise');
  const edgeAgenticRaw = edgeShareOf('agentic');

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

  // Edge work in the same datacenter-equivalent effective units. It does not
  // need datacenter capacity, but it draws on shared silicon supply (wafers,
  // DRAM) and uses energy.
  const requiredEdge =
    (consumerTokensTotal * edgeConsumer) / Math.max(consumerTokPerSec * secondsPerMonth * efficiencyGain, EPSILON)
    + (enterpriseTokensTotal * edgeEnterprise) / Math.max(enterpriseTokPerSec * secondsPerMonth * efficiencyGain, EPSILON)
    + (agenticTokensTotal * edgeAgentic) / Math.max(agenticTokPerSec * secondsPerMonth * efficiencyGain, EPSILON);

  // ==========================================================
  // TRAINING: accelerator-hours model (training IS compute-limited)
  // ==========================================================
  const hoursFrontier = demandValueAt(month, demandAssumptions, (b) => resolveAssumptionValue(b?.workloadBase?.trainingComputePerRun?.frontier, 50e6));
  const hoursMidtier = demandValueAt(month, demandAssumptions, (b) => resolveAssumptionValue(b?.workloadBase?.trainingComputePerRun?.midtier, 200000));

  const frontierRuns = (trainingDemand.frontier || 0) * demandScale;
  const midtierRuns = (trainingDemand.midtier || 0) * demandScale;

  const utilTrn = computeCfg.gpuUtilization?.training ?? PHYSICS_DEFAULTS.utilizationTraining;
  const hoursPerMonth = PHYSICS_DEFAULTS.hoursPerMonth;

  const totalTrainingHours = (frontierRuns * hoursFrontier) + (midtierRuns * hoursMidtier);
  // Soft cap training efficiency: compute raw gain = (S*H) / M, apply soft knee.
  // Hardware is credited through the vintage-tracked fleet. There is one fleet
  // index (H × H_memory) for all work, so training also gets memory-bandwidth
  // gains (large-scale training is partly bandwidth-bound too). Only the
  // software part reduces required effective units.
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

/**
 * Per-accelerator intensity of every gating node, at the opening fleet's kW
 * per accelerator (infrastructure intensities are scaled monthly by kwIndex).
 * Chip and infrastructure intensities come from TRANSLATION_INTENSITIES; the
 * remaining downstream nodes use their own node.inputIntensity.
 */
export function buildIntensityMap() {
  const map = {};
  const gpuToComp = TRANSLATION_INTENSITIES?.gpuToComponents || {};
  const serverToInfra = TRANSLATION_INTENSITIES?.serverToInfra || {};

  const kwPerGpu = resolveAssumptionValue(serverToInfra.kwPerGpu?.value, FLEET_ANCHOR.kwPerAccelerator || 1.4);
  const pue = resolveAssumptionValue(serverToInfra.pue?.value, 1.3);
  const mwPerGpu = (kwPerGpu * pue) / 1000;

  map['hbm_stacks'] = resolveAssumptionValue(gpuToComp.hbmStacksPerGpu?.value, 7);
  map['datacenter_mw'] = mwPerGpu;

  map['advanced_wafers'] = resolveAssumptionValue(gpuToComp.advancedWafersPerGpu?.value, 0.06);
  map['abf_substrate'] = resolveAssumptionValue(NODE_MAP.get('abf_substrate')?.inputIntensity, 0.02);

  map['cowos_capacity'] = resolveAssumptionValue(gpuToComp.cowosWaferEquivPerGpu?.value, 0.075);
  map['dram_server'] = resolveAssumptionValue(gpuToComp.serverDramGbPerGpu?.value, 256);
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
  const transformersPerMw = resolveAssumptionValue(powerChain.transformersPerMw?.value, 0.025);
  const redundancyFactor = resolveAssumptionValue(powerChain.redundancyFactor?.value, 1.5);

  map['transformers_lpt'] = mwPerGpu * transformersPerMw;
  map['power_generation'] = mwPerGpu;
  map['backup_power'] = mwPerGpu * redundancyFactor;
  const workerMonthsPerMw = resolveAssumptionValue(serverToInfra.workerMonthsPerMw?.value, 100);
  const ftesPerMw = resolveAssumptionValue(serverToInfra.ftesPerMw?.value, 1.0);
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

  // EUV tools are capital equipment, not a per-accelerator input: their demand
  // (tools needed to keep the leading-edge wafer ceiling ahead of AI wafer
  // demand) is computed in the simulation loop. See NON_GATING_NODES.

  return map;
}

function runPreflightDiagnostics(map, warnings) {
  let errCount = 0;

  const gpuNode = NODE_MAP.get('gpu_datacenter');
  const gpuStartCap = gpuNode?.startingCapacity || 1;

  for (const node of NODES) {
    const isEligible = node.group !== 'A' && !['gpu_datacenter', 'gpu_inference'].includes(node.id) && !NON_GATING_NODES.has(node.id);
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
    summary: { shortages: [], gluts: [], bottlenecks: [], binding: [] },
    warnings: []
  };

  const nodeIntensityMap = buildIntensityMap();
  runPreflightDiagnostics(nodeIntensityMap, results.warnings);

  const warnedSet = new Set();
  const effCache = [];

  const { demand: demandAssumptions, efficiency: efficiencyAssumptions } = applyScenarioScaling(
    deepMerge(assumptions?.demand || DEMAND_ASSUMPTIONS, scenarioOverrides?.demand),
    deepMerge(assumptions?.efficiency || EFFICIENCY_ASSUMPTIONS, scenarioOverrides?.efficiency),
    scenarioOverrides?.scaling
  );
  const supplyAssumptions = deepMerge(assumptions?.supply || SUPPLY_ASSUMPTIONS, scenarioOverrides?.supplyAssumptions);
  const financingAssumptions = deepMerge(assumptions?.financing || FINANCING_ASSUMPTIONS, scenarioOverrides?.financing);
  const buildAssumptions = deepMerge(assumptions?.build || BUILD_ASSUMPTIONS, scenarioOverrides?.build);
  const costAssumptions = mergeCostOverrides(assumptions?.costs || COST_ASSUMPTIONS, scenarioOverrides?.costs);

  // Precompute demand trajectories (block-chained, no discontinuities)
  const demandTrajectories = precomputeDemandTrajectories(months, demandAssumptions);

  // Organic supply growth: running multiplier per node. Growth is demand-driven
  // (shortage × elasticity); SUPPLY_ASSUMPTIONS.expansionRates adds baseline
  // growth on top (0 by default) and pauses in a glut. See compoundOrganicGrowth.
  const runningSupplyMult = {};
  for (const node of NODES) {
    if (node.group !== 'A') runningSupplyMult[node.id] = 1.0;
  }

  // Glut thresholds
  const glutThresholds = GLOBAL_PARAMS.glutThresholds || { soft: 0.95, hard: 0.80 };

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

  // The opening shortage is the calibrated gap (required = targetRatio ×
  // installed at month 0), which the plan works off. There is no separate
  // accelerator order backlog on top: that counted the same unmet demand twice.
  // Component order backlogs start at node.startingBacklog (0 by default) and
  // can be set per node via startingState.backlogByNode.

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

    const isAccelerator = node.id === 'gpu_datacenter' || node.id === 'gpu_inference';
    const overrideBacklog = startOverrides.backlogByNode?.[node.id];
    const initialBacklog = isAccelerator ? 0 : (overrideBacklog ?? node.startingBacklog ?? 0);

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
    // Month-0 required ÷ installed (effective units). 1.5: every hyperscaler
    // reports being capacity-constrained through 2026 (rising GPU rental
    // prices, the 2026 memory crunch), and ~20 GW IT is being energized in
    // 2026. A ratio near 1.15 (the Excel's implied 2026 level) would make
    // 2026 demand-bound at ~12 GW, contradicting that evidence.
    // Scenarios can deepen or ease the opening shortage with this ratio.
    targetRatio: scenarioOverrides?.calibration?.targetRatio ?? DEFAULT_CALIBRATION_RATIO,
    minScale: scenarioOverrides?.calibration?.minScale ?? 0.02,
    maxScale: scenarioOverrides?.calibration?.maxScale ?? 50
  };

  let demandScale = scenarioOverrides?.calibration?.demandScale ?? null;

  // Helper: compound organic growth for a node, scaled by demand pressure (tightness).
  // Growth is demand-driven (shortage × elasticity) and uncapped by default.
  // Limits come from physics, not growth caps:
  //  - shared pools (EUV wafers, DRAM, industry output of power, transformers
  //    and construction labor) cap what the node can deliver; while a pool is
  //    the binding ceiling the node stops adding capacity it could not use;
  //  - only genuine physical ramp limits define maxAnnualExpansion(Schedule)
  //    (EUV tool output, power generation).
  // Lead time only governs *when* new capacity arrives.
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
    const node = NODE_MAP.get(nodeId);
    // Sold-out upstream capital goods (e.g., EUV scanners) expand at their
    // physical maximum: every tool made is bought, so output follows the
    // producer's capacity build, not AI demand in a given month.
    if (node?.growsAtPhysicalMax) {
      const maxRate = getMaxExpansion(node, month) ?? 0;
      runningSupplyMult[nodeId] *= Math.pow(1 + maxRate, 1 / 12);
      return;
    }
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

    // In a glut, organic base expansion pauses — otherwise capacity keeps
    // compounding until utilization hits the gate (~1.5× overcapacity),
    // making glut a guaranteed end state for every node.
    const baseRate = tightness < glutThresholds.soft
      ? 0
      : blendBlockValue(month, (key) => resolveGrowthRate(supplyAssumptions?.[key]?.expansionRates?.[cat], 0));

    // Scale growth by how severe the shortage is, using the node's long-run elasticity
    const elasticity = node?.elasticityLong ?? 0.5;
    const shortageMagnitude = Math.max(0, tightness - 1.0);
    const dynamicRate = baseRate + (shortageMagnitude * elasticity * 2.0);

    // Physical ramp limit, only where the node defines one (e.g. power generation)
    const maxExp = getMaxExpansion(node, month);
    const cappedRate = maxExp != null
      ? Math.min(dynamicRate, maxExp)
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
  const financing = createFinancingModel(financingAssumptions, {
    startYear: GLOBAL_PARAMS.startYear,
    pue,
    defaults: FINANCING_ASSUMPTIONS_BASE
  });
  // Same (sanitized) compute life drives retirements and depreciation
  const computeLifeMonths = Math.round(financing.scalars.computeLifeYears * 12);
  const startMonthIndex = (GLOBAL_PARAMS.startMonth || 1) - 1;
  const idleShare = financing.scalars.idlePowerShare;

  // Memory content per accelerator (compounded annual growth by time block)
  const memGrowthCfg = TRANSLATION_INTENSITIES?.gpuToComponents?.memoryContentGrowth || {};
  const contentIndex = (sched) => {
    const arr = new Float64Array(months);
    arr[0] = 1;
    for (let m = 1; m < months; m++) arr[m] = arr[m - 1] * Math.pow(1 + blendBlockValue(m, (key) => numOr(sched?.[key], 0)), 1 / 12);
    return arr;
  };
  const hbmContentIndex = contentIndex(memGrowthCfg.hbmGb);
  const hostDramContentIndex = contentIndex(memGrowthCfg.hostDramGb);

  // --- cost model: dollars per input ---
  const costs = createCostModel(costAssumptions, { months, rateAt: blendBlockValue, defaults: COST_ASSUMPTIONS_BASE });
  const lastPriceIndex = {};
  const priceIndexOf = (nodeId) => lastPriceIndex[nodeId] ?? 1;

  // --- build pipeline, procurement and demand response ---
  const pipeCfg = buildAssumptions.pipeline || {};
  const procCfg = buildAssumptions.procurement || {};
  const drCfg = buildAssumptions.demandResponse || {};
  const Tc = Math.max(1, Math.round(numOr(pipeCfg.constructionMonths, 18)));
  const slipMean = Math.max(0, numOr(pipeCfg.slipMonthsMean, 9));
  const onTimeShareAt = (m) => clamp(scheduleValue(pipeCfg.onTimeShareSchedule, Math.max(0, m), 'share', 0.72), 0, 1);
  const permitLag = Math.max(0, Math.round(numOr(pipeCfg.permitLagMonths, 6)));
  const startSmoothing = Math.max(1, numOr(pipeCfg.startSmoothingMonths, 12));
  const openingStarts = Math.max(0, numOr(pipeCfg.openingStartsMWPerMonth, 0));
  const procLead = Math.max(0, Math.round(numOr(procCfg.procurementLeadMonths, 3)));
  const hoardMonths = Math.max(0, numOr(procCfg.hoardMonths, 2));
  const invAdjustMonths = Math.max(1, numOr(procCfg.inventoryAdjustMonths, 6));
  const priceElasticity = Math.max(0, numOr(drCfg.priceElasticity, 0.5));
  const unservedHalfLife = Math.max(0.1, numOr(drCfg.unservedHalfLifeMonths, 6));
  const unservedDecay = 1 - Math.pow(0.5, 1 / unservedHalfLife);
  const capabilityFeedback = Math.max(0, numOr(drCfg.capabilityFeedback, 0));

  // Per-kW (IT) intensity of energization-side infrastructure: the intensity
  // map is per accelerator at the opening kW, so divide by that kW.
  const perKw = (id) => (nodeIntensityMap[id] || 0) / kw0;
  const workerMonthsPerMw = resolveAssumptionValue(TRANSLATION_INTENSITIES?.serverToInfra?.workerMonthsPerMw?.value, 100);
  const transformersPerMwFacility = resolveAssumptionValue(TRANSLATION_INTENSITIES?.powerChain?.transformersPerMw?.value, 0.025);
  const backupMwPerMwFacility = resolveAssumptionValue(TRANSLATION_INTENSITIES?.powerChain?.redundancyFactor?.value, 1.5);
  const ftesPerMw = resolveAssumptionValue(TRANSLATION_INTENSITIES?.serverToInfra?.ftesPerMw?.value, 1.0);

  // Construction pipeline: buckets of facility MW. `paid` counts months of
  // construction done (payments and labor happen then); `wait` is the slip
  // left after construction. A project splits at start into an on-time share
  // and four equal late shares (mean delay slipMonthsMean).
  const SLIP_POINTS = [0.25, 0.75, 1.25, 1.75];
  const buckets = [];
  const scheduledMW = new Array(months + Tc + 24).fill(0);
  const addProject = (mw, paid, schedMonth) => {
    if (!(mw > 0)) return;
    const p = onTimeShareAt(schedMonth);
    buckets.push({ mw: mw * p, paid, wait: 0 });
    SLIP_POINTS.forEach((f) => buckets.push({ mw: (mw * (1 - p)) / SLIP_POINTS.length, paid, wait: slipMean * f }));
    if (schedMonth >= 0 && schedMonth < scheduledMW.length) scheduledMW[schedMonth] += mw;
  };
  {
    // Opening pipeline: completions scheduled through the first construction
    // cycle, plus capacity that already slipped past its 2025 date.
    const firstYear = Math.max(0, numOr(pipeCfg.openingScheduledMW?.firstYear, 0));
    const nextHalf = Math.max(0, numOr(pipeCfg.openingScheduledMW?.nextHalfYear, 0));
    const tail = Math.max(1, Math.min(6, Tc - 12));
    for (let k = 0; k < Math.min(12, Tc); k++) addProject(firstYear / 12, Math.max(0, Tc - (k + 1)), k);
    for (let k = 12; k < 12 + tail; k++) addProject(nextHalf / tail, Math.max(0, Tc - (k + 1)), k);
    const slipped = Math.max(0, numOr(pipeCfg.openingSlippedMW, 0));
    [0.17, 0.5, 0.83, 1.17, 1.5, 1.83].forEach((f) => buckets.push({ mw: slipped / 6, paid: Tc, wait: Math.max(0.5, slipMean * f) }));
  }
  let readyShellsMW = Math.max(0, numOr(pipeCfg.openingReadyShellsMW, 0));
  let lastGridShare = 0.9;
  // Facility quantities per MW (IT × PUE) for the cost model
  const facilityCtx = (gridShare, kwNew) => ({
    gridShare,
    coolingUnitsPerMw: (nodeIntensityMap.liquid_cooling || 0) * (1000 / Math.max(kwNew * pue, EPSILON)),
    transformersPerMw: transformersPerMwFacility,
    backupMwPerMw: backupMwPerMwFacility
  });
  const desiredStartsQueue = [];
  // Developers react to funding conditions over a year, not a single month
  const fundingHistory = [];
  const chipSpendHistory = [];
  // Builders plan on next year's budget growing at least plannedBudgetGrowth
  // (their own capex plans), or at last year's realized rate if higher
  const plannedBudgetGrowth = clamp(numOr(pipeCfg.plannedBudgetGrowth, 0.15), 0, 0.5);
  let fundableGrowthExpected = plannedBudgetGrowth;
  let lastYearFundable = null;
  // Last month's memory need (accelerators ordered, edge DRAM) for the
  // memory pool's wafer split
  const memNeedPrev = { units: 0, edgeDram: 0 };
  // Chip supply capacity as builders see it (kW per month, last two years)
  const chipCapKWHistory = [];
  // Expected growth of that capacity: year-over-year growth averaged over
  // CHIP_GROWTH_SMOOTHING months, so lumpy fab/component additions do not
  // swing construction plans
  const CHIP_GROWTH_SMOOTHING = 24;
  let chipGrowthExpected = 0.2;   // starting view: ~20%/yr accelerator supply growth 2026-28
  // Empty-shell slack builders accept, in months of chip supply
  const maxVacancyMonths = Math.max(0, numOr(pipeCfg.maxVacancyMonths, 6));
  const fundingRatioTrailing = () => (fundingHistory.length ? fundingHistory.reduce((a, b) => a + b, 0) / fundingHistory.length : 1);

  // Buyer inventory: accelerators bought but not yet energized (stranded),
  // FIFO cohorts carrying the vintage they were bought at.
  const strandedCohorts = [];
  {
    const gw = Math.max(0, numOr(procCfg.openingStrandedGW, 0));
    if (gw > 0) {
      const phys = (gw * 1e6) / kw0;
      strandedCohorts.push({ month: -1, phys, eff: phys, kw: phys * kw0 });
    }
  }
  const strandedTotals = () => strandedCohorts.reduce((a, c) => ({ phys: a.phys + c.phys, eff: a.eff + c.eff, kw: a.kw + c.kw }), { phys: 0, eff: 0, kw: 0 });

  // Demand response state
  let latentFactor = 1;
  const baselineServed = 1 / Math.max(calibrationCfg.targetRatio, 1e-6);
  const premium0 = scarcityPremium(financing.scalars, Math.max(0, calibrationCfg.targetRatio - 1));
  let premiumNow = premium0;
  const scarcityWindow = [];

  results.fleet = {
    installedGW: [], requiredGW: [], deployedGW: [], retiredGW: [],
    binding: [], procurementBinding: [], installedAccelerators: [],
    fleetTokPerKwhM: [], frontierTokPerKwhM: [], kwPerNewAccelerator: [],
    trainingShare: [],
    // Build pipeline and procurement
    purchasedGW: [], strandedGW: [], readyShellsGW: [], underConstructionGW: [],
    completionsGW: [], startsGW: [], scheduledGW: [], fundingRatio: [], startsBinding: [],
    servedFraction: [], demandFactor: [], premium: [],
    // Edge (installed, not required): datacenter-equivalent GW, power, token share
    edgeEquivGW: [], edgePowerGW: [], dcPowerGW: [], edgeTokenShare: [], edgeUnitsDeployed: []
  };

  // Edge inference (phones, PCs, Macs, self-hosted servers): draws on the
  // shared wafer and DRAM supply and adds energy. EUV is not listed: edge
  // wafers are already bounded by the EUV-based wafer ceiling.
  const edgeCfg = TRANSLATION_INTENSITIES?.edge || {};
  const edgeWaferX = resolveAssumptionValue(edgeCfg.waferIntensityVsDatacenter?.value, 1.0);
  const edgeDramX = resolveAssumptionValue(edgeCfg.dramIntensityVsDatacenter?.value, 1.0);
  const edgeEnergyX = resolveAssumptionValue(edgeCfg.energyPerTokenVsDatacenter?.value, 0.6);
  const edgeLifeMonths = Math.max(1, resolveAssumptionValue(edgeCfg.deviceLifeMonths?.value, 36));
  const EDGE_SHARED_NODES = { advanced_wafers: edgeWaferX, dram_server: edgeDramX };
  // Edge competes for shared supply rather than taking unlimited priority:
  // it can claim at most this share of a shared node's monthly potential.
  const EDGE_MAX_SUPPLY_SHARE = resolveAssumptionValue(edgeCfg.maxShareOfSharedSupply?.value, 0.35);
  // Opening edge fleet = month-0 edge requirement (set on the first month)
  let edgeInstalledEff = null;

  // Shared physical supply pools (see SHARED_SUPPLY_POOLS in assumptions):
  //  - Leading-edge logic wafers are bounded by the EUV installed base
  //    (ASML deliveries accumulate); AI can take up to a maximum share.
  //  - DRAM wafers are bounded by memory-fab capacity on its construction
  //    schedule; HBM (≈3x wafer area per bit), AI host DRAM and edge share it.
  //  - Industry pools: AI's slice of grid, turbine, transformer and
  //    construction-labor output.
  // Nodes inside a pool grow with demand; the pool is the physical ceiling.
  const poolsCfg = SHARED_SUPPLY_POOLS || {};
  const lePool = poolsCfg.leadingEdge || {};
  const memPool = poolsCfg.memory || {};
  const logicShareOfEuv = lePool.logicShareOfEuv ?? 0.65;
  const waferStartsPerToolMonth = lePool.waferStartsPerToolMonth ?? 2000;
  const leAiMaxShare = lePool.aiMaxShare ?? 0.8;
  let euvLogicInstalled = (lePool.euvInstalledStart ?? 320) * logicShareOfEuv;
  let dramGbPerMonth = memPool.dramGbPerMonthStart ?? 3.0e9;
  results.pools = { aiWaferCeiling: [], aiMemoryCeilingGb: [], leadingEdgeScale: [], memoryScale: [], euvLogicInstalled: [], industry: {} };
  const industryPools = poolsCfg.industry || {};
  const industryCap = {};
  for (const [id, cfg] of Object.entries(industryPools)) {
    industryCap[id] = cfg.industryStart || 0;
    results.pools.industry[id] = { ceiling: [], aiShare: [], binding: [] };
  }

  // Diagnostic: annualized GW each gate could support, per month
  results.gates = {};
  const recordGateKW = (name, kw, m) => {
    if (!results.gates[name]) results.gates[name] = new Array(months).fill(null);
    results.gates[name][m] = Number.isFinite(kw) ? (kw / 1e6) * 12 : null;
  };
  let yearAccum = null;

  for (let month = 0; month < months; month++) {
    results.months.push(month);
    const monthOfYear = (startMonthIndex + month) % 12;
    const calendarYear = calendarYearOf(month);

    // Update hybrid bonding intensity with month-dependent adoption curve
    // S-curve: starts at initial share (~2%), ramps toward target (~25%) with halflife of 36 months
    const hbShare = hbAdoptionTarget - (hbAdoptionTarget - hbAdoptionInitial) * Math.pow(2, -month / Math.max(hbAdoptionHalflife, 1));
    nodeIntensityMap['hybrid_bonding'] = hbIntensityBase * hbShare;


    const currentInstalled = (nodeState['gpu_datacenter']?.installedBase || 0) + (nodeState['gpu_inference']?.installedBase || 0);
    const currentInstalledEff = (nodeState['gpu_datacenter']?.installedEff || 0) + (nodeState['gpu_inference']?.installedEff || 0);

    if (month === 0 && (demandScale === null || demandScale === undefined)) {
      const raw = raw0;
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

    // Demand actually expressed this month: calibrated level × unserved-demand
    // decay/feedback state × price rationing relative to the opening premium.
    const rationing = Math.pow(premiumNow / premium0, -priceElasticity);
    const scaleUsed = ((demandScale === null || demandScale === undefined) ? 1 : demandScale) * latentFactor * rationing;

    const req = computeRequiredGpus(month, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed);

    // Forward-looking demand ratio for capacity planning, over each node's lead
    // time. Required compute is in effective units, but components are sized
    // per PHYSICAL accelerator: divide by the hardware index at each end so
    // hardware gains don't read as demand growth. Infrastructure is sized per
    // kW, so it also grows with kW per new accelerator.
    const demandForecastCache = {};
    const getDemandGrowthRatio = (lookAheadMonths, perKwBasis = false) => {
      const key = `${lookAheadMonths}:${perKwBasis ? 1 : 0}`;
      if (demandForecastCache[key] !== undefined) return demandForecastCache[key];
      const futureMonth = Math.min(month + lookAheadMonths, months - 1);
      if (futureMonth <= month || req.requiredTotal <= EPSILON) {
        demandForecastCache[key] = 1;
        return 1;
      }
      const futureReq = computeRequiredGpus(futureMonth, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed);
      const physNow = req.requiredTotal / Math.max(req.hwIndex, EPSILON);
      const physFuture = futureReq.requiredTotal / Math.max(futureReq.hwIndex, EPSILON);
      const kwRatio = perKwBasis ? (futureReq.kwIndex || 1) / (req.kwIndex || 1) : 1;
      // Allow ratios below 1 so capacity planning can see demand decline —
      // flooring at 1 made contraction invisible to every expansion decision.
      const ratio = Math.max((physFuture / physNow) * kwRatio, 0.1);
      demandForecastCache[key] = ratio;
      return ratio;
    };

    // Allocation: training => DC; inference split by configurable share
    const dcInfShare = demandValueAt(month, demandAssumptions, (b) => resolveGrowthRate(b?.allocation?.dcInferenceShare, 0.60));
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
    // STEP 0: RETIREMENTS AND THE ENERGIZATION PLAN
    // =======================================================
    const gpuState = nodeState['gpu_datacenter'];
    const infState = nodeState['gpu_inference'];

    // Vintage indices for accelerators bought this month
    const hwIdx = Math.max(req.hwIndex || 1, EPSILON);
    const kwNew = kw0 * (req.kwIndex || 1);

    // Per-month intensities: power/infrastructure needs scale with IT kW per
    // new accelerator (intensities were built at the opening fleet's kW).
    const monthIntensity = { ...nodeIntensityMap };
    for (const id of INFRASTRUCTURE_NODES) {
      if (monthIntensity[id] !== undefined) monthIntensity[id] *= (req.kwIndex || 1);
    }
    // Memory per accelerator grows: host DRAM directly, HBM through bigger
    // stacks (the stack count per accelerator is unchanged; hbm_gb is the GB
    // per accelerator, used for HBM pricing and the DRAM wafer ceiling).
    if (monthIntensity.dram_server !== undefined) monthIntensity.dram_server *= hostDramContentIndex[month];
    const gbPerHbmStackNow = (memPool.gbPerHbmStack ?? 36) * hbmContentIndex[month];
    monthIntensity.hbm_gb = (monthIntensity.hbm_stacks || 0) * gbPerHbmStackNow;

    // Retirements: each energized cohort retires when it reaches the compute
    // life (Excel funding model: 6 years; the same input drives depreciation).
    // Its shell, hookup, transformers and staff are freed for replacements.
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
    const dcEffRetire = dcRet.eff;
    const infEffRetire = infRet.eff;
    const retiredKW = dcRet.kw + infRet.kw;
    readyShellsMW += (retiredKW * pue) / 1000;
    // kW retiring at a future month (buyers order replacements ahead)
    const retiringKwAt = (m) => {
      let kw = 0;
      for (const pool of [gpuState, infState]) {
        for (let i = pool.cohortHead; i < pool.cohorts.length; i++) {
          const c = pool.cohorts[i];
          const due = c.month + computeLifeMonths;
          if (due === m) kw += c.kw;
          else if (due > m) break;
        }
      }
      return kw;
    };

    // Energization plan (effective units): replace retirements and close the
    // remaining gap over CATCHUP_MONTHS. Energizing older stranded chips adds
    // their own (older) throughput, so the plan is kept in effective units.
    const planEffFor = (required, installedEff, retiringEff) => Math.max(0,
      retiringEff + (required - installedEff) / CATCHUP_MONTHS);
    const planEffDc = planEffFor(requiredDcBase, gpuState.installedEff, dcEffRetire);
    const planEffInf = planEffFor(requiredInfBase, infState.installedEff, infEffRetire);
    const planEff = planEffDc + planEffInf;

    // Financing: open the calendar year (fundable capex computed on opening balances)
    if (monthOfYear === 0 || month === 0) {
      const totalEff = gpuState.installedEff + infState.installedEff;
      const totalKW = gpuState.installedKW + infState.installedKW;
      let trainSum = 0, reqSum = 0;
      const yearLen = Math.min(12, months - month);
      for (let m = month; m < month + yearLen; m++) {
        const r = computeRequiredGpus(m, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed);
        trainSum += r.requiredTotal > EPSILON ? r.requiredTraining / r.requiredTotal : 0;
        reqSum += r.requiredTotal;
      }
      const midEff = getEfficiencyMultipliers(Math.min(month + 6, months - 1), efficiencyAssumptions, effCache, results.warnings, warnedSet);
      const reqAvg = reqSum / Math.max(yearLen, 1);
      // New-build capex per GW IT at this month's prices (cost model)
      const chipBill = costs.chipBill(month, kwNew, monthIntensity, priceIndexOf);
      const facBill = costs.facilityBill(month, facilityCtx(lastGridShare, kwNew), priceIndexOf);
      const chipPerGw = chipBill.total / kwNew / 1e3;           // $B per GW IT
      const facilityPerGw = (facBill.total * pue) / 1e6;        // $B per GW IT
      financing.startYear(calendarYear, {
        openingGW: totalKW / 1e6,
        openingFleetTokPerKwhM: totalKW > EPSILON ? frontierTok0 * kw0 * totalEff / totalKW : frontierTok0,
        frontierTokPerKwhM: frontierTok0 * (midEff.H * midEff.H_memory) / Math.max(midEff.KW, EPSILON),
        trainingShare: trainSum / Math.max(yearLen, 1),
        servedFraction: totalEff > EPSILON ? reqAvg / totalEff : 1,
        priorScarcityRatio: totalEff > EPSILON ? Math.max(0, req.requiredTotal - totalEff) / totalEff : 0,
        premium: premiumNow,
        capexPerGw: chipPerGw + facilityPerGw,
        computeShareOfCapex: (chipPerGw + facilityPerGw) > 0 ? chipPerGw / (chipPerGw + facilityPerGw) : 0.65
      });
      const fundableNowB = financing.fundableThisYear();
      if (Number.isFinite(fundableNowB) && lastYearFundable) {
        fundableGrowthExpected = clamp(Math.max(fundableNowB / lastYearFundable - 1, plannedBudgetGrowth), 0, 0.5);
      }
      if (Number.isFinite(fundableNowB)) lastYearFundable = fundableNowB;
      yearAccum = {
        requiredGWSum: 0, months: 0, tokens: 0, edgeEquivGW: 0, edgePowerGW: 0, dcPowerGW: 0, edgeShare: 0,
        completionsGW: 0, startsGW: 0, desiredSpend: 0, actualSpend: 0, servedSum: 0, electricity: 0
      };
    }

    // =======================================================
    // STEP 1: POTENTIALS (capacity × utilization × yield, then pool ceilings)
    // =======================================================
    const potentials = {};
    const monthEffCap = {};
    const poolBound = {};
    for (const node of NODES) {
      if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') continue;
      if (node.group === 'A') continue;
      const state = nodeState[node.id];
      const sMult = runningSupplyMult[node.id] || 1;
      const cap = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions, sMult);
      monthEffCap[node.id] = effectiveCapacity(node, month, cap);
    }

    // Leading-edge pool: AI wafer starts ≤ EUV-supported logic wafers × max AI share
    const toolProductivity = Math.pow(1 + (lePool.toolProductivityGrowth ?? 0), month / 12);
    const wafersPerLogicTool = waferStartsPerToolMonth * toolProductivity * leAiMaxShare;
    const aiWaferCeiling = euvLogicInstalled * wafersPerLogicTool;
    const leScale = monthEffCap.advanced_wafers > aiWaferCeiling ? aiWaferCeiling / monthEffCap.advanced_wafers : 1;
    if (monthEffCap.advanced_wafers !== undefined) monthEffCap.advanced_wafers *= leScale;
    poolBound.advanced_wafers = leScale < 1;
    // Memory pool: HBM (wafer-area-weighted) + AI host DRAM ≤ max AI share of
    // DRAM capacity. When it binds, wafers go to the mix buyers need (HBM and
    // host DRAM per accelerator ordered, plus edge devices' DRAM, last month),
    // each capped by its own lines; a side short of lines cedes its share.
    const aiMemCeiling = dramGbPerMonth * (memPool.aiMaxShare ?? 0.6);
    const hbmEqPerStack = gbPerHbmStackNow * (memPool.hbmWaferAreaMultiplier ?? 3);
    const hbmGbEq = (monthEffCap.hbm_stacks || 0) * hbmEqPerStack;
    const memUse = hbmGbEq + (monthEffCap.dram_server || 0);
    const memScale = memUse > aiMemCeiling ? aiMemCeiling / memUse : 1;
    if (memScale < 1) {
      const hbmNeed = memNeedPrev.units * (monthIntensity.hbm_stacks || 0) * hbmEqPerStack;
      const dramNeed = memNeedPrev.units * (monthIntensity.dram_server || 0) + memNeedPrev.edgeDram;
      const hbmShare = hbmNeed + dramNeed > EPSILON ? hbmNeed / (hbmNeed + dramNeed) : hbmGbEq / memUse;
      let hbmAlloc = Math.min(hbmGbEq, hbmShare * aiMemCeiling);
      const dramAlloc = Math.min(monthEffCap.dram_server || 0, aiMemCeiling - hbmAlloc);
      hbmAlloc = Math.min(hbmGbEq, aiMemCeiling - dramAlloc);
      if (monthEffCap.hbm_stacks !== undefined) monthEffCap.hbm_stacks = hbmAlloc / Math.max(hbmEqPerStack, EPSILON);
      if (monthEffCap.dram_server !== undefined) monthEffCap.dram_server = dramAlloc;
    }
    poolBound.hbm_stacks = poolBound.dram_server = memScale < 1;
    results.pools.aiWaferCeiling.push(aiWaferCeiling);
    results.pools.aiMemoryCeilingGb.push(aiMemCeiling);
    results.pools.leadingEdgeScale.push(leScale);
    results.pools.memoryScale.push(memScale);
    results.pools.euvLogicInstalled.push(euvLogicInstalled);

    // Industry pools: AI's slice of power/transformer/labor industry output
    for (const [id, cfg] of Object.entries(industryPools)) {
      if (monthEffCap[id] === undefined) continue;
      const ceiling = industryCap[id] * (cfg.conversion ?? 1) * (cfg.aiMaxShare ?? 1);
      const bound = monthEffCap[id] > ceiling;
      if (bound) monthEffCap[id] = ceiling;
      poolBound[id] = bound;
      const rec = results.pools.industry[id];
      rec.ceiling.push(ceiling);
      rec.aiShare.push(industryCap[id] > 0 ? monthEffCap[id] / (industryCap[id] * (cfg.conversion ?? 1)) : 0);
      rec.binding.push(bound);
      industryCap[id] *= Math.pow(1 + scheduleValue(cfg.growthSchedule, month, 'growth', 0.05), 1 / 12);
    }

    for (const node of NODES) {
      if (monthEffCap[node.id] === undefined) continue;
      const state = nodeState[node.id];
      potentials[node.id] = (state.type === 'STOCK') ? (state.inventory + monthEffCap[node.id]) : monthEffCap[node.id];
    }

    // Pools evolve: EUV deliveries this month join the installed base (logic share);
    // DRAM fab capacity follows its construction schedule.
    euvLogicInstalled += (monthEffCap.euv_tools || 0) * logicShareOfEuv;
    dramGbPerMonth *= Math.pow(1 + scheduleValue(memPool.growthSchedule, month, 'growth', 0.15), 1 / 12);

    // Edge devices claim shared wafer/DRAM supply before datacenters, up to
    // EDGE_MAX_SUPPLY_SHARE of each node's potential (phone and PC makers hold
    // long-term contracts). Like the datacenter plan, edge replaces retiring
    // devices (edgeLifeMonths refresh cycle) and closes its gap over
    // CATCHUP_MONTHS, so block-boundary jumps in edge share ramp in smoothly.
    if (edgeInstalledEff === null) edgeInstalledEff = req.requiredEdge || 0;
    const edgeRetireEff = edgeInstalledEff / edgeLifeMonths;
    const edgeNeedEff = Math.max(0, edgeRetireEff + ((req.requiredEdge || 0) - edgeInstalledEff) / CATCHUP_MONTHS);
    const edgeUnits = edgeNeedEff / hwIdx; // physical datacenter-equivalent units at this month's hardware
    const edgeDemand = {};
    let edgeServedFrac = 1;
    for (const [id, x] of Object.entries(EDGE_SHARED_NODES)) {
      const need = edgeUnits * (monthIntensity[id] || 0) * x;
      edgeDemand[id] = need;
      if (need > EPSILON && potentials[id] !== undefined) {
        edgeServedFrac = Math.min(edgeServedFrac, (potentials[id] * EDGE_MAX_SUPPLY_SHARE) / need);
      }
    }
    edgeServedFrac = clamp(edgeServedFrac, 0, 1);
    // Every shared input is consumed in proportion to the edge units actually built
    for (const id of Object.keys(EDGE_SHARED_NODES)) {
      if (potentials[id] !== undefined) potentials[id] = Math.max(0, potentials[id] - edgeDemand[id] * edgeServedFrac);
    }
    edgeInstalledEff = Math.max(0, edgeInstalledEff - edgeRetireEff + edgeNeedEff * edgeServedFrac);

    // Grid vs on-site share of this month's power hookups
    const gridPotential = potentials['grid_interconnect'] || 0;
    const offGridPotential = potentials['off_grid_power'] || 0;
    const totalPowerPotential = gridPotential + offGridPotential;
    const gridShare = totalPowerPotential > EPSILON ? gridPotential / totalPowerPotential : 1.0;
    lastGridShare = gridShare;

    // =======================================================
    // STEP 2: CONSTRUCTION PIPELINE (labor-paced; funding applied below)
    // =======================================================
    // Developers start projects to cover the facility capacity they expect to
    // need at completion (construction time + expected slip), decided
    // permitLagMonths earlier. Starts = the monthly growth in that need (keep
    // pace) + the gap between need and what is already committed, closed over
    // startSmoothingMonths (anchoring and adjustment; the committed side
    // includes projects still in permitting, so the lag does not overshoot).
    {
      const horizon = Math.min(month + Tc + Math.round(slipMean * (1 - onTimeShareAt(month + Tc))), months - 1);
      const neededMWAt = (h) => {
        const fut = computeRequiredGpus(h, demandTrajectories, demandAssumptions, efficiencyAssumptions, effCache, results.warnings, warnedSet, scaleUsed);
        let remainKW = 0, remainEff = 0;
        for (const pool of [gpuState, infState]) {
          for (let i = pool.cohortHead; i < pool.cohorts.length; i++) {
            const c = pool.cohorts[i];
            if (c.month + computeLifeMonths > h) { remainKW += c.kw; remainEff += c.eff; }
          }
        }
        const kwPerEffFuture = (kw0 * (fut.kwIndex || 1)) / Math.max(fut.hwIndex || 1, EPSILON);
        const demandMW = ((remainKW + Math.max(0, fut.requiredTotal - remainEff) * kwPerEffFuture) * pue) / 1000;
        // Builders never plan more shells than chips can fill: the fleet still
        // running at h, chips in stock, and chip supply each month until h,
        // plus maxVacancyMonths of slack. Supply is chip capacity (fabs and
        // components, not purchases, so the cap does not follow the shells)
        // at its trailing rate and growth, but no more than the memory
        // makers' announced capacity can support (memory per accelerator
        // rises on vendor roadmaps; the DRAM schedule is public).
        if (!chipOutlookReady) return demandMW;
        const supplyAt = (k) => Math.min(supplyKWpm * Math.pow(1 + supplyGrowth, k / 12), memChipKWAt(month + k));
        let chipKW = remainKW + stockKWNow;
        for (let k = 1; k <= h - month; k++) chipKW += supplyAt(k);
        chipKW += maxVacancyMonths * supplyAt(h - month);
        const fillableMW = (chipKW * pue) / 1000;
        return Math.min(demandMW, fillableMW);
      };
      // Chip supply outlook from the last two years of capacity: trailing
      // 12-month rate, growing at its year-over-year pace (bounded)
      const chipOutlookReady = chipCapKWHistory.length >= 24;
      const lastYear = chipCapKWHistory.slice(-12).reduce((a, b) => a + b, 0);
      const priorYear = chipCapKWHistory.slice(-24, -12).reduce((a, b) => a + b, 0);
      const supplyKWpm = lastYear / 12;
      if (chipOutlookReady && priorYear > EPSILON) {
        chipGrowthExpected += (clamp(lastYear / priorYear - 1, 0, 0.3) - chipGrowthExpected) / CHIP_GROWTH_SMOOTHING;
      }
      const supplyGrowth = chipGrowthExpected;
      const stockKWNow = strandedTotals().kw;
      // Accelerator kW per month the AI memory ceiling supports at future
      // month k: ceiling (current DRAM capacity grown on its schedule) × the
      // datacenter share of memory demand ÷ memory per accelerator × kW per
      // accelerator
      const memPerUnitAt = (k) => (nodeIntensityMap.hbm_stacks || 0) * (memPool.gbPerHbmStack ?? 36) * hbmContentIndex[k] * (memPool.hbmWaferAreaMultiplier ?? 3)
        + (nodeIntensityMap.dram_server || 0) * hostDramContentIndex[k];
      const dcMemNeed = memNeedPrev.units * memPerUnitAt(month);
      const dcMemShare = dcMemNeed + memNeedPrev.edgeDram > EPSILON ? dcMemNeed / (dcMemNeed + memNeedPrev.edgeDram) : 1;
      const memChipKW = [];
      {
        let ceiling = dramGbPerMonth * (memPool.aiMaxShare ?? 0.6);
        for (let k = month + 1; k <= horizon; k++) {
          const kwPerUnit = kw0 * (getEfficiencyMultipliers(k, efficiencyAssumptions, effCache, results.warnings, warnedSet).KW || 1);
          memChipKW[k] = (ceiling * dcMemShare) / Math.max(memPerUnitAt(k), EPSILON) * kwPerUnit;
          ceiling *= Math.pow(1 + scheduleValue(memPool.growthSchedule, k, 'growth', 0.15), 1 / 12);
        }
      }
      const memChipKWAt = (k) => memChipKW[Math.min(k, horizon)] ?? Infinity;
      const neededMW = neededMWAt(horizon);
      const paceMW = Math.max(0, neededMW - neededMWAt(Math.max(month, horizon - 1)));
      const pipelineMW = buckets.reduce((s, b) => s + b.mw, 0);
      const occupiedMW = ((gpuState.installedKW + infState.installedKW) * pue) / 1000;
      let decidedMW = 0;
      for (let k = Math.max(0, month - permitLag + 1); k < month; k++) decidedMW += desiredStartsQueue[k] || 0;
      const committedMW = occupiedMW + readyShellsMW + pipelineMW + decidedMW;
      desiredStartsQueue[month] = Math.max(0, paceMW + (neededMW - committedMW) / startSmoothing);
    }
    const startsWanted = month < permitLag ? openingStarts : (desiredStartsQueue[month - permitLag] || 0);

    // Labor: projects under way get crews first; new starts take what is left
    const laborCap = potentials['dc_construction'] ?? Infinity;
    const laborPerMwMonth = workerMonthsPerMw / Tc;
    const activeMW = buckets.reduce((s, b) => s + (b.paid < Tc - 1e-9 ? b.mw : 0), 0);
    const laborActive = activeMW * laborPerMwMonth;
    const laborRate = laborActive > EPSILON ? Math.min(1, laborCap / laborActive) : 1;
    const laborLeft = Math.max(0, laborCap - laborActive * laborRate);
    const startsLabor = Math.min(startsWanted, laborLeft / Math.max(laborPerMwMonth, EPSILON));
    const facilityCtxNow = facilityCtx(gridShare, kwNew);
    const facilityBillNow = costs.facilityBill(month, facilityCtxNow, priceIndexOf);
    // Construction payments due this month at the labor-limited pace ($)
    const progressDue = buckets.map((b) => (b.paid < Tc - 1e-9 ? Math.min(laborRate, Tc - b.paid) : 0));
    const constructionDueMW = buckets.reduce((s, b, i) => s + (progressDue[i] * b.mw) / Tc, 0);
    const constructionDue = constructionDueMW * facilityBillNow.total;
    // Builders only commit to what the budget can carry over the next year:
    // expected fundable capex (this year's, grown at last year's rate) minus
    // payments already committed to projects under way and the chip orders
    // being placed (recent pace). A start pays min(Tc, 12)/Tc of its cost in
    // that window; the room is spread over 12 months of starts. Starts slow
    // further if funding has been rationed over the past year.
    const fundableNow = financing.fundableThisYear() * 1e9;
    const budget12 = fundableNow * (1 + fundableGrowthExpected);
    const window = Math.min(Tc, 12);
    const committed12 = buckets.reduce((s, b) => s + (b.paid < Tc - 1e-9 ? Math.min(window, Tc - b.paid) * b.mw : 0), 0) * facilityBillNow.total / Tc;
    const recentChipSpend = chipSpendHistory.length ? chipSpendHistory.reduce((a, b) => a + b, 0) / chipSpendHistory.length : 0;
    const startsBudgetMW = Number.isFinite(fundableNow)
      ? Math.max(0, budget12 - committed12 - recentChipSpend * 12) / Math.max(facilityBillNow.total * window / Tc, EPSILON) / 12
      : Infinity;
    const startsMW = Math.min(startsLabor, startsBudgetMW) * fundingRatioTrailing();
    const startsBinding = startsWanted <= Math.min(startsLabor, startsBudgetMW) + 1e-9
      ? (fundingRatioTrailing() < 1 - 1e-6 ? 'Funding' : 'Demand')
      : (startsBudgetMW < startsLabor ? 'Funding' : 'Construction labor');

    // =======================================================
    // STEP 3: PROCUREMENT (chips bought ahead of scheduled energization)
    // =======================================================
    const gpuNode = NODE_MAP.get('gpu_datacenter');
    const gpuSMult = runningSupplyMult['gpu_datacenter'] || 1;
    const gpuCap = calculateCapacity(gpuNode, month, scenarioOverrides, gpuState.dynamicExpansions, gpuSMult);
    const gpuYield = calculateNodeYield(gpuNode, month);
    const gpuEffCap = effectiveCapacity(gpuNode, month, gpuCap);

    // gpu_inference fab capacity supplies the same accelerator pool. Both fab
    // lines feed one vendor inventory (tracked on gpuState).
    const infNode = NODE_MAP.get('gpu_inference');
    const infSMult = runningSupplyMult['gpu_inference'] || 1;
    const infCap = calculateCapacity(infNode, month, scenarioOverrides, infState.dynamicExpansions, infSMult);
    const infYield = calculateNodeYield(infNode, month);
    const infEffCap = effectiveCapacity(infNode, month, infCap);

    const gpuEffCapTotal = gpuEffCap + infEffCap;
    const gpuAvailable = gpuState.inventory + gpuEffCapTotal;

    // What buyers want: chips for the capacity scheduled to energize
    // procLead months out (buyers plan on schedule, not on slips) plus
    // replacements, capped by the demand plan; and a stock that fills the
    // shells already standing empty plus a precautionary buffer.
    const stockNow = strandedTotals();
    const schedKW = ((scheduledMW[month + procLead] || 0) * 1000) / pue + retiringKwAt(month + procLead);
    const planKW = planEff * (kwNew / hwIdx);
    const expectedKW = Math.min(schedKW, planKW);
    const emptyShellKW = (readyShellsMW * 1000) / pue;
    const targetStockKW = Math.min(emptyShellKW, planKW * CATCHUP_MONTHS) + hoardMonths * expectedKW;
    const desiredKW = Math.max(0, expectedKW + (targetStockKW - stockNow.kw) / invAdjustMonths);
    const desiredUnits = desiredKW / Math.max(kwNew, EPSILON);

    // Chip-side supply: accelerator fabs and every per-accelerator component
    let chipLimit = Infinity;
    let chipLimitNode = null;
    for (const [nodeId, intensity] of Object.entries(monthIntensity)) {
      if (!CHIP_SIDE_NODES.has(nodeId)) continue;
      const potential = potentials[nodeId];
      if (potential === undefined || !(intensity > 0)) continue;
      const supported = potential / intensity;
      recordGateKW(NODE_MAP.get(nodeId)?.name || nodeId, supported * kwNew, month);
      if (supported < chipLimit) { chipLimit = supported; chipLimitNode = NODE_MAP.get(nodeId)?.name || nodeId; }
    }
    recordGateKW('GPU supply (fab + inventory)', gpuAvailable * kwNew, month);
    const physicalUnits = Math.min(desiredUnits, gpuAvailable, chipLimit);

    // Funding: this month's budget pays construction already under way first
    // (builders finish what they started), then chip purchases; when the
    // budget is short, chip orders shrink and, if even construction cannot be
    // paid, projects slow down. New starts pause while orders are rationed.
    const chipBillNow = costs.chipBill(month, kwNew, monthIntensity, priceIndexOf);
    const chipDollars = physicalUnits * chipBillNow.total;
    const budget = financing.allowance(monthOfYear) * 1e9;
    const constructionRatio = constructionDue > EPSILON && Number.isFinite(budget) ? clamp(budget / constructionDue, 0, 1) : 1;
    const budgetForChips = Number.isFinite(budget) ? Math.max(0, budget - constructionDue * constructionRatio) : Infinity;
    const fundingRatio = chipDollars > EPSILON && Number.isFinite(budgetForChips) ? clamp(budgetForChips / chipDollars, 0, 1) : 1;
    fundingHistory.push(Math.min(fundingRatio, constructionRatio));
    if (fundingHistory.length > 12) fundingHistory.shift();
    recordGateKW('Funding', fundingRatio < 1 ? physicalUnits * fundingRatio * kwNew : Infinity, month);
    recordGateKW('Plan (demand)', planKW, month);

    const purchases = physicalUnits * fundingRatio;
    let procurementBinding = 'Demand';
    if (fundingRatio < 1 - 1e-9 || constructionRatio < 1 - 1e-9) procurementBinding = 'Funding';
    else if (chipLimit < Math.min(desiredUnits, gpuAvailable) - 1e-9) procurementBinding = `Components: ${chipLimitNode}`;
    else if (gpuAvailable < desiredUnits - 1e-9) procurementBinding = 'GPU supply';

    if (purchases > EPSILON) strandedCohorts.push({ month, phys: purchases, eff: purchases * hwIdx, kw: purchases * kwNew });
    costs.book(month, chipBillNow, purchases, 'perUnit', 'qtyPerUnit');
    const chipSpend = purchases * chipBillNow.total;
    chipSpendHistory.push(chipSpend);
    chipCapKWHistory.push(Math.min(gpuAvailable, chipLimit) * kwNew);
    if (chipCapKWHistory.length > 24) chipCapKWHistory.shift();
    memNeedPrev.units = desiredUnits;
    memNeedPrev.edgeDram = (edgeDemand.dram_server || 0) * edgeServedFrac;
    if (chipSpendHistory.length > 3) chipSpendHistory.shift();

    // Construction progresses at the labor pace × funding ratio; payments and
    // labor follow progress. Finished projects wait out their slip, then join
    // the stock of ready shells.
    let paidMW = 0;
    let laborUsed = 0;
    let completedMW = 0;
    buckets.forEach((b, i) => {
      if (b.paid < Tc - 1e-9) {
        const step = progressDue[i] * constructionRatio;
        b.paid = Math.min(Tc, b.paid + step);
        paidMW += (step * b.mw) / Tc;
        laborUsed += step * b.mw * laborPerMwMonth;
      } else if (b.wait > 0) {
        b.wait -= 1;
      }
    });
    for (let i = buckets.length - 1; i >= 0; i--) {
      const b = buckets[i];
      if (b.paid >= Tc - 1e-9 && b.wait <= 1e-9) { completedMW += b.mw; buckets.splice(i, 1); }
    }
    readyShellsMW += completedMW;
    if (startsMW > EPSILON) addProject(startsMW, 0, month + Tc);
    costs.book(month, facilityBillNow, paidMW, 'perMw', 'qtyPerMw');
    const facilitySpend = paidMW * facilityBillNow.total;

    // =======================================================
    // STEP 4: ENERGIZATION (chips in hand × ready shells × power)
    // =======================================================
    // Infrastructure constrains net growth: retirements free their hookup,
    // transformers and staff (their shells were returned to readyShellsMW).
    const gateKW = {};
    const gateLabel = {};
    const addGate = (label, kw) => { gateKW[label] = kw; };
    addGate('DC shells', (readyShellsMW * 1000) / pue);
    const hookupPerKw = perKw('grid_interconnect'); // MW per kW IT
    addGate(POWER_HOOKUP_LABEL, hookupPerKw > 0 ? (gridPotential + offGridPotential) / hookupPerKw + retiredKW : Infinity);
    for (const id of ENERGIZE_SIDE_NODES) {
      if (id === 'grid_interconnect' || id === 'off_grid_power' || potentials[id] === undefined) continue;
      let intensityKw = perKw(id);
      if (id === 'power_generation' || id === 'transformers_lpt') intensityKw *= gridShare;
      const name = NODE_MAP.get(id)?.name || id;
      if (id === 'liquid_cooling') {
        // per accelerator: convert with the kW of the chips waiting to energize
        const kwPerUnit = stockNow.phys > EPSILON ? stockNow.kw / stockNow.phys : kwNew;
        const units = (monthIntensity.liquid_cooling || 0) > 0 ? potentials[id] / monthIntensity.liquid_cooling : Infinity;
        addGate(name, units * kwPerUnit);
      } else {
        addGate(name, intensityKw > EPSILON ? potentials[id] / intensityKw + retiredKW : Infinity);
      }
    }
    Object.entries(gateKW).forEach(([label, kw]) => recordGateKW(label, kw, month));
    let kwLimit = Infinity;
    let kwLimitLabel = null;
    Object.entries(gateKW).forEach(([label, kw]) => { if (kw < kwLimit) { kwLimit = kw; kwLimitLabel = label; } });

    // Draw chips FIFO until the plan (effective units), the kW gates or the
    // stock run out.
    const stockBefore = strandedTotals();
    let effNeed = planEff;
    let kwRoom = Math.max(0, kwLimit);
    const energized = { phys: 0, eff: 0, kw: 0 };
    while (strandedCohorts.length && effNeed > EPSILON && kwRoom > EPSILON) {
      const c = strandedCohorts[0];
      const f = Math.min(1, effNeed / Math.max(c.eff, EPSILON), kwRoom / Math.max(c.kw, EPSILON));
      energized.phys += c.phys * f; energized.eff += c.eff * f; energized.kw += c.kw * f;
      effNeed -= c.eff * f; kwRoom -= c.kw * f;
      if (f >= 1 - 1e-12) strandedCohorts.shift();
      else { c.phys *= (1 - f); c.eff *= (1 - f); c.kw *= (1 - f); }
    }
    readyShellsMW = Math.max(0, readyShellsMW - (energized.kw * pue) / 1000);

    const planKWAtStock = stockBefore.eff > EPSILON ? planEff * (stockBefore.kw / stockBefore.eff) : planKW;
    let binding = 'Demand';
    const minOther = Math.min(kwLimit, stockBefore.kw);
    if (planKWAtStock <= minOther + 1e-6) binding = 'Demand';
    else if (stockBefore.kw <= kwLimit) binding = 'Chips in hand';
    else binding = kwLimitLabel === POWER_HOOKUP_LABEL || kwLimitLabel?.startsWith('DC shells') ? kwLimitLabel : `Components: ${kwLimitLabel}`;
    const deferredByFundingGW = ((physicalUnits - purchases) * kwNew) / 1e6;

    // Book energized chips into the fleet pools (life starts at energization)
    const shareDc = planEff > EPSILON ? planEffDc / planEff : 0.7;
    const actualDcPhys = energized.phys * shareDc;
    const actualInfPhys = energized.phys * (1 - shareDc);
    gpuState.installedBase = Math.max(0, gpuState.installedBase + actualDcPhys - dcRet.phys);
    infState.installedBase = Math.max(0, infState.installedBase + actualInfPhys - infRet.phys);
    gpuState.installedEff = Math.max(0, gpuState.installedEff + energized.eff * shareDc - dcEffRetire);
    infState.installedEff = Math.max(0, infState.installedEff + energized.eff * (1 - shareDc) - infEffRetire);
    gpuState.installedKW = Math.max(0, gpuState.installedKW + energized.kw * shareDc - dcRet.kw);
    infState.installedKW = Math.max(0, infState.installedKW + energized.kw * (1 - shareDc) - infRet.kw);
    if (actualDcPhys > 0) gpuState.cohorts.push({ month, phys: actualDcPhys, eff: energized.eff * shareDc, kw: energized.kw * shareDc });
    if (actualInfPhys > 0) infState.cohorts.push({ month, phys: actualInfPhys, eff: energized.eff * (1 - shareDc), kw: energized.kw * (1 - shareDc) });

    // Unserved demand after energization (accelerators at this month's hardware)
    const installedEffAfter = gpuState.installedEff + infState.installedEff;
    gpuState.backlog = Math.max(0, req.requiredTotal - installedEffAfter) / hwIdx;

    // Vendor side: fabs produce to purchases plus a finished-goods buffer
    const gpuBufferTarget = purchases * DEFAULT_BUFFER_MONTHS;
    const gpuProduced = Math.min(gpuEffCapTotal, purchases + Math.max(0, gpuBufferTarget - gpuState.inventory));
    gpuState.inventory = Math.max(0, gpuState.inventory + gpuProduced - purchases);

    // Tightness compares demand flow (orders) against fab output (flow vs flow)
    const gpuTightness = desiredUnits / Math.max(gpuEffCapTotal, EPSILON);
    const gpuPriceIndex = calculatePriceIndex(gpuTightness);
    lastPriceIndex.gpu_datacenter = gpuPriceIndex;
    lastPriceIndex.gpu_inference = gpuPriceIndex;
    gpuState.tightnessHistory.push(gpuTightness);
    const gpuUtilization = gpuEffCapTotal > EPSILON ? gpuProduced / gpuEffCapTotal : 1.0;

    // Organic growth: shortage-driven (tightness > 1) plus any baseline rate,
    // throttled by utilization — no new lines while existing ones are idle.
    compoundOrganicGrowth('gpu_datacenter', month, gpuTightness, gpuUtilization);
    compoundOrganicGrowth('gpu_inference', month, gpuTightness, gpuUtilization);

    const gpuLeadTime = gpuNode.leadTimeDebottleneck || 6;
    const gpuCooldown = Math.max(Math.floor(gpuLeadTime / 2), 6);
    if ((month - gpuState.lastExpansionMonth) > gpuCooldown && gpuUtilization >= UTILIZATION_GATE_FLOOR) {
      const gpuGrowthRatio = getDemandGrowthRatio(gpuLeadTime);
      const forecastGpuDemand = desiredUnits * gpuGrowthRatio;
      const gpuFutureMonth = Math.min(month + gpuLeadTime, months - 1);
      const forecastGpuCap = calculateCapacity(gpuNode, gpuFutureMonth, scenarioOverrides, gpuState.dynamicExpansions, runningSupplyMult['gpu_datacenter'] || 1);
      const forecastInfCap = calculateCapacity(infNode, gpuFutureMonth, scenarioOverrides, infState.dynamicExpansions, runningSupplyMult['gpu_inference'] || 1);
      const forecastGpuEffCap = effectiveCapacity(gpuNode, gpuFutureMonth, forecastGpuCap)
        + effectiveCapacity(infNode, gpuFutureMonth, forecastInfCap);
      if (forecastGpuDemand > forecastGpuEffCap) {
        const gap = forecastGpuDemand - forecastGpuEffCap;
        const expansionAmount = Math.min(gap * 0.5, gpuCap * 0.30);
        gpuState.dynamicExpansions.push({ month: gpuFutureMonth, capacityAdd: Math.max(expansionAmount, gpuCap * 0.05) });
        gpuState.lastExpansionMonth = month;
      }
    }

    // Shortage / glut flags for accelerators (orders vs fab output)
    const gpuUnmet = purchases < desiredUnits - 1e-6;
    const gpuIsShort = gpuTightness > 1.05;
    const gpuIsGlut = gpuTightness < glutThresholds.soft && !gpuUnmet;
    const gpuIsHardGlut = gpuTightness < glutThresholds.hard && !gpuUnmet;
    const purchaseShareDc = shareDc;

    const storeGpu = (isDc) => {
      const nodeId = isDc ? 'gpu_datacenter' : 'gpu_inference';
      const res = results.nodes[nodeId];
      if (!res) return;
      const share = isDc ? purchaseShareDc : (1 - purchaseShareDc);
      res.demand.push(desiredUnits * share);
      res.planDeploy.push(desiredUnits * share);
      res.supply.push(purchases * share);
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
      res.consumption.push(energized.phys * share);
      res.gpuDelivered.push(isDc ? actualDcPhys : actualInfPhys);
      res.idleGpus.push(strandedTotals().phys * share);
      res.tightness.push(gpuTightness);
      res.priceIndex.push(gpuPriceIndex);
      res.yield.push(isDc ? gpuYield : infYield);
      res.shortage.push(gpuIsShort ? 1 : 0);
      res.glut.push(gpuIsGlut ? (gpuIsHardGlut ? 2 : 1) : 0);
      res.unmetDemand.push(Math.max(0, (desiredUnits - purchases) * share));
    };

    storeGpu(true);
    storeGpu(false);

    // Energization-side demand (net of retirements for infrastructure)
    const netPlanKW = Math.max(0, planKWAtStock - retiredKW);
    const netEnergizedKW = Math.max(0, energized.kw - retiredKW);

    // Components
    for (const node of NODES) {
      if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') continue;
      if (node.group === 'A') continue;

      const nodeRes = results.nodes[node.id];
      const state = nodeState[node.id];
      const isInfra = INFRASTRUCTURE_NODES.has(node.id);

      let planDemand = 0;
      let actualConsumption = 0;
      if (CHIP_SIDE_NODES.has(node.id) || node.id === 'hybrid_bonding') {
        const intensity = monthIntensity[node.id] || 0;
        const edgeNeed = edgeDemand[node.id] || 0;
        planDemand = desiredUnits * intensity + edgeNeed;
        actualConsumption = purchases * intensity + edgeNeed * edgeServedFrac;
      } else if (node.id === 'euv_tools') {
        // Tools that must be delivered each month so the EUV-supported wafer
        // ceiling stays ahead of AI wafer demand one lead time out (logic tools
        // grossed up to all EUV tools). Zero when the ceiling has headroom.
        const leadTime = node.leadTimeDebottleneck || 18;
        const waferIntensity = monthIntensity.advanced_wafers || 0;
        const toolsFor = (units, edge) => {
          const wafers = units * waferIntensity * getDemandGrowthRatio(leadTime) + edge;
          return Math.max(0, wafers / Math.max(wafersPerLogicTool, EPSILON) - euvLogicInstalled) / leadTime / logicShareOfEuv;
        };
        planDemand = toolsFor(desiredUnits, edgeDemand.advanced_wafers || 0);
        actualConsumption = toolsFor(purchases, (edgeDemand.advanced_wafers || 0) * edgeServedFrac);
      } else if (node.id === 'datacenter_mw') {
        // Shells: MW needed this month to energize the plan vs MW occupied
        planDemand = (planKWAtStock * pue) / 1000;
        actualConsumption = (energized.kw * pue) / 1000;
      } else if (node.id === 'dc_construction') {
        // Crews: all active projects at full pace plus wanted starts
        planDemand = laborActive + startsWanted * laborPerMwMonth;
        actualConsumption = laborUsed;
      } else if (node.id === 'liquid_cooling') {
        const intensity = monthIntensity.liquid_cooling || 0;
        const kwPerUnit = stockBefore.phys > EPSILON ? stockBefore.kw / stockBefore.phys : kwNew;
        planDemand = (planKWAtStock / Math.max(kwPerUnit, EPSILON)) * intensity;
        actualConsumption = energized.phys * intensity;
      } else if (ENERGIZE_SIDE_NODES.has(node.id)) {
        let intensityKw = perKw(node.id);
        if (node.id === 'power_generation' || node.id === 'transformers_lpt' || node.id === 'grid_interconnect') intensityKw *= gridShare;
        else if (node.id === 'off_grid_power') intensityKw *= (1 - gridShare);
        planDemand = (isInfra ? netPlanKW : planKWAtStock) * intensityKw;
        actualConsumption = (isInfra ? netEnergizedKW : energized.kw) * intensityKw;
      }

      // Effective demand: producers respond to what customers actually consume,
      // not the unconstrained order book (up to CONSUMPTION_HEADROOM above it).
      // During bootstrap (no consumption yet), fall back to plan demand.
      const effectiveDemand = actualConsumption > EPSILON
        ? Math.min(planDemand, actualConsumption * CONSUMPTION_HEADROOM)
        : planDemand;

      const sMult = runningSupplyMult[node.id] || 1;
      const cap = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions, sMult);
      const y = calculateNodeYield(node, month);
      // Same pool-limited effective capacity used in gating; shells are the
      // pipeline's completions this month
      const isShells = node.id === 'datacenter_mw';
      const effCap = isShells ? completedMW : monthEffCap[node.id];

      const inventoryIn = isShells ? readyShellsMW : state.inventory;
      const backlogIn = state.backlog;
      const backlogUrgency = backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS;

      const potentialSupply = (state.type === 'STOCK') ? (inventoryIn + effCap) : effCap;

      let production = 0;
      let delivered = 0;
      if (isShells) {
        production = completedMW;
        delivered = actualConsumption;
      } else if (state.type === 'STOCK') {
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

      // Backlog tracks against effective demand (not plan): unmet plan demand
      // caused by a different bottleneck is not a real order shortfall.
      const unmetThisMonth = Math.max(0, effectiveDemand - delivered);
      state.backlog = isShells ? buckets.reduce((s, b) => s + b.mw, 0) : Math.max(0, backlogIn + effectiveDemand - delivered);

      // Market tightness (price signals, reporting): plan demand flow vs
      // capacity flow. Shells: plan vs completions plus the ready stock.
      const totalLoad = planDemand + (isShells ? 0 : backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS);
      const tightness = totalLoad / Math.max(isShells ? effCap + inventoryIn : effCap, EPSILON);
      const priceIndex = calculatePriceIndex(tightness);
      lastPriceIndex[node.id] = priceIndex;

      // Operational tightness (what customers actually take) drives expansion
      const operationalLoad = effectiveDemand + (backlogIn / BACKLOG_PAYDOWN_MONTHS_COMPONENTS);
      const operationalTightness = operationalLoad / Math.max(effCap, EPSILON);
      state.tightnessHistory.push(tightness);

      const compUtilization = effCap > EPSILON
        ? (state.type === 'STOCK' ? production : delivered) / effCap
        : 1.0;

      // Shells grow through the construction pipeline, not organically
      if (!isShells) {
        // Organic growth: shortage-driven plus any baseline rate, throttled by
        // utilization. Under a pool ceiling the node's own lines keep pace
        // with current demand (not the backlog the ceiling itself causes),
        // measured against unscaled capacity, so supply follows the rising
        // ceiling instead of stalling below it and then jumping.
        const ownTightness = poolBound[node.id]
          ? effectiveDemand / Math.max(effectiveCapacity(node, month, cap), EPSILON)
          : operationalTightness;
        compoundOrganicGrowth(node.id, month, ownTightness, compUtilization);

        // Discrete (lead-time) expansions: not for nodes that grow on a fixed
        // physical schedule. They continue under a pool ceiling (sized to
        // forecast demand, so bounded): the ceiling rises every month, and
        // lines planned a lead time ahead are what let supply follow it
        // instead of stalling and then jumping.
        const compLeadTime = node.leadTimeDebottleneck || 12;
        const compCooldown = Math.max(Math.floor(compLeadTime / 2), 6);
        const canExpand = !node.growsAtPhysicalMax;
        if (canExpand && (month - state.lastExpansionMonth) > compCooldown && compUtilization >= UTILIZATION_GATE_FLOOR) {
          const growthRatio = getDemandGrowthRatio(compLeadTime, isInfra);
          const forecastDemand = effectiveDemand * growthRatio;
          const compFutureMonth = Math.min(month + compLeadTime, months - 1);
          const futureCap = calculateCapacity(node, compFutureMonth, scenarioOverrides, state.dynamicExpansions, runningSupplyMult[node.id] || 1);
          const futureEffCap = effectiveCapacity(node, compFutureMonth, futureCap);
          if (forecastDemand > futureEffCap) {
            const gap = forecastDemand - futureEffCap;
            // Up to 100% of capacity per trigger, or the node's physical ramp
            // limit where it has one (e.g. power generation).
            const maxExp = getMaxExpansion(node, month);
            const maxDynamic = maxExp != null ? cap * (maxExp / 12) : cap;
            const expansionAmount = Math.min(gap * 0.5, maxDynamic);
            // Floor at 5% of capacity, but never above a physical ramp limit
            const expansionFloor = Math.min(cap * 0.05, maxDynamic);
            state.dynamicExpansions.push({ month: month + compLeadTime, capacityAdd: Math.max(expansionAmount, expansionFloor) });
            state.lastExpansionMonth = month;
          }
        }
      }

      // Shortage / glut flags
      const isShort = tightness > 1.05 || (!isShells && state.backlog > 0);
      const isGlut = tightness < glutThresholds.soft && (isShells || state.backlog <= 0);
      const isHardGlut = tightness < glutThresholds.hard && (isShells || state.backlog <= 0);

      if (nodeRes) {
        nodeRes.demand.push(planDemand);
        nodeRes.planDeploy.push(planDemand);
        nodeRes.supply.push(delivered);
        nodeRes.capacity.push(effCap);
        nodeRes.supplyPotential.push(potentialSupply);
        nodeRes.potential.push(potentialSupply);
        nodeRes.inventory.push(isShells ? readyShellsMW : state.inventory);
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

    // ---- Fleet, demand response, spend and financing bookkeeping ----
    const fleetKW = gpuState.installedKW + infState.installedKW;
    const fleetEff = gpuState.installedEff + infState.installedEff;
    const fleetPhys = gpuState.installedBase + infState.installedBase;
    const kwPerEff = fleetEff > EPSILON ? fleetKW / fleetEff : kwNew / hwIdx;
    const requiredGW = req.requiredTotal * kwPerEff / 1e6;
    const deployedGW = energized.kw / 1e6;
    const retiredGW = retiredKW / 1e6;
    const stockAfter = strandedTotals();
    const underConstructionMW = buckets.reduce((s, b) => s + b.mw, 0);

    results.fleet.installedGW.push(fleetKW / 1e6);
    results.fleet.requiredGW.push(requiredGW);
    results.fleet.deployedGW.push(deployedGW);
    results.fleet.retiredGW.push(retiredGW);
    results.fleet.binding.push(binding);
    results.fleet.procurementBinding.push(procurementBinding);
    results.fleet.installedAccelerators.push(fleetPhys);
    results.fleet.fleetTokPerKwhM.push(fleetKW > EPSILON ? frontierTok0 * kw0 * fleetEff / fleetKW : frontierTok0);
    results.fleet.frontierTokPerKwhM.push(frontierTok0 * hwIdx / Math.max(req.kwIndex || 1, EPSILON));
    results.fleet.kwPerNewAccelerator.push(kwNew);
    results.fleet.trainingShare.push(req.requiredTotal > EPSILON ? req.requiredTraining / req.requiredTotal : 0);
    results.fleet.purchasedGW.push((purchases * kwNew) / 1e6);
    results.fleet.strandedGW.push(stockAfter.kw / 1e6);
    results.fleet.readyShellsGW.push(readyShellsMW / pue / 1000);
    results.fleet.underConstructionGW.push(underConstructionMW / pue / 1000);
    results.fleet.completionsGW.push(completedMW / pue / 1000);
    results.fleet.startsGW.push(startsMW / pue / 1000);
    results.fleet.scheduledGW.push((scheduledMW[month] || 0) / pue / 1000);
    results.fleet.fundingRatio.push(Math.min(fundingRatio, constructionRatio));
    results.fleet.startsBinding.push(startsBinding);

    // Demand response: served share after energization vs the opening baseline
    const served = req.requiredTotal > EPSILON ? Math.min(1, installedEffAfter / req.requiredTotal) : 1;
    const servedVsBase = Math.min(1, served / Math.max(baselineServed, EPSILON));
    latentFactor *= 1 - unservedDecay * (1 - servedVsBase);
    if (capabilityFeedback > 0 && month + 1 < months) {
      const tokNow = req.inferenceDemand.consumer + req.inferenceDemand.enterprise + req.inferenceDemand.agentic;
      const next = calculateInferenceDemand(month + 1, demandTrajectories);
      const g = tokNow > EPSILON ? next.total / tokNow : 1;
      latentFactor *= Math.pow(Math.max(g, EPSILON), Math.pow(servedVsBase, capabilityFeedback) - 1);
    }
    const scarcity = installedEffAfter > EPSILON ? Math.max(0, req.requiredTotal - installedEffAfter) / installedEffAfter : 0;
    scarcityWindow.push(scarcity);
    if (scarcityWindow.length > 12) scarcityWindow.shift();
    results.fleet.servedFraction.push(served);
    results.fleet.demandFactor.push(latentFactor * rationing);
    results.fleet.premium.push(premiumNow);
    premiumNow = scarcityPremium(financing.scalars, scarcityWindow.reduce((a, b) => a + b, 0) / scarcityWindow.length);

    // Energy: average draw = idle share + (1 − idle) × utilization (Excel convention)
    const drawFactor = idleShare + (1 - idleShare) * financing.pathValue('utilization', calendarYear);
    // Edge reporting uses the INSTALLED edge fleet (it ramps toward the
    // requirement), so energy and token share reflect what is actually served.
    const edgeServedRatio = (req.requiredEdge || 0) > EPSILON ? Math.min(1, edgeInstalledEff / req.requiredEdge) : 0;
    const edgeEquivGW = edgeInstalledEff * kwPerEff / 1e6;
    const dcPowerGW = (fleetKW / 1e6) * drawFactor * pue;
    const edgePowerGW = edgeEquivGW * drawFactor * pue * edgeEnergyX;
    // inferenceDemand is pre-calibration; edgeTokensTotal is post-calibration
    const inferenceTokens = ((req.inferenceDemand.consumer || 0) + (req.inferenceDemand.enterprise || 0) + (req.inferenceDemand.agentic || 0)) * scaleUsed;
    const edgeTokenShare = inferenceTokens > EPSILON ? (req.edgeTokensTotal || 0) * edgeServedRatio / inferenceTokens : 0;
    results.fleet.edgeEquivGW.push(edgeEquivGW);
    results.fleet.dcPowerGW.push(dcPowerGW);
    results.fleet.edgePowerGW.push(edgePowerGW);
    results.fleet.edgeTokenShare.push(edgeTokenShare);
    results.fleet.edgeUnitsDeployed.push(edgeUnits * edgeServedFrac);

    // Operating spend: datacenter electricity and operations staff
    const kwhThisMonth = dcPowerGW * 1e6 * (8760 / 12);
    const electricityPrice = financing.scalars.electricityPricePerKwh;
    costs.bookDirect(month, 'electricity', kwhThisMonth * electricityPrice, kwhThisMonth, electricityPrice);
    const fteNow = ((fleetKW * pue) / 1000) * ftesPerMw;
    const staffPrice = costs.priceAt('ops_staff', month, priceIndexOf('dc_ops_staff'));
    costs.bookDirect(month, 'ops_staff', (fteNow * staffPrice) / 12, fteNow / 12, staffPrice);

    financing.recordMonth({
      computeCapex: chipSpend / 1e9,
      facilityCapex: facilitySpend / 1e9,
      deployedGW, retiredGW,
      purchasedGW: (purchases * kwNew) / 1e6,
      binding, deferredByFundingGW
    });
    if (yearAccum) {
      yearAccum.requiredGWSum += requiredGW;
      yearAccum.months += 1;
      yearAccum.tokens += inferenceTokens;
      yearAccum.edgeEquivGW += edgeEquivGW;
      yearAccum.edgePowerGW += edgePowerGW;
      yearAccum.dcPowerGW += dcPowerGW;
      yearAccum.edgeShare += edgeTokenShare;
      yearAccum.completionsGW += completedMW / pue / 1000;
      yearAccum.startsGW += startsMW / pue / 1000;
      yearAccum.desiredSpend += (constructionDue + chipDollars) / 1e9;
      yearAccum.actualSpend += (facilitySpend + chipSpend) / 1e9;
      yearAccum.servedSum += served;
    }
    if (monthOfYear === 11 || month === months - 1) {
      financing.closeYear({
        tokenDemandIndex: yearAccum ? yearAccum.tokens : 0,
        requiredGW: yearAccum && yearAccum.months ? yearAccum.requiredGWSum / yearAccum.months : requiredGW,
        requiredGWYearEnd: requiredGW,
        installedGW: fleetKW / 1e6,
        scarcityRatio: scarcity,
        extras: yearAccum && yearAccum.months ? {
          edgeTokenShare: yearAccum.edgeShare / yearAccum.months,
          edgeEquivGW: yearAccum.edgeEquivGW / yearAccum.months,
          edgePowerGW: yearAccum.edgePowerGW / yearAccum.months,
          dcPowerGW: yearAccum.dcPowerGW / yearAccum.months,
          totalAiPowerGW: (yearAccum.edgePowerGW + yearAccum.dcPowerGW) / yearAccum.months,
          strandedGWYearEnd: stockAfter.kw / 1e6,
          readyShellsGWYearEnd: readyShellsMW / pue / 1000,
          underConstructionGWYearEnd: underConstructionMW / pue / 1000,
          completionsGW: yearAccum.completionsGW,
          startsGW: yearAccum.startsGW,
          fundingShortfallShare: yearAccum.desiredSpend > EPSILON ? Math.max(0, 1 - yearAccum.actualSpend / yearAccum.desiredSpend) : 0,
          procurementBinding: mostCommon(results.fleet.procurementBinding.slice(month + 1 - yearAccum.months, month + 1)),
          startsBinding: mostCommon(results.fleet.startsBinding.slice(month + 1 - yearAccum.months, month + 1)),
          servedFraction: yearAccum.servedSum / yearAccum.months
        } : {}
      });
    }
  }

  results.financing = financing.finalize();
  results.annual = results.financing.years;
  results.spend = costs.annual(results.annual.length);
  results.spend.years = results.annual.map((r) => r.year);
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
    if (!node || node.group === 'A' || NON_GATING_NODES.has(nodeId)) continue;

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

  // What actually set deployments: months each constraint was binding, with
  // the first and last calendar year it bound.
  const bindingMap = {};
  (results.fleet?.binding || []).forEach((name, month) => {
    const year = calendarYearOf(month);
    const b = bindingMap[name] || (bindingMap[name] = { constraint: name, months: 0, firstYear: year, lastYear: year });
    b.months += 1;
    b.lastYear = year;
  });
  const binding = Object.values(bindingMap).sort((a, b) => b.months - a.months);

  return {
    shortages: shortages.slice(0, 20),
    gluts: gluts.slice(0, 20),
    bottlenecks: bottlenecks.slice(0, 10),
    binding,
    primaryConstraint: binding[0]?.constraint || null
  };
}

export function formatMonth(monthIndex) {
  const year = calendarYearOf(monthIndex);
  const month = (((GLOBAL_PARAMS.startMonth || 1) - 1 + monthIndex) % 12) + 1;
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
