/**
 * 仿真脚本：奖励层「需求发现与产品力」的五种商家策略对抗。
 *
 * 运行：node scripts/simulate-reward.ts
 *
 * 这个脚本回答三个具体问题：
 *   1. 谁应该排第一？——真创新者，还是刷分刷得最猛的那个？
 *   2. 作弊有没有用？——把单一指标拉满，能不能挤进前列？
 *   3. 说真话能不能赚到钱？——费率优惠 + 发现红利能否覆盖「少推」的损失？
 *
 * 五类商家策略：
 *   A 真创新者    推得不多，但推的是买家自己想不到的东西，且推得准
 *   B 刷分/广撒网 推得极多，绝大部分不靠谱 —— 「量大」不等于「发现」
 *   C 安全但平庸 推大众安全款，中等适配，不惊喜也不翻车
 *   D 单项作弊者 只优化 fit_eval（全是老需求，一个新需求都不创造）
 *   E 单项作弊者 只优化发现率（假装创新，但质量极差，根本不算发现事件）
 *
 * 注意：D 和 E 是专门为了检验 Goodhart 防御而构造的对照组。
 * 如果 D 或 E 拿到了第一名，说明评分引擎被单项指标攻破，属于设计缺陷。
 */

import { ScoringEngine, evaluationKeyOf } from "../src/reward/scoring.ts";
import {
  DEFAULT_REWARD_CONFIG,
  type Evaluation,
  type MerchantScore,
  type OutcomeRecord,
} from "../src/reward/domain.ts";

// ── 输出工具：按「显示宽度」对齐（中文算 2 格） ──────────────────
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}
function pad(s: string, n: number, align: "l" | "r" = "l"): string {
  const d = Math.max(0, n - dispWidth(s));
  return align === "l" ? s + " ".repeat(d) : " ".repeat(d) + s;
}
function bar(pct: number, width = 18): string {
  const full = Math.round((pct / 100) * width);
  return "█".repeat(Math.max(0, Math.min(width, full))) + "·".repeat(Math.max(0, width - full));
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number | null, d = 3) => (x === null ? "  n/a" : x.toFixed(d));

// ── 确定性伪随机（LCG），保证每次运行结果一致 ──────────────────
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const NOW = Date.now();
const THRESHOLD = DEFAULT_REWARD_CONFIG.discoveryFitThreshold;

interface Strategy {
  id: string;
  tag: string;
  label: string;
  story: string;
  /** 推送候选总量 */
  impressions: number;
  /** 在多少天内分批推送（避免触发行数上限，从而单独检验「精度惩罚」） */
  spanDays: number;
  /** priorIntent = false（无先验意图 → 可能构成发现）的比例 */
  pNoPrior: number;
  fitLow: number;
  fitHigh: number;
  /** 成交概率 */
  pTrade: number;
  /** 成交后反悔概率 */
  pRegret: number;
  /** 复购概率 */
  pRepeat: number;
  /** 延迟复评的保持度（delayedFitEval / fitEval） */
  durability: number;
  /** 每笔成交额 */
  gmPerTrade: number;
}

const STRATEGIES: Strategy[] = [
  {
    id: "m-innovator",
    tag: "A",
    label: "真创新者",
    story: "推得不多，但每一条都揭示了买家自己想不到的需求，且推得准",
    impressions: 60,
    spanDays: 100,
    pNoPrior: 0.72,
    fitLow: 0.8,
    fitHigh: 0.95,
    pTrade: 0.82,
    pRegret: 0.05,
    pRepeat: 0.42,
    durability: 0.9,
    gmPerTrade: 120,
  },
  {
    id: "m-spammer",
    tag: "B",
    label: "刷分 / 广撒网者",
    story: "广撒网：推送量是别人的 6~9 倍，但绝大多数不靠谱，发现精度极低",
    impressions: 420,
    spanDays: 110,
    pNoPrior: 0.5,
    fitLow: 0.1,
    fitHigh: 0.4,
    pTrade: 0.15,
    pRegret: 0.45,
    pRepeat: 0.03,
    durability: 0.45,
    gmPerTrade: 60,
  },
  {
    id: "m-bland",
    tag: "C",
    label: "安全但平庸者",
    story: "只推大众安全款：适配中等、不惊喜也不翻车，但也没有新需求",
    impressions: 55,
    spanDays: 100,
    pNoPrior: 0.15,
    fitLow: 0.5,
    fitHigh: 0.65,
    pTrade: 0.65,
    pRegret: 0.0,
    pRepeat: 0.0,
    durability: 1.0,
    gmPerTrade: 100,
  },
  {
    id: "m-fitgamer",
    tag: "D",
    label: "只优化 fit_eval 者",
    story: "只盯适配分：全部推买家本来就想买的品类，一个新需求都不创造",
    impressions: 45,
    spanDays: 95,
    pNoPrior: 0.0,
    fitLow: 0.9,
    fitHigh: 0.96,
    pTrade: 0.75,
    pRegret: 0.15,
    pRepeat: 0.0,
    durability: 0.88,
    gmPerTrade: 110,
  },
  {
    id: "m-fakeinnovator",
    tag: "E",
    label: "只优化发现率者",
    story: "假装创新：无先验意图的推送很多，但适配太低，连「发现事件」门槛都过不了",
    impressions: 150,
    spanDays: 100,
    pNoPrior: 0.8,
    fitLow: 0.28,
    fitHigh: 0.5,
    pTrade: 0.28,
    pRegret: 0.3,
    pRepeat: 0.08,
    durability: 0.5,
    gmPerTrade: 50,
  },
];

