import React, { useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area, ComposedChart, Bar, ReferenceLine
} from 'recharts';
import { NODES, NODE_GROUPS, getNode } from '../data/nodes.js';
import { formatMonth, formatNumber } from '../engine/calculations.js';

function ChartsTab({ results, selectedNode, onSelectNode, scenario }) {
  const [timeRange, setTimeRange] = useState('all');  // '5y', '10y', 'all'

  const node = getNode(selectedNode);
  const nodeData = results?.nodes[selectedNode];

  // Filter data by time range
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
        demand: nodeData.demand[i],
        supply: nodeData.supply[i],                         // Shipments cleared
        supplyPotential: nodeData.supplyPotential?.[i] || nodeData.supply[i],  // Production potential
        capacity: nodeData.capacity[i],
        tightness: nodeData.tightness[i],
        priceIndex: nodeData.priceIndex[i],
        inventory: nodeData.inventory[i],
        backlog: nodeData.backlog[i],
        yield: nodeData.yield[i] * 100,
        shortage: nodeData.shortage[i],
        glut: nodeData.glut[i],
        installedBase: nodeData.installedBase?.[i] || 0,    // Stock view
        requiredBase: nodeData.requiredBase?.[i] || 0       // Stock view
      });
    }
    return data;
  }, [nodeData, results, timeRange]);

  // Check if this is a GPU/stock node
  const isStockNode = selectedNode === 'gpu_datacenter' || selectedNode === 'gpu_inference';

  // Heatmap data for tightness across nodes
  const heatmapData = useMemo(() => {
    if (!results) return [];

    const keyNodes = ['gpu_datacenter', 'hbm_stacks', 'cowos_capacity', 'advanced_wafers',
                      'datacenter_mw', 'transformers_lpt', 'optical_transceivers'];

    // Sample every 6 months for heatmap
    const data = [];
    for (let i = 0; i < results.months.length; i += 6) {
      const point = { month: results.months[i], label: formatMonth(results.months[i]) };
      keyNodes.forEach(nodeId => {
        point[nodeId] = results.nodes[nodeId]?.tightness[i] || 1;
      });
      data.push(point);
    }
    return data;
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
              {entry.name}: {
                ['Tightness', 'Price Index', 'Yield'].includes(entry.name)
                  ? (entry.name === 'Yield' ? entry.value.toFixed(1) + '%' : entry.value.toFixed(2))
                  : formatNumber(entry.value)
              }
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
          <h1 className="tab-title">Charts Dashboard</h1>
          <p className="tab-description">
            Interactive visualizations for supply-demand dynamics, tightness ratios, and capacity evolution.
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

      {/* Node Selector */}
      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Select Node</h2>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
          {NODES.filter(n => n.startingCapacity).slice(0, 20).map(n => (
            <button
              key={n.id}
              className={`btn ${selectedNode === n.id ? 'btn-primary' : 'btn-secondary'}`}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              onClick={() => onSelectNode(n.id)}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: NODE_GROUPS[n.group]?.color
                }}
              />
              {n.name}
            </button>
          ))}
        </div>
      </div>

      {/* Selected Node Charts */}
      {node && nodeData && (
        <>
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
              {/* Shipments vs Demand (Flow View) */}
              <div className="chart-container">
                <div className="chart-header">
                  <h3 className="chart-title">{isStockNode ? 'Shipments vs Purchase Demand' : 'Shipments vs Demand'}</h3>
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval={Math.floor(chartData.length / 8)} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={(v) => formatNumber(v)} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="supplyPotential" fill="#6366f1" fillOpacity={0.1} stroke="#6366f1" strokeDasharray="4 4" name="Production Potential" />
                    <Line type="monotone" dataKey="supply" stroke="#22c55e" strokeWidth={2} dot={false} name="Shipments (Cleared)" />
                    <Line type="monotone" dataKey="demand" stroke="#ef4444" strokeWidth={2} dot={false} name={isStockNode ? 'Purchase Demand' : 'Demand'} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Tightness & Price */}
              <div className="chart-container">
                <div className="chart-header">
                  <h3 className="chart-title">Tightness & Price Index</h3>
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval={Math.floor(chartData.length / 8)} />
                    <YAxis yAxisId="left" domain={[0.5, 2]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                    <YAxis yAxisId="right" orientation="right" domain={[0.5, 3]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine yAxisId="left" y={1} stroke="var(--text-muted)" strokeDasharray="3 3" />
                    <Line yAxisId="left" type="monotone" dataKey="tightness" stroke="#6366f1" strokeWidth={2} dot={false} name="Tightness" />
                    <Line yAxisId="right" type="monotone" dataKey="priceIndex" stroke="#f59e0b" strokeWidth={2} dot={false} name="Price Index" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Inventory & Backlog */}
              <div className="chart-container">
                <div className="chart-header">
                  <h3 className="chart-title">Inventory & Backlog</h3>
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval={Math.floor(chartData.length / 8)} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={(v) => formatNumber(v)} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="inventory" stroke="#14b8a6" fill="#14b8a6" fillOpacity={0.3} name="Inventory" />
                    <Area type="monotone" dataKey="backlog" stroke="#ef4444" fill="#ef4444" fillOpacity={0.3} name="Backlog" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Stock View for GPU nodes OR Yield for others */}
              {isStockNode ? (
                <div className="chart-container">
                  <div className="chart-header">
                    <h3 className="chart-title">Installed Base vs Required Base</h3>
                  </div>
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval={Math.floor(chartData.length / 8)} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={(v) => formatNumber(v)} />
                      <Tooltip content={<CustomTooltip />} />
                      <Line type="monotone" dataKey="installedBase" stroke="#22c55e" strokeWidth={2} dot={false} name="Installed Base" />
                      <Line type="monotone" dataKey="requiredBase" stroke="#ef4444" strokeWidth={2} strokeDasharray="4 4" dot={false} name="Required Base" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="chart-container">
                  <div className="chart-header">
                    <h3 className="chart-title">Effective Yield</h3>
                  </div>
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval={Math.floor(chartData.length / 8)} />
                      <YAxis domain={[50, 100]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={v => v + '%'} />
                      <Tooltip content={<CustomTooltip />} />
                      <Line type="monotone" dataKey="yield" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Yield" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          {/* Capacity Additions */}
          {node.committedExpansions && node.committedExpansions.length > 0 && (
            <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
              <div className="card-header">
                <h3 className="card-title">Capacity Additions Timeline</h3>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-md)' }}>
                {node.committedExpansions.map((exp, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 'var(--space-sm) var(--space-md)',
                      background: exp.type === 'committed' ? 'rgba(34, 197, 94, 0.1)' : 'var(--bg-tertiary)',
                      border: `1px solid ${exp.type === 'committed' ? 'var(--accent-success)' : 'var(--bg-elevated)'}`,
                      borderRadius: 'var(--radius-md)'
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{exp.date}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-success)' }}>
                      +{formatNumber(exp.capacityAdd)}
                    </div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                      {exp.type === 'committed' ? 'Committed' : 'Optional'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Overview Heatmap */}
      <div className="section" style={{ marginTop: 'var(--space-xl)' }}>
        <div className="section-header">
          <h2 className="section-title">Tightness Heatmap (Key Nodes)</h2>
        </div>
        <div className="card">
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: '0.75rem' }}>
              <thead>
                <tr>
                  <th>Node</th>
                  {heatmapData.slice(0, 20).map((d, i) => (
                    <th key={i} style={{ textAlign: 'center', padding: '4px 8px' }}>{d.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {['gpu_datacenter', 'hbm_stacks', 'cowos_capacity', 'advanced_wafers',
                  'datacenter_mw', 'transformers_lpt', 'optical_transceivers'].map(nodeId => {
                  const n = getNode(nodeId);
                  return (
                    <tr key={nodeId}>
                      <td style={{ fontWeight: 500 }}>{n?.name || nodeId}</td>
                      {heatmapData.slice(0, 20).map((d, i) => {
                        const tightness = d[nodeId] || 1;
                        const color = tightness > 1.2 ? '#ef4444' :
                                     tightness > 1.05 ? '#f59e0b' :
                                     tightness > 0.95 ? '#22c55e' :
                                     tightness > 0.8 ? '#3b82f6' : '#8b5cf6';
                        const opacity = Math.abs(tightness - 1) * 2 + 0.2;
                        return (
                          <td
                            key={i}
                            style={{
                              textAlign: 'center',
                              background: color,
                              opacity: Math.min(opacity, 1),
                              color: 'white',
                              fontFamily: 'var(--font-mono)',
                              padding: '4px 8px'
                            }}
                          >
                            {tightness.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChartsTab;
