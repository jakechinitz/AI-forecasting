import React, { useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from 'recharts';
import NumInput, { Kpi } from './NumInput.jsx';
import { ASSUMPTION_SEGMENTS } from '../data/assumptions.js';
import { formatNumber } from '../engine/calculations.js';

/**
 * Spend by Input — dollars spent on each supply-chain input per year, after
 * every constraint in the model (demand, accelerator and component supply,
 * shells, power, construction labor, funding). Volume × unit price, where
 * volumes come from the simulation and prices from COST_ASSUMPTIONS.
 */

const CAPEX_GROUPS = [
  { id: 'compute', title: 'Compute & servers', color: '#1d9bf0', when: 'paid when chips are bought' },
  { id: 'network', title: 'Networking', color: '#7856ff', when: 'paid when chips are bought' },
  { id: 'facility', title: 'Facilities', color: '#00ba7c', when: 'paid during construction' },
  { id: 'power', title: 'Power', color: '#ff7a00', when: 'paid during construction' }
];

const usdB = (v) => {
  if (v == null || !Number.isFinite(v)) return '-';
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}T`;
  if (Math.abs(v) >= 100) return `$${v.toFixed(0)}B`;
  return `$${v.toFixed(1)}B`;
};
const pct = (v) => (v == null || !Number.isFinite(v) ? '' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`);
const growthOf = (arr) => arr.map((x, k) => (k === 0 || !(arr[k - 1] > 0) ? null : x / arr[k - 1] - 1));
const volumeUnit = (unit) => String(unit || '').replace(/^\$ per /, '');

function Cell({ value, growth, strong }) {
  return (
    <td>
      <div style={{ fontWeight: strong ? 700 : 400 }}>{usdB(value)}</div>
      <div className={`spend-growth ${growth < 0 ? 'neg' : ''}`}>{pct(growth)}</div>
    </td>
  );
}