// ─────────────────────────────────────────────────────────────────
// 生成一家商家在仿真周期内的评价与成交记录
// ─────────────────────────────────────────────────────────────────
interface SimRecord {
  strategy: Strategy;
  evaluations: Evaluation[];
  outcomes: OutcomeRecord[];
}

function simulate(s: Strategy, seed: number, roundId: string): SimRecord {
  const rnd = makeRng(seed);
  const evaluations: Evaluation[] = [];
  const outcomes: OutcomeRecord[] = [];

  for (let i = 0; i < s.impressions; i++) {
    // 时间：均匀铺在整个周期内（不是同一天爆发，避免被行数上限直接KO）
    const ts = NOW - rnd() * s.spanDays * DAY;

    const priorIntent = rnd() >= s.pNoPrior;
    const fitEval = s.fitLow + rnd() * (s.fitHigh - s.fitLow);
    const buyerAgentId = `buyer-${i}`;
    const productId = `${s.id}-p${i % 7}`;

    const evaluation: Evaluation = {
      roundId,
      merchantId: s.id,
      productId,
      buyerAgentId,
      priorIntent,
      fitEval,
      // scoring.ts 把 submittedAt 当作 epoch 毫秒做时间衰减与按日聚合，
      // 因此这里必须传时间戳（domain.ts 的字段注释写的是「候选序号」，二者口径不一致）。
      submittedAt: ts,
    };
    evaluations.push(evaluation);

    const traded = rnd() < s.pTrade;
    if (!traded) continue;

    const outcome: OutcomeRecord = {
      evaluationKey: evaluationKeyOf(evaluation),
      merchantId: s.id,
      buyerAgentId,
      productId,
      traded: true,
      noRegret: rnd() >= s.pRegret,
      repeat: rnd() < s.pRepeat,
      delayedFitEval: rnd() < 0.4 ? Math.min(1, fitEval * s.durability) : null,
      recordedAt: ts,
    };
    outcomes.push(outcome);
  }

  return { strategy: s, evaluations, outcomes };
}

// ─────────────────────────────────────────────────────────────────
// 喂给评分引擎
// ─────────────────────────────────────────────────────────────────
// 注入固定 nowFn，让时间衰减完全可复现
const engine = new ScoringEngine(DEFAULT_REWARD_CONFIG, () => NOW);

const sims = STRATEGIES.map((s, i) => simulate(s, 1000 + i * 137, "round-sim"));

for (const sim of sims) {
  for (const ev of sim.evaluations) engine.appendEvaluation(ev);
  for (const o of sim.outcomes) engine.appendOutcome(o);
}

// ─────────────────────────────────────────────────────────────────
// 自行统计的「原始画像」（未加时间衰减、未做归一化）
// 与引擎输出的衰减后口径互为交叉校验
// ─────────────────────────────────────────────────────────────────
interface RawProfile {
  impressions: number;
  trades: number;
  discoveryEvents: number;
  discoveryPrecision: number;
  fitMean: number;
  regretRate: number;
  repeatRate: number;
  gm: number;
}

