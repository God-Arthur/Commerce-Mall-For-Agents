/**
 * 效果实验的断言版。规模比 `npm run experiments` 小，但打的是同一套生产代码。
 * 数字对不上时，先看 experiments/RESULTS.md 里的完整跑法。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMechanismStudy } from "../experiments/mechanism.ts";
import { runBaselineStudy } from "../experiments/baselines.ts";
import { runAblations, runTournament } from "../experiments/reward-study.ts";
import { runClosedLoop } from "../experiments/closed-loop.ts";

test("市场变厚后，福利损失占比下降，占优策略、预算和个体理性仍成立", () => {
  const study = runMechanismStudy({ marketsPerSize: 24, sizes: [2, 8, 16] });
  assert.equal(study.dsicViolations, 0);
  assert.ok(study.dsicChecks > 1000);
  const small = study.sizes[0]!;
  const large = study.sizes[study.sizes.length - 1]!;
  for (const row of study.sizes) {
    assert.ok(row.maxEfficiencyLoss <= 1);
    assert.equal(row.budgetViolations, 0);
    assert.equal(row.irViolations, 0);
    assert.equal(row.dsicViolations, 0);
  }
  assert.ok(
    large.meanWelfareLossRatio < small.meanWelfareLossRatio,
    `厚市场的福利损失应更小：n=${small.tradersPerSide} 为 ${small.meanWelfareLossRatio}，n=${large.tradersPerSide} 为 ${large.meanWelfareLossRatio}`,
  );
  assert.ok(large.meanWelfareLossRatio < 0.05);
});

test("McAfee 不贴钱且偏离无利；VCG 要补贴；中点价和按报价支付可以被偏离", () => {
  const study = runBaselineStudy({ markets: 40, traders: 4 });
  assert.equal(study.fixed.vcgBilateralSubsidy, 5);
  assert.equal(study.fixed.vcgTwoByTwoBudget, -6);
  assert.ok(study.fixed.midpointGain > 0);
  assert.ok(study.fixed.payAsBidGain > 0);
  assert.equal(study.fixed.mcafeeGainOnMidpointExample, 0);
  assert.equal(study.fixed.vcgGainOnBilateral, 0);

  assert.equal(study.random.mcafee.subsidyMarkets, 0);
  assert.equal(study.random.mcafee.dsicViolations, 0);
  assert.equal(study.random.vcg.dsicViolations, 0);
  assert.ok(study.random.vcg.subsidyMarkets > study.random.vcg.markets * 0.8);
  assert.ok(study.random.midpoint.dsicViolations > 0);
  assert.ok(study.random.payAsBid.dsicViolations > 0);
  assert.equal(study.random.vcg.meanWelfareRatio, 1);
  assert.ok(study.random.mcafee.meanWelfareRatio > 0.9);
});

test("多种子下真创新者稳定压过平庸者和刷分者，单项优化拿不到第一", () => {
  const study = runTournament({ seeds: 16 });
  assert.equal(study.firstPlace.innovator, study.seeds);
  assert.equal(study.innovatorBeatsSpammer, study.seeds);
  assert.equal(study.innovatorBeatsBland, study.seeds);
  assert.equal(study.singleMetricNeverFirst, study.seeds);
  assert.ok(study.meanNet.innovator! > study.meanNet.spammer!);
  assert.ok(study.meanRank.innovator! < study.meanRank.bland!);
  assert.ok(study.meanRank.bland! < study.meanRank.spammer!);
});

test("消融：几何平均比加权和更压单项，缺数据不当成 0，铺量稀释精度", () => {
  const study = runAblations();
  assert.ok(study.geometric.innovator > study.geometric.fitOnly);
  assert.ok(study.geometric.innovator > study.geometric.discoveryOnly);
  assert.ok(study.geometric.discoveryOnly < study.linear.discoveryOnly);
  assert.ok(study.geometric.fitOnly < study.linear.fitOnly);
  const geoRatio = study.geometric.fitOnly / study.geometric.innovator;
  const linearRatio = study.linear.fitOnly / study.linear.innovator;
  assert.ok(linearRatio > geoRatio, "加权和让只刷适配的商家更接近领先者");

  assert.ok(study.missingOutcomes.renormalized > study.missingOutcomes.asZero + 0.4);
  assert.equal(study.outcomeGap.innovatorNoRegretWithout, null);
  assert.equal(study.outcomeGap.spammerNoRegretWithout, null);
  assert.ok(study.outcomeGap.innovatorNoRegretWith !== null);
  assert.ok(study.outcomeGap.spammerNoRegretWith !== null);
  assert.ok(study.outcomeGap.innovatorNoRegretWith! > study.outcomeGap.spammerNoRegretWith!);
  assert.ok(study.outcomeGap.innovatorPowerWith > study.outcomeGap.spammerPowerWith);

  assert.ok(study.impressionDilution.focusedPrecision > study.impressionDilution.sprayedPrecision);
  assert.ok(study.precisionPenalty.withPenalty < study.precisionPenalty.withoutPenalty);
  assert.ok(study.recency.fresh > study.recency.halfLifeAgo);
  assert.ok(Math.abs(study.recency.halfLifeAgo / study.recency.fresh - 0.5) < 1e-6);
});

test("闭环里创新者留在入围前列，适配分不牵动价格，格子上的价格表不能靠改口获利", () => {
  const study = runClosedLoop({
    seeds: 6,
    rounds: 6,
    buyers: 12,
    elicitationMarkets: 30,
  });
  assert.equal(study.innovatorFirst, study.seeds);
  assert.equal(study.innovatorAheadOfSpammer, study.seeds);
  assert.equal(study.innovatorAheadOfFitOnly, study.seeds);
  assert.ok(study.lateImpressionShare.innovator! > study.lateImpressionShare.spammer!);
  assert.ok(study.priceFitCorrelation === null || Math.abs(study.priceFitCorrelation) < 0.75);
  assert.equal(study.elicitationOnGrid.violations, 0);
  assert.ok(study.elicitationOnGrid.checks > 100);
});
