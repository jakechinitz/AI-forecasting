/**
 * AI Infrastructure Supply Chain - Assumptions & Base Rates
 *
 * This file defines all user-adjustable assumptions organized into yearly
 * segments for years 1-5 and 5-year blocks thereafter.
 * Historical base rates are documented with sources for transparency.
 *
 * IMPORTANT: Efficiency formulas use the CORRECTED math:
 * - M_t = (1-m)^(t/12)  : Compute per token DECREASES (in numerator)
 * - S_t = (1+s)^(t/12)  : Systems throughput INCREASES (in denominator)
 * - H_t = (1+h)^(t/12)  : Hardware throughput INCREASES (in denominator)
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
const CURRENT_MONTH = NOW.getUTCMonth() + 1;
const START_DATE = new Date(Date.UTC(CURRENT_YEAR, CURRENT_MONTH - 1, 1));
const DEFAULT_AS_OF_DATE = formatAsOfDate(CURRENT_YEAR, CURRENT_MONTH);

export const GLOBAL_PARAMS = {
  // Simulation horizon
  horizonYears: 20,
  startYear: CURRENT_YEAR,
  startMonth: CURRENT_MONTH,

  // Price index shape parameters (global, not per-node)
  priceIndex: {
    a: 2.0,      // Sensitivity to tightness above 1
    b: 1.5,      // Exponent for price response
    minPrice: 0.5,  // Floor (even in glut, price doesn't go to zero)
    maxPrice: 5.0   // Ceiling for extreme shortages
  },

  // Glut thresholds (can override per node)
  glutThresholds: {
    soft: 0.95,           // Pricing softens
    hard: 0.80,           // Capex cuts begin
    persistenceMonthsSoft: 3,
    persistenceMonthsHard: 2
  },

  // Substitution damping
  substitution: {
    priceSignalSmaMonths: 4,  // Smooth price signal
    adjustmentSpeed: 0.15      // Lambda - how fast substitution adjusts
  },

  // Capex trigger parameters
  capexTrigger: {
    priceThreshold: 1.3,      // Price index must exceed this
    persistenceMonths: 6,      // For this many consecutive months
    maxCapacityAddPct: 0.30,   // Cap expansion at 30% of current/year
    cooldownMonths: 12,        // Min months between endogenous triggers per node
    maxExpansions: 6           // Max endogenous expansions per node over full horizon
  },

  // Predictive supply elasticity
  // Simulates firms looking ahead and starting builds before peaks
  predictiveSupply: {
    forecastHorizonMonths: 6,     // Look-ahead window
    shortageThreshold: 1.0,       // Demand/capacity ratio that triggers investment
    expansionFraction: 0.10,      // Fraction of current capacity added per trigger (10%)
    cooldownMonths: 12,           // Min months between dynamic triggers per node
    maxDynamicExpansions: 5       // Max dynamic expansions per node over full horizon
  },

  // Inventory display
  inventoryDisplay: {
    forwardMonths: 3  // Average forward demand for MoS calculation
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

// ============================================
// DEMAND ASSUMPTIONS BY 5-YEAR BLOCK
// ============================================
const DEMAND_YEAR1 = {
  label: SEGMENT_LABELS.year1,
  asOfDate: DEFAULT_AS_OF_DATE,

  // Single source of truth for workload baselines
  // All base rates centralized here; calculations.js reads from this
  workloadBase: {
    inferenceTokensPerMonth: {
      consumer: 5e12,    // 5T tokens/month - ChatGPT/Claude billions of daily tokens
      enterprise: 6e12,  // 6T tokens/month - $37B enterprise AI spend, 3.2x YoY
      agentic: 1e12      // 1T tokens/month - agentic AI in 40% enterprise apps by 2026
    },
    trainingRunsPerMonth: {
      frontier: 1.2,     // ~10-15 frontier runs/year globally
      midtier: 150       // ~100-200 significant runs/month
    },
    trainingComputePerRun: {
      frontier: 1e6,     // 1M accel-hours per frontier run
      midtier: 5000      // 5K accel-hours per mid-tier run
    },
    continualLearningBase: {
      accelHoursPerMonth: 150000,  // 150K accel-hours/month for fine-tuning/RLHF
      dataTB: 1500,                // 1500 TB base storage
      networkGbps: 300             // 300 Gbps base bandwidth
    }
  },

  // Inference demand growth (CAGR)
  inferenceGrowth: {
    consumer: {
      value: 2.00,  // 3x annual growth
      confidence: 'medium',
      source: 'Usage growth + consumer adoption, 2024-2026 trend',
      historicalRange: [0.25, 0.60]
    },
    enterprise: {
      value: 3.00,  // 300% annual growth
      confidence: 'medium',
      source: 'Enterprise AI adoption surveys, cloud earnings',
      historicalRange: [0.35, 0.80]
    },
    agentic: {
      value: 2.50,  // 250% annual growth
      confidence: 'low',
      source: 'Emerging category, high uncertainty',
      historicalRange: [0.50, 2.00]
    }
  },

  // Training demand growth
  trainingGrowth: {
    frontier: {
      value: 3.00,  // 300% more frontier runs per year
      confidence: 'medium',
      source: 'Supply-constrained training demand; increased runs once capacity expands',
      historicalRange: [0.10, 3.00]
    },
    midtier: {
      value: 3.00,  // 300% growth in mid-tier training
      confidence: 'low',
      source: 'Supply-constrained training demand; increased runs once capacity expands',
      historicalRange: [0.30, 3.00]
    }
  },

  // Context length trend (affects memory)
  contextLength: {
    averageTokens: 4000,  // Starting average
    growthRate: 0.30,     // 30% annual increase
    confidence: 'medium',
    source: 'Model releases, long-context adoption'
  },

  // Inference intensity growth (compute per token increases)
  // Captures: longer contexts, multi-step reasoning, agentic loops, tool use
  // Critical for offsetting efficiency gains and keeping GPU demand growing
  intensityGrowth: {
    value: 0.40,  // 40% annual increase in compute per token
    confidence: 'medium',
    source: 'Reasoning models, agent loops, 10-100x tokens per task',
    historicalRange: [0.25, 0.60]
  },

  // Continual Learning demand (fine-tuning, RLHF, RAG updates)
  // Drives compute for training + memory/storage/network for data
  continualLearning: {
    computeGrowth: {
      value: 0.60,  // 60% annual growth in continual learning compute
      confidence: 'medium',
      source: 'Enterprise fine-tuning adoption, RLHF scaling',
      historicalRange: [0.40, 0.80]
    },
    dataStorageGrowth: {
      value: 0.50,  // 50% annual growth in data storage needs
      confidence: 'medium',
      source: 'RAG corpus growth, checkpoint storage'
    },
    networkBandwidthGrowth: {
      value: 0.45,  // 45% annual growth in network bandwidth
      confidence: 'medium',
      source: 'Distributed training, data movement'
    },
    // HBM memory pressure from continual learning adoption
    adoptionRateBy2030: {
      value: 0.90,  // 90% of AI workloads use continual learning by 2030
      confidence: 'medium',
      source: 'Enterprise fine-tuning, RLHF ubiquity'
    },
    memoryMultiplierAtFullAdoption: {
      value: 1.6,  // 60% more HBM per GPU for continual learning
      confidence: 'medium',
      source: 'HBM pressure 20-40% higher in AI workloads; larger working sets'
    }
  }
};

const DEMAND_YEARLY_BLOCKS = FIRST_FIVE_YEAR_KEYS.reduce((acc, key, index) => {
  const segment = ASSUMPTION_SEGMENTS[index];
  acc[key] = {
    ...cloneBlock(DEMAND_YEAR1),
    label: `${segment.label} (${segment.years})`
  };
  if (index > 0) {
    delete acc[key].asOfDate;
  }
  return acc;
}, {});

DEMAND_YEARLY_BLOCKS.year2.inferenceGrowth.consumer.value = 2.00;
DEMAND_YEARLY_BLOCKS.year2.inferenceGrowth.enterprise.value = 3.00;
DEMAND_YEARLY_BLOCKS.year2.inferenceGrowth.agentic.value = 2.00;
DEMAND_YEARLY_BLOCKS.year2.trainingGrowth.frontier.value = 2.00;
DEMAND_YEARLY_BLOCKS.year2.trainingGrowth.midtier.value = 2.00;

DEMAND_YEARLY_BLOCKS.year3.inferenceGrowth.consumer.value = 1.00;
DEMAND_YEARLY_BLOCKS.year3.inferenceGrowth.enterprise.value = 3.00;
DEMAND_YEARLY_BLOCKS.year3.inferenceGrowth.agentic.value = 1.50;
DEMAND_YEARLY_BLOCKS.year3.trainingGrowth.frontier.value = 1.00;
DEMAND_YEARLY_BLOCKS.year3.trainingGrowth.midtier.value = 1.00;

DEMAND_YEARLY_BLOCKS.year4.inferenceGrowth.consumer.value = 0.60;
DEMAND_YEARLY_BLOCKS.year4.inferenceGrowth.enterprise.value = 1.00;
DEMAND_YEARLY_BLOCKS.year4.inferenceGrowth.agentic.value = 0.90;

DEMAND_YEARLY_BLOCKS.year5.inferenceGrowth.consumer.value = 0.50;
DEMAND_YEARLY_BLOCKS.year5.inferenceGrowth.enterprise.value = 1.00;
DEMAND_YEARLY_BLOCKS.year5.inferenceGrowth.agentic.value = 0.70;

export const DEMAND_ASSUMPTIONS_BASE = {
  ...DEMAND_YEARLY_BLOCKS,

  years6_10: {
    label: SEGMENT_LABELS.years6_10,

    inferenceGrowth: {
      consumer: { value: 0.25, confidence: 'low', source: 'Market maturation expected' },
      enterprise: { value: 0.35, confidence: 'low', source: 'Continued enterprise adoption' },
      agentic: { value: 0.60, confidence: 'low', source: 'Agentic becomes mainstream' }
    },

    trainingGrowth: {
      frontier: { value: 0.15, confidence: 'low', source: 'Diminishing returns possible' },
      midtier: { value: 0.30, confidence: 'low', source: 'Steady enterprise demand' }
    },

    contextLength: {
      averageTokens: 16000,
      growthRate: 0.20,
      confidence: 'low'
    },

    intensityGrowth: {
      value: 0.20,  // Moderating intensity growth
      confidence: 'low'
    },

    continualLearning: {
      computeGrowth: { value: 0.40, confidence: 'low' },
      dataStorageGrowth: { value: 0.35, confidence: 'low' },
      networkBandwidthGrowth: { value: 0.30, confidence: 'low' }
    }
  },

  years11_15: {
    label: SEGMENT_LABELS.years11_15,

    inferenceGrowth: {
      consumer: { value: 0.15, confidence: 'low', source: 'Market saturation' },
      enterprise: { value: 0.20, confidence: 'low', source: 'Matured market' },
      agentic: { value: 0.30, confidence: 'low', source: 'Agentic normalized' }
    },

    trainingGrowth: {
      frontier: { value: 0.10, confidence: 'low', source: 'New paradigms unclear' },
      midtier: { value: 0.20, confidence: 'low', source: 'Steady state' }
    },

    contextLength: {
      averageTokens: 32000,
      growthRate: 0.10,
      confidence: 'low'
    },

    intensityGrowth: {
      value: 0.15,  // Slowing intensity growth
      confidence: 'low'
    },

    continualLearning: {
      computeGrowth: { value: 0.25, confidence: 'low' },
      dataStorageGrowth: { value: 0.25, confidence: 'low' },
      networkBandwidthGrowth: { value: 0.20, confidence: 'low' }
    }
  },

  years16_20: {
    label: SEGMENT_LABELS.years16_20,

    inferenceGrowth: {
      consumer: { value: 0.10, confidence: 'low', source: 'Highly uncertain' },
      enterprise: { value: 0.15, confidence: 'low', source: 'Highly uncertain' },
      agentic: { value: 0.20, confidence: 'low', source: 'Highly uncertain' }
    },

    trainingGrowth: {
      frontier: { value: 0.08, confidence: 'low', source: 'Highly uncertain' },
      midtier: { value: 0.15, confidence: 'low', source: 'Highly uncertain' }
    },

    contextLength: {
      averageTokens: 64000,
      growthRate: 0.05,
      confidence: 'low'
    },

    intensityGrowth: {
      value: 0.10,  // Minimal intensity growth in far future
      confidence: 'low'
    },

    continualLearning: {
      computeGrowth: { value: 0.15, confidence: 'low' },
      dataStorageGrowth: { value: 0.15, confidence: 'low' },
      networkBandwidthGrowth: { value: 0.12, confidence: 'low' }
    }
  }
};

// ============================================
// EFFICIENCY ASSUMPTIONS BY 5-YEAR BLOCK
// ============================================
const EFFICIENCY_YEAR1 = {
  label: SEGMENT_LABELS.year1,

  // Model efficiency (compute per token declines)
  // NOTE: These are DEPLOYED efficiency rates, not theoretical peaks.
  // Updated to reflect token efficiency research and real-world propagation lags.
  modelEfficiency: {
    m_inference: {
      value: 0.18,  // 18% annual reduction (deployed systems lag theoretical gains)
      confidence: 'medium',
      source: 'Deployed model efficiency; rollout lag from frontier research',
      historicalRange: [0.10, 0.30]
    },
    m_training: {
      value: 0.10,  // 10% annual reduction in compute per capability
      confidence: 'low',
      source: 'Scaling law efficiency + optimizer improvements',
      historicalRange: [0.05, 0.20]
    }
  },

  // Systems/software throughput improvements
  systemsEfficiency: {
    s_inference: {
      value: 0.10,  // 10% annual throughput gain (deployment-lagged)
      confidence: 'medium',
      source: 'Batching + scheduling + compiler gains (deployed)',
      historicalRange: [0.06, 0.18]
    },
    s_training: {
      value: 0.08,  // 8% annual improvement
      confidence: 'medium',
      source: 'Distributed training optimizations',
      historicalRange: [0.05, 0.15]
    }
  },

  // Hardware throughput improvements (perf/$)
  // H applies to NEW purchases only conceptually, but the model uses it
  // on all demand. 15% is more realistic for blended fleet improvement.
  hardwareEfficiency: {
    h: {
      value: 0.15,  // 15% annual perf/$ improvement (blended fleet)
      confidence: 'high',
      source: 'NVIDIA gen-over-gen; blended fleet effect',
      historicalRange: [0.10, 0.25]
    },
    h_memory: {
      value: 0.12,  // 12% memory bandwidth improvement
      confidence: 'medium',
      source: 'HBM generation improvements',
      historicalRange: [0.08, 0.20]
    }
  }
};

const EFFICIENCY_YEARLY_BLOCKS = FIRST_FIVE_YEAR_KEYS.reduce((acc, key, index) => {
  const segment = ASSUMPTION_SEGMENTS[index];
  acc[key] = {
    ...cloneBlock(EFFICIENCY_YEAR1),
    label: `${segment.label} (${segment.years})`
  };
  return acc;
}, {});

export const EFFICIENCY_ASSUMPTIONS_BASE = {
  /**
   * CORRECTED FORMULAS:
   *
   * M_t (model efficiency - compute per token):
   *   M_t = (1-m)^(t/12) where m = annual improvement rate
   *   This DECREASES over time (good - less compute needed)
   *   Goes in NUMERATOR of demand calculation
   *
   * S_t (systems/software throughput):
   *   S_t = (1+s)^(t/12) where s = annual improvement rate
   *   This INCREASES over time (good - more throughput)
   *   Goes in DENOMINATOR of demand calculation
   *
   * H_t (hardware throughput):
   *   H_t = (1+h)^(t/12) where h = annual improvement rate
   *   This INCREASES over time (good - faster chips)
   *   Goes in DENOMINATOR of demand calculation
   */

  ...EFFICIENCY_YEARLY_BLOCKS,

  years6_10: {
    label: SEGMENT_LABELS.years6_10,

    modelEfficiency: {
      m_inference: { value: 0.14, confidence: 'low', source: 'Diminishing returns expected' },
      m_training: { value: 0.08, confidence: 'low', source: 'Architecture maturation' }
    },

    systemsEfficiency: {
      s_inference: { value: 0.08, confidence: 'low', source: 'Continued optimization' },
      s_training: { value: 0.06, confidence: 'low', source: 'Distributed training matures' }
    },

    hardwareEfficiency: {
      h: { value: 0.12, confidence: 'low', source: 'Moore\'s law slowing' },
      h_memory: { value: 0.10, confidence: 'low', source: 'Memory scaling challenges' }
    }
  },

  years11_15: {
    label: SEGMENT_LABELS.years11_15,

    modelEfficiency: {
      m_inference: { value: 0.10, confidence: 'low', source: 'Highly uncertain' },
      m_training: { value: 0.06, confidence: 'low', source: 'Highly uncertain' }
    },

    systemsEfficiency: {
      s_inference: { value: 0.06, confidence: 'low', source: 'Highly uncertain' },
      s_training: { value: 0.05, confidence: 'low', source: 'Highly uncertain' }
    },

    hardwareEfficiency: {
      h: { value: 0.08, confidence: 'low', source: 'Post-Moore era' },
      h_memory: { value: 0.07, confidence: 'low', source: 'New memory tech unclear' }
    }
  },

  years16_20: {
    label: SEGMENT_LABELS.years16_20,

    modelEfficiency: {
      m_inference: { value: 0.08, confidence: 'low', source: 'Highly uncertain' },
      m_training: { value: 0.05, confidence: 'low', source: 'Highly uncertain' }
    },

    systemsEfficiency: {
      s_inference: { value: 0.05, confidence: 'low', source: 'Highly uncertain' },
      s_training: { value: 0.04, confidence: 'low', source: 'Highly uncertain' }
    },

    hardwareEfficiency: {
      h: { value: 0.06, confidence: 'low', source: 'Speculative' },
      h_memory: { value: 0.05, confidence: 'low', source: 'Speculative' }
    }
  }
};

