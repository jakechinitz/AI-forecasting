/**
 * AI Infrastructure Supply Chain - Calculation Engine
 *
 * FINAL POLISHED ARCHITECTURE (v22):
 * * LOGIC FIX: Backlog Paydown is now implicit (New = Old + Baseline - Actual).
 * * LOGIC FIX: Expansion triggers off Flow (Plan), not Stock (Backlog).
 * * SAFETY: Smart Warnings (First occurrence per node).
 * * SAFETY: Loud Constraint Guards.
 */

import { NODES, getNode } from '../data/nodes.js';
import {
  GLOBAL_PARAMS,
  DEMAND_ASSUMPTIONS,
  EFFICIENCY_ASSUMPTIONS,
  TRANSLATION_INTENSITIES,
  getBlockKeyForMonth,
  calculateStackedYield,
  calculateSimpleYield
} from '../data/assumptions.js';

// ============================================
// 1. ONTOLOGY DEFINITIONS
// ============================================

const STOCK_NODES = new Set([
  'gpu_datacenter', 'gpu_inference', 
  'hbm_stacks', 'dram_server', 'ssd_datacenter', 
  'advanced_wafers', 'abf_substrate', 
  'cpu_server', 'dpu_nic', 'switch_asics', 
  'optical_transceivers', 'infiniband_cables',
  'rack_pdu', 'transformers_lpt', 'backup_power',
  'datacenter_mw' 
]);

const THROUGHPUT_NODES = new Set([
  'cowos_capacity', 
  'osat_capacity', 
  'server_assembly', 
  'hybrid_bonding', 
  'liquid_cooling',
  'dc_construction',
  'euv_tools' 
]);

const QUEUE_NODES = new Set([
  'grid_interconnect', 
  'dc_ops_staff', 
  'ml_engineers'
]);

function getNodeType(nodeId) {
  if (STOCK_NODES.has(nodeId)) return 'STOCK';
  if (THROUGHPUT_NODES.has(nodeId)) return 'THROUGHPUT';
  if (QUEUE_NODES.has(nodeId)) return 'QUEUE';
  return 'STOCK';
}

// ============================================
// 2. CORE UTILITIES
// ============================================

const EPSILON = 1e-10;
const CATCHUP_MONTHS = 24; 
const DEFAULT_BUFFER_MONTHS = 2; 
const BACKLOG_PAYDOWN_MONTHS = 24; 

