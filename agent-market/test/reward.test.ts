/**
 * 奖励层评分引擎单元测试。
 *
 * 运行：node --test "test/*.test.ts"
 *
 * 这些测试全部直接打生产实现 ScoringEngine，不用测试专用副本。
 * 覆盖的是「刷分防御」的四道闸门：
 *   1. 空数据 / 样本不足  → 不得崩溃，且不得给高分
 *   2. 时间衰减          → 老资格刷的高分不能永久躺赢
 *   3. 发现精度惩罚      → 广撒网必须比精准推送吃亏
 *   4. Goodhart 防御     → 单项拉满拿不到第一
 * 外加：费率单调性、红利上限、异常检测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScoringEngine, rankOf } from "../src/reward/scoring.ts";
import {
  DEFAULT_REWARD_CONFIG,
  type Evaluation,
  type OutcomeRecord,
} from "../src/reward/domain.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const CFG = DEFAULT_REWARD_CONFIG;

/** 构造一条评价 */
function ev(
  merchantId: string,
  i: number,
  opts: {
    fit?: number;
    priorIntent?: boolean;
    ageDays?: number;
    roundId?: string;
  } = {},
): Evaluation {
  return {
    roundId: opts.roundId ?? "r1",
    merchantId,
    productId: `${merchantId}-p${i}`,
    buyerAgentId: `b-${merchantId}-${i}`,
    priorIntent: opts.priorIntent ?? false,
    fitEval: opts.fit ?? 0.6,
    // scoring.ts 将 submittedAt 视为 epoch 毫秒（时间衰减与按日聚合都用它）
    submittedAt: T0 - (opts.ageDays ?? 0) * DAY,
  };
}

/** 构造一条成交回填记录 */
function out(e: Evaluation, opts: { noRegret?: boolean; repeat?: boolean; delayed?: number | null } = {}): OutcomeRecord {
  return {
    evaluationKey: `${e.roundId}::${e.merchantId}::${e.productId}::${e.buyerAgentId}`,
    merchantId: e.merchantId,
    buyerAgentId: e.buyerAgentId,
    productId: e.productId,
    traded: true,
    noRegret: opts.noRegret ?? true,
    repeat: opts.repeat ?? false,
    delayedFitEval: opts.delayed ?? null,
    recordedAt: e.submittedAt,
  };
}

/** 建一家「全优」商家：fit 高、不反悔、复购、耐久 */
function buildGood(mid: string, n: number, ageDays: number, engine: ScoringEngine): void {
  for (let i = 0; i < n; i++) {
    const e = ev(mid, i, { fit: 0.95, priorIntent: false, ageDays });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: true, repeat: true, delayed: 0.9 }));
  }
}

// ─────────────────────────────────────────────────────────────────
// 1. 健壮性：空数据
// ─────────────────────────────────────────────────────────────────
test("空数据不崩溃：未注册商家得 0 分 + belowMinSample", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  const s = engine.score("ghost");
  assert.equal(s.merchantId, "ghost");
  assert.equal(s.sampleSize, 0);
  assert.equal(s.belowMinSample, true);
  assert.equal(s.productPowerScore, 0);
  assert.equal(s.discoveryScore, 0);
  assert.equal(s.metrics.realizedFitMean, null);
  assert.equal(s.metrics.noRegretRate, null);
  assert.equal(s.discoveryBonus, 0);
  assert.equal(s.takeRate, CFG.baseTakeRate, "样本不足应拿基础费率，不得享受优惠");
});

test("空数据：rankAll 在无任何记录时返回空数组", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  assert.deepEqual(engine.rankAll(), []);
});

// ─────────────────────────────────────────────────────────────────
// 2. 样本不足
// ─────────────────────────────────────────────────────────────────
test("样本不足时 belowMinSample = true，且 realizedFitMean 置 null", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  for (let i = 0; i < CFG.minSampleSize - 1; i++) {
    const e = ev("newbie", i, { fit: 1.0 });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: true, repeat: true }));
  }
  const s = engine.score("newbie");
  assert.equal(s.sampleSize, CFG.minSampleSize - 1);
  assert.equal(s.belowMinSample, true);
  assert.equal(s.metrics.realizedFitMean, null, "样本不足时适配均值必须置 null 而不是照实给出");
  assert.equal(s.productPowerScore, 0, "样本不足不得给出产品力分，避免高分诱导刷量");
});

