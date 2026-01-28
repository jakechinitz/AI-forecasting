/**
 * AI Infrastructure Supply Chain - Calculation Engine
 *
 * This module implements all core calculations for the forecasting model.
 * It uses the CORRECTED formulas from the patch spec:
 *
 * EFFICIENCY MULTIPLIERS:
 *   M_t = (1-m)^(t/12)  - Model efficiency (compute/token) DECREASES - NUMERATOR
 *   S_t = (1+s)^(t/12)  - Systems throughput INCREASES - DENOMINATOR
 *   H_t = (1+h)^(t/12)  - Hardware throughput INCREASES - DENOMINATOR
 *
 * YIELD MODELS:
 *   Simple: Y = 1 - yield_loss
 *   Stacked (HBM): Y(t) = Y_target - (Y_target - Y_initial) * 2^(-t/HL)
 *
 * MARKET CLEARING:
 *   Tightness = (Demand + Backlog) / (Supply + Inventory + ε)
 *   Price_Index = f(Tightness, contracting regime)
 *
 * SUBSTITUTION (with damping):
 *   SubTarget = min(SubMax, SubK * max(0, P_signal - 1))
 *   SubShare_t = SubShare_{t-1} + λ * (SubTarget - SubShare_{t-1})
 *
 * STOCK VS FLOW FIX:
 *   For GPUs and other "stock" assets, we track installed base separately
 *   from shipments (flow). Demand = purchase demand, not required base.
 */

import { NODES, getNode, getChildNodes } from '../data/nodes.js';
import {
  GLOBAL_PARAMS,
  DEMAND_ASSUMPTIONS,
  EFFICIENCY_ASSUMPTIONS,
  getBlockKeyForMonth,
  calculateMt,
  calculateSt,
  calculateHt,
  calculateStackedYield,
  calculateSimpleYield
} from '../data/assumptions.js';

// ============================================
// CONSTANTS
// ============================================
const EPSILON = 1e-10;  // Small value to prevent division by zero

// ============================================
// GROWTH CACHE - Fix for block spikes
// Cumulative growth computed month-by-month
// ============================================
const growthCache = new Map();

/**
 * Clear the growth cache (call when assumptions change)
 */
export function clearGrowthCache() {
  growthCache.clear();
}

// ============================================
// CORE CALCULATION FUNCTIONS
// ============================================

/**
 * Calculate efficiency multipliers for a given month
 * Uses RUNTIME assumptions, not defaults
 */
export function calculateEfficiencyMultipliers(month, assumptions) {
  const blockKey = getBlockKeyForMonth(month);
  const block = assumptions?.[blockKey] || EFFICIENCY_ASSUMPTIONS[blockKey];

  const m_infer = block?.modelEfficiency?.m_inference?.value ?? 0.40;
  const m_train = block?.modelEfficiency?.m_training?.value ?? 0.20;
  const s_infer = block?.systemsEfficiency?.s_inference?.value ?? 0.25;
  const s_train = block?.systemsEfficiency?.s_training?.value ?? 0.15;
  const h = block?.hardwareEfficiency?.h?.value ?? 0.30;

  return {
    // Model efficiency (compute per token) - DECREASES over time
    M_inference: calculateMt(m_infer, month),
    M_training: calculateMt(m_train, month),

    // Systems throughput - INCREASES over time
    S_inference: calculateSt(s_infer, month),
    S_training: calculateSt(s_train, month),

    // Hardware throughput - INCREASES over time
    H: calculateHt(h, month)
  };
}

/**
 * Calculate yield for a node at a given month
 */
export function calculateNodeYield(node, month) {
  if (node.yieldModel === 'stacked') {
    return calculateStackedYield(
      node.yieldInitial ?? 0.65,
      node.yieldTarget ?? 0.85,
      node.yieldHalflifeMonths ?? 18,
      month
    );
  }
  return calculateSimpleYield(node.yieldSimpleLoss ?? 0.03);
}

/**
 * Calculate demand growth multiplier for a given month
 * FIXED: Uses piecewise cumulative growth to avoid block discontinuities
 */
