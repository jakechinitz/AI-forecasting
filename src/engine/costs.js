/**
 * Unit-cost layer: dollars per supply-chain input.
 *
 * spend(input, month) = volume(input, month) × price(input, month)
 *   volume: from the physical engine (accelerators bought × per-accelerator
 *           intensities, facility MW paid for during construction, energy use)
 *   price:  January level × compounded annual change for the time block ×
 *           scarcity pass-through (1 + passThrough × (node price index − 1))
 *
 * Groups: compute, network (paid at purchase), facility, power (paid over
 * construction), embedded (supplier value inside accelerator prices — shown,
 * never added to totals), opex (operating spend, not capex).
 */

export const CAPEX_GROUPS = ['compute', 'network', 'facility', 'power'];
export const CHIP_GROUPS = ['compute', 'network'];
export const FACILITY_GROUPS = ['facility', 'power'];

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (v, fallback) => {
  const n = typeof v === 'object' && v !== null && 'value' in v ? v.value : v;
  const f = typeof n === 'string' && n.trim() !== '' ? Number(n) : n;
  return typeof f === 'number' && Number.isFinite(f) ? f : fallback;
};

// Scarcity pass-through is bounded: contracted prices move less than spot.
const SCARCITY_MULT_MIN = 0.8;
const SCARCITY_MULT_MAX = 1.5;

/**
 * @param costCfg   COST_ASSUMPTIONS ({ inputs: [...] })
 * @param opts.months         simulation length
 * @param opts.rateAt         (month, pick(blockKey) → rate) → rate, blended across block edges
 * @param opts.defaults       COST_ASSUMPTIONS_BASE (fallback for bad inputs)
 */