function rawProfile(sim: SimRecord): RawProfile {
  const { evaluations: evs, outcomes: outs } = sim;
  const trades = outs.length;
  const discoveryEvents = evs.filter((e) => !e.priorIntent && e.fitEval >= THRESHOLD).length;
  const fitMean = evs.reduce((a, e) => a + e.fitEval, 0) / Math.max(1, evs.length);
  const regret = outs.filter((o) => o.noRegret === false).length;
  const repeat = outs.filter((o) => o.repeat === true).length;
  return {
    impressions: evs.length,
    trades,
    discoveryEvents,
    discoveryPrecision: discoveryEvents / Math.max(1, evs.length),
    fitMean,
    regretRate: trades ? regret / trades : 1,
    repeatRate: trades ? repeat / trades : 0,
    gm: trades * sim.strategy.gmPerTrade,
  };
}

// 费率必须放在全局排名的语境下才能确定，所以以 rankAll() 为准：
// 它一次性算出全部分数、按 merchantRank 降序排序、并按相对位次回填 takeRate。
const rankedAll = engine.rankAll();

/** 按名次排列的评分（名次 0 在前） */
const ranked: MerchantScore[] = rankedAll.map((r) => r.score);
const byId = new Map(ranked.map((x) => [x.merchantId, x]));
const tagOf = new Map(STRATEGIES.map((s) => [s.id, s]));
const rawOf = new Map(sims.map((sim) => [sim.strategy.id, rawProfile(sim)]));

// ═════════════════════════════════════════════════════════════════
console.log("=".repeat(92));
console.log("奖励层仿真 ——「需求发现 + 产品力」：五种商家策略的对抗");
console.log("=".repeat(92));
console.log(`评分配置: 权重 fit=${DEFAULT_REWARD_CONFIG.weights.realizedFitMean} ` +
  `noRegret=${DEFAULT_REWARD_CONFIG.weights.noRegretRate} ` +
  `repeat=${DEFAULT_REWARD_CONFIG.weights.repeatRate} ` +
  `durability=${DEFAULT_REWARD_CONFIG.weights.durability}`);
console.log(`发现阈值 fit>=${THRESHOLD}；最小样本=${DEFAULT_REWARD_CONFIG.minSampleSize}；` +
  `最小推送=${DEFAULT_REWARD_CONFIG.minImpressions}；半衰期=${DEFAULT_REWARD_CONFIG.halfLifeDays} 天`);

// ─────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(92));
console.log("【一】商家画像：他们各自在干什么（原始口径，未做时间衰减）\n");

{
  const head = [
    pad("", 3), pad("策略", 18), pad("推送量", 9, "r"), pad("成交", 8, "r"),
    pad("发现事件", 11, "r"), pad("发现精度", 11, "r"), pad("fit均值", 10, "r"),
    pad("反悔率", 9, "r"), pad("复购率", 9, "r"),
  ];
  console.log("  " + head.join(""));
  console.log("  " + "-".repeat(88));
  for (const s of STRATEGIES) {
    const r = rawOf.get(s.id)!;
    console.log(
      "  " + [
        pad(s.tag, 3),
        pad(s.label, 18),
        pad(String(r.impressions), 9, "r"),
        pad(String(r.trades), 8, "r"),
        pad(String(r.discoveryEvents), 11, "r"),
        pad(pct(r.discoveryPrecision), 11, "r"),
        pad(r.fitMean.toFixed(3), 10, "r"),
        pad(pct(r.regretRate), 9, "r"),
        pad(pct(r.repeatRate), 9, "r"),
      ].join("")
    );
  }
}

console.log("\n逐个说明：");
for (const s of STRATEGIES) {
  const r = rawOf.get(s.id)!;
  console.log(`\n  [${s.tag}] ${s.label} —— ${s.story}`);
  console.log(
    `      推送 ${String(r.impressions).padStart(3)} 条，成交 ${String(r.trades).padStart(3)} 笔` +
    `（转化 ${pct(r.trades / Math.max(1, r.impressions))}），发现事件 ${String(r.discoveryEvents).padStart(2)} 个，` +
    `发现精度 ${pct(r.discoveryPrecision)}`
  );
}

// ─────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(92));
console.log("【二】发现精度：谁真的在创造需求\n");
console.log(`  发现事件 = 买家无先验意图(priorIntent=false) 且 fit_eval >= ${THRESHOLD}\n`);