export function calculateDemandGrowth(category, segment, month, assumptions) {
  const key = `${category}:${segment}`;

  // Initialize cache for this key if needed
  if (!growthCache.has(key)) {
    growthCache.set(key, [1]); // month 0 multiplier = 1
  }

  const arr = growthCache.get(key);

  // Build up multipliers month by month
  for (let m = arr.length; m <= month; m++) {
    const blockKey = getBlockKeyForMonth(m);
    const block = assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];

    let rate = 0;
    if (category === 'inference') {
      rate = block?.inferenceGrowth?.[segment]?.value ?? 0.40;
    } else if (category === 'training') {
      rate = block?.trainingGrowth?.[segment]?.value ?? 0.25;
    }

    // Convert annual rate to monthly
    const monthlyRate = Math.pow(1 + rate, 1 / 12) - 1;
    // Compound from previous month
    arr[m] = arr[m - 1] * (1 + monthlyRate);
  }

  return arr[month];
}

/**
 * Calculate capacity at a given month, including expansions
 */
export function calculateCapacity(node, month, scenarioOverrides = {}) {
  let capacity = node.startingCapacity || 0;

  // Add committed expansions
  (node.committedExpansions || []).forEach(expansion => {
    const expansionMonth = dateToMonth(expansion.date);
    if (month >= expansionMonth) {
      // Apply ramp profile
      const monthsSinceExpansion = month - expansionMonth;
      const rampedCapacity = applyRampProfile(
        expansion.capacityAdd,
        monthsSinceExpansion,
        node.rampProfile || 'linear',
        6  // Default ramp duration
      );
      capacity += rampedCapacity;
    }
  });

  // Apply scenario overrides (e.g., geopolitical shock)
  if (scenarioOverrides.supply?.affectedNodes?.includes(node.id)) {
    const shockMonth = scenarioOverrides.supply.shockMonth || 24;
    const reduction = scenarioOverrides.supply.capacityReduction || 0.5;
    const recoveryMonths = scenarioOverrides.supply.recoveryMonths || 36;

    if (month >= shockMonth) {
      const monthsSinceShock = month - shockMonth;
      const recoveryFactor = Math.min(1, monthsSinceShock / recoveryMonths);
      const currentReduction = reduction * (1 - recoveryFactor);
      capacity *= (1 - currentReduction);
    }
  }

  return capacity;
}

/**
 * Apply ramp profile to capacity addition
 */
function applyRampProfile(capacityAdd, monthsSinceExpansion, profile, rampDuration) {
  const t = Math.min(monthsSinceExpansion / rampDuration, 1);

  switch (profile) {
    case 'step':
      return capacityAdd;

    case 'linear':
      return capacityAdd * t;

    case 's-curve':
      // Sigmoid function for S-curve
      const x = (t - 0.5) * 10;  // Scale for sigmoid
      const sigmoid = 1 / (1 + Math.exp(-x));
      return capacityAdd * sigmoid;

    default:
      return capacityAdd * t;
  }
}

/**
 * Convert date string to month index
 */
function dateToMonth(dateStr) {
  const [year, month] = dateStr.split('-').map(Number);
  return (year - GLOBAL_PARAMS.startYear) * 12 + (month - GLOBAL_PARAMS.startMonth);
}

/**
 * Calculate tightness ratio
 * Tightness = (Demand + Backlog) / (Supply + Inventory + ε)
 */
export function calculateTightness(demand, backlog, supply, inventory) {
  return (demand + backlog) / (supply + inventory + EPSILON);
}

/**
 * Calculate price index from tightness
 * Uses the corrected formula with global parameters
 */
export function calculatePriceIndex(tightness, params = GLOBAL_PARAMS.priceIndex) {
  const { a, b, minPrice, maxPrice } = params;

  let price;
  if (tightness <= 1) {
    // Soft market - price decreases
    price = Math.pow(tightness, 0.5);  // Gradual decrease
  } else {
    // Tight market - price spikes
    price = 1 + a * Math.pow(tightness - 1, b);
  }

  return Math.max(minPrice, Math.min(maxPrice, price));
}

/**
 * Calculate substitution share with damping
 * Uses smoothed price signal and sticky adjustment
 */
export function calculateSubstitutionShare(
  currentShare,
  priceSignalSma,
  subMax,
  subK,
  lambda
) {
  const target = Math.min(subMax, subK * Math.max(0, priceSignalSma - 1));
  return currentShare + lambda * (target - currentShare);
}

/**
 * Calculate inventory in units
 */
export function calculateInventory(prevInventory, supply, shipments) {
  return Math.max(0, prevInventory + supply - shipments);
}

/**
 * Calculate months of supply for display
 */
export function calculateMonthsOfSupply(inventoryUnits, forwardDemand, forwardMonths = 3) {
  const avgDemand = forwardDemand.slice(0, forwardMonths).reduce((a, b) => a + b, 0) / forwardMonths;
  return inventoryUnits / (avgDemand + EPSILON);
}