test("样本不足：推送量够但评价数不够，仍不得拿到发现红利", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  for (let i = 0; i < 3; i++) engine.appendEvaluation(ev("sparse", i, { fit: 0.99 }));
  const s = engine.score("sparse");
  assert.equal(s.belowMinSample, true);
  assert.equal(s.discoveryBonus, 0);
  assert.equal(s.flagged, false);
});

test("样本刚够 minSampleSize 时评分即刻生效", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  for (let i = 0; i < CFG.minSampleSize; i++) {
    const e = ev("just-enough", i, { fit: 0.95, priorIntent: false });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: true, repeat: true, delayed: 0.9 }));
  }
  const s = engine.score("just-enough");
  assert.equal(s.belowMinSample, false);
  assert.ok(s.productPowerScore > 0.9, `应拿到高分，实际 ${s.productPowerScore}`);
  assert.ok(s.metrics.realizedFitMean !== null);
});

// ─────────────────────────────────────────────────────────────────
// 3. 时间衰减
// ─────────────────────────────────────────────────────────────────
test("时间衰减生效：老高分压不住新低分（老样本被降权）", () => {
  // 关键在于「加权均值」：若所有样本取值相同，衰减不改变均值；
  // 只有当新旧样本取值不同时，衰减才会显形 —— 老样本的权重被折半、
  // 二次方衰减，于是老高分被新低分压过去。
  const engine = new ScoringEngine(CFG, () => T0);
  for (let i = 0; i < 10; i++) engine.appendEvaluation(ev("aging", i, { fit: 0.95, ageDays: 90 }));
  for (let i = 0; i < 10; i++) engine.appendEvaluation(ev("aging", 100 + i, { fit: 0.2, ageDays: 0 }));

  const s = engine.score("aging");
  const got = s.metrics.realizedFitMean!;
  const unweighted = 0.575; // 不做衰减时的朴素均值
  assert.ok(
    got < 0.3,
    `90 天前的高分应被显著降权，加权均值应远低于朴素均值 ${unweighted}；实际 ${got}`
  );
});

test("时间衰减生效：单个半衰期后权重减半（通过新旧样本混合验证）", () => {
  // 半衰期 30 天，半衰期后权重应为 0.5。
  // 混合实验：1 条「当天高分」+ N 条「半衰期后低分」。
  //
  // 这里用的是**加权平均** Σ(w·x)/Σw：分母只统计仍有效的权重，
  // 因此极老的样本会自然退出分母（这是衰减职责 A）。
  // 1 条当天高分权重 1.0，N 条半衰期前低分各权重 0.5：
  //   均值 = (1.0×1 + 0) / (1 + 0.5N)
  const engine = new ScoringEngine(CFG, () => T0);
  const n = CFG.halfLifeDays;
  engine.appendEvaluation(ev("mix", 0, { fit: 1.0, priorIntent: true }));
  for (let i = 1; i <= n; i++) {
    engine.appendEvaluation(ev("mix", i, { fit: 0.0, priorIntent: true, ageDays: CFG.halfLifeDays }));
  }
  // 本组样本最新的一条是「当天」，故时效因子 = 1，不影响加权平均本身
  const expected = 1 / (1 + 0.5 * n);
  const got = engine.score("mix").metrics.realizedFitMean!;
  assert.ok(Math.abs(got - expected) < 1e-9, `加权均值应为 ${expected}，实际 ${got}`);
});

