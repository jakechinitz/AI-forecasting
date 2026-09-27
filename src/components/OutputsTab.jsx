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

// Year-average of a monthly series, aligned to the annual rows
const yearAverages = (series, annual) => annual.map((_, i) => {
  const vals = (series || []).slice(i * 12, i * 12 + 12).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
});

// Gates in reading order: demand, capital, chips, then components by name
const GATE_ORDER = ['Plan (demand)', 'Funding', 'GPU supply (fab + inventory)'];

const SPEND_GROUP_TITLES = {
  compute: 'Compute & servers', network: 'Networking', facility: 'Facilities', power: 'Power',
  embedded: 'Supplier value inside accelerator prices (not added to totals)', opex: 'Operating spend (not capex)'
};

function buildSheet(annual, tiers, tierMeta, gates, spend) {
  const col = (key) => annual.map((r) => r[key]);
  const tierCol = (id, key) => (tiers[id] || []).map((r) => r[key]);
  const gateNames = Object.keys(gates || {}).sort((a, b) => {
    const ia = GATE_ORDER.indexOf(a); const ib = GATE_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });

  const sections = [
    {
      title: 'Demand and build',
      rows: [
        { label: 'Token demand growth (YoY)', unit: '%', values: growth(annual, 'tokenDemandIndex'), f: fmt.pct },
        { label: 'Training share of required fleet', unit: '%', values: col('trainingShare'), f: fmt.pct },
        { label: 'Required installed GW (year average)', unit: 'GW', values: col('requiredGW'), f: fmt.gw },
        { label: 'Required installed GW (year-end)', unit: 'GW', values: col('requiredGWYearEnd'), f: fmt.gw },
        { label: 'Installed GW, opening', unit: 'GW', values: col('openingGW'), f: fmt.gw },
        { label: 'Chips bought', unit: 'GW', values: col('purchasedGW'), f: fmt.gw },
        { label: 'GW built (energized)', unit: 'GW', values: col('deployedGW'), f: fmt.gw, bold: true },
        { label: '  of which replacing retirements', unit: 'GW', values: col('replacementGW'), f: fmt.gw },
        { label: '  of which net new', unit: 'GW', values: col('netNewGW'), f: fmt.gw },
        { label: 'GW retired', unit: 'GW', values: col('retiredGW'), f: fmt.gw },
        { label: 'Installed GW, year-end', unit: 'GW', values: col('installedGW'), f: fmt.gw, bold: true },
        { label: 'Unmet demand (required − installed)', unit: 'GW', values: col('unmetGW'), f: fmt.gw },
        { label: 'Scarcity ratio (unmet ÷ installed)', unit: 'x', values: col('scarcityRatio'), f: fmt.num2 },
        { label: 'Share of demand served (year average)', unit: '%', values: col('servedFraction'), f: fmt.pct },
        { label: 'Chip orders deferred by funding', unit: 'GW', values: col('deferredByFundingGW'), f: fmt.gw, highlight: true },
        { label: 'Energization limited by (most months)', unit: '', values: col('bindingConstraint'), f: fmt.text },
        { label: 'Chip buying limited by (most months)', unit: '', values: col('procurementBinding'), f: fmt.text },
        { label: 'Construction starts limited by (most months)', unit: '', values: col('startsBinding'), f: fmt.text },
        { label: 'Build growth', unit: '%', values: col('buildGrowth'), f: fmt.pct }
      ]
    },
    {
      title: 'Construction pipeline and stranded chips',
      rows: [
        { label: 'Construction starts', unit: 'GW IT', values: col('startsGW'), f: fmt.gw },
        { label: 'Shell completions', unit: 'GW IT', values: col('completionsGW'), f: fmt.gw },
        { label: 'Under construction, year-end', unit: 'GW IT', values: col('underConstructionGWYearEnd'), f: fmt.gw },
        { label: 'Shells complete but empty, year-end', unit: 'GW IT', values: col('readyShellsGWYearEnd'), f: fmt.gw },
        { label: 'Chips bought but not energized, year-end', unit: 'GW IT', values: col('strandedGWYearEnd'), f: fmt.gw, highlight: true },
        { label: 'Stranded chips as share of the year’s purchases', unit: '%', values: annual.map((r) => (r.purchasedGW > 0 ? r.strandedGWYearEnd / r.purchasedGW : null)), f: fmt.pct }
      ]
    },
    {
      title: 'Build capacity by gate (GW/yr each could support, year average)',
      rows: gateNames.map((name) => ({
        label: name, unit: 'GW/yr', values: yearAverages(gates[name], annual), f: fmt.gw,
        bold: name === 'Funding'
      }))
    },
    {
      title: 'Energy and edge AI',
      rows: [
        { label: 'Share of inference tokens served at the edge (phones, PCs, Macs, self-hosted)', unit: '%', values: col('edgeTokenShare'), f: fmt.pct1 },
        { label: 'Installed edge compute, datacenter-equivalent', unit: 'GW', values: col('edgeEquivGW'), f: fmt.gw },
        { label: 'Datacenter AI power (average draw, incl. cooling)', unit: 'GW', values: col('dcPowerGW'), f: fmt.gw },
        { label: 'Edge AI power (average draw)', unit: 'GW', values: col('edgePowerGW'), f: fmt.gw },
        { label: 'Total AI power (average draw)', unit: 'GW', values: col('totalAiPowerGW'), f: fmt.gw, bold: true },
        { label: 'Total AI energy', unit: 'TWh/yr', values: annual.map((r) => (r.totalAiPowerGW == null ? null : r.totalAiPowerGW * 8.76)), f: fmt.usd }
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
        { label: 'Capex per GW IT, new build (bottom-up, start of year)', unit: '$B/GW', values: col('capexPerGw'), f: fmt.usd1 },
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
        { label: 'Chips, servers & networking (paid when bought)', unit: '$B', values: col('computeCapex'), f: fmt.usd },
        { label: 'Facilities & power (paid during construction)', unit: '$B', values: col('facilityCapex'), f: fmt.usd },
        { label: 'TOTAL AI capex', unit: '$B', values: col('totalCapex'), f: fmt.usd, bold: true },
        { label: 'Capex growth', unit: '%', values: growth(annual, 'totalCapex'), f: fmt.pct },
        { label: 'Capex per GW deployed (new + replacement)', unit: '$B/GW', values: col('capexPerGwDeployed'), f: fmt.usd1 }
      ]
    },
    ...(spend ? [{
      title: 'Spend by input ($B; see the Spend by Input tab for growth, volumes and prices)',
      rows: [
        ...['compute', 'network', 'facility', 'power'].flatMap((g) => [
          ...spend.inputs.filter((i) => i.group === g).map((i) => ({ label: `${SPEND_GROUP_TITLES[g]}: ${i.label}`, unit: '$B', values: i.spendB, f: fmt.usd }))
        ]),
        { label: 'TOTAL CAPEX (all inputs)', unit: '$B', values: spend.totals.capex.spendB, f: fmt.usd, bold: true },
        { label: 'Capex growth', unit: '%', values: spend.totals.capex.growth, f: fmt.pct },
        ...spend.inputs.filter((i) => i.group === 'embedded').map((i) => ({ label: `Inside accelerators: ${i.label}`, unit: '$B', values: i.spendB, f: fmt.usd })),
        ...spend.inputs.filter((i) => i.group === 'opex').map((i) => ({ label: `Opex: ${i.label}`, unit: '$B', values: i.spendB, f: fmt.usd }))
      ]
    }] : []),
    {
      title: 'Funding (all tiers)',
      rows: [
        { label: 'Max fundable capex (start of year)', unit: '$B', values: col('fundableCapex'), f: fmt.usd },
        { label: 'Capex above fundable (gate off only)', unit: '$B', values: col('capexAboveFundable'), f: fmt.usd },
        { label: 'Total OCF (legacy + AI − interest)', unit: '$B', values: col('totalOcf'), f: fmt.usd },
        { label: 'Shareholder returns', unit: '$B', values: col('shareholderReturns'), f: fmt.usd },
        { label: 'Cash interest', unit: '$B', values: col('interest'), f: fmt.usd },
        { label: 'Cash drawdown', unit: '$B', values: col('cashDrawdown'), f: fmt.usd },
        { label: 'Debt raised', unit: '$B', values: col('debtRaised'), f: fmt.usd, bold: true },
        { label: 'Equity raised', unit: '$B', values: col('equityRaised'), f: fmt.usd },
        { label: 'UNFUNDED CAPEX (charged to cash)', unit: '$B', values: col('unfundedCapex'), f: fmt.usd, highlight: true },
        { label: 'Operating cash deficit (OCF below returns + interest)', unit: '$B', values: col('operatingDeficit'), f: fmt.usd },
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
        { label: 'Unfunded capex', unit: '$B', values: tierCol(t.id, 'unfundedCapex'), f: fmt.usd, highlight: true },
        { label: 'Operating cash deficit', unit: '$B', values: tierCol(t.id, 'operatingDeficit'), f: fmt.usd },
        { label: 'Gross debt, year-end', unit: '$B', values: tierCol(t.id, 'grossDebt'), f: fmt.usd },
        { label: 'Cash, year-end', unit: '$B', values: tierCol(t.id, 'cash'), f: fmt.usd },
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
      const pct = row.unit === '%';
      const vals = row.values.map((v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? +(pct ? v * 100 : v).toFixed(4) : '';
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
    () => (fin ? buildSheet(annual, fin.tiers, fin.tierMeta, results?.gates, results?.spend) : []),
    [annual, fin, results]
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
            {[['7', `${allYears[0]}–${allYears[0] + 6}`], ['10', '10 yrs'], ['all', `All ${allYears.length}`]].map(([v, label]) => (
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
        and any shortfall is charged to cash (negative cash pays interest) rather than disappearing. Unfunded capex stays at zero
        while the funding gate is on; an operating deficit is cash owed beyond operating cash flow even with no capex.
        Build deferred by funding sums each month&apos;s demanded, physically possible but unfunded deployments; that demand carries
        into later months, so it measures deferral, not permanent loss. In the CSV, % rows are in percent.
      </p>
    </div>
  );
}

export default OutputsTab;
