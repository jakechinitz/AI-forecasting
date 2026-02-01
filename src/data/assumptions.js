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

const NOW = new Date();
const CURRENT_YEAR = NOW.getUTCFullYear();
const CURRENT_MONTH = NOW.getUTCMonth() + 1; // 1..12
const START_DATE = new Date(Date.UTC(CURRENT_YEAR, CURRENT_MONTH - 1, 1));
const DEFAULT_AS_OF_DATE = formatAsOfDate(CURRENT_YEAR, CURRENT_MONTH);

export const GLOBAL_PARAMS = {
  // Simulation horizon
  horizonYears: 20,
  startYear: CURRENT_YEAR,
  startMonth: CURRENT_MONTH,

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
    maxDynamicExpansions: 5
  },

  // Inventory display
  inventoryDisplay: {
    forwardMonths: 3
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
  inferenceTokensPerMonth: {
    consumer: 5e12,
    enterprise: 6e12,
    agentic: 1e12
  },
  trainingRunsPerMonth: {
    frontier: 2,
    midtier: 150
  },
  // Assumption is accelerator-hours per run (not tokens)
  trainingComputePerRun: {
    frontier: 50e6,
    midtier: 200000
  },
  continualLearningBase: {
    accelHoursPerMonth: 150000,
    dataTB: 1500,
    networkGbps: 300
  }
};

