import React, { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from 'recharts';
import { NODES, NODE_GROUPS, getNode } from '../data/nodes.js';
import { formatMonth, formatNumber } from '../engine/calculations.js';

function MarketClearingTab({ results, selectedNode, onSelectNode }) {
  const nodeData = useMemo(() => {
    if (!results || !selectedNode) return null;
    return results.nodes[selectedNode];
  }, [results, selectedNode]);

  const node = getNode(selectedNode);

  // Prepare chart data
  const chartData = useMemo(() => {
    if (!nodeData) return [];

    const data = [];
    for (let i = 0; i < results.months.length; i += 3) {
      data.push({
        month: results.months[i],
        label: formatMonth(results.months[i]),
        demand: nodeData.demand[i],
        supply: nodeData.supply[i],
        tightness: nodeData.tightness[i],
        priceIndex: nodeData.priceIndex[i],
        inventory: nodeData.inventory[i],
        backlog: nodeData.backlog[i]
      });
    }
    return data;
  }, [nodeData, results]);

  // Get tightness status
  const getTightnessStatus = (value) => {
    if (value > 1.2) return { label: 'Severe Shortage', color: 'var(--status-tight)', badge: 'badge-tight' };
    if (value > 1.05) return { label: 'Tight', color: 'var(--status-stressed)', badge: 'badge-stressed' };
    if (value > 0.95) return { label: 'Balanced', color: 'var(--status-balanced)', badge: 'badge-balanced' };
    if (value > 0.8) return { label: 'Soft', color: 'var(--status-soft)', badge: 'badge-soft' };
    return { label: 'Glut', color: 'var(--status-glut)', badge: 'badge-glut' };
  };

  // Market overview for all key nodes
  const marketOverview = useMemo(() => {
    if (!results) return [];

    const keyNodeIds = ['gpu_datacenter', 'hbm_stacks', 'cowos_capacity', 'advanced_wafers',
                        'datacenter_mw', 'transformers_lpt', 'optical_transceivers', 'server_assembly'];

    return keyNodeIds.map(id => {
      const n = getNode(id);
      const data = results.nodes[id];
      if (!n || !data) return null;

      const currentMonth = 12;
      const tightness = data.tightness[currentMonth] || 1;
      const priceIndex = data.priceIndex[currentMonth] || 1;
      const status = getTightnessStatus(tightness);

      return {
        id,
        name: n.name,
        group: n.group,
        tightness,
        priceIndex,
        status
      };
    }).filter(Boolean);
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
                entry.name === 'Tightness' || entry.name === 'Price Index'
                  ? entry.value.toFixed(2)
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
          <h1 className="tab-title">Market Clearing</h1>
          <p className="tab-description">
            Computes tightness ratios, price indices, and inventory levels. Tightness {'>'} 1 indicates
            shortage; {'<'} 1 indicates oversupply. Price index reflects market stress.
          </p>
        </div>
      </div>

      {/* Market Overview Grid */}
      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Market Status at Year 1</h2>
          <span className="section-subtitle">Click to view details</span>
        </div>

        <div className="grid grid-4" style={{ gap: 'var(--space-md)' }}>
          {marketOverview.map(item => (
            <div
              key={item.id}
              className={`card ${selectedNode === item.id ? 'selected' : ''}`}
              style={{
                cursor: 'pointer',
                borderColor: selectedNode === item.id ? 'var(--accent-primary)' : undefined
              }}
              onClick={() => onSelectNode(item.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-sm)' }}>
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '2px' }}>
                    {NODE_GROUPS[item.group]?.name}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{item.name}</div>
                </div>
                <span className={`badge ${item.status.badge}`}>{item.status.label}</span>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-lg)' }}>
                <div>
                  <div style={{
                    fontSize: '1.25rem',
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    color: item.status.color
                  }}>
                    {item.tightness.toFixed(2)}
                  </div>
                  <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Tightness</div>
                </div>
                <div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                    {item.priceIndex.toFixed(2)}
                  </div>
                  <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Price Index</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Selected Node Charts */}
      {node && nodeData && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">{node.name} - Market Dynamics</h2>
          </div>

          <div className="grid grid-2" style={{ gap: 'var(--space-lg)' }}>
            {/* Supply vs Demand */}
            <div className="chart-container">
              <div className="chart-header">
                <h3 className="chart-title">Supply vs Demand</h3>
                <div className="chart-legend">
                  <span className="legend-item">
                    <span className="legend-dot" style={{ background: '#22c55e' }} />
                    Supply
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot" style={{ background: '#ef4444' }} />
                    Demand
                  </span>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval={7} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={(v) => formatNumber(v)} />
                  <Tooltip content={<CustomTooltip />} />
                  <Line type="monotone" dataKey="supply" stroke="#22c55e" strokeWidth={2} dot={false} name="Supply" />
                  <Line type="monotone" dataKey="demand" stroke="#ef4444" strokeWidth={2} dot={false} name="Demand" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Tightness Ratio */}
            <div className="chart-container">
              <div className="chart-header">
                <h3 className="chart-title">Tightness Ratio</h3>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval={7} />
                  <YAxis domain={[0.5, 2]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={1} stroke="var(--text-muted)" strokeDasharray="3 3" />
                  <ReferenceLine y={1.05} stroke="var(--status-stressed)" strokeDasharray="3 3" label={{ value: 'Tight', fill: 'var(--status-stressed)', fontSize: 10 }} />
                  <ReferenceLine y={0.95} stroke="var(--status-soft)" strokeDasharray="3 3" label={{ value: 'Soft', fill: 'var(--status-soft)', fontSize: 10 }} />
                  <Line
                    type="monotone"
                    dataKey="tightness"
                    stroke="#6366f1"
                    strokeWidth={2}
                    dot={false}
                    name="Tightness"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Price Index */}
            <div className="chart-container">
              <div className="chart-header">
                <h3 className="chart-title">Price Index</h3>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval={7} />
                  <YAxis domain={[0.5, 3]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={1} stroke="var(--text-muted)" strokeDasharray="3 3" label={{ value: 'Base', fill: 'var(--text-muted)', fontSize: 10 }} />
                  <Line
                    type="monotone"
                    dataKey="priceIndex"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={false}
                    name="Price Index"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Inventory & Backlog */}
            <div className="chart-container">
              <div className="chart-header">
                <h3 className="chart-title">Inventory & Backlog</h3>
                <div className="chart-legend">
                  <span className="legend-item">
                    <span className="legend-dot" style={{ background: '#14b8a6' }} />
                    Inventory
                  </span>
                  <span className="legend-item">
                    <span className="legend-dot" style={{ background: '#ef4444' }} />
                    Backlog
                  </span>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval={7} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickFormatter={(v) => formatNumber(v)} />
                  <Tooltip content={<CustomTooltip />} />
                  <Line type="monotone" dataKey="inventory" stroke="#14b8a6" strokeWidth={2} dot={false} name="Inventory" />
                  <Line type="monotone" dataKey="backlog" stroke="#ef4444" strokeWidth={2} dot={false} name="Backlog" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Formula Reference */}
      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">Market Clearing Formulas</h3>
        </div>
        <div className="grid grid-2" style={{ gap: 'var(--space-lg)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
            <h4 style={{ marginBottom: 'var(--space-sm)', fontFamily: 'var(--font-sans)' }}>Tightness</h4>
            <div style={{ padding: 'var(--space-sm)', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
              Tight<sub>t</sub> = (D<sub>t</sub> + Backlog<sub>t</sub>) / (S<sub>t</sub> + Inv<sub>t</sub> + ε)
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
            <h4 style={{ marginBottom: 'var(--space-sm)', fontFamily: 'var(--font-sans)' }}>Price Index</h4>
            <div style={{ padding: 'var(--space-sm)', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
              P<sub>t</sub> = 1 + a × (Tight<sub>t</sub> - 1)<sup>b</sup> when Tight {'>'} 1
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MarketClearingTab;
