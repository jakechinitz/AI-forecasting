/**
 * AI Infrastructure Supply Chain - Assumptions & Base Rates
 *
 * Purpose:
 * - Single source of truth for all user-adjustable assumptions.
 * - Guarantees every time block has required baselines (no "drop to 0" after Year 5).
 * - Normalizes scenario overrides so numbers like { consumer: 0.55 } are treated as { consumer: { value: 0.55 } }.
 *
 * IMPORTANT (Efficiency math conventions used by calculations.js):
 * - Model efficiency M_t = (1 - m)^(t/12)  (compute per unit work decreases)
 * - Systems throughput S_t = (1 + s)^(t/12) (throughput increases)
 * - Hardware throughput H_t = (1 + h)^(t/12) (throughput increases)
 *
 * NOTE:
 * - calculations.js already applies M in the numerator and S/H in the denominator.
 * - This file ensures those values exist for every time block.
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

  // Glut thresholds (can override per node)
  glutThresholds: {
    soft: 0.95,
    hard: 0.80,
    persistenceMonthsSoft: 3,
    persistenceMonthsHard: 2
  },

  // Substitution damping
  substitution: {
    priceSignalSmaMonths: 4,
    adjustmentSpeed: 0.15
  },

  // Capex trigger parameters (kept for UI / future enhancements)
  capexTrigger: {
    priceThreshold: 1.3,
    persistenceMonths: 6,
    maxCapacityAddPct: 0.30,
    cooldownMonths: 12,
    maxExpansions: 6
  },

  // Predictive supply elasticity
  predictiveSupply: {
    forecastHorizonMonths: 6,
    shortageThreshold: 1.0,
    expansionFraction: 0.10,
    cooldownMonths: 12,
    maxDynamicExpansions: 20
  },

  // Inventory display
  inventoryDisplay: {
    forwardMonths: 3
  },

  // Brain power equivalency parameters
  brainEquivalency: {
    humanBrainWatts: 30,              // Human brain power consumption in watts
    startingWattsPerBrainEquiv: 10000, // Starting AI watts per brain-equivalent of cognitive work
    maxEfficiencyVsBrain: 60,         // Asymptote: AI can be at most 10x more efficient than the brain
    // At 10x efficiency, AI does brain-equivalent work at 30W / 10 = 3W
    // 0.5 watts maximum efficiency (thermodynamic limit adjusted for resilency/brittlness)
    minWattsPerBrainEquiv: 0.5          // = humanBrainWatts / maxEfficiencyVsBrain 
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

export const FIRST_ASSUMPTION_KEY = ASSUMPTION_SEGMENTS[0].key;
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
    frontier: 3,          // frontier-class runs completing per month, all labs incl. China
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
    dcInferenceShare: { value: 0.60, confidence: 'medium', source: 'Inference ~60% of datacenter GPU fleet; training clusters concentrated at frontier labs' }
  },

  // Edge offload: fraction of inference tokens served outside hyperscale
  // datacenters: phones and laptops, Macs, self-hosted small servers, and edge
  // boxes (distributed compute). The total edge share is capped by
  // TRANSLATION_INTENSITIES.edge.maxShareOfInference.
  // rather than in datacenter GPUs. Offloaded tokens bypass the entire DC supply chain
  // (no transformers, no cooling, no grid interconnect). Driven by model distillation
  // (Llama-4-Small, Gemma, Phi) running on Apple Neural Engine, Snapdragon NPU, etc.
  edgeOffload: {
    consumer: { value: 0.02, confidence: 'low', source: 'Apple Intelligence, on-device Gemini Nano; ~2% of consumer tokens on-device in 2026', historicalRange: [0.00, 0.10] },
    enterprise: { value: 0.00, confidence: 'medium', source: 'Enterprise inference is overwhelmingly cloud/on-prem datacenter today', historicalRange: [0.00, 0.05] },
    agentic: { value: 0.00, confidence: 'medium', source: 'Agentic workloads require large context + tool access; edge infeasible near-term', historicalRange: [0.00, 0.03] }
  },

  contextLength: {
    averageTokens: 4000,
    growthRate: 0.30,
    confidence: 'medium',
    source: 'Model releases, long-context adoption'
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
  // Token growth decelerates from ~3.6x (Y1) to ~2.6x (Y2), then holds near
  // 2x through Year 5 (≈2.3x, 2.1x, 2.0x), in line with the Excel funding
  // model: better models raise tokens per task (agents, reasoning), so volume
  // keeps compounding even as user growth saturates. Agentic share keeps rising.
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
  blocks.years6_10.contextLength.averageTokens = 32000;
  blocks.years6_10.contextLength.growthRate = 0.25;
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
  blocks.years11_15.contextLength.averageTokens = 64000;
  blocks.years11_15.contextLength.growthRate = 0.12;
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
  blocks.years16_20.contextLength.averageTokens = 128000;
  blocks.years16_20.contextLength.growthRate = 0.05;
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
// (H100-equivalents). It decelerates with token growth: effective compute
// demand grows ~2.1x (Y1), 1.8x, 1.6x, 1.45x, 1.35x (Y5).
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
    m_training: { value: 0.25, confidence: 'low', source: 'Optimizer + architecture gains, partly reinvested in bigger runs (training ~38% of fleet, Excel model)', historicalRange: [0.10, 0.40] }
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

  // Year 2: Still aggressive but decelerating (~3.1x = 67% cost reduction)
  blocks.year2.modelEfficiency.m_inference.value = 0.2;
  blocks.year2.modelEfficiency.m_training.value = 0.22;
  blocks.year2.systemsEfficiency.s_inference.value = 0.12;
  blocks.year2.systemsEfficiency.s_training.value = 0.08;
  blocks.year2.hardwareEfficiency.h.value = 0.32;
  blocks.year2.hardwareEfficiency.h_memory.value = 0.22;
  blocks.year2.hardwareEfficiency.kw_growth.value = 0.15;

  // Year 3: Still strong (~2.5x = 60% cost reduction)
  blocks.year3.modelEfficiency.m_inference.value = 0.15;
  blocks.year3.modelEfficiency.m_training.value = 0.15;
  blocks.year3.systemsEfficiency.s_inference.value = 0.1;
  blocks.year3.systemsEfficiency.s_training.value = 0.06;
  blocks.year3.hardwareEfficiency.h.value = 0.25;
  blocks.year3.hardwareEfficiency.h_memory.value = 0.18;
  blocks.year3.hardwareEfficiency.kw_growth.value = 0.10;

  // Year 4: Moderating (~2.0x = 50% cost reduction)
  blocks.year4.modelEfficiency.m_inference.value = 0.12;
  blocks.year4.modelEfficiency.m_training.value = 0.12;
  blocks.year4.systemsEfficiency.s_inference.value = 0.08;
  blocks.year4.systemsEfficiency.s_training.value = 0.05;
  blocks.year4.hardwareEfficiency.h.value = 0.20;
  blocks.year4.hardwareEfficiency.h_memory.value = 0.15;
  blocks.year4.hardwareEfficiency.kw_growth.value = 0.05;

  // Year 5: Settling (~1.8x = 44% cost reduction)
  blocks.year5.modelEfficiency.m_inference.value = 0.1;
  blocks.year5.modelEfficiency.m_training.value = 0.1;
  blocks.year5.systemsEfficiency.s_inference.value = 0.07;
  blocks.year5.systemsEfficiency.s_training.value = 0.05;
  blocks.year5.hardwareEfficiency.h.value = 0.18;
  blocks.year5.hardwareEfficiency.h_memory.value = 0.12;
  blocks.year5.hardwareEfficiency.kw_growth.value = 0;

  // Years 6-10: Diminishing returns (~1.5x = 33% cost reduction)
  blocks.years6_10.modelEfficiency.m_inference.value = 0.15;
  blocks.years6_10.modelEfficiency.m_training.value = 0.08;
  blocks.years6_10.systemsEfficiency.s_inference.value = 0.08;
  blocks.years6_10.systemsEfficiency.s_training.value = 0.04;
  blocks.years6_10.hardwareEfficiency.h.value = 0.12;
  blocks.years6_10.hardwareEfficiency.h_memory.value = 0.10;
  blocks.years6_10.hardwareEfficiency.kw_growth.value = 0;

  // Years 11-15: Mature (~1.3x = 22% cost reduction)
  blocks.years11_15.modelEfficiency.m_inference.value = 0.12;
  blocks.years11_15.modelEfficiency.m_training.value = 0.05;
  blocks.years11_15.systemsEfficiency.s_inference.value = 0.08;
  blocks.years11_15.systemsEfficiency.s_training.value = 0.03;
  blocks.years11_15.hardwareEfficiency.h.value = 0.08;
  blocks.years11_15.hardwareEfficiency.h_memory.value = 0.07;
  blocks.years11_15.hardwareEfficiency.kw_growth.value = 0;

  // Years 16-20: Near-mature (~1.2x = 15% cost reduction)
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
// within lead times, physical limits (node caps on truly physical inputs and
// the shared EUV/DRAM pools), and the builders' capital (funding gate).
const SUPPLY_TEMPLATE_YEAR1 = {
  label: SEGMENT_LABELS.year1,
  expansionRates: {
    packaging: { value: 0, confidence: 'high', source: 'TSMC doubled CoWoS in 18mo; continued aggressive expansion' },
    foundry: { value: 0, confidence: 'high', source: 'Advanced-node fabs + committed expansions coming online' },
    memory: { value: 0, confidence: 'medium', source: 'HBM revenue 300%+ growth 2024; SK Hynix/Samsung expanding aggressively' },
    datacenter: { value: 0, confidence: 'medium', source: '$6.7T capex through 2030 (McKinsey); hyperscaler $300B+/yr' },
    power: { value: 0, confidence: 'medium', source: 'Key bottleneck; grid interconnection 2-5yr queues; 76GW potential with flexibility' }
  }
};

const buildSupplyBlocks = () => {
  const blocks = {};
  ASSUMPTION_SEGMENTS.forEach((seg) => {
    blocks[seg.key] = applyBlockLabel(cloneBlock(SUPPLY_TEMPLATE_YEAR1), seg.key, false);
  });

  // All periods inherit the Year 1 physical-maximum rates.
  // Actual expansion is demand-driven: the simulation engine scales growth
  // by supply-demand tightness × node elasticity, so these rates act as
  // base inputs to the demand-pull formula rather than a fixed schedule.

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

export const ASSUMPTION_METADATA = {
  asOfDate: DEFAULT_AS_OF_DATE,
  ...(assumptionOverrides?.metadata || {})
};

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
     *   consumer @40 → ~104M tok/GPU-month
     *   enterprise @25 → ~65M tok/GPU-month
     *   agentic @15 → ~39M tok/GPU-month
     */
    effectiveTokensPerSecPerGpu: {
      consumer: { value: 30, confidence: 'medium', source: 'Unified throughput — all inference compute costs the same per token', historicalRange: [20, 80] },
      enterprise: { value: 30, confidence: 'medium', source: 'Unified throughput — segment differences captured in growth rates', historicalRange: [10, 50] },
      agentic: { value: 30, confidence: 'medium', source: 'Unified throughput — extra agentic compute rolled into demand growth', historicalRange: [5, 40] }
    },
    /**
     * flopsPerToken: DEPRECATED for inference GPU demand calculation.
     * Kept for reference and potential use in cost/energy modeling.
     * Inference demand now uses effectiveTokensPerSecPerGpu (above).
     */
    flopsPerToken: {
      value: 140e9,
      confidence: 'medium',
      source: 'Reasoning-heavy inference mix (reference only, not used for GPU demand)',
      historicalRange: [2e9, 2e12]
    },
    gpuUtilization: {
      // inference utilization is now baked into effectiveTokensPerSecPerGpu
      training: 0.85
    },
    acceleratorHoursPerGpu: {
      value: 720,
      unit: 'hours/month'
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
    ssdTbPerGpu: { value: 2, confidence: 'medium', source: 'Datacenter NVMe storage per GPU' }
  },

  // Servers → Infrastructure
  serverToInfra: {
    gpusPerServer: { value: 8, confidence: 'high' },
    serversPerRack: { value: 4, confidence: 'high' },
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

  // Edge inference (phones, PCs, Macs, self-hosted servers). Tokens moved to the edge leave the datacenter
  // (no GPUs, CoWoS, HBM, DC power, cooling, networking) but still need
  // silicon from the SAME wafer, EUV and DRAM supply, and still use energy.
  // Edge work is sized in datacenter-equivalent compute units, then:
  //  - wafers/DRAM per unit relative to a datacenter accelerator doing the same
  //    work. ~1x: phone NPUs sit idle ~95% of the time (≈10x more silicon per
  //    token than a DC GPU at ~50% utilization) but run models ~10x smaller.
  //  - phone makers hold long-term wafer/DRAM contracts, so edge demand is
  //    served before GPUs when these nodes are short.
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
    activeDevices: { value: 8.5e9, growth: 0.02, confidence: 'medium', source: '~7B smartphones + ~1.5B PCs in use (context only)' },
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
  }
};

