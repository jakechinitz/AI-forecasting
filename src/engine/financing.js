/**
 * Capital financing layer — port of AI_Capex_Funding_Model.xlsx.
 *
 * The physical engine (calculations.js) decides what CAN be built each month.
 * This module decides what can be PAID FOR, per calendar year. The year's
 * fundable capex is a cumulative monthly budget (allowance()) that the engine
 * spends on construction payments and chip purchases, rationing both
 * proportionally when the budget is short.
 *
 * Sheet mapping:
 *   Capital_Markets  → channelCapacity()
 *   Fleet_Economics  → unitEconomics() (capex per GW comes from the engine's
 *                      bottom-up cost model instead of an input path)
 *   Capex            → recordMonth(): chips when bought, facilities during construction
 *   Funding          → startYear() (max fundable per tier) and closeYear() (waterfall)
 *   Dashboard        → annual rows in results.financing
 *
 * Non-circularity (same as the Excel): AI revenue is earned on the OPENING
 * fleet, the scarcity premium comes from the PRIOR year's unmet demand, and
 * fundable capex depends only on opening balances.
 *
 * Fixes vs the Excel:
 *  1. Revenue is capped at demand: tokens sold = fleet capacity × min(1, required ÷ installed).
 *     The Excel billed full fleet output even when supply exceeded demand.
 *  2. A funding shortfall is booked against cash (cash can fall below its floor
 *     or go negative) instead of vanishing, and negative cash accrues interest
 *     at the tier's cost of debt. The shortfall is split into unfunded capex
 *     (kept at zero by the funding gate) and an operating deficit (cash
 *     obligations above operating cash flow, which capex cannot fix).
 */

const KWH_PER_GW_YEAR = 8.76e9;

const safeDiv = (a, b, fallback = 0) => (Math.abs(b) > 1e-12 ? a / b : fallback);
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Number from a raw input ({ value } objects and numeric strings accepted),
// else the fallback. Optional bounds clamp the result.
function num(raw, fallback, lo = -Infinity, hi = Infinity) {
  const v = isPlainObject(raw) && 'value' in raw ? raw.value : raw;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  const out = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(hi, Math.max(lo, out));
}

// Share-like scalars must stay in [0, 1]; lives must be at least a year.
const SCALAR_BOUNDS = {
  cashTaxRate: [0, 1],
  variableCostPctOfRevenue: [0, 1], idlePowerShare: [0, 1],
  computeLifeYears: [1, 50], facilityLifeYears: [1, 100],
  scarcityElasticity: [0, Infinity], maxScarcityPremium: [1, Infinity],
  electricityPricePerKwh: [0, Infinity], otherOpexPerGwYr: [0, Infinity]
};

/**
 * Coerce user/LLM-edited financing inputs into a well-formed structure, filling
 * anything missing or non-numeric from the defaults. Tier shares are
 * normalized to sum to 1 and channel allocations are padded to the tier count.
 */
