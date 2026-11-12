/**
 * 把全部实验跑一遍，把机器写出来的数字落到 experiments/results 和 RESULTS.md。
 *
 * 运行：node experiments/run-all.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resultsDir, writeResult } from "./lib.ts";
import { runMechanismStudy } from "./mechanism.ts";
import { runBaselineStudy } from "./baselines.ts";
import { runAblations, runTournament } from "./reward-study.ts";
import { runClosedLoop } from "./closed-loop.ts";

const started = Date.now();
const mechanism = runMechanismStudy();
const baselines = runBaselineStudy();
const tournament = runTournament();
const ablations = runAblations();
const loop = runClosedLoop();
const elapsedMs = Date.now() - started;

writeResult("mechanism", mechanism);
writeResult("baselines", baselines);
writeResult("tournament", tournament);
writeResult("ablations", ablations);
writeResult("closed-loop", loop);

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const money = (x: number) => x.toFixed(1);

const mechRows = mechanism.sizes.map((row) =>
  `| ${row.tradersPerSide} | ${row.markets} | ${row.dsicChecks} | ${row.dsicViolations} | ${row.maxEfficiencyLoss} | ${pct(row.meanWelfareLossRatio)} | ${row.budgetViolations} | ${row.irViolations} |`,
).join("\n");

const rankRows = Object.keys(tournament.meanRank).map((id) =>
  `| ${id} | ${tournament.firstPlace[id] ?? 0} | ${tournament.meanRank[id]} | ${tournament.meanProductPower[id]} | ${tournament.meanDiscovery[id]} | ${money(tournament.meanNet[id] ?? 0)} |`,
).join("\n");

const baseRows = (["mcafee", "vcg", "midpoint", "payAsBid"] as const).map((name) => {
  const row = baselines.random[name];
  return `| ${name} | ${row.subsidyMarkets}/${row.markets} | ${row.meanBudget} | ${pct(row.meanWelfareRatio)} | ${row.dsicViolations}/${row.dsicChecks} | ${row.maxDeviationGain} |`;
}).join("\n");

const generatedAt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
}).format(new Date());

const markdown = `# 实验结果

这份文件由 \`node experiments/run-all.ts\` 写入，数字来自当次运行，不是手填的。
生成时间 ${generatedAt}（Asia/Shanghai），耗时 ${(elapsedMs / 1000).toFixed(1)} 秒。
原始 JSON 在 \`experiments/results/\`。

断言版在 \`test/effect.test.ts\`，\`npm test\` 会用较小样本量再跑一遍同样的结论。

## 1. 市场厚度

每侧 n 个交易者，各 ${mechanism.sizes[0]?.markets ?? 0} 个随机市场。种子 ${mechanism.seed}。
占优策略检验合计 ${mechanism.dsicChecks} 次，违反 ${mechanism.dsicViolations} 次，最大偏离收益 ${mechanism.maxDeviationGain}。

| 每侧人数 | 市场数 | 偏离检验 | 违反 | 最大效率损失（笔） | 平均福利损失占比 | 预算违反 | 个体理性违反 |
|---|---:|---:|---:|---:|---:|---:|---:|
${mechRows}

效率损失的笔数不超过 1。人数变多之后，被牺牲的那一笔占福利的比例下降。

## 2. 和另外三种规则对照

固定例子：

- 一个买家价值 10、一个卖家成本 5：VCG 需要平台补贴 ${baselines.fixed.vcgBilateralSubsidy}
- 两个买家 10 和 8、两个卖家 1 和 5：VCG 预算 ${baselines.fixed.vcgTwoByTwoBudget}（负数是补贴）
- 边际中点价下，买方改报的收益 ${baselines.fixed.midpointGain}
- 按报价支付下，买方改报的收益 ${baselines.fixed.payAsBidGain}
- 同一例子里 McAfee 的改报收益 ${baselines.fixed.mcafeeGainOnMidpointExample}
- 双边例子里 VCG 的改报收益 ${baselines.fixed.vcgGainOnBilateral}

随机市场（种子 ${baselines.seed}）：

| 机制 | 需要补贴的市场 | 平均预算 | 平均福利比 | 偏离获利次数 | 最大偏离收益 |
|---|---:|---:|---:|---:|---:|
${baseRows}

McAfee 的预算不为负，偏离没有收益，福利比接近完全效率。VCG 福利比为 1，但经常要补贴。中点价和按报价支付福利比为 1、也不贴钱，但改报能赚到钱。

## 3. 五类商家，多种子

${tournament.seeds} 个种子。同样 ${tournament.gmv} 元成交额下的净收入 = 成交额 × (1 − 费率) + 发现红利。

| 商家 | 第一名次数 | 平均名次（0 最好） | 平均产品力 | 平均发现分 | 平均净收入 |
|---|---:|---:|---:|---:|---:|
${rankRows}

真创新者压过刷分者 ${tournament.innovatorBeatsSpammer}/${tournament.seeds} 次，压过平庸者 ${tournament.innovatorBeatsBland}/${tournament.seeds} 次。只优化单一指标的商家拿到第一名的次数是 ${tournament.seeds - tournament.singleMetricNeverFirst}。

## 4. 消融

几何平均把「只刷发现」压到 ${ablations.geometric.discoveryOnly}，「只刷适配」压到 ${ablations.geometric.fitOnly}，两项都在的是 ${ablations.geometric.innovator}。同样的分数用 0.7/0.3 加权和，分别是 ${ablations.linear.discoveryOnly}、${ablations.linear.fitOnly}、${ablations.linear.innovator}。加权和让单项刷分更接近领先者。

成交结果还没接上时，把缺失维度当成 0，产品力是 ${ablations.missingOutcomes.asZero}；按现有规则把缺失维度移出分母，产品力是 ${ablations.missingOutcomes.renormalized}。所以在回填接上之前，不能把「还没有反悔数据」当成「全部反悔」。

接上成交回填之后，真创新者的未反悔率是 ${ablations.outcomeGap.innovatorNoRegretWith}，刷分者是 ${ablations.outcomeGap.spammerNoRegretWith}。不回填时两边都是 ${String(ablations.outcomeGap.innovatorNoRegretWithout)}。产品力分别是 ${ablations.outcomeGap.innovatorPowerWith} 和 ${ablations.outcomeGap.spammerPowerWith}。

同样 20 条评价，额外再展示 100 次，发现精度从 ${ablations.impressionDilution.focusedPrecision} 降到 ${ablations.impressionDilution.sprayedPrecision}。精度惩罚把产品力从 ${ablations.precisionPenalty.withoutPenalty} 打到 ${ablations.precisionPenalty.withPenalty}。

同一批满分，当天的适配均值 ${ablations.recency.fresh}，一个半衰期之前是 ${ablations.recency.halfLifeAgo}。

## 5. 闭环

${loop.seeds} 个种子，每个 ${loop.rounds} 轮、${loop.buyers} 个买家。五类商家的成本抽自同一分布。

真创新者排第一 ${loop.innovatorFirst}/${loop.seeds} 次，名次优于刷分者 ${loop.innovatorAheadOfSpammer}/${loop.seeds} 次，优于只优化适配者 ${loop.innovatorAheadOfFitOnly}/${loop.seeds} 次。

后几轮的展示份额：创新者 ${pct(loop.lateImpressionShare.innovator ?? 0)}，只优化适配者 ${pct(loop.lateImpressionShare["fit-only"] ?? 0)}，刷分者 ${pct(loop.lateImpressionShare.spammer ?? 0)}。

各轮出清价和当轮平均适配分的相关系数是 ${loop.priceFitCorrelation}。适配分不进入出价。

价格表的真实价值正好落在格子上时，改答其他格子 ${loop.elicitationOnGrid.checks} 次，获利 ${loop.elicitationOnGrid.violations} 次。真实价值落在格子之间时，${loop.elicitationOffGrid.checks} 次里有 ${loop.elicitationOffGrid.violations} 次改答能多赚，最大多赚 ${loop.elicitationOffGrid.maxGain}。这是离散价格表的量化缝隙，格子覆盖真值时不出现。
`;

writeFileSync(join(resultsDir(), "..", "RESULTS.md"), markdown);
console.log(markdown);
console.log(`写入完成，用时 ${(elapsedMs / 1000).toFixed(1)} 秒`);