test("时间衰减生效：同样一批满分，整体变老后分数必须下降", () => {
  // 这是时间衰减最直接的检验：
  // 同样 10 条 fit=1.0 的评价，「今天的」与「半衰期前的」分数必须不同。
  //
  // 注意：这个衰减**不是**来自加权平均（Σ(w·x)/Σw 对同质样本恒等于 1.0，
  // 权重会被完全约掉），而是来自独立的**时效因子**。
  // 两个机制职责不同，详见 src/reward/scoring.ts 中的长注释。
  const fresh = new ScoringEngine(CFG, () => T0);
  const stale = new ScoringEngine(CFG, () => T0);
  for (let i = 0; i < 10; i++) {
    fresh.appendEvaluation(ev("f", i, { fit: 1.0, priorIntent: true, ageDays: 0 }));
    stale.appendEvaluation(ev("s", i, { fit: 1.0, priorIntent: true, ageDays: CFG.halfLifeDays }));
  }
  const a = fresh.score("f").metrics.realizedFitMean!;
  const b = stale.score("s").metrics.realizedFitMean!;
  assert.ok(a > b, `当天样本(${a}) 必须优于半衰期前样本(${b})`);
  // 恰好一个半衰期 → 时效因子减半 → 均值也随之减半
  assert.ok(
    Math.abs(b / a - 0.5) < 1e-9,
    `半衰期后应为原来的一半：${a} -> ${b}`
  );
});

test("时间衰减：老口碑被新证据冲刷，而不是被老资格永久垄断", () => {
  // 一年前狂刷 40 条 0.3 的差评，recent 又拿到 6 条 0.95 的好评。
  // 朴素均值 = (40*0.3 + 6*0.95)/46 = 0.385 —— 差评霸榜。
  //
  // 启用衰减后，40 条一年前差评的权重约 2^-12 ≈ 0.0002，在加权平均的
  // 分母里几乎不存在，自然退出 —— 得分应回到 0.95 附近，
  // 即「近期的良好表现」压过「一年前的差评」。
  //
  // ⚠️ 这里用加权平均（分母 = Σw）而非「分母固定为样本数」。
  // 若分母固定为 N，老差评虽权重趋近 0 仍全额占位，把新表现稀释：
  // 实测会从 0.949 掉到 0.124，把「衰减」变成了「惩罚新商家」。
  // 代价是加权平均对同质样本失效（10 条老满分仍是 1.0），
  // 这由独立的「时效因子」兜底 —— 见下一条测试。
  const engine = new ScoringEngine(CFG, () => T0);
  for (let i = 0; i < 40; i++) {
    const e = ev("reformed", i, { fit: 0.3, priorIntent: true, ageDays: 365 });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: false }));
  }
  for (let i = 0; i < 6; i++) {
    const e = ev("reformed", 100 + i, { fit: 0.95, priorIntent: false, ageDays: 0 });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: true, repeat: true, delayed: 0.9 }));
  }
  const got = engine.score("reformed").metrics.realizedFitMean!;
  const naive = (40 * 0.3 + 6 * 0.95) / 46;
  assert.ok(
    got > naive * 2 && got > 0.9,
    `新证据应压过一年前的差评：衰减后 ${got.toFixed(4)}（朴素均值 ${naive.toFixed(4)}）`
  );
  // 反向对照：若把衰减关掉（半衰期拉长到 100000 天），分数应逼近朴素均值
  const noDecay = new ScoringEngine({ ...CFG, halfLifeDays: 100000 }, () => T0);
  for (let i = 0; i < 40; i++) noDecay.appendEvaluation(ev("reformed", i, { fit: 0.3, priorIntent: true, ageDays: 365 }));
  for (let i = 0; i < 6; i++) noDecay.appendEvaluation(ev("reformed", 100 + i, { fit: 0.95, priorIntent: false, ageDays: 0 }));
  const flat = noDecay.score("reformed").metrics.realizedFitMean!;
  assert.ok(
    Math.abs(flat - naive) < 1e-3,
    `关掉衰减后应回到朴素均值：${flat.toFixed(4)} vs ${naive.toFixed(4)}`
  );
});