const DEMAND_TEMPLATE_YEAR1 = {
  label: SEGMENT_LABELS.year1,
  asOfDate: DEFAULT_AS_OF_DATE,

  workloadBase: cloneBlock(WORKLOAD_BASE_DEFAULT),

  inferenceGrowth: {
    consumer: { value: 0.80, confidence: 'medium', source: 'Usage growth + consumer adoption', historicalRange: [0.25, 1.50] },
    enterprise: { value: 1.00, confidence: 'medium', source: 'Enterprise AI adoption + cloud earnings', historicalRange: [0.35, 1.50] },
    agentic: { value: 1.50, confidence: 'low', source: 'Emerging category, rapid adoption from small base', historicalRange: [0.50, 3.00] }
  },

  trainingGrowth: {
    frontier: { value: 0.50, confidence: 'medium', source: 'Supply-constrained demand unlocking', historicalRange: [0.10, 1.00] },
    midtier: { value: 0.80, confidence: 'low', source: 'Fine-tuning proliferation', historicalRange: [0.30, 1.50] }
  },

  contextLength: {
    averageTokens: 4000,
    growthRate: 0.30,
    confidence: 'medium',
    source: 'Model releases, long-context adoption'
  },

  intensityGrowth: {
    value: 0.40,
    confidence: 'medium',
    source: 'Reasoning models, agent loops, tool use',
    historicalRange: [0.25, 0.60]
  },

  continualLearning: {
    computeGrowth: { value: 0.60, confidence: 'medium', source: 'Enterprise fine-tuning adoption' },
    dataStorageGrowth: { value: 0.50, confidence: 'medium', source: 'RAG + checkpoint growth' },
    networkBandwidthGrowth: { value: 0.45, confidence: 'medium', source: 'Distributed training + data movement' },

    adoptionRateBy2030: { value: 0.90, confidence: 'medium', source: 'Fine-tuning ubiquity by 2030' },
    memoryMultiplierAtFullAdoption: { value: 1.6, confidence: 'medium', source: 'Larger working sets + HBM pressure' }
  }
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
  // Year 2: Still high growth but decelerating
  blocks.year2.inferenceGrowth.consumer.value = 0.60;
  blocks.year2.inferenceGrowth.enterprise.value = 0.80;
  blocks.year2.inferenceGrowth.agentic.value = 1.20;
  blocks.year2.trainingGrowth.frontier.value = 0.40;
  blocks.year2.trainingGrowth.midtier.value = 0.60;

  // Year 3: Growth moderating as market matures
  blocks.year3.inferenceGrowth.consumer.value = 0.40;
  blocks.year3.inferenceGrowth.enterprise.value = 0.50;
  blocks.year3.inferenceGrowth.agentic.value = 0.80;
  blocks.year3.trainingGrowth.frontier.value = 0.30;
  blocks.year3.trainingGrowth.midtier.value = 0.40;

  // Year 4: Supply catching up, growth normalizing
  blocks.year4.inferenceGrowth.consumer.value = 0.30;
  blocks.year4.inferenceGrowth.enterprise.value = 0.35;
  blocks.year4.inferenceGrowth.agentic.value = 0.50;
  blocks.year4.trainingGrowth.frontier.value = 0.20;
  blocks.year4.trainingGrowth.midtier.value = 0.30;

  // Year 5: Maturing market
  blocks.year5.inferenceGrowth.consumer.value = 0.20;
  blocks.year5.inferenceGrowth.enterprise.value = 0.25;
  blocks.year5.inferenceGrowth.agentic.value = 0.35;
  blocks.year5.trainingGrowth.frontier.value = 0.15;
  blocks.year5.trainingGrowth.midtier.value = 0.20;

  // Years 6-10
  blocks.years6_10.inferenceGrowth.consumer.value = 0.25;
  blocks.years6_10.inferenceGrowth.enterprise.value = 0.35;
  blocks.years6_10.inferenceGrowth.agentic.value = 0.60;
  blocks.years6_10.trainingGrowth.frontier.value = 0.15;
  blocks.years6_10.trainingGrowth.midtier.value = 0.30;
  blocks.years6_10.contextLength.averageTokens = 16000;
  blocks.years6_10.contextLength.growthRate = 0.20;
  blocks.years6_10.intensityGrowth.value = 0.20;
  blocks.years6_10.continualLearning.computeGrowth.value = 0.40;
  blocks.years6_10.continualLearning.dataStorageGrowth.value = 0.35;
  blocks.years6_10.continualLearning.networkBandwidthGrowth.value = 0.30;

  // Years 11-15
  blocks.years11_15.inferenceGrowth.consumer.value = 0.15;
  blocks.years11_15.inferenceGrowth.enterprise.value = 0.20;
  blocks.years11_15.inferenceGrowth.agentic.value = 0.30;
  blocks.years11_15.trainingGrowth.frontier.value = 0.10;
  blocks.years11_15.trainingGrowth.midtier.value = 0.20;
  blocks.years11_15.contextLength.averageTokens = 32000;
  blocks.years11_15.contextLength.growthRate = 0.10;
  blocks.years11_15.intensityGrowth.value = 0.15;
  blocks.years11_15.continualLearning.computeGrowth.value = 0.25;
  blocks.years11_15.continualLearning.dataStorageGrowth.value = 0.25;
  blocks.years11_15.continualLearning.networkBandwidthGrowth.value = 0.20;

  // Years 16-20
  blocks.years16_20.inferenceGrowth.consumer.value = 0.10;
  blocks.years16_20.inferenceGrowth.enterprise.value = 0.15;
  blocks.years16_20.inferenceGrowth.agentic.value = 0.20;
  blocks.years16_20.trainingGrowth.frontier.value = 0.08;
  blocks.years16_20.trainingGrowth.midtier.value = 0.15;
  blocks.years16_20.contextLength.averageTokens = 64000;
  blocks.years16_20.contextLength.growthRate = 0.05;
  blocks.years16_20.intensityGrowth.value = 0.10;
  blocks.years16_20.continualLearning.computeGrowth.value = 0.15;
  blocks.years16_20.continualLearning.dataStorageGrowth.value = 0.15;
  blocks.years16_20.continualLearning.networkBandwidthGrowth.value = 0.12;

  return blocks;
};

export const DEMAND_ASSUMPTIONS_BASE = buildDemandBlocks();

// ============================================
// EFFICIENCY ASSUMPTIONS
// ============================================