// ============================================
// SUPPLY ASSUMPTIONS BY 5-YEAR BLOCK
// ============================================
const SUPPLY_YEAR1 = {
  label: SEGMENT_LABELS.year1,

  // Capacity expansion rates by node group
  expansionRates: {
    packaging: {
      value: 0.35,  // 35% annual capacity growth
      confidence: 'high',
      source: 'TSMC CoWoS expansion plans, Amkor commitments'
    },
    foundry: {
      value: 0.15,  // 15% annual advanced node growth
      confidence: 'high',
      source: 'TSMC fab construction schedule'
    },
    memory: {
      value: 0.25,  // 25% HBM capacity growth
      confidence: 'medium',
      source: 'SK Hynix, Samsung expansion announcements'
    },
    datacenter: {
      value: 0.20,  // 20% DC capacity growth
      confidence: 'medium',
      source: 'Hyperscaler capex guidance'
    },
    power: {
      value: 0.08,  // 8% grid/transformer capacity growth
      confidence: 'medium',
      source: 'Utility capex plans, DOE reports'
    }
  }
};

const SUPPLY_YEARLY_BLOCKS = FIRST_FIVE_YEAR_KEYS.reduce((acc, key, index) => {
  const segment = ASSUMPTION_SEGMENTS[index];
  acc[key] = {
    ...cloneBlock(SUPPLY_YEAR1),
    label: `${segment.label} (${segment.years})`
  };
  return acc;
}, {});

