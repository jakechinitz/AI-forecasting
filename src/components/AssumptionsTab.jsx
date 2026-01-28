import React, { useState } from 'react';

function AssumptionsTab({ assumptions, onAssumptionChange, onRunSimulation, isSimulating }) {
  const [activeBlock, setActiveBlock] = useState('block0');

  const blocks = [
    { key: 'block0', label: 'Years 0-5', years: '2025-2030' },
    { key: 'block1', label: 'Years 5-10', years: '2030-2035' },
    { key: 'block2', label: 'Years 10-15', years: '2035-2040' },
    { key: 'block3', label: 'Years 15-20', years: '2040-2045' }
  ];

  const demandBlock = assumptions.demand[activeBlock];
  const efficiencyBlock = assumptions.efficiency[activeBlock];

  const renderInput = (category, path, label, suffix = '%/yr', help = '', source = '') => {
    let value = category === 'demand'
      ? demandBlock
      : efficiencyBlock;

    // Navigate to nested value
    for (const key of path) {
      value = value?.[key];
    }

    const numValue = typeof value === 'object' ? value?.value : value;
    const confidence = typeof value === 'object' ? value?.confidence : 'medium';

    return (
      <div className="input-group">
        <label>{label}</label>
        <div className="input-row">
          <input
            type="number"
            step="0.01"
            value={(numValue * 100).toFixed(0)}
            onChange={(e) => {
              const newValue = parseFloat(e.target.value) / 100;
              onAssumptionChange(category, activeBlock, path, newValue);
            }}
            style={{ width: '80px' }}
          />
          <span className="input-suffix">{suffix}</span>
          {confidence && (
            <span className={`confidence-${confidence}`} title={`Confidence: ${confidence}`}>
              {confidence === 'high' ? '●' : confidence === 'medium' ? '◐' : '○'}
            </span>
          )}
        </div>
        {source && <div className="input-help">Source: {source}</div>}
        {help && <div className="input-help">{help}</div>}
      </div>
    );
  };

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Assumptions</h1>
          <p className="tab-description">
            Configure demand growth, efficiency improvements, and supply expansion rates.
            Changes are applied when you click "Run Simulation".
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

      {/* Time Block Selector */}
      <div className="tabs" style={{ marginBottom: 'var(--space-lg)' }}>
        {blocks.map(block => (
          <button
            key={block.key}
            className={`tab ${activeBlock === block.key ? 'active' : ''}`}
            onClick={() => setActiveBlock(block.key)}
          >
            {block.label}
            <span style={{ fontSize: '0.6875rem', marginLeft: '4px', opacity: 0.7 }}>
              ({block.years})
            </span>
          </button>
        ))}
      </div>

      <div className="grid grid-2" style={{ gap: 'var(--space-lg)' }}>
        {/* Demand Assumptions */}
        <div className="assumption-block">
          <div className="assumption-block-header">
            <h3 className="assumption-block-title">Demand Growth</h3>
            <span className="assumption-block-badge">CAGR</span>
          </div>

          <div className="section">
            <h4 className="section-title" style={{ marginBottom: 'var(--space-md)' }}>
              Inference Demand
            </h4>
            <div className="grid grid-3" style={{ gap: 'var(--space-md)' }}>
              {renderInput(
                'demand',
                ['inferenceGrowth', 'consumer'],
                'Consumer',
                '%/yr',
                '',
                demandBlock?.inferenceGrowth?.consumer?.source
              )}
              {renderInput(
                'demand',
                ['inferenceGrowth', 'enterprise'],
                'Enterprise',
                '%/yr',
                '',
                demandBlock?.inferenceGrowth?.enterprise?.source
              )}
              {renderInput(
                'demand',
                ['inferenceGrowth', 'agentic'],
                'Agentic',
                '%/yr',
                'High uncertainty',
                demandBlock?.inferenceGrowth?.agentic?.source
              )}
            </div>
          </div>

          <div className="section">
            <h4 className="section-title" style={{ marginBottom: 'var(--space-md)' }}>
              Training Demand
            </h4>
            <div className="grid grid-2" style={{ gap: 'var(--space-md)' }}>
              {renderInput(
                'demand',
                ['trainingGrowth', 'frontier'],
                'Frontier Runs',
                '%/yr',
                '',
                demandBlock?.trainingGrowth?.frontier?.source
              )}
              {renderInput(
                'demand',
                ['trainingGrowth', 'midtier'],
                'Mid-tier Runs',
                '%/yr',
                '',
                demandBlock?.trainingGrowth?.midtier?.source
              )}
            </div>
          </div>

          <div className="section">
            <h4 className="section-title" style={{ marginBottom: 'var(--space-md)' }}>
              Continual Learning
            </h4>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-md)' }}>
              Fine-tuning, RLHF, RAG updates — drives compute + memory/storage demand
            </p>
            <div className="grid grid-3" style={{ gap: 'var(--space-md)' }}>
              {renderInput(
                'demand',
                ['continualLearning', 'computeGrowth'],
                'Compute',
                '%/yr',
                '',
                demandBlock?.continualLearning?.computeGrowth?.source
              )}
              {renderInput(
                'demand',
                ['continualLearning', 'dataStorageGrowth'],
                'Data Storage',
                '%/yr',
                '',
                demandBlock?.continualLearning?.dataStorageGrowth?.source
              )}
              {renderInput(
                'demand',
                ['continualLearning', 'networkBandwidthGrowth'],
                'Network BW',
                '%/yr',
                '',
                demandBlock?.continualLearning?.networkBandwidthGrowth?.source
              )}
            </div>
          </div>

          <div className="section">
            <h4 className="section-title" style={{ marginBottom: 'var(--space-md)' }}>
              Inference Intensity
            </h4>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-md)' }}>
              Compute per token growth (context, reasoning, agents)
            </p>
            <div className="grid grid-1" style={{ gap: 'var(--space-md)' }}>
              {renderInput(
                'demand',
                ['intensityGrowth'],
                'Intensity Growth',
                '%/yr',
                '',
                demandBlock?.intensityGrowth?.source
              )}
            </div>
          </div>
        </div>

        {/* Efficiency Assumptions */}
        <div className="assumption-block">
          <div className="assumption-block-header">
            <h3 className="assumption-block-title">Efficiency Improvements</h3>
            <span className="assumption-block-badge">Annual</span>
          </div>

          <div className="section">
            <h4 className="section-title" style={{ marginBottom: 'var(--space-md)' }}>
              Model Efficiency (Compute/Token Reduction)
            </h4>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-md)' }}>
              M<sub>t</sub> = (1-m)<sup>t/12</sup> — Compute per token decreases
            </p>
            <div className="grid grid-2" style={{ gap: 'var(--space-md)' }}>
              {renderInput(
                'efficiency',
                ['modelEfficiency', 'm_inference'],
                'Inference',
                '%/yr',
                '',
                efficiencyBlock?.modelEfficiency?.m_inference?.source
              )}
              {renderInput(
                'efficiency',
                ['modelEfficiency', 'm_training'],
                'Training',
                '%/yr',
                '',
                efficiencyBlock?.modelEfficiency?.m_training?.source
              )}
            </div>
          </div>

          <div className="section">
            <h4 className="section-title" style={{ marginBottom: 'var(--space-md)' }}>
              Systems Throughput (Software Gains)
            </h4>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-md)' }}>
              S<sub>t</sub> = (1+s)<sup>t/12</sup> — Throughput increases
            </p>
            <div className="grid grid-2" style={{ gap: 'var(--space-md)' }}>
              {renderInput(
                'efficiency',
                ['systemsEfficiency', 's_inference'],
                'Inference',
                '%/yr',
                'vLLM, batching, speculative decoding'
              )}
              {renderInput(
                'efficiency',
                ['systemsEfficiency', 's_training'],
                'Training',
                '%/yr',
                'Distributed training optimizations'
              )}
            </div>
          </div>

          <div className="section">
            <h4 className="section-title" style={{ marginBottom: 'var(--space-md)' }}>
              Hardware Throughput (Chip Improvements)
            </h4>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-md)' }}>
              H<sub>t</sub> = (1+h)<sup>t/12</sup> — Performance/$ increases
            </p>
            <div className="grid grid-2" style={{ gap: 'var(--space-md)' }}>
              {renderInput(
                'efficiency',
                ['hardwareEfficiency', 'h'],
                'Accelerator Perf/$',
                '%/yr',
                '',
                efficiencyBlock?.hardwareEfficiency?.h?.source
              )}
              {renderInput(
                'efficiency',
                ['hardwareEfficiency', 'h_memory'],
                'Memory Bandwidth',
                '%/yr',
                'HBM generation improvements'
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Formula Reference */}
      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">Formula Reference</h3>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--space-lg)' }}>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Inference Accelerator-Hours</h4>
            <code style={{
              display: 'block',
              padding: 'var(--space-sm)',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono)'
            }}>
              InferAH = (Tokens × ComputePerToken × M<sub>t</sub>) / (Throughput × S<sub>t</sub> × H<sub>t</sub>)
            </code>
          </div>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Stacked Yield (HBM)</h4>
            <code style={{
              display: 'block',
              padding: 'var(--space-sm)',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono)'
            }}>
              Y(t) = Y<sub>target</sub> - (Y<sub>target</sub> - Y<sub>initial</sub>) × 2<sup>-t/HL</sup>
            </code>
          </div>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Tightness Ratio</h4>
            <code style={{
              display: 'block',
              padding: 'var(--space-sm)',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono)'
            }}>
              Tightness = (Demand + Backlog) / (Supply + Inventory + ε)
            </code>
          </div>
          <div>
            <h4 style={{ fontSize: '0.875rem', marginBottom: 'var(--space-sm)' }}>Price Index</h4>
            <code style={{
              display: 'block',
              padding: 'var(--space-sm)',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono)'
            }}>
              P = 1 + a × (Tightness - 1)<sup>b</sup> when Tight {'>'} 1
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AssumptionsTab;
