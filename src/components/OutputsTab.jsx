import React, { useMemo, useState } from 'react';

/**
 * Excel-style annual output sheet. Every number links to the simulation
 * (results.annual from the financing layer, which reads the physical engine).
 * Layout mirrors the Dashboard sheet of AI_Capex_Funding_Model.xlsx.
 */

const fmt = {
  gw: (v) => (v == null ? '' : v.toFixed(1)),
  usd: (v) => (v == null ? '' : Math.round(v).toLocaleString('en-US')),
  usd1: (v) => (v == null ? '' : v.toFixed(1)),
  usd2: (v) => (v == null ? '' : v.toFixed(2)),
  pct: (v) => (v == null || !Number.isFinite(v) ? '' : `${(v * 100).toFixed(0)}%`),
  pct1: (v) => (v == null || !Number.isFinite(v) ? '' : `${(v * 100).toFixed(1)}%`),
  x: (v) => (v == null || !Number.isFinite(v) ? '' : `${v.toFixed(2)}x`),
  num1: (v) => (v == null ? '' : v.toFixed(1)),
  num2: (v) => (v == null ? '' : v.toFixed(2)),
  yrs: (v) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(1)),
  text: (v) => (v == null ? '' : String(v)),
  flag: (v) => (v ? 'Yes' : 'No')
};

const growth = (rows, key) => rows.map((r, i) => (i === 0 || !rows[i - 1][key] ? null : r[key] / rows[i - 1][key] - 1));