export const SUPPLY_ASSUMPTIONS_BASE = {
  ...SUPPLY_YEARLY_BLOCKS,

  years6_10: {
    label: SEGMENT_LABELS.years6_10,
    expansionRates: {
      packaging: { value: 0.20, confidence: 'low' },
      foundry: { value: 0.10, confidence: 'low' },
      memory: { value: 0.18, confidence: 'low' },
      datacenter: { value: 0.15, confidence: 'low' },
      power: { value: 0.10, confidence: 'low' }
    }
  },

  years11_15: {
    label: SEGMENT_LABELS.years11_15,
    expansionRates: {
      packaging: { value: 0.12, confidence: 'low' },
      foundry: { value: 0.08, confidence: 'low' },
      memory: { value: 0.12, confidence: 'low' },
      datacenter: { value: 0.10, confidence: 'low' },
      power: { value: 0.08, confidence: 'low' }
    }
  },

  years16_20: {
    label: SEGMENT_LABELS.years16_20,
    expansionRates: {
      packaging: { value: 0.08, confidence: 'low' },
      foundry: { value: 0.05, confidence: 'low' },
      memory: { value: 0.08, confidence: 'low' },
      datacenter: { value: 0.08, confidence: 'low' },
      power: { value: 0.06, confidence: 'low' }
    }
  }
};

