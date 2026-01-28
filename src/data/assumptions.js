/**
 * AI Infrastructure Supply Chain - Assumptions & Base Rates
 *
 * This file defines all user-adjustable assumptions organized into 5-year blocks.
 * Historical base rates are documented with sources for transparency.
 *
 * IMPORTANT: Efficiency formulas use the CORRECTED math:
 * - M_t = (1-m)^(t/12)  : Compute per token DECREASES (in numerator)
 * - S_t = (1+s)^(t/12)  : Systems throughput INCREASES (in denominator)
 * - H_t = (1+h)^(t/12)  : Hardware throughput INCREASES (in denominator)
 */

// ============================================
// GLOBAL MODEL PARAMETERS
// ============================================
export const GLOBAL_PARAMS = {
  // Simulation horizon
  horizonYears: 20,
  startYear: 2025,
  startMonth: 1,

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
    maxCapacityAddPct: 0.30    // Cap expansion at 30% of current/year
  },

  // Inventory display
  inventoryDisplay: {
    forwardMonths: 3  // Average forward demand for MoS calculation
  }
};

// ============================================
// DEMAND ASSUMPTIONS BY 5-YEAR BLOCK
// ============================================
export const DEMAND_ASSUMPTIONS = {
  // Block 0: Years 0-5 (2025-2030)
  block0: {
    label: 'Years 0-5 (2025-2030)',

    // Inference demand growth (CAGR)
    inferenceGrowth: {
      consumer: {
        value: 0.40,  // 40% annual growth
        confidence: 'medium',
        source: 'ChatGPT/Claude growth trajectory, mobile adoption',
        historicalRange: [0.25, 0.60]
      },
      enterprise: {
        value: 0.55,  // 55% annual growth
        confidence: 'medium',
        source: 'Enterprise AI adoption surveys, cloud earnings',
        historicalRange: [0.35, 0.80]
      },
      agentic: {
        value: 1.00,  // 100% annual growth (doubling)
        confidence: 'low',
        source: 'Emerging category, high uncertainty',
        historicalRange: [0.50, 2.00]
      }
    },

    // Training demand growth
    trainingGrowth: {
      frontier: {
        value: 0.25,  // 25% more frontier runs per year
        confidence: 'medium',
        source: 'Scaling law research, lab announcements',
        historicalRange: [0.10, 0.50]
      },
      midtier: {
        value: 0.50,  // 50% growth in mid-tier training
        confidence: 'low',
        source: 'Fine-tuning demand, enterprise custom models',
        historicalRange: [0.30, 0.80]
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
    // This partially offsets efficiency gains to keep required GPU base growing
    intensityGrowth: {
      value: 0.25,  // 25% annual increase in compute per token
      confidence: 'medium',
      source: 'Context scaling, chain-of-thought, agent loops',
      historicalRange: [0.15, 0.40]
    }
  },

  // Block 1: Years 5-10 (2030-2035)
  block1: {
    label: 'Years 5-10 (2030-2035)',

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
    }
  },

  // Block 2: Years 10-15 (2035-2040)
  block2: {
    label: 'Years 10-15 (2035-2040)',

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
    }
  },

  // Block 3: Years 15-20 (2040-2045)
  block3: {
    label: 'Years 15-20 (2040-2045)',

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
    }
  }
};

// ============================================
// EFFICIENCY ASSUMPTIONS BY 5-YEAR BLOCK
// ============================================
export const EFFICIENCY_ASSUMPTIONS = {
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

  block0: {
    label: 'Years 0-5 (2025-2030)',

    // Model efficiency (compute per token declines)
    modelEfficiency: {
      m_inference: {
        value: 0.40,  // 40% annual reduction in compute per token
        confidence: 'medium',
        source: 'GPT-4 to GPT-4o-mini trajectory, distillation gains',
        historicalRange: [0.25, 0.60]
      },
      m_training: {
        value: 0.20,  // 20% annual reduction in compute per capability
        confidence: 'low',
        source: 'Chinchilla-optimal training, architecture improvements',
        historicalRange: [0.10, 0.35]
      }
    },

    // Systems/software throughput improvements
    systemsEfficiency: {
      s_inference: {
        value: 0.25,  // 25% annual throughput gain from batching, scheduling
        confidence: 'medium',
        source: 'vLLM, continuous batching, speculative decoding',
        historicalRange: [0.15, 0.40]
      },
      s_training: {
        value: 0.15,  // 15% annual improvement
        confidence: 'medium',
        source: 'Distributed training optimizations',
        historicalRange: [0.10, 0.25]
      }
    },

    // Hardware throughput improvements (perf/$)
    hardwareEfficiency: {
      h: {
        value: 0.30,  // 30% annual perf/$ improvement
        confidence: 'high',
        source: 'NVIDIA generation-over-generation gains',
        historicalRange: [0.20, 0.45]
      },
      h_memory: {
        value: 0.25,  // 25% memory bandwidth improvement
        confidence: 'medium',
        source: 'HBM generation improvements',
        historicalRange: [0.15, 0.35]
      }
    }
  },

  block1: {
    label: 'Years 5-10 (2030-2035)',

    modelEfficiency: {
      m_inference: { value: 0.30, confidence: 'low', source: 'Diminishing returns expected' },
      m_training: { value: 0.15, confidence: 'low', source: 'Architecture maturation' }
    },

    systemsEfficiency: {
      s_inference: { value: 0.20, confidence: 'low', source: 'Continued optimization' },
      s_training: { value: 0.12, confidence: 'low', source: 'Distributed training matures' }
    },

    hardwareEfficiency: {
      h: { value: 0.20, confidence: 'low', source: 'Moore\'s law slowing' },
      h_memory: { value: 0.18, confidence: 'low', source: 'Memory scaling challenges' }
    }
  },

  block2: {
    label: 'Years 10-15 (2035-2040)',

    modelEfficiency: {
      m_inference: { value: 0.20, confidence: 'low', source: 'Highly uncertain' },
      m_training: { value: 0.10, confidence: 'low', source: 'Highly uncertain' }
    },

    systemsEfficiency: {
      s_inference: { value: 0.15, confidence: 'low', source: 'Highly uncertain' },
      s_training: { value: 0.10, confidence: 'low', source: 'Highly uncertain' }
    },

    hardwareEfficiency: {
      h: { value: 0.15, confidence: 'low', source: 'Post-Moore era' },
      h_memory: { value: 0.12, confidence: 'low', source: 'New memory tech unclear' }
    }
  },

  block3: {
    label: 'Years 15-20 (2040-2045)',

    modelEfficiency: {
      m_inference: { value: 0.15, confidence: 'low', source: 'Highly uncertain' },
      m_training: { value: 0.08, confidence: 'low', source: 'Highly uncertain' }
    },

    systemsEfficiency: {
      s_inference: { value: 0.10, confidence: 'low', source: 'Highly uncertain' },
      s_training: { value: 0.08, confidence: 'low', source: 'Highly uncertain' }
    },

    hardwareEfficiency: {
      h: { value: 0.10, confidence: 'low', source: 'Speculative' },
      h_memory: { value: 0.08, confidence: 'low', source: 'Speculative' }
    }
  }
};