function buildSheet(annual, tiers, tierMeta) {
  const col = (key) => annual.map((r) => r[key]);
  const tierCol = (id, key) => (tiers[id] || []).map((r) => r[key]);

  const sections = [
    {
      title: 'Demand and build',
      rows: [
        { label: 'Token demand growth (YoY)', unit: '%', values: growth(annual, 'tokenDemandIndex'), f: fmt.pct },
        { label: 'Training share of required fleet', unit: '%', values: col('trainingShare'), f: fmt.pct },
        { label: 'Required installed GW (year average)', unit: 'GW', values: col('requiredGW'), f: fmt.gw },
        { label: 'Required installed GW (year-end)', unit: 'GW', values: col('requiredGWYearEnd'), f: fmt.gw },
        { label: 'Installed GW, opening', unit: 'GW', values: col('openingGW'), f: fmt.gw },
        { label: 'GW built (energized)', unit: 'GW', values: col('deployedGW'), f: fmt.gw, bold: true },
        { label: '  of which replacing retirements', unit: 'GW', values: col('replacementGW'), f: fmt.gw },
        { label: '  of which net new', unit: 'GW', values: col('netNewGW'), f: fmt.gw },
        { label: 'GW retired', unit: 'GW', values: col('retiredGW'), f: fmt.gw },
        { label: 'Installed GW, year-end', unit: 'GW', values: col('installedGW'), f: fmt.gw, bold: true },
        { label: 'Unmet demand (required − installed)', unit: 'GW', values: col('unmetGW'), f: fmt.gw },
        { label: 'Scarcity ratio (unmet ÷ installed)', unit: 'x', values: col('scarcityRatio'), f: fmt.num2 },
        { label: 'GW lost to funding constraint', unit: 'GW', values: col('lostToFundingGW'), f: fmt.gw, highlight: true },
        { label: 'Binding constraint (most months)', unit: '', values: col('bindingConstraint'), f: fmt.text },
        { label: 'Build growth', unit: '%', values: col('buildGrowth'), f: fmt.pct }
      ]
    },
    {
      title: 'Unit economics per GW',
      rows: [
        { label: 'Frontier tokens/kWh (new vintage, mid-year)', unit: 'M tok/kWh', values: col('frontierTokPerKwhM'), f: fmt.num1 },
        { label: 'Blended fleet tokens/kWh (opening)', unit: 'M tok/kWh', values: col('openingFleetTokPerKwhM'), f: fmt.num1 },
        { label: 'Effective utilization', unit: '%', values: col('util'), f: fmt.pct },
        { label: 'Base blended price', unit: '$/M tok', values: col('basePrice'), f: fmt.usd2 },
        { label: 'Scarcity premium', unit: 'x', values: col('premium'), f: fmt.num2 },
        { label: 'Effective blended price', unit: '$/M tok', values: col('effPrice'), f: fmt.usd2 },
        { label: "'Jensen math' rev/GW (frontier, 95% util)", unit: '$B/GW', values: col('jensenRevPerGw'), f: fmt.usd1 },
        { label: 'Share of fleet output sold (demand cap)', unit: '%', values: col('servedFraction'), f: fmt.pct },
        { label: 'REALIZED revenue/GW', unit: '$B/GW', values: col('realizedRevPerGw'), f: fmt.usd2, bold: true },
        { label: 'Realized as % of Jensen math', unit: '%', values: col('realizedPctOfJensen'), f: fmt.pct },
        { label: 'Energy cost/GW', unit: '$B/GW', values: col('energyPerGw'), f: fmt.usd2 },
        { label: 'Variable cash costs/GW', unit: '$B/GW', values: col('variablePerGw'), f: fmt.usd2 },
        { label: 'Other cash opex/GW', unit: '$B/GW', values: col('otherOpexPerGw'), f: fmt.usd2 },
        { label: 'EBITDA/GW', unit: '$B/GW', values: col('ebitdaPerGw'), f: fmt.usd2 },
        { label: 'D&A/GW', unit: '$B/GW', values: col('daPerGw'), f: fmt.usd2 },
        { label: 'EBIT/GW', unit: '$B/GW', values: col('ebitPerGw'), f: fmt.usd2 },
        { label: 'OCF/GW', unit: '$B/GW', values: col('ocfPerGw'), f: fmt.usd2, bold: true },
        { label: 'Capex per GW (new build)', unit: '$B/GW', values: col('capexPerGw'), f: fmt.usd1 },
        { label: 'Payback on new GW', unit: 'years', values: col('paybackYears'), f: fmt.yrs },
        { label: 'Unlevered pre-tax ROIC', unit: '%', values: col('roic'), f: fmt.pct1 },
        { label: 'Self-fundable growth g* (OCF/GW ÷ capex/GW)', unit: '%', values: col('gStar'), f: fmt.pct1 },
        { label: 'AI compute revenue', unit: '$B', values: col('aiRevenue'), f: fmt.usd, bold: true },
        { label: 'AI EBITDA', unit: '$B', values: col('aiEbitda'), f: fmt.usd },
        { label: 'AI OCF', unit: '$B', values: col('aiOcf'), f: fmt.usd }
      ]
    },
    {
      title: 'Capex',
      rows: [
        { label: 'Capex timing factor (pre-spend)', unit: 'x', values: col('timingFactor'), f: fmt.num2 },
        { label: 'New-build capex', unit: '$B', values: col('newBuildCapex'), f: fmt.usd },
        { label: 'Replacement capex (compute share)', unit: '$B', values: col('replacementCapex'), f: fmt.usd },
        { label: 'TOTAL AI capex', unit: '$B', values: col('totalCapex'), f: fmt.usd, bold: true },
        { label: 'Capex growth', unit: '%', values: growth(annual, 'totalCapex'), f: fmt.pct },
        { label: 'Capex per GW energized in-year', unit: '$B/GW', values: col('capexPerGwEnergized'), f: fmt.usd1 }
      ]
    },
    {
      title: 'Funding (all tiers)',
      rows: [
        { label: 'Max fundable capex (start of year)', unit: '$B', values: col('fundableCapex'), f: fmt.usd },
        { label: 'Total OCF (legacy + AI − interest)', unit: '$B', values: col('totalOcf'), f: fmt.usd },
        { label: 'Shareholder returns', unit: '$B', values: col('shareholderReturns'), f: fmt.usd },
        { label: 'Cash interest', unit: '$B', values: col('interest'), f: fmt.usd },
        { label: 'Cash drawdown', unit: '$B', values: col('cashDrawdown'), f: fmt.usd },
        { label: 'Debt raised', unit: '$B', values: col('debtRaised'), f: fmt.usd, bold: true },
        { label: 'Equity raised', unit: '$B', values: col('equityRaised'), f: fmt.usd },
        { label: 'SHORTFALL (unfunded capex)', unit: '$B', values: col('shortfall'), f: fmt.usd, highlight: true },
        { label: 'Gross debt, year-end', unit: '$B', values: col('grossDebt'), f: fmt.usd },
        { label: 'Cash, year-end', unit: '$B', values: col('cash'), f: fmt.usd },
        { label: 'Debt raised as % of capex', unit: '%', values: col('debtShareOfCapex'), f: fmt.pct },
        { label: 'External + cash funding as % of capex', unit: '%', values: col('externalShareOfCapex'), f: fmt.pct },
        { label: 'Market debt absorption available', unit: '$B', values: col('debtCapacityTotal'), f: fmt.usd },
        { label: 'Share of market debt absorption used', unit: '%', values: col('shareOfMarketDebtUsed'), f: fmt.pct },
        { label: 'System self-funding (OCF − returns ≥ capex)', unit: '', values: col('selfFunding'), f: fmt.flag }
      ]
    },
    ...tierMeta.map((t) => ({
      title: `Tier ${t.id}: ${t.name}`,
      rows: [
        { label: 'Installed GW, year-end', unit: 'GW', values: tierCol(t.id, 'installedGW'), f: fmt.gw },
        { label: 'Capex', unit: '$B', values: tierCol(t.id, 'capex'), f: fmt.usd, bold: true },
        { label: 'Max fundable capex', unit: '$B', values: tierCol(t.id, 'maxFundable'), f: fmt.usd },
        { label: 'Funding coverage (fundable ÷ capex)', unit: 'x', values: tierCol(t.id, 'fundingCoverage'), f: fmt.x },
        { label: 'OCF (legacy + AI − interest)', unit: '$B', values: tierCol(t.id, 'ocf'), f: fmt.usd },
        { label: 'Debt raised', unit: '$B', values: tierCol(t.id, 'debtRaised'), f: fmt.usd },
        { label: 'Equity raised', unit: '$B', values: tierCol(t.id, 'equityRaised'), f: fmt.usd },
        { label: 'Shortfall', unit: '$B', values: tierCol(t.id, 'shortfall'), f: fmt.usd, highlight: true },
        { label: 'Gross debt / EBITDA', unit: 'x', values: tierCol(t.id, 'debtToEbitda'), f: fmt.x },
        { label: 'Funding governor', unit: '', values: tierCol(t.id, 'governor'), f: fmt.text },
        { label: 'Marginal dollar source', unit: '', values: tierCol(t.id, 'marginalSource'), f: fmt.text }
      ]
    }))
  ];
  return sections;
}

