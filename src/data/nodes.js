/**
 * AI Infrastructure Supply Chain - Node Library
 *
 * This file defines the complete node graph representing the AI infrastructure
 * supply chain. Each node has demand translation factors, supply dynamics,
 * elasticity regimes, and market mechanics.
 *
 * Historical base rates are documented with sources where applicable.
 */

// Node Groups
export const NODE_GROUPS = {
  A: { id: 'A', name: 'AI Workloads', color: '#6366f1' },
  B: { id: 'B', name: 'Compute Hardware', color: '#8b5cf6' },
  C: { id: 'C', name: 'Memory & Storage', color: '#d946ef' },
  D: { id: 'D', name: 'Advanced Packaging', color: '#ec4899' },
  E: { id: 'E', name: 'Foundry & Equipment', color: '#f43f5e' },
  F: { id: 'F', name: 'Networking & Optics', color: '#f97316' },
  G: { id: 'G', name: 'Server Manufacturing', color: '#eab308' },
  H: { id: 'H', name: 'Data Center & Facilities', color: '#22c55e' },
  I: { id: 'I', name: 'Power Chain', color: '#14b8a6' },
  J: { id: 'J', name: 'Ops & Human Capital', color: '#0ea5e9' }
};

/**
 * Complete Node Library
 *
 * Each node contains:
 * - Identity: id, name, group, unit
 * - Demand translation: driver type, intensity, parent nodes
 * - Supply dynamics: capacity, expansions, lead times, ramp profiles
 * - Elasticity: short/mid/long term elasticities, substitutability
 * - Market mechanics: contracting, inventory targets, utilization caps
 * - Yield model: simple or stacked (for HBM)
 * - Scenario hooks: geo risk, export controls
 */
