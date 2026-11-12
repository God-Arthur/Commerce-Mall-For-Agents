/**
 * 对照实验：同一批市场上比较 McAfee、VCG、边际中点价、按报价支付。
 * 要看的是三件事能不能同时成立：如实报价、平台不贴钱、成交接近有效。
 */
import { clearMarket } from "../src/mechanism/mcafee.ts";
import { makeRng, mean, round } from "./lib.ts";

interface Quote {
  id: string;
  report: number;
  truth: number;
}

interface Trade {
  buyerId: string;
  sellerId: string;
  buyerPays: number;
  sellerReceives: number;
}

interface Outcome {
  trades: Trade[];
  budget: number;
}

export interface MechanismStats {
  markets: number;
  subsidyMarkets: number;
  meanBudget: number;
  meanWelfareRatio: number;
  dsicViolations: number;
  dsicChecks: number;
  maxDeviationGain: number;
}

export interface BaselineStudy {
  seed: number;
  fixed: {
    vcgBilateralSubsidy: number;
    vcgTwoByTwoBudget: number;
    midpointGain: number;
    payAsBidGain: number;
    mcafeeGainOnMidpointExample: number;
    vcgGainOnBilateral: number;
  };
  random: Record<"mcafee" | "vcg" | "midpoint" | "payAsBid", MechanismStats>;
}

function byBid(quotes: Quote[]): Quote[] {
  return [...quotes].sort((a, b) => b.report - a.report || a.id.localeCompare(b.id));
}
function byAsk(quotes: Quote[]): Quote[] {
  return [...quotes].sort((a, b) => a.report - b.report || a.id.localeCompare(b.id));
}

function efficientK(buyers: Quote[], sellers: Quote[]): number {
  const vb = byBid(buyers);
  const sa = byAsk(sellers);
  let k = 0;
  while (k < vb.length && k < sa.length && vb[k]!.report >= sa[k]!.report) k++;
  return k;
}

function reportedWelfare(buyers: Quote[], sellers: Quote[]): number {
  const vb = byBid(buyers);
  const sa = byAsk(sellers);
  const k = efficientK(buyers, sellers);
  let w = 0;
  for (let i = 0; i < k; i++) w += vb[i]!.report - sa[i]!.report;
  return w;
}

function trueWelfare(buyers: Quote[], sellers: Quote[], trades: Trade[]): number {
  const b = new Map(buyers.map((q) => [q.id, q.truth]));
  const s = new Map(sellers.map((q) => [q.id, q.truth]));
  let w = 0;
  for (const t of trades) w += b.get(t.buyerId)! - s.get(t.sellerId)!;
  return w;
}

function budgetOf(trades: Trade[]): number {
  let b = 0;
  for (const t of trades) b += t.buyerPays - t.sellerReceives;
  return b;
}

function clearVcg(buyers: Quote[], sellers: Quote[]): Outcome {
  const vb = byBid(buyers);
  const sa = byAsk(sellers);
  const k = efficientK(buyers, sellers);
  const welfare = reportedWelfare(buyers, sellers);
  const trades: Trade[] = [];
  for (let i = 0; i < k; i++) {
    const buyer = vb[i]!;
    const seller = sa[i]!;
    const withoutBuyer = reportedWelfare(buyers.filter((q) => q.id !== buyer.id), sellers);
    const withoutSeller = reportedWelfare(buyers, sellers.filter((q) => q.id !== seller.id));
    trades.push({
      buyerId: buyer.id,
      sellerId: seller.id,
      buyerPays: withoutBuyer - (welfare - buyer.report),
      sellerReceives: seller.report + (welfare - withoutSeller),
    });
  }
  return { trades, budget: budgetOf(trades) };
}

function clearMidpoint(buyers: Quote[], sellers: Quote[]): Outcome {
  const vb = byBid(buyers);
  const sa = byAsk(sellers);
  const k = efficientK(buyers, sellers);
  if (k === 0) return { trades: [], budget: 0 };
  const price = (vb[k - 1]!.report + sa[k - 1]!.report) / 2;
  const trades: Trade[] = [];
  for (let i = 0; i < k; i++) {
    trades.push({
      buyerId: vb[i]!.id,
      sellerId: sa[i]!.id,
      buyerPays: price,
      sellerReceives: price,
    });
  }
  return { trades, budget: budgetOf(trades) };
}

