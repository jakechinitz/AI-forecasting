/**
 * AI Infrastructure Supply Chain - Assumptions & Base Rates
 *
 * Purpose:
 * - Single source of truth for all user-adjustable assumptions.
 * - Guarantees every time block has required baselines (no "drop to 0" after Year 5).
 * - Normalizes scenario overrides so numbers like { consumer: 0.55 } are treated as { consumer: { value: 0.55 } }.
 *
 * Efficiency conventions used by calculations.js (monthly compounding within
 * each time block):
 * - Model efficiency M_t = (1 - m)^(t/12)   (compute per token falls)
 * - Systems throughput S_t = (1 + s)^(t/12) (throughput rises)
 * - Hardware H_t = (1 + h)^(t/12), memory H_mem,t = (1 + h_memory)^(t/12)
 * - IT kW per new accelerator KW_t = (1 + kw_growth)^(t/12)
 * Software (1/M × S) applies to the whole fleet. Hardware (H × H_mem) applies
 * only to accelerators installed that month (vintage tracking), and kw_growth
 * raises the IT power of each new accelerator.
 */

import assumptionOverrides from './assumptionOverrides.json';

// ============================================
// GLOBAL MODEL PARAMETERS
// ============================================

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (value) => String(value).padStart(2, '0');
const formatMonthYear = (date) => `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
const formatAsOfDate = (year, month) => `${year}-${pad2(month)}-01`;
const addMonths = (date, months) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));

// ============================================
// FLEET ANCHOR (opening balances)
// ============================================
/**
 * The model starts in January of the year after the fleet anchor, so the
 * opening fleet, cash, and debt are all year-end actuals (the Excel funding
 * model's convention: 2025 is the base year). Roll this forward once a new
 * year-end is known and the whole model moves with it.
 *
 * GW are IT (critical) load. PUE is applied separately for facility power.
 * Tokens/kWh at install per vintage come from the AI Capex Funding Model
 * (~7M tok/kWh for early Blackwell, Elastix; Hopper-era vintages lower).
 */
export const FLEET_ANCHOR = {
  asOfYearEnd: 2025,
  vintages: [
    { year: 2023, gw: 4, tokensPerKwhM: 3.0 },
    { year: 2024, gw: 8, tokensPerKwhM: 4.5 },
    { year: 2025, gw: 12, tokensPerKwhM: 7.0 }
  ],
  // Frontier (newest-vintage) serving efficiency at the model start
  frontierTokensPerKwhM: 7.0,
  // IT kW per accelerator for the opening fleet. GB200 NVL72 ≈ 120 kW / 72 GPUs
  // ≈ 1.7 kW; HGX H100 ≈ 10.2 kW / 8 ≈ 1.3 kW; TPU/Trainium lower. Fleet blend ≈ 1.4.
  kwPerAccelerator: 1.4,
  // Scope: global ex-China, matching the Excel (its builder tiers and chip caps
  // exclude China). Physical supply nodes are calibrated to ex-China supply.
  source: 'AI Capex Funding Model (Sept 2026): opening AI fleet ≈ 24 GW end-2025, ex-China'
};

const MODEL_START_YEAR = FLEET_ANCHOR.asOfYearEnd + 1;
const START_DATE = new Date(Date.UTC(MODEL_START_YEAR, 0, 1));
const DEFAULT_AS_OF_DATE = formatAsOfDate(MODEL_START_YEAR, 1);

export const GLOBAL_PARAMS = {
  // Simulation horizon
  horizonYears: 20,
  startYear: MODEL_START_YEAR,
  startMonth: 1,

  // Price index shape parameters (global, not per-node)
  priceIndex: {
    a: 2.0,
    b: 1.5,
    minPrice: 0.5,
    maxPrice: 5.0
  },

  // Glut thresholds: tightness below soft = glut, below hard = hard glut
  glutThresholds: {
    soft: 0.95,
    hard: 0.80
  },

  // Brain power equivalency parameters
  brainEquivalency: {
    humanBrainWatts: 30,               // Human brain power consumption in watts
    startingWattsPerBrainEquiv: 10000, // Starting AI watts per brain-equivalent of cognitive work
    // Soft knee at 60× brain efficiency: 30 W / 60 = 0.5 W per brain-equivalent
    // (a practical floor allowing for resilience/redundancy). Gains continue
    // above the knee with logarithmic diminishing returns (softEfficiencyCap).
    maxEfficiencyVsBrain: 60,
    minWattsPerBrainEquiv: 0.5         // = humanBrainWatts / maxEfficiencyVsBrain
  }
};

// ============================================
// ASSUMPTION TIME SEGMENTS
// ============================================

const SEGMENT_DEFS = [
  { key: 'year1', label: 'Year 1', startMonth: 0, endMonth: 11 },
  { key: 'year2', label: 'Year 2', startMonth: 12, endMonth: 23 },
  { key: 'year3', label: 'Year 3', startMonth: 24, endMonth: 35 },
  { key: 'year4', label: 'Year 4', startMonth: 36, endMonth: 47 },
  { key: 'year5', label: 'Year 5', startMonth: 48, endMonth: 59 },
  { key: 'years6_10', label: 'Years 6-10', startMonth: 60, endMonth: 119 },
  { key: 'years11_15', label: 'Years 11-15', startMonth: 120, endMonth: 179 },
  { key: 'years16_20', label: 'Years 16-20', startMonth: 180, endMonth: 239 }
];

export const ASSUMPTION_SEGMENTS = SEGMENT_DEFS.map((segment) => {
  const startDate = addMonths(START_DATE, segment.startMonth);
  const endDate = addMonths(START_DATE, segment.endMonth);
  return {
    ...segment,
    years: `${formatMonthYear(startDate)}-${formatMonthYear(endDate)}`
  };
});

export const FIRST_FIVE_YEAR_KEYS = ASSUMPTION_SEGMENTS.slice(0, 5).map(segment => segment.key);

const SEGMENT_LABELS = ASSUMPTION_SEGMENTS.reduce((acc, segment) => {
  acc[segment.key] = `${segment.label} (${segment.years})`;
  return acc;
}, {});

// ============================================
// CORE HELPERS
// ============================================

const cloneBlock = (block) => JSON.parse(JSON.stringify(block));
const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const deepMerge = (base, overrides) => {
  if (!isPlainObject(overrides)) return base;
  const merged = { ...base };
  Object.entries(overrides).forEach(([key, value]) => {
    if (isPlainObject(value) && isPlainObject(base?.[key])) {
      merged[key] = deepMerge(base[key], value);
    } else {
      merged[key] = value;
    }
  });
  return merged;
};

/**
 * Normalize overrides against a template so that:
 * - If template expects { value: number, ... } and override provides a number,
 *   we convert it to { ...template, value: overrideNumber }.
 * - Works recursively.
 */
const normalizeOverridesToTemplate = (template, overrides) => {
  if (!isPlainObject(overrides) || !isPlainObject(template)) return overrides;

  const out = { ...overrides };

  Object.entries(overrides).forEach(([key, val]) => {
    const t = template[key];

    if (val === null || val === undefined) return;

    // If template is a value-object and override is a number, wrap it.
    if (typeof val === 'number' && isPlainObject(t) && Object.prototype.hasOwnProperty.call(t, 'value')) {
      out[key] = { ...cloneBlock(t), value: val };
      return;
    }

    // Recurse if both are plain objects.
    if (isPlainObject(val) && isPlainObject(t)) {
      out[key] = normalizeOverridesToTemplate(t, val);
    }
  });

  return out;
};

const applyBlockLabel = (block, segmentKey, includeAsOfDate) => {
  const segment = ASSUMPTION_SEGMENTS.find(s => s.key === segmentKey);
  const labeled = { ...block, label: `${segment.label} (${segment.years})` };
  if (includeAsOfDate) labeled.asOfDate = DEFAULT_AS_OF_DATE;
  return labeled;
};

// ============================================
// DEMAND ASSUMPTIONS
// ============================================

/**
 * Workload baselines MUST exist for every block.
 * The UI can still display block-specific baselines, but calculations.js
 * should never see missing workloadBase.
 */
const WORKLOAD_BASE_DEFAULT = {
  // Token LEVEL is rescaled by the month-0 calibration (required = targetRatio ×
  // installed fleet), so only the segment MIX and the growth rates matter here.
  // Mix reflects 2026: coding/agent workloads are now the largest API consumers
  // (OpenRouter: programming >50% of tokens; Anthropic run-rate driven by
  // Claude Code/API), while consumer surfaces (Google 3.2Q tokens/mo incl. AI
  // Overviews, Gemini app 950M MAU, ChatGPT) remain the largest single block.
  inferenceTokensPerMonth: {
    consumer: 225e12,     // 45%
    enterprise: 175e12,   // 35%
    agentic: 100e12       // 20%
  },
  trainingRunsPerMonth: {
    frontier: 3,          // frontier-class runs completing per month, ex-China labs
    midtier: 300          // post-training, RL, fine-tuning, research runs
  },
  // Accelerator-hours per run (not tokens). Sized so training + research is
  // ~38% of the fleet at the start, matching the Excel funding model (42% in
  // 2025 → 38% in 2026). A 2026 frontier run is ~150K accelerators × 4-6 months.
  // Calibration scales training and inference together, so this baseline sets
  // the training share directly: 2.4e9 accelerator-hours/month vs 500T tokens
  // at 30 tok/s ≈ 38% training at the start.
  trainingComputePerRun: {
    frontier: 550e6,
    midtier: 2.5e6
  }
};

const DEMAND_TEMPLATE_YEAR1 = {
  label: SEGMENT_LABELS.year1,
  asOfDate: DEFAULT_AS_OF_DATE,

  workloadBase: cloneBlock(WORKLOAD_BASE_DEFAULT),

  // Growth rates as annual fractions: 1.00 = 100% = 2x, 2.50 = 250% = 3.5x
  // Evidence (Sept 2026 research):
  //   Google surface tokens: 9.7T/mo (May-24) → 480T (May-25, ~50x) → 3.2Q (May-26, ~7x).
  //     Still 3.2Q at the Jul-26 earnings call → current annualized pace ~3-4x.
  //   Google API: 16B → 22B tokens/min in one quarter (~3.6x annualized).
  //   OpenAI API: 6B tokens/min (Oct-25) → 15B (Mar-26), then flat into GPT-5.4.
  //   Revenue cross-check: Anthropic $9B → $65B run-rate (Dec-25 → Jul-26);
  //     OpenAI ~2x YoY to $40B (Aug-26). With blended $/token falling 30-50%/yr,
  //     revenue growth implies token growth of ~5-7x trailing, decelerating.
  // Forward Year 1 blended ≈ 3.6x: consumer slowest, coding/agents fastest.
  // Net compute demand = token growth ÷ software efficiency (model + systems);
  // hardware gains apply only to newly installed accelerators (vintage-tracked).
  inferenceGrowth: {
    consumer: { value: 1.50, confidence: 'medium', source: 'Google surfaces 7x YoY to May-26 but flat May→Jul; Gemini app 950M MAU; ChatGPT consumer growth slowing', historicalRange: [1.00, 4.00] },
    enterprise: { value: 2.50, confidence: 'medium', source: 'Google API ~3.6x annualized (Q1→Q2-26); MSFT Foundry 1T-token customers 4x YoY', historicalRange: [1.50, 5.00] },
    agentic: { value: 5.00, confidence: 'low', source: 'Coding agents: Anthropic run-rate 7x in 7 months; OpenRouter weekly tokens 5x in 6 months', historicalRange: [2.50, 10.00] }
  },

  trainingGrowth: {
    frontier: { value: 2.00, confidence: 'medium', source: 'More frontier labs + bigger clusters; GPT-5/Gemini 2/Claude 4 class runs', historicalRange: [0.50, 4.00] },
    midtier: { value: 1.50, confidence: 'low', source: 'Post-training/RL and fine-tuning now a large compute block; growth slower than frontier', historicalRange: [0.75, 3.00] }
  },

  allocation: {
    dcInferenceShare: { value: 0.60, confidence: 'medium', source: 'Share of inference served from the general datacenter pool; the rest runs on the inference-optimized pool. Training always uses the datacenter pool' }
  },

  // Edge offload: fraction of inference tokens served outside hyperscale
  // datacenters: phones and laptops, Macs, self-hosted small servers, and edge
  // boxes (distributed compute). Edge tokens skip datacenter GPUs, CoWoS, HBM,
  // DC power and cooling, but still draw wafer and DRAM supply and use energy
  // (0.6× datacenter energy per token). The total edge share is capped by
  // TRANSLATION_INTENSITIES.edge.maxShareOfInference; the installed edge fleet
  // ramps toward each block's share over a few months.
  edgeOffload: {
    consumer: { value: 0.02, confidence: 'low', source: 'Apple Intelligence, on-device Gemini Nano; ~2% of consumer tokens on-device in 2026', historicalRange: [0.00, 0.10] },
    enterprise: { value: 0.00, confidence: 'medium', source: 'Enterprise inference is overwhelmingly cloud/on-prem datacenter today', historicalRange: [0.00, 0.05] },
    agentic: { value: 0.00, confidence: 'medium', source: 'Agentic workloads require large context + tool access; edge infeasible near-term', historicalRange: [0.00, 0.03] }
  },

  // Extra tokens-per-request growth on top of inferenceGrowth. Zero for Years
  // 1-5: those growth rates come from MEASURED token counts (Google, OpenAI,
  // OpenRouter), which already include longer reasoning and agent chains.
  // Years 6-20 keep the per-request growth + intensity structure, with intensity
  // raised (Jevons effect: as cost per token falls, agents run longer, more
  // often, with larger contexts), so compute demand keeps outgrowing efficiency
  // and outrunning what the supply chain can build.
  intensityGrowth: {
    value: 0,
    confidence: 'medium',
    source: 'Already embedded in measured token growth (reasoning models, agent loops, tool use)',
    historicalRange: [0, 0.60]
  },

};

/**
 * Build demand blocks for all segments:
 * - Year 1 defines full structure (template).
 * - Year 2-5 clone and tweak growth rates.
 * - Years 6-20 ALSO clone the full structure so workloadBase never disappears.
 */
const buildDemandBlocks = () => {
  const blocks = {};

  // Start from full template for every segment (prevents "0 after Year 5").
  ASSUMPTION_SEGMENTS.forEach((seg, idx) => {
    const base = cloneBlock(DEMAND_TEMPLATE_YEAR1);
    delete base.asOfDate; // only include it for year1 display
    blocks[seg.key] = applyBlockLabel(base, seg.key, idx === 0);
  });

  // Targeted tweaks (only the values that should change by period)
  // Blended token growth, calendar-year averages: 2027 3.1x, 2028 2.7x,
  // 2029 2.6x, 2030 2.4x, 2031 2.0x. The blend runs above the segment rates
  // because agentic work rises from 20% of tokens toward ~75% by Year 5.
  // Better models raise tokens per task (agents, reasoning), so volume keeps
  // compounding even as user growth saturates.
  // Year 2
  blocks.year2.inferenceGrowth.consumer.value = 1.00;   // 2x
  blocks.year2.inferenceGrowth.enterprise.value = 1.50;  // 2.5x
  blocks.year2.inferenceGrowth.agentic.value = 3.00;     // 4x
  blocks.year2.trainingGrowth.frontier.value = 1.50;
  blocks.year2.trainingGrowth.midtier.value = 1.20;
  // Edge offload Year 2: Apple Intelligence / Gemini Nano adoption growing
  blocks.year2.edgeOffload.consumer.value = 0.05;
  blocks.year2.edgeOffload.enterprise.value = 0.01;
  blocks.year2.edgeOffload.agentic.value = 0.0;

  // Year 3
  blocks.year3.inferenceGrowth.consumer.value = 0.9;
  blocks.year3.inferenceGrowth.enterprise.value = 1.3;
  blocks.year3.inferenceGrowth.agentic.value = 2.3;
  blocks.year3.trainingGrowth.frontier.value = 1.3;
  blocks.year3.trainingGrowth.midtier.value = 1.2;
  // Edge offload Year 3: distilled models becoming mainstream on flagships
  blocks.year3.edgeOffload.consumer.value = 0.12;
  blocks.year3.edgeOffload.enterprise.value = 0.03;
  blocks.year3.edgeOffload.agentic.value = 0.01;

  // Year 4
  blocks.year4.inferenceGrowth.consumer.value = 0.7;
  blocks.year4.inferenceGrowth.enterprise.value = 1.1;
  blocks.year4.inferenceGrowth.agentic.value = 1.9;
  blocks.year4.trainingGrowth.frontier.value = 1.0;
  blocks.year4.trainingGrowth.midtier.value = 0.9;
  // Edge offload Year 4: mid-range phones get capable NPUs; enterprise edge pilots
  blocks.year4.edgeOffload.consumer.value = 0.22;
  blocks.year4.edgeOffload.enterprise.value = 0.08;
  blocks.year4.edgeOffload.agentic.value = 0.02;

  // Year 5
  blocks.year5.inferenceGrowth.consumer.value = 0.6;
  blocks.year5.inferenceGrowth.enterprise.value = 1.0;
  blocks.year5.inferenceGrowth.agentic.value = 1.6;
  blocks.year5.trainingGrowth.frontier.value = 0.8;
  blocks.year5.trainingGrowth.midtier.value = 0.7;
  // Edge offload Year 5: most consumer queries handled locally for simple tasks
  blocks.year5.edgeOffload.consumer.value = 0.35;
  blocks.year5.edgeOffload.enterprise.value = 0.15;
  blocks.year5.edgeOffload.agentic.value = 0.05;

  // Years 6-10
  blocks.years6_10.inferenceGrowth.consumer.value = 0.20;
  blocks.years6_10.inferenceGrowth.enterprise.value = 0.30;
  blocks.years6_10.inferenceGrowth.agentic.value = 0.50;
  blocks.years6_10.trainingGrowth.frontier.value = 0.25;
  blocks.years6_10.trainingGrowth.midtier.value = 0.3;
  blocks.years6_10.intensityGrowth.value = 0.25;
  // Edge offload Years 6-10: mature ecosystem, on-device becomes default for simple inference
  blocks.years6_10.edgeOffload.consumer.value = 0.5;
  blocks.years6_10.edgeOffload.enterprise.value = 0.25;
  blocks.years6_10.edgeOffload.agentic.value = 0.1;

  // Years 11-15
  blocks.years11_15.inferenceGrowth.consumer.value = 0.12;
  blocks.years11_15.inferenceGrowth.enterprise.value = 0.18;
  blocks.years11_15.inferenceGrowth.agentic.value = 0.25;
  blocks.years11_15.trainingGrowth.frontier.value = 0.15;
  blocks.years11_15.trainingGrowth.midtier.value = 0.2;
  blocks.years11_15.intensityGrowth.value = 0.26;
  // Edge offload Years 11-15: edge AI pervasive; cloud reserved for frontier/long-context
  blocks.years11_15.edgeOffload.consumer.value = 0.6;
  blocks.years11_15.edgeOffload.enterprise.value = 0.35;
  blocks.years11_15.edgeOffload.agentic.value = 0.15;

  // Years 16-20
  blocks.years16_20.inferenceGrowth.consumer.value = 0.08;
  blocks.years16_20.inferenceGrowth.enterprise.value = 0.10;
  blocks.years16_20.inferenceGrowth.agentic.value = 0.15;
  blocks.years16_20.trainingGrowth.frontier.value = 0.1;
  blocks.years16_20.trainingGrowth.midtier.value = 0.12;
  blocks.years16_20.intensityGrowth.value = 0.26;
  // Edge offload Years 16-20: steady state — cloud for frontier, edge for everything else
  blocks.years16_20.edgeOffload.consumer.value = 0.65;
  blocks.years16_20.edgeOffload.enterprise.value = 0.4;
  blocks.years16_20.edgeOffload.agentic.value = 0.2;

  return blocks;
};

export const DEMAND_ASSUMPTIONS_BASE = buildDemandBlocks();

// ============================================
// EFFICIENCY ASSUMPTIONS
// ============================================

// Efficiency calibration.
// SOFTWARE gains (model + systems) raise tokens per GPU-hour for the WHOLE fleet:
//   softwareGain = (1 / (1 - m)) * (1 + s)
// HARDWARE gains (h, h_memory) apply only to newly installed accelerators; the
// engine tracks the fleet by vintage, so old GPUs keep their install-year
// throughput. kw_growth is the rise in IT power per new accelerator, so
// tokens/kWh of a new vintage grows at (1 + h)(1 + h_memory) / (1 + kw_growth).
//
// Software efficiency ≈ token growth ÷ growth in hardware-adjusted compute
// (H100-equivalents). Net effective-compute demand (tokens ÷ software gain)
// grows ~2.1x in Year 1 and ~2x/yr through Year 5.
// Year 1 is set so net compute demand growth matches observed evidence:
//   tokens ~3.6x ÷ software 1.71x ≈ 2.1x effective compute demand, vs ~2.25x/yr
//   growth in global AI compute (Epoch) with demand still outrunning supply.
//   (Previous 5.25x total efficiency implied demand falling once token growth
//   slowed from ~50x to ~4x, which contradicts every hyperscaler being
//   capacity-constrained through 2026.)
// New-vintage tokens/kWh: 1.75 / 1.20 ≈ 1.46x in Year 1, matching the Excel
//   funding model's frontier path (7 → 11 → 16M tok/kWh, ~1.45-1.57x/yr).
const EFFICIENCY_TEMPLATE_YEAR1 = {
  label: SEGMENT_LABELS.year1,

  modelEfficiency: {
    m_inference: { value: 0.30, confidence: 'medium', source: 'Distillation, MoE, speculative decoding. Net of mix shift toward frontier/reasoning tokens, which use more compute per token', historicalRange: [0.15, 0.55] },
    m_training: { value: 0.25, confidence: 'low', source: 'Optimizer + architecture gains, partly reinvested in bigger runs', historicalRange: [0.10, 0.40] }
  },

  systemsEfficiency: {
    s_inference: { value: 0.20, confidence: 'medium', source: 'Serving stacks (vLLM/TRT-LLM), batching, KV-cache reuse, disaggregated prefill/decode', historicalRange: [0.10, 0.40] },
    s_training: { value: 0.10, confidence: 'medium', source: 'Distributed training, better data pipelines, compiler optimizations', historicalRange: [0.05, 0.25] }
  },

  hardwareEfficiency: {
    h: { value: 0.40, confidence: 'high', source: 'H200/B100/B200 deployment; ~2-4x gen-over-gen for inference', historicalRange: [0.20, 0.50] },
    h_memory: { value: 0.25, confidence: 'medium', source: 'HBM3E, larger capacity stacks', historicalRange: [0.12, 0.35] },
    kw_growth: { value: 0.20, confidence: 'medium', source: 'All-in IT kW per accelerator: HGX H100 1.3-1.4, GB200 1.8-2.0, GB300 2.0-2.2, VR200 2.8-3.4; TPU ~1.1-1.3 and Trainium ~0.9 moderate the blend (2026 ≈ 1.6 kW)', historicalRange: [0.00, 0.35] }
  }
};

const buildEfficiencyBlocks = () => {
  const blocks = {};
  ASSUMPTION_SEGMENTS.forEach((seg) => {
    blocks[seg.key] = applyBlockLabel(cloneBlock(EFFICIENCY_TEMPLATE_YEAR1), seg.key, false);
  });

  // Per-block gains (software = (1/(1-m))(1+s) on the whole fleet; new-vintage
  // tokens/kWh = (1+h)(1+h_memory)/(1+kw_growth)):
  //   Y1 1.71x / 1.46x, Y2 1.40x / 1.40x, Y3 1.29x / 1.34x, Y4 1.23x / 1.31x,
  //   Y5 1.19x / 1.32x, Y6-10 1.27x / 1.23x, Y11-15 1.23x / 1.16x, Y16-20 1.14x / 1.11x
  // Year 2: still strong, decelerating
  blocks.year2.modelEfficiency.m_inference.value = 0.2;
  blocks.year2.modelEfficiency.m_training.value = 0.22;
  blocks.year2.systemsEfficiency.s_inference.value = 0.12;
  blocks.year2.systemsEfficiency.s_training.value = 0.08;
  blocks.year2.hardwareEfficiency.h.value = 0.32;
  blocks.year2.hardwareEfficiency.h_memory.value = 0.22;
  blocks.year2.hardwareEfficiency.kw_growth.value = 0.15;

  // Year 3
  blocks.year3.modelEfficiency.m_inference.value = 0.15;
  blocks.year3.modelEfficiency.m_training.value = 0.15;
  blocks.year3.systemsEfficiency.s_inference.value = 0.1;
  blocks.year3.systemsEfficiency.s_training.value = 0.06;
  blocks.year3.hardwareEfficiency.h.value = 0.25;
  blocks.year3.hardwareEfficiency.h_memory.value = 0.18;
  blocks.year3.hardwareEfficiency.kw_growth.value = 0.10;

  // Year 4: moderating
  blocks.year4.modelEfficiency.m_inference.value = 0.12;
  blocks.year4.modelEfficiency.m_training.value = 0.12;
  blocks.year4.systemsEfficiency.s_inference.value = 0.08;
  blocks.year4.systemsEfficiency.s_training.value = 0.05;
  blocks.year4.hardwareEfficiency.h.value = 0.20;
  blocks.year4.hardwareEfficiency.h_memory.value = 0.15;
  blocks.year4.hardwareEfficiency.kw_growth.value = 0.05;

  // Year 5: settling; kW per accelerator stops rising
  blocks.year5.modelEfficiency.m_inference.value = 0.1;
  blocks.year5.modelEfficiency.m_training.value = 0.1;
  blocks.year5.systemsEfficiency.s_inference.value = 0.07;
  blocks.year5.systemsEfficiency.s_training.value = 0.05;
  blocks.year5.hardwareEfficiency.h.value = 0.18;
  blocks.year5.hardwareEfficiency.h_memory.value = 0.12;
  blocks.year5.hardwareEfficiency.kw_growth.value = 0;

  // Years 6-10: diminishing hardware returns
  blocks.years6_10.modelEfficiency.m_inference.value = 0.15;
  blocks.years6_10.modelEfficiency.m_training.value = 0.08;
  blocks.years6_10.systemsEfficiency.s_inference.value = 0.08;
  blocks.years6_10.systemsEfficiency.s_training.value = 0.04;
  blocks.years6_10.hardwareEfficiency.h.value = 0.12;
  blocks.years6_10.hardwareEfficiency.h_memory.value = 0.10;
  blocks.years6_10.hardwareEfficiency.kw_growth.value = 0;

  // Years 11-15: mature
  blocks.years11_15.modelEfficiency.m_inference.value = 0.12;
  blocks.years11_15.modelEfficiency.m_training.value = 0.05;
  blocks.years11_15.systemsEfficiency.s_inference.value = 0.08;
  blocks.years11_15.systemsEfficiency.s_training.value = 0.03;
  blocks.years11_15.hardwareEfficiency.h.value = 0.08;
  blocks.years11_15.hardwareEfficiency.h_memory.value = 0.07;
  blocks.years11_15.hardwareEfficiency.kw_growth.value = 0;

  // Years 16-20: near-mature
  blocks.years16_20.modelEfficiency.m_inference.value = 0.08;
  blocks.years16_20.modelEfficiency.m_training.value = 0.03;
  blocks.years16_20.systemsEfficiency.s_inference.value = 0.05;
  blocks.years16_20.systemsEfficiency.s_training.value = 0.02;
  blocks.years16_20.hardwareEfficiency.h.value = 0.06;
  blocks.years16_20.hardwareEfficiency.h_memory.value = 0.05;
  blocks.years16_20.hardwareEfficiency.kw_growth.value = 0;

  return blocks;
};

export const EFFICIENCY_ASSUMPTIONS_BASE = buildEfficiencyBlocks();

// ============================================
// SUPPLY ASSUMPTIONS
// ============================================

// Baseline expansion that happens regardless of AI demand. Zero by default:
// capacity grows only when demand signals it (shortages and demand forecasts),
// within lead times, the shared physical pools (EUV wafers, DRAM, and industry
// output of grid connections, turbines, transformers and construction labor),
// the two physical ramp limits (EUV tools, power generation), and the
// builders' capital (funding gate). Any non-zero rate here adds exogenous
// growth on top of the demand-driven expansion.
const BASELINE_SOURCE = 'Baseline non-demand expansion; 0 = growth is demand-driven';
const SUPPLY_TEMPLATE_YEAR1 = {
  label: SEGMENT_LABELS.year1,
  expansionRates: {
    packaging: { value: 0, confidence: 'high', source: BASELINE_SOURCE },
    foundry: { value: 0, confidence: 'high', source: BASELINE_SOURCE },
    memory: { value: 0, confidence: 'high', source: BASELINE_SOURCE },
    datacenter: { value: 0, confidence: 'high', source: BASELINE_SOURCE },
    power: { value: 0, confidence: 'high', source: BASELINE_SOURCE }
  }
};

const buildSupplyBlocks = () => {
  const blocks = {};
  ASSUMPTION_SEGMENTS.forEach((seg) => {
    blocks[seg.key] = applyBlockLabel(cloneBlock(SUPPLY_TEMPLATE_YEAR1), seg.key, false);
  });

  // Zero in every period by default (see SUPPLY_TEMPLATE_YEAR1).

  return blocks;
};

export const SUPPLY_ASSUMPTIONS_BASE = buildSupplyBlocks();

// ============================================
// APPLY JSON OVERRIDES (with normalization)
// ============================================

/**
 * Overrides must be block-keyed ({ year1: {...}, years6_10: {...}, ... }) to
 * match the structures the engine reads. Each block's contents are normalized
 * against that block's base template so numeric shorthand becomes { value }
 * objects. Keys that aren't valid block keys would merge into paths nothing
 * reads, so they are skipped with a warning instead.
 */
const normalizeBlockedOverrides = (baseBlocks, overrides, label) => {
  if (!isPlainObject(overrides)) return {};
  const out = {};
  Object.entries(overrides).forEach(([blockKey, blockOverride]) => {
    if (isPlainObject(baseBlocks[blockKey])) {
      out[blockKey] = normalizeOverridesToTemplate(baseBlocks[blockKey], blockOverride);
    } else {
      console.warn(`Ignoring ${label} override key "${blockKey}": not a valid time block (expected one of ${Object.keys(baseBlocks).join(', ')}).`);
    }
  });
  return out;
};

const DEMAND_OVERRIDES_NORM = normalizeBlockedOverrides(DEMAND_ASSUMPTIONS_BASE, assumptionOverrides?.demand || {}, 'demand');
const EFF_OVERRIDES_NORM = normalizeBlockedOverrides(EFFICIENCY_ASSUMPTIONS_BASE, assumptionOverrides?.efficiency || {}, 'efficiency');
const SUPPLY_OVERRIDES_NORM = normalizeBlockedOverrides(SUPPLY_ASSUMPTIONS_BASE, assumptionOverrides?.supply || {}, 'supply');

export const DEMAND_ASSUMPTIONS = deepMerge(DEMAND_ASSUMPTIONS_BASE, DEMAND_OVERRIDES_NORM);
export const EFFICIENCY_ASSUMPTIONS = deepMerge(EFFICIENCY_ASSUMPTIONS_BASE, EFF_OVERRIDES_NORM);
export const SUPPLY_ASSUMPTIONS = deepMerge(SUPPLY_ASSUMPTIONS_BASE, SUPPLY_OVERRIDES_NORM);

// ============================================
// TRANSLATION INTENSITIES (Physical conversion factors)
// ============================================

export const TRANSLATION_INTENSITIES = {
  // Workloads → Accelerators
  compute: {
    /**
     * effectiveTokensPerSecPerGpu:
     * The PRIMARY inference demand primitive. Reflects real-world serving throughput
     * (memory/bandwidth/KV-cache/latency-SLA constrained), NOT theoretical peak FLOPs.
     *
     * Sanity ranges:
     *   Frontier models, latency-constrained:     ~10-50 tok/s/GPU
     *   Smaller models, high-batch throughput:     ~50-300 tok/s/GPU
     *
     * tokens_per_gpu_month = tok/s/GPU × 2.6e6 s/month
     *   All segments at 30 tok/s ≈ 78M tokens per month-0 frontier accelerator.
     *   The month-0 calibration rescales the token LEVEL, so tok/s mainly sets
     *   the training/inference split.
     */
    effectiveTokensPerSecPerGpu: {
      consumer: { value: 30, confidence: 'medium', source: 'Unified throughput — all inference compute costs the same per token', historicalRange: [20, 80] },
      enterprise: { value: 30, confidence: 'medium', source: 'Unified throughput — segment differences captured in growth rates', historicalRange: [10, 50] },
      agentic: { value: 30, confidence: 'medium', source: 'Unified throughput — extra agentic compute rolled into demand growth', historicalRange: [5, 40] }
    },
    gpuUtilization: {
      // inference utilization is baked into effectiveTokensPerSecPerGpu
      training: 0.85
    }
  },

  // Accelerators → Components
  gpuToComponents: {
    hbmStacksPerGpu: { value: 7, confidence: 'medium', source: 'GB300/Rubin/TPU v7: 8 stacks; MI455X: 12; Trainium/others fewer → blended ~7' },
    cowosWaferEquivPerGpu: { value: 0.075, confidence: 'medium', source: '~12 effective B300/Rubin packages per CoWoS-L wafer (0.083); smaller ASIC interposers fit more → blended ~0.075' },

    hybridBondingPerGpu: { value: 0.35, confidence: 'low', source: 'Hybrid bonding roadmap estimates' },
    hybridBondingAdoption: { initial: 0.02, target: 0.25, halflifeMonths: 36, confidence: 'low', source: 'Adoption curve (share of GPUs using hybrid bonding over time)' },

    advancedWafersPerGpu: { value: 0.06, confidence: 'medium', source: 'B300: two ~800mm² dies, ~22-24 accelerators per wafer (0.045); + Grace/Vera, NVSwitch, NICs ≈ 0.06 (Epoch B200 cost breakdown)' },
    serverDramGbPerGpu: { value: 256, confidence: 'medium', source: 'Grace 480 GB per 2 GPUs; x86 HGX ~2 TB per 8 GPUs; Vera up to 750 GB per GPU' },
    ssdTbPerGpu: { value: 2, confidence: 'medium', source: 'Datacenter NVMe storage per GPU' },
    // Memory per accelerator keeps rising (annual growth per time block). HBM
    // grows through bigger stacks (12-hi 36 GB → 16-hi 48-64 GB), so the stack
    // count per accelerator stays at hbmStacksPerGpu while GB per stack rises;
    // both feed the DRAM wafer ceiling (SHARED_SUPPLY_POOLS.memory).
    memoryContentGrowth: {
      hbmGb: { year1: 0.10, year2: 0.20, year3: 0.20, year4: 0.15, year5: 0.15, years6_10: 0.10, years11_15: 0.07, years16_20: 0.05 },
      hostDramGb: { year1: 0.10, year2: 0.35, year3: 0.20, year4: 0.10, year5: 0.10, years6_10: 0.06, years11_15: 0.04, years16_20: 0.03 },
      source: 'HBM per accelerator: B300/Rubin 288 GB, MI455X 432 GB, TPU v7 192 GB; Rubin Ultra planned 1 TB but mainline SKU may drop to 192 GB on HBM supply (TrendForce, Aug 2026). Host memory: Vera 1.5 TB per CPU (~750 GB per GPU) vs Grace ~240 GB; CSPs adding RDIMM for agentic AI'
    }
  },

  // Servers → Infrastructure
  serverToInfra: {
    gpusPerServer: { value: 8, confidence: 'high' },
    // Opening-fleet IT kW per accelerator. New vintages grow via hardwareEfficiency.kw_growth.
    kwPerGpu: { value: FLEET_ANCHOR.kwPerAccelerator, confidence: 'medium', source: 'Fleet blend: HGX H100 ~1.3 kW, GB200 NVL72 ~1.7 kW per GPU incl. CPU/network; TPU/Trainium lower' },
    pue: { value: 1.3, confidence: 'high', source: 'Hyperscaler PUE' },
    workerMonthsPerMw: { value: 100, confidence: 'medium', source: '~80-150k worker-months per GW IT (Abilene ~6.4k workers, 1.2 GW facility, ~2 yrs; ~12k MEP field hours/MW)' },
    ftesPerMw: { value: 1.0, confidence: 'medium', source: 'Permanent ops staff: Meta Hyperion ~500 operational jobs for 2+ GW; large AI campuses ~0.25-1.5 per MW' },
  },

  powerChain: {
    transformersPerMw: { value: 0.025, confidence: 'medium', source: '~2-3 large power transformers per 100 MW facility with N+1 (CloudHQ 225 MW used 4×100 MVA; ~1.8 MVA/MW)' },
    redundancyFactor: { value: 1.5, confidence: 'high' }
  },

  // Edge inference (phones, PCs, Macs, self-hosted servers). Tokens moved to the
  // edge leave the datacenter (no GPUs, CoWoS, HBM, DC power, cooling,
  // networking) but still need silicon from the SAME wafer and DRAM supply, and
  // still use energy.
  // Edge work is sized in datacenter-equivalent compute units, then:
  //  - wafers/DRAM per unit relative to a datacenter accelerator doing the same
  //    work. ~1x: phone NPUs sit idle ~95% of the time (≈10x more silicon per
  //    token than a DC GPU at ~50% utilization) but run models ~10x smaller.
  //  - phone and PC makers hold long-term wafer/DRAM contracts, so edge demand
  //    is served first, up to maxShareOfSharedSupply (35%) of a shared node's
  //    monthly supply. EUV is not claimed separately: edge wafers already sit
  //    under the EUV-based wafer ceiling.
  //  - energy per token vs the average datacenter token (all-in, incl. cooling):
  //    the SAME model is ~3x less efficient at the edge than batched server
  //    inference (arXiv 2603.23640), ≈2.3x after datacenter PUE. Edge models are
  //    smaller: ~10x for phones (≈0.23x), ~2-3x for Macs and self-hosted
  //    servers (≈0.8-1.1x). Blended ≈0.6x.
  //  - maxShareOfInference caps the total edge share of inference tokens.
  edge: {
    waferIntensityVsDatacenter: { value: 1.0, confidence: 'low', source: 'Low NPU duty cycle offset by much smaller on-device models' },
    dramIntensityVsDatacenter: { value: 1.0, confidence: 'low', source: 'Phone DRAM 8-12 GB → 16-24 GB for on-device models; shares DRAM fabs with servers' },
    energyPerTokenVsDatacenter: { value: 0.6, confidence: 'low', source: 'Same model ~2.3x less efficient at the edge after PUE; edge models smaller (phones ~10x, Macs/self-hosted ~2-3x) → blended ≈0.6x' },
    maxShareOfSharedSupply: { value: 0.35, confidence: 'low', source: 'Edge buyers compete for wafers/DRAM; they can take at most ~35% of the AI-available supply in a month' },
    maxShareOfInference: { value: 0.20, confidence: 'low', source: 'Cap on edge share of all inference tokens: frontier, reasoning and agentic work stays in datacenters' },
    deviceLifeMonths: { value: 36, confidence: 'medium', source: 'Smartphone/PC replacement cycle ~3 years' }
  }
};

// ============================================
// SHARED PHYSICAL SUPPLY POOLS
// ============================================
/**
 * Physical ceilings shared between AI and everything else. Nodes inside a pool
 * (AI wafers, HBM, AI host DRAM) grow with demand; the pool caps them.
 *  - Leading-edge logic: EUV installed base × wafer starts per tool. ASML
 *    deliveries (euv_tools node, ASML's capacity plan) add to the base.
 *    AI may take up to aiMaxShare; phones/PCs/other keep the rest.
 *  - Memory: total DRAM capacity follows the fab construction schedule. HBM
 *    uses ~3x the wafer area per bit of standard DRAM.
 */
export const SHARED_SUPPLY_POOLS = {
  leadingEdge: {
    euvInstalledStart: 320,         // end-2025, summed ASML shipments; TSMC >56%
    logicShareOfEuv: 0.65,          // remainder mostly DRAM
    waferStartsPerToolMonth: 2000,  // N3 ≈ 5-6 tools per 10k wafers/month; N2 ≈ 6-7
    toolProductivityGrowth: 0.05,   // per-tool throughput upgrades, ~5-10%/yr
    aiMaxShare: 0.8,                // AI took ~60% of N3 in 2026, ~86% planned 2027
    source: 'ASML shipments (48 in 2025, ~65 in 2026); TSMC N3/N2 capacity (TrendForce); SemiAnalysis AI share of N3'
  },
  memory: {
    dramGbPerMonthStart: 3.1e9,     // ~37 EB/yr run-rate end-2025 (~40 EB in 2026, TrendForce)
    growthSchedule: [
      { until: 2026, growth: 0.20 },  // Micron ~20% bit growth 2026
      { until: 2027, growth: 0.18 },
      { until: 2030, growth: 0.20 },  // new fabs: SK hynix Yongin/M15X 2027, Micron ID1 2027, ID2 2028, Samsung P5 ~2028, Micron NY ~2030
      { until: 2032, growth: 0.15 },
      { until: 2045, growth: 0.10 }
    ],
    gbPerHbmStack: 36,
    hbmWaferAreaMultiplier: 3,
    aiMaxShare: 0.6,                // AI ≈ 32-36% of DRAM wafer-equivalents in 2026
    source: 'TrendForce DRAM/HBM bit output; memory-maker fab schedules'
  },

  /**
   * Industry pools for power and construction. Each is the WHOLE industry's
   * output (in the AI node's units per month, after `conversion`), growing on
   * its own physical schedule. AI's node grows with demand and can claim up to
   * aiMaxShare of it, so when capital frees up AI can bid for a bigger slice
   * of existing industry output instead of growing from its own small base.
   */
  industry: {
    grid_interconnect: {
      label: 'Grid connection capacity for new large loads',
      industryStart: 2667,            // MW facility/month ≈ 32 GW/yr ex-China (US ~20 GW/yr new large-load/firm capacity; Europe, Gulf, Asia ex-China ~12)
      growthSchedule: [{ until: 2032, growth: 0.12 }, { until: 2045, growth: 0.07 }],
      aiMaxShare: 0.7,                // DCs ≈ 55% of forecast US load growth (Grid Strategies)
      conversion: 1,
      source: 'FERC, Grid Strategies, utility capex +17%/yr (EEI); 2-4 yr transmission/transformer lead times'
    },
    off_grid_power: {
      label: 'Gas turbine, engine and fuel-cell output',
      industryStart: 6667,            // MW nameplate/month ≈ 80 GW/yr (turbines 60-70 + recips/fuel cells ~10)
      growthSchedule: [{ until: 2030, growth: 0.10 }, { until: 2045, growth: 0.05 }],
      aiMaxShare: 0.4,                // DCs compete with utilities and industry for slots
      conversion: 0.7,                // ~1.4 MW nameplate per MW of firm load (N+1 redundancy)
      source: 'GE Vernova 20→30 GW/yr by 2030; Siemens ~15-16 GW, sold out to FY2028; MHI doubling; BNEF ~102 GW/yr by 2030; Caterpillar 3x recips'
    },
    transformers_lpt: {
      label: 'Large power transformer output',
      industryStart: 333,             // units/month ≈ 4,000/yr globally (US ~900/yr demand, ~20% domestic)
      growthSchedule: [{ until: 2030, growth: 0.10 }, { until: 2045, growth: 0.06 }],
      aiMaxShare: 0.4,                // utilities and other industry need most transformers
      conversion: 1,
      source: 'DOE LPT report; Wood Mackenzie 30% deficit; Hitachi/Siemens plant expansions 2027-28'
    },
    dc_construction: {
      label: 'Skilled construction trades in datacenter regions',
      industryStart: 3.0e6,           // workers (worker-months/month): electricians, pipefitters, HVAC in US/Europe/Gulf/Asia ex-China DC regions
      growthSchedule: [{ until: 2032, growth: 0.07 }, { until: 2045, growth: 0.04 }],  // headcount +1-2%/yr plus modular productivity
      aiMaxShare: 0.3,                // ~30% of electricians is the practical limit (SemiAnalysis/BLS arithmetic)
      conversion: 1,
      source: 'BLS: 819k US electricians, +1%/yr; ~12k MEP field hours/MW; modular builds cut field hours 2-3x'
    }
  }
};

// ============================================
// BUILD PIPELINE: FACILITIES, CHIP PROCUREMENT, DEMAND RESPONSE
// ============================================
/**
 * Datacenter facilities are built through an explicit construction pipeline:
 * projects start, are paid for and staffed during construction, and complete
 * on schedule or late. Completed shells wait for power and for chips.
 *
 * Buyers order accelerators for the capacity they are SCHEDULED to energize.
 * When shells or power arrive late, the chips wait in inventory (stranded:
 * bought, not plugged in), and buyers cut new orders until the stock clears.
 *
 * MW here are facility MW (IT × PUE), global ex-China.
 */
const FACILITY_PIPELINE = {
  constructionMonths: 18,           // Goldman: DCs take 18-24 months to build; AI campuses are fast-tracked
  // Share of capacity that completes on schedule (by calendar year of the
  // scheduled completion). The rest slips, on average slipMonthsMean months.
  onTimeShareSchedule: [
    { until: 2028, share: 0.50 },   // Goldman: only ~half of AI capacity scheduled through 2028 on time (50-60% for the next 1-2 years)
    { until: 2045, share: 0.72 }    // Goldman: historical on-time rate ~72%
  ],
  slipMonthsMean: 12,               // delays of 6-24 months are typical (power, equipment, labor, permits)
  // Opening pipeline (under construction at end-2025), scheduled completions.
  // Sized so ACTUAL 2026 completions ≈ 23-25 GW facility (US 16-18 GW gross
  // energizable per Jefferies satellite count ÷ ~0.72 US share) with only
  // half arriving on schedule.
  openingScheduledMW: { firstYear: 34000, nextHalfYear: 20000 },
  openingSlippedMW: 6000,           // 2025-scheduled capacity still unfinished at the start
  openingReadyShellsMW: 0,          // Nadella: short of warm shells, not chips
  // New starts: developers start projects to cover the capacity they expect to
  // need at completion; permitting and site work add a decision lag, and the
  // gap is closed over several months rather than all at once.
  permitLagMonths: 6,
  startSmoothingMonths: 12,
  openingStartsMWPerMonth: 2700,    // starts already decided for the first permitLagMonths (~2025 start pace)
  source: 'Goldman Sachs (on-time rates, 18-24 mo builds); Jefferies/Alphaville satellite count (US 16-18 GW gross energizable in 2026, low twenties in 2027); SemiAnalysis (22 GW US under vertical construction)'
};

const PROCUREMENT = {
  // Buyers take delivery this many months ahead of scheduled energization
  procurementLeadMonths: 3,
  // Extra stock buyers want in hand (precautionary buying / hoarding), in
  // months of expected energization
  hoardMonths: 2,
  // Months over which buyers work excess (or missing) inventory back to target
  inventoryAdjustMonths: 6,
  // Accelerators bought but not energized at the start (IT GW, 2025 vintage)
  openingStrandedGW: 2.0,
  source: 'Nadella (Nov 2025): chips sitting in inventory without warm shells; Morgan Stanley (Aug 2026): 33 GW US power shortfall = 34% of chip demand through 2028'
};

/**
 * How token demand responds when compute stays scarce. Growth rates are
 * calibrated on tokens actually SERVED at the opening shortage; these rules
 * only act when scarcity is worse than that baseline.
 *  - priceElasticity: demand falls as the scarcity price premium rises
 *    (demand ∝ premium^-elasticity, relative to the opening premium).
 *  - unservedHalfLifeMonths: unserved demand beyond the opening shortage
 *    decays with this half-life (users give up or go elsewhere).
 *  - capabilityFeedback: 0 in the base case. Above 0, a build shortfall also
 *    slows demand GROWTH (less compute → slower model progress → weaker
 *    adoption); growth is scaled by (served share vs baseline)^feedback.
 */
const DEMAND_RESPONSE = {
  priceElasticity: 0.5,
  unservedHalfLifeMonths: 6,
  capabilityFeedback: 0,
  source: 'Model design: growth rates are measured on served tokens (see DEMAND_ASSUMPTIONS year 1)'
};

// ============================================
// UNIT COSTS (dollars per input)
// ============================================
/**
 * Prices for every supply-chain input, so spend by input = physical volume ×
 * unit price. Volumes come from the engine (accelerators bought, components
 * per accelerator, facility MW under construction). Prices are January 2026
 * levels (global ex-China, contract not spot), then change at the annual rate
 * for each time block. passThrough: share of the node's scarcity price index
 * (tightness) that shows up in the price actually paid; contracted inputs
 * pass little through.
 *
 * group: compute | network | facility | power (capex), embedded (value inside
 * accelerator prices; not added to totals), opex.
 * basis: perKw (× kW per accelerator bought), perUnit (× node intensity per
 * accelerator bought), perMwFacility (× facility MW paid for during
 * construction), plus special quantity rules noted per input.
 */
const pc = (year1, year2, year3, year4, year5, years6_10, years11_15, years16_20) =>
  ({ year1, year2, year3, year4, year5, years6_10, years11_15, years16_20 });

export const COST_ASSUMPTIONS_BASE = {
  inputs: [
    // --- Compute & servers (paid when accelerators are bought) ---
    {
      id: 'accelerators', label: 'Accelerators ex-HBM (logic, packaging, vendor margin)', group: 'compute', basis: 'perKw',
      unit: '$ per kW', price: 15800, node: 'gpu_datacenter', passThrough: 0.15,
      change: pc(0, 0, -0.03, -0.05, -0.05, -0.06, -0.06, -0.05),
      source: 'Nvidia DC compute ~$300B CY26 + AMD ~$15B + custom ASICs ~$50-65B over ~15.5M ex-China units (JPM 16.3M global) ≈ $25-27k/unit ≈ $18k per kW including HBM; less ~$2.2k/kW of HBM at January prices. $/kW roughly flat per generation (Rubin prices rise with power)'
    },
    {
      id: 'hbm', label: 'HBM memory', group: 'compute', basis: 'perUnit', node: 'hbm_stacks', qtyKey: 'hbm_gb',
      unit: '$ per GB', price: 12, passThrough: 0,
      change: pc(0.25, 0.50, 0, -0.15, -0.10, -0.08, -0.06, -0.05),
      source: 'Passed through at market price. HBM3E ~$11-13/GB early 2026 with ~20% 2026 contract increases; HBM4 ~$550 per 36 GB stack (~$15/GB); Seoul Economic Daily (Jul 2026): HBM4 prices could roughly double in 2027; Nvidia buys below market'
    },
    { id: 'host_cpu', label: 'Host CPUs', group: 'compute', basis: 'perUnit', node: 'cpu_server', unit: '$ per CPU', price: 3000, passThrough: 0.1, change: pc(0, -0.03, -0.05, -0.05, -0.05, -0.05, -0.04, -0.03), source: 'Grace ~$3k; x86 server CPUs $3-8k; blended per AI server CPU' },
    { id: 'host_dram', label: 'Server DRAM', group: 'compute', basis: 'perUnit', node: 'dram_server', unit: '$ per GB', price: 11, passThrough: 0, change: pc(1.00, 0.15, -0.10, -0.25, -0.15, -0.10, -0.08, -0.06), source: '64 GB DDR5 RDIMM contract ~$255 (Q3-25) → ~$873 (Q1-26) → >$1,000 (Q2-26); Citi ~$1,590 by Q4-26 (~$25/GB); TrendForce lifts 4Q26 outlook; SemiAnalysis: double-digit ASP rise again in 2027; Deloitte: crunch may not ease until 2029' },
    { id: 'ssd', label: 'Datacenter SSDs', group: 'compute', basis: 'perUnit', node: 'ssd_datacenter', unit: '$ per TB', price: 120, passThrough: 0, change: pc(1.00, 0, -0.25, -0.20, -0.12, -0.12, -0.10, -0.08), source: 'TrendForce: enterprise SSD contract +53-58% Q1-26, +48-53% Q2, NAND +10-15% Q3 and rising into 4Q26; no new fab supply before 2027' },
    { id: 'nics', label: 'NICs / DPUs', group: 'network', basis: 'perUnit', node: 'dpu_nic', unit: '$ per NIC', price: 1500, passThrough: 0.1, change: pc(0, -0.05, -0.05, -0.05, -0.05, -0.05, -0.04, -0.03), source: 'ConnectX-8 SuperNIC / BlueField ~$1.5-3k; one per accelerator' },
    { id: 'server_assembly', label: 'Server assembly (ODM)', group: 'compute', basis: 'perUnit', node: 'server_assembly', unit: '$ per 8-accelerator server', price: 15000, passThrough: 0.2, change: pc(0, 0, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02), source: 'ODM value-add (boards, chassis, power supplies, integration, margin) ~$30B on ~2M server-equivalents' },
    { id: 'racks', label: 'Racks, PDUs & in-rack power', group: 'compute', basis: 'perUnit', node: 'rack_pdu', unit: '$ per rack', price: 40000, passThrough: 0.2, change: pc(0.05, 0.03, 0, 0, 0, -0.01, -0.01, -0.01), source: 'Rack, busbar, power shelves and PDUs for 40 accelerators' },
    // --- Networking ---
    { id: 'switches', label: 'Switch systems (scale-up & scale-out)', group: 'network', basis: 'perUnit', node: 'switch_asics', unit: '$ per switch ASIC', price: 22000, passThrough: 0.1, change: pc(0, -0.03, -0.05, -0.05, -0.05, -0.05, -0.04, -0.03), source: 'Nvidia networking ~$60B CY26 run-rate + Arista/Celestica/whitebox; NVLink and Ethernet/InfiniBand switch systems' },
    { id: 'optics', label: 'Optical transceivers', group: 'network', basis: 'perUnit', node: 'optical_transceivers', unit: '$ per accelerator-set', price: 1500, passThrough: 0.2, change: pc(0, -0.05, -0.08, -0.08, -0.08, -0.08, -0.06, -0.05), source: "Dell'Oro: AI cluster optics ~$26B in 2026; ~$0.5/Gbps (AOI): 800G ~$400-900, 1.6T ~$700-1,300; 2-3 modules per accelerator" },
    { id: 'cables', label: 'Copper cables & AECs', group: 'network', basis: 'perUnit', node: 'infiniband_cables', unit: '$ per cable', price: 100, passThrough: 0.1, change: pc(0, -0.03, -0.05, -0.05, -0.05, -0.05, -0.04, -0.03), source: 'DAC/AEC per link' },
    // --- Facility (paid over construction) ---
    { id: 'shell_mep', label: 'Shell, MEP & fit-out (incl. field labor)', group: 'facility', basis: 'perMwFacility', node: 'dc_construction', unit: '$ per MW facility', price: 8.5e6, passThrough: 0.2, change: pc(0.06, 0.05, 0.04, 0.03, 0.03, 0.02, 0.02, 0.02), source: 'JLL 2026: shell & core $11.3M/MW (+6%); Cushman & Wakefield 2026: $17.6M/MW fully equipped (+21% since Q4-24); here per MW facility, excluding items priced separately below' },
    { id: 'liquid_cooling', label: 'Liquid cooling (CDUs, cold plates)', group: 'facility', basis: 'coolingPerMwFacility', node: 'liquid_cooling', unit: '$ per CDU-unit (20 accelerators)', price: 14000, passThrough: 0.2, change: pc(0.05, 0.05, 0, -0.02, -0.02, -0.02, -0.02, -0.02), source: 'Tom\'s Hardware: ~$50k cooling per NVL72 rack (~$700 per accelerator), rising to ~$56k for NVL144' },
    // --- Power (paid over construction) ---
    { id: 'transformers', label: 'Large power transformers', group: 'power', basis: 'transformersPerMwFacility', node: 'transformers_lpt', unit: '$ per transformer', price: 4.0e6, passThrough: 0.2, change: pc(0.15, 0.08, 0, -0.02, -0.03, -0.03, -0.02, -0.02), source: 'Substation units $0.15-2M+; LPTs (100+ MVA) several $M; finished-unit costs +30-60% in 2026 (GOES, copper); 128-144 wk lead times' },
    { id: 'backup_power', label: 'Backup power (gensets, UPS, batteries)', group: 'power', basis: 'backupPerMwFacility', node: 'backup_power', unit: '$ per MW backup', price: 0.8e6, passThrough: 0.2, change: pc(0.08, 0.05, 0.02, 0, 0, -0.01, -0.01, -0.01), source: 'Diesel gensets ~$0.5-0.7M/MW plus UPS and batteries; 1.5 MW of backup per MW facility' },
    { id: 'onsite_generation', label: 'On-site generation (turbines, engines)', group: 'power', basis: 'onsitePerMwFacility', node: 'off_grid_power', unit: '$ per MW firm load', price: 3.0e6, passThrough: 0.2, change: pc(0.12, 0.08, 0.03, 0, -0.02, -0.03, -0.02, -0.02), source: 'New gas orders ~$2,000-2,500/kW installed (GE Vernova pricing +10-20 pts in H1-26; WoodMac turbines ~$600/kW by 2027 equipment only); ~1.4 MW nameplate per MW firm' },
    { id: 'grid_connection', label: 'Grid connection (developer-paid)', group: 'power', basis: 'gridPerMwFacility', node: 'grid_interconnect', unit: '$ per MW grid', price: 0.25e6, passThrough: 0.2, change: pc(0.05, 0.05, 0.05, 0.03, 0.03, 0.02, 0.02, 0.02), source: 'Substations and network upgrades ~$100-500/kW where the developer pays (most PJM upgrades are socialized)' },
    // --- Supplier value inside the ex-HBM accelerator price (not added to totals) ---
    { id: 'emb_wafers', label: 'Leading-edge logic wafers', group: 'embedded', basis: 'perUnit', node: 'advanced_wafers', unit: '$ per wafer', price: 20000, passThrough: 0, change: pc(0.05, 0.12, 0.08, 0.05, 0.03, 0.02, 0.02, 0.02), source: 'TSMC N3 ~$20k/wafer (Aug 2026), N2 ~$30k; mix shifts to N2/A16 from 2027' },
    { id: 'emb_cowos', label: 'CoWoS advanced packaging', group: 'embedded', basis: 'perUnit', node: 'cowos_capacity', unit: '$ per wafer-equivalent', price: 10000, passThrough: 0, change: pc(0.05, 0.03, 0, -0.03, -0.03, -0.03, -0.03, -0.02), source: 'TrendForce (Apr 2026): CoWoS wafer ASP nearing 7nm-class levels' },
    { id: 'emb_substrate', label: 'ABF substrates', group: 'embedded', basis: 'perUnit', node: 'abf_substrate', unit: '$ per sqm', price: 15000, passThrough: 0, change: pc(0.05, 0, -0.03, -0.03, -0.03, -0.03, -0.02, -0.02), source: '~$300 of substrate per large accelerator package' },
    { id: 'emb_test', label: 'Final test & assembly (OSAT)', group: 'embedded', basis: 'perUnit', node: 'osat_test', unit: '$ per accelerator', price: 150, passThrough: 0, change: pc(0, 0, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02), source: 'OSAT test/burn-in per accelerator' },
    // --- Operating spend (not capex) ---
    { id: 'electricity', label: 'Datacenter electricity', group: 'opex', basis: 'electricity', unit: '$ per kWh', price: null, passThrough: 0, change: pc(0, 0, 0, 0, 0, 0, 0, 0), source: 'Uses FINANCING_ASSUMPTIONS.scalars.electricityPricePerKwh and average power draw (idle + utilization)' },
    { id: 'ops_staff', label: 'Datacenter operations staff', group: 'opex', basis: 'staff', unit: '$ per FTE-year', price: 180000, passThrough: 0.1, change: pc(0.04, 0.04, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03), source: 'Loaded cost of DC technicians and engineers; ~1 FTE per MW (serverToInfra.ftesPerMw)' }
  ],
  source: 'See each input. Accelerator prices are blended across Nvidia, AMD and custom ASICs; facility prices are global ex-China averages.'
};

// ============================================
// CAPITAL FINANCING (ported from AI_Capex_Funding_Model.xlsx, Sept 2026)
// ============================================
/**
 * Economics + funding layer. The physical engine decides what CAN be built;
 * this layer decides what can be PAID FOR. When applyFundingConstraint is on,
 * each year's fundable capex (by builder tier) is a monthly budget shared by
 * chip purchases and construction payments (rationed proportionally when short).
 *
 * Linked from the physical engine (not inputs here): installed / required /
 * deployed GW, fleet tokens/kWh by vintage, training share, scarcity ratio.
 *
 * Annual paths: the Excel's explicit years (2026-2032) are kept as given;
 * later years extend with the stated rules. When FLEET_ANCHOR rolls forward,
 * update the explicit years to match.
 */
const FIN_YEARS = Array.from({ length: GLOBAL_PARAMS.horizonYears }, (_, i) => MODEL_START_YEAR + i);
const buildPath = (explicit, extend) => {
  const out = {};
  let prev = null;
  FIN_YEARS.forEach((year) => {
    const value = explicit[year] !== undefined ? explicit[year] : extend(year, prev);
    out[year] = value;
    prev = value;
  });
  return out;
};

export const FINANCING_ASSUMPTIONS_BASE = {
  applyFundingConstraint: true,

  // Base year (end of FLEET_ANCHOR year) anchors
  baseYear: {
    blendedPricePerMTokens: 0.55   // $/M tokens, back-solved from ~$65B 2025 AI compute revenue
  },

  // Capex is built bottom-up from COST_ASSUMPTIONS: chips are paid when
  // bought, facilities while under construction. Capex per GW and the compute
  // share of capex are therefore outputs, not inputs.
  scalars: {
    computeLifeYears: 6,           // depreciation life, compute
    facilityLifeYears: 20,         // depreciation life, facility & power
    cashTaxRate: 0.20,
    variableCostPctOfRevenue: 0.30, // lab margin / pass-through, model R&D, SG&A
    otherOpexPerGwYr: 1.2,         // $B per GW-yr: staff, maintenance, network, software
    electricityPricePerKwh: 0.085,
    idlePowerShare: 0.50,          // power draw at zero utilization, share of peak
    scarcityElasticity: 0.50,      // price premium per unit of unmet-demand ratio (prior year)
    maxScarcityPremium: 2.0,
    otherRevenuePerGwYr: 0         // $B, GPU rental / fine-tuning not captured as tokens
  },

  // Multipliers on all capital-markets channel capacity (scenario levers)
  marketCapacityMultiplier: { debt: 1.0, equity: 1.0 },

  paths: {
    // Blended $/M token price change (base path, before scarcity premium)
    priceChange: buildPath(
      { 2026: -0.40, 2027: -0.30, 2028: -0.25, 2029: -0.20, 2030: -0.20, 2031: -0.15, 2032: -0.15 },
      (year) => (year <= 2035 ? -0.12 : -0.10)
    ),
    // Effective utilization of the ENERGIZED fleet (MFU, idle, hoarded
    // capacity). Chips bought but not yet energized are tracked separately.
    utilization: buildPath(
      { 2026: 0.50, 2027: 0.53, 2028: 0.56, 2029: 0.58, 2030: 0.60, 2031: 0.62, 2032: 0.65 },
      (year, prev) => Math.min(0.70, +(prev + 0.01).toFixed(2))
    )
  },

  // Builder tiers. share = base allocation of each year's build (normalized to sum to 1)
  tiers: [
    {
      // Calibrated to Q2-2026 guidance: 2026 capex ~$730B (AMZN ~$220B, GOOGL
      // $195-205B, MSFT ~$175B CY26, META $130-145B), ~90% AI; operating cash
      // flow ~$640B; buybacks + dividends ~$150B; ~1/3 of capex funded
      // externally (bonds, SPVs, Alphabet's 2026 equity raise).
      id: 'A', name: 'Big-4 hyperscalers', note: 'MSFT, GOOGL, AMZN, META',
      share: 0.72, legacyOcf: 520, legacyOcfGrowth: 0.07, shareholderReturns: 150,
      cash: 380, minCash: 150, debt: 260, legacyEbitda: 700, legacyEbitdaGrowth: 0.07,
      maxExternalShareOfCapex: 0.40, costOfDebt: 0.05, maxDebtToEbitda: 1.5
    },
    {
      // Oracle (~$50B), CoreWeave (~$30-35B), xAI (~$30B), other neoclouds and
      // third-party developers of leased AI shells; ~85-90% externally financed
      // (DDTLs, project finance, ABS).
      id: 'B', name: 'Leveraged builders', note: 'Oracle, CoreWeave/Nebius/neoclouds, xAI, DC developers',
      share: 0.22, legacyOcf: 25, legacyOcfGrowth: 0.05, shareholderReturns: 5,
      cash: 40, minCash: 15, debt: 170, legacyEbitda: 40, legacyEbitdaGrowth: 0.05,
      // Contracted-offtake project finance supports ~6x (CoreWeave runs above 6x)
      maxExternalShareOfCapex: 0.88, costOfDebt: 0.09, maxDebtToEbitda: 6.0
    },
    {
      // Stargate UAE, Humain (PIF), G42, SoftBank, EU/Asia sovereign AI
      // (~$50B in 2026), mostly equity-funded.
      id: 'C', name: 'Sovereign & other', note: 'Gulf, SoftBank/Stargate equity, other',
      share: 0.06, legacyOcf: 0, legacyOcfGrowth: 0, shareholderReturns: 0,
      cash: 20, minCash: 5, debt: 10, legacyEbitda: 0, legacyEbitdaGrowth: 0,
      maxExternalShareOfCapex: 0.92, costOfDebt: 0.085, maxDebtToEbitda: 4.0
    }
  ],

  // Capital-markets absorption capacity (AI-available, $B/yr). capacity = first
  // model year; compounds at growth thereafter. alloc = share to tiers A/B/C.
  channels: [
    { id: 'us_ig', name: 'US investment-grade bonds', type: 'debt', capacity: 220, growth: 0.08, alloc: [0.8, 0.2, 0], note: 'Big-5 issued $121B in 2025; order-book coverage fell 5x → <2x Feb→Jul 2026' },
    { id: 'exus_ig', name: 'Ex-US IG bonds (EUR/JPY/CHF)', type: 'debt', capacity: 50, growth: 0.10, alloc: [0.7, 0.3, 0], note: 'Reverse Yankee / Samurai' },
    { id: 'private_credit', name: 'Private credit / direct lending', type: 'debt', capacity: 200, growth: 0.08, alloc: [0.3, 0.6, 0.1], note: 'Morgan Stanley: ~$800B of $1.5T gap through 2028' },
    { id: 'abs', name: 'Data-center ABS / CMBS', type: 'debt', capacity: 35, growth: 0.10, alloc: [0.2, 0.7, 0.1], note: 'JPM $30-40B/yr' },
    { id: 'hy', name: 'Leveraged loans / high yield', type: 'debt', capacity: 25, growth: 0.10, alloc: [0, 0.9, 0.1], note: '9-12.5% coupons' },
    { id: 'converts', name: 'Convertibles', type: 'debt', capacity: 20, growth: 0.05, alloc: [0, 0.9, 0.1], note: 'CRWV converts at 1.75%' },
    { id: 'bank', name: 'Bank loans / project finance', type: 'debt', capacity: 80, growth: 0.06, alloc: [0.3, 0.5, 0.2], note: 'AMZN $17.5B loan; DDTL facilities' },
    { id: 'spv', name: 'SPV / JV / lease financing', type: 'debt', capacity: 120, growth: 0.10, alloc: [0.6, 0.3, 0.1], note: 'Meta Hyperion-style off-balance-sheet' },
    { id: 'public_equity', name: 'Public equity follow-ons / ATM', type: 'equity', capacity: 100, growth: -1.0, alloc: [0.8, 0.2, 0], note: 'Hyperscalers done issuing after 2026 (Alphabet $84.75B Jun-2026)' },
    { id: 'ipo_private', name: 'IPOs & private rounds', type: 'equity', capacity: 80, growth: -0.75, alloc: [0, 0.7, 0.3], note: 'Tail from lab/neocloud rounds only' },
    { id: 'sovereign', name: 'Sovereign wealth', type: 'equity', capacity: 80, growth: -0.50, alloc: [0.1, 0.3, 0.6], note: 'MGX, PIF, QIA, Mubadala; tapering' },
    { id: 'vendor', name: 'Strategic / vendor equity', type: 'equity', capacity: 40, growth: -0.50, alloc: [0.1, 0.6, 0.3], note: 'Circular financing flag (BIS)' }
  ],

  source: 'AI_Capex_Funding_Model.xlsx (Sept 2026 calibration anchors)'
};

// Monthly-updater overrides (assumptionOverrides.json → "financing"). Arrays
// (tiers, channels) are replaced wholesale; objects merge key by key.
export const FINANCING_ASSUMPTIONS = deepMerge(FINANCING_ASSUMPTIONS_BASE, assumptionOverrides?.financing || {});

// Build pipeline, procurement and demand response (assumptionOverrides.json → "build")
export const BUILD_ASSUMPTIONS_BASE = {
  pipeline: FACILITY_PIPELINE,
  procurement: PROCUREMENT,
  demandResponse: DEMAND_RESPONSE
};
export const BUILD_ASSUMPTIONS = deepMerge(BUILD_ASSUMPTIONS_BASE, assumptionOverrides?.build || {});

// Unit costs (assumptionOverrides.json → "costs": { <inputId>: { price, change: { year2: ... } } })
export const COST_ASSUMPTIONS = {
  ...COST_ASSUMPTIONS_BASE,
  inputs: COST_ASSUMPTIONS_BASE.inputs.map((input) => deepMerge(input, assumptionOverrides?.costs?.[input.id] || {}))
};

// ============================================
// SCENARIOS
// ============================================

/**
 * Scenario helper:
 * - Accepts sparse overrides and deep-merges into defaults.
 * - Allows convenient numeric shorthand (normalized later).
 */
const applyOverridesToYears = (overrides = {}) => {
  return FIRST_FIVE_YEAR_KEYS.reduce((acc, key) => {
    acc[key] = overrides;
    return acc;
  }, {});
};

export const SCENARIOS = {
  base: {
    id: 'base',
    name: 'Base Case',
    description: 'Research-based token growth (~3.6x in Year 1, decelerating) with software efficiency ~1.7x in Year 1, sourced physical pools, and the Excel funding model.',
    summary: { demand: 'Base', efficiency: 'Base', supply: 'Base' },
    overrides: {}
  },

  // Demand and efficiency scenarios scale the current base (see
  // applyScenarioScaling in calculations.js), so they stay relative to it.
  highDemandSlowEfficiency: {
    id: 'highDemandSlowEfficiency',
    name: 'High Demand / Slow Efficiency',
    description: 'Token growth multiples 25% above base for five years; software efficiency gains 40% and hardware gains 20% below base.',
    summary: { demand: 'Base × 1.25 per year (Years 1-5)', efficiency: 'Software × 0.6, hardware × 0.8', supply: 'Base' },
    overrides: {
      scaling: {
        tokenGrowth: { factor: 1.25, blocks: FIRST_FIVE_YEAR_KEYS },
        trainingGrowth: { factor: 1.15, blocks: FIRST_FIVE_YEAR_KEYS },
        softwareEfficiency: { factor: 0.6 },
        hardwareEfficiency: { factor: 0.8 }
      }
    }
  },

  highDemandFastEfficiency: {
    id: 'highDemandFastEfficiency',
    name: 'High Demand / Fast Efficiency',
    description: 'Token growth multiples 25% above base for five years, with software efficiency gains 50% and hardware gains 15% above base.',
    summary: { demand: 'Base × 1.25 per year (Years 1-5)', efficiency: 'Software × 1.5, hardware × 1.15', supply: 'Base' },
    overrides: {
      scaling: {
        tokenGrowth: { factor: 1.25, blocks: FIRST_FIVE_YEAR_KEYS },
        trainingGrowth: { factor: 1.15, blocks: FIRST_FIVE_YEAR_KEYS },
        softwareEfficiency: { factor: 1.5 },
        hardwareEfficiency: { factor: 1.15 }
      }
    }
  },

  demandSlowdown: {
    id: 'demandSlowdown',
    name: 'Demand Slowdown (Capex Hangover)',
    description: 'Adoption disappoints: token growth drops to 20-50%/yr for five years, then 10-25%/yr. The opening shortage is built out and overcapacity develops.',
    summary: { demand: '20-50%/yr (Years 1-5), 10-25%/yr (6-10)', efficiency: 'Base', supply: 'Base' },
    overrides: {
      demand: {
        ...applyOverridesToYears({
          inferenceGrowth: { consumer: 0.20, enterprise: 0.30, agentic: 0.50 },
          trainingGrowth: { frontier: 0.10, midtier: 0.25 }
        }),
        years6_10: {
          inferenceGrowth: { consumer: 0.10, enterprise: 0.15, agentic: 0.25 }
        }
      }
    }
  },

  geopoliticalShock: {
    id: 'geopoliticalShock',
    name: 'Geopolitical Shock',
    description: 'Regional disruption in Year 3 halves CoWoS, advanced-wafer and HBM capacity, recovering over three years.',
    summary: { demand: 'Base', efficiency: 'Base', supply: 'CoWoS, wafers, HBM −50% in 2028, 3-yr recovery' },
    overrides: {
      supply: {
        shockMonth: 24,
        affectedNodes: ['cowos_capacity', 'advanced_wafers', 'hbm_stacks'],
        capacityReduction: 0.50,
        recoveryMonths: 36
      }
    }
  },

  creditCrunch: {
    id: 'creditCrunch',
    name: 'Credit Crunch',
    description: 'AI-available debt absorption falls 60% and new equity dries up; hyperscalers become market-limited instead of self-limited.',
    summary: { demand: 'Base', efficiency: 'Base', supply: 'Debt capacity −60%, equity −80%' },
    overrides: {
      financing: {
        marketCapacityMultiplier: { debt: 0.4, equity: 0.2 }
      }
    }
  },

  buildDelays: {
    id: 'buildDelays',
    name: 'Build Delays Slow AI Progress',
    description: 'Only 40% of capacity completes on time through 2030, with slips averaging 15 months; the compute shortfall also slows demand growth (less compute → slower model progress → weaker adoption).',
    summary: { demand: 'Growth slows with the build shortfall (feedback 0.5)', efficiency: 'Base', supply: '40% on time to 2030, 15-month slips' },
    overrides: {
      build: {
        pipeline: { onTimeShareSchedule: [{ until: 2030, share: 0.40 }, { until: 2045, share: 0.72 }], slipMonthsMean: 15 },
        demandResponse: { capabilityFeedback: 0.5 }
      }
    }
  },

  hyperscalerPullback: {
    id: 'hyperscalerPullback',
    name: 'Hyperscaler Pullback',
    description: 'The Big-4 choose to slow the arms race: external funding capped at 20% of capex and shareholder returns raised 50%.',
    summary: { demand: 'Base', efficiency: 'Base', supply: 'Big-4 fundable capex cut (external ≤20%, returns +50%)' },
    overrides: {
      financing: {
        tiers: FINANCING_ASSUMPTIONS_BASE.tiers.map((t) => (t.id === 'A'
          ? { ...t, maxExternalShareOfCapex: 0.20, shareholderReturns: t.shareholderReturns * 1.5 }
          : t))
      }
    }
  },

  tight2026: {
    id: 'tight2026',
    name: '2026 Tight Market',
    description: 'Deeper opening shortage: month-0 demand is 1.8x the installed fleet instead of 1.5x.',
    summary: { demand: 'Opening gap 1.8x installed (base 1.5x)', efficiency: 'Base', supply: 'Base' },
    overrides: {
      calibration: { targetRatio: 1.8 }
    }
  }
};

// ============================================
// EXPORTED HELPERS (used across the app)
// ============================================

/**
 * Get the block index for a given month.
 */
export function getBlockForMonth(month) {
  const index = ASSUMPTION_SEGMENTS.findIndex(
    segment => month >= segment.startMonth && month <= segment.endMonth
  );
  return index === -1 ? ASSUMPTION_SEGMENTS.length - 1 : index;
}

/**
 * Get the block key for a given month.
 */
export function getBlockKeyForMonth(month) {
  const segment = ASSUMPTION_SEGMENTS[getBlockForMonth(month)];
  return segment?.key || ASSUMPTION_SEGMENTS[ASSUMPTION_SEGMENTS.length - 1].key;
}

// Yield models
export function calculateStackedYield(yieldInitial, yieldTarget, halflifeMonths, monthsFromStart) {
  return yieldTarget - (yieldTarget - yieldInitial) * Math.pow(2, -monthsFromStart / halflifeMonths);
}
export function calculateSimpleYield(yieldLoss) { return 1 - yieldLoss; }
