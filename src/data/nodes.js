/**
 * AI Infrastructure Supply Chain - Node Library
 *
 * This file defines the complete node graph representing the AI infrastructure
 * supply chain. Each node has demand translation factors, supply dynamics,
 * elasticity regimes, and market mechanics.
 *
 * Historical base rates are documented with sources where applicable.
 */
import nodesOverrides from './nodesOverrides.json';

const pad2 = (value) => String(value).padStart(2, '0');
const NOW = new Date();
const CURRENT_AS_OF_MONTH = `${NOW.getUTCFullYear()}-${pad2(NOW.getUTCMonth() + 1)}`;

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

// Deep merge with arrays overwritten
function deepMerge(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(source[key]) && isPlainObject(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ========================================
// NODE GROUP DEFINITIONS
// ========================================
export const NODE_GROUPS = [
  { id: 'A', name: 'Workloads', color: '#3B82F6' },
  { id: 'B', name: 'Compute', color: '#8B5CF6' },
  { id: 'C', name: 'Memory & Storage', color: '#EC4899' },
  { id: 'D', name: 'Packaging & Assembly', color: '#F97316' },
  { id: 'E', name: 'Semiconductor Manufacturing', color: '#EF4444' },
  { id: 'F', name: 'Networking', color: '#F59E0B' },
  { id: 'G', name: 'Systems & Cooling', color: '#EAB308' },
  { id: 'H', name: 'Data Centers', color: '#22C55E' },
  { id: 'I', name: 'Power Grid & Interconnect', color: '#10B981' },
  { id: 'J', name: 'Logistics & Other', color: '#6B7280' }
];

// ========================================
// NODE DEFINITIONS
// ========================================
const NODES_BASE = [
  // ========================================
  // GROUP A: WORKLOADS (Demand Drivers)
  // ========================================
  {
    id: 'training_frontier',
    name: 'Frontier Training',
    group: 'A',
    unit: 'runs/month',
    description: 'Large-scale foundation model training runs',

    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: 2 runs/month (Jan 2026)
    baseRate: {
      value: 2,
      confidence: 'medium',
      source: 'Industry cadence estimates. As of 2026-01.',
      historicalRange: [1, 6]
    }
  },
  {
    id: 'training_midtier',
    name: 'Mid-tier Training',
    group: 'A',
    unit: 'runs/month',
    description: 'Fine-tuning and mid-scale training workloads',

    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    baseRate: {
      value: 20,
      confidence: 'medium',
      source: 'Industry cadence estimates. As of 2026-01.',
      historicalRange: [10, 50]
    }
  },
  {
    id: 'inference_consumer',
    name: 'Consumer Inference',
    group: 'A',
    unit: 'tokens/month',
    description: 'Chatbots, search, consumer AI applications',

    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: 4T tokens/month consumer inference (Jan 2026)
    baseRate: {
      value: 4e12,
      confidence: 'medium',
      source: 'Consumer AI usage estimates. As of 2026-01.',
      historicalRange: [1e12, 12e12]
    }
  },
  {
    id: 'inference_enterprise',
    name: 'Enterprise Inference',
    group: 'A',
    unit: 'tokens/month',
    description: 'Enterprise AI services, copilots, RAG',

    demandDriverType: 'direct',
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: 6T tokens/month enterprise inference (Jan 2026)
    baseRate: {
      value: 6e12,
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
    baseRate: {
      value: 1e12,
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

    elasticityShort: 0.1,
    elasticityMid: 0.4,
    elasticityLong: 0.8,

    substitutabilityScore: 0.2,
    supplierConcentration: 5,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 4,
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
    description: 'Lower-cost inference chips (L40S, Gaudi, ASICs)',

    demandDriverType: 'derived',
    inputIntensity: 1,
    parentNodeIds: ['inference_consumer', 'inference_enterprise', 'inference_agentic'],

    startingCapacity: 220000,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 80000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.2,
    elasticityMid: 0.5,
    elasticityLong: 0.8,

    substitutabilityScore: 0.6,
    supplierConcentration: 3,

    contractingRegime: 'spot',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.06,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 220000,
      confidence: 'medium',
      source: 'Competitor shipments, inference ASIC ramp. As of 2026-01.',
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
    inputIntensity: 0.25,
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 2500000,
    committedExpansions: [],
    leadTimeDebottleneck: 3,
    leadTimeNewBuild: 12,
    rampProfile: 'linear',

    elasticityShort: 0.4,
    elasticityMid: 0.7,
    elasticityLong: 0.9,

    substitutabilityScore: 0.6,
    supplierConcentration: 2,

    contractingRegime: 'spot',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 2500000,
      confidence: 'high',
      source: 'Intel/AMD server TAM shipments',
      historicalRange: [2000000, 3200000]
    }
  },

  {
    id: 'dpu_nic',
    name: 'DPUs & Smart NICs',
    group: 'B',
    unit: 'units/month',
    description: 'Data processing units, ConnectX, BlueField',

    demandDriverType: 'derived',
    inputIntensity: 1,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 400000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 100000, type: 'committed' }
    ],
    leadTimeDebottleneck: 4,
    leadTimeNewBuild: 10,
    rampProfile: 's-curve',

    elasticityShort: 0.2,
    elasticityMid: 0.5,
    elasticityLong: 0.8,

    substitutabilityScore: 0.5,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 400000,
      confidence: 'medium',
      source: 'NVIDIA/Mellanox shipments + competitors',
      historicalRange: [200000, 700000]
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
    inputIntensity: 8,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 5000000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 1000000, type: 'committed' },
      { date: '2026-01', capacityAdd: 1200000, type: 'committed' },
      { date: '2026-09', capacityAdd: 1000000, type: 'optional' }
    ],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 24,
    rampProfile: 's-curve',

    elasticityShort: 0.05,
    elasticityMid: 0.25,
    elasticityLong: 0.6,

    substitutabilityScore: 0.1,
    supplierConcentration: 4,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.08,

    geoRiskFlag: true,
    exportControlSensitivity: 'high',

    baseRate: {
      value: 5000000,
      confidence: 'high',
      source: 'HBM supplier announcements and demand estimates',
      historicalRange: [3000000, 7000000]
    }
  },

  {
    id: 'dram_server',
    name: 'Server DRAM',
    group: 'C',
    unit: 'GB/month',
    description: 'DDR5 server memory modules for AI servers',

    demandDriverType: 'derived',
    inputIntensity: 128,
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 34000000,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 4000000, type: 'optional' }
    ],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 24,
    rampProfile: 'linear',

    elasticityShort: 0.15,
    elasticityMid: 0.35,
    elasticityLong: 0.65,

    substitutabilityScore: 0.4,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: true,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 34000000,
      confidence: 'medium',
      source: 'DRAM supply allocated to AI servers',
      historicalRange: [20000000, 50000000]
    }
  },

  {
    id: 'ssd_datacenter',
    name: 'Datacenter SSDs',
    group: 'C',
    unit: 'TB/month',
    description: 'Enterprise NVMe SSDs for AI storage',

    demandDriverType: 'derived',
    inputIntensity: 2,
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 540000,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 80000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.25,
    elasticityMid: 0.5,
    elasticityLong: 0.8,

    substitutabilityScore: 0.6,
    supplierConcentration: 2,

    contractingRegime: 'spot',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 540000,
      confidence: 'medium',
      source: 'Enterprise SSD allocation estimates',
      historicalRange: [300000, 900000]
    }
  },

  // ========================================
  // GROUP D: PACKAGING & ASSEMBLY
  // ========================================
  {
    id: 'cowos_capacity',
    name: 'CoWoS Packaging Capacity',
    group: 'D',
    unit: 'wafer-equiv/month',
    description: 'TSMC CoWoS 2.5D packaging for AI chips',

    demandDriverType: 'derived',
    inputIntensity: 1.0,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 80000,
    committedExpansions: [
      { date: '2025-10', capacityAdd: 15000, type: 'committed' },
      { date: '2026-06', capacityAdd: 20000, type: 'committed' },
      { date: '2026-12', capacityAdd: 10000, type: 'optional' }
    ],
    leadTimeDebottleneck: 30,
    leadTimeNewBuild: 24,
    rampProfile: 's-curve',

    elasticityShort: 0.02,
    elasticityMid: 0.15,
    elasticityLong: 0.5,

    substitutabilityScore: 0.1,
    supplierConcentration: 5,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.05,

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 80000,
      confidence: 'high',
      source: 'TSMC CoWoS capacity estimates',
      historicalRange: [60000, 120000]
    }
  },

  {
    id: 'hybrid_bonding',
    name: 'Hybrid Bonding (3D)',
    group: 'D',
    unit: 'wafer-equiv/month',
    description: 'Advanced 3D stacking for future chips',

    demandDriverType: 'derived',
    inputIntensity: 1.0,  // Adoption curve applied in demand translation
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 20000,  // wafer-equiv/month (kept non-binding in 2026; adoption is low)
    committedExpansions: [
      { date: '2026-06', capacityAdd: 5000, type: 'committed' },
      { date: '2027-06', capacityAdd: 8000, type: 'optional' }
    ],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 30,
    rampProfile: 's-curve',

    elasticityShort: 0.01,
    elasticityMid: 0.1,
    elasticityLong: 0.4,

    substitutabilityScore: 0.3,
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
      value: 20000,
      confidence: 'low',
      source: 'Adjusted to avoid accidental early hard ceiling; revisit when adoption curve is wired',
      historicalRange: [5000, 40000]
    }
  },

  {
    id: 'abf_substrate',
    name: 'ABF Build-up Film',
    group: 'D',
    unit: 'sqm/month',
    description: 'Ajinomoto Build-up Film for advanced substrates',

    demandDriverType: 'derived',
    inputIntensity: 0.02,
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

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
    supplierConcentration: 5,

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
    id: 'osat_test',
    name: 'OSAT Test & Assembly',
    group: 'D',
    unit: 'units/month',
    description: 'Outsourced semiconductor assembly & test',

    demandDriverType: 'derived',
    inputIntensity: 1,
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 800000,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 100000, type: 'optional' }
    ],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.25,
    elasticityMid: 0.5,
    elasticityLong: 0.8,

    substitutabilityScore: 0.5,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.03,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 800000,
      confidence: 'medium',
      source: 'OSAT industry capacity estimates',
      historicalRange: [500000, 1200000]
    }
  },

  // ========================================
  // GROUP E: SEMICONDUCTOR MANUFACTURING
  // ========================================
  {
    id: 'advanced_wafers',
    name: 'Advanced Node Wafer Starts',
    group: 'E',
    unit: 'wafers/month',
    description: '5nm/4nm/3nm wafer starts for AI chips',

    demandDriverType: 'derived',
    inputIntensity: 0.5,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 180000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 20000, type: 'committed' },
      { date: '2026-06', capacityAdd: 40000, type: 'committed' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 36,
    rampProfile: 's-curve',

    elasticityShort: 0.05,
    elasticityMid: 0.2,
    elasticityLong: 0.6,

    substitutabilityScore: 0.1,
    supplierConcentration: 5,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.15,

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    baseRate: {
      value: 180000,
      confidence: 'high',
      source: 'TSMC quarterly / leading-edge capacity estimates',
      historicalRange: [140000, 240000]
    }
  },

  {
    id: 'euv_tools',
    name: 'EUV Lithography Tools',
    group: 'E',
    unit: 'tools',
    description: 'ASML EUV tool deliveries',

    demandDriverType: 'derived',
    inputIntensity: 0.00002,
    parentNodeIds: ['advanced_wafers'],

    startingCapacity: 4,
    committedExpansions: [
      { date: '2027-01', capacityAdd: 1, type: 'optional' }
    ],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 60,
    rampProfile: 'step',

    elasticityShort: 0.01,
    elasticityMid: 0.05,
    elasticityLong: 0.2,

    substitutabilityScore: 0.0,
    supplierConcentration: 5,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'high',

    baseRate: {
      value: 4,
      confidence: 'high',
      source: 'ASML shipment cadence proxy',
      historicalRange: [3, 7]
    }
  },

  // ========================================
  // GROUP F: NETWORKING
  // ========================================
  {
    id: 'switch_asics',
    name: 'Switch ASICs',
    group: 'F',
    unit: 'units/month',
    description: 'High-bandwidth switch chips (Tomahawk, Spectrum)',

    demandDriverType: 'derived',
    inputIntensity: 0.125,
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
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.04,

    geoRiskFlag: true,
    exportControlSensitivity: 'medium',

    baseRate: {
      value: 100000,
      confidence: 'medium',
      source: 'Network ASIC market estimates',
      historicalRange: [60000, 150000]
    }
  },

  {
    id: 'optical_transceivers',
    name: 'Optical Transceivers',
    group: 'F',
    unit: 'units/month',
    description: '400G/800G/1.6T optical modules',

    demandDriverType: 'derived',
    inputIntensity: 1,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 5000000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 1000000, type: 'committed' },
      { date: '2026-01', capacityAdd: 1500000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.25,
    elasticityMid: 0.55,
    elasticityLong: 0.85,

    substitutabilityScore: 0.5,
    supplierConcentration: 2,

    contractingRegime: 'spot',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 5000000,
      confidence: 'medium',
      source: 'Optical module industry output estimates',
      historicalRange: [3000000, 7000000]
    }
  },

  {
    id: 'infiniband_cables',
    name: 'InfiniBand/Ethernet Cables',
    group: 'F',
    unit: 'units/month',
    description: 'High-speed copper and optical cables',

    demandDriverType: 'derived',
    inputIntensity: 4,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 20000000,
    committedExpansions: [],
    leadTimeDebottleneck: 3,
    leadTimeNewBuild: 9,
    rampProfile: 'linear',

    elasticityShort: 0.5,
    elasticityMid: 0.8,
    elasticityLong: 0.95,

    substitutabilityScore: 0.6,
    supplierConcentration: 2,

    contractingRegime: 'spot',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.01,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 20000000,
      confidence: 'medium',
      source: 'Cabling industry estimates',
      historicalRange: [12000000, 30000000]
    }
  },

  // ========================================
  // GROUP G: SYSTEMS & COOLING
  // ========================================
  {
    id: 'server_assembly',
    name: 'Server Assembly Capacity',
    group: 'G',
    unit: 'servers/month',
    description: 'ODM server manufacturing (Foxconn, Quanta, etc.)',

    demandDriverType: 'derived',
    inputIntensity: 0.125,
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
    unit: 'racks/month',
    description: 'Racks, PDUs, busbars, and high-current distribution',

    demandDriverType: 'derived',
    inputIntensity: 0.025,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 50000,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 10000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.3,
    elasticityMid: 0.6,
    elasticityLong: 0.85,

    substitutabilityScore: 0.4,
    supplierConcentration: 2,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.90,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 50000,
      confidence: 'medium',
      source: 'Rack/PDU industry estimates',
      historicalRange: [30000, 80000]
    }
  },

  {
    id: 'liquid_cooling',
    name: 'Liquid Cooling Systems',
    group: 'G',
    unit: 'CDUs/month',
    description: 'CDUs and cold plates for GPU cooling',

    demandDriverType: 'derived',
    inputIntensity: 0.05,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 15000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 10000, type: 'committed' },
      { date: '2026-01', capacityAdd: 20000, type: 'optional' }
    ],
    leadTimeDebottleneck: 10,
    leadTimeNewBuild: 18,
    rampProfile: 's-curve',

    elasticityShort: 0.3,
    elasticityMid: 0.6,
    elasticityLong: 0.85,

    substitutabilityScore: 0.3,
    supplierConcentration: 3,

    contractingRegime: 'mixed',
    inventoryBufferTarget: 4,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 15000,
      confidence: 'medium',
      source: 'Cooling industry analysis',
      historicalRange: [10000, 40000]
    }
  },

  // ========================================
  // GROUP H: DATA CENTERS
  // ========================================
  {
    id: 'datacenter_mw',
    name: 'Data Center Capacity',
    group: 'H',
    unit: 'MW',
    description: 'Operational data center power capacity',

    demandDriverType: 'derived',
    inputIntensity: 0.0013,  // kwPerGpu(1.0) * pue(1.3) / 1000 = MW per GPU
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 1000,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 300, type: 'committed' },
      { date: '2027-01', capacityAdd: 300, type: 'optional' }
    ],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 48,
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
      value: 1000,
      confidence: 'medium',
      source: 'Global AI DC bring-up capacity estimates',
      historicalRange: [500, 2000]
    }
  },

  // ========================================
  // GROUP I: POWER GRID & INTERCONNECT
  // ========================================
  {
    id: 'grid_interconnect',
    name: 'Grid Interconnect Queue',
    group: 'I',
    unit: 'MW-approved/month',
    description: 'Utility grid connection approvals',

    demandDriverType: 'derived',
    inputIntensity: 0.0013,  // MW per GPU (same as datacenter_mw)
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 2500,
    committedExpansions: [],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 60,
    rampProfile: 'linear',

    elasticityShort: 0.02,
    elasticityMid: 0.1,
    elasticityLong: 0.4,

    substitutabilityScore: 0.1,
    supplierConcentration: 2,

    contractingRegime: 'regulated',
    inventoryPolicy: 'queue',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.80,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 2500,
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
    inputIntensity: 0.000026,  // mwPerGpu * transformersPerMw (0.0013 * 0.02)
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 250,
    committedExpansions: [
      { date: '2026-06', capacityAdd: 50, type: 'committed' },
      { date: '2027-06', capacityAdd: 50, type: 'optional' }
    ],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 60,
    rampProfile: 'linear',

    elasticityShort: 0.01,
    elasticityMid: 0.1,
    elasticityLong: 0.5,

    substitutabilityScore: 0.1,
    supplierConcentration: 3,

    contractingRegime: 'regulated',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 250,
      confidence: 'medium',
      source: 'Transformer industry output estimates',
      historicalRange: [150, 400]
    }
  },

  {
    id: 'power_generation',
    name: 'Power Generation PPAs',
    group: 'I',
    unit: 'MW-contracted/month',
    description: 'Contracted incremental generation for new loads',

    demandDriverType: 'derived',
    inputIntensity: 0.0013,  // mwPerGpu (1:1 with datacenter MW demand)
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 8000,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 2000, type: 'optional' }
    ],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 36,
    rampProfile: 's-curve',

    elasticityShort: 0.1,
    elasticityMid: 0.35,
    elasticityLong: 0.7,

    substitutabilityScore: 0.2,
    supplierConcentration: 2,

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
      source: 'PPA market estimates for large loads',
      historicalRange: [4000, 12000]
    }
  },

  {
    id: 'backup_power',
    name: 'Backup Power Systems',
    group: 'I',
    unit: 'MW/month',
    description: 'Generators, UPS, batteries for redundancy',

    demandDriverType: 'derived',
    inputIntensity: 0.00195,  // mwPerGpu * redundancyFactor (0.0013 * 1.5)
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 10000,
    committedExpansions: [
      { date: '2026-01', capacityAdd: 2000, type: 'optional' }
    ],
    leadTimeDebottleneck: 9,
    leadTimeNewBuild: 24,
    rampProfile: 'linear',

    elasticityShort: 0.2,
    elasticityMid: 0.45,
    elasticityLong: 0.8,

    substitutabilityScore: 0.2,
    supplierConcentration: 2,

    contractingRegime: 'spot',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0.02,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 10000,
      confidence: 'medium',
      source: 'UPS/generator market estimates',
      historicalRange: [6000, 15000]
    }
  },

  {
    id: 'dc_construction',
    name: 'DC Construction Labor',
    group: 'I',
    unit: 'worker-months',
    description: 'Skilled labor availability for DC buildouts',

    demandDriverType: 'derived',
    inputIntensity: 0.52,  // mwPerGpu * 400 worker-months per MW
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 5000000,
    committedExpansions: [],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 36,
    rampProfile: 'linear',

    elasticityShort: 0.1,
    elasticityMid: 0.3,
    elasticityLong: 0.6,

    substitutabilityScore: 0.2,
    supplierConcentration: 1,

    contractingRegime: 'spot',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.8,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 5000000,
      confidence: 'low',
      source: 'Labor market proxy; do not gate GPUs directly until infra chain is wired',
      historicalRange: [3000000, 8000000]
    }
  },

  {
    id: 'dc_ops_staff',
    name: 'Data Center Operations Staff',
    group: 'I',
    unit: 'FTEs',
    description: 'Ops staffing for running/maintaining data centers',

    demandDriverType: 'derived',
    inputIntensity: 0.0104,  // mwPerGpu * 8 FTEs per MW
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 50000,
    committedExpansions: [],
    leadTimeDebottleneck: 6,
    leadTimeNewBuild: 18,
    rampProfile: 'linear',

    elasticityShort: 0.15,
    elasticityMid: 0.35,
    elasticityLong: 0.7,

    substitutabilityScore: 0.2,
    supplierConcentration: 1,

    contractingRegime: 'spot',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.9,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 50000,
      confidence: 'low',
      source: 'Staffing proxy; do not gate GPUs directly until infra chain is wired',
      historicalRange: [20000, 120000]
    }
  }
];

// Apply JSON overrides
export const NODES = (nodesOverrides?.nodes)
  ? NODES_BASE.map(n => deepMerge(n, nodesOverrides.nodes[n.id] || {}))
  : NODES_BASE;

// Export update log / metadata
export const ASSUMPTION_UPDATE_LOG = nodesOverrides?.updateLog || [];
export const NODE_METADATA = {
  asOfMonth: CURRENT_AS_OF_MONTH
};

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
