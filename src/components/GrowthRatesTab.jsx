import React, { useMemo } from 'react';
import { NODES, NODE_GROUPS } from '../data/nodes.js';
import { formatMonth } from '../engine/calculations.js';

function GrowthRatesTab({ results, onSelectNode }) {
  if (!results) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>Running simulation...</p>
      </div>
    );
  }

  const rows = useMemo(() => {
    if (!results?.months?.length) return [];
    const lastIndex = results.months.length - 1;
    const priorIndex = lastIndex - 12;
    if (priorIndex < 0) return [];

    return NODES.map((node) => {
      const nodeData = results.nodes[node.id];
      if (!nodeData) return null;
      const demandNow = nodeData.demand[lastIndex] ?? 0;
      const demandPrior = nodeData.demand[priorIndex] ?? 0;
      const supplyNow = nodeData.supplyPotential[lastIndex] ?? 0;
      const supplyPrior = nodeData.supplyPotential[priorIndex] ?? 0;

      const demandGrowth = demandPrior > 0 ? (demandNow / demandPrior) - 1 : null;
      const supplyGrowth = supplyPrior > 0 ? (supplyNow / supplyPrior) - 1 : null;
      const tightness = nodeData.tightness[lastIndex] ?? 1;

      return {
        id: node.id,
        name: node.name,
        group: node.group,
        demandGrowth,
        supplyGrowth,
        tightness
      };
    }).filter(Boolean)
      .sort((a, b) => (b.demandGrowth ?? -Infinity) - (a.demandGrowth ?? -Infinity));
  }, [results]);

  const formatPercent = (value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '-';
    return `${(value * 100).toFixed(1)}%`;
  };

  const getTightnessLabel = (value) => {
    if (value > 1.2) return { label: 'Shortage', color: 'var(--status-tight)' };
    if (value > 1.05) return { label: 'Tight', color: 'var(--status-stressed)' };
    if (value > 0.95) return { label: 'Balanced', color: 'var(--status-balanced)' };
    if (value > 0.8) return { label: 'Soft', color: 'var(--status-soft)' };
    return { label: 'Glut', color: 'var(--status-glut)' };
  };

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">YoY Growth Rates</h1>
          <p className="tab-description">
            Year-over-year demand and supply growth for every node. Click a row to jump into
            the node trend view for details.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            Latest YoY Growth (as of {formatMonth(results.months[results.months.length - 1])})
          </h3>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th className="text-cell" style={{ textAlign: 'left' }}>Node</th>
                <th className="text-cell" style={{ textAlign: 'left' }}>Group</th>
                <th>Demand YoY</th>
                <th>Supply YoY</th>
                <th>Tightness</th>
                <th className="text-cell" style={{ textAlign: 'left' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = getTightnessLabel(row.tightness);
                return (
                  <tr
                    key={row.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onSelectNode(row.id)}
                  >
                    <td className="text-cell">
                      <span
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: NODE_GROUPS[row.group]?.color,
                          marginRight: '6px'
                        }}
                      />
                      {row.name}
                    </td>
                    <td className="text-cell">{NODE_GROUPS[row.group]?.name}</td>
                    <td>{formatPercent(row.demandGrowth)}</td>
                    <td>{formatPercent(row.supplyGrowth)}</td>
                    <td>{row.tightness.toFixed(2)}</td>
                    <td className="text-cell" style={{ color: status.color, fontWeight: 600 }}>
                      {status.label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default GrowthRatesTab;