export function sanitizeFinancing(fin = {}, defaults = {}) {
  const d = defaults || {};
  const scalars = {};
  Object.entries(d.scalars || {}).forEach(([k, def]) => {
    const [lo, hi] = SCALAR_BOUNDS[k] || [-Infinity, Infinity];
    scalars[k] = num(fin.scalars?.[k], def, lo, hi);
  });

  const paths = {};
  const pathNames = new Set([...Object.keys(d.paths || {}), ...Object.keys(fin.paths || {})]);
  pathNames.forEach((name) => {
    const clean = {};
    Object.entries(isPlainObject(fin.paths?.[name]) ? fin.paths[name] : {}).forEach(([year, v]) => {
      const n = num(v, NaN);
      if (Number.isFinite(n) && Number.isFinite(Number(year))) clean[year] = n;
    });
    paths[name] = Object.keys(clean).length ? { ...(d.paths?.[name] || {}), ...clean } : { ...(d.paths?.[name] || {}) };
  });

  const defTiers = d.tiers || [];
  const rawTiers = Array.isArray(fin.tiers) && fin.tiers.length ? fin.tiers : defTiers;
  const tiers = rawTiers.map((t, i) => {
    const def = defTiers.find((x) => x.id === t?.id) || defTiers[i] || {};
    const out = { ...def, ...t };
    ['share', 'legacyOcf', 'legacyOcfGrowth', 'shareholderReturns', 'cash', 'minCash', 'debt',
      'legacyEbitda', 'legacyEbitdaGrowth', 'maxExternalShareOfCapex', 'costOfDebt', 'maxDebtToEbitda']
      .forEach((k) => { out[k] = num(t?.[k], def[k] ?? 0); });
    out.share = Math.max(0, out.share);
    out.maxExternalShareOfCapex = Math.min(1, Math.max(0, out.maxExternalShareOfCapex));
    out.id = out.id ?? String.fromCharCode(65 + i);
    out.name = out.name ?? `Tier ${out.id}`;
    return out;
  });
  const shareSum = tiers.reduce((s, t) => s + t.share, 0);
  tiers.forEach((t) => { t.share = shareSum > 0 ? t.share / shareSum : 1 / tiers.length; });

  const defChannels = d.channels || [];
  const rawChannels = Array.isArray(fin.channels) && fin.channels.length ? fin.channels : defChannels;
  const channels = rawChannels.map((c, i) => {
    const def = defChannels.find((x) => x.id === c?.id) || defChannels[i] || {};
    const alloc = tiers.map((_, j) => Math.max(0, num(c?.alloc?.[j], def.alloc?.[j] ?? 0)));
    return {
      ...def, ...c,
      type: c?.type === 'equity' ? 'equity' : 'debt',
      capacity: Math.max(0, num(c?.capacity, def.capacity ?? 0)),
      growth: num(c?.growth, def.growth ?? 0, -1),
      alloc
    };
  });

  const mult = fin.marketCapacityMultiplier || {};
  return {
    ...fin,
    applyFundingConstraint: fin.applyFundingConstraint !== false,
    baseYear: {
      blendedPricePerMTokens: num(fin.baseYear?.blendedPricePerMTokens, d.baseYear?.blendedPricePerMTokens ?? 0.55, 0)
    },
    scalars, paths, tiers, channels,
    marketCapacityMultiplier: {
      debt: num(mult.debt, 1, 0),
      equity: num(mult.equity, 1, 0)
    }
  };
}

