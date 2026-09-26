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
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: 3 runs/month (Feb 2026) — more frontier labs actively training
    baseRate: {
      value: 3,
      confidence: 'medium',
      source: 'Industry cadence: OpenAI, Anthropic, Google, Meta, xAI, Mistral. As of 2026-02.',
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
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    baseRate: {
      value: 300,
      confidence: 'medium',
      source: 'Fine-tuning explosion; 31% orgs in production (2x 2024 rate). As of 2026-02.',
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
    inputIntensity: 1,
    parentNodeIds: [],

    startingCapacity: null,
    committedExpansions: [],
    leadTimeMonths: 0,
    rampProfile: 'step',

    // Base rate: 250T tokens/month consumer inference (Feb 2026)
    // ChatGPT 810M WAU, Gemini 750M MAU, Claude 18.8M users
    baseRate: {
      value: 250e12,
      confidence: 'medium',
      source: 'Consumer AI usage estimates. ChatGPT 810M WAU. As of 2026-02.',
      historicalRange: [100e12, 500e12]
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

    // Base rate: 200T tokens/month enterprise inference (Feb 2026)
    // 71% of orgs using GenAI; $37B+ enterprise AI spend
    baseRate: {
      value: 200e12,
      confidence: 'medium',
      source: 'Enterprise AI adoption 71% of orgs; cloud earnings. As of 2026-02.',
      historicalRange: [100e12, 400e12]
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

    // Base rate: 50T tokens/month agentic inference (Feb 2026)
    // AI agent deployments doubling every 4 months; 40% enterprise apps by end 2026
    baseRate: {
      value: 50e12,
      confidence: 'low',
      source: 'Agentic AI doubling every 4mo; 1B agents projected by end 2026. As of 2026-02.',
      historicalRange: [20e12, 100e12]
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

    // Base rate: ~7.2M datacenter GPUs shipped 2025 (NVIDIA Blackwell ramp + competitors)
    // NVIDIA datacenter revenue $115B+ FY2026; Blackwell shipping at scale
    startingCapacity: 600000,  // units/month (~7.2M/yr)
    committedExpansions: [
      { date: '2026-06', capacityAdd: 150000, type: 'committed' },
      { date: '2027-01', capacityAdd: 200000, type: 'committed' },
      { date: '2027-07', capacityAdd: 200000, type: 'optional' }
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
      value: 600000,
      confidence: 'high',
      source: 'NVIDIA Blackwell ramp + AMD MI300X; datacenter rev $115B+ FY2026. As of 2026-02.',
      historicalRange: [450000, 900000]
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

    startingCapacity: 350000,
    committedExpansions: [
      { date: '2026-06', capacityAdd: 100000, type: 'committed' },
      { date: '2027-01', capacityAdd: 150000, type: 'optional' }
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
      value: 350000,
      confidence: 'medium',
      source: 'AMD MI300X, Intel Gaudi, Google TPU, custom ASICs ramping. As of 2026-02.',
      historicalRange: [200000, 600000]
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

    startingCapacity: 912000,  // rescaled to the Excel-anchored fleet (was 400000)
    committedExpansions: [
      { date: '2025-06', capacityAdd: 228000, type: 'committed' }
    ],
    leadTimeDebottleneck: 4,
    maxAnnualExpansion: 0.6,  // Merchant NIC/DPU supply on shared leading-edge wafers
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

    startingCapacity: 7000000,   // HBM3E ramp by SK Hynix, Samsung, Micron
    committedExpansions: [
      { date: '2026-06', capacityAdd: 2000000, type: 'committed' },
      { date: '2027-01', capacityAdd: 2500000, type: 'committed' },
      { date: '2027-09', capacityAdd: 1500000, type: 'optional' }
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

    // Parallelism constraint: HBM advanced packaging (TSV, microbump) requires
    // specialized lines. SK Hynix grew ~80% in 2024 at peak crisis effort; 100%
    // allows headroom for Samsung/Micron simultaneous ramps but caps unrealistic
    // 150%+ growth that shortage elasticity could otherwise produce.
    maxAnnualExpansion: 0.5,  // HBM bit growth limited by TSV capacity and DRAM wafer diversion

    baseRate: {
      value: 7000000,
      confidence: 'high',
      source: 'HBM3E ramp; revenue 300%+ growth 2024; SK Hynix/Samsung/Micron expanding. As of 2026-02.',
      historicalRange: [5000000, 10000000]
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

    startingCapacity: 81600000,  // rescaled: ~1.1 EB/yr AI-server DRAM in 2026 (GB200-class ~240 GB/GPU); tight in the 2026 memory crunch (was 34000000)
    committedExpansions: [
      { date: '2026-01', capacityAdd: 9600000, type: 'optional' }
    ],
    leadTimeDebottleneck: 12,
    maxAnnualExpansion: 0.2,  // DRAM bit supply grows ~15-25%/yr; makers expand cautiously after past gluts
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

    startingCapacity: 1998000,  // rescaled to the Excel-anchored fleet (was 540000)
    committedExpansions: [
      { date: '2026-01', capacityAdd: 296000, type: 'optional' }
    ],
    leadTimeDebottleneck: 6,
    maxAnnualExpansion: 0.4,  // NAND supply grows ~20-40%/yr
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
    // Engine sources this intensity from TRANSLATION_INTENSITIES.gpuToComponents
    // .cowosWaferEquivPerGpu in assumptions.js; kept in sync for display.
    inputIntensity: 0.3,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 235200,  // rescaled to the Excel-anchored fleet (~12 GW-equiv chip supply in 2026) (was 120000)
    committedExpansions: [
      { date: '2026-06', capacityAdd: 58800, type: 'committed' },
      { date: '2027-01', capacityAdd: 78400, type: 'committed' },
      { date: '2027-06', capacityAdd: 39200, type: 'optional' }
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

    // Parallelism constraint: TSMC CoWoS doubled in 18 months at peak (~67%/yr).
    // 100% cap allows continued aggressive build-out (Amkor, ASE entering) but
    // prevents unrealistic 150%+ rates the shortage elasticity could otherwise drive.
    maxAnnualExpansion: 0.6,  // CoWoS roughly doubled in 2024 and 2025; growth slowing as easy conversions are used up

    baseRate: {
      value: 120000,
      confidence: 'high',
      source: 'TSMC CoWoS doubled through 2025; continued aggressive expansion. As of 2026-02.',
      historicalRange: [90000, 180000]
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

    // Parallelism constraint: emerging tech with limited tool supply (EVG, ASMPT)
    // and process know-how. 80% allows fast scale from a low base but caps the
    // shortage-driven runaway rates the elasticity formula could otherwise hit.
    maxAnnualExpansion: 0.80,

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

    // Parallelism constraint: ABF is supplied by a handful of Japanese chemical
    // makers (Ajinomoto and a few competitors); throughput limited by reactor
    // capacity and feedstock supply. Historical industry growth ~20-30%/yr.
    maxAnnualExpansion: 0.50,

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

    startingCapacity: 1016000,  // rescaled to the Excel-anchored fleet (was 800000)
    committedExpansions: [
      { date: '2026-01', capacityAdd: 127000, type: 'optional' }
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

    // Parallelism constraint: OSAT (ASE, Amkor, JCET) growth limited by clean-room
    // build-out and tester capex. Industry historically grows ~20-40%/yr in boom.
    maxAnnualExpansion: 0.5,  // Advanced test/assembly lines take 12-24 months to add

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
    // Engine sources this intensity from TRANSLATION_INTENSITIES.gpuToComponents
    // .advancedWafersPerGpu in assumptions.js; kept in sync for display.
    inputIntensity: 0.3,
    parentNodeIds: ['gpu_datacenter'],

    startingCapacity: 232200,  // rescaled to the Excel-anchored fleet (was 180000)
    committedExpansions: [
      { date: '2025-06', capacityAdd: 25800, type: 'committed' },
      { date: '2026-06', capacityAdd: 51600, type: 'committed' }
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

    // Parallelism constraint: leading-edge fab capex is multi-year (36mo new build)
    // and gated by EUV tool throughput from ASML. Historical TSMC advanced-node
    // capacity grew ~25-35%/yr at peak. 50% cap allows aggressive scenarios.
    maxAnnualExpansion: 0.25,  // Leading-edge wafer capacity grows ~20-30%/yr (TSMC N3/N2 ramps, fab construction 2-3 yrs)

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

    startingCapacity: 5.2,  // rescaled to the Excel-anchored fleet (was 4)
    committedExpansions: [
      { date: '2027-01', capacityAdd: 1.3, type: 'optional' }
    ],
    leadTimeDebottleneck: 36,
    maxAnnualExpansion: 0.2,  // ASML ships ~50-60 EUV tools/yr against an installed base of ~250-300; High-NA ramps slowly
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

    startingCapacity: 119000,  // rescaled to the Excel-anchored fleet (was 100000)
    committedExpansions: [
      { date: '2025-06', capacityAdd: 23800, type: 'committed' }
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

    startingCapacity: 35000,
    committedExpansions: [
      { date: '2025-06', capacityAdd: 10000, type: 'committed' },
      { date: '2026-01', capacityAdd: 20000, type: 'optional' }
    ],
    leadTimeDebottleneck: 10,
    maxAnnualExpansion: 0.6,  // CDU and cold-plate supply scaling with rack power
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
    inputIntensity: 0.00182,  // kwPerGpu(1.4) * pue(1.3) / 1000 = MW per accelerator (engine scales with kW growth)
    parentNodeIds: ['gpu_datacenter', 'gpu_inference', 'grid_interconnect', 'off_grid_power'],

    startingCapacity: 3680,  // Facility construction ~25-35 GW IT/yr globally in 2026 (JLL, SemiAnalysis 22 GW US under vertical construction for 2027) → ~30 GW IT ≈ 37.5 GW facility/yr ÷ 0.85
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

    // Parallelism constraint: construction labor + grid interconnection queue.
    // Hyperscalers can spend unlimited capital but cannot hire unlimited electricians
    // or accelerate utility permitting. Historical DC capacity grew ~25-30%/yr peak.
    // Raised to 100% to allow aggressive buildout scenarios (modular DC, off-grid, etc.)
    maxAnnualExpansion: 0.35,  // Shell construction scales with contractor capacity and permitting
    maxAnnualExpansionSchedule: [{ until: 2027, cap: 0.6 }, { until: 2032, cap: 0.28 }, { until: 2045, cap: 0.1 }],  // One-off +50-80% in 2027 (already under construction), then 20-30%/yr to 2032, ~10%/yr after

    baseRate: {
      value: 1500,
      confidence: 'medium',
      source: '$6.7T capex through 2030 (McKinsey); hyperscaler $300B+/yr capex. As of 2026-02.',
      historicalRange: [1000, 3000]
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
    inputIntensity: 0.00182,  // MW per accelerator (same as datacenter_mw)
    parentNodeIds: ['datacenter_mw'],

    startingCapacity: 2350,  // Grid-connected AI-DC energization ~15-22 GW IT/yr globally in 2026 (US ~8-12; FERC, Goldman, SemiAnalysis) → ~18 GW IT ≈ 22.5 GW facility/yr ÷ 0.80 availability
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

    // Parallelism constraint: regulatory permitting throughput, not capital.
    // Utility commissions process a finite number of interconnection studies per year.
    maxAnnualExpansion: 0.2,  // Excel model: US grid 4.5→12 GW/yr and ex-US 4→13 GW/yr over 2026-2032 (~20%/yr)
    maxAnnualExpansionSchedule: [{ until: 2032, cap: 0.2 }, { until: 2045, cap: 0.1 }],  // Utility capex +17%/yr, 2-4 yr transformer/transmission lead times; 15-25%/yr to 2030-32, ~10%/yr after (tied to firm generation build)

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
    inputIntensity: 0.000364,  // mwPerGpu * transformersPerMw (0.00182 * 0.2)
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

    // Parallelism constraint: ~3,500 skilled LPT winding technicians globally;
    // training pipeline adds ~5-8% workforce/yr. Capital is not the bottleneck.
    maxAnnualExpansion: 0.2,  // Excel model: electrical equipment 7.5→22 GW/yr over 2026-2032 (~20%/yr)
    maxAnnualExpansionSchedule: [{ until: 2028, cap: 0.15 }, { until: 2032, cap: 0.2 }, { until: 2045, cap: 0.1 }],  // LPT plants take 2-3 yrs (Hitachi, Siemens expansions land 2027-28): ~15%/yr, ~20% as new plants open, then ~10%

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
    inputIntensity: 0.00182,  // mwPerGpu (1:1 with datacenter MW demand)
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

    // Parallelism constraint: permitting + environmental review for new generation
    // sites. Labor can be hired; regulatory throughput cannot.
    maxAnnualExpansion: 0.25,

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
    inputIntensity: 0.00273,  // mwPerGpu * redundancyFactor (0.00182 * 1.5)
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
    inputIntensity: 0.728,  // mwPerGpu * 400 worker-months per MW
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

    // Parallelism constraint: skilled electrical/mechanical trades labor pool.
    // Apprenticeship pipeline grows ~5%/yr; poaching from other sectors adds ~3%.
    maxAnnualExpansion: 0.17,  // Excel model: US labor/permitting 9→24 GW/yr over 2026-2032 (~17%/yr)
    maxAnnualExpansionSchedule: [{ until: 2032, cap: 0.15 }, { until: 2045, cap: 0.08 }],  // Electricians grow ~1%/yr (BLS) but modular builds cut field hours ~2-3x and non-US labor is more elastic; binding from ~2027 in TX/OH

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
    inputIntensity: 0.01456,  // mwPerGpu * 8 FTEs per MW
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
    inputIntensity: 0.00182,
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

    // Parallelism constraint: turbine/panel manufacturing + EPC crew availability.
    // Gas turbines are factory-built (GE/Siemens can ramp production lines).
    // Solar panels are commodity. Main bottleneck is EPC labor for installation.
    maxAnnualExpansion: 0.3,  // Excel model: on-site generation 3→12 GW/yr over 2026-2032 (~26%/yr); large turbines booked through 2028
    maxAnnualExpansionSchedule: [{ until: 2029, cap: 1.0 }, { until: 2032, cap: 0.25 }, { until: 2045, cap: 0.1 }],  // 75 GW of binding OEM orders; SemiAnalysis 40+ GW BTM by 2028, BTM equipment >50 GW/yr by 2029 → very fast ramp to 2029, then tied to turbine/recip output (~100 GW/yr global by 2030, DCs 30-50%)

    yieldModel: 'simple',
    yieldSimpleLoss: 0.05,

    geoRiskFlag: false,
    exportControlSensitivity: 'low',

    baseRate: {
      value: 1000,
      confidence: 'medium',
      source: 'Epoch AI analysis; behind-the-meter gas/solar/SMR pipeline estimates. Gas turbines deploy in <2yr.',
      historicalRange: [200, 3000]
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
