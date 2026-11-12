/**
 * 闭环实验：上架、入围、评价、价格表出价、出清回填、事后反馈，连续多轮。
 * 商家成本来自同一分布，排名差只来自评价和成交结果，不来自谁更便宜。
 */
import { MarketEngine } from "../src/engine.ts";
import { RewardService } from "../src/reward/service.ts";
import { DEFAULT_REWARD_CONFIG } from "../src/reward/domain.ts";
import { answersForValue, elicitReservation } from "../src/elicitation/price-list.ts";
import { clearMarket } from "../src/mechanism/mcafee.ts";
import { clamp01, makeRng, pearson, round } from "./lib.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const GRID = Array.from({ length: 21 }, (_, i) => i * 2);

interface Spec {
  name: string;
  fit: number;
  noise: number;
  /** 买家事先没有这个需求的概率 */
  pDiscover: number;
  durability: number;
  regretBelow: number;
}

const MERCHANTS: Spec[] = [
  { name: "innovator", fit: 0.9, noise: 0.04, pDiscover: 0.75, durability: 0.92, regretBelow: 0.72 },
  { name: "spammer", fit: 0.25, noise: 0.08, pDiscover: 0.6, durability: 0.4, regretBelow: 0.72 },
  { name: "bland", fit: 0.55, noise: 0.04, pDiscover: 0.08, durability: 0.95, regretBelow: 0.5 },
  { name: "fit-only", fit: 0.94, noise: 0.02, pDiscover: 0, durability: 0.88, regretBelow: 0.7 },
  { name: "fake-discovery", fit: 0.42, noise: 0.05, pDiscover: 0.85, durability: 0.5, regretBelow: 0.7 },
];

export interface ClosedLoopStudy {
  seeds: number;
  rounds: number;
  buyers: number;
  innovatorFirst: number;
  innovatorAheadOfSpammer: number;
  innovatorAheadOfFitOnly: number;
  meanFinalRank: Record<string, number>;
  meanProductPower: Record<string, number>;
  meanDiscovery: Record<string, number>;
  lateImpressionShare: Record<string, number>;
  priceFitCorrelation: number | null;
  /** 真实价值正好落在价格表上时，改答别的格子不会提高效用。 */
  elicitationOnGrid: { checks: number; violations: number };
  /**
   * 真实价值落在两格之间时，诚实答案是「不超过真值的最高格」。
   * 这不是 McAfee 的漏洞，是价格表把真值量化之后留下的缝隙。
   */
  elicitationOffGrid: { checks: number; violations: number; maxGain: number };
}