test("时效因子：整体停更的老口碑无法永久躺赢", () => {
  // 加权平均 Σ(w·x)/Σw 对**同质样本**失效：10 条满分哪怕十年前的，
  // 算出来仍然是 1.0。老资格商家只要早期刷出一批满分，就能永久霸榜。
  //
  // 时效因子专门收拾这种情况：它只看「最新一条评价的新鲜度」，
  // 长期停更的商家历史好口碑被显著折价（地板 0.3）。
  //
  // 本条与上一条构成一对：加权平均负责「让极老的坏证据退出」，
  // 时效因子负责「让整体停更的好口碑打折」。两者职责不重叠，
  // 因此不能用同一个公式表达 —— 这是本引擎最容易写错的地方。
  const build = (ageDays: number) => {
    const e2 = new ScoringEngine(CFG, () => T0);
    for (let i = 0; i < 10; i++) {
      e2.appendEvaluation(ev("veteran", i, { fit: 1.0, priorIntent: true, ageDays }));
    }
    return e2.score("veteran").metrics.realizedFitMean!;
  };

  const today = build(0);
  const oneHalfLife = build(CFG.halfLifeDays);
  const threeYears = build(1095);

  assert.ok(today > oneHalfLife, `当天的应优于半衰期前的：${today} vs ${oneHalfLife}`);
  assert.ok(Math.abs(oneHalfLife / today - 0.5) < 1e-9, `恰好一个半衰期应减半：${today} -> ${oneHalfLife}`);
  assert.ok(
    threeYears <= 0.35,
    `三年前的满分口碑应被折价到地板附近（无法永久躺赢），实际 ${threeYears.toFixed(4)}`
  );
  assert.ok(
    threeYears > 0,
    `但不应归零 —— 停更不等于表现差，应保留翻身的可能性`
  );
});

// ─────────────────────────────────────────────────────────────────
// 4. 发现精度惩罚
// ─────────────────────────────────────────────────────────────────
test("发现精度惩罚：同样 fit 均值下，广撒网者的 discoveryScore 更低", () => {
  const engine = new ScoringEngine(CFG, () => T0);

  // 精准型：12 条推送，10 条是发现事件
  for (let i = 0; i < 12; i++) {
    engine.appendEvaluation(ev("precise", i, { fit: i < 10 ? 0.9 : 0.3, priorIntent: i < 10 ? false : true }));
  }
  // 广撒网型：120 条推送，同样 10 次发现事件（发现事件数完全相同）
  for (let i = 0; i < 120; i++) {
    engine.appendEvaluation(ev("spammer", i, { fit: i < 10 ? 0.9 : 0.3, priorIntent: i < 10 ? false : true }));
  }

  const a = engine.score("precise");
  const b = engine.score("spammer");
  assert.equal(a.discovery.discoveryEvents, b.discovery.discoveryEvents, "两者发现事件数应相同");
  assert.ok(a.discovery.discoveryPrecision > b.discovery.discoveryPrecision);
  assert.ok(
    a.discoveryScore > b.discoveryScore,
    `广撒网者发现分应更低：precise=${a.discoveryScore} spammer=${b.discoveryScore}`
  );
  assert.ok(
    a.productPowerScore > b.productPowerScore,
    `低精度应反噬产品力：precise=${a.productPowerScore} spammer=${b.productPowerScore}`
  );
});

