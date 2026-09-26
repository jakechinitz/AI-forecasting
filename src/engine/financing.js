/**
 * Capital financing layer — port of AI_Capex_Funding_Model.xlsx.
 *
 * The physical engine (calculations.js) decides what CAN be built each month.
 * This module decides what can be PAID FOR, per calendar year, and returns a
 * monthly cap that the engine applies as one more gate in its weakest-link
 * rule (deployments = min(plan, GPU supply, components, funding)).
 *
 * Sheet mapping:
 *   Capital_Markets  → channelCapacity()
 *   Fleet_Economics  → unitEconomics()
 *   Capex            → monthly capex = $/GW × timing × (net-new GW + replacement GW × compute share)
 *   Funding          → startYear() (max fundable per tier) and closeYear() (waterfall)
 *   Dashboard        → annual rows in results.financing
 *
 * Non-circularity (same as the Excel): AI revenue is earned on the OPENING
 * fleet, scarcity premium uses the PRIOR year's unmet ratio, and fundable
 * capex depends only on opening balances.
 *
 * Fixes vs the Excel:
 *  1. Revenue is capped at demand: tokens sold = fleet capacity × min(1, required ÷ installed).
 *     The Excel billed full fleet output even when supply exceeded demand.
 *  2. A funding shortfall is booked against cash (cash can fall below its floor
 *     or go negative) instead of vanishing. With the funding gate on, the gate
 *     prevents shortfalls in the first place.
 */

const KWH_PER_GW_YEAR = 8.76e9;

const safeDiv = (a, b, fallback = 0) => (Math.abs(b) > 1e-12 ? a / b : fallback);