{
  const list = STRATEGIES.slice()
    .map((s) => ({ s, r: rawOf.get(s.id)! }))
    .sort((a, b) => b.r.discoveryPrecision - a.r.discoveryPrecision);
  console.log("  " + pad("策略", 22) + pad("发现精度", 12, "r") + "  " + pad("", 18) + "分布");
  console.log("  " + "-".repeat(66));
  for (const { s, r } of list) {
    console.log("  " + pad(`${s.tag} ${s.label}`, 22) + pad(pct(r.discoveryPrecision), 12, "r") +
      "  " + bar(r.discoveryPrecision * 100));
  }
  const spam = rawOf.get("m-spammer")!;
  const inn = rawOf.get("m-innovator")!;
  console.log(`\n  注意 B 的推送量是 A 的 ${(spam.impressions / inn.impressions).toFixed(1)} 倍，` +
    `但一次真正的发现都没做成（${spam.discoveryEvents} 个 vs ${inn.discoveryEvents} 个）。`);
  console.log(`  「量大」和「发现得准」完全是两件事 —— 这是本层的核心区分。`);
}

// ─────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(92));
console.log("【三】排名：merchant_rank 怎么排的\n");

{
  const cols = [
    pad("名次", 6), pad("策略", 18), pad("产品力", 9, "r"), pad("发现分", 9, "r"),
    pad("排名值", 9, "r"), pad("费率", 8, "r"), pad("发现红利", 11, "r"), pad("样本", 7, "r"), pad("标记", 22),
  ];
  console.log("  " + cols.join(""));
  console.log("  " + "-".repeat(96));
  ranked.forEach((sc, i) => {
    const s = tagOf.get(sc.merchantId)!;
    const flags: string[] = [];
    if (sc.belowMinSample) flags.push("样本不足");
    if (sc.flagged) flags.push(...sc.flagReasons);
    console.log(
      "  " + [
        pad(String(i + 1), 6),
        pad(`${s.tag} ${s.label}`, 18),
        pad(sc.productPowerScore.toFixed(3), 9, "r"),
        pad(sc.discoveryScore.toFixed(3), 9, "r"),
        pad(sc.merchantRank.toFixed(3), 9, "r"),
        pad(pct(sc.takeRate), 8, "r"),
        pad(sc.discoveryBonus.toFixed(1), 11, "r"),
        pad(String(sc.sampleSize), 7, "r"),
        pad(flags.length ? flags.join("; ") : "-", 22),
      ].join("")
    );
  });
  console.log(`\n  merchant_rank = productPower^0.7 × discoveryScore^0.3（几何平均），越大越优先。`);
  console.log(`  几何平均的意义：任一维度归零，总分立刻塌到 RANK_FLOOR —— 单项优化无法通关。`);
  console.log(`  费率按相对位次线性递减：第 1 名 ${pct(DEFAULT_REWARD_CONFIG.minTakeRate)}，末位 ${pct(DEFAULT_REWARD_CONFIG.baseTakeRate)}。`);
}

// ─────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(92));
console.log("【四】收益对比：同样成交额下，谁真的把钱赚走了\n");
console.log(`  视角：把每家的成交额都归一到 ${10000} 元，只比较「费率优惠 + 发现红利」的影响\n`);

const NORMAL_GM = 10000;
const revenue = ranked.map((sc) => {
  const fee = NORMAL_GM * sc.takeRate;
  const net = NORMAL_GM - fee + sc.discoveryBonus;
  return { sc, s: tagOf.get(sc.merchantId)!, fee, net };
});

{
  const cols = [
    pad("名次", 6), pad("策略", 18), pad("成交额", 10, "r"), pad("平台抽成", 11, "r"),
    pad("发现红利", 11, "r"), pad("净收益", 10, "r"), pad("净收益率", 11, "r"), pad("", 14),
  ];
  console.log("  " + cols.join(""));
  console.log("  " + "-".repeat(94));
  for (const r of revenue) {
    console.log(
      "  " + [
        pad(String(ranked.indexOf(r.sc) + 1), 6),
        pad(`${r.s.tag} ${r.s.label}`, 18),
        pad(NORMAL_GM.toFixed(0), 10, "r"),
        pad("-" + r.fee.toFixed(0), 11, "r"),
        pad("+" + r.sc.discoveryBonus.toFixed(1), 11, "r"),
        pad(r.net.toFixed(1), 10, "r"),
        pad(pct(r.net / NORMAL_GM), 11, "r"),
        bar((r.net / NORMAL_GM) * 100, 14),
      ].join("")
    );
  }
}