test("发现精度惩罚：质量相同但铺量 10 倍，产品力被显著打折", () => {
  // 严格控制变量：两家的 fit 均值**完全相同**（都是 0.675），
  // 唯一差别是分母 —— 窄网 40 条 / 广撒网 400 条。
  // 这样 rawPower 必然相同，score 的差异只能来自精度惩罚。
  const TARGET_MEAN = 0.675;
  const DISCOVERY_N = 10;
  const DISCOVERY_FIT = 0.9;

  const build = (mid: string, n: number): ScoringEngine => {
    const engine = new ScoringEngine(CFG, () => T0);
    // 反解填充部分的 fit，使整体均值恰好等于 TARGET_MEAN
    const fillerFit = (n * TARGET_MEAN - DISCOVERY_N * DISCOVERY_FIT) / (n - DISCOVERY_N);
    for (let i = 0; i < n; i++) {
      const e = ev(mid, i, i < DISCOVERY_N
        ? { fit: DISCOVERY_FIT, priorIntent: false }
        : { fit: fillerFit, priorIntent: true });
      engine.appendEvaluation(e);
      engine.appendOutcome(out(e, { noRegret: true }));
    }
    return engine;
  };
  const narrow = build("narrow", 40);
  const wide = build("wide", 400);

  const a = narrow.score("narrow");
  const b = wide.score("wide");
  assert.equal(a.discovery.discoveryEvents, b.discovery.discoveryEvents, "两者发现事件数应相同");
  assert.ok(
    Math.abs(a.metrics.realizedFitMean! - b.metrics.realizedFitMean!) < 1e-9,
    "控制变量前提：两家 fit 均值必须相同"
  );
  assert.ok(a.discovery.discoveryPrecision > b.discovery.discoveryPrecision, "窄网精度应高于广撒网");
  assert.ok(
    b.productPowerScore < a.productPowerScore,
    `同质量但铺量 10 倍的产品力必须更低：narrow=${a.productPowerScore} wide=${b.productPowerScore}`
  );
  // 精度 10/400=0.025 低于 0.15 阈值 -> 乘以 (1 - 0.5*(0.15-0.025)/0.15) = 0.5833
  const expectedRatio = 1 - 0.5 * ((0.15 - 10 / 400) / 0.15);
  const ratio = b.productPowerScore / a.productPowerScore;
  assert.ok(
    Math.abs(ratio - expectedRatio) < 1e-6,
    `惩罚系数应为 ${expectedRatio.toFixed(4)}，实际 ${ratio.toFixed(4)}`
  );
});

test("发现事件必须同时满足无先验意图与高适配", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  for (let i = 0; i < 20; i++) {
    // 有先验意图 + 满分：不是发现
    if (i % 2 === 0) engine.appendEvaluation(ev("x", i, { fit: 1.0, priorIntent: true }));
    // 无先验意图 + 低分：也不是发现
    else engine.appendEvaluation(ev("x", i, { fit: 0.1, priorIntent: false }));
  }
  const s = engine.score("x");
  assert.equal(s.discovery.discoveryEvents, 0, "任一条件不满足都不算发现事件");
  assert.equal(s.discoveryScore, 0);
});

// ─────────────────────────────────────────────────────────────────
// 5. Goodhart 防御
// ─────────────────────────────────────────────────────────────────
test("单项优化无法拿高排名：只刷 fit 与只刷发现都不敌均衡型", () => {
  const engine = new ScoringEngine(CFG, () => T0);

  // 真创新者：产品力与发现都不低
  for (let i = 0; i < 20; i++) {
    const e = ev("balanced", i, { fit: 0.88, priorIntent: false });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: true, repeat: i % 3 === 0, delayed: 0.85 }));
  }

  // 单项作弊者 1：fit 拉满，但全是有先验意图的老需求
  for (let i = 0; i < 20; i++) {
    const e = ev("fit-only", i, { fit: 0.99, priorIntent: true });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: true }));
  }

  // 单项作弊者 2：无先验意图很多，但质量太差，够不上发现门槛
  for (let i = 0; i < 20; i++) {
    engine.appendEvaluation(ev("discovery-only", i, { fit: 0.3, priorIntent: false }));
  }

  const order = engine.rankAll();
  const first = order[0].merchantId;
  assert.equal(first, "balanced", `均衡型应居首，实际第一名是 ${first}`);

  const fitOnly = order.find((r) => r.merchantId === "fit-only")!;
  const discOnly = order.find((r) => r.merchantId === "discovery-only")!;
  assert.equal(fitOnly.score.discoveryScore, 0, "只刷 fit 者的发现分必须为 0");
  assert.equal(discOnly.score.discoveryScore, 0, "低质量的「假发现」不���给发现分");
  assert.ok(fitOnly.position > 0 && discOnly.position > 0, "两个单项作弊者都不得登顶");
});

