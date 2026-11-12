/**
 * 机制实验：大市场里的占优策略、以及「至多牺牲一笔」在市场变厚之后还剩多少福利。
 * 直接调用生产代码 clearMarket。
 */
import { clearMarket } from "../src/mechanism/mcafee.ts";
import { makeRng, mean, round } from "./lib.ts";

export interface SizeRow {
  tradersPerSide: number;
  markets: number;
  dsicChecks: number;
  dsicViolations: number;
  maxDeviationGain: number;
  meanEfficiencyLoss: number;
  maxEfficiencyLoss: number;
  meanWelfareLossRatio: number;
  budgetViolations: number;
  irViolations: number;
}

export interface MechanismStudy {
  seed: number;
  sizes: SizeRow[];
  dsicChecks: number;
  dsicViolations: number;
  maxDeviationGain: number;
}

const EPS = 1e-8;

function surplus(bids: number[], asks: number[], units: number): number {
  const vb = [...bids].sort((a, b) => b - a);
  const sa = [...asks].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i < units; i++) total += vb[i]! - sa[i]!;
  return total;
}

function efficientUnits(bids: number[], asks: number[]): number {
  const vb = [...bids].sort((a, b) => b - a);
  const sa = [...asks].sort((a, b) => a - b);
  let k = 0;
  const m = Math.min(vb.length, sa.length);
  while (k < m && vb[k]! >= sa[k]!) k++;
  return k;
}

function payoff(
  bids: number[],
  asks: number[],
  side: "buyer" | "seller",
  index: number,
  report: number,
): number {
  const bidQuotes = bids.map((value, i) => ({
    agentId: `b${i}`,
    value: side === "buyer" && i === index ? report : value,
    quantity: 1,
  }));
  const askQuotes = asks.map((cost, i) => ({
    agentId: `s${i}`,
    cost: side === "seller" && i === index ? report : cost,
    quantity: 1,
  }));
  const cleared = clearMarket(bidQuotes, askQuotes);
  const me = side === "buyer" ? `b${index}` : `s${index}`;
  const ranked = (side === "buyer" ? bidQuotes : askQuotes)
    .slice()
    .sort((a, b) => {
      const pa = "value" in a ? a.value : a.cost;
      const pb = "value" in b ? b.value : b.cost;
      const priceCmp = side === "buyer" ? pb - pa : pa - pb;
      return priceCmp || a.agentId.localeCompare(b.agentId);
    })
    .map((q) => q.agentId);
  const won = ranked.slice(0, cleared.tradedQuantity).includes(me);
  if (!won) return 0;
  return side === "buyer"
    ? bids[index]! - cleared.clearingPriceBuyer!
    : cleared.clearingPriceSeller! - asks[index]!;
}

function deviations(truth: number, others: number[]): number[] {
  const set = new Set<number>([
    0,
    truth * 0.5,
    truth * 0.85,
    truth * 1.15,
    truth * 1.5,
    truth * 2,
    Math.max(0, truth - 3),
    truth + 3,
  ]);
  for (const o of others) set.add(o);
  set.delete(truth);
  return [...set];
}

export function runMechanismStudy(opts?: {
  seed?: number;
  marketsPerSize?: number;
  sizes?: number[];
}): MechanismStudy {
  const seed = opts?.seed ?? 20261112;
  const marketsPerSize = opts?.marketsPerSize ?? 80;
  const sizes = opts?.sizes ?? [2, 4, 8, 16, 32];
  const rng = makeRng(seed);
  const rows: SizeRow[] = [];

  for (const n of sizes) {
    let checks = 0;
    let violations = 0;
    let maxGain = 0;
    const lossUnits: number[] = [];
    const lossRatios: number[] = [];
    let budgetBad = 0;
    let irBad = 0;

    for (let m = 0; m < marketsPerSize; m++) {
      const bids = Array.from({ length: n }, () => 1 + rng() * 30);
      const asks = Array.from({ length: n }, () => rng() * 20);
      const cleared = clearMarket(
        bids.map((value, i) => ({ agentId: `b${i}`, value, quantity: 1 })),
        asks.map((cost, i) => ({ agentId: `s${i}`, cost, quantity: 1 })),
      );
      lossUnits.push(cleared.efficiencyLoss);
      const eff = surplus(bids, asks, efficientUnits(bids, asks));
      const got = surplus(bids, asks, cleared.tradedQuantity);
      if (eff > 1e-9) lossRatios.push((eff - got) / eff);

      const buyerBill = (cleared.clearingPriceBuyer ?? 0) * cleared.tradedQuantity;
      const sellerReceipt = (cleared.clearingPriceSeller ?? 0) * cleared.tradedQuantity;
      if (buyerBill + EPS < sellerReceipt) budgetBad++;

      const vb = [...bids].sort((a, b) => b - a);
      const sa = [...asks].sort((a, b) => a - b);
      for (let i = 0; i < cleared.tradedQuantity; i++) {
        if (cleared.clearingPriceBuyer! > vb[i]! + EPS) irBad++;
        if (cleared.clearingPriceSeller! + EPS < sa[i]!) irBad++;
      }

      for (let i = 0; i < n; i++) {
        const honestB = payoff(bids, asks, "buyer", i, bids[i]!);
        for (const report of deviations(bids[i]!, asks)) {
          checks++;
          const gain = payoff(bids, asks, "buyer", i, report) - honestB;
          if (gain > maxGain) maxGain = gain;
          if (gain > EPS) violations++;
        }
        const honestS = payoff(bids, asks, "seller", i, asks[i]!);
        for (const report of deviations(asks[i]!, bids)) {
          checks++;
          const gain = payoff(bids, asks, "seller", i, report) - honestS;
          if (gain > maxGain) maxGain = gain;
          if (gain > EPS) violations++;
        }
      }
    }

    rows.push({
      tradersPerSide: n,
      markets: marketsPerSize,
      dsicChecks: checks,
      dsicViolations: violations,
      maxDeviationGain: round(maxGain, 8),
      meanEfficiencyLoss: round(mean(lossUnits), 4),
      maxEfficiencyLoss: Math.max(...lossUnits),
      meanWelfareLossRatio: round(mean(lossRatios), 4),
      budgetViolations: budgetBad,
      irViolations: irBad,
    });
  }

  return {
    seed,
    sizes: rows,
    dsicChecks: rows.reduce((s, r) => s + r.dsicChecks, 0),
    dsicViolations: rows.reduce((s, r) => s + r.dsicViolations, 0),
    maxDeviationGain: round(Math.max(...rows.map((r) => r.maxDeviationGain)), 8),
  };
}