const EFFICIENCY_TEMPLATE_YEAR1 = {
  label: SEGMENT_LABELS.year1,

  modelEfficiency: {
    m_inference: { value: 0.18, confidence: 'medium', source: 'Deployed model efficiency (rollout lag)', historicalRange: [0.10, 0.30] },
    m_training: { value: 0.10, confidence: 'low', source: 'Optimizer + architecture improvements', historicalRange: [0.05, 0.20] }
  },

  systemsEfficiency: {
    s_inference: { value: 0.10, confidence: 'medium', source: 'Batching/scheduling/compiler gains', historicalRange: [0.06, 0.18] },
    s_training: { value: 0.08, confidence: 'medium', source: 'Distributed training optimizations', historicalRange: [0.05, 0.15] }
  },

  hardwareEfficiency: {
    h: { value: 0.15, confidence: 'high', source: 'Blended fleet gen-over-gen', historicalRange: [0.10, 0.25] },
    h_memory: { value: 0.12, confidence: 'medium', source: 'HBM generation improvements', historicalRange: [0.08, 0.20] }
  }
};

const buildEfficiencyBlocks = () => {
  const blocks = {};
  ASSUMPTION_SEGMENTS.forEach((seg) => {
    blocks[seg.key] = applyBlockLabel(cloneBlock(EFFICIENCY_TEMPLATE_YEAR1), seg.key, false);
  });

  // Diminishing returns as horizon extends
  blocks.years6_10.modelEfficiency.m_inference.value = 0.14;
  blocks.years6_10.modelEfficiency.m_training.value = 0.08;
  blocks.years6_10.systemsEfficiency.s_inference.value = 0.08;
  blocks.years6_10.systemsEfficiency.s_training.value = 0.06;
  blocks.years6_10.hardwareEfficiency.h.value = 0.12;
  blocks.years6_10.hardwareEfficiency.h_memory.value = 0.10;

  blocks.years11_15.modelEfficiency.m_inference.value = 0.10;
  blocks.years11_15.modelEfficiency.m_training.value = 0.06;
  blocks.years11_15.systemsEfficiency.s_inference.value = 0.06;
  blocks.years11_15.systemsEfficiency.s_training.value = 0.05;
  blocks.years11_15.hardwareEfficiency.h.value = 0.08;
  blocks.years11_15.hardwareEfficiency.h_memory.value = 0.07;

  blocks.years16_20.modelEfficiency.m_inference.value = 0.08;
  blocks.years16_20.modelEfficiency.m_training.value = 0.05;
  blocks.years16_20.systemsEfficiency.s_inference.value = 0.05;
  blocks.years16_20.systemsEfficiency.s_training.value = 0.04;
  blocks.years16_20.hardwareEfficiency.h.value = 0.06;
  blocks.years16_20.hardwareEfficiency.h_memory.value = 0.05;

  return blocks;
};

export const EFFICIENCY_ASSUMPTIONS_BASE = buildEfficiencyBlocks();

// ============================================
// SUPPLY ASSUMPTIONS
// ============================================

const SUPPLY_TEMPLATE_YEAR1 = {
  label: SEGMENT_LABELS.year1,
  expansionRates: {
    packaging: { value: 0.35, confidence: 'high', source: 'CoWoS expansion plans + OSAT commitments' },
    foundry: { value: 0.15, confidence: 'high', source: 'Advanced-node fab construction schedules' },
    memory: { value: 0.25, confidence: 'medium', source: 'HBM capacity expansion announcements' },
    datacenter: { value: 0.20, confidence: 'medium', source: 'Hyperscaler capex guidance' },
    power: { value: 0.08, confidence: 'medium', source: 'Utility capex + transformer constraints' }
  }
};