// ============================================
// SUPPLY ASSUMPTIONS BY 5-YEAR BLOCK
// ============================================
export const SUPPLY_ASSUMPTIONS = {
  block0: {
    label: 'Years 0-5 (2025-2030)',

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
  },

  block1: {
    label: 'Years 5-10 (2030-2035)',
    expansionRates: {
      packaging: { value: 0.20, confidence: 'low' },
      foundry: { value: 0.10, confidence: 'low' },
      memory: { value: 0.18, confidence: 'low' },
      datacenter: { value: 0.15, confidence: 'low' },
      power: { value: 0.10, confidence: 'low' }
    }
  },

  block2: {
    label: 'Years 10-15 (2035-2040)',
    expansionRates: {
      packaging: { value: 0.12, confidence: 'low' },
      foundry: { value: 0.08, confidence: 'low' },
      memory: { value: 0.12, confidence: 'low' },
      datacenter: { value: 0.10, confidence: 'low' },
      power: { value: 0.08, confidence: 'low' }
    }
  },

  block3: {
    label: 'Years 15-20 (2040-2045)',
    expansionRates: {
      packaging: { value: 0.08, confidence: 'low' },
      foundry: { value: 0.05, confidence: 'low' },
      memory: { value: 0.08, confidence: 'low' },
      datacenter: { value: 0.08, confidence: 'low' },
      power: { value: 0.06, confidence: 'low' }
    }
  }
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
      value: 0.5,  // 2 GPUs per CoWoS wafer
      confidence: 'high',
      source: 'Die size analysis'
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
      demand: {
        block0: {
          inferenceGrowth: { consumer: 0.55, enterprise: 0.70, agentic: 1.50 },
          trainingGrowth: { frontier: 0.40, midtier: 0.70 }
        }
      },
      efficiency: {
        block0: {
          modelEfficiency: { m_inference: 0.25, m_training: 0.12 },
          hardwareEfficiency: { h: 0.20 }
        }
      }
    }
  },

  highDemandFastEfficiency: {
    id: 'highDemandFastEfficiency',
    name: 'High Demand / Fast Efficiency',
    description: 'Strong adoption with rapid efficiency improvements',
    overrides: {
      demand: {
        block0: {
          inferenceGrowth: { consumer: 0.55, enterprise: 0.70, agentic: 1.50 }
        }
      },
      efficiency: {
        block0: {
          modelEfficiency: { m_inference: 0.55, m_training: 0.30 },
          systemsEfficiency: { s_inference: 0.35 },
          hardwareEfficiency: { h: 0.40 }
        }
      }
    }
  },

  demandSlowdown: {
    id: 'demandSlowdown',
    name: 'Demand Slowdown (Capex Hangover)',
    description: 'Adoption disappoints, overcapacity develops',
    overrides: {
      demand: {
        block0: {
          inferenceGrowth: { consumer: 0.20, enterprise: 0.30, agentic: 0.50 },
          trainingGrowth: { frontier: 0.10, midtier: 0.25 }
        },
        block1: {
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
  }
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get the block index for a given month
 */
export function getBlockForMonth(month) {
  const year = Math.floor(month / 12);
  if (year < 5) return 0;
  if (year < 10) return 1;
  if (year < 15) return 2;
  return 3;
}

/**
 * Get the block key for a given month
 */
export function getBlockKeyForMonth(month) {
  return `block${getBlockForMonth(month)}`;
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