/**
 * Calculate backlog
 */
export function calculateBacklog(prevBacklog, demand, supply) {
  return Math.max(0, prevBacklog + demand - supply);
}

/**
 * Simple moving average
 */
export function sma(values, window) {
  if (values.length < window) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  const slice = values.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / window;
}

// ============================================
// DEMAND ENGINE
// ============================================

/**
 * Calculate total inference demand for a given month
 * Returns tokens/month
 * FIXED: Uses runtime assumptions
 */
export function calculateInferenceDemand(month, assumptions) {
  // Base rates from nodes
  const consumerBase = 1.5e12;  // 1.5T tokens/month
  const enterpriseBase = 2.0e12;
  const agenticBase = 0.3e12;

  // Growth multipliers - using runtime assumptions
  const consumerGrowth = calculateDemandGrowth('inference', 'consumer', month, assumptions);
  const enterpriseGrowth = calculateDemandGrowth('inference', 'enterprise', month, assumptions);
  const agenticGrowth = calculateDemandGrowth('inference', 'agentic', month, assumptions);

  return {
    consumer: consumerBase * consumerGrowth,
    enterprise: enterpriseBase * enterpriseGrowth,
    agentic: agenticBase * agenticGrowth,
    total: (consumerBase * consumerGrowth) +
           (enterpriseBase * enterpriseGrowth) +
           (agenticBase * agenticGrowth)
  };
}

/**
 * Calculate training demand for a given month
 * Returns accelerator-hours/month
 * FIXED: Uses runtime assumptions
 */
export function calculateTrainingDemand(month, demandAssumptions, efficiencyAssumptions) {
  const frontierBase = 1.2;  // runs/month
  const midtierBase = 150;   // runs/month

  // Compute per run (accelerator-hours)
  const frontierComputePerRun = 1e6;   // 1M accelerator-hours per frontier run
  const midtierComputePerRun = 5000;   // 5K accelerator-hours per mid-tier run

  const frontierGrowth = calculateDemandGrowth('training', 'frontier', month, demandAssumptions);
  const midtierGrowth = calculateDemandGrowth('training', 'midtier', month, demandAssumptions);

  // Get efficiency multipliers - using runtime assumptions
  const eff = calculateEfficiencyMultipliers(month, efficiencyAssumptions);

  return {
    frontierRuns: frontierBase * frontierGrowth,
    midtierRuns: midtierBase * midtierGrowth,
    // Apply efficiency: demand * M_t / (S_t * H_t)
    frontierAccelHours: (frontierBase * frontierGrowth * frontierComputePerRun * eff.M_training) /
                        (eff.S_training * eff.H),
    midtierAccelHours: (midtierBase * midtierGrowth * midtierComputePerRun * eff.M_training) /
                       (eff.S_training * eff.H),
    totalAccelHours: 0  // Calculated below
  };
}

/**
 * Calculate accelerator hours required for inference
 * FIXED: Uses runtime assumptions
 */
export function calculateInferenceAccelHours(tokens, month, efficiencyAssumptions) {
  const eff = calculateEfficiencyMultipliers(month, efficiencyAssumptions);

  // Base conversion: FLOPs per token at t=0
  const flopsPerToken = 2e9;  // 2 GFLOP per token
  const accelFlopsPerHour = 1e15 * 3600;  // ~1 PFLOP-hour per accel-hour

  // Apply efficiency: tokens * flops/token * M_t / (S_t * H_t * throughput)
  const rawAccelHours = (tokens * flopsPerToken * eff.M_inference) /
                        (eff.S_inference * eff.H * accelFlopsPerHour);

  return rawAccelHours;
}

// ============================================
// TRANSLATION LAYER
// ============================================

/**
 * Translate accelerator hours to GPU REQUIRED BASE (stock needed)
 */
export function accelHoursToRequiredGpuBase(accelHours, utilization = 0.70) {
  const hoursPerMonth = 720;  // 30 days * 24 hours
  return accelHours / (hoursPerMonth * utilization);
}

/**
 * Translate GPU demand to component demands
 */
