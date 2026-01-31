import React, { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { NODES, NODE_GROUPS, getNode } from '../data/nodes.js';
import { formatMonth, formatNumber } from '../engine/calculations.js';

function SupplyEngineTab({ results, selectedNode, onSelectNode }) {
  const [timeRange, setTimeRange] = useState('all');  // '5y', '10y', 'all'

  // Get selected node data
  const nodeData = useMemo(() => {
    if (!results || !selectedNode) return null;
    return results.nodes[selectedNode];
  }, [results, selectedNode]);

  const node = getNode(selectedNode);

  // Prepare chart data
  const chartData = useMemo(() => {
    if (!nodeData) return [];

    let maxMonth = results.months.length;
    if (timeRange === '5y') maxMonth = 60;
    else if (timeRange === '10y') maxMonth = 120;

    const data = [];
    for (let i = 0; i < Math.min(results.months.length, maxMonth); i += 3) {
      data.push({
        month: results.months[i],
        label: formatMonth(results.months[i]),
        capacity: nodeData.capacity[i],
        supply: nodeData.supply[i],
        yield: nodeData.yield[i] * 100
      });
    }
    return data;
  }, [nodeData, results, timeRange]);

  // Get key supply nodes
  const keyNodes = useMemo(() => {
    return NODES.filter(n =>
      ['gpu_datacenter', 'hbm_stacks', 'cowos_capacity', 'advanced_wafers', 'datacenter_mw', 'transformers_lpt']
        .includes(n.id)
    ).map(n => {
      const data = results?.nodes[n.id];
      const currentCapacity = data?.capacity[12] || 0;
      const futureCapacity = data?.capacity[60] || 0;
      const growthRate = ((futureCapacity / currentCapacity) - 1) * 100;

      return {
        ...n,
        currentCapacity,
        futureCapacity,
        growthRate
      };
    });
  }, [results]);

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div style={{
          background: 'var(--bg-elevated)',
          padding: 'var(--space-sm)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--bg-tertiary)',
          fontSize: '0.75rem'
        }}>
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>{label}</div>
          {payload.map((entry, index) => (
            <div key={index} style={{ color: entry.color, marginBottom: '2px' }}>
              {entry.name}: {entry.name === 'Yield' ? entry.value.toFixed(1) + '%' : formatNumber(entry.value)}
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Supply Buildout</h1>
          <p className="tab-description">
            Models capacity evolution with committed expansions, lead times, and ramp profiles.
            Supply = Capacity × Utilization × Yield. Endogenous expansions trigger on forecasted shortages.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
          <div className="tabs">
            {[
              { id: '5y', label: '5 Years' },
              { id: '10y', label: '10 Years' },
              { id: 'all', label: 'Full Horizon' }
            ].map(range => (
              <button
                key={range.id}
                className={`tab ${timeRange === range.id ? 'active' : ''}`}
                onClick={() => setTimeRange(range.id)}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Key Supply Nodes Overview */}
      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Key Supply Nodes</h2>
          <span className="section-subtitle">Click to view details</span>
        </div>

        <div className="grid grid-3" style={{ gap: 'var(--space-md)' }}>
          {keyNodes.map(n => (
            <div
              key={n.id}
              className={`node-card ${selectedNode === n.id ? 'selected' : ''}`}
              onClick={() => onSelectNode(n.id)}
            >
              <div className="node-card-header">
                <span
                  className="node-group-dot"
                  style={{ background: NODE_GROUPS[n.group]?.color }}
                />
                <span className="node-card-name">{n.name}</span>
              </div>
              <div className="node-card-unit">{n.unit}</div>
              <div className="node-card-stats">
                <div className="node-card-stat">
                  <div className="node-card-stat-value">{formatNumber(n.currentCapacity)}</div>
                  <div className="node-card-stat-label">Y1 Capacity</div>
                </div>
                <div className="node-card-stat">
                  <div className="node-card-stat-value">{formatNumber(n.futureCapacity)}</div>
                  <div className="node-card-stat-label">Y5 Capacity</div>
                </div>
                <div className="node-card-stat">
                  <div
                    className="node-card-stat-value"
                    style={{ color: n.growthRate > 0 ? 'var(--accent-success)' : 'var(--text-muted)' }}
                  >
                    +{n.growthRate.toFixed(0)}%
                  </div>
                  <div className="node-card-stat-label">5Y Growth</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Selected Node Detail */}
      {node && nodeData && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">
              <span
                style={{
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: NODE_GROUPS[node.group]?.color,
                  marginRight: 'var(--space-sm)'
                }}
              />
              {node.name}
            </h2>
            <span className="section-subtitle">{node.unit}</span>
          </div>

          <div className="grid grid-2" style={{ gap: 'var(--space-lg)' }}>
            {/* Capacity vs Supply Chart */}
            <div className="chart-container">
              <div className="chart-header">
                <h3 className="chart-title">Capacity & Supply Over Time</h3>
                <div className="chart-legend">
                  <span className="legend-item">
                    <span className="legend-dot" style={{ background: '#6366f1' }} />
                    Capacity
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot" style={{ background: '#22c55e' }} />
                    Effective Supply
                  </span>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                    interval={7}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                    tickFormatter={(v) => formatNumber(v)}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="capacity"
                    stroke="#6366f1"
                    fill="#6366f1"
                    fillOpacity={0.2}
                    name="Capacity"
                  />
                  <Area
                    type="monotone"
                    dataKey="supply"
                    stroke="#22c55e"
                    fill="#22c55e"
                    fillOpacity={0.3}
                    name="Supply"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Yield Over Time (for stacked yield nodes) */}
            <div className="chart-container">
              <div className="chart-header">
                <h3 className="chart-title">Yield Over Time</h3>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                    interval={7}
                  />
                  <YAxis
                    domain={[50, 100]}
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                    tickFormatter={(v) => v + '%'}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="yield"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={false}
                    name="Yield"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Node Details */}
          <div className="card" style={{ marginTop: 'var(--space-md)' }}>
            <div className="grid grid-4" style={{ gap: 'var(--space-lg)' }}>
              <div>
                <h4 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
                  SUPPLY DYNAMICS
                </h4>
                <div style={{ fontSize: '0.8125rem' }}>
                  <div style={{ marginBottom: '6px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Lead Time (New):</span>{' '}
                    <strong>{node.leadTimeNewBuild || '-'} months</strong>
                  </div>
                  <div style={{ marginBottom: '6px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Lead Time (Debottleneck):</span>{' '}
                    <strong>{node.leadTimeDebottleneck || '-'} months</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Ramp Profile:</span>{' '}
                    <strong>{node.rampProfile || 'linear'}</strong>
                  </div>
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
                  ELASTICITY
                </h4>
                <div style={{ fontSize: '0.8125rem' }}>
                  <div style={{ marginBottom: '6px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Short-term (0-18mo):</span>{' '}
                    <strong style={{ color: 'var(--status-tight)' }}>{node.elasticityShort?.toFixed(2) || '-'}</strong>
                  </div>
                  <div style={{ marginBottom: '6px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Medium (18-48mo):</span>{' '}
                    <strong style={{ color: 'var(--status-stressed)' }}>{node.elasticityMid?.toFixed(2) || '-'}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Long-term (48mo+):</span>{' '}
                    <strong style={{ color: 'var(--status-balanced)' }}>{node.elasticityLong?.toFixed(2) || '-'}</strong>
                  </div>
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
                  YIELD MODEL
                </h4>
                <div style={{ fontSize: '0.8125rem' }}>
                  {node.yieldModel === 'stacked' ? (
                    <>
                      <div style={{ marginBottom: '6px' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Type:</span>{' '}
                        <strong>Stacked (HBM)</strong>
                      </div>
                      <div style={{ marginBottom: '6px' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Initial → Target:</span>{' '}
                        <strong>{((node.yieldInitial || 0.65) * 100).toFixed(0)}% → {((node.yieldTarget || 0.85) * 100).toFixed(0)}%</strong>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-secondary)' }}>Half-life:</span>{' '}
                        <strong>{node.yieldHalflifeMonths || 18} months</strong>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ marginBottom: '6px' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Type:</span>{' '}
                        <strong>Simple</strong>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-secondary)' }}>Loss Rate:</span>{' '}
                        <strong>{((node.yieldSimpleLoss || 0.03) * 100).toFixed(1)}%</strong>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div>
                <h4 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
                  MARKET
                </h4>
                <div style={{ fontSize: '0.8125rem' }}>
                  <div style={{ marginBottom: '6px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Contracting:</span>{' '}
                    <strong>{node.contractingRegime || 'mixed'}</strong>
                  </div>
                  <div style={{ marginBottom: '6px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Max Utilization:</span>{' '}
                    <strong>{((node.maxCapacityUtilization || 0.95) * 100).toFixed(0)}%</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-secondary)' }}>Inventory Buffer:</span>{' '}
                    <strong>{node.inventoryBufferTarget || 0} weeks</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Supply Formula */}
      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">Supply Calculation</h3>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
          <div style={{
            padding: 'var(--space-sm)',
            background: 'var(--bg-tertiary)',
            borderRadius: 'var(--radius-sm)',
            marginBottom: 'var(--space-md)'
          }}>
            Supply<sub>t</sub> = Capacity<sub>t</sub> × MaxUtilization × Yield<sub>t</sub>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
            <p><strong>Capacity Evolution:</strong> Base capacity + Committed expansions (with ramp) + Optional expansions (triggered by price signal)</p>
            <p><strong>Stacked Yield:</strong> Y(t) = Y<sub>target</sub> - (Y<sub>target</sub> - Y<sub>initial</sub>) × 2<sup>-t/HL</sup></p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SupplyEngineTab;