export const NODES = [
  // ========================================
  // GROUP A: AI WORKLOADS
  // ========================================
  {
    id: 'training_frontier',
    name: 'Frontier Training Runs',
    group: 'A',
    unit: 'runs/month',
    description: 'Large-scale frontier model training (GPT-5 class)',

    // Demand translation
    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    // Supply dynamics (workload nodes represent demand, not supply)
    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: ~10-15 frontier runs/year globally (2024)
    // Source: Epoch AI, public announcements from OpenAI/Anthropic/Google/Meta
    baseRate: {
      value: 1.2,  // runs/month
      confidence: 'medium',
      source: 'Epoch AI frontier model tracker',
      historicalRange: [0.5, 2.0]
    }
  },
  {
    id: 'training_midtier',
    name: 'Mid-tier Training Runs',
    group: 'A',
    unit: 'runs/month',
    description: 'Smaller model training, fine-tuning, research runs',

    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: ~100-200 significant training runs/month across industry
    baseRate: {
      value: 150,
      confidence: 'low',
      source: 'Industry estimates, cloud provider data',
      historicalRange: [50, 300]
    }
  },
  {
    id: 'inference_consumer',
    name: 'Consumer Inference',
    group: 'A',
    unit: 'tokens/month',
    description: 'ChatGPT, Claude, Gemini consumer usage',

    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: ~5T tokens/month consumer inference (Jan 2026)
    // Consumer AI (ChatGPT, Claude, Gemini) hitting billions of daily tokens
    // Source: SimilarWeb traffic estimates, OpenAI usage reports. As of 2026-01.
    baseRate: {
      value: 5e12,  // 5T tokens/month
      confidence: 'medium',
      source: 'SimilarWeb, company disclosures. As of 2026-01.',
      historicalRange: [2e12, 8e12]
    }
  },
  {
    id: 'inference_enterprise',
    name: 'Enterprise Inference',
    group: 'A',
    unit: 'tokens/month',
    description: 'Enterprise API usage, internal deployments',

    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: 6T tokens/month enterprise inference (Jan 2026)
    // Enterprise AI spend hit $37B in 2025 (3.2x YoY), token usage exploding
    baseRate: {
      value: 6e12,  // 6T tokens/month
      confidence: 'medium',
      source: 'Cloud provider earnings, $37B enterprise AI spend. As of 2026-01.',
      historicalRange: [2e12, 10e12]
    }
  },
  {
    id: 'inference_agentic',
    name: 'Agentic Inference',
    group: 'A',
    unit: 'tokens/month',
    description: 'Autonomous agents, multi-step reasoning, tool use',

    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: 1T tokens/month agentic inference (Jan 2026)
    // Agentic AI projected in 40% enterprise apps by 2026; 10-100x tokens per task
    baseRate: {
      value: 1e12,  // 1T tokens/month
      confidence: 'low',
      source: 'Agentic AI in 40% enterprise apps. As of 2026-01.',
      historicalRange: [0.3e12, 3e12]
    }
  },

  // ========================================
  // GROUP B: COMPUTE HARDWARE
  // ========================================
  {
    id: 'gpu_datacenter',
    name: 'Datacenter GPUs',
    group: 'B',
    unit: 'units/month',
    description: 'H100, H200, B100, B200 class accelerators',

    demandDriverType: 'derived',
    inputIntensity: 1,
    parentNodeIds: ['training_frontier', 'training_midtier', 'inference_consumer', 'inference_enterprise', 'inference_agentic'],

    // Base rate: ~5.4M datacenter GPUs shipped 2025 (NVIDIA + competitors)
    // NVIDIA data center revenue $57B Q3 FY26 (22% QoQ), ~6-8M AI GPUs/year
    // Source: NVIDIA earnings, analyst estimates. As of 2026-01-01.
    startingCapacity: 450000,  // units/month (~5.4M/yr)
    committedExpansions: [
      { date: '2025-06', capacityAdd: 50000, type: 'committed' },
      { date: '2026-01', capacityAdd: 120000, type: 'committed' },
      { date: '2026-07', capacityAdd: 150000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 's-curve',

    elasticityShort: 0.1,   // Very inelastic short-term
    elasticityMid: 0.4,     // Moderate mid-term
    elasticityLong: 0.8,    // More elastic long-term

    substitutabilityScore: 0.2,  // Some substitution to inference chips
    supplierConcentration: 5,    // NVIDIA dominant (HHI proxy: 5 = very concentrated)

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 4,    // weeks
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.05,

    geoRiskFlag: true,
    exportControlSensitivity: 'high',

    baseRate: {
      value: 450000,
      confidence: 'high',
      source: 'NVIDIA quarterly reports, supply chain analysis. As of 2026-01.',
      historicalRange: [350000, 600000]
    }
  },
  {
    id: 'gpu_inference',
    name: 'Inference Accelerators',
    group: 'B',
    unit: 'units/month',
    description: 'L40S, inference-optimized chips, custom ASICs',

    demandDriverType: 'derived',
    inputIntensity: 0.3,  // 30% of inference runs on dedicated inference hardware
    parentNodeIds: ['inference_consumer', 'inference_enterprise', 'inference_agentic'],

    startingCapacity: 200000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 50000, type: 'committed' }
    ],
    leadTimeDebottleneck: 4,
    leadTimeNewBuild: 12,
    rampProfile: 's-curve',

    elasticityShort: 0.2,
    elasticityMid: 0.5,
    elasticityLong: 0.9,

    substitutabilityScore: 0.4,
    supplierConcentration: 4,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 6,
    maxCapacityUtilization: 0.92,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.04,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 200000,
      confidence: 'medium',
      source: 'Analyst estimates, cloud deployments',
      historicalRange: [100000, 400000]
    }
  },
  {
    id: 'cpu_server',
    name: 'Server CPUs',
    group: 'B',
    unit: 'units/month',
    description: 'Intel Xeon, AMD EPYC server processors',

    demandDriverType: 'derived',
    inputIntensity: 0.25,  // 2 CPUs per 8-GPU server = 0.25 CPUs per GPU
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 2500000,
    committedExpansions: [],
    leadTimeDebottleneck: 3,
    leadTimeNewBuild: 12,
    rampProfile: 'linear',

    elasticityShort: 0.4,
    elasticityMid: 0.7,
    elasticityLong: 0.9,

    substitutabilityScore: 0.6,  // Intel/AMD interchangeable for many workloads
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 8,
    maxCapacityUtilization: 0.90,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 2500000,
      confidence: 'high',
      source: 'Intel/AMD quarterly reports',
      historicalRange: [2000000, 3000000]
    }
  },
  {
    id: 'dpu_nic',
    name: 'DPUs & Smart NICs',
    group: 'B',
    unit: 'units/month',
    description: 'Data processing units, ConnectX, BlueField',

    demandDriverType: 'derived',
    inputIntensity: 1,  // 1 DPU per GPU in high-end configs
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 400000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 100000, type: 'committed' }
    ],
    leadTimeDebottleneck: 4,
    leadTimeNewBuild: 10,
    rampProfile: 's-curve',

    elasticityShort: 0.3,
    elasticityMid: 0.6,
    elasticityLong: 0.85,

    substitutabilityScore: 0.3,
    supplierConcentration: 4,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 6,
    maxCapacityUtilization: 0.92,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: false,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 400000,
      confidence: 'medium',
      source: 'NVIDIA Mellanox, analyst estimates',
      historicalRange: [200000, 600000]
    }
  },

  // ========================================
  // GROUP C: MEMORY & STORAGE
  // ========================================
  {
    id: 'hbm_stacks',
    name: 'HBM Memory Stacks',
    group: 'C',
    unit: 'stacks/month',
    description: 'HBM3, HBM3E stacked memory for GPUs',

    demandDriverType: 'derived',
    inputIntensity: 8,  // 8 HBM stacks per H100/H200
    parentNodeIds: ['gpu_datacenter'],

    // Base rate: HBM production ~60M stacks/year (2025)
    // HBM market $54.6B in 2026 (58% YoY), sold out through 2026
    // AI consumes 20% global DRAM wafers; ~250k wafers/month by end-2026
    // Source: SK Hynix, Samsung, Micron announcements. As of 2026-01.
    startingCapacity: 5000000,  // stacks/month (~60M/yr)
    committedExpansions: [
      { date: '2025-06', capacityAdd: 1000000, type: 'committed' },
      { date: '2026-01', capacityAdd: 1200000, type: 'committed' },
      { date: '2026-09', capacityAdd: 1000000, type: 'optional' }
    ],
    leadTimeDebottleneck: 9,
    leadTimeNewBuild: 24,
    rampProfile: 's-curve',

    elasticityShort: 0.05,  // Extremely inelastic
    elasticityMid: 0.25,
    elasticityLong: 0.6,

    substitutabilityScore: 0.1,  // Very limited substitution
    supplierConcentration: 4,    // SK Hynix dominant, Samsung #2

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 2,    // Very tight
    maxCapacityUtilization: 0.98,  // Tight override: sold-out regime

    // STACKED YIELD MODEL - Critical for HBM
    yieldModel: 'stacked',
    yieldInitial: 0.65,       // 65% yield early in ramp
    yieldTarget: 0.85,        // 85% mature yield
    yieldHalflifeMonths: 18,  // 18 months to improve halfway
    stackDieCount: 12,        // HBM3E typically 12-hi

    geoRiskFlag: true,
    exportControlSensitivity: 'high',

    baseRate: {
      value: 5000000,
      confidence: 'medium',
      source: 'Memory vendor capacity announcements, Reuters HBM reports. As of 2026-01.',
      historicalRange: [4000000, 7000000]
    }
  },
  {
    id: 'dram_server',
    name: 'Server DRAM',
    group: 'C',
    unit: 'GB/month',
    description: 'DDR5 server memory modules for AI servers',

    demandDriverType: 'derived',
    inputIntensity: 64,  // 64GB per GPU (512GB per 8-GPU server / 8)
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    // AI-allocated server DRAM capacity
    // Global DRAM: ~120B GB/year; server DRAM ~30%; AI portion growing
    // HBM production consumes DRAM wafers, creating tightness
    // At 64 GB/GPU and ~500K GPU demand, need ~32M GB/month
    startingCapacity: 40000000,  // 40M GB/month AI-allocated
    committedExpansions: [
      { date: '2026-01', capacityAdd: 5000000, type: 'committed' },
      { date: '2026-09', capacityAdd: 8000000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.3,
    elasticityMid: 0.6,
    elasticityLong: 0.85,

    substitutabilityScore: 0.7,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 8,
    maxCapacityUtilization: 0.90,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 40000000,
      confidence: 'medium',
      source: 'AI-allocated server DRAM; HBM wafer competition tightens supply. As of 2026-01.',
      historicalRange: [30000000, 60000000]
    }
  },
  {
    id: 'ssd_datacenter',
    name: 'Datacenter SSDs',
    group: 'C',
    unit: 'TB/month',
    description: 'Enterprise NVMe SSDs for AI storage',

    demandDriverType: 'derived',
    inputIntensity: 1,  // 1 TB per GPU (8 TB per 8-GPU server / 8)
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    // AI-allocated enterprise SSD capacity
    // At 1 TB/GPU and ~500K GPU demand = ~500K TB/month
    // Enterprise SSD market: ~80M TB/year total; AI portion ~10%
    startingCapacity: 800000,  // 800K TB/month AI-allocated
    committedExpansions: [
      { date: '2026-06', capacityAdd: 200000, type: 'committed' }
    ],
    leadTimeDebottleneck: 4,
    leadTimeNewBuild: 12,
    rampProfile: 'linear',

    elasticityShort: 0.5,
    elasticityMid: 0.75,
    elasticityLong: 0.9,

    substitutabilityScore: 0.8,
    supplierConcentration: 3,

    contractingRegime: 'spot',
    inventoryBufferTarget: 10,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 800000,
      confidence: 'medium',
      source: 'Enterprise SSD market, AI-allocated portion. As of 2026-01.',
      historicalRange: [500000, 1200000]
    }
  },

  // ========================================
  // GROUP D: ADVANCED PACKAGING
  // ========================================
  {
    id: 'cowos_capacity',
    name: 'CoWoS Packaging Capacity',
    group: 'D',
    unit: 'wafer-equiv/month',
    description: 'TSMC CoWoS 2.5D packaging for AI chips',

    demandDriverType: 'derived',
    inputIntensity: 1.0,  // 1 CoWoS wafer-equiv per GPU (H100/B100 class)
    parentNodeIds: ['gpu_datacenter'],

    // TSMC CoWoS: 75-80k wafer-equiv/month end-2025, to 115k end-2026 (sold out)
    // At 1 wafer/GPU, 80K wafers → 80K GPUs/month → hard bottleneck
    // Source: TrendForce, TSMC investor calls. As of 2026-01.
    startingCapacity: 80000,  // wafer-equiv/month (down from 200K — real TSMC capacity)
    committedExpansions: [
      { date: '2025-10', capacityAdd: 15000, type: 'committed' },   // ramp to ~95K
      { date: '2026-06', capacityAdd: 20000, type: 'committed' },   // ramp to ~115K
      { date: '2026-12', capacityAdd: 10000, type: 'optional' }     // ramp to ~125K
    ],
    leadTimeDebottleneck: 9,
    leadTimeNewBuild: 24,
    rampProfile: 's-curve',

    elasticityShort: 0.02,  // Almost completely inelastic
    elasticityMid: 0.15,
    elasticityLong: 0.5,

    substitutabilityScore: 0.05,  // Near zero - no real substitute
    supplierConcentration: 5,     // TSMC monopoly

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,     // No inventory - made to order
    maxCapacityUtilization: 0.98, // Tight override: sold-out regime

    yieldModel: 'simple',
    yieldSimpleLoss: 0.08,  // Higher loss than standard packaging

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 80000,
      confidence: 'high',
      source: 'TrendForce, TSMC quarterly reports. 75-80K wafer-equiv/month. As of 2026-01.',
      historicalRange: [60000, 125000]
    }
  },
  {
    id: 'hybrid_bonding',
    name: 'Hybrid Bonding (3D)',
    group: 'D',
    unit: 'wafer-equiv/month',
    description: 'Advanced 3D stacking for future chips',

    demandDriverType: 'derived',
    inputIntensity: 0.1,  // Currently small fraction
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 5000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 5000, type: 'committed' },
      { date: '2026-06', capacityAdd: 10000, type: 'optional' }
    ],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 30,
    rampProfile: 's-curve',

    elasticityShort: 0.01,
    elasticityMid: 0.1,
    elasticityLong: 0.4,

    substitutabilityScore: 0.3,  // Can fall back to CoWoS
    supplierConcentration: 5,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.95,

    yieldModel: 'stacked',
    yieldInitial: 0.55,
    yieldTarget: 0.80,
    yieldHalflifeMonths: 24,
    stackDieCount: 2,

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 5000,
      confidence: 'low',
      source: 'Emerging technology, limited data',
      historicalRange: [2000, 10000]
    }
  },
  {
    id: 'abf_substrate',
    name: 'ABF Build-up Film',
    group: 'D',
    unit: 'sqm/month',
    description: 'Ajinomoto Build-up Film for advanced substrates',

    demandDriverType: 'derived',
    inputIntensity: 0.02,  // 0.02 sqm per GPU package
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    // Base rate: ABF supply tight, ~100k sqm/month
    startingCapacity: 100000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 20000, type: 'committed' },
      { date: '2026-01', capacityAdd: 30000, type: 'optional' }
    ],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 24,
    rampProfile: 'linear',

    elasticityShort: 0.05,
    elasticityMid: 0.2,
    elasticityLong: 0.5,

    substitutabilityScore: 0.15,
    supplierConcentration: 5,  // Ajinomoto dominant

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.05,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 100000,
      confidence: 'medium',
      source: 'Substrate industry reports',
      historicalRange: [80000, 150000]
    }
  },
  {
    id: 'osat_capacity',
    name: 'OSAT Test & Assembly',
    group: 'D',
    unit: 'units/month',
    description: 'Outsourced semiconductor assembly and test',

    demandDriverType: 'derived',
    inputIntensity: 1,
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 800000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 100000, type: 'committed' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 's-curve',

    elasticityShort: 0.15,
    elasticityMid: 0.4,
    elasticityLong: 0.7,

    substitutabilityScore: 0.4,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 2,
    maxCapacityUtilization: 0.92,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 800000,
      confidence: 'medium',
      source: 'ASE, Amkor reports',
      historicalRange: [600000, 1000000]
    }
  },

  // ========================================
  // GROUP E: FOUNDRY & EQUIPMENT
  // ========================================
  {
    id: 'advanced_wafers',
    name: 'Advanced Node Wafer Starts',
    group: 'E',
    unit: 'wafers/month',
    description: '5nm/4nm/3nm wafer starts for AI chips',

    demandDriverType: 'derived',
    inputIntensity: 0.5,  // 0.5 wafers per GPU (reticle limited)
    parentNodeIds: ['gpu_datacenter'],

    // Base rate: ~150-200k advanced node wafers/month (TSMC)
    startingCapacity: 180000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 20000, type: 'committed' },
      { date: '2026-06', capacityAdd: 40000, type: 'committed' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 36,  // New fab is 3 years
    rampProfile: 's-curve',

    elasticityShort: 0.05,
    elasticityMid: 0.2,
    elasticityLong: 0.6,

    substitutabilityScore: 0.1,
    supplierConcentration: 5,  // TSMC monopoly on leading edge

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.15,  // Advanced nodes have higher defect rates

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 180000,
      confidence: 'high',
      source: 'TSMC quarterly reports',
      historicalRange: [150000, 220000]
    }
  },
  {
    id: 'euv_tools',
    name: 'EUV Lithography Tools',
    group: 'E',
    unit: 'tools',
    description: 'ASML EUV scanners (installed base)',

    demandDriverType: 'derived',
    inputIntensity: 0.00001,  // Tiny - tools process many wafers
    parentNodeIds: ['advanced_wafers'],

    // Base rate: ~200 EUV tools installed globally, ~50/year production
    startingCapacity: 200,  // Installed base
    committedExpansions: [
      { date: '2025-03', capacityAdd: 12, type: 'committed' },
      { date: '2025-06', capacityAdd: 12, type: 'committed' },
      { date: '2025-09', capacityAdd: 12, type: 'committed' },
      { date: '2025-12', capacityAdd: 12, type: 'committed' }
    ],
    leadTimeDebottleneck: 0,  // Can't debottleneck
    leadTimeNewBuild: 24,     // 2 year lead time from order
    rampProfile: 'step',

    elasticityShort: 0.0,   // Completely inelastic
    elasticityMid: 0.05,
    elasticityLong: 0.3,

    substitutabilityScore: 0.0,  // No substitute for EUV
    supplierConcentration: 5,    // ASML monopoly

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.85,  // Uptime limited

    yieldModel: 'simple',
    yieldSimpleLoss: 0,  // Tools don't have yield loss

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 200,
      confidence: 'high',
      source: 'ASML annual reports',
      historicalRange: [180, 250]
    }
  },

  // ========================================
  // GROUP F: NETWORKING & OPTICS
  // ========================================
  {
    id: 'switch_asics',
    name: 'Switch ASICs',
    group: 'F',
    unit: 'units/month',
    description: 'High-bandwidth switch chips (Tomahawk, Spectrum)',

    demandDriverType: 'derived',
    inputIntensity: 0.125,  // 1 switch per 8 GPUs
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 100000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 20000, type: 'committed' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 15,
    rampProfile: 's-curve',

    elasticityShort: 0.2,
    elasticityMid: 0.5,
    elasticityLong: 0.8,

    substitutabilityScore: 0.4,
    supplierConcentration: 4,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 6,
    maxCapacityUtilization: 0.90,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.04,

    geoRiskFlag: false,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 100000,
      confidence: 'medium',
      source: 'Broadcom, NVIDIA networking reports',
      historicalRange: [70000, 150000]
    }
  },
  {
    id: 'optical_transceivers',
    name: 'Optical Transceivers',
    group: 'F',
    unit: 'units/month',
    description: '400G/800G/1.6T optical modules',

    demandDriverType: 'derived',
    inputIntensity: 1,  // 1 transceiver per GPU for scale-out
    parentNodeIds: ['gpu_datacenter'],

    // Base rate: ~50M transceivers/year, growing rapidly
    startingCapacity: 5000000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 1000000, type: 'committed' },
      { date: '2026-01', capacityAdd: 2000000, type: 'optional' }
    ],
    leadTimeDebottleneck: 4,
    leadTimeNewBuild: 12,
    rampProfile: 'linear',

    elasticityShort: 0.3,
    elasticityMid: 0.6,
    elasticityLong: 0.85,

    substitutabilityScore: 0.5,  // Different speeds interchangeable somewhat
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 8,
    maxCapacityUtilization: 0.88,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.05,

    geoRiskFlag: true,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 5000000,
      confidence: 'medium',
      source: 'LightCounting, optical industry reports',
      historicalRange: [3000000, 8000000]
    }
  },
  {
    id: 'infiniband_cables',
    name: 'InfiniBand/Ethernet Cables',
    group: 'F',
    unit: 'units/month',
    description: 'High-speed copper and optical cables',

    demandDriverType: 'derived',
    inputIntensity: 4,  // 4 cables per GPU average
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 20000000,
    committedExpansions: [],
    leadTimeDebottleneck: 3,
    leadTimeNewBuild: 9,
    rampProfile: 'linear',

    elasticityShort: 0.5,
    elasticityMid: 0.8,
    elasticityLong: 0.95,

    substitutabilityScore: 0.7,
    supplierConcentration: 2,

    contractingRegime: 'spot',
    inventoryBufferTarget: 10,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 20000000,
      confidence: 'high',
      source: 'Cable industry data',
      historicalRange: [15000000, 30000000]
    }
  },

  // ========================================
  // GROUP G: SERVER MANUFACTURING
  // ========================================
  {
    id: 'server_assembly',
    name: 'Server Assembly Capacity',
    group: 'G',
    unit: 'servers/month',
    description: 'ODM server manufacturing (Foxconn, Quanta, etc.)',

    demandDriverType: 'derived',
    inputIntensity: 0.125,  // 8 GPUs per server
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 500000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 100000, type: 'committed' },
      { date: '2026-01', capacityAdd: 150000, type: 'optional' }
    ],
    leadTimeDebottleneck: 3,
    leadTimeNewBuild: 12,
    rampProfile: 'linear',

    elasticityShort: 0.4,
    elasticityMid: 0.7,
    elasticityLong: 0.9,

    substitutabilityScore: 0.6,
    supplierConcentration: 2,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.90,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.01,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 500000,
      confidence: 'high',
      source: 'ODM quarterly reports',
      historicalRange: [400000, 700000]
    }
  },
  {
    id: 'rack_pdu',
    name: 'Racks & PDUs',
    group: 'G',
    unit: 'units/month',
    description: 'Server racks and power distribution units',

    demandDriverType: 'derived',
    inputIntensity: 0.025,  // 1 rack per 40 servers
    parentNodeIds: ['server_assembly'],

    startingCapacity: 50000,
    committedExpansions: [],
    leadTimeDebottleneck: 2,
    leadTimeNewBuild: 6,
    rampProfile: 'linear',

    elasticityShort: 0.5,
    elasticityMid: 0.8,
    elasticityLong: 0.95,

    substitutabilityScore: 0.7,
    supplierConcentration: 2,

    contractingRegime: 'spot',
    inventoryBufferTarget: 8,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.01,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 50000,
      confidence: 'high',
      source: 'Datacenter infrastructure reports',
      historicalRange: [40000, 70000]
    }
  },
  {
    id: 'liquid_cooling',
    name: 'Liquid Cooling Systems',
    group: 'G',
    unit: 'CDUs/month',
    description: 'CDUs and cold plates for GPU cooling',

    demandDriverType: 'derived',
    inputIntensity: 0.05,  // 1 CDU per 20 GPUs
    parentNodeIds: ['gpu_datacenter'],

    // Base rate: Liquid cooling adoption growing rapidly
    startingCapacity: 20000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 10000, type: 'committed' },
      { date: '2026-01', capacityAdd: 20000, type: 'optional' }
    ],
    leadTimeDebottleneck: 4,
    leadTimeNewBuild: 10,
    rampProfile: 's-curve',

    elasticityShort: 0.3,
    elasticityMid: 0.6,
    elasticityLong: 0.85,

    substitutabilityScore: 0.3,  // Can fall back to air cooling with derating
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 6,
    maxCapacityUtilization: 0.90,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 20000,
      confidence: 'medium',
      source: 'Cooling industry analysis',
      historicalRange: [10000, 40000]
    }
  },

  // ========================================
  // GROUP H: DATA CENTER & FACILITIES
  // ========================================
  {
    id: 'datacenter_mw',
    name: 'Data Center Capacity',
    group: 'H',
    unit: 'MW',
    description: 'Operational data center power capacity',

    demandDriverType: 'derived',
    inputIntensity: 0.001,  // 1 kW per GPU average
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    // Base rate: ~15 GW/year global AI DC bring-up capacity (2025)
    // AI data centers from 10GW base 2025 to ~20-30GW incremental by 2026
    // Grid strain limits bring-up; AI to 27% of data center power
    // Source: NERC reports, S&P Global data center analysis. As of 2026-01.
    startingCapacity: 1250,  // MW/month (~15GW/yr)
    committedExpansions: [
      { date: '2026-01', capacityAdd: 300, type: 'committed' },
      { date: '2027-01', capacityAdd: 300, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 36,  // 3 years for new campus
    rampProfile: 's-curve',

    elasticityShort: 0.1,
    elasticityMid: 0.3,
    elasticityLong: 0.7,

    substitutabilityScore: 0.2,
    supplierConcentration: 2,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: true,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 1250,
      confidence: 'medium',
      source: 'NERC reports, S&P Global data center analysis. As of 2026-01.',
      historicalRange: [1000, 2000]
    }
  },
  {
    id: 'dc_construction',
    name: 'DC Construction Labor',
    group: 'H',
    unit: 'worker-months',
    description: 'Skilled data center construction workforce',

    demandDriverType: 'derived',
    inputIntensity: 500,  // 500 worker-months per MW built
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 5000000,
    committedExpansions: [],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 24,
    rampProfile: 'linear',

    elasticityShort: 0.2,
    elasticityMid: 0.5,
    elasticityLong: 0.8,

    substitutabilityScore: 0.3,
    supplierConcentration: 1,

    contractingRegime: 'spot',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.90,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 5000000,
      confidence: 'low',
      source: 'Construction labor statistics',
      historicalRange: [3000000, 8000000]
    }
  },

  // ========================================
  // GROUP I: POWER CHAIN
  // ========================================
  {
    id: 'grid_interconnect',
    name: 'Grid Interconnect Queue',
    group: 'I',
    unit: 'MW-approved/month',
    description: 'Utility grid connection approvals',

    demandDriverType: 'derived',
    inputIntensity: 1,
    parentNodeIds: ['datacenter_mw'],

    // Base rate: Grid queues severely backlogged
    // Only ~20% of queued capacity gets built
    startingCapacity: 5000,  // MW/month approvals
    committedExpansions: [],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 48,
    rampProfile: 'linear',

    elasticityShort: 0.02,
    elasticityMid: 0.1,
    elasticityLong: 0.4,

    substitutabilityScore: 0.1,  // Behind-the-meter is partial substitute
    supplierConcentration: 2,

    contractingRegime: 'regulated',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.80,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 5000,
      confidence: 'medium',
      source: 'Utility commission data, LBNL queue reports',
      historicalRange: [3000, 8000]
    }
  },
  {
    id: 'transformers_lpt',
    name: 'Large Power Transformers',
    group: 'I',
    unit: 'units/month',
    description: 'High-voltage transformers for substations',

    demandDriverType: 'derived',
    inputIntensity: 0.02,  // 1 transformer per 50 MW
    parentNodeIds: ['datacenter_mw'],

    // Base rate: LPT lead times are 80-210 weeks
    // Global production ~2000-3000 units/year
    startingCapacity: 250,  // units/month globally
    committedExpansions: [
      { date: '2026-06', capacityAdd: 50, type: 'committed' },
      { date: '2027-06', capacityAdd: 50, type: 'optional' }
    ],
    leadTimeDebottleneck: 24,  // 2 years to debottleneck
    leadTimeNewBuild: 60,      // 5 years for new factory
    rampProfile: 'linear',

    elasticityShort: 0.01,  // Extremely inelastic
    elasticityMid: 0.05,
    elasticityLong: 0.25,

    substitutabilityScore: 0.05,
    supplierConcentration: 3,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,  // Built to order
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: true,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 250,
      confidence: 'medium',
      source: 'DOE transformer reports, utility data',
      historicalRange: [200, 350]
    }
  },
  {
    id: 'power_generation',
    name: 'Power Generation PPAs',
    group: 'I',
    unit: 'MW-contracted/month',
    description: 'New power purchase agreements',

    demandDriverType: 'derived',
    inputIntensity: 1.2,  // 120% of DC capacity for redundancy
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 8000,
    committedExpansions: [
      { date: '2025-12', capacityAdd: 2000, type: 'committed' },
      { date: '2026-12', capacityAdd: 3000, type: 'optional' }
    ],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 36,
    rampProfile: 's-curve',

    elasticityShort: 0.1,
    elasticityMid: 0.3,
    elasticityLong: 0.6,

    substitutabilityScore: 0.4,  // Gas/solar/wind somewhat interchangeable
    supplierConcentration: 1,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 8000,
      confidence: 'medium',
      source: 'PPA market reports',
      historicalRange: [5000, 12000]
    }
  },
  {
    id: 'backup_power',
    name: 'Backup Power Systems',
    group: 'I',
    unit: 'MW/month',
    description: 'Generators, UPS, batteries',

    demandDriverType: 'derived',
    inputIntensity: 1.5,  // 150% backup for N+1
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 10000,
    committedExpansions: [],
    leadTimeDebottleneck: 4,
    leadTimeNewBuild: 12,
    rampProfile: 'linear',

    elasticityShort: 0.3,
    elasticityMid: 0.6,
    elasticityLong: 0.85,

    substitutabilityScore: 0.5,
    supplierConcentration: 2,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 8,
    maxCapacityUtilization: 0.90,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.01,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 10000,
      confidence: 'high',
      source: 'Generator/UPS market data',
      historicalRange: [8000, 15000]
    }
  },

  // ========================================
  // GROUP J: OPS & HUMAN CAPITAL
  // ========================================
  {
    id: 'dc_ops_staff',
    name: 'Data Center Operations Staff',
    group: 'J',
    unit: 'FTEs',
    description: 'NOC, facilities, security personnel',

    demandDriverType: 'derived',
    inputIntensity: 0.5,  // 0.5 FTE per MW
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 50000,
    committedExpansions: [],
    leadTimeDebottleneck: 3,
    leadTimeNewBuild: 12,
    rampProfile: 'linear',

    elasticityShort: 0.4,
    elasticityMid: 0.7,
    elasticityLong: 0.9,

    substitutabilityScore: 0.3,
    supplierConcentration: 1,

    contractingRegime: 'spot',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 50000,
      confidence: 'medium',
      source: 'Industry employment data',
      historicalRange: [40000, 70000]
    }
  },
  {
    id: 'ml_engineers',
    name: 'ML Engineers & Researchers',
    group: 'J',
    unit: 'FTEs',
    description: 'Machine learning talent pool',

    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    // Base rate: ~500k ML engineers globally, growing ~15% annually
    startingCapacity: 500000,
    committedExpansions: [],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 48,  // Education pipeline
    rampProfile: 'linear',

    elasticityShort: 0.2,
    elasticityMid: 0.4,
    elasticityLong: 0.7,

    substitutabilityScore: 0.2,
    supplierConcentration: 1,

    contractingRegime: 'spot',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.90,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 500000,
      confidence: 'low',
      source: 'LinkedIn data, industry surveys',
      historicalRange: [300000, 800000]
    }
  }
];

// Get node by ID
export function getNode(nodeId) {
  return NODES.find(n => n.id === nodeId);
}

// Get nodes by group
export function getNodesByGroup(groupId) {
  return NODES.filter(n => n.group === groupId);
}

// Get all parent nodes for a given node
export function getParentNodes(nodeId) {
  const node = getNode(nodeId);
  if (!node) return [];
  return node.parentNodeIds.map(pid => getNode(pid)).filter(Boolean);
}

// Get all child nodes that depend on a given node
export function getChildNodes(nodeId) {
  return NODES.filter(n => n.parentNodeIds.includes(nodeId));
}

// Export node count for validation
export const NODE_COUNT = NODES.length;
