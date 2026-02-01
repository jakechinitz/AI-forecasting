import React, { useMemo, useState } from 'react';
import { NODES } from '../data/nodes.js';
import { formatMonth, formatNumber } from '../engine/calculations.js';

const METRIC_DEFINITIONS = [
  { key: 'demand', label: 'Demand' },
  { key: 'supply', label: 'Supply (Shipments)' },
  { key: 'supplyPotential', label: 'Supply Potential' },
  { key: 'gpuDelivered', label: 'GPU Delivered' },
  { key: 'idleGpus', label: 'Idle GPUs' },
  { key: 'capacity', label: 'Capacity' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'shortage', label: 'Shortage' },
  { key: 'glut', label: 'Glut' },
  { key: 'tightness', label: 'Tightness' },
  { key: 'priceIndex', label: 'Price Index' },
  { key: 'yield', label: 'Yield (%)', downloadKey: 'yield_percent', transform: value => value * 100 },
  { key: 'installedBase', label: 'Installed Base' },
  { key: 'requiredBase', label: 'Required Base' },
  { key: 'gpuPurchases', label: 'GPU Purchases' }
];

const formatDisplayValue = (value, metricKey, transform) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  const finalValue = transform ? transform(value) : value;

  if (['tightness', 'priceIndex'].includes(metricKey)) {
    return finalValue.toFixed(2);
  }

  if (metricKey === 'yield') {
    return `${finalValue.toFixed(2)}%`;
  }

  return formatNumber(finalValue, 2);
};

const formatRawValue = (value, transform) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const finalValue = transform ? transform(value) : value;
  return Number.isFinite(finalValue) ? finalValue.toString() : '';
};

function PrintoutTab({ results, scenario }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const printoutText = useMemo(() => {
    if (!results) return '';

    const lines = [];
    lines.push('# Forecast Printout');
    lines.push(`Scenario: ${scenario?.name || scenario?.label || 'Custom'}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('Notes: Values are monthly. Yield is expressed as percent. Tightness and price index are unitless.');
    lines.push('');

    NODES.forEach(node => {
      const nodeData = results.nodes[node.id];
      if (!nodeData) return;

      // Only include metrics that have at least one non-null value for this node
      const metrics = METRIC_DEFINITIONS.filter(metric => {
        const arr = nodeData[metric.key];
        return Array.isArray(arr) && arr.some(v => v !== null && v !== undefined);
      });
      const headerKeys = metrics.map(metric => metric.downloadKey || metric.key);

      lines.push(`## Node: ${node.name} (${node.id})`);
      lines.push(`| Month | Month Index | ${headerKeys.join(' | ')} |`);
      lines.push(`| --- | --- | ${headerKeys.map(() => '---').join(' | ')} |`);

      results.months.forEach(monthIndex => {
        const rowValues = metrics.map(metric => {
          const value = nodeData[metric.key]?.[monthIndex];
          return formatRawValue(value, metric.transform);
        });
        lines.push(`| ${formatMonth(monthIndex)} | ${monthIndex} | ${rowValues.join(' | ')} |`);
      });

      lines.push('');
    });

    return lines.join('\n');
  }, [results, scenario]);

  const handleDownload = () => {
    const blob = new Blob([printoutText], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'forecast-printout.md';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const visibleNodes = isExpanded ? NODES : NODES.slice(0, 6);

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Forecast Printout</h1>
          <p className="tab-description">
            Monthly printout of every node and metric, formatted for humans and LLMs. Download to share or
            archive.
          </p>
        </div>
        <div className="printout-actions">
          <button className="btn btn-primary" onClick={handleDownload}>
            Download printout
          </button>
        </div>
      </div>

      <div className="printout-meta">
        <div>
          <strong>Scenario:</strong> {scenario?.name || scenario?.label || 'Custom'}
        </div>
        <div>
          <strong>Nodes:</strong> {NODES.length}
        </div>
        <div>
          <strong>Months:</strong> {results?.months.length}
        </div>
      </div>

      <div className="printout-preview">
        <div className="printout-preview-header">
          <h2 className="section-title">Preview</h2>
          <button
            className="btn btn-secondary"
            onClick={() => setIsExpanded(prev => !prev)}
          >
            {isExpanded ? 'Show fewer nodes' : 'Show all nodes'}
          </button>
        </div>

        <div className="printout-grid">
          {visibleNodes.map(node => {
            const nodeData = results?.nodes?.[node.id];
            if (!nodeData) return null;

            // Only include metrics that have at least one non-null value for this node
            const metrics = METRIC_DEFINITIONS.filter(metric => {
              const arr = nodeData[metric.key];
              return Array.isArray(arr) && arr.some(v => v !== null && v !== undefined);
            });

            return (
              <div key={node.id} className="printout-card">
                <div className="printout-card-header">
                  <h3>{node.name}</h3>
                  <span className="printout-node-id">{node.id}</span>
                </div>
                <div className="printout-table-wrapper">
                  <table className="data-table printout-table">
                    <thead>
                      <tr>
                        <th>Month</th>
                        {metrics.map(metric => (
                          <th key={metric.key}>{metric.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {results.months.map(monthIndex => (
                        <tr key={monthIndex}>
                          <td className="text-cell">{formatMonth(monthIndex)}</td>
                          {metrics.map(metric => (
                            <td key={metric.key}>
                              {formatDisplayValue(
                                nodeData[metric.key]?.[monthIndex],
                                metric.key,
                                metric.transform
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="printout-text-block">
        <div className="section-header">
          <h2 className="section-title">Full printout (Markdown)</h2>
        </div>
        <pre className="printout-text">{printoutText}</pre>
      </div>
    </div>
  );
}

export default PrintoutTab;