function oneSeed(seed: number, rounds: number, buyerCount: number) {
  const end = START + (rounds - 1) * DAY;
  const engine = new MarketEngine();
  const reward = new RewardService(engine, DEFAULT_REWARD_CONFIG, () => end);
  const rng = makeRng(seed);
  const merchants = MERCHANTS.map((spec) => ({
    spec,
    agent: engine.registerAgent("seller", spec.name).agent,
  }));
  const buyers = Array.from({ length: buyerCount }, (_, i) =>
    engine.registerAgent("buyer", `buyer-${String(i).padStart(2, "0")}`).agent,
  );

  const late = new Map<string, number>();
  const prices: number[] = [];
  const fits: number[] = [];

  for (let t = 0; t < rounds; t++) {
    const roundId = `r${t}`;
    const at = START + t * DAY;
    engine.createRound(roundId);
    merchants.forEach((m, i) => {
      const cost = 8 + rng() * 6 + (i + 1) * 1e-9;
      engine.submitAsk(roundId, m.agent, cost, 1);
      reward.registerListing({ roundId, merchant: m.agent, productId: m.spec.name });
    });

    const seenFit = new Map<string, Map<string, number>>();
    let fitSum = 0;
    let fitN = 0;
    buyers.forEach((buyer, i) => {
      const list = reward.shortlistFor(roundId, buyer, 3, at);
      const mine = new Map<string, number>();
      for (const candidate of list.candidates) {
        const merchant = merchants.find((m) => m.agent.id === candidate.merchantId)!;
        const fit = clamp01(merchant.spec.fit + (rng() * 2 - 1) * merchant.spec.noise);
        reward.recordEvaluation({
          roundId,
          buyer,
          merchantId: candidate.merchantId,
          productId: candidate.productId,
          priorIntent: rng() >= merchant.spec.pDiscover,
          fitEval: fit,
          submittedAt: at,
        });
        mine.set(candidate.merchantId, fit);
        fitSum += fit;
        fitN++;
        if (t >= rounds - 3) late.set(merchant.spec.name, (late.get(merchant.spec.name) ?? 0) + 1);
      }
      seenFit.set(buyer.id, mine);
      const value = 16 + rng() * 22 + (i + 1) * 1e-9;
      const bid = elicitReservation(answersForValue(value, GRID));
      if (bid !== null) engine.submitBid(roundId, buyer, bid, 1);
    });

    const result = engine.clearRound(roundId);
    reward.ingestClearing(result);
    if (result.clearingPriceBuyer !== null && fitN > 0) {
      prices.push(result.clearingPriceBuyer);
      fits.push(fitSum / fitN);
    }
    for (const settlement of result.settlements) {
      const fit = seenFit.get(settlement.buyerAgentId)?.get(settlement.sellerAgentId);
      if (fit === undefined) continue;
      const merchant = merchants.find((m) => m.agent.id === settlement.sellerAgentId)!;
      const buyer = buyers.find((b) => b.id === settlement.buyerAgentId)!;
      reward.submitFeedback({
        roundId,
        buyer,
        productId: merchant.spec.name,
        noRegret: fit >= merchant.spec.regretBelow,
        delayedFitEval: clamp01(fit * merchant.spec.durability),
      });
    }
  }

  const ranked = merchants
    .map((m) => ({ name: m.spec.name, score: reward.scoreOf(m.agent.id) }))
    .sort((a, b) => b.score.merchantRank - a.score.merchantRank || a.name.localeCompare(b.name));

  return { ranked, late, prices, fits };
}

/**
 * 价格表的激励检验分成两截。
 * 真值在格子上：占优策略应严格成立。
 * 真值在格子之间：报告量化缝隙有多大，不把它算成机制失败。
 */
export function elicitationDeviationCheck(markets: number, seed: number): {
  onGrid: { checks: number; violations: number };
  offGrid: { checks: number; violations: number; maxGain: number };
} {
  const rng = makeRng(seed);
  const onGrid = { checks: 0, violations: 0 };
  const offGrid = { checks: 0, violations: 0, maxGain: 0 };
  const interior = GRID.filter((price) => price >= 4 && price <= 36);

  for (let m = 0; m < markets; m++) {
    const others = [4 + rng() * 30, 4 + rng() * 30];
    const asks = [rng() * 10, 4 + rng() * 12, 10 + rng() * 16];
    const payoff = (bid: number | null, truth: number): number => {
      if (bid === null) return 0;
      const bidList = [
        { agentId: "me", value: bid, quantity: 1 },
        ...others.map((value, i) => ({ agentId: `b${i}`, value, quantity: 1 })),
      ];
      const sellerAsks = asks.map((cost, i) => ({ agentId: `s${i}`, cost, quantity: 1 }));
      const cleared = clearMarket(bidList, sellerAsks);
      const ranked = [...bidList].sort((a, b) => b.value - a.value || a.agentId.localeCompare(b.agentId));
      const won = ranked.slice(0, cleared.tradedQuantity).some((b) => b.agentId === "me");
      return won ? truth - cleared.clearingPriceBuyer! : 0;
    };

    const truthOn = interior[Math.floor(rng() * interior.length)]!;
    const honestOn = elicitReservation(answersForValue(truthOn, GRID));
    const honestPay = payoff(honestOn, truthOn);
    for (const reported of GRID) {
      if (reported === truthOn) continue;
      onGrid.checks++;
      const bid = elicitReservation(answersForValue(reported, GRID));
      if (payoff(bid, truthOn) > honestPay + 1e-8) onGrid.violations++;
    }

    const truthOff = 3 + rng() * 34;
    const honestOffBid = elicitReservation(answersForValue(truthOff, GRID));
    const honestOffPay = payoff(honestOffBid, truthOff);
    for (const reported of GRID) {
      offGrid.checks++;
      const bid = elicitReservation(answersForValue(reported, GRID));
      const gain = payoff(bid, truthOff) - honestOffPay;
      if (gain > offGrid.maxGain) offGrid.maxGain = gain;
      if (gain > 1e-8) offGrid.violations++;
    }
  }
  offGrid.maxGain = Math.round(offGrid.maxGain * 1e6) / 1e6;
  return { onGrid, offGrid };
}