export function createFinancingModel(rawFin, { startYear: firstModelYear, pue, defaults }) {
  const fin = sanitizeFinancing(rawFin, defaults || rawFin);
  const scalars = fin.scalars;
  const tiers = fin.tiers;
  const channels = fin.channels;
  const mult = fin.marketCapacityMultiplier;
  const applyConstraint = fin.applyFundingConstraint;

  // Value of a year-keyed path; before the first year use the first value,
  // after the last year hold the last value.
  const pathValue = (pathName, year) => {
    const path = fin.paths?.[pathName] || {};
    if (path[year] !== undefined) return path[year];
    const years = Object.keys(path).map(Number).sort((a, b) => a - b);
    if (!years.length) return 0;
    return year < years[0] ? path[years[0]] : path[years[years.length - 1]];
  };

  const channelCapacity = (channel, year) => {
    const yearsOut = year - firstModelYear;
    const raw = channel.capacity * Math.pow(1 + channel.growth, yearsOut);
    const m = channel.type === 'equity' ? (mult.equity ?? 1) : (mult.debt ?? 1);
    return Math.max(0, raw * m);
  };

  // Tier balances (opening = end of base year)
  const tierState = tiers.map((t) => ({
    id: t.id,
    legacyOcf: t.legacyOcf,
    legacyEbitda: t.legacyEbitda,
    cash: t.cash,
    debt: t.debt,
    gw: 0
  }));

  let basePrice = fin.baseYear.blendedPricePerMTokens;
  // Scarcity premium uses the PRIOR year-end unmet ratio (Excel convention);
  // the first year takes the engine's opening ratio.
  let lastScarcityRatio = null;

  const annual = [];
  const tierRows = Object.fromEntries(tiers.map((t) => [t.id, []]));
  let current = null;

  function unitEconomics(year, ctx) {
    const util = pathValue('utilization', year);
    // New-build capex per GW IT and its compute share, from the cost model
    const capexPerGw = Math.max(0, ctx.capexPerGw || 0);
    const computeShare = Math.min(1, Math.max(0, ctx.computeShareOfCapex ?? 0.65));
    basePrice = basePrice * (1 + pathValue('priceChange', year));
    const priorScarcity = lastScarcityRatio ?? ctx.priorScarcityRatio ?? 0;
    const premium = ctx.premium ?? scarcityPremium(scalars, priorScarcity);
    const effPrice = basePrice * premium;

    const inferenceShare = Math.max(0, 1 - ctx.trainingShare);
    const servedFraction = Math.min(1, Math.max(0, ctx.servedFraction));

    const theoreticalRevPerGw = ctx.openingFleetTokPerKwhM * 1e6 * KWH_PER_GW_YEAR * effPrice / 1e15;
    const jensenRevPerGw = ctx.frontierTokPerKwhM * 1e6 * KWH_PER_GW_YEAR * effPrice / 1e15 * 0.95;
    const realizedRevPerGw = theoreticalRevPerGw * util * inferenceShare * servedFraction + scalars.otherRevenuePerGwYr;

    const energyPerGw = KWH_PER_GW_YEAR * pue * (scalars.idlePowerShare + (1 - scalars.idlePowerShare) * util) * scalars.electricityPricePerKwh / 1e9;
    const variablePerGw = realizedRevPerGw * scalars.variableCostPctOfRevenue;
    const ebitdaPerGw = realizedRevPerGw - variablePerGw - energyPerGw - scalars.otherOpexPerGwYr;
    const daPerGw = capexPerGw * computeShare / scalars.computeLifeYears
      + capexPerGw * (1 - computeShare) / scalars.facilityLifeYears;
    const ebitPerGw = ebitdaPerGw - daPerGw;
    const taxPerGw = Math.max(0, ebitPerGw) * scalars.cashTaxRate;
    const ocfPerGw = ebitdaPerGw - taxPerGw;

    return {
      util, capexPerGw, computeShare, basePrice, premium, effPrice, inferenceShare, servedFraction,
      theoreticalRevPerGw, jensenRevPerGw, realizedRevPerGw,
      realizedPctOfJensen: safeDiv(realizedRevPerGw, jensenRevPerGw),
      energyPerGw, variablePerGw, otherOpexPerGw: scalars.otherOpexPerGwYr,
      ebitdaPerGw, daPerGw, ebitPerGw, taxPerGw, ocfPerGw,
      paybackYears: ocfPerGw > 0 ? capexPerGw / ocfPerGw : null,
      roic: safeDiv(ebitPerGw, capexPerGw),
      gStar: safeDiv(ocfPerGw, capexPerGw)
    };
  }

  /**
   * Start of a calendar year: compute unit economics on the opening fleet and
   * each tier's maximum fundable capex (Funding rows 34-38 in the Excel).
   */
  function startYear(year, ctx) {
    if (!annual.length) {
      // Base-year fleet split by tier allocation shares
      tierState.forEach((ts, i) => { ts.gw = ctx.openingGW * tiers[i].share; });
    }
    const econ = unitEconomics(year, ctx);
    const openingGW = ctx.openingGW;
    const totalTierGw = tierState.reduce((s, t) => s + t.gw, 0) || 1;

    const aiEbitdaTotal = econ.ebitdaPerGw * openingGW;
    const aiOcfTotal = econ.ocfPerGw * openingGW;
    const aiRevenue = econ.realizedRevPerGw * openingGW;

    const debtCapacityTotal = channels.filter((c) => c.type === 'debt').reduce((s, c) => s + channelCapacity(c, year), 0);
    const equityCapacityTotal = channels.filter((c) => c.type === 'equity').reduce((s, c) => s + channelCapacity(c, year), 0);

    const tierPlans = tiers.map((t, i) => {
      const ts = tierState[i];
      const fleetShare = ts.gw / totalTierGw;
      const legacyOcf = ts.legacyOcf * (1 + t.legacyOcfGrowth);
      const legacyEbitda = ts.legacyEbitda * (1 + t.legacyEbitdaGrowth);
      const aiOcf = aiOcfTotal * fleetShare;
      const aiEbitda = aiEbitdaTotal * fleetShare;
      // Negative cash is an overdraft and pays the tier's cost of debt
      const interest = t.costOfDebt * (ts.debt + Math.max(0, -ts.cash));
      const ocf = legacyOcf + aiOcf - interest;
      const ebitda = legacyEbitda + aiEbitda;
      const cashAvail = Math.max(0, ts.cash - t.minCash);
      const headroom = Math.max(0, t.maxDebtToEbitda * ebitda - ts.debt);
      const marketDebt = channels.filter((c) => c.type === 'debt').reduce((s, c) => s + channelCapacity(c, year) * (c.alloc?.[i] || 0), 0);
      const marketEquity = channels.filter((c) => c.type === 'equity').reduce((s, c) => s + channelCapacity(c, year) * (c.alloc?.[i] || 0), 0);
      const debtCap = Math.min(headroom, marketDebt);
      const internal = ocf - t.shareholderReturns;
      const maxMarkets = internal + cashAvail + debtCap + marketEquity;
      const maxBehavioral = t.maxExternalShareOfCapex >= 1 ? Infinity : Math.max(0, internal) / (1 - t.maxExternalShareOfCapex);
      const maxFundable = Math.max(0, Math.min(maxMarkets, maxBehavioral));
      const governor = maxBehavioral < maxMarkets
        ? 'Behavioral cap'
        : (debtCap === headroom ? 'Rating ceiling' : 'Market absorption');
      return {
        id: t.id, fleetShare, legacyOcf, legacyEbitda, aiOcf, aiEbitda, interest, ocf, ebitda,
        cashAvail, headroom, marketDebt, marketEquity, debtCap, maxMarkets, maxBehavioral,
        maxFundable, governor
      };
    });

    const fundableCapex = tierPlans.reduce((s, p) => s + p.maxFundable, 0);

    current = {
      year, ctx, econ, openingGW, aiRevenue, aiEbitdaTotal, aiOcfTotal,
      debtCapacityTotal, equityCapacityTotal, tierPlans, fundableCapex,
      capexYTD: 0, computeCapex: 0, facilityCapex: 0,
      deployedGW: 0, replacementGW: 0, retiredGW: 0, purchasedGW: 0, deferredByFundingGW: 0,
      bindingCounts: {}, monthsSeen: 0
    };
    return current;
  }

  /**
   * Capex budget ($B) still available this month: the year's fundable capex
   * paced evenly (cumulative YTD allowance) minus what has been spent.
   * Infinity when the funding constraint is off.
   */
  function allowance(monthOfYear) {
    if (!current || !applyConstraint) return Infinity;
    const a = current.fundableCapex * ((monthOfYear + 1) / 12) - current.capexYTD;
    return Number.isFinite(a) ? Math.max(0, a) : 0;
  }

  function recordMonth({ computeCapex = 0, facilityCapex = 0, deployedGW = 0, retiredGW = 0, purchasedGW = 0, binding, deferredByFundingGW }) {
    if (!current) return;
    current.computeCapex += computeCapex;
    current.facilityCapex += facilityCapex;
    current.capexYTD += computeCapex + facilityCapex;
    current.deployedGW += deployedGW;
    current.replacementGW += Math.min(deployedGW, retiredGW);
    current.retiredGW += retiredGW;
    current.purchasedGW += purchasedGW;
    current.deferredByFundingGW += deferredByFundingGW || 0;
    current.bindingCounts[binding] = (current.bindingCounts[binding] || 0) + 1;
    current.monthsSeen += 1;
  }

  /**
   * Year end: allocate actual capex to tiers (base share, spill to tiers with
   * funding slack), run each tier's waterfall, roll balances forward.
   */
  function closeYear(fleet) {
    if (!current) return;
    const c = current;
    const C = c.capexYTD;

    // Allocation (Demand_Build rows 34-44, in dollars): base shares capped at
    // each tier's fundable amount, the rest spilled to tiers with slack. When
    // capex exceeds what all tiers can fund (possible only with the gate off),
    // fall back to fixed shares so the excess shows up as unfunded capex.
    const base = tiers.map((t, i) => Math.min(c.tierPlans[i].maxFundable, t.share * C));
    const useFundableCaps = C <= c.fundableCapex + 1e-6;
    let alloc;
    if (useFundableCaps) {
      const unallocated = Math.max(0, C - base.reduce((s, v) => s + v, 0));
      const slack = tiers.map((_, i) => Math.max(0, c.tierPlans[i].maxFundable - base[i]));
      const totalSlack = slack.reduce((s, v) => s + v, 0);
      alloc = base.map((b, i) => b + (totalSlack > 0 ? Math.min(slack[i], unallocated * slack[i] / totalSlack) : 0));
    } else {
      alloc = tiers.map((t) => t.share * C);
    }

    const openingTierGw = tierState.map((ts) => ts.gw);
    const openingTotalGw = openingTierGw.reduce((s, v) => s + v, 0) || 1;
    const retireFrac = Math.min(1, c.retiredGW / openingTotalGw);

    const rows = tiers.map((t, i) => {
      const ts = tierState[i];
      const p = c.tierPlans[i];
      const capex = alloc[i];
      const openingDebt = ts.debt;
      const openingCash = ts.cash;
      const gap = capex + t.shareholderReturns - p.ocf;
      const cashDrawdown = Math.min(Math.max(0, gap), p.cashAvail);
      const afterCash = Math.max(0, gap) - cashDrawdown;
      const debtRaised = Math.min(afterCash, p.debtCap);
      const afterDebt = afterCash - debtRaised;
      const equityRaised = Math.min(afterDebt, p.marketEquity);
      const shortfall = afterDebt - equityRaised;
      // Operating obligations are met first, so any shortfall is unfunded
      // capex up to the capex amount; the rest is an operating deficit.
      const unfundedCapex = Math.min(shortfall, capex);
      const operatingDeficit = shortfall - unfundedCapex;
      const surplus = Math.max(0, -gap);

      ts.debt = openingDebt + debtRaised;
      ts.cash = openingCash - cashDrawdown - shortfall + surplus; // shortfall hits cash (fix #2)
      ts.legacyOcf = p.legacyOcf;
      ts.legacyEbitda = p.legacyEbitda;
      ts.gw = openingTierGw[i] * (1 - retireFrac) + (C > 0 ? c.deployedGW * capex / C : c.deployedGW * t.share);

      const marginal = unfundedCapex > 0.01 ? 'UNFUNDED'
        : operatingDeficit > 0.01 ? 'Operating deficit'
        : equityRaised > 0.01 ? 'Equity'
          : debtRaised > 0.01 ? 'Debt'
            : cashDrawdown > 0.01 ? 'Cash' : 'Self-funded';

      return {
        year: c.year, id: t.id, name: t.name,
        fleetShare: p.fleetShare, installedGW: ts.gw,
        legacyOcf: p.legacyOcf, aiOcf: p.aiOcf, interest: p.interest, ocf: p.ocf,
        shareholderReturns: t.shareholderReturns, capex,
        fundingGap: gap, cashDrawdown, debtRaised, equityRaised,
        shortfall, unfundedCapex, operatingDeficit,
        grossDebt: ts.debt, cash: ts.cash, ebitda: p.ebitda,
        debtToEbitda: safeDiv(ts.debt, p.ebitda),
        debtShareOfCapex: safeDiv(debtRaised, capex),
        externalShareOfCapex: safeDiv(cashDrawdown + debtRaised + equityRaised, capex),
        selfFunding: p.ocf - t.shareholderReturns >= capex,
        maxFundable: p.maxFundable, fundingCoverage: safeDiv(p.maxFundable, capex, null),
        governor: p.governor, marginalSource: marginal,
        leverageHeadroom: p.headroom, marketDebt: p.marketDebt, marketEquity: p.marketEquity
      };
    });
    rows.forEach((r) => tierRows[r.id].push(r));

    const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
    const binding = Object.entries(c.bindingCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '-';
    const totalOcf = sum('ocf');
    const returns = sum('shareholderReturns');

    annual.push({
      year: c.year,
      // Demand & build (from the physical engine)
      tokenDemandIndex: fleet.tokenDemandIndex,
      requiredGW: fleet.requiredGW,
      requiredGWYearEnd: fleet.requiredGWYearEnd,
      openingGW: c.openingGW,
      installedGW: fleet.installedGW,
      deployedGW: c.deployedGW,
      replacementGW: c.replacementGW,
      netNewGW: c.deployedGW - c.replacementGW,
      retiredGW: c.retiredGW,
      unmetGW: Math.max(0, fleet.requiredGWYearEnd - fleet.installedGW),
      scarcityRatio: fleet.scarcityRatio,
      deferredByFundingGW: c.deferredByFundingGW,
      bindingConstraint: binding,
      trainingShare: c.ctx.trainingShare,
      // Unit economics
      openingFleetTokPerKwhM: c.ctx.openingFleetTokPerKwhM,
      frontierTokPerKwhM: c.ctx.frontierTokPerKwhM,
      ...c.econ,
      aiRevenue: c.aiRevenue,
      aiEbitda: c.aiEbitdaTotal,
      aiOcf: c.aiOcfTotal,
      buildGrowth: annual.length ? safeDiv(c.deployedGW, annual[annual.length - 1].deployedGW, 1) - 1 : null,
      purchasedGW: c.purchasedGW,
      // Capex
      computeCapex: c.computeCapex,
      facilityCapex: c.facilityCapex,
      totalCapex: C,
      capexPerGwDeployed: safeDiv(C, c.deployedGW),
      // Funding (system)
      fundableCapex: c.fundableCapex,
      capexAboveFundable: Math.max(0, C - c.fundableCapex),
      totalOcf, shareholderReturns: returns,
      interest: sum('interest'),
      cashDrawdown: sum('cashDrawdown'),
      debtRaised: sum('debtRaised'),
      equityRaised: sum('equityRaised'),
      shortfall: sum('shortfall'),
      unfundedCapex: sum('unfundedCapex'),
      operatingDeficit: sum('operatingDeficit'),
      grossDebt: sum('grossDebt'),
      cash: sum('cash'),
      debtShareOfCapex: safeDiv(sum('debtRaised'), C),
      externalShareOfCapex: safeDiv(sum('cashDrawdown') + sum('debtRaised') + sum('equityRaised'), C),
      debtCapacityTotal: c.debtCapacityTotal,
      equityCapacityTotal: c.equityCapacityTotal,
      shareOfMarketDebtUsed: safeDiv(sum('debtRaised'), c.debtCapacityTotal),
      selfFunding: totalOcf - returns >= C,
      ...(fleet.extras || {})
    });
    lastScarcityRatio = fleet.scarcityRatio;
    current = null;
  }

  function finalize() {
    const selfFundingYear = {};
    tiers.forEach((t) => {
      const hit = tierRows[t.id].find((r) => r.selfFunding && r.capex > 0);
      selfFundingYear[t.id] = hit ? hit.year : null;
    });
    const sys = annual.find((r) => r.selfFunding && r.totalCapex > 0);
    selfFundingYear.system = sys ? sys.year : null;
    return {
      applyConstraint,
      marketCapacityMultiplier: { debt: mult.debt ?? 1, equity: mult.equity ?? 1 },
      years: annual,
      tiers: tierRows,
      tierMeta: tiers.map(({ id, name, note, share, maxDebtToEbitda }) => ({ id, name, note, share, maxDebtToEbitda })),
      selfFundingYear
    };
  }

  // This year's fundable capex ($B), Infinity when the constraint is off
  const fundableThisYear = () => (current && applyConstraint ? current.fundableCapex : Infinity);

  return { scalars, pathValue, startYear, allowance, fundableThisYear, recordMonth, closeYear, finalize };
}

/** Scarcity price premium: 1 + elasticity × unmet-demand ratio, capped */
export function scarcityPremium(scalars, scarcityRatio) {
  return Math.min(scalars.maxScarcityPremium, 1 + scalars.scarcityElasticity * Math.max(0, scarcityRatio || 0));
}