export const DEMAND_ASSUMPTIONS = deepMerge(
  DEMAND_ASSUMPTIONS_BASE,
  assumptionOverrides?.demand
);

export const EFFICIENCY_ASSUMPTIONS = deepMerge(
  EFFICIENCY_ASSUMPTIONS_BASE,
  assumptionOverrides?.efficiency
);

export const SUPPLY_ASSUMPTIONS = deepMerge(
  SUPPLY_ASSUMPTIONS_BASE,
  assumptionOverrides?.supply
);

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
    flopsPerToken: {
      value: 2e9,  // 2 GFLOP per token (varies by model)
      confidence: 'medium',
      source: 'Model architecture analysis',
      historicalRange: [5e8, 1e10]
    },
    gpuUtilization: {
      inference: 0.60,  // 60% average utilization
      training: 0.85    // 85% for training
    },
    acceleratorHoursPerGpu: {
      value: 720,  // Hours per month
      unit: 'hours/month'
    }
  },

  // Accelerators → Components
  gpuToComponents: {
    hbmStacksPerGpu: {
      value: 8,  // H100/H200 have 8 stacks
      confidence: 'high',
      source: 'NVIDIA specs'
    },
    cowosWaferEquivPerGpu: {
      value: 0.3,  // ~3.3 GPUs per CoWoS wafer-equiv (package vs wafer-adjusted)
      confidence: 'medium',
      source: 'Die size analysis, wafer-equivalent normalization'
    },
    hybridBondingPerGpu: {
      value: 1.0,  // Wafer-equiv per GPU if fully adopted
      confidence: 'low',
      source: 'Hybrid bonding roadmap estimates'
    },
    hybridBondingAdoption: {
      initial: 0.05,  // 5% of GPUs using hybrid bonding in early ramp
      target: 0.6,    // 60% adoption at maturity
      halflifeMonths: 30,
      confidence: 'low',
      source: 'Advanced packaging adoption curves'
    },
    advancedWafersPerGpu: {
      value: 0.5,  // Logic die
      confidence: 'high',
      source: 'Reticle limit analysis'
    },
    serverDramGbPerGpu: {
      value: 64,  // 64GB system DRAM per GPU
      confidence: 'medium'
    }
  },

  // Servers → Infrastructure
  serverToInfra: {
    gpusPerServer: {
      value: 8,  // DGX/HGX style
      confidence: 'high'
    },
    serversPerRack: {
      value: 4,  // Dense GPU racks
      confidence: 'high'
    },
    kwPerGpu: {
      value: 1.0,  // 1kW per GPU including overhead
      confidence: 'medium',
      source: 'H100 TDP + infrastructure overhead'
    },
    pue: {
      value: 1.3,  // Modern efficient DC
      confidence: 'high',
      source: 'Hyperscaler efficiency reports'
    }
  },

  // Power chain
  powerChain: {
    transformersPerMw: {
      value: 0.02,  // 1 LPT per 50MW
      confidence: 'medium',
      source: 'Utility infrastructure norms'
    },
    redundancyFactor: {
      value: 1.5,  // N+1 for critical power
      confidence: 'high'
    }
  }
};