export function runClosedLoop(opts?: {
  seeds?: number;
  rounds?: number;
  buyers?: number;
  seed?: number;
  elicitationMarkets?: number;
}): ClosedLoopStudy {
  const seeds = opts?.seeds ?? 12;
  const rounds = opts?.rounds ?? 8;
  const buyers = opts?.buyers ?? 16;
  const seed0 = opts?.seed ?? 7;
  const rankSum: Record<string, number> = {};
  const powerSum: Record<string, number> = {};
  const discoverySum: Record<string, number> = {};
  const lateSum: Record<string, number> = {};
  for (const m of MERCHANTS) {
    rankSum[m.name] = 0;
    powerSum[m.name] = 0;
    discoverySum[m.name] = 0;
    lateSum[m.name] = 0;
  }
  let innovatorFirst = 0;
  let innovatorAheadOfSpammer = 0;
  let innovatorAheadOfFitOnly = 0;
  const prices: number[] = [];
  const fits: number[] = [];

  for (let s = 0; s < seeds; s++) {
    const run = oneSeed(seed0 + s * 97, rounds, buyers);
    prices.push(...run.prices);
    fits.push(...run.fits);
    run.ranked.forEach((row, index) => {
      rankSum[row.name] = (rankSum[row.name] ?? 0) + index;
      powerSum[row.name] = (powerSum[row.name] ?? 0) + row.score.productPowerScore;
      discoverySum[row.name] = (discoverySum[row.name] ?? 0) + row.score.discoveryScore;
    });
    if (run.ranked[0]?.name === "innovator") innovatorFirst++;
    const pos = new Map(run.ranked.map((row, index) => [row.name, index]));
    if ((pos.get("innovator") ?? 9) < (pos.get("spammer") ?? -1)) innovatorAheadOfSpammer++;
    if ((pos.get("innovator") ?? 9) < (pos.get("fit-only") ?? -1)) innovatorAheadOfFitOnly++;
    for (const [name, count] of run.late) lateSum[name] = (lateSum[name] ?? 0) + count;
  }

  const lateTotal = Object.values(lateSum).reduce((s, n) => s + n, 0);
  const avg = (table: Record<string, number>) =>
    Object.fromEntries(MERCHANTS.map((m) => [m.name, round((table[m.name] ?? 0) / seeds, 4)]));
  const elicitation = elicitationDeviationCheck(opts?.elicitationMarkets ?? 60, seed0 + 999);

  return {
    seeds,
    rounds,
    buyers,
    innovatorFirst,
    innovatorAheadOfSpammer,
    innovatorAheadOfFitOnly,
    meanFinalRank: avg(rankSum),
    meanProductPower: avg(powerSum),
    meanDiscovery: avg(discoverySum),
    lateImpressionShare: Object.fromEntries(
      MERCHANTS.map((m) => [m.name, round(lateTotal === 0 ? 0 : (lateSum[m.name] ?? 0) / lateTotal, 4)]),
    ),
    priceFitCorrelation: (() => {
      const r = pearson(prices, fits);
      return r === null ? null : round(r, 4);
    })(),
    elicitationOnGrid: elicitation.onGrid,
    elicitationOffGrid: elicitation.offGrid,
  };
}
