import React, { useMemo, useState } from 'react';
import { ASSUMPTION_SEGMENTS } from '../data/assumptions.js';

function AssumptionsTab({ assumptions, onAssumptionChange, onRunSimulation, isSimulating }) {
  const timeBlocks = ASSUMPTION_SEGMENTS;
  const [selection, setSelection] = useState(null);

  const getValue = (category, blockKey, path) => {
    let value = assumptions?.[category]?.[blockKey];
    for (const key of path) {
      value = value?.[key];
    }
    return value;
  };

  const renderInputCell = (category, blockKey, path, suffix, columnKey, rowIndex) => {
    const value = getValue(category, blockKey, path);
    const numValue = typeof value === 'object' ? value?.value : value;
    const confidence = typeof value === 'object' ? value?.confidence : null;
    const source = typeof value === 'object' ? value?.source : '';
    const isSelected = selection
      && selection.columnKey === columnKey
      && rowIndex >= Math.min(selection.start, selection.end)
      && rowIndex <= Math.max(selection.start, selection.end);

    const handleRangeSelect = (event) => {
      if (event.shiftKey && selection?.columnKey === columnKey) {
        setSelection({ columnKey, start: selection.start, end: rowIndex });
        return;
      }
      setSelection({ columnKey, start: rowIndex, end: rowIndex });
    };

    const handleFillDown = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'd') return;
      event.preventDefault();
      if (!selection || selection.columnKey !== columnKey) return;
      const startIndex = Math.min(selection.start, selection.end);
      const endIndex = Math.max(selection.start, selection.end);
      if (startIndex === endIndex) return;
      const sourceBlockKey = timeBlocks[startIndex]?.key;
      if (!sourceBlockKey) return;
      const sourceValue = getValue(category, sourceBlockKey, path);
      const sourceNumValue = typeof sourceValue === 'object' ? sourceValue?.value : sourceValue;
      if (sourceNumValue === undefined || Number.isNaN(sourceNumValue)) return;
      for (let idx = startIndex + 1; idx <= endIndex; idx += 1) {
        const targetBlockKey = timeBlocks[idx]?.key;
        if (!targetBlockKey) continue;
        onAssumptionChange(category, targetBlockKey, path, sourceNumValue);
      }
    };

    return (
      <div className={`assumption-cell${isSelected ? ' is-selected' : ''}`}>
        <div className="input-row">
          <input
            type="number"
            step="0.01"
            value={
              numValue === null || numValue === undefined || Number.isNaN(numValue)
                ? ''
                : (numValue * 100).toFixed(0)
            }
            onMouseDown={handleRangeSelect}
            onKeyDown={handleFillDown}
            onChange={(e) => {
              if (e.target.value === '') {
                onAssumptionChange(category, blockKey, path, null);
                return;
              }
              const newValue = parseFloat(e.target.value) / 100;
              if (!Number.isNaN(newValue)) {
                onAssumptionChange(category, blockKey, path, newValue);
              }
            }}
            style={{ width: '56px' }}
          />
          <span className="input-suffix">{suffix}</span>
          {confidence && (
            <span
              className={`confidence-${confidence}`}
              title={`Confidence: ${confidence}${source ? ` • ${source}` : ''}`}
            >
              {confidence === 'high' ? '●' : confidence === 'medium' ? '◐' : '○'}
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderYearRow = (block, columns, rowIndex) => (
    <tr key={block.key}>
      <td className="assumptions-label-cell assumptions-year-cell">
        <div className="assumptions-row-title">{block.label}</div>
        <div className="assumptions-row-help">{block.years}</div>
      </td>
      {columns.map((column) => {
        const columnKey = `${column.category ?? column.type}:${column.path?.join('.') ?? column.valueKey}`;
        const isSelected = selection
          && selection.columnKey === columnKey
          && rowIndex >= Math.min(selection.start, selection.end)
          && rowIndex <= Math.max(selection.start, selection.end);
        return (
        <td
          key={`${block.key}-${column.label}`}
          className={`assumptions-input-cell${isSelected ? ' is-selected' : ''}`}
        >
          {column.type === 'metric'
            ? (
              <span className="assumptions-metric">
                {column.format(efficiencySummary[block.key][column.valueKey])}
              </span>
            )
            : renderInputCell(column.category, block.key, column.path, column.suffix, columnKey, rowIndex)}
        </td>
        );
      })}
    </tr>
  );

  const efficiencySummary = useMemo(() => {
    const calcStats = (blockKey) => {
      const block = assumptions?.efficiency?.[blockKey];
      const mInference = block?.modelEfficiency?.m_inference?.value ?? 0;
      const mTraining = block?.modelEfficiency?.m_training?.value ?? 0;
      const sInference = block?.systemsEfficiency?.s_inference?.value ?? 0;
      const sTraining = block?.systemsEfficiency?.s_training?.value ?? 0;
      const h = block?.hardwareEfficiency?.h?.value ?? 0;

      const inferenceFactor = (1 - mInference) / ((1 + sInference) * (1 + h));
      const trainingFactor = (1 - mTraining) / ((1 + sTraining) * (1 + h));

      const inferenceGain = 1 / inferenceFactor;
      const trainingGain = 1 / trainingFactor;

      const totalGain = Math.sqrt(inferenceGain * trainingGain);

      return {
        inferenceGain,
        trainingGain,
        totalGain,
        inferenceOom: Math.log10(inferenceGain),
        trainingOom: Math.log10(trainingGain),
        totalOom: Math.log10(totalGain)
      };
    };

    return timeBlocks.reduce((acc, block) => {
      acc[block.key] = calcStats(block.key);
      return acc;
    }, {});
  }, [assumptions, timeBlocks]);

  const renderHeaderRow = (columns, label = 'Year') => (
    <tr>
      <th className="assumptions-header-cell assumptions-header-label">{label}</th>
      {columns.map((column) => (
        <th key={column.label} className="assumptions-header-cell">
          <div className="assumptions-col-title">{column.label}</div>
          {column.help && <div className="assumptions-col-years">{column.help}</div>}
        </th>
      ))}
    </tr>
  );

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Assumptions</h1>
          <p className="tab-description">
            Adjust demand growth, token efficiency, and supply expansion assumptions in one view.
            Years 1-5 are editable individually, with rolling 5-year blocks beyond that.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={onRunSimulation}
          disabled={isSimulating}
        >
          {isSimulating ? 'Simulating...' : 'Run Simulation'}
        </button>
      </div>

      <div className="assumptions-grid">
        <div className="assumption-block">
          <div className="assumption-block-header">
            <h3 className="assumption-block-title">Demand Growth</h3>
            <span className="assumption-block-badge">CAGR</span>
          </div>

          <div className="section">
            <h4 className="section-title">Inference Demand</h4>
            {(() => {
              const columns = [
                { category: 'demand', path: ['inferenceGrowth', 'consumer'], label: 'Consumer', suffix: '%/yr' },
                { category: 'demand', path: ['inferenceGrowth', 'enterprise'], label: 'Enterprise', suffix: '%/yr' },
                { category: 'demand', path: ['inferenceGrowth', 'agentic'], label: 'Agentic', suffix: '%/yr', help: 'High uncertainty' }
              ];
              return (
            <div className="assumptions-table-wrap">
              <table className="assumptions-table">
                <thead>{renderHeaderRow(columns)}</thead>
                <tbody>
                  {timeBlocks.map((block, index) => renderYearRow(block, columns, index))}
                </tbody>
              </table>
            </div>
              );
            })()}
          </div>

          <div className="section">
            <h4 className="section-title">Training Demand</h4>
            {(() => {
              const columns = [
                { category: 'demand', path: ['trainingGrowth', 'frontier'], label: 'Frontier Runs', suffix: '%/yr' },
                { category: 'demand', path: ['trainingGrowth', 'midtier'], label: 'Mid-tier Runs', suffix: '%/yr' }
              ];
              return (
            <div className="assumptions-table-wrap">
              <table className="assumptions-table">
                <thead>{renderHeaderRow(columns)}</thead>
                <tbody>
                  {timeBlocks.map((block, index) => renderYearRow(block, columns, index))}
                </tbody>
              </table>
            </div>
              );
            })()}
          </div>

          <div className="section">
            <h4 className="section-title">Continual Learning</h4>
            {(() => {
              const columns = [
                { category: 'demand', path: ['continualLearning', 'computeGrowth'], label: 'Compute', suffix: '%/yr' },
                { category: 'demand', path: ['continualLearning', 'dataStorageGrowth'], label: 'Data Storage', suffix: '%/yr' },
                { category: 'demand', path: ['continualLearning', 'networkBandwidthGrowth'], label: 'Network BW', suffix: '%/yr' }
              ];
              return (
            <div className="assumptions-table-wrap">
              <table className="assumptions-table">
                <thead>{renderHeaderRow(columns)}</thead>
                <tbody>
                  {timeBlocks.map((block, index) => renderYearRow(block, columns, index))}
                </tbody>
              </table>
            </div>
              );
            })()}
          </div>

          <div className="section">
            <h4 className="section-title">Inference Intensity</h4>
            {(() => {
              const columns = [
                {
                  category: 'demand',
                  path: ['intensityGrowth'],
                  label: 'Compute per Token',
                  suffix: '%/yr',
                  help: 'Context length + reasoning + agent loops'
                }
              ];
              return (
            <div className="assumptions-table-wrap">
              <table className="assumptions-table">
                <thead>{renderHeaderRow(columns)}</thead>
                <tbody>
                  {timeBlocks.map((block, index) => renderYearRow(block, columns, index))}
                </tbody>
              </table>
            </div>
              );
            })()}
          </div>
        </div>

        <div className="assumption-block">
          <div className="assumption-block-header">
            <h3 className="assumption-block-title">Efficiency Improvements</h3>
            <span className="assumption-block-badge">Annual</span>
          </div>

          <div className="section">
            <h4 className="section-title">Model Efficiency (Compute/Token Reduction)</h4>
            {(() => {
              const columns = [
                { category: 'efficiency', path: ['modelEfficiency', 'm_inference'], label: 'Inference', suffix: '%/yr' },
                { category: 'efficiency', path: ['modelEfficiency', 'm_training'], label: 'Training', suffix: '%/yr' }
              ];
              return (
            <div className="assumptions-table-wrap">
              <table className="assumptions-table">
                <thead>{renderHeaderRow(columns)}</thead>
                <tbody>
                  {timeBlocks.map((block, index) => renderYearRow(block, columns, index))}
                </tbody>
              </table>
            </div>
              );
            })()}
          </div>

          <div className="section">
            <h4 className="section-title">Systems Throughput (Software Gains)</h4>
            {(() => {
              const columns = [
                {
                  category: 'efficiency',
                  path: ['systemsEfficiency', 's_inference'],
                  label: 'Inference',
                  suffix: '%/yr',
                  help: 'Batching, kernels, schedulers'
                },
                {
                  category: 'efficiency',
                  path: ['systemsEfficiency', 's_training'],
                  label: 'Training',
                  suffix: '%/yr',
                  help: 'Distributed training optimizations'
                }
              ];
              return (
            <div className="assumptions-table-wrap">
              <table className="assumptions-table">
                <thead>{renderHeaderRow(columns)}</thead>
                <tbody>
                  {timeBlocks.map((block, index) => renderYearRow(block, columns, index))}
                </tbody>
              </table>
            </div>
              );
            })()}
          </div>

          <div className="section">
            <h4 className="section-title">Hardware Throughput (Chip Improvements)</h4>
            {(() => {
              const columns = [
                { category: 'efficiency', path: ['hardwareEfficiency', 'h'], label: 'Accelerator Perf/$', suffix: '%/yr' },
                { category: 'efficiency', path: ['hardwareEfficiency', 'h_memory'], label: 'Memory Bandwidth', suffix: '%/yr' }
              ];
              return (
            <div className="assumptions-table-wrap">
              <table className="assumptions-table">
                <thead>{renderHeaderRow(columns)}</thead>
                <tbody>
                  {timeBlocks.map((block, index) => renderYearRow(block, columns, index))}
                </tbody>
              </table>
            </div>
              );
            })()}
          </div>

          <div className="section">
            <h4 className="section-title">Implied Token Efficiency</h4>
            <p className="section-description">
              Derived from the combined model + systems + hardware improvements. OOM/year is the
              log10 efficiency gain (e.g., 0.3 = 2×/year). Total OOM/year mirrors the
              combined efficiency improvement rate used in industry reporting.
            </p>
            {(() => {
              const columns = [
                { type: 'metric', valueKey: 'inferenceGain', label: 'Inference eff. (x/yr)', format: (value) => value.toFixed(2) },
                { type: 'metric', valueKey: 'inferenceOom', label: 'Inference OOM/yr', format: (value) => value.toFixed(2) },
                { type: 'metric', valueKey: 'trainingGain', label: 'Training eff. (x/yr)', format: (value) => value.toFixed(2) },
                { type: 'metric', valueKey: 'trainingOom', label: 'Training OOM/yr', format: (value) => value.toFixed(2) },
                { type: 'metric', valueKey: 'totalGain', label: 'Total eff. (x/yr)', format: (value) => value.toFixed(2) },
                { type: 'metric', valueKey: 'totalOom', label: 'Total OOM/yr', format: (value) => value.toFixed(2) }
              ];
              return (
            <div className="assumptions-table-wrap">
              <table className="assumptions-table assumptions-table--metrics">
                <thead>{renderHeaderRow(columns)}</thead>
                <tbody>
                  {timeBlocks.map((block, index) => renderYearRow(block, columns, index))}
                </tbody>
              </table>
            </div>
              );
            })()}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">Formula Reference</h3>
        </div>
        <div className="formula-grid">
          <div>
            <h4>Inference Accelerator-Hours</h4>
            <code>
              InferAH = (Tokens × ComputePerToken × M<sub>t</sub>) / (Throughput × S<sub>t</sub> × H<sub>t</sub>)
            </code>
          </div>
          <div>
            <h4>Stacked Yield (HBM)</h4>
            <code>
              Y(t) = Y<sub>target</sub> - (Y<sub>target</sub> - Y<sub>initial</sub>) × 2<sup>-t/HL</sup>
            </code>
          </div>
          <div>
            <h4>Tightness Ratio</h4>
            <code>
              Tightness = (Demand + Backlog) / (Supply + Inventory + ε)
            </code>
          </div>
          <div>
            <h4>Price Index</h4>
            <code>
              P = 1 + a × (Tightness - 1)<sup>b</sup> when Tight {'>'} 1
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AssumptionsTab;
