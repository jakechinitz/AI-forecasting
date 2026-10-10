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

// Id-keyed lookup for components that resolve a node's group letter to name/color.
export const NODE_GROUP_MAP = Object.fromEntries(NODE_GROUPS.map((g) => [g.id, g]));

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
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: 3 runs/month (end-2025) — more frontier labs actively training
    baseRate: {
      value: 3,
      confidence: 'medium',
      source: 'Industry cadence: OpenAI, Anthropic, Google, Meta, xAI, Mistral.',
      historicalRange: [2, 8]
    }
  },
  {
    id: 'training_midtier',
    name: 'Mid-tier Training',
    group: 'A',
    unit: 'runs/month',
    description: 'Fine-tuning and mid-scale training workloads',

    demandDriverType: 'direct',
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    baseRate: {
      value: 300,
      confidence: 'medium',
      source: 'Fine-tuning explosion; 31% orgs in production (2x 2024 rate).',
      historicalRange: [100, 600]
    }
  },
  {
    id: 'inference_consumer',
    name: 'Consumer Inference',
    group: 'A',
    unit: 'tokens/month',
    description: 'Chatbots, search, consumer AI applications',

    demandDriverType: 'direct',
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base mix: 225T tokens/month consumer (45%); the level is rescaled by the month-0 calibration
    // ChatGPT 810M WAU, Gemini 750M MAU, Claude 18.8M users
    baseRate: {
      value: 225e12,
      confidence: 'medium',
      source: 'Consumer AI usage estimates. ChatGPT 810M WAU.',
      historicalRange: [100000000000000, 500000000000000]
    }
  },
  {
    id: 'inference_enterprise',
    name: 'Enterprise Inference',
    group: 'A',
    unit: 'tokens/month',
    description: 'Enterprise AI services, copilots, RAG',

    demandDriverType: 'direct',
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base mix: 175T tokens/month enterprise (35%); the level is rescaled by the month-0 calibration
    // 71% of orgs using GenAI; $37B+ enterprise AI spend
    baseRate: {
      value: 175e12,
      confidence: 'medium',
      source: 'Enterprise AI adoption 71% of orgs; cloud earnings.',
      historicalRange: [100000000000000, 400000000000000]
    }
  },
  {
    id: 'inference_agentic',
    name: 'Agentic Inference',
    group: 'A',
    unit: 'tokens/month',
    description: 'Autonomous agents, multi-step reasoning, tool use',

    demandDriverType: 'direct',
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base mix: 100T tokens/month agentic (20%); the level is rescaled by the month-0 calibration
    // AI agent deployments doubling every 4 months; 40% enterprise apps by end 2026
    baseRate: {
      value: 100e12,
      confidence: 'low',
      source: 'Agentic AI doubling every 4mo; 1B agents projected by end 2026.',
      historicalRange: [20000000000000, 125000000000000]
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
    parentNodeIds: ['training_frontier', 'training_midtier', 'inference_consumer', 'inference_enterprise', 'inference_agentic'],

    startingCapacity: 1000000,  // Accelerator output across vendors: ~16.3M units in 2026 (JPM, +62% YoY; ~10M in 2025); pools sum to ~1.5M/month at the start
    committedExpansions: [],
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
      value: 1000000,
      confidence: 'high',
      source: 'Accelerator output across vendors: ~16.3M units in 2026 (JPM, +62% YoY; ~10M in 2025); pools sum to ~1.5M/month at the start',
      historicalRange: [450000, 1250000]
    }
  },

  {
    id: 'gpu_inference',
    name: 'Inference Accelerators',
    group: 'B',
    unit: 'units/month',
    description: 'Lower-cost inference chips (L40S, Gaudi, ASICs)',

    demandDriverType: 'derived',
    parentNodeIds: ['inference_consumer', 'inference_enterprise', 'inference_agentic'],

    startingCapacity: 500000,  // Second accelerator pool (ASIC-heavy inference parts); see gpu_datacenter
    committedExpansions: [],
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
      value: 500000,
      confidence: 'medium',
      source: 'Second accelerator pool (ASIC-heavy inference parts); see gpu_datacenter',
      historicalRange: [200000, 625000]
    }
  },

  {
    id: 'cpu_server',
    name: 'Server CPUs',
    group: 'B',
    unit: 'units/month',
    description: 'Intel Xeon, AMD EPYC server processors',

    demandDriverType: 'derived',
    inputIntensity: 0.5,
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 1000000,  // AI-available server CPUs (EPYC sold out; Intel filling ~40% of orders in 2026)
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
      value: 1000000,
      confidence: 'medium',
      source: 'AI-available share of Intel/AMD/Arm server CPU output (~2.5M/month total); 2026 shortage: EPYC sold out, Intel filling ~40% of orders',
      historicalRange: [800000, 1500000]
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

    startingCapacity: 2200000,  // NICs/DPUs made on TSMC nodes; not a known bottleneck (sized to support ~40 GW/yr in 2026)
    committedExpansions: [],
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
      value: 2200000,
      confidence: 'medium',
      source: 'NICs/DPUs made on TSMC nodes; not a known bottleneck (sized to support ~40 GW/yr in 2026)',
      historicalRange: [200000, 2750000]
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
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (gpuToComponents.hbmStacksPerGpu)
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 8100000,  // HBM ~3.5 EB/yr run-rate at end-2025 (2025 ~2.6 EB; 2026 ~4.2 EB, TrendForce) ≈ 8.1M stacks/month at ~36 GB/stack
    committedExpansions: [],
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
    yieldSimpleLoss: 0,  // counted as shipped good stacks

    geoRiskFlag: true,
    exportControlSensitivity: 'high',

    // Growth: demand-driven, no growth cap; ceiling = AI share of DRAM wafer capacity (SHARED_SUPPLY_POOLS.memory).

    baseRate: {
      value: 8100000,
      confidence: 'high',
      source: 'HBM ~3.5 EB/yr run-rate at end-2025 (2025 ~2.6 EB; 2026 ~4.2 EB, TrendForce) ≈ 8.1M stacks/month at ~36 GB/stack',
      historicalRange: [5000000, 10125000]
    }
  },

  {
    id: 'dram_server',
    name: 'Server DRAM',
    group: 'C',
    unit: 'GB/month',
    description: 'DDR5 server memory modules for AI servers',

    demandDriverType: 'derived',
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (gpuToComponents.serverDramGbPerGpu)
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 290000000,  // Host DRAM for AI servers ~3.5 EB/yr in 2026 (~10% of ~40 EB standard DRAM bits; TrendForce)
    committedExpansions: [],
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
      value: 290000000,
      confidence: 'medium',
      source: 'Host DRAM for AI servers ~3.5 EB/yr in 2026 (~10% of ~40 EB standard DRAM bits; TrendForce)',
      historicalRange: [20000000, 362500000]
    }
  },

  {
    id: 'ssd_datacenter',
    name: 'Datacenter SSDs',
    group: 'C',
    unit: 'TB/month',
    description: 'Enterprise NVMe SSDs for AI storage',

    demandDriverType: 'derived',
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (gpuToComponents.ssdTbPerGpu)
    parentNodeIds: ['gpu_datacenter', 'gpu_inference'],

    startingCapacity: 5000000,  // NAND for AI servers; not a known bottleneck (sized to support ~40 GW/yr in 2026)
    committedExpansions: [],
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
      value: 5000000,
      confidence: 'medium',
      source: 'NAND for AI servers; not a known bottleneck (sized to support ~40 GW/yr in 2026)',
      historicalRange: [300000, 6250000]
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
    // Engine sources this intensity from TRANSLATION_INTENSITIES.gpuToComponents
    // .cowosWaferEquivPerGpu in assumptions.js; kept in sync for display.
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (gpuToComponents.cowosWaferEquivPerGpu)
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 95000,  // Industry CoWoS-class capacity ~95k wafers/month at end-2025 (TSMC ~75k + OSAT ~20k) → ~130k end-2026, ~170k 2027, ~260k end-2028 (TrendForce Sep-2026)
    committedExpansions: [],
    leadTimeDebottleneck: 30,
    leadTimeNewBuild: 30,
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
    yieldSimpleLoss: 0,  // intensity (0.075 wafers/accelerator) already net of yield

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    // Growth: demand-driven, no growth cap (lead time and utilization only); gates on its own capacity.

    baseRate: {
      value: 95000,
      confidence: 'high',
      source: 'Industry CoWoS-class capacity ~95k wafers/month at end-2025 (TSMC ~75k + OSAT ~20k) → ~130k end-2026, ~170k 2027, ~260k end-2028 (TrendForce Sep-2026)',
      historicalRange: [76000, 180000]
    }
  },

  {
    id: 'hybrid_bonding',
    name: 'Hybrid Bonding (3D)',
    group: 'D',
    unit: 'wafer-equiv/month',
    description: 'Advanced 3D stacking for future chips',

    demandDriverType: 'derived',
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (gpuToComponents.hybridBondingPerGpu × hybridBondingAdoption (2% → 25%))
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 20000,  // wafer-equiv/month (kept non-binding in 2026; adoption is low)
    committedExpansions: [
      { date: '2026-06', capacityAdd: 5000, type: 'committed' },
      { date: '2027-06', capacityAdd: 8000, type: 'committed' }
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

    // Growth: demand-driven, no growth cap. Non-gating: short bonding falls back to CoWoS-only packaging.

    baseRate: {
      value: 20000,
      confidence: 'low',
      source: 'wafer-equiv/month (kept non-binding in 2026; adoption is low)',
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

    startingCapacity: 150000,  // includes expansions completed by the model start
    committedExpansions: [],
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

    // Growth: demand-driven, no growth cap (lead time and utilization only).

    baseRate: {
      value: 150000,
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

    startingCapacity: 2200000,  // final test/assembly scales with packaging (sized to support ~40 GW/yr in 2026)
    committedExpansions: [],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 24,
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

    // Growth: demand-driven, no growth cap (lead time and utilization only).

    baseRate: {
      value: 2200000,
      confidence: 'medium',
      source: 'final test/assembly scales with packaging (sized to support ~40 GW/yr in 2026)',
      historicalRange: [500000, 2750000]
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
    // Engine sources this intensity from TRANSLATION_INTENSITIES.gpuToComponents
    // .advancedWafersPerGpu in assumptions.js; kept in sync for display.
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (gpuToComponents.advancedWafersPerGpu)
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 120000,  // Leading-edge wafers to AI ~120k/month at the start (~60% of TSMC N3 plus part of N5/N4; SemiAnalysis), ~1.5-2M/yr in 2026
    committedExpansions: [],
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
    yieldSimpleLoss: 0,  // intensity (0.06 wafers/accelerator) already net of die yield

    geoRiskFlag: true,
    exportControlSensitivity: 'critical',

    // Growth: demand-driven, no growth cap; ceiling = EUV-supported leading-edge wafers (SHARED_SUPPLY_POOLS.leadingEdge).

    baseRate: {
      value: 120000,
      confidence: 'high',
      source: 'Leading-edge wafers to AI ~120k/month at the start (~60% of TSMC N3 plus part of N5/N4; SemiAnalysis), ~1.5-2M/yr in 2026',
      historicalRange: [96000, 240000]
    }
  },

  {
    id: 'euv_tools',
    name: 'EUV Lithography Tools',
    group: 'E',
    unit: 'tools/month',
    description: 'ASML EUV tool deliveries',

    demandDriverType: 'derived',
    // Demand: tools needed to keep the EUV wafer ceiling ahead of AI wafer demand (computed in the engine)
    parentNodeIds: ['advanced_wafers'],

    startingCapacity: 4.8,  // End-2025 run-rate (48 tools shipped in 2025); growing on ASML's schedule gives ~65 low-NA EUV tools in 2026 and ~385 installed end-2026. Limits wafer-capacity growth, not a per-accelerator gate
    committedExpansions: [],
    leadTimeDebottleneck: 36,
    growsAtPhysicalMax: true,
    maxAnnualExpansionSchedule: [{ until: 2028, cap: 0.28 }, { until: 2045, cap: 0.10 }],  // PHYSICAL: ASML capacity +30% for 2027, studying +30% for 2028 (Zeiss optics limit); ~10%/yr after
    leadTimeNewBuild: 60,
    rampProfile: 'step',

    elasticityShort: 0.01,
    elasticityMid: 0.05,
    elasticityLong: 0.2,

    substitutabilityScore: 0.0,
    supplierConcentration: 5,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 1.0,  // deliveries are counted in full

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'high',

    baseRate: {
      value: 4.8,
      confidence: 'high',
      source: 'ASML ~65 low-NA EUV tools shipped in 2026 (44 in 2025); ~385 installed end-2026. Limits wafer-capacity growth, not a per-accelerator gate',
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

    startingCapacity: 250000,  // switch silicon; not a known bottleneck (sized to support ~40 GW/yr in 2026)
    committedExpansions: [],
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
      value: 250000,
      confidence: 'medium',
      source: 'switch silicon; not a known bottleneck (sized to support ~40 GW/yr in 2026)',
      historicalRange: [60000, 312500]
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

    startingCapacity: 2200000,  // accelerator-sets/month: ~63M 800G+ modules in 2026 (TrendForce) at 2-3 per accelerator
    committedExpansions: [],
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
      value: 2200000,
      confidence: 'medium',
      source: 'TrendForce: ~63M 800G+ modules in 2026 (2.6x y/y), 2-3 per accelerator; EML laser shortfall ~30%',
      historicalRange: [1500000, 3000000]
    }
  },

  {
    id: 'optical_lasers',
    name: 'InP Laser Chips',
    group: 'F',
    unit: 'accelerator-sets/month',
    description: 'Indium phosphide EMLs and CW lasers inside optical transceivers (silicon photonics still needs an InP light source)',

    demandDriverType: 'derived',
    inputIntensity: 1,
    parentNodeIds: ['gpu_datacenter'],

    // Laser sets for the transceivers of one accelerator. Opens ~30% short of
    // demand (Lumentum, May 2026: EML demand >30% above supply).
    startingCapacity: 1020000,
    // Lumentum +50% EML units by end-CY26 and a North Carolina fab from 2028;
    // Coherent doubling 6-inch InP output in 2026 and again by end-2027
    committedExpansions: [
      { date: '2026-07', capacityAdd: 250000, type: 'committed' },
      { date: '2027-01', capacityAdd: 300000, type: 'committed' },
      { date: '2027-07', capacityAdd: 300000, type: 'committed' },
      { date: '2028-06', capacityAdd: 400000, type: 'committed' }
    ],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 30,
    rampProfile: 's-curve',

    elasticityShort: 0.05,
    elasticityMid: 0.25,
    elasticityLong: 0.6,

    substitutabilityScore: 0.2,
    supplierConcentration: 4,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 2,
    maxCapacityUtilization: 0.95,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: false,
    exportControlSensitivity: 'medium',

    // Non-gating: a laser shortfall shows up as price, allocation and a shift
    // to designs that use fewer lasers (CW + silicon photonics, copper for
    // short links), not as fewer accelerators deployed.

    baseRate: {
      value: 1020000,
      confidence: 'low',
      source: 'Lumentum (May 2026): EML demand >30% above supply, sole 200G/lane EML supplier at volume, +50% EML units by end-CY26, NC fab from 2028; Coherent doubling 6-inch InP in 2026 and again by end-2027; Nvidia $2B each to Lumentum and Coherent (Mar 2026). Makers: Lumentum, Coherent, Broadcom, Mitsubishi Electric, Sumitomo',
      historicalRange: [800000, 1400000]
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
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (1 / serverToInfra.gpusPerServer)
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 750000,  // includes expansions completed by the model start
    committedExpansions: [],
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
      value: 750000,
      confidence: 'high',
      source: 'ODM quarterly reports',
      historicalRange: [400000, 800000]
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

    startingCapacity: 60000,  // includes expansions completed by the model start
    committedExpansions: [],
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
      value: 60000,
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

    startingCapacity: 110000,  // CDUs/cold plates; not a known bottleneck (sized to support ~40 GW/yr in 2026)
    committedExpansions: [],
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
      value: 110000,
      confidence: 'medium',
      source: 'CDUs/cold plates; not a known bottleneck (sized to support ~40 GW/yr in 2026)',
      historicalRange: [10000, 137500]
    }
  },

  // ========================================
  // GROUP H: DATA CENTERS
  // ========================================
  {
    id: 'datacenter_mw',
    name: 'Data Center Capacity',
    group: 'H',
    unit: 'MW/month',
    description: 'Datacenter shells (building, MEP, fit-out) completed by the construction pipeline',

    demandDriverType: 'derived',
    // Capacity = the construction pipeline's completions each month
    // (BUILD_ASSUMPTIONS.pipeline: starts, 18-month builds, on-time share,
    // slips). startingCapacity is reference only: the opening pipeline sets 2026.
    parentNodeIds: ['gpu_datacenter', 'gpu_inference', 'grid_interconnect', 'off_grid_power'],

    startingCapacity: 3680,  // reference: ~25-35 GW IT/yr facility construction globally in 2026 (JLL, SemiAnalysis)
    committedExpansions: [],
    leadTimeDebottleneck: 24,
    leadTimeNewBuild: 48,
    rampProfile: 's-curve',

    elasticityShort: 0.1,
    elasticityMid: 0.3,
    elasticityLong: 0.7,

    // High substitutability: grid power and off-grid power are interchangeable MW
    substitutabilityScore: 0.9,
    supplierConcentration: 2,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.85,

    yieldModel: 'simple',
    yieldSimpleLoss: 0,

    geoRiskFlag: true,
    exportControlSensitivity: 'low',

    // Growth: construction starts follow expected need, paced by crews (dc_construction) and the budget; power hookups gate separately.

    baseRate: {
      value: 3680,
      confidence: 'medium',
      source: 'Facility construction ~25-35 GW IT/yr globally in 2026 (JLL, SemiAnalysis 22 GW US under vertical construction for 2027) → ~30 GW IT ≈ 37.5 GW facility/yr ÷ 0.85',
      historicalRange: [1000, 4600]
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
    description: 'Utility grid connection approvals (3-5 year hookup queues)',

    demandDriverType: 'derived',
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (MW per accelerator (grid share of power hookups))
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 1950,  // Ex-China grid-connected AI-DC energization ~15 GW IT/yr in 2026 (US ~8-12 per FERC/Goldman/SemiAnalysis + Europe/Gulf/Asia ex-China ~4-6) ≈ 18.75 GW facility/yr ÷ 0.80 availability
    committedExpansions: [],
    leadTimeDebottleneck: 36,
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

    // Growth: demand-driven; ceiling = AI share of industry output (SHARED_SUPPLY_POOLS.industry)

    baseRate: {
      value: 1950,
      confidence: 'medium',
      source: 'Ex-China grid-connected AI-DC energization ~15 GW IT/yr in 2026 (US ~8-12 per FERC/Goldman/SemiAnalysis + Europe/Gulf/Asia ex-China ~4-6) ≈ 18.75 GW facility/yr ÷ 0.80 availability',
      historicalRange: [1560, 8000]
    }
  },

  {
    id: 'transformers_lpt',
    name: 'Large Power Transformers',
    group: 'I',
    unit: 'units/month',
    description: 'High-voltage transformers for substations',

    demandDriverType: 'derived',
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (MW per accelerator × powerChain.transformersPerMw (grid share))
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 92,  // Large power transformers available to AI DCs: supports ~30 GW IT/yr in 2026 (global ~25-35 per Wood Mackenzie deficits, 128-210 wk lead times) at 2.5 LPT per 100 MW facility ÷ 0.85
    committedExpansions: [],
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

    // Growth: demand-driven; ceiling = AI share of industry output (SHARED_SUPPLY_POOLS.industry)

    baseRate: {
      value: 92,
      confidence: 'medium',
      source: 'Large power transformers available to AI DCs: supports ~30 GW IT/yr in 2026 (global ~25-35 per Wood Mackenzie deficits, 128-210 wk lead times) at 2.5 LPT per 100 MW facility ÷ 0.85',
      historicalRange: [74, 400]
    }
  },

  {
    id: 'power_generation',
    name: 'Power Generation PPAs',
    group: 'I',
    unit: 'MW-contracted/month',
    description: 'Contracted incremental generation for new loads',

    demandDriverType: 'derived',
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (MW per accelerator (grid share))
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 10000,  // includes expansions completed by the model start
    committedExpansions: [],
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

    // Physical ramp limit: permitting + environmental review for new generation
    // sites; regulatory throughput cannot be bought.
    maxAnnualExpansion: 0.25,  // PHYSICAL: grid-scale generation build (firm capacity additions)

    baseRate: {
      value: 10000,
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
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (MW per accelerator × powerChain.redundancyFactor)
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 12000,  // includes expansions completed by the model start
    committedExpansions: [],
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
      value: 12000,
      confidence: 'medium',
      source: 'UPS/generator market estimates',
      historicalRange: [6000, 15000]
    }
  },

  {
    id: 'dc_construction',
    name: 'DC Construction Labor',
    group: 'I',
    unit: 'worker-months/month',
    description: 'Skilled labor availability for DC buildouts',

    demandDriverType: 'derived',
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (MW per accelerator × serverToInfra.workerMonthsPerMw)
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 590000,  // Worker-months/month for DC construction: supports ~45 GW IT/yr in 2026 (not yet binding) at ~100 worker-months per MW facility (Abilene ~6.4k workers for 1.2 GW; ~80-150k per GW IT)
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
      value: 590000,
      confidence: 'low',
      source: 'Worker-months/month for DC construction: supports ~45 GW IT/yr in 2026 (not yet binding) at ~100 worker-months per MW facility (Abilene ~6.4k workers for 1.2 GW; ~80-150k per GW IT)',
      historicalRange: [472000, 8000000]
    }
  },

  {
    id: 'dc_ops_staff',
    name: 'Data Center Operations Staff',
    group: 'I',
    unit: 'FTEs/month',
    description: 'Ops staffing for running/maintaining data centers',

    demandDriverType: 'derived',
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (MW per accelerator × serverToInfra.ftesPerMw)
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
      source: 'Staffing proxy (gates net fleet growth)',
      historicalRange: [20000, 120000]
    }
  },

  // Off-grid / behind-the-meter generation: gas turbines, solar+storage, SMRs.
  // Represents the Epoch AI thesis that datacenter power can bypass utility grid
  // queues entirely by co-locating generation. These are manufactured goods
  // (turbines, panels, battery modules) that scale like factories, not civil works.
  {
    id: 'off_grid_power',
    name: 'Off-Grid Power Stack (Gas/Solar/SMR)',
    group: 'I',
    unit: 'MW/month',
    description: 'Behind-the-meter generation: gas turbines (18mo), solar+storage (12-18mo), SMRs (36-60mo). Bypasses grid interconnect queue.',

    demandDriverType: 'derived',
    // Intensity per accelerator: engine-derived from TRANSLATION_INTENSITIES (MW per accelerator (on-site share of power hookups))
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 175,  // BTM on-site generation ~1.5 GW IT/yr in 2026 (Cleanview: ~2 → ~3 GW operating in the US) ≈ 1.9 GW facility/yr ÷ 0.90
    committedExpansions: [],
    leadTimeDebottleneck: 12,
    leadTimeNewBuild: 24,
    rampProfile: 's-curve',

    elasticityShort: 0.5,
    elasticityMid: 1.2,
    elasticityLong: 2.0,

    substitutabilityScore: 0.9,
    supplierConcentration: 1,

    contractingRegime: 'LTAs',
    inventoryBufferTarget: 0,
    maxCapacityUtilization: 0.90,

    // Gas turbines are factory-built (GE Vernova, Siemens, MHI slots sold out to
    // ~2028); engines and fuel cells fill in. Growth: demand-driven; ceiling = AI share of industry output (SHARED_SUPPLY_POOLS.industry)

    yieldModel: 'simple',
    yieldSimpleLoss: 0.05,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 175,
      confidence: 'medium',
      source: 'BTM on-site generation ~1.5 GW IT/yr in 2026 (Cleanview: ~2 → ~3 GW operating in the US) ≈ 1.9 GW facility/yr ÷ 0.90',
      historicalRange: [140, 3000]
    }
  }
];

// Apply JSON overrides
export const NODES = (nodesOverrides?.nodes)
  ? NODES_BASE.map(n => deepMerge(n, nodesOverrides.nodes[n.id] || {}))
  : NODES_BASE;

// Export update log / metadata
export const ASSUMPTION_UPDATE_LOG = nodesOverrides?.updateLog || [];

// Get node by ID
export function getNode(nodeId) {
  return NODES.find(n => n.id === nodeId);
}

// Get nodes by group
export function getNodesByGroup(groupId) {
  return NODES.filter(n => n.group === groupId);
}

