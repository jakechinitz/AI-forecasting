import React, { useMemo } from 'react';
import { NODE_GROUPS, getNode } from '../data/nodes.js';
import { formatNumber } from '../engine/calculations.js';

function ScenarioTab({ scenarios, selectedScenario, onSelectScenario, results }) {
  const scenarioList = Object.values(scenarios);

  // Get key metrics for current scenario
  const metrics = useMemo(() => {
    if (!results) return null;

    const gpuData = results.nodes.gpu_datacenter;
    const hbmData = results.nodes.hbm_stacks;
    const cowosData = results.nodes.cowos_capacity;
    const dcData = results.nodes.datacenter_mw;

    const y1 = 12;  // Year 1
    const y5 = 60;  // Year 5

    return {
      gpuDemandY1: gpuData?.demand[y1] || 0,
      gpuDemandY5: gpuData?.demand[y5] || 0,
      gpuTightnessAvg: gpuData?.tightness.slice(0, 60).reduce((a, b) => a + b, 0) / 60 || 0,
      hbmTightnessMax: Math.max(...(hbmData?.tightness.slice(0, 60) || [1])),
      cowosTightnessMax: Math.max(...(cowosData?.tightness.slice(0, 60) || [1])),
      dcMwY5: dcData?.demand[y5] || 0,
      shortageCount: results.summary.shortages.length,
      glutCount: results.summary.gluts.length,
      topBottleneck: results.summary.bottlenecks[0]?.nodeName || 'None'
    };
  }, [results]);

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Scenario Comparison</h1>
          <p className="tab-description">
            Compare different demand, efficiency, and supply scenarios. Select a scenario to
            run the simulation with adjusted assumptions.
          </p>
        </div>
      </div>

      {/* Scenario Selection */}
      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Select Scenario</h2>
        </div>

        <div className="grid grid-3" style={{ gap: 'var(--space-md)' }}>
          {scenarioList.map(scenario => (
            <div
              key={scenario.id}
              className={`scenario-card ${selectedScenario === scenario.id ? 'selected' : ''}`}
              onClick={() => onSelectScenario(scenario.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div className="scenario-card-name">{scenario.name}</div>
                {selectedScenario === scenario.id && (
                  <span className="badge badge-balanced">Active</span>
                )}
              </div>
              <p className="scenario-card-description">{scenario.description}</p>

              {/* Show overrides summary */}
              {scenario.overrides && Object.keys(scenario.overrides).length > 0 && (
                <div style={{ marginTop: 'var(--space-sm)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <strong>Adjustments:</strong>
                  {scenario.overrides.demand && ' Demand'}
                  {scenario.overrides.efficiency && ' Efficiency'}
                  {scenario.overrides.supply && ' Supply'}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Current Scenario Results */}
      {metrics && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Scenario Results: {scenarios[selectedScenario]?.name}</h2>
          </div>

          <div className="grid grid-4" style={{ gap: 'var(--space-md)', marginBottom: 'var(--space-lg)' }}>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{formatNumber(metrics.gpuDemandY1)}</span>
                <span className="metric-label">GPU Demand Y1</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{formatNumber(metrics.gpuDemandY5)}</span>
                <span className="metric-label">GPU Demand Y5</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span
                  className="metric-value"
                  style={{
                    color: metrics.gpuTightnessAvg > 1.1 ? 'var(--status-tight)' :
                           metrics.gpuTightnessAvg > 1 ? 'var(--status-stressed)' :
                           'var(--status-balanced)'
                  }}
                >
                  {metrics.gpuTightnessAvg.toFixed(2)}
                </span>
                <span className="metric-label">Avg GPU Tightness (5Y)</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{formatNumber(metrics.dcMwY5)}</span>
                <span className="metric-label">DC Power Y5 (MW)</span>
              </div>
            </div>
          </div>

          <div className="grid grid-3" style={{ gap: 'var(--space-md)' }}>
            <div className="card">
              <h4 style={{ marginBottom: 'var(--space-sm)' }}>Peak Constraints</h4>
              <div style={{ fontSize: '0.875rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span>Max HBM Tightness:</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    color: metrics.hbmTightnessMax > 1.1 ? 'var(--status-tight)' : 'var(--text-primary)'
                  }}>
                    {metrics.hbmTightnessMax.toFixed(2)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span>Max CoWoS Tightness:</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    color: metrics.cowosTightnessMax > 1.1 ? 'var(--status-tight)' : 'var(--text-primary)'
                  }}>
                    {metrics.cowosTightnessMax.toFixed(2)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Primary Bottleneck:</span>
                  <span style={{ fontWeight: 600 }}>{metrics.topBottleneck}</span>
                </div>
              </div>
            </div>

            <div className="card">
              <h4 style={{ marginBottom: 'var(--space-sm)' }}>Event Summary</h4>
              <div style={{ fontSize: '0.875rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span>Shortage Events:</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    color: metrics.shortageCount > 5 ? 'var(--status-tight)' : 'var(--text-primary)'
                  }}>
                    {metrics.shortageCount}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Glut Events:</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    color: metrics.glutCount > 3 ? 'var(--status-glut)' : 'var(--text-primary)'
                  }}>
                    {metrics.glutCount}
                  </span>
                </div>
              </div>
            </div>

            <div className="card">
              <h4 style={{ marginBottom: 'var(--space-sm)' }}>Scenario Characteristics</h4>
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                {selectedScenario === 'base' && 'Balanced assumptions with moderate growth and efficiency gains.'}
                {selectedScenario === 'highDemandSlowEfficiency' && 'Aggressive adoption with disappointing efficiency improvements creates persistent shortages.'}
                {selectedScenario === 'highDemandFastEfficiency' && 'Strong demand offset by rapid efficiency gains leads to balanced markets.'}
                {selectedScenario === 'demandSlowdown' && 'Weaker-than-expected adoption may lead to overcapacity and gluts.'}
                {selectedScenario === 'geopoliticalShock' && 'Regional supply disruption causes severe temporary constraints.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Scenario Comparison Table */}
      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">Scenario Comparison</h3>
        </div>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Demand Growth</th>
                <th>Efficiency</th>
                <th>Supply Risk</th>
                <th>Expected Outcome</th>
              </tr>
            </thead>
            <tbody>
              <tr className={selectedScenario === 'base' ? 'selected' : ''}>
                <td className="text-cell"><strong>Base Case</strong></td>
                <td>Moderate (40-55% CAGR)</td>
                <td>Moderate (25-40% annual)</td>
                <td>Normal</td>
                <td style={{ color: 'var(--status-stressed)' }}>Periodic constraints, mostly balanced</td>
              </tr>
              <tr className={selectedScenario === 'highDemandSlowEfficiency' ? 'selected' : ''}>
                <td className="text-cell"><strong>High Demand / Slow Efficiency</strong></td>
                <td style={{ color: 'var(--status-tight)' }}>High (55-70% CAGR)</td>
                <td style={{ color: 'var(--status-tight)' }}>Low (15-25% annual)</td>
                <td>Normal</td>
                <td style={{ color: 'var(--status-tight)' }}>Persistent shortages</td>
              </tr>
              <tr className={selectedScenario === 'highDemandFastEfficiency' ? 'selected' : ''}>
                <td className="text-cell"><strong>High Demand / Fast Efficiency</strong></td>
                <td style={{ color: 'var(--status-tight)' }}>High (55-70% CAGR)</td>
                <td style={{ color: 'var(--status-balanced)' }}>High (35-55% annual)</td>
                <td>Normal</td>
                <td style={{ color: 'var(--status-balanced)' }}>Balanced, efficiency absorbs demand</td>
              </tr>
              <tr className={selectedScenario === 'demandSlowdown' ? 'selected' : ''}>
                <td className="text-cell"><strong>Demand Slowdown</strong></td>
                <td style={{ color: 'var(--status-soft)' }}>Low (20-30% CAGR)</td>
                <td>Moderate</td>
                <td>Normal</td>
                <td style={{ color: 'var(--status-glut)' }}>Potential gluts, price pressure</td>
              </tr>
              <tr className={selectedScenario === 'geopoliticalShock' ? 'selected' : ''}>
                <td className="text-cell"><strong>Geopolitical Shock</strong></td>
                <td>Moderate</td>
                <td>Moderate</td>
                <td style={{ color: 'var(--status-tight)' }}>50% capacity loss</td>
                <td style={{ color: 'var(--status-tight)' }}>Severe short-term shortages</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* How to Use */}
      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">Using Scenarios</h3>
        </div>
        <div className="grid grid-2" style={{ gap: 'var(--space-lg)' }}>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Scenario Selection</h4>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
              Click on any scenario card above to switch. The simulation will re-run automatically
              with the adjusted assumptions. All tabs will update to reflect the new scenario.
            </p>
          </div>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Custom Scenarios</h4>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
              For custom scenarios, go to the Assumptions tab and adjust individual parameters.
              Click "Run Simulation" to see results. Scenarios override assumptions; custom changes
              take precedence.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ScenarioTab;