function deepMerge(target, source) {
  if (!source) return target;
  if (!target) return source;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function resolveAssumptionValue(value, fallback) {
  return value ?? fallback ?? 0;
}

function sma(values, window) {
  if (values.length === 0) return 0;
  if (values.length < window) return values.reduce((a, b) => a + b, 0) / values.length;
  return values.slice(-window).reduce((a, b) => a + b, 0) / window;
}

// ============================================
// 3. CALCULATION HELPERS
// ============================================

const growthCache = new Map();

export function clearGrowthCache() {
  growthCache.clear();
}

export function calculateCapacity(node, month, scenarioOverrides = {}, dynamicExpansions = []) {
  let capacity = node.startingCapacity || 0;

  // 1. Committed Expansions (Static)
  (node.committedExpansions || []).forEach(expansion => {
    const onlineMonth = dateToMonth(expansion.date) + (expansion.leadTimeMonths || 0);
    if (month >= onlineMonth) {
      capacity += applyRampProfile(expansion.capacityAdd, month - onlineMonth, node.rampProfile || 'linear', 6);
    }
  });

  // 2. Dynamic Expansions (from the Loop)
  dynamicExpansions.forEach(exp => {
    if (month >= exp.month) {
      capacity += applyRampProfile(exp.capacityAdd, month - exp.month, node.rampProfile || 'linear', 6);
    }
  });

  // 3. Scenario Shocks
  if (scenarioOverrides.supply?.affectedNodes?.includes(node.id)) {
    const shockMonth = scenarioOverrides.supply.shockMonth || 24;
    const reduction = scenarioOverrides.supply.capacityReduction || 0.5;
    if (month >= shockMonth && month < shockMonth + 12) {
      capacity *= (1 - reduction);
    }
  }
  return capacity;
}

function applyRampProfile(capacityAdd, monthsSinceExpansion, profile, rampDuration) {
  const t = Math.min(monthsSinceExpansion / rampDuration, 1);
  if (profile === 'step') return capacityAdd;
  if (profile === 's-curve') return capacityAdd * (1 / (1 + Math.exp(-((t - 0.5) * 10))));
  return capacityAdd * t; // linear
}

function dateToMonth(dateStr) {
  const [year, month] = dateStr.split('-').map(Number);
  return (year - GLOBAL_PARAMS.startYear) * 12 + (month - GLOBAL_PARAMS.startMonth);
}

function calculateNodeYield(node, month) {
   if (node.yieldModel === 'stacked') {
    return calculateStackedYield(node.yieldInitial||0.65, node.yieldTarget||0.85, node.yieldHalflifeMonths||18, month);
   }
   return calculateSimpleYield(node.yieldSimpleLoss || 0.03);
}

function calculateInferenceDemand(month, assumptions) {
    const blockKey = getBlockKeyForMonth(month);
    const block = assumptions?.[blockKey] || DEMAND_ASSUMPTIONS[blockKey];
    const base = block?.workloadBase?.inferenceTokensPerMonth?.total || 50000;
    const growth = Math.pow(1.035, month); 
    return { total: base * growth }; 
}

// ============================================
// 4. INTENSITY MAPPING (The Generic Linker)
// ============================================

function buildIntensityMap() {
    const map = {};
    const gpuToComp = TRANSLATION_INTENSITIES.gpuToComponents;
    const serverToInfra = TRANSLATION_INTENSITIES.serverToInfra;

    // Power Calc (with PUE)
    const kwPerGpu = serverToInfra.kwPerGpu?.value || 1.0;
    const pue = serverToInfra.pue?.value || 1.3;
    const mwPerGpu = (kwPerGpu * pue) / 1000;

    // -- STOCK NODES --
    map['hbm_stacks'] = gpuToComp.hbmStacksPerGpu?.value || 8; 
    map['datacenter_mw'] = mwPerGpu; 
    map['advanced_wafers'] = 0.5; 
    map['abf_substrate'] = 0.02; 
    
    // -- THROUGHPUT NODES --
    map['cowos_capacity'] = gpuToComp.cowosWaferEquivPerGpu?.value || 1; 
    map['hybrid_bonding'] = 0.1; 
    map['server_assembly'] = 1 / (serverToInfra.gpusPerServer?.value || 8); 

    // -- QUEUE NODES --
    map['grid_interconnect'] = mwPerGpu; 

    // Add explicit inputIntensity overrides
    NODES.forEach(node => {
        if (node.inputIntensity && !map[node.id]) {
            map[node.id] = node.inputIntensity;
        }
    });
    
    return map;
}

// ============================================
// 5. MAIN SIMULATION LOOP
// ============================================

export function runSimulation(assumptions, scenarioOverrides = {}) {
  clearGrowthCache();
  const months = GLOBAL_PARAMS.horizonYears * 12;
  const nodeIntensityMap = buildIntensityMap();
  
  const results = {
    months: [],
    nodes: {},
    summary: { shortages: [], gluts: [] },
    warnings: [] 
  };
  
  // Track warnings to avoid spam
  const warnedNodes = new Set();

  const demandAssumptions = deepMerge(assumptions?.demand || DEMAND_ASSUMPTIONS, scenarioOverrides?.demand);

  // --- STATE INITIALIZATION ---
  const nodeState = {};
  NODES.forEach(node => {
    const type = getNodeType(node.id);
    nodeState[node.id] = {
      type: type,
      inventory: (type === 'STOCK') ? (node.startingInventory || 0) : 0,
      backlog: node.startingBacklog || 0,
      installedBase: (node.id === 'gpu_datacenter') ? 1200000 : (node.id === 'gpu_inference' ? 300000 : 0),
      dynamicExpansions: [],
      lastExpansionMonth: -Infinity,
      tightnessHistory: []
    };
    
    results.nodes[node.id] = {
      demand: [], supply: [], capacity: [], inventory: [], backlog: [], 
      shortage: [], glut: [], tightness: [], priceIndex: [], 
      installedBase: [], requiredBase: [], planDeploy: [], consumption: []
    };
  });

  // --- MONTHLY LOOP ---
  for (let month = 0; month < months; month++) {
    results.months.push(month);

    // 1. Core Drivers
    const requiredGpuBase = 2000000 * Math.pow(1.03, month); 
    const requiredDcBase = requiredGpuBase * 0.7; 
    const requiredInfBase = requiredGpuBase * 0.3; 

    // =======================================================
    // STEP 0: THE PLAN
    // =======================================================
    const gpuState = nodeState['gpu_datacenter'];
    const infState = nodeState['gpu_inference'];

    const dcGap = Math.max(0, requiredDcBase - gpuState.installedBase);
    const infGap = Math.max(0, requiredInfBase - infState.installedBase);
    const dcRetirements = gpuState.installedBase / 48;
    const infRetirements = infState.installedBase / 48;

    // Smoothed Paydown
    const backlogPaydown = gpuState.backlog / BACKLOG_PAYDOWN_MONTHS;

    const planDeployDc = (dcGap / CATCHUP_MONTHS) + dcRetirements;
    const planDeployInf = (infGap / CATCHUP_MONTHS) + infRetirements;
    
    // Master Scalar (Includes Paydown)
    const planDeployTotal = planDeployDc + planDeployInf + backlogPaydown;
    
    // Baseline Plan (No Paydown) - used for clean backlog update
    const baselinePlan = planDeployDc + planDeployInf;

    // =======================================================
    // STEP 1: POTENTIALS
    // =======================================================
    const potentials = {}; 

    NODES.forEach(node => {
        if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') return;
        if (node.group === 'A') return;

        const state = nodeState[node.id];
        const capacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
        const yieldRate = calculateNodeYield(node, month);
        const effectiveCapacity = capacity * (node.maxCapacityUtilization || 0.95) * yieldRate;

        if (state.type === 'STOCK') {
            potentials[node.id] = state.inventory + effectiveCapacity;
        } else {
            potentials[node.id] = effectiveCapacity;
        }
    });

    // =======================================================
    // STEP 2: GATING (Generic)
    // =======================================================
    
    // 1. GPU Fab Constraint
    const gpuNode = NODES.find(n => n.id === 'gpu_datacenter');
    const gpuCap = calculateCapacity(gpuNode, month, scenarioOverrides, gpuState.dynamicExpansions);
    const gpuEffCap = gpuCap * 0.95 * calculateNodeYield(gpuNode, month);
    const gpuAvailable = gpuState.inventory + gpuEffCap;
    
    // Capture Pre-Update GPU State for expansion logic
    const preUpdateGpuInventory = gpuState.inventory;

    // 2. Generic Component Constraints
    let maxSupported = Infinity;
    let constraintCount = 0; 
    
    Object.entries(nodeIntensityMap).forEach(([nodeId, intensity]) => {
        const potential = potentials[nodeId];
        if (potential !== undefined && intensity > 0) {
            const supported = potential / intensity;
            if (supported < maxSupported) {
                maxSupported = supported; 
            }
            constraintCount++;
        }
    });

    // SAFETY: Loud Warning if no constraints found
    if (constraintCount === 0) {
        if (month < 12) results.warnings.push(`Warning (Month ${month}): No active component constraints found. Check Intensity Map.`);
        maxSupported = Infinity; 
    }

    // 3. Final Gating
    const demandCeiling = planDeployTotal; 
    const actualDeployTotal = Math.min(demandCeiling, gpuAvailable, maxSupported);

    // =======================================================
    // STEP 3: CONSUMPTION & UPDATES
    // =======================================================
    
    // A. GPU State Update
    const gpuBufferTarget = planDeployTotal * DEFAULT_BUFFER_MONTHS;
    const gpuProdTarget = actualDeployTotal + Math.max(0, gpuBufferTarget - gpuState.inventory);
    const gpuProduced = Math.min(gpuEffCap, gpuProdTarget);
    
    const oldGpuBacklog = gpuState.backlog;
    
    gpuState.inventory = (gpuState.inventory + gpuProduced) - actualDeployTotal;
    
    // SAFETY: Inventory Clamp
    if (gpuState.inventory < -1e-6) {
        if (!warnedNodes.has('gpu_datacenter')) {
             results.warnings.push(`Clamp: Negative GPU Inventory detected at month ${month}`);
             warnedNodes.add('gpu_datacenter');
        }
        gpuState.inventory = 0;
    }

    // LOGIC FIX: Clean Backlog Math
    // NewBacklog = OldBacklog + NewDemand(Baseline) - Actual
    gpuState.backlog = Math.max(0, oldGpuBacklog + baselinePlan - actualDeployTotal);
    
    // Installed Base Update
    const totalReqBase = requiredDcBase + requiredInfBase;
    const shareDc = totalReqBase > 0 ? (requiredDcBase / totalReqBase) : 0.7;
    const actualDc = actualDeployTotal * shareDc;
    const actualInf = actualDeployTotal * (1 - shareDc);

    gpuState.installedBase = Math.max(0, gpuState.installedBase + actualDc - dcRetirements);
    infState.installedBase = Math.max(0, infState.installedBase + actualInf - infRetirements);

    // --- SAFETY: GPU FAB EXPANSION LOGIC ---
    // LOGIC FIX: Trigger off Flow (Plan), not Stock (Backlog)
    // We want to expand if the PLAN exceeds Capacity consistently
    const gpuTotalLoad = planDeployTotal; 
    const gpuPotential = preUpdateGpuInventory + gpuEffCap;
    const gpuTightness = gpuTotalLoad / Math.max(gpuPotential, EPSILON);
    
    gpuState.tightnessHistory.push(gpuTightness);
    
    if (sma(gpuState.tightnessHistory, 6) > 1.05 && (month - gpuState.lastExpansionMonth > 24)) {
        const expansionAmount = gpuCap * 0.20; 
        const leadTime = gpuNode.leadTimeDebottleneck || 24; 
        gpuState.dynamicExpansions.push({
            month: month + leadTime,
            capacityAdd: expansionAmount
        });
        gpuState.lastExpansionMonth = month;
    }

    // Save GPU Results
    [gpuState, infState].forEach((state, idx) => {
        const isDc = idx === 0;
        const res = results.nodes[isDc ? 'gpu_datacenter' : 'gpu_inference'];
        const share = isDc ? shareDc : (1-shareDc);
        
        res.demand.push(planDeployTotal * share); 
        res.supply.push(isDc ? actualDc : actualInf); 
        res.capacity.push(isDc ? gpuEffCap : 0);
        res.inventory.push(isDc ? gpuState.inventory : 0);
        res.backlog.push(gpuState.backlog * share);
        res.installedBase.push(state.installedBase);
        res.consumption.push(actualDeployTotal * share);
        res.shortage.push(gpuState.backlog > 0 ? 1 : 0);
    });

    // B. Component Updates
    NODES.forEach(node => {
        if (node.id === 'gpu_datacenter' || node.id === 'gpu_inference') return;
        if (node.group === 'A') return;

        const state = nodeState[node.id];
        const nodeRes = results.nodes[node.id];
        
        const intensity = nodeIntensityMap[node.id] || 0;
        const demand = planDeployTotal * intensity; 
        const consumption = actualDeployTotal * intensity;

        const capacity = calculateCapacity(node, month, scenarioOverrides, state.dynamicExpansions);
        const yieldRate = calculateNodeYield(node, month);
        const effectiveCapacity = capacity * (node.maxCapacityUtilization || 0.95) * yieldRate;

        // PRE-UPDATE SNAPSHOTS
        const inventoryIn = state.inventory; 
        const backlogIn = state.backlog;
        let delivered = 0;

        if (state.type === 'STOCK') {
            const bufferTarget = consumption * DEFAULT_BUFFER_MONTHS;
            const prodNeed = consumption + Math.max(0, bufferTarget - state.inventory);
            const production = Math.min(effectiveCapacity, prodNeed);
            
            const available = state.inventory + production;
            delivered = consumption; 
            
            state.inventory = available - delivered;
            state.backlog = 0; 
            
            // SAFETY: Inventory Clamp
            if (state.inventory < -1e-6) {
                if (!warnedNodes.has(node.id)) {
                    results.warnings.push(`Clamp: Negative Inventory in ${node.id} (Month ${month})`);
                    warnedNodes.add(node.id);
                }
                state.inventory = 0;
            }
            
        } else {
            delivered = consumption;
            state.backlog = Math.max(0, state.backlog + demand - delivered);
            state.inventory = 0;
        }

        // C. Expansion Logic
        const totalLoad = demand + backlogIn;
        const potentialSupply = (state.type === 'STOCK') ? (inventoryIn + effectiveCapacity) : effectiveCapacity;
        
        const tightness = totalLoad / Math.max(potentialSupply, EPSILON);
        state.tightnessHistory.push(tightness);
        
        if (sma(state.tightnessHistory, 6) > 1.10 && (month - state.lastExpansionMonth > 12)) {
            const expansionAmount = capacity * 0.20; 
            const leadTime = node.leadTimeDebottleneck || 12;
            state.dynamicExpansions.push({
                month: month + leadTime,
                capacityAdd: expansionAmount
            });
            state.lastExpansionMonth = month;
        }

        // D. Store Results
        nodeRes.demand.push(demand);
        nodeRes.supply.push(delivered);
        nodeRes.capacity.push(effectiveCapacity);
        nodeRes.inventory.push(state.inventory);
        nodeRes.backlog.push(state.backlog);
        nodeRes.tightness.push(tightness);
        
        const isShort = (state.type === 'STOCK') ? (tightness > 1.05) : (state.backlog > 0);
        nodeRes.shortage.push(isShort ? 1 : 0);
    });

  } // End Month Loop

  results.summary = analyzeResults(results);
  return results;
}

// ============================================
// ANALYSIS & FORMATTING
// ============================================
function analyzeResults(results) {
  const shortages = [];
  const shortagePersistence = 3;

  Object.entries(results.nodes).forEach(([nodeId, data]) => {
    const node = getNode(nodeId);
    if (!node || node.group === 'A') return;

    let shortageStart = null, peakTightness = 0, shortageDuration = 0, consecShort = 0;
    data.tightness.forEach((t, month) => {
      if (t > 1.05) {
        consecShort++;
        if (consecShort >= shortagePersistence) {
          if (shortageStart === null) shortageStart = month - shortagePersistence + 1;
          if (t > peakTightness) peakTightness = t;
          shortageDuration++;
        }
      } else {
        if (shortageStart !== null) shortages.push({ nodeId, nodeName: node.name, group: node.group, startMonth: shortageStart, peakTightness, duration: shortageDuration, severity: peakTightness * shortageDuration });
        shortageStart = null; peakTightness = 0; shortageDuration = 0; consecShort = 0;
      }
    });
    if (shortageStart !== null) shortages.push({ nodeId, nodeName: node.name, group: node.group, startMonth: shortageStart, peakTightness, duration: shortageDuration, severity: peakTightness * shortageDuration });
  });

  return { shortages: shortages.slice(0, 20), gluts: [], bottlenecks: [] };
}

export function formatMonth(monthIndex) {
  const year = GLOBAL_PARAMS.startYear + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[month - 1]} ${year}`;
}

export function formatNumber(num, decimals = 1) {
  if (num === null || num === undefined) return '-';
  if (Math.abs(num) >= 1e12) return (num / 1e12).toFixed(decimals) + 'T';
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(decimals) + 'B';
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(decimals) + 'M';
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(decimals) + 'K';
  return num.toFixed(decimals);
}
