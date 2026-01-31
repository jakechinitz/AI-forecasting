import React, { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { formatMonth, formatNumber } from '../engine/calculations.js';

function DemandEngineTab({ results, assumptions }) {
  // Prepare chart data - sample every 3 months for readability
  const chartData = useMemo(() => {
    if (!results) return [];

    const data = [];
    for (let i = 0; i < results.months.length; i += 3) {
      const month = results.months[i];

      // Get inference node data
      const consumerDemand = results.nodes.inference_consumer?.demand[i] || 0;
      const enterpriseDemand = results.nodes.inference_enterprise?.demand[i] || 0;
      const agenticDemand = results.nodes.inference_agentic?.demand[i] || 0;

      // Get training node data
      const frontierDemand = results.nodes.training_frontier?.demand[i] || 0;
      const midtierDemand = results.nodes.training_midtier?.demand[i] || 0;

      // GPU demand
      const gpuDemand = results.nodes.gpu_datacenter?.demand[i] || 0;

      data.push({
        month,
        label: formatMonth(month),
        consumer: consumerDemand,
        enterprise: enterpriseDemand,
        agentic: agenticDemand,
        totalInference: consumerDemand + enterpriseDemand + agenticDemand,
        frontier: frontierDemand,
        midtier: midtierDemand,
        gpuDemand
      });
    }
    return data;
  }, [results]);

  // Summary metrics
  const summaryMetrics = useMemo(() => {
    if (!chartData.length) return null;

    const current = chartData[4] || chartData[0];  // ~1 year out
    const future5y = chartData[20] || chartData[chartData.length - 1];  // ~5 years out
    const future10y = chartData[40] || chartData[chartData.length - 1]; // ~10 years out

    return {
      currentInference: current.totalInference,
      future5yInference: future5y.totalInference,
      future10yInference: future10y.totalInference,
      inferenceGrowth5y: ((future5y.totalInference / current.totalInference) - 1) * 100,
      currentGpu: current.gpuDemand,
      future5yGpu: future5y.gpuDemand
    };
  }, [chartData]);

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
              {entry.name}: {formatNumber(entry.value)}
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
          <h1 className="tab-title">Demand Drivers</h1>
          <p className="tab-description">
            Computes monthly workload demand: training compute (frontier + mid-tier runs) and
            inference tokens (consumer, enterprise, agentic). Applies efficiency multipliers
            to translate tokens to accelerator-hours.
          </p>
        </div>
      </div>

      {/* Summary Metrics */}
      {summaryMetrics && (
        <div className="grid grid-4" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="card">
            <div className="metric">
              <span className="metric-value">{formatNumber(summaryMetrics.currentInference)}</span>
              <span className="metric-label">Current Inference (tokens/mo)</span>
            </div>
          </div>
          <div className="card">
            <div className="metric">
              <span className="metric-value">{formatNumber(summaryMetrics.future5yInference)}</span>
              <span className="metric-label">5-Year Inference (tokens/mo)</span>
              <span className="metric-change positive">
                +{summaryMetrics.inferenceGrowth5y.toFixed(0)}%
              </span>
            </div>
          </div>
          <div className="card">
            <div className="metric">
              <span className="metric-value">{formatNumber(summaryMetrics.currentGpu)}</span>
              <span className="metric-label">Current GPU Demand</span>
            </div>
          </div>
          <div className="card">
            <div className="metric">
              <span className="metric-value">{formatNumber(summaryMetrics.future5yGpu)}</span>
              <span className="metric-label">5-Year GPU Demand</span>
            </div>
          </div>
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-2" style={{ gap: 'var(--space-lg)' }}>
        {/* Inference Demand by Segment */}
        <div className="chart-container">
          <div className="chart-header">
            <h3 className="chart-title">Inference Demand by Segment</h3>
            <div className="chart-legend">
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#6366f1' }} />
                Consumer
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#8b5cf6' }} />
                Enterprise
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#ec4899' }} />
                Agentic
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={300}>
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
                dataKey="consumer"
                stackId="1"
                stroke="#6366f1"
                fill="#6366f1"
                fillOpacity={0.6}
                name="Consumer"
              />
              <Area
                type="monotone"
                dataKey="enterprise"
                stackId="1"
                stroke="#8b5cf6"
                fill="#8b5cf6"
                fillOpacity={0.6}
                name="Enterprise"
              />
              <Area
                type="monotone"
                dataKey="agentic"
                stackId="1"
                stroke="#ec4899"
                fill="#ec4899"
                fillOpacity={0.6}
                name="Agentic"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* GPU Demand */}
        <div className="chart-container">
          <div className="chart-header">
            <h3 className="chart-title">GPU Demand (units/month)</h3>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
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
              <Line
                type="monotone"
                dataKey="gpuDemand"
                stroke="#22c55e"
                strokeWidth={2}
                dot={false}
                name="GPU Demand"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Formula Box */}
      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header">
          <h3 className="card-title">Demand Calculation Formula</h3>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', lineHeight: 1.8 }}>
          <div style={{ marginBottom: 'var(--space-md)' }}>
            <strong>Inference Accelerator-Hours:</strong>
            <div style={{
              padding: 'var(--space-sm)',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-sm)',
              marginTop: 'var(--space-xs)'
            }}>
              InferAH<sub>t</sub> = (Tokens<sub>t</sub> × ComputePerToken<sub>0</sub> × M<sub>t</sub>) / (ThroughputPerAH<sub>0</sub> × S<sub>t</sub> × H<sub>t</sub>)
            </div>
          </div>
          <div style={{ marginBottom: 'var(--space-md)' }}>
            <strong>Training Accelerator-Hours:</strong>
            <div style={{
              padding: 'var(--space-sm)',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-sm)',
              marginTop: 'var(--space-xs)'
            }}>
              TrainAH<sub>t</sub> = (Runs<sub>t</sub> × ComputePerRun<sub>0</sub> × M<sup>train</sup><sub>t</sub>) / (ThroughputPerAH<sub>0</sub> × S<sup>train</sup><sub>t</sub> × H<sub>t</sub>)
            </div>
          </div>
          <div>
            <strong>Where:</strong>
            <ul style={{ marginTop: 'var(--space-xs)', paddingLeft: 'var(--space-lg)', color: 'var(--text-secondary)' }}>
              <li>M<sub>t</sub> = (1-m)<sup>t/12</sup> — Model efficiency (compute/token) decreases</li>
              <li>S<sub>t</sub> = (1+s)<sup>t/12</sup> — Systems throughput increases</li>
              <li>H<sub>t</sub> = (1+h)<sup>t/12</sup> — Hardware throughput increases</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DemandEngineTab;