function clearPayAsBid(buyers: Quote[], sellers: Quote[]): Outcome {
  const vb = byBid(buyers);
  const sa = byAsk(sellers);
  const k = efficientK(buyers, sellers);
  const trades: Trade[] = [];
  for (let i = 0; i < k; i++) {
    trades.push({
      buyerId: vb[i]!.id,
      sellerId: sa[i]!.id,
      buyerPays: vb[i]!.report,
      sellerReceives: sa[i]!.report,
    });
  }
  return { trades, budget: budgetOf(trades) };
}

function clearMcafee(buyers: Quote[], sellers: Quote[]): Outcome {
  const cleared = clearMarket(
    buyers.map((b) => ({ agentId: b.id, value: b.report, quantity: 1 })),
    sellers.map((s) => ({ agentId: s.id, cost: s.report, quantity: 1 })),
  );
  const trades: Trade[] = cleared.fills.map((f) => ({
    buyerId: f.buyerAgentId,
    sellerId: f.sellerAgentId,
    buyerPays: f.buyerPrice * f.quantity,
    sellerReceives: f.sellerPrice * f.quantity,
  }));
  return { trades, budget: budgetOf(trades) };
}

const MECHANISMS = {
  mcafee: clearMcafee,
  vcg: clearVcg,
  midpoint: clearMidpoint,
  payAsBid: clearPayAsBid,
} as const;

function utility(outcome: Outcome, id: string, side: "buyer" | "seller", truth: number): number {
  const trade = outcome.trades.find((t) => (side === "buyer" ? t.buyerId === id : t.sellerId === id));
  if (!trade) return 0;
  return side === "buyer" ? truth - trade.buyerPays : trade.sellerReceives - truth;
}

function bestGain(
  clear: (buyers: Quote[], sellers: Quote[]) => Outcome,
  buyers: Quote[],
  sellers: Quote[],
  side: "buyer" | "seller",
  index: number,
  reports: number[],
): number {
  const pool = side === "buyer" ? buyers : sellers;
  const agent = pool[index]!;
  const honestQuotes = side === "buyer" ? buyers : sellers;
  const baseline = utility(
    clear(buyers, sellers),
    agent.id,
    side,
    agent.truth,
  );
  let best = 0;
  for (const report of reports) {
    if (report === agent.report) continue;
    const next = honestQuotes.map((q, i) => (i === index ? { ...q, report } : q));
    const gain = utility(
      clear(side === "buyer" ? next : buyers, side === "buyer" ? sellers : next),
      agent.id,
      side,
      agent.truth,
    ) - baseline;
    if (gain > best) best = gain;
  }
  return best;
}

function quote(id: string, value: number): Quote {
  return { id, report: value, truth: value };
}