// ============================================
// CAPITAL FINANCING (ported from AI_Capex_Funding_Model.xlsx, Sept 2026)
// ============================================
/**
 * Economics + funding layer. The physical engine decides what CAN be built;
 * this layer decides what can be PAID FOR. When applyFundingConstraint is on,
 * each year's fundable capex (by builder tier) caps monthly deployments.
 *
 * Linked from the physical engine (not inputs here): installed / required /
 * deployed GW, fleet tokens/kWh by vintage, training share, scarcity ratio.
 *
 * Annual paths: 2026-2032 match the Excel; 2033+ extend with stated rules.
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

  // Base year (end-2025) anchors
  baseYear: {
    blendedPricePerMTokens: 0.55,  // $/M tokens, back-solved from ~$65B 2025 AI compute revenue
    capexPerGw: 45                 // $B per GW energized (IT)
  },

  scalars: {
    preSpendFraction: 0.40,        // share of next year's build paid this year (GPUs ahead of power)
    computeShareOfCapex: 0.65,     // compute & networking share of $/GW (Barclays 65-70%)
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
    // Effective utilization incl. MFU, idle, stranded GPUs awaiting power
    utilization: buildPath(
      { 2026: 0.50, 2027: 0.53, 2028: 0.56, 2029: 0.58, 2030: 0.60, 2031: 0.62, 2032: 0.65 },
      (year, prev) => Math.min(0.70, +(prev + 0.01).toFixed(2))
    ),
    // All-in capex per GW energized ($B)
    capexPerGw: buildPath(
      { 2026: 60, 2027: 62, 2028: 64, 2029: 66, 2030: 68, 2031: 70, 2032: 72 },
      (year, prev) => prev + 1
    )
  },

  // Builder tiers. share = base allocation of each year's build (must sum to 1)
  tiers: [
    {
      id: 'A', name: 'Big-4 hyperscalers', note: 'MSFT, GOOGL, AMZN, META',
      share: 0.68, legacyOcf: 450, legacyOcfGrowth: 0.07, shareholderReturns: 180,
      cash: 380, minCash: 150, debt: 260, legacyEbitda: 620, legacyEbitdaGrowth: 0.07,
      maxExternalShareOfCapex: 0.45, costOfDebt: 0.05, maxDebtToEbitda: 1.5
    },
    {
      id: 'B', name: 'Leveraged builders', note: 'Oracle, CoreWeave/Nebius/neoclouds, xAI',
      share: 0.24, legacyOcf: 25, legacyOcfGrowth: 0.05, shareholderReturns: 5,
      cash: 40, minCash: 15, debt: 170, legacyEbitda: 40, legacyEbitdaGrowth: 0.05,
      maxExternalShareOfCapex: 0.70, costOfDebt: 0.09, maxDebtToEbitda: 4.0
    },
    {
      id: 'C', name: 'Sovereign & other', note: 'Gulf, SoftBank/Stargate equity, other',
      share: 0.08, legacyOcf: 0, legacyOcfGrowth: 0, shareholderReturns: 0,
      cash: 20, minCash: 5, debt: 10, legacyEbitda: 0, legacyEbitdaGrowth: 0,
      maxExternalShareOfCapex: 0.80, costOfDebt: 0.085, maxDebtToEbitda: 4.0
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
    description: 'Balanced growth with moderate efficiency gains',
    overrides: {}
  },

  highDemandSlowEfficiency: {
    id: 'highDemandSlowEfficiency',
    name: 'High Demand / Slow Efficiency',
    description: 'Strong adoption but efficiency gains disappoint',
    overrides: {
      demand: applyOverridesToYears({
        inferenceGrowth: { consumer: 0.55, enterprise: 0.70, agentic: 1.50 },
        trainingGrowth: { frontier: 0.40, midtier: 0.70 }
      }),
      efficiency: applyOverridesToYears({
        modelEfficiency: { m_inference: 0.25, m_training: 0.12 },
        hardwareEfficiency: { h: 0.20 }
      })
    }
  },

  highDemandFastEfficiency: {
    id: 'highDemandFastEfficiency',
    name: 'High Demand / Fast Efficiency',
    description: 'Strong adoption with rapid efficiency improvements',
    overrides: {
      demand: applyOverridesToYears({
        inferenceGrowth: { consumer: 0.55, enterprise: 0.70, agentic: 1.50 }
      }),
      efficiency: applyOverridesToYears({
        modelEfficiency: { m_inference: 0.55, m_training: 0.30 },
        systemsEfficiency: { s_inference: 0.35 },
        hardwareEfficiency: { h: 0.40 }
      })
    }
  },

  demandSlowdown: {
    id: 'demandSlowdown',
    name: 'Demand Slowdown (Capex Hangover)',
    description: 'Adoption disappoints, overcapacity develops',
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
    description: 'Regional supply disruption',
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
    overrides: {
      financing: {
        marketCapacityMultiplier: { debt: 0.4, equity: 0.2 }
      }
    }
  },

  tight2026: {
    id: 'tight2026',
    name: '2026 Tight Market (Backlog + Allocation)',
    description: 'Sold-out components + large order backlogs; shortages visible immediately.',
    overrides: {
      startingState: {
        backlogByNode: {
          gpu_datacenter: 900000,
          hbm_stacks: 7200000,
          cowos_capacity: 270000,
          advanced_wafers: 270000,
          server_assembly: 112500,
          datacenter_mw: 1170
        }
      }
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

/**
 * Interpolate assumption value for a specific month using simple block lookup.
 * If the resolved node is an object with {value}, returns .value.
 */
export function interpolateAssumption(assumptions, month, path) {
  const blockKey = getBlockKeyForMonth(month);
  const block = assumptions[blockKey];

  let value = block;
  for (const key of path) value = value?.[key];

  return (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'value')) ? value.value : value;
}

// Efficiency multipliers
export function calculateMt(m, monthsFromStart) { return Math.pow(1 - m, monthsFromStart / 12); }
export function calculateSt(s, monthsFromStart) { return Math.pow(1 + s, monthsFromStart / 12); }
export function calculateHt(h, monthsFromStart) { return Math.pow(1 + h, monthsFromStart / 12); }

// Yield models
export function calculateStackedYield(yieldInitial, yieldTarget, halflifeMonths, monthsFromStart) {
  return yieldTarget - (yieldTarget - yieldInitial) * Math.pow(2, -monthsFromStart / halflifeMonths);
}
export function calculateSimpleYield(yieldLoss) { return 1 - yieldLoss; }
