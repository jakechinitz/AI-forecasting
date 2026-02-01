import React, { useMemo } from 'react';
import { NODE_GROUPS } from '../data/nodes.js';
import { formatMonth } from '../engine/calculations.js';

function AnalysisTab({ results, onSelectNode }) {
  const { shortages, gluts, bottlenecks } = results?.summary || { shortages: [], gluts: [], bottlenecks: [] };

  // Build group color lookup (NODE_GROUPS is an array, item.group is a letter like 'A')
  const groupColor = useMemo(() => {
    const map = {};
    NODE_GROUPS.forEach(g => { map[g.id] = g.color; });
    return map;
  }, []);

  const getTightnessColor = (value) => {
    if (value > 1.2) return 'var(--status-tight)';
    if (value > 1.05) return 'var(--status-stressed)';
    if (value > 0.95) return 'var(--status-balanced)';
    if (value > 0.8) return 'var(--status-soft)';
    return 'var(--status-glut)';
  };

  const getSeverityBadge = (value, type) => {
    const thresholds = type === 'shortage'
      ? { high: 25, medium: 12 }
      : { high: 8, medium: 4 };
    if (value >= thresholds.high) {
      return { label: 'Material', color: 'var(--status-tight)' };
    }
    if (value >= thresholds.medium) {
      return { label: 'Meaningful', color: 'var(--status-stressed)' };
    }
    return { label: 'Minor', color: 'var(--text-muted)' };
  };

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Market Stress Overview</h1>
          <p className="tab-description">
            Highlights material shortages and gluts with severity scoring and timelines.
            Click any item to view detailed node charts.
          </p>
        </div>
      </div>

      <div className="grid grid-3" style={{ gap: 'var(--space-lg)' }}>
        {/* Top Bottlenecks */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Top Systemic Bottlenecks</h3>
            <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
              Ranked by downstream impact
            </span>
          </div>

          {bottlenecks.length === 0 ? (
            <div className="empty-state" style={{ padding: 'var(--space-lg)' }}>
              <div style={{ fontSize: '2rem', opacity: 0.5 }}>✓</div>
              <p>No critical bottlenecks detected</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              {bottlenecks.slice(0, 10).map((item, index) => (
                <div
                  key={item.nodeId}
                  className="analysis-card"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onSelectNode(item.nodeId)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div className="analysis-card-rank">#{index + 1}</div>
                      <div className="analysis-card-title">
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: groupColor[item.group],
                            marginRight: '6px'
                          }}
                        />
                        {item.nodeName}
                      </div>
                    </div>
                    <div style={{
                      fontSize: '1.25rem',
                      fontWeight: 700,
                      fontFamily: 'var(--font-mono)',
                      color: getTightnessColor(item.maxTightness)
                    }}>
                      {item.maxTightness.toFixed(2)}
                    </div>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Avg Tightness</span>
                    <span className="analysis-card-metric-value">{item.avgTightness.toFixed(2)}</span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Shortage Months</span>
                    <span className="analysis-card-metric-value">{item.shortageMonths}</span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Downstream Impact</span>
                    <span className="analysis-card-metric-value">{item.downstreamImpact.toFixed(1)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Shortage Events */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Material Shortages</h3>
            <span style={{ fontSize: '0.6875rem', color: 'var(--status-tight)' }}>
              Severity = peak tightness × duration
            </span>
          </div>

          {shortages.length === 0 ? (
            <div className="empty-state" style={{ padding: 'var(--space-lg)' }}>
              <div style={{ fontSize: '2rem', opacity: 0.5 }}>✓</div>
              <p>No shortages detected</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              {shortages.slice(0, 10).map((item, index) => {
                const badge = getSeverityBadge(item.severity, 'shortage');
                return (
                <div
                  key={`${item.nodeId}-${item.startMonth}`}
                  className="analysis-card"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onSelectNode(item.nodeId)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div className="analysis-card-rank">#{index + 1}</div>
                      <div className="analysis-card-title">
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: groupColor[item.group],
                            marginRight: '6px'
                          }}
                        />
                        {item.nodeName}
                      </div>
                    </div>
                    <span className="badge" style={{ background: badge.color, color: 'white' }}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Onset</span>
                    <span className="analysis-card-metric-value">{formatMonth(item.startMonth)}</span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Peak Tightness</span>
                    <span className="analysis-card-metric-value" style={{ color: 'var(--status-tight)' }}>
                      {item.peakTightness.toFixed(2)}
                    </span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Duration</span>
                    <span className="analysis-card-metric-value">{item.duration} months</span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Severity</span>
                    <span className="analysis-card-metric-value">{item.severity.toFixed(1)}</span>
                  </div>
                </div>
              );})}
            </div>
          )}
        </div>

        {/* Glut Events */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Material Gluts</h3>
            <span style={{ fontSize: '0.6875rem', color: 'var(--status-glut)' }}>
              Severity = (1 - min tightness) × duration
            </span>
          </div>

          {gluts.length === 0 ? (
            <div className="empty-state" style={{ padding: 'var(--space-lg)' }}>
              <div style={{ fontSize: '2rem', opacity: 0.5 }}>📈</div>
              <p>No gluts detected (demand stays strong)</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              {gluts.slice(0, 10).map((item, index) => {
                const badge = getSeverityBadge(item.severity, 'glut');
                return (
                <div
                  key={`${item.nodeId}-${item.startMonth}`}
                  className="analysis-card"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onSelectNode(item.nodeId)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div className="analysis-card-rank">#{index + 1}</div>
                      <div className="analysis-card-title">
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: groupColor[item.group],
                            marginRight: '6px'
                          }}
                        />
                        {item.nodeName}
                      </div>
                    </div>
                    <span className="badge" style={{ background: badge.color, color: 'white' }}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Onset</span>
                    <span className="analysis-card-metric-value">{formatMonth(item.startMonth)}</span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Min Tightness</span>
                    <span className="analysis-card-metric-value" style={{ color: 'var(--status-glut)' }}>
                      {item.minTightness.toFixed(2)}
                    </span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Duration</span>
                    <span className="analysis-card-metric-value">{item.duration} months</span>
                  </div>
                  <div className="analysis-card-metric">
                    <span className="analysis-card-metric-label">Severity</span>
                    <span className="analysis-card-metric-value">{item.severity.toFixed(1)}</span>
                  </div>
                </div>
              );})}
            </div>
          )}
        </div>
      </div>

      {/* Analysis Summary */}
      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">Analysis Summary</h3>
        </div>
        <div className="grid grid-3" style={{ gap: 'var(--space-lg)' }}>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Key Findings</h4>
            <ul style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', paddingLeft: 'var(--space-md)' }}>
              <li style={{ marginBottom: '4px' }}>
                {bottlenecks.length > 0
                  ? `Primary bottleneck: ${bottlenecks[0].nodeName}`
                  : 'No critical bottlenecks identified'}
              </li>
              <li style={{ marginBottom: '4px' }}>
                {shortages.length} shortage events detected across simulation
              </li>
              <li>
                {gluts.length > 0
                  ? `${gluts.length} glut windows flagged by the severity model`
                  : 'Demand remains strong, no glut risk'}
              </li>
            </ul>
          </div>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Critical Nodes</h4>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
              Monitor HBM, CoWoS, and transformer capacity most closely.
              These have the lowest elasticity and longest lead times.
            </p>
          </div>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Methodology</h4>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
              Bottleneck score = avg_tightness × shortage_months × (1 + downstream_impact/10).
              Severity = peak/min × duration.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AnalysisTab;
