import React, { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine
} from 'recharts';

/**
 * Capital & Funding tab — inputs and outputs of the financing layer ported
 * from AI_Capex_Funding_Model.xlsx. Edits flow into the simulation: fundable
 * capex caps monthly deployments when the funding constraint is on.
 */

const SCALAR_FIELDS = [
  { key: 'preSpendFraction', label: 'Pre-spend fraction (next year’s build paid this year)', kind: 'pct' },
  { key: 'computeShareOfCapex', label: 'Compute & networking share of $/GW', kind: 'pct', help: 'Also the cost of replacing retired compute (shell and power are reused)' },
  { key: 'computeLifeYears', label: 'Compute life (years)', kind: 'num', help: 'Drives depreciation AND when accelerators retire in the physical model' },
  { key: 'facilityLifeYears', label: 'Facility & power life (years)', kind: 'num' },
  { key: 'cashTaxRate', label: 'Cash tax rate on AI EBIT', kind: 'pct' },
  { key: 'variableCostPctOfRevenue', label: 'Variable cash costs (% of AI revenue)', kind: 'pct', help: 'Lab margin / pass-through, model R&D, SG&A' },
  { key: 'otherOpexPerGwYr', label: 'Other cash opex per GW-yr ($B)', kind: 'num' },
  { key: 'electricityPricePerKwh', label: 'Electricity price ($/kWh)', kind: 'num', step: 0.005 },
  { key: 'idlePowerShare', label: 'Power draw at zero utilization (% of peak)', kind: 'pct' },
  { key: 'scarcityElasticity', label: 'Scarcity price elasticity', kind: 'num', step: 0.05, help: 'Premium per unit of prior-year unmet-demand ratio' },
  { key: 'maxScarcityPremium', label: 'Max scarcity premium (x base price)', kind: 'num', step: 0.1 },
  { key: 'otherRevenuePerGwYr', label: 'Non-token revenue per GW-yr ($B)', kind: 'num' }
];

const TIER_FIELDS = [
  { key: 'share', label: 'Base share of build', kind: 'pct' },
  { key: 'legacyOcf', label: 'Legacy (ex-AI) OCF, base year ($B)', kind: 'num' },
  { key: 'legacyOcfGrowth', label: 'Legacy OCF growth', kind: 'pct' },
  { key: 'legacyEbitda', label: 'Legacy EBITDA, base year ($B)', kind: 'num' },
  { key: 'legacyEbitdaGrowth', label: 'Legacy EBITDA growth', kind: 'pct' },
  { key: 'shareholderReturns', label: 'Shareholder returns ($B/yr)', kind: 'num' },
  { key: 'cash', label: 'Cash & investments, opening ($B)', kind: 'num' },
  { key: 'minCash', label: 'Minimum operating cash ($B)', kind: 'num' },
  { key: 'debt', label: 'Gross debt, opening ($B)', kind: 'num' },
  { key: 'costOfDebt', label: 'Pre-tax cost of debt', kind: 'pct', step: 0.5 },
  { key: 'maxDebtToEbitda', label: 'Gross debt / EBITDA ceiling (x)', kind: 'num', step: 0.25 },
  { key: 'maxExternalShareOfCapex', label: 'Max external + cash share of capex', kind: 'pct', help: 'Behavioral cap: management slows the build first' }
];

const PATH_FIELDS = [
  { key: 'priceChange', label: 'Blended $/M token price change', kind: 'pct' },
  { key: 'utilization', label: 'Effective utilization', kind: 'pct' },
  { key: 'capexPerGw', label: 'All-in capex per GW ($B)', kind: 'num' }
];

// Numeric cell that keeps its own text while typing and commits on blur or
// Enter, so partial entries ("-", "0.") never reach the model. Escape reverts.
function NumInput({ value, kind, step, onChange, width = 64 }) {
  const format = (v) => (v == null || Number.isNaN(+v)
    ? ''
    : String(kind === 'pct' ? +(v * 100).toFixed(2) : +(+v).toFixed(4)));
  const [text, setText] = useState(format(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(format(value)); }, [value, kind, editing]);
  const commit = () => {
    setEditing(false);
    const n = parseFloat(text);
    if (Number.isFinite(n)) {
      const next = kind === 'pct' ? n / 100 : n;
      if (next !== value) onChange(next);
    } else {
      setText(format(value));
    }
  };
  return (
    <input
      type="number"
      className="fin-input"
      style={{ width }}
      step={step ?? 1}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setText(format(value)); setEditing(false); e.currentTarget.blur(); }
      }}
    />
  );
}

