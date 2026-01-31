/**
 * AI Infrastructure Supply Chain - Node Library
 *
 * This file defines the complete node graph representing the AI infrastructure
 * supply chain. Each node has demand translation factors, supply parameters, and
 * optional constraints or dynamics.
 *
 * Notes:
 * - “unit” strings are used for UI + diagnostics; several are standardized to match
 *   the calculation engine’s EXPECTED_UNITS warnings.
 * - Some component intensities are intentionally handled in TRANSLATION_INTENSITIES
 *   (assumptions.js) to avoid double-counting (e.g., CoWoS wafer-equivalent per GPU).
 */

const NOW = new Date();
const CURRENT_YEAR = NOW.getUTCFullYear();
const CURRENT_MONTH = NOW.getUTCMonth() + 1; // 1..12
const pad2 = (value) => String(value).padStart(2, '0');
const CURRENT_AS_OF_MONTH = `${CURRENT_YEAR}-${pad2(CURRENT_MONTH)}`;

export const NODES = [
  // ========================================
  // GROUP A: DEMAND DRIVERS (Workloads)
  // ========================================
  {
    id: 'training_frontier',
    name: 'Frontier Training Runs',
    group: 'A',
    unit: 'accel-hours/month',
    description: 'Compute demand for SOTA training',

    demandDriverType: 'direct',
    parentNodeIds: [],
    startingCapacity: 0,
    committedExpansions: [],

    elasticityShort: 0.0,
    elasticityMid: 0.0,
    elasticityLong: 0.0,

    substitutabilityScore: 0.0,
    supplierConcentration: 0,

    contractingRegime: 'N/A',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 1.0,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 0,
      confidence: 'high',
      source: 'Derived in calculation engine from demand assumptions',
      historicalRange: [0, 0]
    }
  },
  {
    id: 'training_midtier',
    name: 'Mid-tier Training Runs',
    group: 'A',
    unit: 'accel-hours/month',
    description: 'Compute demand for mid-tier model training',

    demandDriverType: 'direct',
    parentNodeIds: [],
    startingCapacity: 0,
    committedExpansions: [],

    elasticityShort: 0.0,
    elasticityMid: 0.0,
    elasticityLong: 0.0,

    substitutabilityScore: 0.0,
    supplierConcentration: 0,

    contractingRegime: 'N/A',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 1.0,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 0,
      confidence: 'high',
      source: 'Derived in calculation engine from demand assumptions',
      historicalRange: [0, 0]
    }
  },
  {
    id: 'inference_consumer',
    name: 'Consumer Inference Tokens',
    group: 'A',
    unit: 'tokens/month',
    description: 'Consumer-facing inference demand',

    demandDriverType: 'direct',
    parentNodeIds: [],
    startingCapacity: 0,
    committedExpansions: [],

    elasticityShort: 0.0,
    elasticityMid: 0.0,
    elasticityLong: 0.0,

    substitutabilityScore: 0.0,
    supplierConcentration: 0,

    contractingRegime: 'N/A',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 1.0,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 0,
      confidence: 'high',
      source: 'Derived in calculation engine from demand assumptions',
      historicalRange: [0, 0]
    }
  },
  {
    id: 'inference_enterprise',
    name: 'Enterprise Inference Tokens',
    group: 'A',
    unit: 'tokens/month',
    description: 'Enterprise inference demand',

    demandDriverType: 'direct',
    parentNodeIds: [],
    startingCapacity: 0,
    committedExpansions: [],

    elasticityShort: 0.0,
    elasticityMid: 0.0,
    elasticityLong: 0.0,

    substitutabilityScore: 0.0,
    supplierConcentration: 0,

    contractingRegime: 'N/A',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 1.0,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 0,
      confidence: 'high',
      source: 'Derived in calculation engine from demand assumptions',
      historicalRange: [0, 0]
    }
  },
  {
    id: 'inference_agentic',
    name: 'Agentic Inference Tokens',
    group: 'A',
    unit: 'tokens/month',
    description: 'Agentic / tool-using inference demand',

    demandDriverType: 'direct',
    parentNodeIds: [],
    startingCapacity: 0,
    committedExpansions: [],

    elasticityShort: 0.0,
    elasticityMid: 0.0,
    elasticityLong: 0.0,

    substitutabilityScore: 0.0,
    supplierConcentration: 0,

    contractingRegime: 'N/A',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 1.0,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 0,
      confidence: 'high',
      source: 'Derived in calculation engine from demand assumptions',
      historicalRange: [0, 0]
    }
  },

  // ========================================
  // GROUP B: ACCELERATORS & CORE COMPUTE
  // ========================================
  {
    id: 'gpu_datacenter',
    name: 'Data Center GPUs (Installed Base)',
    group: 'B',
    unit: 'gpus',
    description: 'AI accelerators for training and inference in data centers',

    demandDriverType: 'derived',
    inputIntensity: 1.0,
    parentNodeIds: ['training_frontier', 'training_midtier', 'inference_consumer', 'inference_enterprise', 'inference_agentic'],

    startingCapacity: 450000,
    startingInventory: 25000,
    startingBacklog: 0,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 50000, type: 'committed' },
      { date: '2026-01', capacityAdd: 80000, type: 'committed' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 's-curve',

    elasticityShort: 0.05,
    elasticityMid: 0.25,
    elasticityLong: 0.7,

    substitutabilityScore: 0.2,
    supplierConcentration: 4,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 2,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.05,

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 450000,
      confidence: 'high',
      source: 'NVIDIA + AMD quarterly shipments estimates',
      historicalRange: [250000, 600000]
    }
  },
  {
    id: 'gpu_inference',
    name: 'Inference GPUs (Installed Base)',
    group: 'B',
    unit: 'gpus',
    description: 'Inference-optimized accelerators (including edge inference clusters)',

    demandDriverType: 'derived',
    inputIntensity: 1.0,
    parentNodeIds: ['inference_consumer', 'inference_enterprise', 'inference_agentic'],

    startingCapacity: 120000,
    startingInventory: 5000,
    startingBacklog: 0,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 15000, type: 'committed' },
      { date: '2026-01', capacityAdd: 25000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 's-curve',

    elasticityShort: 0.08,
    elasticityMid: 0.3,
    elasticityLong: 0.75,

    substitutabilityScore: 0.35,
    supplierConcentration: 4,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 1,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.05,

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 120000,
      confidence: 'medium',
      source: 'Inference accelerators mix (NVIDIA L40S, etc.)',
      historicalRange: [50000, 250000]
    }
  },
  {
    id: 'cpu_server',
    name: 'Server CPUs',
    group: 'B',
    unit: 'units/month',
    description: 'x86/ARM CPUs paired with GPUs in servers',

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
    unit: 'Stacks',
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

    yieldModel: 'stacked',
    yieldInitial: 0.70,
    yieldTarget: 0.92,
    yieldHalflifeMonths: 18,
    stackDieCount: 8,

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 5000000,
      confidence: 'high',
      source: 'SK Hynix, Samsung, Micron statements; TrendForce. As of 2026-01.',
      historicalRange: [3500000, 7000000]
    }
  },
  {
    id: 'dram_server',
    name: 'Server DRAM (GB)',
    group: 'C',
    unit: 'gb/month',
    description: 'DDR5 DRAM capacity allocated for AI servers',

    demandDriverType: 'derived',
    inputIntensity: 64,  // 64 GB per GPU (host RAM per accelerator)
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 200000000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 30000000, type: 'committed' },
      { date: '2026-03', capacityAdd: 40000000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.2,
    elasticityMid: 0.5,
    elasticityLong: 0.8,

    substitutabilityScore: 0.5,
    supplierConcentration: 4,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 6,
    maxCapacityUtilization: 0.92,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 200000000,
      confidence: 'medium',
      source: 'DRAM industry data, AI allocation assumptions',
      historicalRange: [140000000, 260000000]
    }
  },
  {
    id: 'ssd_datacenter',
    name: 'Enterprise SSDs (TB)',
    group: 'C',
    unit: 'tb/month',
    description: 'Data center SSD storage capacity',

    demandDriverType: 'derived',
    inputIntensity: 1,  // 1 TB per GPU (8 TB per 8-GPU server / 8)
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    // AI-allocated enterprise SSD capacity (allocation-constrained in 2026)
    // At 1 TB/GPU and ~500K GPU demand = ~500K TB/month
    // Enterprise SSD market: ~80M TB/year total; AI portion ~10%
    startingCapacity: 540000,  // ~450K TB/month effective after utilization/yield
    startingInventory: 150000, // ~0.28 months of coverage
    startingBacklog: 110000,   // ~0.2 months queued
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
      value: 540000,
      confidence: 'medium',
      source: 'Enterprise SSD market, AI-allocated portion. As of 2026-01.',
      historicalRange: [400000, 900000]
    }
  },

  // ========================================
  // GROUP D: ADVANCED PACKAGING
  // ========================================
  {
    id: 'cowos_capacity',
    name: 'CoWoS Packaging Capacity',
    group: 'D',
    unit: 'Wafers/Month',
    description: 'TSMC CoWoS 2.5D packaging for AI chips',

    demandDriverType: 'derived',
    // Conversion handled in TRANSLATION_INTENSITIES.gpuToComponents.cowosWaferEquivPerGpu
    // to avoid double-counting wafer-equivalent demand.
    inputIntensity: 1.0,
    parentNodeIds: ['gpu_datacenter'],

    // TSMC CoWoS: 75-80k wafer-equiv/month end-2025, to 115k end-2026 (sold out)
    // At 0.3 wafer/GPU, 80K wafers → ~267K GPUs/month (wafer-equiv vs package-adjusted)
    // Source: TrendForce, TSMC investor calls. As of 2026-01.
    startingCapacity: 80000,  // Wafers/Month (wafer-equivalent; down from 200K prior placeholder)
    committedExpansions: [
      { date: '2025-10', capacityAdd: 15000, type: 'committed' },   // ramp to ~95K
      { date: '2026-06', capacityAdd: 20000, type: 'committed' },   // ramp to ~115K
      { date: '2026-12', capacityAdd: 10000, type: 'optional' }     // ramp to ~125K
    ],
    leadTimeDebottleneck: 9,
    leadTimeNewBuild: 24,
    rampProfile: 's-curve',

    elasticityShort: 0.01,  // Extremely inelastic near-term
    elasticityMid: 0.1,
    elasticityLong: 0.4,

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
    unit: 'Bonds/WaferOps',
    description: 'Advanced 3D stacking (capacity normalized to wafer-ops)',

    demandDriverType: 'derived',
    inputIntensity: 1.0,  // Adoption curve applied in demand translation
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 1500,
    committedExpansions: [
      { date: '2026-06', capacityAdd: 1500, type: 'committed' },
      { date: '2027-06', capacityAdd: 2000, type: 'optional' }
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
    inventoryPolicy: 'non_storable',
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
      value: 1500,
      confidence: 'low',
      source: 'Emerging technology, limited data',
      historicalRange: [1000, 4000]
    }
  },
  {
    id: 'abf_substrate',
    name: 'ABF Build-up Film',
    group: 'D',
    unit: 'Units',
    description: 'Ajinomoto Build-up Film for advanced substrates',

    demandDriverType: 'derived',
    inputIntensity: 0.02,  // 0.02 (normalized) units per GPU package
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    // Base rate: ABF supply tight, ~100k units/month (normalized)
    startingCapacity: 100000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 20000, type: 'committed' },
      { date: '2026-01', capacityAdd: 30000, type: 'optional' }
    ],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 24,
    rampProfile: 'linear',

    elasticityShort: 0.08,
    elasticityMid: 0.25,
    elasticityLong: 0.6,

    substitutabilityScore: 0.3,
    supplierConcentration: 4,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: false,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 100000,
      confidence: 'medium',
      source: 'ABF market data, AI allocation assumptions',
      historicalRange: [70000, 150000]
    }
  },
  {
    id: 'osat_capacity',
    name: 'OSAT Packaging (Non-CoWoS)',
    group: 'D',
    unit: 'packages/month',
    description: 'ASE, Amkor, JCET packaging capacity for AI-adjacent components',

    demandDriverType: 'derived',
    inputIntensity: 1.0,
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 1000000,
    committedExpansions: [
      { date: '2025-09', capacityAdd: 150000, type: 'committed' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.15,
    elasticityMid: 0.4,
    elasticityLong: 0.8,

    substitutabilityScore: 0.6,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 6,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 1000000,
      confidence: 'medium',
      source: 'OSAT industry estimates',
      historicalRange: [800000, 1400000]
    }
  },

  // ========================================
  // GROUP E: FOUNDRY & EQUIPMENT
  // ========================================
  {
    id: 'advanced_wafers',
    name: 'Advanced Node Wafer Starts',
    group: 'E',
    unit: 'Wafers',
    description: '5nm/4nm/3nm wafer starts for AI chips',

    demandDriverType: 'derived',
    // Conversion handled in TRANSLATION_INTENSITIES.gpuToComponents.advancedWafersPerGpu
    inputIntensity: 1.0,
    parentNodeIds: ['gpu_datacenter'],

    // Base rate: Advanced node AI allocation, rough order-of-magnitude
    startingCapacity: 750000,
    committedExpansions: [
      { date: '2025-12', capacityAdd: 60000, type: 'committed' },
      { date: '2026-09', capacityAdd: 90000, type: 'optional' }
    ],
    leadTimeDebottleneck: 18,
    leadTimeNewBuild: 36,
    rampProfile: 's-curve',

    elasticityShort: 0.02,
    elasticityMid: 0.12,
    elasticityLong: 0.35,

    substitutabilityScore: 0.1,
    supplierConcentration: 5,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.97,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.05,

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 750000,
      confidence: 'high',
      source: 'TSMC/Samsung/Intel Foundry reports',
      historicalRange: [600000, 1000000]
    }
  },
  {
    id: 'euv_tools',
    name: 'EUV Lithography Tools',
    group: 'E',
    unit: 'tools/year',
    description: 'ASML EUV tool shipments (gating advanced node capacity)',

    demandDriverType: 'derived',
    inputIntensity: 0.000002, // placeholder intensity (tools per GPU-equivalent capacity)
    parentNodeIds: ['advanced_wafers'],

    startingCapacity: 60,
    committedExpansions: [
      { date: '2026-12', capacityAdd: 10, type: 'committed' }
    ],
    leadTimeDebottleneck: 18,
    leadTimeNewBuild: 48,
    rampProfile: 'linear',

    elasticityShort: 0.0,
    elasticityMid: 0.05,
    elasticityLong: 0.2,

    substitutabilityScore: 0.0,
    supplierConcentration: 5,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.0,

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 60,
      confidence: 'high',
      source: 'ASML annual guidance',
      historicalRange: [40, 80]
    }
  },

  // ========================================
  // GROUP F: NETWORKING & OPTICAL
  // ========================================
  {
    id: 'switch_asics',
    name: 'Switch ASICs',
    group: 'F',
    unit: 'units/month',
    description: 'High-speed switch silicon (400G/800G)',

    demandDriverType: 'derived',
    inputIntensity: 0.08, // ~1 switch ASIC per ~12 GPUs (very rough)
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 600000,
    committedExpansions: [
      { date: '2025-09', capacityAdd: 100000, type: 'committed' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.25,
    elasticityMid: 0.55,
    elasticityLong: 0.85,

    substitutabilityScore: 0.4,
    supplierConcentration: 4,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 6,
    maxCapacityUtilization: 0.92,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 600000,
      confidence: 'medium',
      source: 'Broadcom / Marvell guidance; analyst estimates',
      historicalRange: [400000, 800000]
    }
  },
  {
    id: 'optical_transceivers',
    name: 'Optical Transceivers',
    group: 'F',
    unit: 'units/month',
    description: '400G/800G optical modules',

    demandDriverType: 'derived',
    inputIntensity: 1.5, // per GPU, rough for large clusters
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 1500000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 250000, type: 'committed' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 15,
    rampProfile: 's-curve',

    elasticityShort: 0.2,
    elasticityMid: 0.5,
    elasticityLong: 0.8,

    substitutabilityScore: 0.4,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 1500000,
      confidence: 'medium',
      source: 'Optics vendors guidance (Lumentum, Coherent, etc.)',
      historicalRange: [900000, 2200000]
    }
  },
  {
    id: 'infiniband_cables',
    name: 'InfiniBand / High-Speed Cables',
    group: 'F',
    unit: 'meters/month',
    description: 'Copper and AOC/DAC high-speed interconnect cabling',

    demandDriverType: 'derived',
    inputIntensity: 5, // meters per GPU (rough)
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
    unit: 'Servers/Month',
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
      source: 'Rack/PDU industry estimates',
      historicalRange: [30000, 80000]
    }
  },
  {
    id: 'liquid_cooling',
    name: 'Liquid Cooling Systems',
    group: 'G',
    unit: 'units/month',
    description: 'Direct-to-chip / immersion cooling systems',

    demandDriverType: 'derived',
    inputIntensity: 0.015, // systems per GPU (very rough)
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 20000,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 6000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 's-curve',

    elasticityShort: 0.15,
    elasticityMid: 0.45,
    elasticityLong: 0.8,

    substitutabilityScore: 0.5,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 3,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 20000,
      confidence: 'low',
      source: 'Liquid cooling industry estimates',
      historicalRange: [5000, 40000]
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
    inputIntensity: 0.0013, // MW per GPU (including PUE). Overridden by serverToInfra.kwPerGpu + PUE if desired.
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 28000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 2500, type: 'committed' },
      { date: '2026-01', capacityAdd: 3000, type: 'optional' }
    ],
    leadTimeDebottleneck: 9,
    leadTimeNewBuild: 24,
    rampProfile: 's-curve',

    elasticityShort: 0.05,
    elasticityMid: 0.2,
    elasticityLong: 0.6,

    substitutabilityScore: 0.2,
    supplierConcentration: 2,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.92,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.01,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 28000,
      confidence: 'medium',
      source: 'Hyperscaler + colo buildout estimates',
      historicalRange: [20000, 40000]
    }
  },
  {
    id: 'dc_construction',
    name: 'Data Center Construction',
    group: 'H',
    unit: 'mw/month',
    description: 'Rate of bringing new data center MW online',

    demandDriverType: 'derived',
    inputIntensity: 1.0,
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 1200,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 150, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 24,
    rampProfile: 'linear',

    elasticityShort: 0.1,
    elasticityMid: 0.35,
    elasticityLong: 0.7,

    substitutabilityScore: 0.4,
    supplierConcentration: 2,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 1200,
      confidence: 'medium',
      source: 'Construction industry capacity estimates',
      historicalRange: [800, 1800]
    }
  },

  // ========================================
  // GROUP I: POWER CHAIN
  // ========================================
  {
    id: 'grid_interconnect',
    name: 'Grid Interconnect Queue',
    group: 'I',
    unit: 'MW',
    description: 'Utility grid connection approvals',

    demandDriverType: 'derived',
    inputIntensity: 0.0013, // MW per GPU (same as datacenter_mw intensity)
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 3500,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 500, type: 'optional' }
    ],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 36,
    rampProfile: 'linear',

    elasticityShort: 0.02,
    elasticityMid: 0.15,
    elasticityLong: 0.4,

    substitutabilityScore: 0.0,
    supplierConcentration: 2,

    contractingRegime: 'regulated',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 3500,
      confidence: 'medium',
      source: 'Utility interconnect queue estimates',
      historicalRange: [2000, 6000]
    }
  },
  {
    id: 'transformers_lpt',
    name: 'Large Power Transformers',
    group: 'I',
    unit: 'units/month',
    description: 'Utility-scale transformers for new data centers',

    demandDriverType: 'derived',
    inputIntensity: 0.02, // ~1 LPT per 50 MW
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 700,
    committedExpansions: [
      { date: '2026-06', capacityAdd: 120, type: 'optional' }
    ],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 30,
    rampProfile: 'linear',

    elasticityShort: 0.05,
    elasticityMid: 0.2,
    elasticityLong: 0.5,

    substitutabilityScore: 0.15,
    supplierConcentration: 3,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 2,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 700,
      confidence: 'medium',
      source: 'Transformer industry capacity; lead time reports',
      historicalRange: [400, 1200]
    }
  },
  {
    id: 'backup_power',
    name: 'Backup Power Systems',
    group: 'I',
    unit: 'units/month',
    description: 'Generators / UPS systems for data centers',

    demandDriverType: 'derived',
    inputIntensity: 0.04, // placeholder
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 5000,
    committedExpansions: [],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.25,
    elasticityMid: 0.6,
    elasticityLong: 0.9,

    substitutabilityScore: 0.6,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 5,
    maxCapacityUtilization: 0.88,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 5000,
      confidence: 'medium',
      source: 'Generator/UPS industry capacity estimates',
      historicalRange: [2500, 9000]
    }
  },

  // ========================================
  // GROUP J: LABOR / SERVICES (Queues)
  // ========================================
  {
    id: 'dc_ops_staff',
    name: 'Data Center Ops Staff',
    group: 'J',
    unit: 'heads/month',
    description: 'Hiring throughput for DC operations staffing',

    demandDriverType: 'derived',
    inputIntensity: 0.002, // staff per GPU (very rough)
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 25000,
    committedExpansions: [],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.15,
    elasticityMid: 0.4,
    elasticityLong: 0.8,

    substitutabilityScore: 0.5,
    supplierConcentration: 1,

    contractingRegime: 'labor',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 25000,
      confidence: 'medium',
      source: 'DC ops labor statistics',
      historicalRange: [15000, 40000]
    }
  },
  {
    id: 'ml_engineers',
    name: 'ML Engineers',
    group: 'J',
    unit: 'heads/month',
    description: 'Hiring throughput for ML engineering talent',

    demandDriverType: 'derived',
    inputIntensity: 0.0015, // headcount per GPU-equivalent workload (rough)
    parentNodeIds: ['training_frontier', 'training_midtier', 'inference_consumer', 'inference_enterprise', 'inference_agentic'],

    startingCapacity: 60000,
    committedExpansions: [],
    leadTimeDebottleneck: 9,
    leadTimeNewBuild: 24,
    rampProfile: 'linear',

    elasticityShort: 0.1,
    elasticityMid: 0.35,
    elasticityLong: 0.7,

    substitutabilityScore: 0.4,
    supplierConcentration: 1,

    contractingRegime: 'labor',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 60000,
      confidence: 'medium',
      source: 'Software/ML labor statistics',
      historicalRange: [30000, 90000]
    }
  }
];

// Convenience lookups
const NODE_MAP = new Map(NODES.map(n => [n.id, n]));

/**
 * Get node by id.
 */
export function getNode(id) {
  return NODE_MAP.get(id);
}

/**
 * Get direct child nodes (nodes that list `id` in parentNodeIds).
 */
export function getChildNodes(id) {
  return NODES.filter(n => (n.parentNodeIds || []).includes(id));
}

export const NODE_METADATA = {
  asOfMonth: CURRENT_AS_OF_MONTH,
  totalNodes: NODES.length
};
