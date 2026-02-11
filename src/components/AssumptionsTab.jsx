import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { ASSUMPTION_SEGMENTS, GLOBAL_PARAMS, TRANSLATION_INTENSITIES } from '../data/assumptions.js';
import { formatNumber, MAX_EFFICIENCY_GAIN } from '../engine/calculations.js';

/* ── Brain equivalency constants ── */
const BRAIN = GLOBAL_PARAMS.brainEquivalency;
const KW_PER_GPU = (TRANSLATION_INTENSITIES?.serverToInfra?.kwPerGpu?.value ?? 1.0);
const PUE = (TRANSLATION_INTENSITIES?.serverToInfra?.pue?.value ?? 1.3);
const WATTS_PER_GPU = KW_PER_GPU * PUE * 1000;
const WORLD_POPULATION = 8.2e9;

/* ── Block durations in years ── */
const BLOCK_YEARS = [1, 1, 1, 1, 1, 5, 5, 5];

/* ── Table definitions: id → { category, columns[] } ── */
const TABLE_DEFS = {
  'inf-demand': {
    category: 'demand',
    columns: [
      { path: ['inferenceGrowth', 'consumer'], label: 'Consumer', suffix: '%/yr' },
      { path: ['inferenceGrowth', 'enterprise'], label: 'Enterprise', suffix: '%/yr' },
      { path: ['inferenceGrowth', 'agentic'], label: 'Agentic', suffix: '%/yr', help: 'High uncertainty' }
    ]
  },
  'train-demand': {
    category: 'demand',
    columns: [
      { path: ['trainingGrowth', 'frontier'], label: 'Frontier Runs', suffix: '%/yr' },
      { path: ['trainingGrowth', 'midtier'], label: 'Mid-tier Runs', suffix: '%/yr' }
    ]
  },
  'model-eff': {
    category: 'efficiency',
    columns: [
      { path: ['modelEfficiency', 'm_inference'], label: 'Inference', suffix: '%/yr' },
      { path: ['modelEfficiency', 'm_training'], label: 'Training', suffix: '%/yr' }
    ]
  },
  'sys-eff': {
    category: 'efficiency',
    columns: [
      { path: ['systemsEfficiency', 's_inference'], label: 'Inference', suffix: '%/yr', help: 'Batching, kernels, schedulers' },
      { path: ['systemsEfficiency', 's_training'], label: 'Training', suffix: '%/yr', help: 'Distributed training optimizations' }
    ]
  },
  'hw-eff': {
    category: 'efficiency',
    columns: [
      { path: ['hardwareEfficiency', 'h'], label: 'Accelerator Perf/$', suffix: '%/yr' },
      { path: ['hardwareEfficiency', 'h_memory'], label: 'Memory Bandwidth', suffix: '%/yr' }
    ]
  }
};

const EFFICIENCY_TABLE_IDS = ['model-eff', 'sys-eff', 'hw-eff'];

/* Metrics table columns (read-only derived values) */
const METRICS_COLUMNS = [
  { valueKey: 'inferenceGain', label: 'Inference eff. (x/yr)', format: v => v.toFixed(2) + 'x' },
  { valueKey: 'inferenceCostReduction', label: 'Inf. cost reduction', format: v => v.toFixed(0) + '%', help: 'Google achieved ~80% in 2024' },
  { valueKey: 'trainingGain', label: 'Training eff. (x/yr)', format: v => v.toFixed(2) + 'x' },
  { valueKey: 'trainingCostReduction', label: 'Train. cost reduction', format: v => v.toFixed(0) + '%' },
  { valueKey: 'totalGain', label: 'Total eff. (x/yr)', format: v => v.toFixed(2) + 'x' },
  { valueKey: 'totalOom', label: 'Total OOM/yr', format: v => v.toFixed(2) }
];

/* Brain equivalency table columns */
const BRAIN_COLUMNS = [
  { valueKey: 'cumulativeGain', label: 'Cumulative Eff. (x)', format: v => v < 1000 ? v.toFixed(1) + 'x' : (v / 1000).toFixed(1) + 'Kx' },
  { valueKey: 'wattsPerBrainEquiv', label: 'W per Brain-Equiv', format: v => v >= 1000 ? (v / 1000).toFixed(1) + ' kW' : v.toFixed(0) + ' W' },
  { valueKey: 'brainEfficiencyPct', label: '% of Brain Eff.', format: v => v < 1 ? v.toFixed(2) + '%' : v < 100 ? v.toFixed(1) + '%' : v.toFixed(0) + '%', help: `Human brain = ${GLOBAL_PARAMS.brainEquivalency.humanBrainWatts}W` },
  { valueKey: 'atAsymptote', label: 'Limit?', format: v => v ? 'AT LIMIT' : '\u2014' }
];