function toCsv(years, sections) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Section', 'Line item', 'Unit', ...years].map(esc).join(',')];
  sections.forEach((sec) => {
    sec.rows.forEach((row) => {
      const vals = row.values.map((v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? +v.toFixed(4) : '';
        if (typeof v === 'boolean') return v ? 1 : 0;
        return v ?? '';
      });
      lines.push([sec.title, row.label.trim(), row.unit, ...vals].map(esc).join(','));
    });
  });
  return lines.join('\n');
}

function OutputsTab({ results, scenario }) {
  const [range, setRange] = useState('10');
  const annual = results?.annual || [];
  const fin = results?.financing;

  const sections = useMemo(
    () => (fin ? buildSheet(annual, fin.tiers, fin.tierMeta) : []),
    [annual, fin]
  );

  if (!fin || !annual.length) {
    return <div className="loading-state"><p>No financing results.</p></div>;
  }

  const allYears = annual.map((r) => r.year);
  const count = range === 'all' ? allYears.length : Math.min(Number(range), allYears.length);
  const years = allYears.slice(0, count);

  const downloadCsv = () => {
    const csv = toCsv(allYears, sections);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-infrastructure-model-outputs-${(scenario?.id || 'base')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const sfy = fin.selfFundingYear || {};

  return (
    <div>
      <div className="tab-header">
        <div>
          <h1 className="tab-title">Model Outputs</h1>
          <p className="tab-description">
            Annual summary of the whole model in spreadsheet form: demand, build, unit economics, capex and funding.
            All figures are live from the current scenario ({scenario?.name || 'Base Case'}). GW are IT load; $ are nominal billions.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="sheet-toggle" role="group" aria-label="Year range">
            {[['7', '2026–32'], ['10', '10 yrs'], ['all', 'All 20']].map(([v, label]) => (
              <button
                key={v}
                className={`btn btn-sm ${range === v ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setRange(v)}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={downloadCsv}>Download CSV</button>
        </div>
      </div>

      <div className="sheet-summary">
        <div><span className="sheet-summary-label">Funding constraint</span><span>{fin.applyConstraint ? 'Binds the build' : 'Check only'}</span></div>
        <div><span className="sheet-summary-label">System self-funding year</span><span>{sfy.system || 'Beyond horizon'}</span></div>
        {fin.tierMeta.map((t) => (
          <div key={t.id}><span className="sheet-summary-label">Tier {t.id} self-funding</span><span>{sfy[t.id] || 'Beyond horizon'}</span></div>
        ))}
      </div>

      <div className="sheet-wrap">
        <table className="sheet">
          <thead>
            <tr>
              <th className="sheet-label">Line item</th>
              <th className="sheet-unit">Unit</th>
              {years.map((y) => <th key={y}>{y}</th>)}
            </tr>
          </thead>
          <tbody>
            {sections.map((sec) => (
              <React.Fragment key={sec.title}>
                <tr className="sheet-section">
                  <td className="sheet-label" colSpan={2}>{sec.title}</td>
                  <td colSpan={years.length} />
                </tr>
                {sec.rows.map((row) => (
                  <tr key={sec.title + row.label} className={`${row.bold ? 'sheet-bold' : ''} ${row.highlight ? 'sheet-highlight' : ''}`}>
                    <td className="sheet-label">{row.label}</td>
                    <td className="sheet-unit">{row.unit}</td>
                    {years.map((y, i) => {
                      const v = row.values[i];
                      const text = row.f(v);
                      const neg = typeof v === 'number' && v < -1e-9;
                      const isText = row.f === fmt.text || row.f === fmt.flag;
                      return (
                        <td key={y} className={`${isText ? 'sheet-text' : ''} ${neg ? 'sheet-neg' : ''}`}>
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="section-description" style={{ marginTop: 'var(--space-md)' }}>
        Conventions follow the Excel funding model: AI revenue is earned on the opening fleet, the scarcity premium uses the prior
        year&apos;s unmet-demand ratio, and fundable capex depends only on opening balances. Two fixes: revenue is capped at demand,
        and any shortfall is charged to cash rather than disappearing.
      </p>
    </div>
  );
}

export default OutputsTab;