test("几何平均排名：单项拉满无法通关，双弱必被双强碾压", () => {
  // merchant_rank = productPower^0.7 × discoveryScore^0.3
  // 地板 RANK_FLOOR = 0.05：任一维度归零，总分都被摁在地板附近
  assert.ok(rankOf(0.95, 0) < 0.4, `缺发现的满分产品力应被摁低，实际 ${rankOf(0.95, 0)}`);
  assert.ok(rankOf(0, 0.95) < 0.2, `缺产品力的满分发现应被摁低，实际 ${rankOf(0, 0.95)}`);
  assert.ok(rankOf(0.95, 0.95) > 0.9, "两项都好才拿高分");

  // 关键检验：为什么用几何平均而不是加权和？
  // 场景：只刷发现分的商家 vs 只刷产品力的商家（各有一项拉满、一项归零）
  const geoDiscoveryOnly = rankOf(0.05, 1.0);
  const geoPowerOnly = rankOf(0.8, 0.3);
  const linearDiscoveryOnly = 0.05 * 0.5 + 1.0 * 0.5;
  const linearPowerOnly = 0.8 * 0.5 + 0.3 * 0.5;

  // 加权和中两者几乎持平（0.525 vs 0.55）——「只刷发现」是一条有效攻击路径
  assert.ok(
    Math.abs(linearPowerOnly - linearDiscoveryOnly) < 0.05,
    `加权和下两者近乎持平：${linearPowerOnly} vs ${linearDiscoveryOnly}`
  );
  // 几何平均下差距被放大一个数量级：单项优化者会被甩开
  const geoGap = geoPowerOnly - geoDiscoveryOnly;
  const linearGap = linearPowerOnly - linearDiscoveryOnly;
  assert.ok(
    geoGap > linearGap * 10,
    `几何平均应把差距放大一个数量级：几何 ${geoGap.toFixed(3)} vs 加权和 ${linearGap.toFixed(3)}`
  );
});

test("排名分有地板：产品力与发现分同时为 0 也不会除零", () => {
  const v = rankOf(0, 0);
  assert.ok(Number.isFinite(v) && v >= 0, `应返回有限非负数，实际 ${v}`);
});

test("排名分有地板：产品力与发现分同时为 0 也不会除零", () => {
  const v = rankOf(0, 0);
  assert.ok(Number.isFinite(v) && v >= 0, `应返回有限非负数，实际 ${v}`);
});

// ─────────────────────────────────────────────────────────────────
// 6. 费率单调性
// ─────────────────────────────────────────────────────────────────
test("费率随排名单调下降：第 1 名拿最低抽成，末位拿基础抽成", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  buildGood("top", 20, 0, engine);
  buildGood("mid", 20, 0, engine);
  buildGood("last", 20, 0, engine);

  const ranked = engine.rankAll();
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      ranked[i].score.takeRate >= ranked[i - 1].score.takeRate,
      `第 ${i + 1} 名费率 ${ranked[i].score.takeRate} 不应低于第 ${i} 名 ${ranked[i - 1].score.takeRate}`
    );
  }
  assert.equal(ranked[0].score.takeRate, CFG.minTakeRate, "第一名应拿到最低费率");
  assert.equal(ranked[ranked.length - 1].score.takeRate, CFG.baseTakeRate, "末位应拿基础费率");
});

test("费率：只有 1 家商家时视为最优，拿到最低抽成", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  buildGood("solo", 10, 0, engine);
  assert.equal(engine.rankAll()[0].score.takeRate, CFG.minTakeRate);
});

