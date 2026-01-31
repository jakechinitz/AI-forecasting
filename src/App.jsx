import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { NODES, NODE_GROUPS, getNode } from './data/nodes.js';
import {
  GLOBAL_PARAMS,
  DEMAND_ASSUMPTIONS,
  EFFICIENCY_ASSUMPTIONS,
  SUPPLY_ASSUMPTIONS,
  SCENARIOS
} from './data/assumptions.js';
import { runSimulation, formatMonth, formatNumber } from './engine/calculations.js';

// Import components
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import AssumptionsTab from './components/AssumptionsTab.jsx';
import NodeLibraryTab from './components/NodeLibraryTab.jsx';
import DemandEngineTab from './components/DemandEngineTab.jsx';
import SupplyEngineTab from './components/SupplyEngineTab.jsx';
import MarketClearingTab from './components/MarketClearingTab.jsx';
import AnalysisTab from './components/AnalysisTab.jsx';
import ChartsTab from './components/ChartsTab.jsx';
import ScenarioTab from './components/ScenarioTab.jsx';
import GrowthRatesTab from './components/GrowthRatesTab.jsx';
import PrintoutTab from './components/PrintoutTab.jsx';

import './styles/app.css';

const TABS = [
  { id: 'assumptions', label: 'Assumptions', icon: '\u2699', description: 'Inputs & efficiencies' },
  { id: 'nodes', label: 'Node Library', icon: '\u25CE', description: 'Supply chain map' },
  { id: 'demand', label: 'Demand Drivers', icon: '\u2197', description: 'Workload demand' },
  { id: 'supply', label: 'Supply Buildout', icon: '\u25A3', description: 'Capacity growth' },
  { id: 'market', label: 'Market Clearing', icon: '\u2696', description: 'Tightness & pricing' },
  { id: 'analysis', label: 'Market Stress', icon: '\u26A0', description: 'Shortages & gluts' },
  { id: 'growth', label: 'YoY Growth', icon: '\u2191', description: 'Demand vs supply' },
  { id: 'charts', label: 'Node Trends', icon: '\u2500', description: 'Detailed charts' },
  { id: 'scenarios', label: 'Scenarios', icon: '\u2630', description: 'Compare cases' },
  { id: 'printout', label: 'Printout', icon: '\u2193', description: 'Snapshot summary' }
];

