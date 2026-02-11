import React, { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { formatMonth, formatNumber, MAX_EFFICIENCY_GAIN } from '../engine/calculations.js';
import { GLOBAL_PARAMS, ASSUMPTION_SEGMENTS, TRANSLATION_INTENSITIES, getBlockKeyForMonth } from '../data/assumptions.js';

const BRAIN = GLOBAL_PARAMS.brainEquivalency;
const KW_PER_GPU = (TRANSLATION_INTENSITIES?.serverToInfra?.kwPerGpu?.value ?? 1.0);
const PUE = (TRANSLATION_INTENSITIES?.serverToInfra?.pue?.value ?? 1.3);
const WATTS_PER_GPU = KW_PER_GPU * PUE * 1000; // Convert kW to watts, apply PUE
const WORLD_POPULATION = 8.2e9; // ~8.2 billion humans (2026)

/* Block durations in years (matches ASSUMPTION_SEGMENTS order) */
const BLOCK_YEARS = [1, 1, 1, 1, 1, 5, 5, 5];

/**
 * Compute watts-per-brain-equivalent at a given month based on efficiency assumptions.
 * Uses block-chained compounding of total efficiency gain, capped at the same
 * thermodynamic efficiency ceiling (117×) used by the simulation engine.
 */
function computeBrainEquivAtMonth(month, efficiencyAssumptions) {
  if (!efficiencyAssumptions) return BRAIN.startingWattsPerBrainEquiv;

  // Compute cumulative efficiency gain month-by-month
  let cumGain = 1.0;
  // Cap at the same thermodynamic limit the sim engine uses (700W / 6W ≈ 117×).
  // Once hardware efficiency is maxed out, brain equivalency stops improving too.
  const maxGain = MAX_EFFICIENCY_GAIN;
  const minWatts = BRAIN.startingWattsPerBrainEquiv / maxGain;

  for (let m = 1; m <= month; m++) {
    if (cumGain >= maxGain) break;

    const blockKey = getBlockKeyForMonth(m);
    const block = efficiencyAssumptions?.[blockKey];

    const mInf = block?.modelEfficiency?.m_inference?.value ?? 0;
    const sInf = block?.systemsEfficiency?.s_inference?.value ?? 0;
    const h = block?.hardwareEfficiency?.h?.value ?? 0;
    const hMem = block?.hardwareEfficiency?.h_memory?.value ?? 0;
    const mTrn = block?.modelEfficiency?.m_training?.value ?? 0;
    const sTrn = block?.systemsEfficiency?.s_training?.value ?? 0;

    // Annual gains for inference (includes h_memory) and training
    const infFactor = (1 - mInf) / ((1 + sInf) * (1 + h) * (1 + hMem));
    const trnFactor = (1 - mTrn) / ((1 + sTrn) * (1 + h));
    const totalAnnualGain = Math.sqrt((1 / infFactor) * (1 / trnFactor));

    // Monthly compound
    const monthlyGain = Math.pow(totalAnnualGain, 1 / 12);
    cumGain *= monthlyGain;
  }

  cumGain = Math.min(cumGain, maxGain);
  return Math.max(BRAIN.startingWattsPerBrainEquiv / cumGain, minWatts);
}

function DemandEngineTab({ results, assumptions }) {
  const [timeRange, setTimeRange] = useState('all');  // '5y', '10y', 'all'

  // Prepare chart data - sample every 3 months for readability
  const chartData = useMemo(() => {
    if (!results) return [];

    let maxMonth = results.months.length;
    if (timeRange === '5y') maxMonth = 60;
    else if (timeRange === '10y') maxMonth = 120;

    const data = [];
    for (let i = 0; i < Math.min(results.months.length, maxMonth); i += 3) {
      const month = results.months[i];

      // Get inference node data
      const consumerDemand = results.nodes.inference_consumer?.demand[i] || 0;
      const enterpriseDemand = results.nodes.inference_enterprise?.demand[i] || 0;
      const agenticDemand = results.nodes.inference_agentic?.demand[i] || 0;

      // Get training node data
      const frontierDemand = results.nodes.training_frontier?.demand[i] || 0;
      const midtierDemand = results.nodes.training_midtier?.demand[i] || 0;

      // GPU demand and installed base
      const gpuDemand = (results.nodes.gpu_datacenter?.requiredBase?.[i] || 0)
        + (results.nodes.gpu_inference?.requiredBase?.[i] || 0);
      const dcInstalled = results.nodes.gpu_datacenter?.installedBase[i] || 0;
      const infInstalled = results.nodes.gpu_inference?.installedBase[i] || 0;
      const totalInstalled = dcInstalled + infInstalled;

      // Power and brain equivalents
      const totalPowerWatts = totalInstalled * WATTS_PER_GPU;
      const totalPowerGW = totalPowerWatts / 1e9;
      const wattsPerBrainEquiv = computeBrainEquivAtMonth(month, assumptions?.efficiency);
      const brainEquivalents = totalPowerWatts / wattsPerBrainEquiv;

      const aisPerHuman = brainEquivalents / WORLD_POPULATION;

      data.push({
        month,
        label: formatMonth(month),
        consumer: consumerDemand,
        enterprise: enterpriseDemand,
        agentic: agenticDemand,
        totalInference: consumerDemand + enterpriseDemand + agenticDemand,
        frontier: frontierDemand,
        midtier: midtierDemand,
        gpuDemand,
        totalInstalled,
        totalPowerGW,
        brainEquivalents,
        wattsPerBrainEquiv,
        aisPerHuman
      });
    }
    return data;
  }, [results, timeRange, assumptions]);

  // Summary metrics
  const summaryMetrics = useMemo(() => {
    if (!chartData.length) return null;

    const current = chartData[4] || chartData[0];  // ~1 year out
    const future5y = chartData[20] || chartData[chartData.length - 1];  // ~5 years out

    return {
      currentInference: current.totalInference,
      future5yInference: future5y.totalInference,
      inferenceGrowth5y: ((future5y.totalInference / current.totalInference) - 1) * 100,
      currentGpu: current.gpuDemand,
      future5yGpu: future5y.gpuDemand,
      currentBrainEquiv: current.brainEquivalents,
      future5yBrainEquiv: future5y.brainEquivalents,
      currentPowerGW: current.totalPowerGW,
      future5yPowerGW: future5y.totalPowerGW,
      currentAisPerHuman: current.aisPerHuman,
      future5yAisPerHuman: future5y.aisPerHuman
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
            to translate tokens to accelerator-hours. Brain-equivalents show total AI cognitive
            output relative to the human brain ({BRAIN.humanBrainWatts}W).
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

      {/* Summary Metrics */}
      {summaryMetrics && (
        <div style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="grid grid-4" style={{ marginBottom: 'var(--space-md)' }}>
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
                <span className="metric-label">Current Required GPU Base</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{formatNumber(summaryMetrics.future5yGpu)}</span>
                <span className="metric-label">5-Year Required GPU Base</span>
              </div>
            </div>
          </div>
          <div className="grid grid-4">
            <div className="card">
              <div className="metric">
                <span className="metric-value">{summaryMetrics.currentPowerGW.toFixed(1)} GW</span>
                <span className="metric-label">Current AI Power Draw</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{summaryMetrics.future5yPowerGW.toFixed(1)} GW</span>
                <span className="metric-label">5-Year AI Power Draw</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{formatNumber(summaryMetrics.currentBrainEquiv)}</span>
                <span className="metric-label">Current Human Brain Equiv.</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{formatNumber(summaryMetrics.future5yBrainEquiv)}</span>
                <span className="metric-label">5-Year Human Brain Equiv.</span>
              </div>
            </div>
          </div>
          <div className="grid grid-4" style={{ marginTop: 'var(--space-md)' }}>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{summaryMetrics.currentAisPerHuman?.toFixed(4)}</span>
                <span className="metric-label">Current AIs per Human</span>
              </div>
            </div>
            <div className="card">
              <div className="metric">
                <span className="metric-value">{summaryMetrics.future5yAisPerHuman?.toFixed(2)}</span>
                <span className="metric-label">5-Year AIs per Human</span>
              </div>
            </div>
            <div className="card" style={{ gridColumn: 'span 2' }}>
              <div className="metric">
                <span className="metric-value" style={{ fontSize: '0.875rem' }}>
                  1 AI per human = {formatNumber(WORLD_POPULATION)} brain-equivalents
                </span>
                <span className="metric-label">World Population Baseline (~8.2B)</span>
              </div>
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

        {/* Human Brain Equivalents */}
        <div className="chart-container">
          <div className="chart-header">
            <h3 className="chart-title">Human Brain Power Equivalents</h3>
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
                dataKey="brainEquivalents"
                stroke="#f59e0b"
                fill="#f59e0b"
                fillOpacity={0.3}
                name="Brain Equivalents"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* AIs per Human */}
        <div className="chart-container">
          <div className="chart-header">
            <h3 className="chart-title">AIs per Human (brain-equiv / 8.2B)</h3>
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
                tickFormatter={(v) => v < 0.01 ? v.toExponential(1) : v.toFixed(2)}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="aisPerHuman"
                stroke="#ef4444"
                fill="#ef4444"
                fillOpacity={0.3}
                name="AIs per Human"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* GPU Demand */}
        <div className="chart-container">
          <div className="chart-header">
            <h3 className="chart-title">Required GPU Base (units)</h3>
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
                name="Required GPU Base"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Total Power Draw */}
        <div className="chart-container">
          <div className="chart-header">
            <h3 className="chart-title">Total AI Power Draw (GW)</h3>
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
                tickFormatter={(v) => v.toFixed(1)}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="totalPowerGW"
                stroke="#10b981"
                fill="#10b981"
                fillOpacity={0.3}
                name="Power (GW)"
              />
            </AreaChart>
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
            <strong>Inference GPU Demand:</strong>
            <div style={{
              padding: 'var(--space-sm)',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-sm)',
              marginTop: 'var(--space-xs)'
            }}>
              GPUs = Tokens / (tok/s/GPU x seconds/month x EfficiencyGain)
            </div>
          </div>
          <div style={{ marginBottom: 'var(--space-md)' }}>
            <strong>Brain Power Equivalents:</strong>
            <div style={{
              padding: 'var(--space-sm)',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-sm)',
              marginTop: 'var(--space-xs)'
            }}>
              BrainEquiv = (InstalledGPUs x {WATTS_PER_GPU.toFixed(0)}W) / WattsPerBrainEquiv(t)
            </div>
          </div>
          <div style={{ marginBottom: 'var(--space-md)' }}>
            <strong>AIs per Human:</strong>
            <div style={{
              padding: 'var(--space-sm)',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-sm)',
              marginTop: 'var(--space-xs)'
            }}>
              AIsPerHuman = BrainEquiv / {formatNumber(WORLD_POPULATION)} (world pop.)
            </div>
          </div>
          <div>
            <strong>Where:</strong>
            <ul style={{ marginTop: 'var(--space-xs)', paddingLeft: 'var(--space-lg)', color: 'var(--text-secondary)' }}>
              <li>M<sub>t</sub> = (1-m)<sup>t/12</sup> -- Model efficiency (compute/token) decreases</li>
              <li>S<sub>t</sub> = (1+s)<sup>t/12</sup> -- Systems throughput increases</li>
              <li>H<sub>t</sub> = (1+h)<sup>t/12</sup> -- Hardware throughput increases</li>
              <li>Human brain = {BRAIN.humanBrainWatts}W, asymptote = {BRAIN.maxEfficiencyVsBrain}x brain efficiency</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DemandEngineTab;