export function gpuToComponentDemands(gpuCount) {
  return {
    hbmStacks: gpuCount * 8,           // 8 HBM stacks per GPU
    cowosWaferEquiv: gpuCount * 0.5,   // 2 GPUs per CoWoS wafer
    advancedWafers: gpuCount * 0.5,    // Logic die wafers
    serverDramGb: gpuCount * 64,       // 64GB DRAM per GPU
    servers: gpuCount / 8,             // 8 GPUs per server
    transceivers: gpuCount * 1,        // 1 transceiver per GPU
    cdus: gpuCount * 0.05,             // 1 CDU per 20 GPUs
    powerMw: gpuCount * 0.001          // 1 kW per GPU
  };
}

/**
 * Translate data center MW to power infrastructure
 */
export function dcMwToPowerDemands(mw) {
  return {
    transformers: mw * 0.02,           // 1 transformer per 50 MW
    gridApprovals: mw * 1.0,           // 1:1 for MW approvals
    ppas: mw * 1.2,                    // 120% for redundancy
    backupMw: mw * 1.5                 // 150% for N+1
  };
}

// ============================================
// FULL SIMULATION ENGINE
// ============================================

/**
 * Run the full simulation for all months
 * Returns complete time series data for all nodes
 *
 * FIXES APPLIED:
 * 1. Cumulative growth (no block spikes)
 * 2. Stock vs flow for GPUs (installed base tracking)
 * 3. Runtime assumptions used everywhere
 * 4. Group A excluded from market clearing
 */
