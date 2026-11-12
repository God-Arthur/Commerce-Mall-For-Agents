/**
 * 奖励层实验。
 * 多种子重跑五类商家对抗，并做消融：几何平均、null 重归一化、精度惩罚、成交回填、展示稀释。
 */
import { evaluationKeyOf, rankOf, ScoringEngine } from "../src/reward/scoring.ts";
import {
  DEFAULT_REWARD_CONFIG,
  type Evaluation,
  type OutcomeRecord,
} from "../src/reward/domain.ts";
import { makeRng, mean, round } from "./lib.ts";

export interface Strategy {
  id: string;
  label: string;
  impressions: number;
  spanDays: number;
  pNoPrior: number;
  fitLow: number;
  fitHigh: number;
  pTrade: number;
  pRegret: number;
  pRepeat: number;
  durability: number;
}

/** 与 scripts/simulate-reward.ts 的五类策略同一组参数。 */
export const STRATEGIES: Strategy[] = [
  { id: "innovator", label: "真创新者", impressions: 60, spanDays: 100, pNoPrior: 0.72, fitLow: 0.8, fitHigh: 0.95, pTrade: 0.82, pRegret: 0.05, pRepeat: 0.42, durability: 0.9 },
  { id: "spammer", label: "刷分/广撒网", impressions: 420, spanDays: 110, pNoPrior: 0.5, fitLow: 0.1, fitHigh: 0.4, pTrade: 0.15, pRegret: 0.45, pRepeat: 0.03, durability: 0.45 },
  { id: "bland", label: "安全但平庸", impressions: 55, spanDays: 100, pNoPrior: 0.15, fitLow: 0.5, fitHigh: 0.65, pTrade: 0.65, pRegret: 0, pRepeat: 0, durability: 1 },
  { id: "fit-only", label: "只优化 fit", impressions: 45, spanDays: 95, pNoPrior: 0, fitLow: 0.9, fitHigh: 0.96, pTrade: 0.75, pRegret: 0.15, pRepeat: 0, durability: 0.88 },
  { id: "fake-discovery", label: "只优化发现率", impressions: 150, spanDays: 100, pNoPrior: 0.8, fitLow: 0.28, fitHigh: 0.5, pTrade: 0.28, pRegret: 0.3, pRepeat: 0.08, durability: 0.5 },
];

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);
const GMV = 10_000;

export interface TournamentStudy {
  seeds: number;
  gmv: number;
  firstPlace: Record<string, number>;
  meanRank: Record<string, number>;
  meanProductPower: Record<string, number>;
  meanDiscovery: Record<string, number>;
  meanNet: Record<string, number>;
  innovatorBeatsSpammer: number;
  innovatorBeatsBland: number;
  singleMetricNeverFirst: number;
}

function populate(engine: ScoringEngine, strategy: Strategy, seed: number, withOutcomes: boolean): void {
  const rng = makeRng(seed);
  for (let i = 0; i < strategy.impressions; i++) {
    const submittedAt = NOW - rng() * strategy.spanDays * DAY;
    const evaluation: Evaluation = {
      roundId: "sim",
      merchantId: strategy.id,
      productId: `${strategy.id}-p${i % 7}`,
      buyerAgentId: `${strategy.id}-b${i}`,
      priorIntent: rng() >= strategy.pNoPrior,
      fitEval: strategy.fitLow + rng() * (strategy.fitHigh - strategy.fitLow),
      submittedAt,
    };
    engine.appendEvaluation(evaluation);
    if (!withOutcomes || rng() >= strategy.pTrade) continue;
    const outcome: OutcomeRecord = {
      evaluationKey: evaluationKeyOf(evaluation),
      merchantId: strategy.id,
      buyerAgentId: evaluation.buyerAgentId,
      productId: evaluation.productId,
      traded: true,
      noRegret: rng() >= strategy.pRegret,
      repeat: rng() < strategy.pRepeat,
      delayedFitEval: rng() < 0.4 ? Math.min(1, evaluation.fitEval * strategy.durability) : null,
      recordedAt: submittedAt,
    };
    engine.appendOutcome(outcome);
  }
}