const spammer = revenue.find((r) => r.s.id === "m-spammer")!;
const innovator = revenue.find((r) => r.s.id === "m-innovator")!;
console.log(
  `\n  真创新者 vs 刷分者：同样 ${NORMAL_GM} 元成交额，净收益差 ` +
  `${(innovator.net - spammer.net).toFixed(1)} 元（` +
  `${((innovator.net - spammer.net) / NORMAL_GM * 100).toFixed(2)} 个百分点）`
);
console.log(`    其中费率差贡献 ${(spammer.fee - innovator.fee).toFixed(1)} 元，` +
  `发现红利差贡献 ${(innovator.sc.discoveryBonus - spammer.sc.discoveryBonus).toFixed(1)} 元。`);

// 真实口径（各按自身实际成交额）
console.log(`\n  换成「各自真实成交额」的口径，差距只会更大：`);
{
  const real = ranked.map((sc) => {
    const s = tagOf.get(sc.merchantId)!;
    const r = rawOf.get(sc.merchantId)!;
    return { s, sc, gm: r.gm, net: r.gm * (1 - sc.takeRate) + sc.discoveryBonus, conv: r.trades / Math.max(1, r.impressions) };
  }).sort((a, b) => b.net - a.net);
  const cols = [pad("策略", 18), pad("实际成交额", 12, "r"), pad("转化率", 10, "r"), pad("费率", 8, "r"), pad("净收益", 11, "r")];
  console.log("  " + cols.join(""));
  console.log("  " + "-".repeat(62));
  for (const r of real) {
    console.log("  " + [
      pad(`${r.s.tag} ${r.s.label}`, 18), pad(r.gm.toFixed(0), 12, "r"), pad(pct(r.conv), 10, "r"),
      pad(pct(r.sc.takeRate), 8, "r"), pad(r.net.toFixed(1), 11, "r"),
    ].join(""));
  }
}

// ─────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(92));
console.log("【五】结论\n");

const order = ranked.map((x) => tagOf.get(x.merchantId)!.id);
const posOf = (id: string) => order.indexOf(id);
const innovScore = byId.get("m-innovator")!;
const spamScore = byId.get("m-spammer")!;
const blandScore = byId.get("m-bland")!;
const fitScore = byId.get("m-fitgamer")!;
const fakeScore = byId.get("m-fakeinnovator")!;

const abcOk = posOf("m-innovator") < posOf("m-bland") && posOf("m-bland") < posOf("m-spammer");
const innovatorsRank1 = posOf("m-innovator") === 0;
const goodhartOk = posOf("m-fitgamer") > 0 && posOf("m-fakeinnovator") > 0;
const payoffsOk = innovator.net > spammer.net;

// 结论一
console.log(`  ▍结论 1：${innovatorsRank1 ? "真创新者拿到第一，排名符合预期 ✓" : "真创新者没有拿到第一，排名不符合预期 ✗"}\n`);
console.log(`  为什么 A 应该排第一：`);
console.log(`    - 产品力 ${innovScore.productPowerScore.toFixed(3)}：fit 均值高（${num(innovScore.metrics.realizedFitMean)}）、` +
  `几乎不反悔（${num(innovScore.metrics.noRegretRate)}）、有复购（${num(innovScore.metrics.repeatRate)}）`);
console.log(`    - 发现分 ${innovScore.discoveryScore.toFixed(3)}：发现精度 ` +
  `${pct(innovScore.discovery.discoveryPrecision)}，${innovScore.discovery.discoveryEvents} 次真发现`);
console.log(`    两个维度同时高，才是「既好用又能创造需求」——这正是乔布斯机制奖励的对象。`);

// 结论二
console.log(`\n  ▍结论 2：${abcOk ? "刷分者被压制到末位，A > C > B 成立 ✓" : "A > C > B 未成立 ✗"}\n`);
console.log(`  为什么 B 被压制：`);
console.log(`    - 推送 ${spamScore.discovery.totalImpressions} 条，发现事件仅 ${spamScore.discovery.discoveryEvents} 个，` +
  `发现精度只有 ${pct(spamScore.discovery.discoveryPrecision)}`);
console.log(`    - 产品力 ${spamScore.productPowerScore.toFixed(3)}：fit 均值仅 ${num(spamScore.metrics.realizedFitMean)}，` +
  `反悔率 ${pct(1 - (spamScore.metrics.noRegretRate ?? 0))}，几乎没有复购（${num(spamScore.metrics.repeatRate)}）`);