function SpendTab({ results, costs, onCostChange, onResetCosts, build, onBuildChange, onResetBuild, scenario }) {
  const [range, setRange] = useState('10');
  const [mode, setMode] = useState('spend');
  const [showEditors, setShowEditors] = useState(false);
  const spend = results?.spend;
  const annual = results?.annual || [];

  const allYears = spend?.years || [];
  const count = range === 'all' ? allYears.length : Math.min(Number(range), allYears.length);
  const years = allYears.slice(0, count);

  // Vendor margin & other = accelerator spend − supplier value inside it
  const vendorResidual = useMemo(() => {
    if (!spend) return [];
    const acc = spend.inputs.find((i) => i.id === 'accelerators');
    return allYears.map((_, y) => (acc?.spendB[y] || 0) - spend.totals.embedded.spendB[y]);
  }, [spend, allYears]);

  // Supplier value nested inside another input (e.g. lasers inside optics), grouped by that input
  const nestedGroups = useMemo(() => {
    if (!spend) return [];
    const parents = [...new Set(spend.inputs.filter((i) => i.group === 'embedded' && i.within).map((i) => i.within))];
    return parents.map((pid) => {
      const parent = spend.inputs.find((i) => i.id === pid);
      const items = spend.inputs.filter((i) => i.group === 'embedded' && i.within === pid);
      const residual = allYears.map((_, y) => (parent?.spendB[y] || 0) - items.reduce((a, i) => a + i.spendB[y], 0));
      return { id: pid, label: parent?.label || pid, items, residual };
    });
  }, [spend, allYears]);

  const chartData = useMemo(() => years.map((year, y) => {
    const row = { year, growth: spend.totals.capex.growth[y] == null ? null : spend.totals.capex.growth[y] * 100 };
    CAPEX_GROUPS.forEach((g) => { row[g.id] = spend.totals[g.id].spendB[y]; });
    return row;
  }), [spend, years]);

  if (!spend) return <div className="loading-state"><p>No spend results.</p></div>;

  const first = spend.totals.capex.spendB[0];
  const y5 = Math.min(4, allYears.length - 1);
  const cagr5 = first > 0 ? Math.pow(spend.totals.capex.spendB[y5] / first, 1 / y5) - 1 : null;
  const cum5 = spend.totals.capex.spendB.slice(0, 5).reduce((a, b) => a + b, 0);
  const chips0 = spend.totals.chips.spendB[0];

  const downloadCsv = () => {
    const esc = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [['Group', 'Input', 'Measure', 'Unit', ...allYears].map(esc).join(',')];
    spend.inputs.forEach((i) => {
      lines.push([i.group, i.label, 'Spend', '$B', ...i.spendB.map((v) => +v.toFixed(3))].map(esc).join(','));
      lines.push([i.group, i.label, 'Growth', '%', ...i.growth.map((v) => (v == null ? '' : +(v * 100).toFixed(2)))].map(esc).join(','));
      lines.push([i.group, i.label, 'Volume', volumeUnit(i.unit), ...i.volume.map((v) => +v.toPrecision(6))].map(esc).join(','));
      lines.push([i.group, i.label, 'Average price paid', i.unit, ...i.avgPrice.map((v) => (v == null ? '' : +v.toPrecision(6)))].map(esc).join(','));
    });
    Object.entries(spend.totals).forEach(([k, t]) => {
      lines.push(['total', k, 'Spend', '$B', ...t.spendB.map((v) => +v.toFixed(3))].map(esc).join(','));
      lines.push(['total', k, 'Growth', '%', ...t.growth.map((v) => (v == null ? '' : +(v * 100).toFixed(2)))].map(esc).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-spend-by-input-${scenario?.id || 'base'}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const tooltipStyle = { background: 'var(--bg-elevated)', border: '1px solid var(--bg-tertiary)', fontSize: 12 };
  const axis = { tick: { fontSize: 10, fill: 'var(--text-muted)' } };

  const inputRow = (i) => (
    <tr key={i.id}>
      <td className="sheet-label" title={i.source}>{i.label}</td>
      {mode === 'spend'
        ? years.map((_, y) => <Cell key={y} value={i.spendB[y]} growth={i.growth[y]} />)
        : years.map((_, y) => (
          <td key={y}>
            <div>{formatNumber(i.volume[y])} <span className="spend-unit">{volumeUnit(i.unit)}</span></div>
            <div className="spend-growth">{i.avgPrice[y] == null ? '' : `$${formatNumber(i.avgPrice[y], i.avgPrice[y] < 10 ? 2 : 1)}`}</div>
          </td>
        ))}
    </tr>
  );
  const totalRow = (label, total, strong = true) => (
    <tr className="sheet-bold">
      <td className="sheet-label">{label}</td>
      {years.map((_, y) => <Cell key={y} value={total.spendB[y]} growth={total.growth[y]} strong={strong} />)}
    </tr>
  );
  const sectionRow = (title, note) => (
    <tr className="sheet-section">
      <td className="sheet-label">{title}{note && <span className="spend-note"> · {note}</span>}</td>
      <td colSpan={years.length} />
    </tr>
  );
  const textRow = (label, values, f) => (
    <tr>
      <td className="sheet-label">{label}</td>
      {years.map((_, y) => <td key={y} className="sheet-text">{f(values[y])}</td>)}
    </tr>
  );

  const pipe = build?.pipeline || {};
  const proc = build?.procurement || {};
  const dr = build?.demandResponse || {};
  const onTime = pipe.onTimeShareSchedule || [];

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Spend by Input</h1>
          <p className="tab-description">
            Dollars spent on each supply-chain input per year, after every constraint in the model: demand, accelerator and
            component supply, shells, power, construction labor and funding. Spend = volume × unit price. Chips, servers and
            networking are paid when bought (including chips that wait for power); facilities and power are paid during
            construction. Global ex-China, nominal dollars. Scenario: {scenario?.name || 'Base Case'}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="sheet-toggle" role="group" aria-label="View">
            {[['spend', '$ and growth'], ['volume', 'Volumes & prices']].map(([v, label]) => (
              <button key={v} className={`btn btn-sm ${mode === v ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode(v)}>{label}</button>
            ))}
          </div>
          <div className="sheet-toggle" role="group" aria-label="Year range">
            {[['5', '5 yrs'], ['10', '10 yrs'], ['all', `All ${allYears.length}`]].map(([v, label]) => (
              <button key={v} className={`btn btn-sm ${range === v ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRange(v)}>{label}</button>
            ))}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={downloadCsv}>Download CSV</button>
        </div>
      </div>

      <div className="fin-kpis">
        <Kpi label={`AI capex ${allYears[0]}`} value={usdB(first)} sub={`${usdB(chips0)} chips & network · ${usdB(spend.totals.facilities.spendB[0])} facilities & power`} />
        <Kpi label={`Capex growth ${allYears[0]}–${allYears[y5]}`} value={cagr5 == null ? '-' : `${pct(cagr5)} a year`} sub={`${usdB(spend.totals.capex.spendB[y5])} in ${allYears[y5]}`} />
        <Kpi label={`Cumulative capex ${allYears[0]}–${allYears[4]}`} value={usdB(cum5)} />
        <Kpi label={`Operating spend ${allYears[0]}`} value={usdB(spend.totals.opex.spendB[0])} sub="Electricity and datacenter staff" />
      </div>

      <div className="chart-container" style={{ marginBottom: 'var(--space-lg)' }}>
        <div className="chart-header"><h3 className="chart-title">AI capex by group ($B) and total growth</h3></div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-tertiary)" />
            <XAxis dataKey="year" {...axis} />
            <YAxis yAxisId="usd" {...axis} tickFormatter={(v) => Math.round(v).toLocaleString()} />
            <YAxis yAxisId="g" orientation="right" {...axis} tickFormatter={(v) => `${Math.round(v)}%`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => (name === 'Total growth' ? `${(+v).toFixed(0)}%` : usdB(+v))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {CAPEX_GROUPS.map((g) => <Bar key={g.id} yAxisId="usd" dataKey={g.id} stackId="c" fill={g.color} name={g.title} />)}
            <Line yAxisId="g" type="monotone" dataKey="growth" stroke="#f4212e" strokeWidth={2} dot={{ r: 2 }} name="Total growth" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="sheet-wrap">
        <table className="sheet spend-sheet">
          <thead>
            <tr>
              <th className="sheet-label">{mode === 'spend' ? 'Input ($, y/y growth)' : 'Input (volume, average price paid)'}</th>
              {years.map((y) => <th key={y}>{y}</th>)}
            </tr>
          </thead>
          <tbody>
            {CAPEX_GROUPS.map((g) => (
              <React.Fragment key={g.id}>
                {sectionRow(g.title, g.when)}
                {spend.inputs.filter((i) => i.group === g.id).map(inputRow)}
                {mode === 'spend' && totalRow(`${g.title} total`, spend.totals[g.id], false)}
              </React.Fragment>
            ))}
            {mode === 'spend' && sectionRow('Totals')}
            {mode === 'spend' && totalRow('Chips, servers & networking', spend.totals.chips)}
            {mode === 'spend' && totalRow('Facilities & power', spend.totals.facilities)}
            {mode === 'spend' && totalRow('TOTAL AI CAPEX', spend.totals.capex)}

            {sectionRow('Supplier value inside the ex-HBM accelerator price', 'already counted above')}
            {spend.inputs.filter((i) => i.group === 'embedded' && !i.within).map(inputRow)}
            {mode === 'spend' && (
              <tr>
                <td className="sheet-label">Accelerator vendor margin & other (ex-HBM price less the items above)</td>
                {years.map((_, y) => <Cell key={y} value={vendorResidual[y]} growth={growthOf(vendorResidual)[y]} />)}
              </tr>
            )}

            {nestedGroups.map((g) => (
              <React.Fragment key={g.id}>
                {sectionRow(`Supplier value inside ${g.label.toLowerCase()}`, 'already counted above')}
                {g.items.map(inputRow)}
                {mode === 'spend' && (
                  <tr>
                    <td className="sheet-label">Makers' margin & other in {g.label.toLowerCase()} (price less the items above)</td>
                    {years.map((_, y) => <Cell key={y} value={g.residual[y]} growth={growthOf(g.residual)[y]} />)}
                  </tr>
                )}
              </React.Fragment>
            ))}

            {sectionRow('Operating spend', 'not capex')}
            {spend.inputs.filter((i) => i.group === 'opex').map(inputRow)}
            {mode === 'spend' && totalRow('Operating spend total', spend.totals.opex, false)}

            {sectionRow('What drove the spend')}
            {textRow('Chips bought (GW IT)', annual.map((r) => r.purchasedGW), (v) => (v == null ? '' : v.toFixed(1)))}
            {textRow('Energized (GW IT)', annual.map((r) => r.deployedGW), (v) => (v == null ? '' : v.toFixed(1)))}
            {textRow('Bought, not energized, year-end (GW)', annual.map((r) => r.strandedGWYearEnd), (v) => (v == null ? '' : v.toFixed(1)))}
            {textRow('Construction starts (GW IT)', annual.map((r) => r.startsGW), (v) => (v == null ? '' : v.toFixed(1)))}
            {textRow('Shell completions (GW IT)', annual.map((r) => r.completionsGW), (v) => (v == null ? '' : v.toFixed(1)))}
            {textRow('Fundable capex', annual.map((r) => r.fundableCapex), usdB)}
            {textRow('Energization limited by', annual.map((r) => r.bindingConstraint), (v) => String(v || '').replace(/^Components: /, ''))}
            {textRow('Chip buying limited by', annual.map((r) => r.procurementBinding), (v) => String(v || '').replace(/^Components: /, ''))}
            {textRow('Construction starts limited by', annual.map((r) => r.startsBinding), (v) => String(v || ''))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 'var(--space-lg)', display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowEditors((v) => !v)}>
          {showEditors ? 'Hide' : 'Edit'} unit prices and build assumptions
        </button>
        {showEditors && <button className="btn btn-secondary btn-sm" onClick={() => { onResetCosts(); onResetBuild(); }}>Reset to defaults</button>}
      </div>

      {showEditors && (
        <>
          <div className="card" style={{ marginTop: 'var(--space-md)' }}>
            <div className="card-header"><h3 className="card-title">Unit prices</h3></div>
            <p className="section-description">
              January 2026 price, then the annual change during each period (compounded monthly). Pass-through is the share of a
              node&apos;s scarcity price index that reaches the price paid. Hover an input name in the table above for its source.
            </p>
            <div className="fin-table-scroll">
              <table className="fin-table fin-table--paths">
                <thead>
                  <tr>
                    <th>Input</th><th>Unit</th><th>Jan 2026</th><th>Pass-through</th>
                    {ASSUMPTION_SEGMENTS.map((seg) => <th key={seg.key}>{seg.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(costs?.inputs || []).filter((i) => i.price != null).map((i) => (
                    <tr key={i.id}>
                      <td>{i.label}</td>
                      <td className="fin-muted">{i.unit}</td>
                      <td><NumInput value={i.price} kind="num" width={84} onChange={(v) => onCostChange(i.id, ['price'], v)} /></td>
                      <td><NumInput value={i.passThrough} kind="pct" width={54} onChange={(v) => onCostChange(i.id, ['passThrough'], v)} /></td>
                      {ASSUMPTION_SEGMENTS.map((seg) => (
                        <td key={seg.key}><NumInput value={i.change?.[seg.key] ?? 0} kind="pct" width={54} onChange={(v) => onCostChange(i.id, ['change', seg.key], v)} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-2" style={{ marginTop: 'var(--space-md)' }}>
            <div className="card">
              <div className="card-header"><h3 className="card-title">Construction pipeline</h3></div>
              <table className="fin-table">
                <tbody>
                  <tr><td>Construction time (months)</td><td><NumInput value={pipe.constructionMonths} kind="num" onChange={(v) => onBuildChange(['pipeline', 'constructionMonths'], v)} /></td></tr>
                  {onTime.map((step, k) => (
                    <tr key={k}>
                      <td>Share on time, schedules through {step.until}</td>
                      <td><NumInput value={step.share} kind="pct" onChange={(v) => onBuildChange(['pipeline', 'onTimeShareSchedule', k, 'share'], v)} /></td>
                    </tr>
                  ))}
                  <tr><td>Average slip for late projects (months)</td><td><NumInput value={pipe.slipMonthsMean} kind="num" onChange={(v) => onBuildChange(['pipeline', 'slipMonthsMean'], v)} /></td></tr>
                  <tr><td>Opening pipeline: scheduled in the first year (MW facility)</td><td><NumInput value={pipe.openingScheduledMW?.firstYear} kind="num" step={1000} width={84} onChange={(v) => onBuildChange(['pipeline', 'openingScheduledMW', 'firstYear'], v)} /></td></tr>
                  <tr><td>Opening pipeline: scheduled in the next half-year (MW)</td><td><NumInput value={pipe.openingScheduledMW?.nextHalfYear} kind="num" step={1000} width={84} onChange={(v) => onBuildChange(['pipeline', 'openingScheduledMW', 'nextHalfYear'], v)} /></td></tr>
                  <tr><td>Opening pipeline: already late (MW)</td><td><NumInput value={pipe.openingSlippedMW} kind="num" step={500} width={84} onChange={(v) => onBuildChange(['pipeline', 'openingSlippedMW'], v)} /></td></tr>
                  <tr><td>Permitting lag before starts (months)</td><td><NumInput value={pipe.permitLagMonths} kind="num" onChange={(v) => onBuildChange(['pipeline', 'permitLagMonths'], v)} /></td></tr>
                  <tr><td>Months to close the starts gap</td><td><NumInput value={pipe.startSmoothingMonths} kind="num" onChange={(v) => onBuildChange(['pipeline', 'startSmoothingMonths'], v)} /></td></tr>
                  <tr><td>Empty-shell slack builders accept (months of chip supply)</td><td><NumInput value={pipe.maxVacancyMonths} kind="num" onChange={(v) => onBuildChange(['pipeline', 'maxVacancyMonths'], v)} /></td></tr>
                  <tr><td>Budget growth builders plan on</td><td><NumInput value={pipe.plannedBudgetGrowth} kind="pct" onChange={(v) => onBuildChange(['pipeline', 'plannedBudgetGrowth'], v)} /></td></tr>
                  <tr><td>Starts already decided (MW/month, first months)</td><td><NumInput value={pipe.openingStartsMWPerMonth} kind="num" step={100} width={84} onChange={(v) => onBuildChange(['pipeline', 'openingStartsMWPerMonth'], v)} /></td></tr>
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="card-header"><h3 className="card-title">Chip buying and demand response</h3></div>
              <table className="fin-table">
                <tbody>
                  <tr><td>Buy ahead of scheduled energization (months)</td><td><NumInput value={proc.procurementLeadMonths} kind="num" onChange={(v) => onBuildChange(['procurement', 'procurementLeadMonths'], v)} /></td></tr>
                  <tr><td>Precautionary stock (months of expected use)</td><td><NumInput value={proc.hoardMonths} kind="num" step={0.5} onChange={(v) => onBuildChange(['procurement', 'hoardMonths'], v)} /></td></tr>
                  <tr><td>Months to work stock back to target</td><td><NumInput value={proc.inventoryAdjustMonths} kind="num" onChange={(v) => onBuildChange(['procurement', 'inventoryAdjustMonths'], v)} /></td></tr>
                  <tr><td>Chips bought but not energized at start (GW)</td><td><NumInput value={proc.openingStrandedGW} kind="num" step={0.5} onChange={(v) => onBuildChange(['procurement', 'openingStrandedGW'], v)} /></td></tr>
                  <tr><td>Price elasticity of token demand</td><td><NumInput value={dr.priceElasticity} kind="num" step={0.1} onChange={(v) => onBuildChange(['demandResponse', 'priceElasticity'], v)} /></td></tr>
                  <tr><td>Half-life of unserved demand (months)</td><td><NumInput value={dr.unservedHalfLifeMonths} kind="num" onChange={(v) => onBuildChange(['demandResponse', 'unservedHalfLifeMonths'], v)} /></td></tr>
                  <tr>
                    <td>
                      Capability feedback (0 = off)
                      <div className="fin-help">Above 0, a compute shortfall also slows demand growth</div>
                    </td>
                    <td><NumInput value={dr.capabilityFeedback} kind="num" step={0.1} onChange={(v) => onBuildChange(['demandResponse', 'capabilityFeedback'], v)} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default SpendTab;