export function runBaselineStudy(opts?: { seed?: number; markets?: number; traders?: number }): BaselineStudy {
  const seed = opts?.seed ?? 20261112;
  const markets = opts?.markets ?? 200;
  const traders = opts?.traders ?? 6;
  const rng = makeRng(seed);

  const bilateralBuyers = [quote("b", 10)];
  const bilateralSellers = [quote("s", 5)];
  const vcgBi = clearVcg(bilateralBuyers, bilateralSellers);

  const twoBuyers = [quote("b1", 10), quote("b2", 8)];
  const twoSellers = [quote("s1", 1), quote("s2", 5)];
  const vcg22 = clearVcg(twoBuyers, twoSellers);

  const midBuyers = [quote("b1", 10), quote("b2", 6)];
  const midSellers = [quote("s1", 4), quote("s2", 5)];
  const midpointGain = bestGain(clearMidpoint, midBuyers, midSellers, "buyer", 1, [5.4, 5.2, 7, 9]);
  const payAsBidGain = bestGain(clearPayAsBid, midBuyers, midSellers, "buyer", 1, [5.1, 5.4, 5.8]);
  const mcafeeGain = Math.max(
    bestGain(clearMcafee, midBuyers, midSellers, "buyer", 0, [0, 4, 6, 8, 12, 20]),
    bestGain(clearMcafee, midBuyers, midSellers, "buyer", 1, [0, 4, 5.4, 8, 12, 20]),
    bestGain(clearMcafee, midBuyers, midSellers, "seller", 0, [0, 2, 6, 8, 12]),
    bestGain(clearMcafee, midBuyers, midSellers, "seller", 1, [0, 3, 6, 8, 12]),
  );
  const vcgGain = Math.max(
    bestGain(clearVcg, bilateralBuyers, bilateralSellers, "buyer", 0, [0, 4, 6, 8, 12, 20]),
    bestGain(clearVcg, bilateralBuyers, bilateralSellers, "seller", 0, [0, 2, 7, 9, 15]),
  );

  const stats = {
    mcafee: emptyStats(),
    vcg: emptyStats(),
    midpoint: emptyStats(),
    payAsBid: emptyStats(),
  };

  const budgets: Record<keyof typeof stats, number[]> = {
    mcafee: [], vcg: [], midpoint: [], payAsBid: [],
  };
  const ratios: Record<keyof typeof stats, number[]> = {
    mcafee: [], vcg: [], midpoint: [], payAsBid: [],
  };

  for (let m = 0; m < markets; m++) {
    const buyers = Array.from({ length: traders }, (_, i) => quote(`b${i}`, 1 + rng() * 20));
    const sellers = Array.from({ length: traders }, (_, i) => quote(`s${i}`, rng() * 12));
    const eff = reportedWelfare(buyers, sellers);

    for (const name of Object.keys(MECHANISMS) as Array<keyof typeof MECHANISMS>) {
      const clear = MECHANISMS[name];
      const outcome = clear(buyers, sellers);
      budgets[name].push(outcome.budget);
      if (outcome.budget < -1e-8) stats[name].subsidyMarkets++;
      if (eff > 1e-9) ratios[name].push(trueWelfare(buyers, sellers, outcome.trades) / eff);

      for (let i = 0; i < buyers.length; i++) {
        const gain = bestGain(clear, buyers, sellers, "buyer", i, altReports(buyers[i]!.truth));
        stats[name].dsicChecks++;
        if (gain > stats[name].maxDeviationGain) stats[name].maxDeviationGain = gain;
        if (gain > 1e-6) stats[name].dsicViolations++;
      }
      for (let i = 0; i < sellers.length; i++) {
        const gain = bestGain(clear, buyers, sellers, "seller", i, altReports(sellers[i]!.truth));
        stats[name].dsicChecks++;
        if (gain > stats[name].maxDeviationGain) stats[name].maxDeviationGain = gain;
        if (gain > 1e-6) stats[name].dsicViolations++;
      }
    }
  }

  for (const name of Object.keys(stats) as Array<keyof typeof stats>) {
    stats[name].markets = markets;
    stats[name].meanBudget = round(mean(budgets[name]), 4);
    stats[name].meanWelfareRatio = round(mean(ratios[name]), 4);
    stats[name].maxDeviationGain = round(stats[name].maxDeviationGain, 6);
  }

  return {
    seed,
    fixed: {
      vcgBilateralSubsidy: round(-(vcgBi.budget), 6),
      vcgTwoByTwoBudget: round(vcg22.budget, 6),
      midpointGain: round(midpointGain, 6),
      payAsBidGain: round(payAsBidGain, 6),
      mcafeeGainOnMidpointExample: round(mcafeeGain, 6),
      vcgGainOnBilateral: round(vcgGain, 6),
    },
    random: stats,
  };
}

function emptyStats(): MechanismStats {
  return {
    markets: 0,
    subsidyMarkets: 0,
    meanBudget: 0,
    meanWelfareRatio: 0,
    dsicViolations: 0,
    dsicChecks: 0,
    maxDeviationGain: 0,
  };
}

function altReports(truth: number): number[] {
  return [0, truth * 0.5, truth * 0.8, truth * 1.2, truth * 1.6, Math.max(0, truth - 2), truth + 4];
}