const buildSupplyBlocks = () => {
  const blocks = {};
  ASSUMPTION_SEGMENTS.forEach((seg) => {
    blocks[seg.key] = applyBlockLabel(cloneBlock(SUPPLY_TEMPLATE_YEAR1), seg.key, false);
  });

  blocks.years6_10.expansionRates.packaging.value = 0.20;
  blocks.years6_10.expansionRates.foundry.value = 0.10;
  blocks.years6_10.expansionRates.memory.value = 0.18;
  blocks.years6_10.expansionRates.datacenter.value = 0.15;
  blocks.years6_10.expansionRates.power.value = 0.10;

  blocks.years11_15.expansionRates.packaging.value = 0.12;
  blocks.years11_15.expansionRates.foundry.value = 0.08;
  blocks.years11_15.expansionRates.memory.value = 0.12;
  blocks.years11_15.expansionRates.datacenter.value = 0.10;
  blocks.years11_15.expansionRates.power.value = 0.08;

  blocks.years16_20.expansionRates.packaging.value = 0.08;
  blocks.years16_20.expansionRates.foundry.value = 0.05;
  blocks.years16_20.expansionRates.memory.value = 0.08;
  blocks.years16_20.expansionRates.datacenter.value = 0.08;
  blocks.years16_20.expansionRates.power.value = 0.06;

  return blocks;
};

export const SUPPLY_ASSUMPTIONS_BASE = buildSupplyBlocks();

// ============================================
// APPLY JSON OVERRIDES (with normalization)
// ============================================

const DEMAND_OVERRIDES_NORM = normalizeOverridesToTemplate(DEMAND_ASSUMPTIONS_BASE.year1, assumptionOverrides?.demand || {});
const EFF_OVERRIDES_NORM = normalizeOverridesToTemplate(EFFICIENCY_ASSUMPTIONS_BASE.year1, assumptionOverrides?.efficiency || {});
const SUPPLY_OVERRIDES_NORM = normalizeOverridesToTemplate(SUPPLY_ASSUMPTIONS_BASE.year1, assumptionOverrides?.supply || {});

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
      consumer: { value: 40, confidence: 'medium', source: 'Blended model mix (frontier + mid-size), moderate latency', historicalRange: [20, 80] },
      enterprise: { value: 25, confidence: 'medium', source: 'Frontier models, strict enterprise latency SLAs', historicalRange: [10, 50] },
      agentic: { value: 15, confidence: 'low', source: 'Multi-step reasoning, long context, tool use', historicalRange: [5, 40] }
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
    hbmStacksPerGpu: { value: 8, confidence: 'high', source: 'H100/H200 class specs' },
    cowosWaferEquivPerGpu: { value: 0.3, confidence: 'medium', source: 'Package wafer-equivalent normalization' },

    hybridBondingPerGpu: { value: 0.35, confidence: 'low', source: 'Hybrid bonding roadmap estimates' },
    hybridBondingPackageShare: { value: 0.2, confidence: 'low', source: '3D / SoIC penetration assumptions' },
    hybridBondingAdoption: { initial: 0.02, target: 0.25, halflifeMonths: 36, confidence: 'low', source: 'Adoption curve' },

    advancedWafersPerGpu: { value: 0.3, confidence: 'high', source: 'Reticle/multi-die normalization' },
    serverDramGbPerGpu: { value: 128, confidence: 'medium', source: 'System DRAM per GPU (DDR5, 8-channel)' }
  },

  // Servers → Infrastructure
  serverToInfra: {
    gpusPerServer: { value: 8, confidence: 'high' },
    serversPerRack: { value: 4, confidence: 'high' },
    kwPerGpu: { value: 1.0, confidence: 'medium', source: 'GPU + overhead' },
    pue: { value: 1.3, confidence: 'high', source: 'Hyperscaler PUE' }
  },

  powerChain: {
    transformersPerMw: { value: 0.02, confidence: 'medium', source: '~1 LPT / 50 MW' },
    redundancyFactor: { value: 1.5, confidence: 'high' }
  }
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

/**
 * Inherit year1 demand block while allowing partial overrides.
 */
function inheritYear1Demand(overrides = {}) {
  const b0 = DEMAND_ASSUMPTIONS_BASE[FIRST_ASSUMPTION_KEY];
  return deepMerge(cloneBlock(b0), overrides);
}

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

  tight2026: {
    id: 'tight2026',
    name: '2026 Tight Market (Backlog + Allocation)',
    description: 'Sold-out components + large order backlogs; shortages visible immediately.',
    demandAssumptions: inheritYear1Demand({ asOfDate: '2026-01-01' }),
    overrides: {
      startingState: {
        installedBase: 1200000,
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
