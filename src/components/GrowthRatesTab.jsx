import React, { useMemo } from 'react';
import { NODES } from '../data/nodes.js';
import { formatMonth } from '../engine/calculations.js';

function GrowthRatesTab({ results }) {
  if (!results) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>Running simulation...</p>
      </div>
    );
  }

  const { rows, monthLabels } = useMemo(() => {
    if (!results?.months?.length) return { rows: [], monthLabels: [] };
    const monthLabelsLocal = results.months.map((month) => formatMonth(month));

    const rowData = NODES.map((node) => {
      const nodeData = results.nodes[node.id];
      if (!nodeData) return null;
      const demandGrowthByMonth = results.months.map((_, index) => {
        if (index < 12) return null;
        const demandNow = nodeData.demand[index] ?? 0;
        const demandPrior = nodeData.demand[index - 12] ?? 0;
        return demandPrior > 0 ? (demandNow / demandPrior) - 1 : null;
      });

      return {
        id: node.id,
        name: node.name,
        demandGrowthByMonth
      };
    }).filter(Boolean);

    return { rows: rowData, monthLabels: monthLabelsLocal };
  }, [results]);

  const formatPercent = (value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '-';
    return `${(value * 100).toFixed(1)}%`;
  };

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">YoY Growth Rates</h1>
          <p className="tab-description">
            Year-over-year demand growth by month for every node.
          </p>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th className="text-cell" style={{ textAlign: 'left' }}>Node</th>
              {monthLabels.map((label) => (
                <th key={label} style={{ whiteSpace: 'nowrap' }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="text-cell">{row.name}</td>
                {row.demandGrowthByMonth.map((value, index) => (
                  <td key={`${row.id}-${index}`}>{formatPercent(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default GrowthRatesTab;