export function runTournament(opts?: { seeds?: number; seed?: number }): TournamentStudy {
  const seeds = opts?.seeds ?? 40;
  const seed0 = opts?.seed ?? 1000;
  const firstPlace: Record<string, number> = {};
  const ranks: Record<string, number[]> = {};
  const power: Record<string, number[]> = {};
  const discovery: Record<string, number[]> = {};
  const net: Record<string, number[]> = {};
  for (const s of STRATEGIES) {
    firstPlace[s.id] = 0;
    ranks[s.id] = [];
    power[s.id] = [];
    discovery[s.id] = [];
    net[s.id] = [];
  }
  let innovatorBeatsSpammer = 0;
  let innovatorBeatsBland = 0;
  let singleMetricNeverFirst = 0;

  for (let s = 0; s < seeds; s++) {
    const engine = new ScoringEngine(DEFAULT_REWARD_CONFIG, () => NOW);
    STRATEGIES.forEach((strategy, i) => populate(engine, strategy, seed0 + s * 100 + i, true));
    const ranked = engine.rankAll();
    const winner = ranked[0]?.merchantId;
    if (winner) firstPlace[winner] = (firstPlace[winner] ?? 0) + 1;
    if (winner !== "fit-only" && winner !== "fake-discovery") singleMetricNeverFirst++;
    const byId = new Map(ranked.map((r) => [r.merchantId, r]));
    if ((byId.get("innovator")?.position ?? 99) < (byId.get("spammer")?.position ?? -1)) innovatorBeatsSpammer++;
    if ((byId.get("innovator")?.position ?? 99) < (byId.get("bland")?.position ?? -1)) innovatorBeatsBland++;
    for (const row of ranked) {
      ranks[row.merchantId]?.push(row.position);
      power[row.merchantId]?.push(row.score.productPowerScore);
      discovery[row.merchantId]?.push(row.score.discoveryScore);
      net[row.merchantId]?.push(GMV * (1 - row.score.takeRate) + row.score.discoveryBonus);
    }
  }

  const avg = (table: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(table).map(([k, xs]) => [k, round(mean(xs), 4)]));

  return {
    seeds,
    gmv: GMV,
    firstPlace,
    meanRank: avg(ranks),
    meanProductPower: avg(power),
    meanDiscovery: avg(discovery),
    meanNet: avg(net),
    innovatorBeatsSpammer,
    innovatorBeatsBland,
    singleMetricNeverFirst,
  };
}

export interface AblationStudy {
  geometric: { innovator: number; discoveryOnly: number; fitOnly: number };
  linear: { innovator: number; discoveryOnly: number; fitOnly: number };
  missingOutcomes: { renormalized: number; asZero: number };
  outcomeGap: {
    innovatorPowerWith: number;
    spammerPowerWith: number;
    innovatorNoRegretWith: number | null;
    spammerNoRegretWith: number | null;
    innovatorNoRegretWithout: number | null;
    spammerNoRegretWithout: number | null;
  };
  precisionPenalty: { withPenalty: number; withoutPenalty: number };
  impressionDilution: { focusedPrecision: number; sprayedPrecision: number };
  recency: { fresh: number; halfLifeAgo: number };
}