// ─────────────────────────────────────────────────────────────────
// 7. 发现红利上限
// ─────────────────────────────────────────────────────────────────
test("发现红利不超过 discoveryBonusCap", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  // 200 条全满分全无先验意图的推送 —— 远超封顶所需
  for (let i = 0; i < 200; i++) {
    const e = ev("flood", i, { fit: 1.0, priorIntent: false });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: true, repeat: true, delayed: 1.0 }));
  }
  const s = engine.score("flood");
  assert.ok(s.discoveryBonus <= CFG.discoveryBonusCap, `红利 ${s.discoveryBonus} 超过上限 ${CFG.discoveryBonusCap}`);
  assert.equal(s.discoveryBonus, CFG.discoveryBonusCap, "刷得足够多时应恰好顶到上限");
});

test("发现红利：没有发现事件就没有红利", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  for (let i = 0; i < 20; i++) {
    const e = ev("no-discovery", i, { fit: 0.9, priorIntent: true });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: true }));
  }
  assert.equal(engine.score("no-discovery").discoveryBonus, 0);
});

// ─────────────────────────────────────────────────────────────────
// 8. 异常检测
// ─────────────────────────────────────────────────────────────────
test("异常检测：fit_eval 相对历史均值异常飙升时 flagged", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  // 先铺 8 条 0.2 的历史评价（超过 SPIKE_MIN_HISTORY=5）
  for (let i = 0; i < 8; i++) engine.appendEvaluation(ev("sneaky", i, { fit: 0.2, priorIntent: true, ageDays: 30 - i }));
  // 然后突然来一条 0.99 —— 远超历史均值 0.2 的 spikeFactor=3 倍
  engine.appendEvaluation(ev("sneaky", 99, { fit: 0.99, priorIntent: true }));

  const s = engine.score("sneaky");
  assert.equal(s.flagged, true, "飙升应被标记");
  assert.ok(s.flagReasons.some((r) => r.includes("飙升")), `理由应含「飙升」：${s.flagReasons.join(";")}`);
  assert.equal(s.discoveryBonus, 0, "被标记的商家不得领取红利");
  assert.equal(s.takeRate, CFG.baseTakeRate, "被标记的商家不得享受费率优惠");
});

test("异常检测：平稳上升不误伤", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  // 缓慢爬升，每次都 < 3 倍历史均值 —— 属于正常的口碑积累
  for (let i = 0; i < 30; i++) {
    engine.appendEvaluation(ev("gradual", i, { fit: 0.3 + i * 0.02, priorIntent: true }));
  }
  assert.equal(engine.score("gradual").flagged, false, "正常口碑爬升不应被误判为刷量");
});

test("异常检测：冷启动前几单高评价不误伤", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  // 历史样本不足 5 条时的首单高分必须放过
  for (let i = 0; i < 3; i++) engine.appendEvaluation(ev("cold", i, { fit: 0.5, priorIntent: true }));
  engine.appendEvaluation(ev("cold", 3, { fit: 0.98, priorIntent: true }));
  assert.equal(engine.score("cold").flagged, false, "冷启动误伤是最常见的假阳性，必须避免");
});

test("异常检测：单日评价量超限被标记", () => {
  const engine = new ScoringEngine(CFG, () => T0);
  // 全部压在同一天，数量超过 dailyVolumeLimit
  for (let i = 0; i <= CFG.dailyVolumeLimit; i++) {
    engine.appendEvaluation(ev("burst", i, { fit: 0.6, priorIntent: true }));
  }
  const s = engine.score("burst");
  assert.equal(s.flagged, true);
  assert.ok(s.flagReasons.some((r) => r.includes("单日")), `理由应含「单日」：${s.flagReasons.join(";")}`);
});

// ─────────────────────────────────────────────────────────────────
// 9. 配置可注入
// ─────────────────────────────────────────────────────────────────
test("自定义 RewardConfig 生效：提高最小样本量会让商家掉回 belowMinSample", () => {
  const strict = { ...CFG, minSampleSize: 50 };
  const engine = new ScoringEngine(strict, () => T0);
  for (let i = 0; i < 10; i++) {
    const e = ev("tight", i, { fit: 0.95, priorIntent: false });
    engine.appendEvaluation(e);
    engine.appendOutcome(out(e, { noRegret: true }));
  }
  assert.equal(engine.score("tight").belowMinSample, true);
});