export function createCostModel(costCfg, { months, rateAt, defaults }) {
  const baseById = new Map((defaults?.inputs || []).map((i) => [i.id, i]));
  const inputs = (costCfg?.inputs || defaults?.inputs || []).map((raw) => {
    const def = baseById.get(raw.id) || {};
    const change = {};
    const keys = new Set([...Object.keys(def.change || {}), ...Object.keys(raw.change || {})]);
    keys.forEach((k) => { change[k] = clamp(num(raw.change?.[k], num(def.change?.[k], 0)), -0.9, 5); });
    return {
      ...def,
      ...raw,
      price: raw.price === null ? null : Math.max(0, num(raw.price, num(def.price, 0))),
      passThrough: clamp(num(raw.passThrough, num(def.passThrough, 0)), 0, 1),
      change
    };
  });
  const byId = new Map(inputs.map((i) => [i.id, i]));

  // Compounded price trend per input (index 1 at month 0)
  const trend = {};
  inputs.forEach((input) => {
    const arr = new Float64Array(months);
    arr[0] = 1;
    for (let m = 1; m < months; m++) {
      const g = rateAt(m, (key) => input.change[key] ?? 0);
      arr[m] = arr[m - 1] * Math.pow(1 + g, 1 / 12);
    }
    trend[input.id] = arr;
  });

  const spend = {};
  const volume = {};
  const paid = {};
  inputs.forEach((i) => {
    spend[i.id] = new Array(months).fill(0);
    volume[i.id] = new Array(months).fill(0);
    paid[i.id] = new Array(months).fill(null);
  });

  /** Price actually paid for an input this month, given its node's price index */
  function priceAt(id, month, priceIndex = 1) {
    const input = byId.get(id);
    if (!input || input.price == null) return 0;
    const pi = Number.isFinite(priceIndex) ? priceIndex : 1;
    const scarcity = clamp(1 + input.passThrough * (pi - 1), SCARCITY_MULT_MIN, SCARCITY_MULT_MAX);
    return input.price * trend[id][Math.min(month, months - 1)] * scarcity;
  }

  /**
   * Per-accelerator bill (compute + network, plus embedded supplier value)
   * @param intensity   node intensity per accelerator (engine map)
   * @param priceIndex  (nodeId) → scarcity price index
   * @returns { perUnit: {id: $}, total (capex only), qtyPerUnit: {id: qty} }
   */
  function chipBill(month, kwNew, intensity, priceIndex) {
    const perUnit = {}; const qtyPerUnit = {};
    let total = 0;
    inputs.forEach((i) => {
      if (![...CHIP_GROUPS, 'embedded'].includes(i.group)) return;
      // qtyKey lets an input be counted in different units than its node
      // (HBM is priced per GB; the node counts stacks)
      const qty = i.basis === 'perKw' ? kwNew : (intensity[i.qtyKey || i.node] || 0);
      const $ = qty * priceAt(i.id, month, priceIndex(i.node));
      qtyPerUnit[i.id] = qty;
      perUnit[i.id] = $;
      if (i.group !== 'embedded') total += $;
    });
    return { perUnit, total, qtyPerUnit };
  }

  /**
   * Cost of one MW of facility (IT × PUE), paid over construction
   * @param ctx { gridShare, coolingUnitsPerMw, transformersPerMw, backupMwPerMw }
   */
  function facilityBill(month, ctx, priceIndex) {
    const perMw = {}; const qtyPerMw = {};
    let total = 0;
    inputs.forEach((i) => {
      if (!FACILITY_GROUPS.includes(i.group)) return;
      let qty = 0;
      switch (i.basis) {
        case 'perMwFacility': qty = 1; break;
        case 'coolingPerMwFacility': qty = ctx.coolingUnitsPerMw; break;
        case 'transformersPerMwFacility': qty = ctx.transformersPerMw * ctx.gridShare; break;
        case 'backupPerMwFacility': qty = ctx.backupMwPerMw; break;
        case 'onsitePerMwFacility': qty = 1 - ctx.gridShare; break;
        case 'gridPerMwFacility': qty = ctx.gridShare; break;
        default: qty = 0;
      }
      const $ = qty * priceAt(i.id, month, priceIndex(i.node));
      qtyPerMw[i.id] = qty;
      perMw[i.id] = $;
      total += $;
    });
    return { perMw, total, qtyPerMw };
  }

  /** Book spend: scale × bill items (units or MW) into the month */
  function book(month, bill, scale, key = 'perUnit', qtyKey = 'qtyPerUnit') {
    if (!(scale > 0)) return;
    Object.entries(bill[key]).forEach(([id, $]) => {
      spend[id][month] += $ * scale;
      volume[id][month] += (bill[qtyKey][id] || 0) * scale;
    });
  }

  function bookDirect(month, id, dollars, qty, unitPrice) {
    if (!spend[id]) return;
    spend[id][month] += dollars;
    volume[id][month] += qty;
    if (unitPrice != null) paid[id][month] = unitPrice;
  }

  /** Annual table: spend ($B), volume, average price paid, y/y growth */
  function annual(yearsCount) {
    const rows = inputs.map((i) => {
      const s = []; const v = []; const p = [];
      for (let y = 0; y < yearsCount; y++) {
        let ss = 0; let vv = 0;
        for (let m = y * 12; m < Math.min(months, y * 12 + 12); m++) { ss += spend[i.id][m]; vv += volume[i.id][m]; }
        s.push(ss / 1e9);
        v.push(vv);
        p.push(vv > 0 ? ss / vv : null);
      }
      const growth = s.map((x, k) => (k === 0 || !(s[k - 1] > 0) ? null : x / s[k - 1] - 1));
      return { id: i.id, label: i.label, group: i.group, unit: i.unit, source: i.source, spendB: s, volume: v, avgPrice: p, growth };
    });
    const sumGroup = (groups) => {
      const out = [];
      for (let y = 0; y < yearsCount; y++) out.push(rows.filter((r) => groups.includes(r.group)).reduce((a, r) => a + r.spendB[y], 0));
      return out;
    };
    const withGrowth = (arr) => ({ spendB: arr, growth: arr.map((x, k) => (k === 0 || !(arr[k - 1] > 0) ? null : x / arr[k - 1] - 1)) });
    return {
      inputs: rows,
      totals: {
        compute: withGrowth(sumGroup(['compute'])),
        network: withGrowth(sumGroup(['network'])),
        facility: withGrowth(sumGroup(['facility'])),
        power: withGrowth(sumGroup(['power'])),
        chips: withGrowth(sumGroup(CHIP_GROUPS)),
        facilities: withGrowth(sumGroup(FACILITY_GROUPS)),
        capex: withGrowth(sumGroup(CAPEX_GROUPS)),
        embedded: withGrowth(sumGroup(['embedded'])),
        opex: withGrowth(sumGroup(['opex']))
      }
    };
  }

  return { inputs, priceAt, chipBill, facilityBill, book, bookDirect, annual, spend, volume, has: (id) => byId.has(id) };
}