// ============================================
// SCENARIO DEFINITIONS
// ============================================
/**
 * Scenario inheritance helper - deep-merges overrides into year 1 defaults
 * Ensures scenarios don't duplicate year 1 and only override what's different
 */
function inheritYear1(overrides = {}) {
  const b0 = DEMAND_ASSUMPTIONS[FIRST_ASSUMPTION_KEY];
  return {
    ...b0,
    ...overrides,
    workloadBase: {
      ...b0.workloadBase,
      ...(overrides.workloadBase || {}),
      inferenceTokensPerMonth: {
        ...b0.workloadBase.inferenceTokensPerMonth,
        ...(overrides.workloadBase?.inferenceTokensPerMonth || {})
      },
      trainingRunsPerMonth: {
        ...b0.workloadBase.trainingRunsPerMonth,
        ...(overrides.workloadBase?.trainingRunsPerMonth || {})
      },
      continualLearningBase: {
        ...b0.workloadBase.continualLearningBase,
        ...(overrides.workloadBase?.continualLearningBase || {})
      }
    }
  };
}

function applyOverridesToYears(overrides = {}) {
  return FIRST_FIVE_YEAR_KEYS.reduce((acc, key) => {
    acc[key] = overrides;
    return acc;
  }, {});
}

export const SCENARIOS = {
  base: {
    id: 'base',
    name: 'Base Case',
    description: 'Balanced growth with moderate efficiency gains',
    overrides: {}  // Uses default assumptions
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
    description: 'Regional supply disruption (Taiwan scenario)',
    overrides: {
      supply: {
        shockMonth: 24,  // Shock occurs at month 24
        affectedNodes: ['cowos_capacity', 'advanced_wafers', 'hbm_stacks'],
        capacityReduction: 0.50,  // 50% reduction
        recoveryMonths: 36        // 3 years to recover
      }
    }
  },

  tight2026: {
    id: 'tight2026',
    name: '2026 Tight Market (Backlog + Allocation)',
    description: 'Sold-out components + large order backlogs; shortages visible immediately. ' +
      'Reflects Jan 2026 market: HBM sold out, CoWoS at capacity, GPU backlog ~900K.',
    demandAssumptions: inheritYear1({ asOfDate: '2026-01-01' }),
    overrides: {
      startingState: {
        backlogByNode: {
          gpu_datacenter: 900000,   // ~900K GPU order backlog
          hbm_stacks: 7200000,     // 900K GPUs × 8 stacks = 7.2M stacks backlog
          cowos_capacity: 270000,  // 900K GPUs × 0.3 wafer-equiv = 270K wafer backlog
          server_assembly: 112500, // 900K / 8 GPUs per server
          datacenter_mw: 900       // 900K GPUs × 0.001 MW
        }
      }
    }
  }
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get the block index for a given month
 */
export function getBlockForMonth(month) {
  const index = ASSUMPTION_SEGMENTS.findIndex(
    segment => month >= segment.startMonth && month <= segment.endMonth
  );
  return index === -1 ? ASSUMPTION_SEGMENTS.length - 1 : index;
}

/**
 * Get the block key for a given month
 */
export function getBlockKeyForMonth(month) {
  const segment = ASSUMPTION_SEGMENTS[getBlockForMonth(month)];
  return segment?.key || ASSUMPTION_SEGMENTS[ASSUMPTION_SEGMENTS.length - 1].key;
}

/**
 * Interpolate assumption value for a specific month using CAGR within blocks
 */
export function interpolateAssumption(assumptions, month, path) {
  const blockKey = getBlockKeyForMonth(month);
  const block = assumptions[blockKey];

  // Navigate the path to get the value
  let value = block;
  for (const key of path) {
    value = value?.[key];
  }

  return typeof value === 'object' ? value.value : value;
}

/**
 * Calculate efficiency multiplier M_t (model efficiency - decays)
 */
export function calculateMt(m, monthsFromStart) {
  return Math.pow(1 - m, monthsFromStart / 12);
}

/**
 * Calculate efficiency multiplier S_t (systems throughput - grows)
 */
export function calculateSt(s, monthsFromStart) {
  return Math.pow(1 + s, monthsFromStart / 12);
}

/**
 * Calculate efficiency multiplier H_t (hardware throughput - grows)
 */
export function calculateHt(h, monthsFromStart) {
  return Math.pow(1 + h, monthsFromStart / 12);
}

/**
 * Calculate stacked yield for HBM
 * Y_stack(t) = Y_target - (Y_target - Y_initial) * 2^(-t/HL)
 */
export function calculateStackedYield(yieldInitial, yieldTarget, halflifeMonths, monthsFromStart) {
  return yieldTarget - (yieldTarget - yieldInitial) * Math.pow(2, -monthsFromStart / halflifeMonths);
}

/**
 * Calculate simple yield
 */
export function calculateSimpleYield(yieldLoss) {
  return 1 - yieldLoss;
}