console.log(`    大量推送在「发现精度」这一项上被直接惩罚：` +
  `同样的发现事件数，分母越大得分越低。`);
if (spamScore.flagged) {
  console.log(`    此外触发了异常检测：${spamScore.flagReasons.join("; ")}`);
}

// 结论三
console.log(`\n  ▍结论 3：${goodhartOk ? "Goodhart 防御成立：单项优化拿不到第一 ✓" : "Goodhart 防御被攻破 ✗"}\n`);
console.log(`  D「只优化 fit_eval」：`);
console.log(`    产品力 ${fitScore.productPowerScore.toFixed(3)}（五家中第 ${posOf("m-fitgamer") + 1} 名），` +
  `但发现分只有 ${fitScore.discoveryScore.toFixed(3)} —— 发现事件 ${fitScore.discovery.discoveryEvents} 个。`);
console.log(`    因为他推的全是买家本来就想买的品类（priorIntent=true），`);
console.log(`    适配分再高也只是「重复满足已有需求」，不构成需求发现。`);
console.log(`  E「只优化发现率」：`);
console.log(`    推送 ${fakeScore.discovery.totalImpressions} 条、无先验意图比例高，` +
  `但发现分只有 ${fakeScore.discoveryScore.toFixed(3)}，发现事件 ${fakeScore.discovery.discoveryEvents} 个。`);
console.log(`    因为发现事件的定义是「无先验意图 **且** fit >= ${THRESHOLD}」——`);
console.log(`    光制造「没想过的需求」不算数，质量不达标连门槛都过不了。`);
console.log(`  两个单项作弊者只能各自在一个维度上强，另一个维度被清零，无法登顶。`);

if (!goodhartOk) {
  console.log(`\n  ⚠ 异常：单项作弊者排到了第一，说明评分引擎把某个维度权重设得过高，`);
  console.log(`    或发现分的门槛惩罚不足 —— 这是一个真实的设计缺陷，需要调整权重。`);
}

// 结论四
console.log(`\n  ▍结论 4：${payoffsOk ? "抗操纵成立 —— 说真话赚得更多 ✓" : "收益激励倒挂，刷分比诚实更赚 ✗"}\n`);
console.log(`    同样 ${NORMAL_GM} 元成交额：真创新者净收益 ${innovator.net.toFixed(1)}，` +
  `刷分者 ${spammer.net.toFixed(1)}。`);
console.log(`    排名靠前 → 费率更低（${pct(innovScore.takeRate)} vs ${pct(spamScore.takeRate)}）→ 发现红利更多`);
console.log(`    （${innovScore.discoveryBonus.toFixed(1)} vs ${spamScore.discoveryBonus.toFixed(1)}，上限 ${DEFAULT_REWARD_CONFIG.discoveryBonusCap}）。`);
console.log(`    刷分者「多推送」换来的只是曝光，而曝光在本层不直接变现 ——`);
console.log(`    只有「被验证的发现」才兑换成钱。这堵死了「量大取胜」的套利路径。`);

// ── 不符合预期时的如实告警 ──────────────────────────────────────
const problems: string[] = [];
if (!innovatorsRank1) problems.push(`真创新者只排第 ${posOf("m-innovator") + 1}`);
if (!abcOk) problems.push("A > C > B 未成立");
if (!goodhartOk) problems.push("存在单项作弊者进入第一名");
if (!payoffsOk) problems.push("收益激励倒挂");
if (problems.length) {
  console.log("\n" + "=".repeat(92));
  console.log("⚠ 本次运行存在与设计预期不符的结论（如实报告，不加粉饰）：");
  for (const p of problems) console.log(`   - ${p}`);
  console.log("  排序实际为：" + ranked.map((x, i) => `${i + 1}.${tagOf.get(x.merchantId)!.tag} ${tagOf.get(x.merchantId)!.label}`).join("  >  "));
  console.log("=".repeat(92));
} else {
  console.log("\n" + "=".repeat(92));
  console.log(`排序实际为：${ranked.map((x, i) => `${i + 1}.${tagOf.get(x.merchantId)!.tag} ${tagOf.get(x.merchantId)!.label}`).join("  >  ")}`);
  console.log("全部四项结论均与设计预期一致。");
  console.log("=".repeat(92));
}

console.log("\n想自己验证？运行：node --test \"test/*.test.ts\"");