export function runSimulation(assumptions, scenarioOverrides = {}) {
  // Clear growth cache for fresh calculation with new assumptions
  clearGrowthCache();

  const months = GLOBAL_PARAMS.horizonYears * 12;
  const results = {
    months: [],
    nodes: {},
    summary: {
      shortages: [],
      gluts: [],
      bottlenecks: []
    }
  };

  // Extract demand and efficiency assumptions
  const demandAssumptions = assumptions?.demand || DEMAND_ASSUMPTIONS;
  const efficiencyAssumptions = assumptions?.efficiency || EFFICIENCY_ASSUMPTIONS;

  // Initialize node state
  const nodeState = {};
  NODES.forEach(node => {
    // STOCK VS FLOW FIX: Track installed base for GPU nodes
    const isStockNode = ['gpu_datacenter', 'gpu_inference'].includes(node.id);
    const startingInstalledBase = isStockNode ? (node.startingCapacity || 0) * 6 : 0; // ~6 months of initial shipments
    const lifetimeMonths = node.lifetimeMonths || 48; // 4 year default lifetime

    nodeState[node.id] = {
      inventory: (node.inventoryBufferTarget || 0) * (node.startingCapacity || 0) / 4,
      backlog: 0,
      subShare: 0,
      priceHistory: [1],
      tightnessHistory: [1],
      // Stock tracking
      installedBase: startingInstalledBase,
      lifetimeMonths: lifetimeMonths
    };
    results.nodes[node.id] = {
      demand: [],
      supply: [],
      tightness: [],
      priceIndex: [],
      inventory: [],
      backlog: [],
      capacity: [],
      yield: [],
      shortage: [],
      glut: [],
      installedBase: []
    };
  });

  // Run simulation for each month
  for (let month = 0; month < months; month++) {
    results.months.push(month);

    // Calculate workload demands using runtime assumptions
    const inferenceDemand = calculateInferenceDemand(month, demandAssumptions);
    const trainingDemand = calculateTrainingDemand(month, demandAssumptions, efficiencyAssumptions);

    // Calculate total accelerator hours
    const inferenceAccelHours = calculateInferenceAccelHours(inferenceDemand.total, month, efficiencyAssumptions);
    const totalAccelHours = inferenceAccelHours + trainingDemand.frontierAccelHours + trainingDemand.midtierAccelHours;

    // Translate to GPU REQUIRED BASE (stock needed to run workloads)
    const requiredGpuBase = accelHoursToRequiredGpuBase(totalAccelHours);
    const componentDemands = gpuToComponentDemands(requiredGpuBase);

    // Process each node
    NODES.forEach(node => {
      const state = nodeState[node.id];
      const nodeResults = results.nodes[node.id];

      // Skip market clearing for Group A (workload drivers)
      if (node.group === 'A') {
        // For workload nodes, just track demand for display
        let workloadDemand = node.baseRate?.value || 0;
        workloadDemand *= calculateDemandGrowth(
          node.id.includes('inference') ? 'inference' : 'training',
          node.id.includes('consumer') ? 'consumer' :
            node.id.includes('enterprise') ? 'enterprise' :
              node.id.includes('agentic') ? 'agentic' :
                node.id.includes('frontier') ? 'frontier' : 'midtier',
          month,
          demandAssumptions
        );

        // Store workload demand but use neutral values for market metrics
        nodeResults.demand.push(workloadDemand);
        nodeResults.supply.push(workloadDemand); // Supply = demand (no constraint)
        nodeResults.capacity.push(workloadDemand);
        nodeResults.yield.push(1);
        nodeResults.tightness.push(1);  // Neutral - not a market
        nodeResults.priceIndex.push(1);
        nodeResults.inventory.push(0);
        nodeResults.backlog.push(0);
        nodeResults.shortage.push(0);
        nodeResults.glut.push(0);
        nodeResults.installedBase.push(0);
        return; // Skip rest of market clearing
      }

      // Calculate capacity and supply (shipments)
      const capacity = calculateCapacity(node, month, scenarioOverrides);
      const nodeYield = calculateNodeYield(node, month);
      const maxUtilization = node.maxCapacityUtilization || 0.95;
      const shipments = capacity * maxUtilization * nodeYield;

      // Calculate demand based on node type
      let demand = 0;

      // STOCK VS FLOW FIX: For GPU nodes, demand = purchase demand, not required base
      if (node.id === 'gpu_datacenter') {
        // Calculate retirements
        const retirements = state.installedBase / state.lifetimeMonths;

        // Purchase demand = gap to required base + replacements
        const gap = Math.max(0, requiredGpuBase - state.installedBase);
        demand = gap + retirements;

        // Update installed base after this month's shipments
        const actualShipments = Math.min(shipments + state.inventory, demand + state.backlog);
        state.installedBase = Math.max(0, state.installedBase + actualShipments - retirements);

        nodeResults.installedBase.push(state.installedBase);
      } else if (node.id === 'hbm_stacks') {
        demand = componentDemands.hbmStacks;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'cowos_capacity') {
        demand = componentDemands.cowosWaferEquiv;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'advanced_wafers') {
        demand = componentDemands.advancedWafers;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'server_assembly') {
        demand = componentDemands.servers;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'datacenter_mw') {
        demand = componentDemands.powerMw;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'transformers_lpt') {
        demand = dcMwToPowerDemands(componentDemands.powerMw).transformers;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'optical_transceivers') {
        demand = componentDemands.transceivers;
        nodeResults.installedBase.push(0);
      } else if (node.id === 'liquid_cooling') {
        demand = componentDemands.cdus;
        nodeResults.installedBase.push(0);
      } else {
        // Derived demand from parent nodes using intensity
        const parentDemands = (node.parentNodeIds || []).map(pid => {
          const parentResult = results.nodes[pid];
          if (parentResult && parentResult.demand.length > 0) {
            return parentResult.demand[parentResult.demand.length - 1] || 0;
          }
          return 0;
        });
        demand = parentDemands.reduce((sum, d) => sum + d, 0) * (node.inputIntensity || 1);
        nodeResults.installedBase.push(0);
      }

      // Calculate tightness
      const tightness = calculateTightness(demand, state.backlog, shipments, state.inventory);

      // Update price history and calculate SMA for substitution
      state.priceHistory.push(calculatePriceIndex(tightness));
      const priceSignalSma = sma(state.priceHistory, GLOBAL_PARAMS.substitution.priceSignalSmaMonths);

      // Calculate substitution if applicable
      if (node.substitutabilityScore > 0 && tightness > 1) {
        const subK = 0.2;  // Substitution sensitivity
        state.subShare = calculateSubstitutionShare(
          state.subShare,
          priceSignalSma,
          node.substitutabilityScore,
          subK,
          GLOBAL_PARAMS.substitution.adjustmentSpeed
        );
        // Reduce effective demand by substitution
        demand *= (1 - state.subShare);
      }

      // Update inventory and backlog
      const actualShipments = Math.min(shipments + state.inventory, demand + state.backlog);
      state.inventory = calculateInventory(state.inventory, shipments, actualShipments);
      state.backlog = calculateBacklog(state.backlog, demand, actualShipments);

      // Store results
      nodeResults.demand.push(demand);
      nodeResults.supply.push(shipments);
      nodeResults.capacity.push(capacity);
      nodeResults.yield.push(nodeYield);
      nodeResults.tightness.push(tightness);
      nodeResults.priceIndex.push(state.priceHistory[state.priceHistory.length - 1]);
      nodeResults.inventory.push(state.inventory);
      nodeResults.backlog.push(state.backlog);

      // Detect shortage/glut
      const isShortage = tightness > 1.05;
      const isGlut = tightness < GLOBAL_PARAMS.glutThresholds.soft;
      nodeResults.shortage.push(isShortage ? 1 : 0);
      nodeResults.glut.push(isGlut ? 1 : 0);

      // Update tightness history for persistence checks
      state.tightnessHistory.push(tightness);
    });
  }

  // Analyze results for summary
  results.summary = analyzeResults(results);

  return results;
}