function App() {
  // State
  const [activeTab, setActiveTab] = useState('assumptions');
  const [selectedScenario, setSelectedScenario] = useState('base');
  const [selectedNode, setSelectedNode] = useState('gpu_datacenter');
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationResults, setSimulationResults] = useState(null);

  // Custom assumptions (start with defaults)
  const [customAssumptions, setCustomAssumptions] = useState({
    demand: JSON.parse(JSON.stringify(DEMAND_ASSUMPTIONS)),
    efficiency: JSON.parse(JSON.stringify(EFFICIENCY_ASSUMPTIONS)),
    supply: JSON.parse(JSON.stringify(SUPPLY_ASSUMPTIONS))
  });

  // Run simulation when assumptions or scenario change
  const runSim = useCallback(() => {
    setIsSimulating(true);

    // Small delay to allow UI to update
    setTimeout(() => {
      try {
        const scenarioOverrides = SCENARIOS[selectedScenario]?.overrides || {};
        const results = runSimulation(customAssumptions, scenarioOverrides);
        setSimulationResults(results);
      } catch (error) {
        console.error('Simulation error:', error);
      } finally {
        setIsSimulating(false);
      }
    }, 50);
  }, [customAssumptions, selectedScenario]);

  // Initial simulation run
  useEffect(() => {
    runSim();
  }, []);

  // Re-run simulation when scenario changes
  useEffect(() => {
    runSim();
  }, [selectedScenario]);

  // Handle assumption changes
  const handleAssumptionChange = useCallback((category, blockKey, path, value) => {
    setCustomAssumptions(prev => {
      const updated = JSON.parse(JSON.stringify(prev));

      // Navigate to the correct nested location and update
      let current = updated[category][blockKey];
      for (let i = 0; i < path.length - 1; i++) {
        current = current[path[i]];
      }
      const lastKey = path[path.length - 1];

      if (typeof current[lastKey] === 'object' && current[lastKey].value !== undefined) {
        current[lastKey].value = value;
      } else {
        current[lastKey] = value;
      }

      return updated;
    });
  }, []);

  // Render active tab content
  const renderTabContent = () => {
    if (!simulationResults) {
      return (
        <div className="loading-state">
          <div className="spinner" />
          <p>Running initial simulation...</p>
        </div>
      );
    }

    switch (activeTab) {
      case 'assumptions':
        return (
          <AssumptionsTab
            assumptions={customAssumptions}
            onAssumptionChange={handleAssumptionChange}
            onRunSimulation={runSim}
            isSimulating={isSimulating}
          />
        );

      case 'nodes':
        return (
          <NodeLibraryTab
            nodes={NODES}
            groups={NODE_GROUPS}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
          />
        );

      case 'demand':
        return (
          <DemandEngineTab
            results={simulationResults}
            assumptions={customAssumptions}
          />
        );

      case 'supply':
        return (
          <SupplyEngineTab
            results={simulationResults}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
          />
        );

      case 'market':
        return (
          <MarketClearingTab
            results={simulationResults}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
          />
        );

      case 'analysis':
        return (
          <AnalysisTab
            results={simulationResults}
            onSelectNode={(nodeId) => {
              setSelectedNode(nodeId);
              setActiveTab('charts');
            }}
          />
        );

      case 'charts':
        return (
          <ChartsTab
            results={simulationResults}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            scenario={selectedScenario}
          />
        );

      case 'growth':
        return (
          <GrowthRatesTab
            results={simulationResults}
            onSelectNode={(nodeId) => {
              setSelectedNode(nodeId);
              setActiveTab('charts');
            }}
          />
        );

      case 'scenarios':
        return (
          <ScenarioTab
            scenarios={SCENARIOS}
            selectedScenario={selectedScenario}
            onSelectScenario={setSelectedScenario}
            results={simulationResults}
          />
        );
      case 'printout':
        return (
          <PrintoutTab
            results={simulationResults}
            scenario={SCENARIOS[selectedScenario]}
          />
        );

      default:
        return <div>Select a tab</div>;
    }
  };

  // Summary stats for header
  const summaryStats = useMemo(() => {
    if (!simulationResults) return null;

    const shortages = simulationResults.summary.shortages.length;
    const gluts = simulationResults.summary.gluts.length;
    const topBottleneck = simulationResults.summary.bottlenecks[0];

    // Get current month data (month 12 = 1 year out)
    const currentMonth = 12;
    const gpuData = simulationResults.nodes.gpu_datacenter;
    const hbmData = simulationResults.nodes.hbm_stacks;
    const cowosData = simulationResults.nodes.cowos_capacity;

    return {
      shortages,
      gluts,
      topBottleneck: topBottleneck?.nodeName || 'None',
      gpuTightness: gpuData?.tightness[currentMonth]?.toFixed(2) || '-',
      hbmTightness: hbmData?.tightness[currentMonth]?.toFixed(2) || '-',
      cowosTightness: cowosData?.tightness[currentMonth]?.toFixed(2) || '-'
    };
  }, [simulationResults]);

  return (
    <div className="app">
      <Header
        stats={summaryStats}
        scenario={SCENARIOS[selectedScenario]}
        isSimulating={isSimulating}
      />

      <div className="app-layout">
        <Sidebar
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />

        <main className="main-content">
          {isSimulating && (
            <div className="simulation-overlay">
              <div className="spinner" />
              <span>Simulating...</span>
            </div>
          )}

          <div className="tab-content fade-in">
            {renderTabContent()}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