const money = (v) => (v == null ? '-' : `$${Math.round(v).toLocaleString('en-US')}B`);

function Kpi({ label, value, sub }) {
  return (
    <div className="fin-kpi">
      <div className="fin-kpi-label">{label}</div>
      <div className="fin-kpi-value">{value}</div>
      {sub && <div className="fin-kpi-sub">{sub}</div>}
    </div>
  );
}

function FundingTab({ results, financing, onFinancingChange, onResetFinancing }) {
  const [chartYears, setChartYears] = useState(10);
  const fin = results?.financing;
  const annual = results?.annual || [];

  const view = annual.slice(0, chartYears);

  const fundingMix = useMemo(() => view.map((r) => {
    const external = r.cashDrawdown + r.debtRaised + r.equityRaised + r.unfundedCapex;
    return {
      year: r.year,
      internal: Math.max(0, r.totalCapex - external),
      cash: r.cashDrawdown,
      debt: r.debtRaised,
      equity: r.equityRaised,
      unfunded: r.unfundedCapex,
      capex: r.totalCapex,
      fundable: r.fundableCapex
    };
  }), [view]);

  const buildData = useMemo(() => view.map((r) => ({
    year: r.year,
    built: r.deployedGW,
    deferred: r.deferredByFundingGW,
    unmet: r.unmetGW
  })), [view]);

  const leverage = useMemo(() => view.map((r, i) => {
    const row = { year: r.year };
    (fin?.tierMeta || []).forEach((t) => { row[t.id] = fin.tiers[t.id]?.[i]?.debtToEbitda ?? null; });
    return row;
  }), [view, fin]);

  const perGw = useMemo(() => view.map((r) => ({
    year: r.year,
    revenue: r.realizedRevPerGw,
    ebitda: r.ebitdaPerGw,
    ocf: r.ocfPerGw,
    gStar: r.gStar * 100,
    buildGrowth: r.buildGrowth == null ? null : r.buildGrowth * 100
  })), [view]);

  if (!fin) return <div className="loading-state"><p>No financing results.</p></div>;

  const deferredTotal = view.reduce((s, r) => s + r.deferredByFundingGW, 0);
  const peak = view.reduce((best, r) => (r.totalCapex > (best?.totalCapex ?? -1) ? r : best), null);
  const debtTotal = view.reduce((s, r) => s + r.debtRaised, 0);
  const unfundedTotal = view.reduce((s, r) => s + r.unfundedCapex, 0);
  const opDeficitTotal = view.reduce((s, r) => s + r.operatingDeficit, 0);
  const firstYear = annual[0]?.year;
  const bindingYears = view.filter((r) => r.bindingConstraint === 'Funding').map((r) => r.year);

  const tierShareSum = financing.tiers.reduce((s, t) => s + (t.share || 0), 0);
  const badChannels = financing.channels.filter((c) => Math.abs((c.alloc || []).reduce((s, v) => s + v, 0) - 1) > 1e-6);
  const pathYears = Object.keys(financing.paths.capexPerGw).map(Number).sort((a, b) => a - b);

  const tooltipStyle = { background: 'var(--bg-elevated)', border: '1px solid var(--bg-tertiary)', fontSize: 12 };
  const axis = { tick: { fontSize: 10, fill: 'var(--text-muted)' } };

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Capital &amp; Funding</h1>
          <p className="tab-description">
            Who pays for the build. Each year, three builder tiers fund capex from operating cash flow, cash, debt and equity,
            limited by leverage ceilings, capital-markets capacity and how much outside money management will use.
            When the constraint is on, anything the tiers cannot fund is not built.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="fin-toggle">
            <input
              type="checkbox"
              checked={financing.applyFundingConstraint}
              onChange={(e) => onFinancingChange(['applyFundingConstraint'], e.target.checked)}
            />
            Funding constrains the build
          </label>
          <button className="btn btn-secondary btn-sm" onClick={onResetFinancing}>Reset to defaults</button>
        </div>
      </div>

      <div className="fin-kpis">
        <Kpi label="System self-funding year" value={fin.selfFundingYear.system || 'Beyond horizon'} sub="OCF − returns ≥ capex" />
        <Kpi label={`Build deferred by funding (${view[0]?.year}–${view[view.length - 1]?.year})`} value={`${deferredTotal.toFixed(1)} GW`} sub={bindingYears.length ? `Funding binds: ${bindingYears[0]}–${bindingYears[bindingYears.length - 1]}` : 'Funding never binds'} />
        <Kpi label="Peak annual AI capex" value={money(peak?.totalCapex)} sub={peak ? `in ${peak.year}` : ''} />
        <Kpi label="Debt raised (cumulative)" value={money(debtTotal)} sub={`${view[0]?.year}–${view[view.length - 1]?.year}`} />
        <Kpi label="Unfunded capex" value={money(unfundedTotal)} sub={`${financing.applyFundingConstraint ? 'Gate on: stays 0' : 'Gate off: charged to cash'}${opDeficitTotal > 0.5 ? ` · operating deficit ${money(opDeficitTotal)}` : ''}`} />
      </div>

      <div className="sheet-toggle" style={{ margin: 'var(--space-md) 0' }}>
        {[7, 10, 20].map((n) => (
          <button key={n} className={`btn btn-sm ${chartYears === n ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setChartYears(n)}>
            {n === 7 && firstYear ? `${firstYear}–${firstYear + 6}` : `${n} yrs`}
          </button>
        ))}
      </div>

      <div className="grid grid-2">
        <div className="chart-container">
          <div className="chart-header"><h3 className="chart-title">How AI capex is funded ($B)</h3></div>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={fundingMix}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
              <XAxis dataKey="year" {...axis} />
              <YAxis {...axis} tickFormatter={(v) => Math.round(v).toLocaleString()} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="internal" stackId="f" fill="#00ba7c" name="Internal cash flow" />
              <Bar dataKey="cash" stackId="f" fill="#14b8a6" name="Cash drawdown" />
              <Bar dataKey="debt" stackId="f" fill="#1d9bf0" name="Debt" />
              <Bar dataKey="equity" stackId="f" fill="#7856ff" name="Equity" />
              <Bar dataKey="unfunded" stackId="f" fill="#f4212e" name="Unfunded capex" />
              <Line type="monotone" dataKey="fundable" stroke="#65676b" strokeDasharray="4 4" dot={false} name="Max fundable" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-container">
          <div className="chart-header"><h3 className="chart-title">GW built vs deferred by funding</h3></div>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={buildData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
              <XAxis dataKey="year" {...axis} />
              <YAxis {...axis} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${(+v).toFixed(1)} GW`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="built" stackId="g" fill="#1d9bf0" name="GW built" />
              <Bar dataKey="deferred" stackId="g" fill="#f4212e" name="Deferred by funding (sum of monthly)" />
              <Line type="monotone" dataKey="unmet" stroke="#ff7a00" dot={false} strokeWidth={2} name="Unmet demand, year-end" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-container">
          <div className="chart-header"><h3 className="chart-title">Gross debt / EBITDA by tier</h3></div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={leverage}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
              <XAxis dataKey="year" {...axis} />
              <YAxis {...axis} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${(+v).toFixed(2)}x`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {fin.tierMeta.map((t, i) => (
                <Line key={t.id} type="monotone" dataKey={t.id} stroke={['#1d9bf0', '#ff7a00', '#7856ff'][i]} strokeWidth={2} dot={false} name={`Tier ${t.id}: ${t.name}`} />
              ))}
              {fin.tierMeta.map((t, i) => (
                <ReferenceLine key={`c${t.id}`} y={t.maxDebtToEbitda} stroke={['#1d9bf0', '#ff7a00', '#7856ff'][i]} strokeDasharray="3 3" strokeOpacity={0.5} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-container">
          <div className="chart-header"><h3 className="chart-title">Economics per GW ($B/GW-yr)</h3></div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={perGw}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
              <XAxis dataKey="year" {...axis} />
              <YAxis {...axis} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => (name.includes('%') ? `${(+v).toFixed(1)}%` : `$${(+v).toFixed(2)}B`)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="revenue" stroke="#1d9bf0" strokeWidth={2} dot={false} name="Realized revenue/GW" />
              <Line type="monotone" dataKey="ebitda" stroke="#00ba7c" strokeWidth={2} dot={false} name="EBITDA/GW" />
              <Line type="monotone" dataKey="ocf" stroke="#7856ff" strokeWidth={2} dot={false} name="OCF/GW" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <h2 className="section-title" style={{ marginTop: 'var(--space-xl)' }}>Inputs</h2>
      <p className="section-description">
        Ported from AI_Capex_Funding_Model.xlsx (Sept 2026 anchors). Physical quantities, fleet efficiency by vintage, training
        share and the scarcity ratio come from the simulation, not from these inputs.
      </p>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-header"><h3 className="card-title">Economics</h3></div>
          <table className="fin-table">
            <tbody>
              <tr>
                <td>Blended price, base year ($/M tokens)</td>
                <td><NumInput value={financing.baseYear.blendedPricePerMTokens} kind="num" step={0.05} onChange={(v) => onFinancingChange(['baseYear', 'blendedPricePerMTokens'], v)} /></td>
              </tr>
              {SCALAR_FIELDS.map((f) => (
                <tr key={f.key}>
                  <td>
                    {f.label}
                    {f.help && <div className="fin-help">{f.help}</div>}
                  </td>
                  <td><NumInput value={financing.scalars[f.key]} kind={f.kind} step={f.step} onChange={(v) => onFinancingChange(['scalars', f.key], v)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-header"><h3 className="card-title">Builder tiers</h3></div>
          {Math.abs(tierShareSum - 1) > 1e-6 && (
            <p className="fin-warning">Tier shares sum to {(tierShareSum * 100).toFixed(1)}%. They should sum to 100%.</p>
          )}
          <div className="fin-table-scroll">
            <table className="fin-table">
              <thead>
                <tr>
                  <th />
                  {financing.tiers.map((t) => (
                    <th key={t.id} title={t.note}>Tier {t.id}<div className="fin-help">{t.name}</div></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TIER_FIELDS.map((f) => (
                  <tr key={f.key}>
                    <td>
                      {f.label}
                      {f.help && <div className="fin-help">{f.help}</div>}
                    </td>
                    {financing.tiers.map((t, i) => (
                      <td key={t.id}>
                        <NumInput value={t[f.key]} kind={f.kind} step={f.step} onChange={(v) => onFinancingChange(['tiers', i, f.key], v)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header"><h3 className="card-title">Capital-markets absorption (AI-available, $B/yr)</h3></div>
        <p className="section-description">
          Capacity is for {pathYears[0]} and compounds at the growth rate. Allocation splits each channel across tiers A/B/C.
          Active scenario multipliers: debt {((fin.marketCapacityMultiplier?.debt ?? 1) * 100).toFixed(0)}%,
          equity {((fin.marketCapacityMultiplier?.equity ?? 1) * 100).toFixed(0)}%.
        </p>
        {badChannels.length > 0 && (
          <p className="fin-warning">Allocation does not sum to 100% for: {badChannels.map((c) => c.name).join(', ')}.</p>
        )}
        <div className="fin-table-scroll">
          <table className="fin-table">
            <thead>
              <tr>
                <th>Channel</th><th>Type</th><th>Capacity</th><th>Growth</th><th>Tier A</th><th>Tier B</th><th>Tier C</th><th>Note</th>
              </tr>
            </thead>
            <tbody>
              {financing.channels.map((c, i) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="fin-muted">{c.type}</td>
                  <td><NumInput value={c.capacity} kind="num" step={5} onChange={(v) => onFinancingChange(['channels', i, 'capacity'], v)} /></td>
                  <td><NumInput value={c.growth} kind="pct" onChange={(v) => onFinancingChange(['channels', i, 'growth'], v)} /></td>
                  {[0, 1, 2].map((k) => (
                    <td key={k}>
                      <NumInput value={c.alloc?.[k] ?? 0} kind="pct" width={54} onChange={(v) => {
                        const alloc = [...(c.alloc || [0, 0, 0])];
                        alloc[k] = v;
                        onFinancingChange(['channels', i, 'alloc'], alloc);
                      }} />
                    </td>
                  ))}
                  <td className="fin-help">{c.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="card-header"><h3 className="card-title">Annual paths</h3></div>
        <p className="section-description">
          2026–2032 match the Excel. Later years extend it: price declines taper to −10%/yr, utilization rises to a 70% cap,
          and capex per GW rises $1B/yr.
        </p>
        <div className="fin-table-scroll">
          <table className="fin-table fin-table--paths">
            <thead>
              <tr>
                <th>Path</th>
                {pathYears.map((y) => <th key={y}>{y}</th>)}
              </tr>
            </thead>
            <tbody>
              {PATH_FIELDS.map((f) => (
                <tr key={f.key}>
                  <td>{f.label}</td>
                  {pathYears.map((y) => (
                    <td key={y}>
                      <NumInput value={financing.paths[f.key]?.[y]} kind={f.kind} width={54} onChange={(v) => onFinancingChange(['paths', f.key, String(y)], v)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default FundingTab;