/**
 * Analyze simulation results to find shortages, gluts, and bottlenecks
 * FIXED: Close open-ended periods and exclude Group A
 */
function analyzeResults(results) {
  const shortages = [];
  const gluts = [];
  const bottlenecks = [];

  Object.entries(results.nodes).forEach(([nodeId, data]) => {
    const node = getNode(nodeId);
    if (!node) return;

    // EXCLUDE Group A from shortage/glut analysis (they're demand drivers, not supply nodes)
    if (node.group === 'A') return;

    // Find shortage periods
    let shortageStart = null;
    let peakTightness = 0;
    let shortageDuration = 0;

    data.tightness.forEach((t, month) => {
      if (t > 1.05) {
        if (shortageStart === null) shortageStart = month;
        if (t > peakTightness) peakTightness = t;
        shortageDuration++;
      } else if (shortageStart !== null) {
        shortages.push({
          nodeId,
          nodeName: node.name,
          group: node.group,
          startMonth: shortageStart,
          peakTightness,
          duration: shortageDuration,
          severity: peakTightness * shortageDuration
        });
        shortageStart = null;
        peakTightness = 0;
        shortageDuration = 0;
      }
    });

    // FIX: Close open-ended shortage at horizon end
    if (shortageStart !== null) {
      shortages.push({
        nodeId,
        nodeName: node.name,
        group: node.group,
        startMonth: shortageStart,
        peakTightness,
        duration: shortageDuration,
        severity: peakTightness * shortageDuration
      });
    }

    // Find glut periods
    let glutStart = null;
    let minTightness = 1;
    let glutDuration = 0;

    data.tightness.forEach((t, month) => {
      if (t < GLOBAL_PARAMS.glutThresholds.soft) {
        if (glutStart === null) glutStart = month;
        if (t < minTightness) minTightness = t;
        glutDuration++;
      } else if (glutStart !== null) {
        gluts.push({
          nodeId,
          nodeName: node.name,
          group: node.group,
          startMonth: glutStart,
          minTightness,
          duration: glutDuration,
          severity: (1 - minTightness) * glutDuration
        });
        glutStart = null;
        minTightness = 1;
        glutDuration = 0;
      }
    });

    // FIX: Close open-ended glut at horizon end
    if (glutStart !== null) {
      gluts.push({
        nodeId,
        nodeName: node.name,
        group: node.group,
        startMonth: glutStart,
        minTightness,
        duration: glutDuration,
        severity: (1 - minTightness) * glutDuration
      });
    }

    // Calculate bottleneck score
    const avgTightness = data.tightness.reduce((a, b) => a + b, 0) / data.tightness.length;
    const maxTightness = Math.max(...data.tightness);
    const shortageMonths = data.shortage.filter(s => s === 1).length;

    if (shortageMonths > 0) {
      // Calculate downstream impact
      const childNodes = getChildNodes(nodeId);
      const downstreamImpact = childNodes.length * avgTightness;

      bottlenecks.push({
        nodeId,
        nodeName: node.name,
        group: node.group,
        avgTightness,
        maxTightness,
        shortageMonths,
        downstreamImpact,
        score: avgTightness * shortageMonths * (1 + downstreamImpact / 10)
      });
    }
  });

  // Sort by severity/score
  shortages.sort((a, b) => b.severity - a.severity);
  gluts.sort((a, b) => b.severity - a.severity);
  bottlenecks.sort((a, b) => b.score - a.score);

  return {
    shortages: shortages.slice(0, 20),
    gluts: gluts.slice(0, 20),
    bottlenecks: bottlenecks.slice(0, 10)
  };
}

/**
 * Format month index to display string
 */
export function formatMonth(monthIndex) {
  const year = GLOBAL_PARAMS.startYear + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[month - 1]} ${year}`;
}

/**
 * Format large numbers for display
 */
export function formatNumber(num, decimals = 1) {
  if (num === null || num === undefined) return '-';
  if (Math.abs(num) >= 1e12) return (num / 1e12).toFixed(decimals) + 'T';
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(decimals) + 'B';
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(decimals) + 'M';
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
}
