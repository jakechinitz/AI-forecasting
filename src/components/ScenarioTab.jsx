import React, { useMemo } from 'react';
import { runSimulation } from '../engine/calculations.js';
import { GLOBAL_PARAMS } from '../data/assumptions.js';

const Y5 = GLOBAL_PARAMS.startYear + 4;
const Y10 = GLOBAL_PARAMS.startYear + 9;
const Y_END = GLOBAL_PARAMS.startYear + GLOBAL_PARAMS.horizonYears - 1;

const gw = (v) => (Number.isFinite(v) ? `${v.toFixed(0)} GW` : '-');
const usdT = (v) => (Number.isFinite(v) ? `$${(v / 1000).toFixed(1)}T` : '-');
const yearSpan = (b) => (b.firstYear === b.lastYear ? `${b.firstYear}` : `${b.firstYear}–${b.lastYear}`);

// Which assumption groups a scenario changes, read from its overrides
function adjustmentList(overrides = {}) {
  const out = [];
  if (overrides.demand || overrides.scaling?.tokenGrowth || overrides.scaling?.trainingGrowth) out.push('Demand');
  if (overrides.efficiency || overrides.scaling?.softwareEfficiency || overrides.scaling?.hardwareEfficiency) out.push('Efficiency');
  if (overrides.supply || overrides.supplyAssumptions) out.push('Supply shock');
  if (overrides.financing) out.push('Financing');
  if (overrides.calibration || overrides.startingState) out.push('Opening shortage');
  if (overrides.build?.pipeline || overrides.build?.procurement) out.push('Construction pipeline');
  if (overrides.build?.demandResponse) out.push('Demand response');
  if (overrides.costs) out.push('Unit costs');
  return out;
}

// Headline metrics for one simulation result
function summarize(results) {
  const annual = results?.annual || [];
  const at = (year) => annual.find((r) => r.year === year) || {};
  const capexTo = (year) => annual.filter((r) => r.year <= year).reduce((s, r) => s + (r.totalCapex || 0), 0);
  const binding = results?.summary?.binding || [];
  return {
    installedY5: at(Y5).installedGW,
    requiredY5: at(Y5).requiredGW,
    installedY10: at(Y10).installedGW,
    installedEnd: at(Y_END).installedGW,
    powerY5: at(Y5).totalAiPowerGW,
    capexY5: capexTo(Y5),
    binding,
    selfFundingYear: results?.financing?.selfFundingYear?.system ?? null,
    gpuTightnessAvg: (results?.nodes?.gpu_datacenter?.tightness || []).slice(0, 60).reduce((a, b) => a + (b || 0), 0) / 60
  };
}

function ScenarioTab({ scenarios, selectedScenario, onSelectScenario, results, assumptions }) {
  const scenarioList = Object.values(scenarios);

  const current = useMemo(() => (results ? summarize(results) : null), [results]);

  // Run every scenario on the current assumptions (~50 ms each) so the
  // comparison table always reflects the model, not hand-written text.
  const comparison = useMemo(() => {
    if (!assumptions) return {};
    const out = {};
    for (const s of scenarioList) {
      try {
        out[s.id] = s.id === selectedScenario && results
          ? summarize(results)
          : summarize(runSimulation(assumptions, s.overrides || {}));
      } catch (e) {
        out[s.id] = null;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assumptions, results]);

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Scenario Comparison</h1>
          <p className="tab-description">
            Demand and efficiency scenarios scale the current assumptions; supply, financing and
            opening-shortage scenarios change one lever. Select a scenario to run every tab on it.
          </p>
        </div>
      </div>

      {/* Scenario Selection */}
      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Select Scenario</h2>
        </div>

        <div className="grid grid-3" style={{ gap: 'var(--space-md)' }}>
          {scenarioList.map(scenario => {
            const adjustments = adjustmentList(scenario.overrides);
            return (
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
                {adjustments.length > 0 && (
                  <div style={{ marginTop: 'var(--space-sm)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    <strong>Adjusts:</strong> {adjustments.join(', ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Current Scenario Results */}
      {current && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Scenario Results: {scenarios[selectedScenario]?.name}</h2>
          </div>

          <div className="grid grid-4" style={{ gap: 'var(--space-md)', marginBottom: 'var(--space-lg)' }}>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{gw(current.installedY5)}</span>
                <span className="metric-label">Installed IT, end-{Y5}</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{gw(current.requiredY5)}</span>
                <span className="metric-label">Required IT, {Y5} avg</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{gw(current.powerY5)}</span>
                <span className="metric-label">AI power draw {Y5} (DC + edge)</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{usdT(current.capexY5)}</span>
                <span className="metric-label">Cumulative capex to {Y5}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-3" style={{ gap: 'var(--space-md)' }}>
            <div className="card">
              <h4 style={{ marginBottom: 'var(--space-sm)' }}>What Binds</h4>
              <div style={{ fontSize: '0.875rem' }}>
                {current.binding.map((b) => (
                  <div key={b.constraint} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-sm)', marginBottom: '6px' }}>
                    <span>{b.constraint.replace(/^Components: /, '')}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{b.months} mo · {yearSpan(b)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h4 style={{ marginBottom: 'var(--space-sm)' }}>Market Pressure</h4>
              <div style={{ fontSize: '0.875rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span>Avg accelerator tightness (5Y):</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{current.gpuTightnessAvg.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span>Shortage events:</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{results.summary.shortages.length}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Glut events:</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{results.summary.gluts.length}</span>
                </div>
              </div>
            </div>

            <div className="card">
              <h4 style={{ marginBottom: 'var(--space-sm)' }}>Scenario Characteristics</h4>
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                {scenarios[selectedScenario]?.description}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Scenario Comparison Table (computed) */}
      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">Scenario Comparison</h3>
        </div>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Demand</th>
                <th>Efficiency</th>
                <th>Supply / capital</th>
                <th>Installed {Y5}</th>
                <th>Installed {Y10}</th>
                <th>Installed {Y_END}</th>
                <th>Capex to {Y5}</th>
                <th>What binds</th>
              </tr>
            </thead>
            <tbody>
              {scenarioList.map((s) => {
                const c = comparison[s.id];
                return (
                  <tr key={s.id} className={selectedScenario === s.id ? 'selected' : ''} onClick={() => onSelectScenario(s.id)} style={{ cursor: 'pointer' }}>
                    <td className="text-cell"><strong>{s.name}</strong></td>
                    <td className="text-cell">{s.summary?.demand || '-'}</td>
                    <td className="text-cell">{s.summary?.efficiency || '-'}</td>
                    <td className="text-cell">{s.summary?.supply || '-'}</td>
                    <td>{gw(c?.installedY5)}</td>
                    <td>{gw(c?.installedY10)}</td>
                    <td>{gw(c?.installedEnd)}</td>
                    <td>{usdT(c?.capexY5)}</td>
                    <td className="text-cell">
                      {c ? c.binding.slice(0, 2).map((b) => `${b.constraint.replace(/^Components: /, '')} (${yearSpan(b)})`).join('; ') : 'Run failed'}
                    </td>
                  </tr>
                );
              })}
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
              Click any scenario card or table row to switch. Every tab re-runs on the selected
              scenario. The comparison table re-runs all scenarios on your current assumptions.
            </p>
          </div>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Custom Scenarios</h4>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
              Edit individual parameters on the Assumptions and Funding tabs. Scenarios are applied
              on top of those edits: scaling scenarios multiply your values, and the others override
              only the lever they name.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ScenarioTab;