export function createFinancingModel(fin, { startYear: firstModelYear, pue }) {
  const scalars = fin.scalars;
  const tiers = fin.tiers.map((t) => ({ ...t }));
  const channels = fin.channels;
  const mult = fin.marketCapacityMultiplier || { debt: 1, equity: 1 };
  const applyConstraint = fin.applyFundingConstraint !== false;

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

  let basePrice = fin.baseYear?.blendedPricePerMTokens ?? 0.55;

  const annual = [];
  const tierRows = Object.fromEntries(tiers.map((t) => [t.id, []]));
  let current = null;

  function unitEconomics(year, ctx) {
    const util = pathValue('utilization', year);
    const capexPerGw = pathValue('capexPerGw', year);
    basePrice = basePrice * (1 + pathValue('priceChange', year));
    const premium = Math.min(scalars.maxScarcityPremium, 1 + scalars.scarcityElasticity * Math.max(0, ctx.priorScarcityRatio));
    const effPrice = basePrice * premium;

    const inferenceShare = Math.max(0, 1 - ctx.trainingShare);
    const servedFraction = Math.min(1, Math.max(0, ctx.servedFraction));

    const theoreticalRevPerGw = ctx.openingFleetTokPerKwhM * 1e6 * KWH_PER_GW_YEAR * effPrice / 1e15;
    const jensenRevPerGw = ctx.frontierTokPerKwhM * 1e6 * KWH_PER_GW_YEAR * effPrice / 1e15 * 0.95;
    const realizedRevPerGw = theoreticalRevPerGw * util * inferenceShare * servedFraction + scalars.otherRevenuePerGwYr;

    const energyPerGw = KWH_PER_GW_YEAR * pue * (scalars.idlePowerShare + (1 - scalars.idlePowerShare) * util) * scalars.electricityPricePerKwh / 1e9;
    const variablePerGw = realizedRevPerGw * scalars.variableCostPctOfRevenue;
    const ebitdaPerGw = realizedRevPerGw - variablePerGw - energyPerGw - scalars.otherOpexPerGwYr;
    const daPerGw = capexPerGw * scalars.computeShareOfCapex / scalars.computeLifeYears
      + capexPerGw * (1 - scalars.computeShareOfCapex) / scalars.facilityLifeYears;
    const ebitPerGw = ebitdaPerGw - daPerGw;
    const taxPerGw = Math.max(0, ebitPerGw) * scalars.cashTaxRate;
    const ocfPerGw = ebitdaPerGw - taxPerGw;

    return {
      util, capexPerGw, basePrice, premium, effPrice, inferenceShare, servedFraction,
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
      const interest = t.costOfDebt * ts.debt;
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
    const k = scalars.preSpendFraction;
    const timingFactor = (1 - k) + k * Math.max(0.8, Math.min(1.6, ctx.preSpendRatio || 1));

    current = {
      year, ctx, econ, openingGW, aiRevenue, aiEbitdaTotal, aiOcfTotal,
      debtCapacityTotal, equityCapacityTotal, tierPlans, fundableCapex, timingFactor,
      capexYTD: 0, newBuildCapex: 0, replacementCapex: 0,
      deployedGW: 0, replacementGW: 0, retiredGW: 0, lostToFundingGW: 0,
      bindingCounts: {}, monthsSeen: 0
    };
    return current;
  }

  /**
   * Maximum accelerators deployable this month given the year's remaining
   * fundable capex, paced evenly (cumulative YTD allowance).
   */
  function capForMonth({ monthOfYear, kwPerNewAccel, retiredGW }) {
    if (!current || !applyConstraint) return Infinity;
    const allowance = current.fundableCapex * ((monthOfYear + 1) / 12) - current.capexYTD;
    if (allowance <= 0) return 0;
    const perGw = current.econ.capexPerGw * current.timingFactor;
    const R = allowance / Math.max(perGw, 1e-9); // GW-equivalents at full cost
    const cs = scalars.computeShareOfCapex;
    const gw = R <= retiredGW * cs ? R / cs : retiredGW + (R - retiredGW * cs);
    return (gw * 1e6) / Math.max(kwPerNewAccel, 1e-9);
  }

  function recordMonth({ deployedGW, retiredGW, binding, lostToFundingGW }) {
    if (!current) return;
    const replacementGW = Math.min(deployedGW, retiredGW);
    const netNewGW = deployedGW - replacementGW;
    const perGw = current.econ.capexPerGw * current.timingFactor;
    const newBuild = netNewGW * perGw;
    const replacement = replacementGW * perGw * scalars.computeShareOfCapex;
    current.newBuildCapex += newBuild;
    current.replacementCapex += replacement;
    current.capexYTD += newBuild + replacement;
    current.deployedGW += deployedGW;
    current.replacementGW += replacementGW;
    current.retiredGW += retiredGW;
    current.lostToFundingGW += lostToFundingGW || 0;
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

    // Allocation (Demand_Build rows 34-44, in dollars)
    const base = tiers.map((t, i) => Math.min(c.tierPlans[i].maxFundable, t.share * C));
    const useFundableCaps = applyConstraint && C <= c.fundableCapex + 1e-6;
    let alloc;
    if (useFundableCaps) {
      const unallocated = Math.max(0, C - base.reduce((s, v) => s + v, 0));
      const slack = tiers.map((_, i) => Math.max(0, c.tierPlans[i].maxFundable - base[i]));
      const totalSlack = slack.reduce((s, v) => s + v, 0);
      alloc = base.map((b, i) => b + (totalSlack > 0 ? Math.min(slack[i], unallocated * slack[i] / totalSlack) : 0));
    } else {
      alloc = tiers.map((t) => t.share * C); // check-only mode: fixed shares
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
      const surplus = Math.max(0, -gap);

      ts.debt = openingDebt + debtRaised;
      ts.cash = openingCash - cashDrawdown - shortfall + surplus; // shortfall hits cash (fix #2)
      ts.legacyOcf = p.legacyOcf;
      ts.legacyEbitda = p.legacyEbitda;
      ts.gw = openingTierGw[i] * (1 - retireFrac) + (C > 0 ? c.deployedGW * capex / C : c.deployedGW * t.share);

      const marginal = shortfall > 0.01 ? 'UNFUNDED'
        : equityRaised > 0.01 ? 'Equity'
          : debtRaised > 0.01 ? 'Debt'
            : cashDrawdown > 0.01 ? 'Cash' : 'Self-funded';

      return {
        year: c.year, id: t.id, name: t.name,
        fleetShare: p.fleetShare, installedGW: ts.gw,
        legacyOcf: p.legacyOcf, aiOcf: p.aiOcf, interest: p.interest, ocf: p.ocf,
        shareholderReturns: t.shareholderReturns, capex,
        fundingGap: gap, cashDrawdown, debtRaised, equityRaised, shortfall,
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
      lostToFundingGW: c.lostToFundingGW,
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
      // Capex
      timingFactor: c.timingFactor,
      newBuildCapex: c.newBuildCapex,
      replacementCapex: c.replacementCapex,
      totalCapex: C,
      capexPerGwEnergized: safeDiv(C, c.deployedGW),
      // Funding (system)
      fundableCapex: c.fundableCapex,
      totalOcf, shareholderReturns: returns,
      interest: sum('interest'),
      cashDrawdown: sum('cashDrawdown'),
      debtRaised: sum('debtRaised'),
      equityRaised: sum('equityRaised'),
      shortfall: sum('shortfall'),
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

  return { startYear, capForMonth, recordMonth, closeYear, finalize, isActive: () => !!current };
}