function AssumptionsTab({ assumptions, onAssumptionChange, onRunSimulation, isSimulating, results }) {
  const timeBlocks = ASSUMPTION_SEGMENTS;
  const numRows = timeBlocks.length;

  /*
   * 2D selection model:
   * sel = { t: tableId, r0, c0, r1, c1 }
   * r0/c0 = anchor cell, r1/c1 = focus (cursor) cell
   * Selected rectangle = min/max of anchor & focus
   */
  const [sel, setSel] = useState(null);
  const selRef = useRef(sel);
  selRef.current = sel;

  /* Internal clipboard (raw decimal value, e.g. 0.35 for 35%) */
  const clipboardRef = useRef(null);

  /* Mouse drag state */
  const draggingRef = useRef(false);

  useEffect(() => {
    const handleMouseUp = () => { draggingRef.current = false; };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, []);

  /* ── Value read/write helpers ── */

  const getRawValue = useCallback((tableId, colIndex, rowIndex) => {
    const def = TABLE_DEFS[tableId];
    if (!def) return null;
    const col = def.columns[colIndex];
    if (!col) return null;
    const blockKey = timeBlocks[rowIndex]?.key;
    if (!blockKey) return null;
    let value = assumptions?.[def.category]?.[blockKey];
    for (const key of col.path) {
      value = value?.[key];
    }
    return typeof value === 'object' ? value?.value : value;
  }, [assumptions, timeBlocks]);

  const setRawValue = useCallback((tableId, colIndex, rowIndex, rawValue) => {
    const def = TABLE_DEFS[tableId];
    if (!def) return;
    const col = def.columns[colIndex];
    if (!col) return;
    const blockKey = timeBlocks[rowIndex]?.key;
    if (!blockKey) return;
    onAssumptionChange(def.category, blockKey, col.path, rawValue);
  }, [timeBlocks, onAssumptionChange]);

  /* ── DOM helpers ── */

  const getInput = useCallback((t, r, c) =>
    document.querySelector(`input[data-t="${t}"][data-r="${r}"][data-c="${c}"]`),
  []);

  const focusCell = useCallback((t, r, c) => {
    const el = getInput(t, r, c);
    if (el) { el.focus(); el.select(); }
    return !!el;
  }, [getInput]);

  /* ── Selection rectangle ── */

  const selectionRect = useMemo(() => {
    if (!sel) return null;
    return {
      t: sel.t,
      minR: Math.min(sel.r0, sel.r1),
      maxR: Math.max(sel.r0, sel.r1),
      minC: Math.min(sel.c0, sel.c1),
      maxC: Math.max(sel.c0, sel.c1),
    };
  }, [sel]);

  const isCellInSelection = (tableId, row, col) => {
    if (!selectionRect || selectionRect.t !== tableId) return false;
    return row >= selectionRect.minR && row <= selectionRect.maxR
      && col >= selectionRect.minC && col <= selectionRect.maxC;
  };

  const isCellFocused = (tableId, row, col) => {
    if (!sel || sel.t !== tableId) return false;
    return row === sel.r1 && col === sel.c1;
  };

  /* ── Keyboard handler (Excel-style) ── */

  const handleKeyDown = useCallback((e) => {
    const input = e.target;
    if (input.tagName !== 'INPUT') return;
    const t = input.dataset.t;
    const r = parseInt(input.dataset.r, 10);
    const c = parseInt(input.dataset.c, 10);
    if (!t || isNaN(r) || isNaN(c)) return;

    const def = TABLE_DEFS[t];
    if (!def) return;
    const numCols = def.columns.length;
    const s = selRef.current;

    /* Arrow keys: navigate between cells */
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      let nr = r, nc = c;
      if (e.key === 'ArrowUp') nr = Math.max(0, r - 1);
      if (e.key === 'ArrowDown') nr = Math.min(numRows - 1, r + 1);
      if (e.key === 'ArrowLeft') nc = Math.max(0, c - 1);
      if (e.key === 'ArrowRight') nc = Math.min(numCols - 1, c + 1);

      if (focusCell(t, nr, nc)) {
        if (e.shiftKey) {
          setSel(prev => prev && prev.t === t
            ? { ...prev, r1: nr, c1: nc }
            : { t, r0: r, c0: c, r1: nr, c1: nc });
        } else {
          setSel({ t, r0: nr, c0: nc, r1: nr, c1: nc });
        }
      }
      return;
    }

    /* Enter: move down */
    if (e.key === 'Enter') {
      e.preventDefault();
      const nr = Math.min(numRows - 1, r + 1);
      if (focusCell(t, nr, c)) {
        setSel({ t, r0: nr, c0: c, r1: nr, c1: c });
      }
      return;
    }

    /* Tab: move right (shift+tab = left), wrap at row edges */
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      let nc = c + (e.shiftKey ? -1 : 1);
      let nr = r;
      if (nc >= numCols) { nc = 0; nr = r + 1; }
      if (nc < 0) { nc = numCols - 1; nr = r - 1; }
      if (nr >= 0 && nr < numRows && nc >= 0 && nc < numCols) {
        if (focusCell(t, nr, nc)) {
          setSel({ t, r0: nr, c0: nc, r1: nr, c1: nc });
        }
      }
      return;
    }

    /* Escape: clear selection */
    if (e.key === 'Escape') {
      setSel(null);
      input.blur();
      return;
    }

    const isMod = e.ctrlKey || e.metaKey;

    /* Ctrl+C: copy active cell value */
    if (isMod && e.key === 'c') {
      const raw = getRawValue(t, c, r);
      clipboardRef.current = raw;
      /* Don't preventDefault — let browser copy text to system clipboard too */
      return;
    }

    /* Ctrl+V: paste into selected cells (or just the active cell) */
    if (isMod && e.key === 'v') {
      e.preventDefault();
      const raw = clipboardRef.current;
      if (raw === null || raw === undefined) return;
      if (s && s.t === t) {
        const rect = {
          minR: Math.min(s.r0, s.r1), maxR: Math.max(s.r0, s.r1),
          minC: Math.min(s.c0, s.c1), maxC: Math.max(s.c0, s.c1),
        };
        for (let ri = rect.minR; ri <= rect.maxR; ri++) {
          for (let ci = rect.minC; ci <= rect.maxC; ci++) {
            setRawValue(t, ci, ri, raw);
          }
        }
      } else {
        setRawValue(t, c, r, raw);
      }
      return;
    }

    /* Ctrl+D: fill down (top row value → all rows below in selection) */
    if (isMod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (!s || s.t !== t) return;
      const rect = {
        minR: Math.min(s.r0, s.r1), maxR: Math.max(s.r0, s.r1),
        minC: Math.min(s.c0, s.c1), maxC: Math.max(s.c0, s.c1),
      };
      if (rect.minR === rect.maxR) return;
      for (let ci = rect.minC; ci <= rect.maxC; ci++) {
        const srcVal = getRawValue(t, ci, rect.minR);
        if (srcVal === null || srcVal === undefined) continue;
        for (let ri = rect.minR + 1; ri <= rect.maxR; ri++) {
          setRawValue(t, ci, ri, srcVal);
        }
      }
      return;
    }

    /* Ctrl+R: fill right (leftmost col value → all cols right in selection) */
    if (isMod && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      if (!s || s.t !== t) return;
      const rect = {
        minR: Math.min(s.r0, s.r1), maxR: Math.max(s.r0, s.r1),
        minC: Math.min(s.c0, s.c1), maxC: Math.max(s.c0, s.c1),
      };
      if (rect.minC === rect.maxC) return;
      for (let ri = rect.minR; ri <= rect.maxR; ri++) {
        const srcVal = getRawValue(t, rect.minC, ri);
        if (srcVal === null || srcVal === undefined) continue;
        for (let ci = rect.minC + 1; ci <= rect.maxC; ci++) {
          setRawValue(t, ci, ri, srcVal);
        }
      }
      return;
    }
  }, [numRows, getRawValue, setRawValue, focusCell]);

  /* ── Mouse handlers for cell selection + drag ── */

  const handleCellMouseDown = useCallback((e, t, r, c) => {
    /* Prevent text-selection on the page during drag, but let direct input clicks through */
    if (e.target.tagName !== 'INPUT') {
      e.preventDefault();
    }
    draggingRef.current = true;

    if (e.shiftKey) {
      const s = selRef.current;
      if (s && s.t === t) {
        setSel({ ...s, r1: r, c1: c });
      } else {
        setSel({ t, r0: r, c0: c, r1: r, c1: c });
      }
    } else {
      setSel({ t, r0: r, c0: c, r1: r, c1: c });
    }
    focusCell(t, r, c);
  }, [focusCell]);

  const handleCellMouseEnter = useCallback((t, r, c) => {
    if (!draggingRef.current) return;
    const s = selRef.current;
    if (s && s.t === t) {
      setSel({ ...s, r1: r, c1: c });
    }
  }, []);

  /* ── Efficiency summary (for Implied Token Efficiency metrics table) ── */

  const efficiencySummary = useMemo(() => {
    const calcStats = (blockKey) => {
      const block = assumptions?.efficiency?.[blockKey];
      const mInference = block?.modelEfficiency?.m_inference?.value ?? 0;
      const mTraining = block?.modelEfficiency?.m_training?.value ?? 0;
      const sInference = block?.systemsEfficiency?.s_inference?.value ?? 0;
      const sTraining = block?.systemsEfficiency?.s_training?.value ?? 0;
      const h = block?.hardwareEfficiency?.h?.value ?? 0;
      const hMem = block?.hardwareEfficiency?.h_memory?.value ?? 0;

      // Inference is memory-bandwidth-bound: H_memory contributes alongside H
      const inferenceFactor = (1 - mInference) / ((1 + sInference) * (1 + h) * (1 + hMem));
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
        totalOom: Math.log10(totalGain),
        inferenceCostReduction: (1 - 1 / inferenceGain) * 100,
        trainingCostReduction: (1 - 1 / trainingGain) * 100
      };
    };

    return timeBlocks.reduce((acc, block) => {
      acc[block.key] = calcStats(block.key);
      return acc;
    }, {});
  }, [assumptions, timeBlocks]);

  /* ── Brain power equivalency (cumulative efficiency → watts per brain equiv) ── */

  const brainEquivalency = useMemo(() => {
    const startingWatts = BRAIN.startingWattsPerBrainEquiv;
    const brainWatts = BRAIN.humanBrainWatts;

    // Cap at the same thermodynamic limit the simulation engine uses (700W / 6W ≈ 117×).
    // Once hardware efficiency is maxed out, brain equivalency stops improving too.
    const maxCumulativeGain = MAX_EFFICIENCY_GAIN;
    const minWatts = startingWatts / maxCumulativeGain;

    let cumulativeGain = 1.0;
    let asymptoteReached = false;
    let firstAsymptoteIdx = -1;

    const results = {};

    timeBlocks.forEach((block, idx) => {
      const years = BLOCK_YEARS[idx] || 1;
      const annualGain = efficiencySummary[block.key]?.totalGain || 1;

      if (!asymptoteReached) {
        // Compound the annual gain over the block's duration
        const blockGain = Math.pow(annualGain, years);
        cumulativeGain *= blockGain;

        // Check if we hit the asymptote
        if (cumulativeGain >= maxCumulativeGain) {
          cumulativeGain = maxCumulativeGain;
          asymptoteReached = true;
          firstAsymptoteIdx = idx;
        }
      }

      const wattsPerBrainEquiv = Math.max(startingWatts / cumulativeGain, minWatts);
      const brainEfficiencyPct = (brainWatts / wattsPerBrainEquiv) * 100;

      results[block.key] = {
        cumulativeGain,
        wattsPerBrainEquiv,
        brainEfficiencyPct,
        atAsymptote: asymptoteReached
      };
    });

    return {
      perBlock: results,
      firstAsymptoteIdx
    };
  }, [efficiencySummary, timeBlocks]);

  /* ── Implied human-equivalent AIs per time block (from simulation results) ── */

  const impliedAIs = useMemo(() => {
    if (!results?.months?.length) return null;

    // End month for each block (cumulative)
    const blockEndMonths = [];
    let cum = 0;
    BLOCK_YEARS.forEach(y => { cum += y * 12; blockEndMonths.push(cum); });

    return timeBlocks.map((block, idx) => {
      const endMonth = Math.min(blockEndMonths[idx], results.months.length - 1);
      const monthIdx = endMonth;

      const dcInstalled = results.nodes?.gpu_datacenter?.installedBase?.[monthIdx] || 0;
      const infInstalled = results.nodes?.gpu_inference?.installedBase?.[monthIdx] || 0;
      const totalInstalled = dcInstalled + infInstalled;
      const totalPowerWatts = totalInstalled * WATTS_PER_GPU;

      const wattsPerBrainEquiv = brainEquivalency.perBlock[block.key]?.wattsPerBrainEquiv || BRAIN.startingWattsPerBrainEquiv;
      const brainEquivs = totalPowerWatts / wattsPerBrainEquiv;
      const aisPerHuman = brainEquivs / WORLD_POPULATION;

      return {
        key: block.key,
        totalInstalledGPUs: totalInstalled,
        totalPowerGW: totalPowerWatts / 1e9,
        brainEquivs,
        aisPerHuman
      };
    });
  }, [results, brainEquivalency, timeBlocks]);

  /* ── Check if a row is past the asymptote (for greying out efficiency cells) ── */

  const isRowPastAsymptote = useCallback((rowIdx) => {
    const { firstAsymptoteIdx } = brainEquivalency;
    if (firstAsymptoteIdx === -1) return false;
    // Grey out rows AFTER the one that hit the asymptote
    return rowIdx > firstAsymptoteIdx;
  }, [brainEquivalency]);

  /* ── Render: table header row ── */

  const renderHeaderRow = (columns, label = 'Year') => (
    <tr>
      <th className="assumptions-header-cell assumptions-header-label">{label}</th>
      {columns.map(col => (
        <th key={col.label} className="assumptions-header-cell">
          <div className="assumptions-col-title">{col.label}</div>
          {col.help && <div className="assumptions-col-years">{col.help}</div>}
        </th>
      ))}
    </tr>
  );

  /* ── Render: editable table by ID (with asymptote support) ── */

  const renderEditableTable = (tableId) => {
    const def = TABLE_DEFS[tableId];
    if (!def) return null;
    const { category, columns } = def;
    const isEfficiencyTable = EFFICIENCY_TABLE_IDS.includes(tableId);

    return (
      <div className="assumptions-table-wrap">
        <table className="assumptions-table">
          <thead>{renderHeaderRow(columns)}</thead>
          <tbody>
            {timeBlocks.map((block, rowIdx) => {
              const disabled = isEfficiencyTable && isRowPastAsymptote(rowIdx);

              return (
                <tr key={block.key} className={disabled ? 'asymptote-disabled' : ''}>
                  <td className="assumptions-label-cell assumptions-year-cell">
                    <div className="assumptions-row-title">{block.label}</div>
                    <div className="assumptions-row-help">{block.years}</div>
                  </td>
                  {columns.map((col, colIdx) => {
                    const selected = !disabled && isCellInSelection(tableId, rowIdx, colIdx);
                    const focused = !disabled && isCellFocused(tableId, rowIdx, colIdx);

                    let value = assumptions?.[category]?.[block.key];
                    for (const key of col.path) value = value?.[key];
                    const numValue = typeof value === 'object' ? value?.value : value;
                    const confidence = typeof value === 'object' ? value?.confidence : null;
                    const source = typeof value === 'object' ? value?.source : '';

                    const cellClasses = [
                      'assumptions-input-cell',
                      selected && 'is-selected',
                      focused && 'is-focused',
                      disabled && 'is-disabled',
                    ].filter(Boolean).join(' ');

                    return (
                      <td
                        key={col.label}
                        className={cellClasses}
                        onMouseDown={disabled ? undefined : (e) => handleCellMouseDown(e, tableId, rowIdx, colIdx)}
                        onMouseEnter={disabled ? undefined : () => handleCellMouseEnter(tableId, rowIdx, colIdx)}
                        title={disabled ? 'Efficiency asymptote reached — no further gains possible' : undefined}
                      >
                        <div className="input-row">
                          {disabled ? (
                            <span className="assumptions-metric" style={{ opacity: 0.35, fontSize: '0.8125rem' }}>
                              {numValue !== null && numValue !== undefined && !Number.isNaN(numValue)
                                ? (numValue * 100).toFixed(0)
                                : '—'}
                            </span>
                          ) : (
                            <input
                              type="number"
                              step="0.01"
                              data-t={tableId}
                              data-r={rowIdx}
                              data-c={colIdx}
                              value={
                                numValue === null || numValue === undefined || Number.isNaN(numValue)
                                  ? ''
                                  : (numValue * 100).toFixed(0)
                              }
                              onFocus={(e) => e.target.select()}
                              onKeyDown={handleKeyDown}
                              onChange={(e) => {
                                if (e.target.value === '') {
                                  onAssumptionChange(category, block.key, col.path, null);
                                  return;
                                }
                                const newValue = parseFloat(e.target.value) / 100;
                                if (!Number.isNaN(newValue)) {
                                  onAssumptionChange(category, block.key, col.path, newValue);
                                }
                              }}
                              style={{ width: '56px' }}
                            />
                          )}
                          <span className="input-suffix" style={disabled ? { opacity: 0.35 } : undefined}>
                            {col.suffix}
                          </span>
                          {!disabled && confidence && (
                            <span
                              className={`confidence-${confidence}`}
                              title={`Confidence: ${confidence}${source ? ` • ${source}` : ''}`}
                            >
                              {confidence === 'high' ? '●' : confidence === 'medium' ? '◐' : '○'}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  /* ── Render: read-only metrics table ── */

  const renderMetricsTable = () => (
    <div className="assumptions-table-wrap">
      <table className="assumptions-table assumptions-table--metrics">
        <thead>{renderHeaderRow(METRICS_COLUMNS)}</thead>
        <tbody>
          {timeBlocks.map(block => (
            <tr key={block.key}>
              <td className="assumptions-label-cell assumptions-year-cell">
                <div className="assumptions-row-title">{block.label}</div>
                <div className="assumptions-row-help">{block.years}</div>
              </td>
              {METRICS_COLUMNS.map(col => (
                <td key={col.label} className="assumptions-input-cell">
                  <span className="assumptions-metric">
                    {col.format(efficiencySummary[block.key][col.valueKey])}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  /* ── Render: brain power equivalency table ── */

  const renderBrainEquivalencyTable = () => (
    <div className="assumptions-table-wrap">
      <table className="assumptions-table assumptions-table--metrics">
        <thead>{renderHeaderRow(BRAIN_COLUMNS)}</thead>
        <tbody>
          {timeBlocks.map(block => {
            const data = brainEquivalency.perBlock[block.key];
            return (
              <tr key={block.key}>
                <td className="assumptions-label-cell assumptions-year-cell">
                  <div className="assumptions-row-title">{block.label}</div>
                  <div className="assumptions-row-help">{block.years}</div>
                </td>
                {BRAIN_COLUMNS.map(col => (
                  <td key={col.label} className="assumptions-input-cell">
                    <span className={`assumptions-metric${col.valueKey === 'atAsymptote' && data[col.valueKey] ? ' asymptote-label' : ''}`}>
                      {col.format(data[col.valueKey])}
                    </span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  /* ── Main render ── */

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
        {/* ── Demand Growth ── */}
        <div className="assumption-block">
          <div className="assumption-block-header">
            <h3 className="assumption-block-title">Demand Growth</h3>
            <span className="assumption-block-badge">CAGR</span>
          </div>

          <div className="section">
            <h4 className="section-title">Inference Demand</h4>
            {renderEditableTable('inf-demand')}
          </div>

          <div className="section">
            <h4 className="section-title">Training Demand</h4>
            {renderEditableTable('train-demand')}
          </div>

          {/* ── Implied Human-Equivalent AIs ── */}
          {impliedAIs && (
            <div className="section">
              <h4 className="section-title">Implied Human-Equivalent AIs</h4>
              <p className="section-description">
                Based on projected installed GPU base, power draw, and efficiency improvements.
                Brain equivalents = total AI watts / watts-per-brain-equiv.
                Divided by world population (~8.2B) for AIs per human.
              </p>
              <div className="assumptions-table-wrap">
                <table className="assumptions-table assumptions-table--metrics">
                  <thead>
                    <tr>
                      <th className="assumptions-header-cell assumptions-header-label">Year</th>
                      <th className="assumptions-header-cell">
                        <div className="assumptions-col-title">Installed GPUs</div>
                      </th>
                      <th className="assumptions-header-cell">
                        <div className="assumptions-col-title">Power (GW)</div>
                      </th>
                      <th className="assumptions-header-cell">
                        <div className="assumptions-col-title">Brain Equivalents</div>
                      </th>
                      <th className="assumptions-header-cell">
                        <div className="assumptions-col-title">AIs per Human</div>
                        <div className="assumptions-col-years">brain-equiv / 8.2B</div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {impliedAIs.map((row, idx) => (
                      <tr key={row.key}>
                        <td className="assumptions-label-cell assumptions-year-cell">
                          <div className="assumptions-row-title">{timeBlocks[idx].label}</div>
                          <div className="assumptions-row-help">{timeBlocks[idx].years}</div>
                        </td>
                        <td className="assumptions-input-cell">
                          <span className="assumptions-metric">{formatNumber(row.totalInstalledGPUs)}</span>
                        </td>
                        <td className="assumptions-input-cell">
                          <span className="assumptions-metric">{row.totalPowerGW.toFixed(1)}</span>
                        </td>
                        <td className="assumptions-input-cell">
                          <span className="assumptions-metric">{formatNumber(row.brainEquivs)}</span>
                        </td>
                        <td className="assumptions-input-cell">
                          <span className="assumptions-metric" style={{
                            fontWeight: 600,
                            color: row.aisPerHuman >= 1 ? 'var(--accent-danger)' : row.aisPerHuman >= 0.1 ? 'var(--accent-warning)' : 'var(--text-primary)'
                          }}>
                            {row.aisPerHuman < 0.01
                              ? row.aisPerHuman.toExponential(2)
                              : row.aisPerHuman < 1
                                ? row.aisPerHuman.toFixed(3)
                                : row.aisPerHuman.toFixed(1)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ── Efficiency Improvements ── */}
        <div className="assumption-block">
          <div className="assumption-block-header">
            <h3 className="assumption-block-title">Efficiency Improvements</h3>
            <span className="assumption-block-badge">Annual</span>
          </div>

          <div className="section">
            <h4 className="section-title">Model Efficiency (Compute/Token Reduction)</h4>
            {renderEditableTable('model-eff')}
          </div>

          <div className="section">
            <h4 className="section-title">Systems Throughput (Software Gains)</h4>
            {renderEditableTable('sys-eff')}
          </div>

          <div className="section">
            <h4 className="section-title">Hardware Throughput (Chip Improvements)</h4>
            {renderEditableTable('hw-eff')}
          </div>

          <div className="section">
            <h4 className="section-title">Implied Token Efficiency</h4>
            <p className="section-description">
              Derived from the combined model + systems + hardware improvements. OOM/year is the
              log10 efficiency gain (e.g., 0.3 = 2x/year). Total OOM/year mirrors the
              combined efficiency improvement rate used in industry reporting.
            </p>
            {renderMetricsTable()}
          </div>

          <div className="section">
            <h4 className="section-title">Brain Power Equivalency</h4>
            <p className="section-description">
              Compares AI compute efficiency to the human brain ({BRAIN.humanBrainWatts}W).
              Starting at {(BRAIN.startingWattsPerBrainEquiv / 1000).toFixed(0)}kW per brain-equivalent
              of cognitive work, efficiency improvements compound over time.
              Capped at the thermodynamic efficiency limit ({MAX_EFFICIENCY_GAIN.toFixed(0)}×),
              corresponding to ~{(BRAIN.startingWattsPerBrainEquiv / MAX_EFFICIENCY_GAIN).toFixed(0)}W per brain-equiv. Once the
              limit is reached, further efficiency cells are locked.
            </p>
            {renderBrainEquivalencyTable()}
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
              InferAH = (Tokens x ComputePerToken x M<sub>t</sub>) / (Throughput x S<sub>t</sub> x H<sub>t</sub>)
            </code>
          </div>
          <div>
            <h4>Stacked Yield (HBM)</h4>
            <code>
              Y(t) = Y<sub>target</sub> - (Y<sub>target</sub> - Y<sub>initial</sub>) x 2<sup>-t/HL</sup>
            </code>
          </div>
          <div>
            <h4>Brain-Equiv Watts</h4>
            <code>
              W<sub>brain</sub> = max(W<sub>start</sub> / CumulativeEff, W<sub>min</sub>)
            </code>
          </div>
          <div>
            <h4>Price Index</h4>
            <code>
              P = 1 + a x (Tightness - 1)<sup>b</sup> when Tight {'>'} 1
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AssumptionsTab;