export function runAblations(): AblationStudy {
  const innovator = rankOf(0.85, 0.55);
  const discoveryOnly = rankOf(0.05, 1);
  const fitOnly = rankOf(0.95, 0);
  const linear = (p: number, d: number) => 0.7 * p + 0.3 * d;

  const now = NOW;
  const partial = new ScoringEngine(DEFAULT_REWARD_CONFIG, () => now);
  for (let i = 0; i < 8; i++) {
    partial.appendEvaluation({
      roundId: "r",
      merchantId: "partial",
      productId: `p${i}`,
      buyerAgentId: `b${i}`,
      priorIntent: true,
      fitEval: 0.92,
      submittedAt: now,
    });
  }
  const renormalized = partial.score("partial").productPowerScore;
  const fit = partial.score("partial").metrics.realizedFitMean ?? 0;
  const asZero =
    DEFAULT_REWARD_CONFIG.weights.realizedFitMean * fit +
    DEFAULT_REWARD_CONFIG.weights.noRegretRate * 0 +
    DEFAULT_REWARD_CONFIG.weights.repeatRate * 0 +
    DEFAULT_REWARD_CONFIG.weights.durability * 0;

  const withEngine = new ScoringEngine(DEFAULT_REWARD_CONFIG, () => now);
  const withoutEngine = new ScoringEngine(DEFAULT_REWARD_CONFIG, () => now);
  for (const strategy of STRATEGIES) {
    if (strategy.id !== "innovator" && strategy.id !== "spammer") continue;
    populate(withEngine, strategy, 42, true);
    populate(withoutEngine, strategy, 42, false);
  }
  const snap = (engine: ScoringEngine, id: string) => {
    const score = engine.score(id);
    return {
      power: score.productPowerScore,
      noRegret: score.metrics.noRegretRate,
    };
  };
  const innovatorWith = snap(withEngine, "innovator");
  const spammerWith = snap(withEngine, "spammer");
  const innovatorWithout = snap(withoutEngine, "innovator");
  const spammerWithout = snap(withoutEngine, "spammer");

  const sprayed = new ScoringEngine(DEFAULT_REWARD_CONFIG, () => now);
  const focused = new ScoringEngine(DEFAULT_REWARD_CONFIG, () => now);
  for (let i = 0; i < 20; i++) {
    const evaluation: Evaluation = {
      roundId: "r",
      merchantId: "wide",
      productId: `p${i}`,
      buyerAgentId: `b${i}`,
      priorIntent: i < 4,
      fitEval: i < 4 ? 0.3 : 0.9,
      submittedAt: now,
    };
    // 4 条低质量「假装发现」够不上阈值，6 条真实发现，其余是老需求。
    const real: Evaluation = {
      ...evaluation,
      merchantId: "wide",
      priorIntent: i < 6 ? false : true,
      fitEval: i < 6 ? 0.9 : 0.4,
    };
    sprayed.appendEvaluation(real);
    focused.appendEvaluation({ ...real, merchantId: "tight" });
  }
  for (let i = 0; i < 100; i++) sprayed.appendImpression("wide", now);
  const wideScore = sprayed.score("wide");
  const penalty = precisionMultiplier(
    wideScore.discovery.discoveryPrecision,
    wideScore.discovery.totalImpressions,
  );

  const fresh = new ScoringEngine(DEFAULT_REWARD_CONFIG, () => now);
  const stale = new ScoringEngine(DEFAULT_REWARD_CONFIG, () => now);
  for (let i = 0; i < 10; i++) {
    fresh.appendEvaluation({
      roundId: "r", merchantId: "fresh", productId: `p${i}`, buyerAgentId: `b${i}`,
      priorIntent: true, fitEval: 1, submittedAt: now,
    });
    stale.appendEvaluation({
      roundId: "r", merchantId: "stale", productId: `p${i}`, buyerAgentId: `b${i}`,
      priorIntent: true, fitEval: 1,
      submittedAt: now - DEFAULT_REWARD_CONFIG.halfLifeDays * DAY,
    });
  }

  return {
    geometric: { innovator: round(innovator, 4), discoveryOnly: round(discoveryOnly, 4), fitOnly: round(fitOnly, 4) },
    linear: {
      innovator: round(linear(0.85, 0.55), 4),
      discoveryOnly: round(linear(0.05, 1), 4),
      fitOnly: round(linear(0.95, 0), 4),
    },
    missingOutcomes: { renormalized: round(renormalized, 4), asZero: round(asZero, 4) },
    outcomeGap: {
      innovatorPowerWith: round(innovatorWith.power, 4),
      spammerPowerWith: round(spammerWith.power, 4),
      innovatorNoRegretWith: innovatorWith.noRegret === null ? null : round(innovatorWith.noRegret, 4),
      spammerNoRegretWith: spammerWith.noRegret === null ? null : round(spammerWith.noRegret, 4),
      innovatorNoRegretWithout: innovatorWithout.noRegret,
      spammerNoRegretWithout: spammerWithout.noRegret,
    },
    precisionPenalty: {
      withPenalty: round(wideScore.productPowerScore, 4),
      withoutPenalty: round(wideScore.productPowerScore / penalty, 4),
    },
    impressionDilution: {
      focusedPrecision: round(focused.score("tight").discovery.discoveryPrecision, 4),
      sprayedPrecision: round(wideScore.discovery.discoveryPrecision, 4),
    },
    recency: {
      fresh: round(fresh.score("fresh").metrics.realizedFitMean ?? 0, 4),
      halfLifeAgo: round(stale.score("stale").metrics.realizedFitMean ?? 0, 4),
    },
  };
}

function precisionMultiplier(precision: number, impressions: number): number {
  if (impressions < DEFAULT_REWARD_CONFIG.minImpressions) return 1;
  const threshold = 0.15;
  const strength = 0.5;
  return 1 - strength * Math.max(0, (threshold - precision) / threshold);
}
