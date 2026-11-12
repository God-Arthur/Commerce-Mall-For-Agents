/**
 * 奖励层服务：「需求发现与产品力」（乔布斯机制）
 *
 * ─────────────────────────────────────────────────────────────────
 * 【红线】适配评价（fitEval）与支付意愿严格解耦 —— fitEval 绝不进定价
 * ─────────────────────────────────────────────────────────────────
 * 本层的 fitEval 只用于三件事：
 *   (1) 度量产品力（realizedFitMean）
 *   (2) 度量需求发现效果（discoveryScore / merchantRank）
 *   (3) 决定入围赛里谁先被推送给买家
 *
 * 本层**没有任何一条代码路径**把 fitEval 写回报价、成交价或出清逻辑。
 * 定价的唯一来源仍是基础层的支付意愿 value / cost + McAfee 双向拍卖。
 *
 * 为什么必须这样隔离（这是硬约束，不是洁癖）：
 *   如果买家知道「fitEval 越高 → 报价越高 → 我付得越多」，理性买家就会
 *   一律低报 fitEval（哪怕很喜欢也报 0.5）。于是：
 *     · 商家拿到的产品力信号失真 → 真正的好商品被挤出入围集
 *     · 需求发现机制反向失效 → 平台再也无法识别好需求
 *     · 整个「昂贵信号」链条崩掉，因为信号本身变成了可低成本伪造的博弈变量
 *   换句话说，一旦 fitEval 有了价格，它就不再是信号，而变成了噪声。
 *   与之相对，支付意愿（value）本身带成本（钱），天然难以低报，
 *   所以把「度量」与「支付」分开是对抗 truthful reporting 的标准做法
 *   （单参数占优策略 DSIC 的思想：让每个信号在各自通道里都是诚实的）。
 *
 * ─────────────────────────────────────────────────────────────────
 * 【红线】单个买家的评价绝不对外披露，只用于聚合
 * ─────────────────────────────────────────────────────────────────
 * 任务书明确要求：单个买家的评价不对外披露。
 * 因此本类的方法被切成两类：
 *   · 对外（scoreOf / reputationOf / shortlistFor）：只返回聚合量与比率，
 *     响应体中不出现任何单个 fitEval，也不出现任何买家 agent id。
 *   · 对内且仅对内（myEvaluations）：只允许评价者本人查看自己的原始评价，
 *     模式对齐基础层的 agentRoundView。
 *
 * ─────────────────────────────────────────────────────────────────
 * 【红线】验证结果（OutcomeRecord）只能由系统回填
 * ─────────────────────────────────────────────────────────────────
 * 「是否成交 / 是否反悔 / 是否复购」是昂贵信号的来源，一旦允许商家自填，
 * 商家就会全填「成交 + 不反悔 + 已复购」。所以 recordOutcome 不接受任何
 * agent 身份参数（方法签名里根本没有「调用者是谁」这一概念），
 * 且 server.ts 不为它注册任何 HTTP 路由 —— 商家在协议层面无法提交。
 * 合法调用方只有基础层的出清/结算流程。
 * HTTP 不暴露 recordOutcome 本身；出清时由服务写入成交与否，
 * 买方只能在成交之后补充反悔与延迟复评，复购由后续成交推断。
 */

import { MarketError } from "../engine.ts";
import type { Agent, RoundResult } from "../domain.ts";
import { ScoringEngine, evaluationKeyOf } from "./scoring.ts";
import {
  DEFAULT_REWARD_CONFIG,
  type Evaluation,
  type MerchantProfile,
  type MerchantScore,
  type OutcomeRecord,
  type RewardConfig,
  type ShortlistEntry,
} from "./domain.ts";

/**
 * 幂等去重键：(round, buyer, product)。
 *
 * 与 scoring.ts 的 evaluationKeyOf 刻意不同：
 *   · 本键服务于「重复提交」的判定口径 —— 任务书要求
 *     同一 (轮次, 买家, 商品) 不可重复评价，否则买家可以反复刷高自己的记录。
 *   · scoring 的键服务于「把成交回填关联回具体评价」，需要带上 merchantId，
 *     因为同一轮里同一个 productId 理论上可由不同商家挂售。
 * 两者各司其职，不互相替代。
 */
function dedupeKey(roundId: string, buyerAgentId: string, productId: string): string {
  return `${roundId}::${buyerAgentId}::${productId}`;
}

export class RewardService {
  private readonly engine: RewardEngineRef;
  private readonly scoring: ScoringEngine;
  private readonly config: RewardConfig;

  /**
   * 本层自持一份评价索引，职责是「幂等去重」与「定位买家自己的原始评价」，
   * 不承担任何计分（计分全部委托 ScoringEngine，避免两套口径）。
   */
  private readonly evaluations = new Map<string, Evaluation>();
  private readonly outcomes = new Map<string, OutcomeRecord>();
  /** 商家自述：只用于展示，绝不参与评分。 */
  private readonly profiles = new Map<string, MerchantProfile>();
  /** 本轮上架。key = roundId::merchantId。入围赛候选来自这里，而不是「已经被评价过的商品」。 */
  private readonly listings = new Map<string, { roundId: string; merchantId: string; productId: string }>();
  /** 同一买家、同一轮、同一商品只计一次展示。 */
  private readonly impressionKeys = new Set<string>();

  constructor(
    engine: RewardEngineRef,
    config: RewardConfig = DEFAULT_REWARD_CONFIG,
    nowFn?: () => number,
  ) {
    this.engine = engine;
    this.config = config;
    this.scoring = new ScoringEngine(config, nowFn);
  }

  // ── 1. 记录评价（只有买方 agent 能提交） ─────────────────────────

  /**
   * 记录一次适配评价。
   *
   * 幂等策略：同一 (roundId, buyerAgentId, productId)
   *   · 内容完全相同 → 视为重试，直接返回原记录，不重复计分
   *   · 内容不同       → 409 报错，避免「改口」刷高分
   */
  recordEvaluation(input: {
    roundId: string;
    buyer: Agent;
    merchantId: unknown;
    productId: unknown;
    priorIntent: unknown;
    fitEval: unknown;
    /** 仅供回放实验注入评价时间。HTTP 不传这个字段，线上用服务器时钟。 */
    submittedAt?: number;
  }): { accepted: true; evaluationId: string; duplicate: boolean } {
    const { roundId, buyer } = input;

    // 角色校验：评价只能来自买方 agent
    if (buyer.role !== "buyer") {
      throw new MarketError(403, "只有买方 agent 可以提交适配评价", "ROLE_MISMATCH");
    }
    // 轮次必须真实存在
    this.engine.getRound(roundId);

    // merchant_id 是 Evaluation 的必填字段，因此它是必填入参。
    // 路由层由 body.merchant_id 提供。
    const merchantId = this.requireMerchantId(input.merchantId);
    const productId = this.assertProductId(input.productId);
    const priorIntent = this.assertPriorIntent(input.priorIntent);
    const fitEval = this.assertFitEval(input.fitEval);

    const key = dedupeKey(roundId, buyer.id, productId);
    const existing = this.evaluations.get(key);
    if (existing) {
      if (existing.fitEval === fitEval && existing.priorIntent === priorIntent) {
        return { accepted: true, evaluationId: key, duplicate: true };
      }
      throw new MarketError(
        409,
        `本轮对该商品已有评价，不可修改（幂等键 ${roundId}/${productId}）`,
        "DUPLICATE_EVALUATION"
      );
    }

    const submittedAt = input.submittedAt ?? Date.now();
    if (typeof submittedAt !== "number" || !Number.isFinite(submittedAt)) {
      throw new MarketError(400, "submittedAt 必须是有限数值", "INVALID_INPUT");
    }
    const record: Evaluation = {
      roundId,
      merchantId,
      productId,
      buyerAgentId: buyer.id,
      priorIntent,
      fitEval,
      submittedAt,
    };
    this.evaluations.set(key, record);
    this.scoring.appendEvaluation(record);
    this.recordImpression({
      roundId,
      buyerAgentId: buyer.id,
      merchantId,
      productId,
      at: record.submittedAt,
    });
    return { accepted: true, evaluationId: key, duplicate: false };
  }

  // ── 1b. 商家上架（候选集的来源） ────────────────────────────────

  /**
   * 登记本轮上架的商品。要价仍由基础层 submitAsk 接收；
   * 这里只让入围赛知道「这个商家有东西可看」。
   */
  registerListing(input: {
    roundId: string;
    merchant: Agent;
    productId: unknown;
  }): { roundId: string; merchantId: string; productId: string } {
    if (input.merchant.role !== "seller") {
      throw new MarketError(403, "只有卖方 agent 可以上架商品", "ROLE_MISMATCH");
    }
    const round = this.engine.getRound(input.roundId);
    if (round.status !== "open") {
      throw new MarketError(409, `轮次 ${input.roundId} 已出清，不可上架`, "ROUND_CLOSED");
    }
    const productId = this.assertProductId(input.productId);
    const key = `${input.roundId}::${input.merchant.id}`;
    const existing = this.listings.get(key);
    if (existing && existing.productId !== productId) {
      throw new MarketError(409, "本轮已上架其他商品", "LISTING_CONFLICT");
    }
    const listing = { roundId: input.roundId, merchantId: input.merchant.id, productId };
    this.listings.set(key, listing);
    return listing;
  }

  /**
   * 记录一次入围展示。重复展示同一买家同一商品不增加分母，
   * 避免靠刷新页面制造「低精度」。
   * @returns 是否是新的展示
   */
  recordImpression(input: {
    roundId: string;
    buyerAgentId: string;
    merchantId: string;
    productId: string;
    at?: number;
  }): boolean {
    const key = `${input.roundId}::${input.buyerAgentId}::${input.merchantId}::${input.productId}`;
    if (this.impressionKeys.has(key)) return false;
    this.impressionKeys.add(key);
    this.scoring.appendImpression(input.merchantId, input.at ?? Date.now());
    return true;
  }

  // ── 2. 回填验证结果（仅系统，绝不暴露给商家） ───────────────────

  /**
   * 回填成交 / 反悔 / 复购 / 延迟复评。
   *
   * ⚠️ 调用方限制：仅出清结算与本服务内部。
   * 刻意不接受 agent / apiKey 参数 —— 调用签名里不存在「调用者身份」，
   * 因此商家 agent 在任何情况下都无法构造一次合法的自评回填。
   * server.ts 不为该方法注册路由。
   */
  recordOutcome(input: {
    roundId: string;
    merchantId: string;
    buyerAgentId: string;
    productId: string;
    traded: boolean;
    noRegret?: boolean | null;
    repeat?: boolean | null;
    delayedFitEval?: number | null;
    recordedAt?: number;
  }): void {
    const key = evaluationKeyOf({
      roundId: input.roundId,
      merchantId: input.merchantId,
      productId: input.productId,
      buyerAgentId: input.buyerAgentId,
    });
    const evaluation = this.evaluations.get(
      dedupeKey(input.roundId, input.buyerAgentId, input.productId)
    );
    if (!evaluation) {
      throw new MarketError(
        404,
        `找不到对应的评价记录，无法回填（${input.roundId}/${input.productId}）`,
        "EVALUATION_NOT_FOUND"
      );
    }
    // 回填的商家必须与被评价的商家一致，否则回填会挂到错误的商品上
    if (evaluation.merchantId !== input.merchantId) {
      throw new MarketError(
        409,
        "回填的 merchant_id 与原评价不一致",
        "MERCHANT_MISMATCH"
      );
    }
    if (this.outcomes.has(key)) {
      // 回填同样只追加一次：已记录的反悔/复购结果不可被覆盖
      return;
    }
    const delayed =
      input.delayedFitEval === null || input.delayedFitEval === undefined
        ? null
        : this.assertFitEval(input.delayedFitEval);

    const outcome: OutcomeRecord = {
      evaluationKey: key,
      merchantId: input.merchantId,
      buyerAgentId: input.buyerAgentId,
      productId: input.productId,
      traded: input.traded,
      noRegret: input.noRegret ?? null,
      repeat: input.repeat ?? null,
      delayedFitEval: delayed,
      recordedAt: input.recordedAt ?? Date.now(),
    };
    this.outcomes.set(key, outcome);
    this.scoring.appendOutcome(outcome);
  }

  /**
   * 出清之后，把本轮每条评价对上实际成交。
   * 成交与否只来自结算单，不来自买家或商家的自述。
   * 同一对买家-商家若在更早的轮次已经成交过，两边的复购标记写成 true。
   */
  ingestClearing(result: RoundResult): { recorded: number } {
    let recorded = 0;
    for (const ev of this.evaluations.values()) {
      if (ev.roundId !== result.roundId) continue;
      const key = evaluationKeyOf(ev);
      if (this.outcomes.has(key)) continue;
      const traded = result.settlements.some(
        (s) =>
          s.buyerAgentId === ev.buyerAgentId &&
          s.sellerAgentId === ev.merchantId &&
          s.quantity > 0,
      );
      // 没看到下一次成交之前，复购是未知而不是「没有复购」。
      // 写成 false 会把还没来得及复购的商家当成不复购。
      const repeat = traded && this.hasPriorTrade(ev.buyerAgentId, ev.merchantId, ev.roundId) ? true : null;
      this.recordOutcome({
        roundId: ev.roundId,
        merchantId: ev.merchantId,
        buyerAgentId: ev.buyerAgentId,
        productId: ev.productId,
        traded,
        noRegret: null,
        repeat,
        delayedFitEval: null,
        recordedAt: ev.submittedAt,
      });
      if (traded && repeat) this.markPriorRepeat(ev.buyerAgentId, ev.merchantId, ev.roundId);
      recorded++;
    }
    return { recorded };
  }

  /**
   * 买方在成交之后补充事后信号：是否反悔、延迟复评。
   * 不能改写成交与否，也不能自己声称复购。已经写过的值不能翻案。
   */
  submitFeedback(input: {
    roundId: string;
    buyer: Agent;
    productId: unknown;
    noRegret?: unknown;
    delayedFitEval?: unknown;
  }): { updated: boolean } {
    if (input.buyer.role !== "buyer") {
      throw new MarketError(403, "只有买方 agent 可以提交事后反馈", "ROLE_MISMATCH");
    }
    const round = this.engine.getRound(input.roundId);
    if (round.status !== "cleared") {
      throw new MarketError(409, "出清前不能提交事后反馈", "ROUND_OPEN");
    }
    if (input.noRegret === undefined && input.delayedFitEval === undefined) {
      throw new MarketError(400, "至少提供 no_regret 或 delayed_fit_eval", "INVALID_INPUT");
    }
    const productId = this.assertProductId(input.productId);
    const ev = this.evaluations.get(dedupeKey(input.roundId, input.buyer.id, productId));
    if (!ev) {
      throw new MarketError(404, "找不到你在本轮对该商品的评价", "EVALUATION_NOT_FOUND");
    }
    const outcome = this.outcomes.get(evaluationKeyOf(ev));
    if (!outcome) {
      throw new MarketError(409, "系统尚未写入本轮成交结果", "OUTCOME_MISSING");
    }
    if (!outcome.traded) {
      throw new MarketError(409, "未成交的评价不能提交反悔或延迟复评", "NOT_TRADED");
    }

    let updated = false;
    if (input.noRegret !== undefined) {
      if (typeof input.noRegret !== "boolean") {
        throw new MarketError(400, "no_regret 必须是布尔值", "INVALID_INPUT");
      }
      if (outcome.noRegret === null) {
        outcome.noRegret = input.noRegret;
        updated = true;
      } else if (outcome.noRegret !== input.noRegret) {
        throw new MarketError(409, "反悔结果已记录，不能翻案", "OUTCOME_LOCKED");
      }
    }
    if (input.delayedFitEval !== undefined) {
      const delayed = this.assertFitEval(input.delayedFitEval);
      if (outcome.delayedFitEval === null) {
        outcome.delayedFitEval = delayed;
        updated = true;
      } else if (outcome.delayedFitEval !== delayed) {
        throw new MarketError(409, "延迟复评已记录，不能翻案", "OUTCOME_LOCKED");
      }
    }
    return { updated };
  }

  // ── 3. 查询商家评分（聚合口径） ─────────────────────────────────

  /**
   * 商家产品力 / 发现分 / 排名。
   *
   * 对外披露策略：只给 MerchantScore（聚合后的均值 / 比率 / 计数），
   * 绝不附带任何单条 fitEval，也绝不附带买家 agent id。
   */
  scoreOf(merchantId: string): MerchantScore {
    this.assertMerchantExists(merchantId);
    return this.rankedScoreOf(merchantId);
  }

  // ── 4. 查询商家声誉（已验证 vs 自述） ───────────────────────────

  /**
   * 商家声誉：把「已验证的产品力信号」与「商家自述」分栏返回，
   * 让调用方（尤其是买家 agent）在结构上就不可能把两者混淆。
   */
  reputationOf(merchantId: string): {
    merchantId: string;
    verified: {
      /** 信号来源说明，让买家知道这些数字为什么可信 */
      source: "verified-outcomes";
      note: string;
      realizedFitMean: number | null;
      noRegretRate: number | null;
      repeatRate: number | null;
      durability: number | null;
      productPowerScore: number;
      discoveryScore: number;
      merchantRank: number;
      sampleSize: number;
      belowMinSample: boolean;
      flagged: boolean;
      flagReasons: string[];
    };
    unverified: {
      source: "merchant-self-report";
      note: string;
      description: string;
      credentials: string[];
    };
  } {
    const score = this.scoreOf(merchantId);
    const profile = this.profileOf(merchantId);
    return {
      merchantId,
      verified: {
        source: "verified-outcomes",
        note:
          "以下数值全部来自买家评价与真实成交结果的聚合，由系统记录，商家无法自行填写或修改。",
        realizedFitMean: score.metrics.realizedFitMean,
        noRegretRate: score.metrics.noRegretRate,
        repeatRate: score.metrics.repeatRate,
        durability: score.metrics.durability,
        productPowerScore: score.productPowerScore,
        discoveryScore: score.discoveryScore,
        merchantRank: score.merchantRank,
        sampleSize: score.sampleSize,
        belowMinSample: score.belowMinSample,
        flagged: score.flagged,
        flagReasons: score.flagReasons,
      },
      unverified: {
        source: "merchant-self-report",
        note: "以下内容为商家自述，未经任何验证，不参与评分与排名。",
        description: profile.description,
        credentials: profile.claimedCredentials,
      },
    };
  }

  // ── 5. 入围赛候选集 ────────────────────────────────────────────

  /**
   * 给定买方 agent，返回本轮入围候选，按 merchantRank 降序。
   *
   * 信息隔离：
   *   · verifiedSignals 只放聚合值（均值 / 比率），不含任何单条 fitEval
   *   · 不返回评价者身份
   *   · 剔除该买家自己已评价过的商品，避免自评回流影响自己的候选集
   */
  shortlistFor(roundId: string, buyer: Agent, limit = 10, shownAt = Date.now()): {
    roundId: string;
    buyerAgentId: string;
    total: number;
    candidates: ShortlistEntry[];
  } {
    this.engine.getRound(roundId);
    if (buyer.role !== "buyer") {
      throw new MarketError(403, "只有买方 agent 可以拉取入围候选集", "ROLE_MISMATCH");
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      throw new MarketError(400, "limit 必须是 1..100 的整数", "INVALID_INPUT");
    }

    // 已被该买家评过的商品，直接从候选中剔除
    const seenByBuyer = new Set<string>();
    for (const ev of this.evaluations.values()) {
      if (ev.roundId === roundId && ev.buyerAgentId === buyer.id) {
        seenByBuyer.add(`${ev.merchantId}::${ev.productId}`);
      }
    }

    // 全局排名只算一次：费率是相对位次的函数，必须在全量语境下确定，
    // 否则每个商家都按基础费率算就失去了「排名影响抽成」的意义。
    const ranked = new Map(
      this.scoring.rankAll().map((r) => [r.merchantId, r.score])
    );

    const pool = this.candidatePool(roundId)
      .filter((c) => !seenByBuyer.has(`${c.merchantId}::${c.productId}`))
      .map((c) => {
        const score = ranked.get(c.merchantId) ?? this.scoring.score(c.merchantId);
        const profile = this.profileOf(c.merchantId);
        const entry: ShortlistEntry = {
          merchantId: c.merchantId,
          rank: 0,
          score: score.merchantRank,
          productId: c.productId,
          explored: false,
          // 仅聚合口径 —— 昂贵信号
          verifiedSignals: {
            realizedFitMean: score.metrics.realizedFitMean,
            noRegretRate: score.metrics.noRegretRate,
            repeatRate: score.metrics.repeatRate,
          },
          // 明示为商家自述、未验证
          unverifiedClaims: {
            description: profile.description,
            credentials: profile.claimedCredentials,
          },
        };
        return entry;
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const byName = this.agentName(a.merchantId).localeCompare(this.agentName(b.merchantId));
        if (byName !== 0) return byName;
        return a.merchantId.localeCompare(b.merchantId);
      });

    const selected = selectShortlist(pool, limit, `${roundId}:${buyer.name}`);
    const candidates = selected.map((e, i) => ({ ...e, rank: i + 1 }));
    for (const c of candidates) {
      this.recordImpression({
        roundId,
        buyerAgentId: buyer.id,
        merchantId: c.merchantId,
        productId: c.productId,
        at: shownAt,
      });
    }
    return { roundId, buyerAgentId: buyer.id, total: pool.length, candidates };
  }

  // ── 6. 私密回执：只有评价者本人能看到自己的原始评价 ───────────

  /**
   * 按角色裁剪的私有视图，模式对齐基础层 agentRoundView。
   * 传入非评价者本人的 agent 时返回空列表 —— 商家与他人永远看不到这条。
   */
  myEvaluations(buyer: Agent, roundId?: string): {
    agentId: string;
    note: string;
    evaluations: Array<{
      roundId: string;
      productId: string;
      merchantId: string;
      priorIntent: boolean;
      fitEval: number;
      submittedAt: number;
    }>;
  } {
    if (buyer.role !== "buyer") {
      throw new MarketError(403, "只有买方 agent 可以查看自己的评价", "ROLE_MISMATCH");
    }
    const mine = [...this.evaluations.values()]
      .filter((e) => e.buyerAgentId === buyer.id)
      .filter((e) => roundId === undefined || e.roundId === roundId)
      .sort((a, b) => a.submittedAt - b.submittedAt)
      .map((e) => ({
        roundId: e.roundId,
        productId: e.productId,
        merchantId: e.merchantId,
        priorIntent: e.priorIntent,
        fitEval: e.fitEval,
        submittedAt: e.submittedAt,
      }));
    return {
      agentId: buyer.id,
      note: "仅本人可见；这些原始评分不会以任何形式披露给商家或其他买家。",
      evaluations: mine,
    };
  }

  // ── 内部工具 ───────────────────────────────────────────────────

  /**
   * 取某商家的评分，且费率/名次在**全局排名语境**下确定。
   *
   * 抽成费率是「相对位次」的函数，单看一个商家算不出来，
   * 所以必须走 rankAll() 拿全局分位，而不是直接调 score()（它默认按
   * percentile=0 即基础费率算，会把所有商家都当成末位）。
   */
  private rankedScoreOf(merchantId: string): MerchantScore {
    const ranked = this.scoring.rankAll().find((r) => r.merchantId === merchantId);
    // 该商家还没有任何评价/回填记录时不在 rankAll 中，退回基础口径
    return ranked ? ranked.score : this.scoring.score(merchantId);
  }

  /** 本轮上架的商品，加上本轮已被评价、但没有上架记录的商品。 */
  private candidatePool(roundId: string): Array<{ merchantId: string; productId: string }> {
    const map = new Map<string, { merchantId: string; productId: string }>();
    for (const listing of this.listings.values()) {
      if (listing.roundId !== roundId) continue;
      map.set(`${listing.merchantId}::${listing.productId}`, {
        merchantId: listing.merchantId,
        productId: listing.productId,
      });
    }
    for (const ev of this.evaluations.values()) {
      if (ev.roundId !== roundId) continue;
      map.set(`${ev.merchantId}::${ev.productId}`, {
        merchantId: ev.merchantId,
        productId: ev.productId,
      });
    }
    return [...map.values()];
  }

  private agentName(agentId: string): string {
    try {
      return this.engine.getAgent(agentId).name;
    } catch {
      return agentId;
    }
  }

  /** 更早轮次里，这对买家和商家是否已经成交过。 */
  private hasPriorTrade(buyerAgentId: string, merchantId: string, roundId: string): boolean {
    for (const outcome of this.outcomes.values()) {
      if (!outcome.traded) continue;
      if (outcome.buyerAgentId !== buyerAgentId || outcome.merchantId !== merchantId) continue;
      if (roundIdOf(outcome.evaluationKey) === roundId) continue;
      return true;
    }
    return false;
  }

  /** 后续成交证实了复购：把此前仍为 null 的复购标记补成 true。不能把 false 改掉。 */
  private markPriorRepeat(buyerAgentId: string, merchantId: string, roundId: string): void {
    for (const outcome of this.outcomes.values()) {
      if (!outcome.traded) continue;
      if (outcome.buyerAgentId !== buyerAgentId || outcome.merchantId !== merchantId) continue;
      if (roundIdOf(outcome.evaluationKey) === roundId) continue;
      if (outcome.repeat === null) outcome.repeat = true;
    }
  }

  /**
   * 商家自述档案。v1 没有商家自助注册入口，直接以基础层 agent 的
   * 名称作为其自述简介，credentials 留空 —— 保证「无自述」也是一种诚实状态，
   * 而不是被默认填充的美化文案。
   */
  private profileOf(merchantId: string): MerchantProfile {
    let p = this.profiles.get(merchantId);
    if (!p) {
      const agent = this.engine.getAgent(merchantId);
      p = {
        merchantId,
        description: `${agent.name}（未提供自述简介）`,
        claimedCredentials: [],
        registeredAt: agent.createdAt ?? Date.now(),
      };
      this.profiles.set(merchantId, p);
    }
    return p;
  }

  private requireMerchantId(mid: unknown): string {
    if (typeof mid !== "string" || mid.trim() === "") {
      throw new MarketError(400, "merchant_id 不能为空", "INVALID_INPUT");
    }
    const agent = this.engine.getAgent(mid);
    if (agent.role !== "seller") {
      throw new MarketError(400, `agent ${mid} 不是商家（seller）`, "INVALID_MERCHANT");
    }
    return mid;
  }

  private assertMerchantExists(merchantId: string): void {
    const agent = this.engine.getAgent(merchantId);
    if (agent.role !== "seller") {
      throw new MarketError(400, `agent ${merchantId} 不是商家（seller）`, "INVALID_MERCHANT");
    }
  }

  private assertProductId(v: unknown): string {
    if (typeof v !== "string" || v.trim() === "") {
      throw new MarketError(400, "product_id 不能为空", "INVALID_INPUT");
    }
    if (v.includes("::")) {
      throw new MarketError(400, "product_id 不能包含 '::'", "INVALID_INPUT");
    }
    return v.trim();
  }

  private assertPriorIntent(v: unknown): boolean {
    if (typeof v !== "boolean") {
      throw new MarketError(400, "prior_intent 必须是布尔值", "INVALID_INPUT");
    }
    return v;
  }

  /** fitEval 的校验是本层唯一被严格约束的入参：必须是 [0,1] 内的有限数。 */
  private assertFitEval(v: unknown): number {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new MarketError(400, "fit_eval 必须是有限数值", "INVALID_INPUT");
    }
    if (v < 0 || v > 1) {
      throw new MarketError(400, "fit_eval 必须落在 [0,1] 区间", "INVALID_INPUT");
    }
    return v;
  }

  /** 配置只读暴露，便于排障与测试。 */
  getConfig(): RewardConfig {
    return this.config;
  }
}

/**
 * 本层对基础层的最小依赖面。
 * 刻意只声明用到的三个方法，避免 reward -> engine 的循环依赖。
 */
interface RewardEngineRef {
  getAgent(id: string): Agent;
  getRound(id: string): { id: string; status: string };
}

function roundIdOf(evaluationKey: string): string {
  return evaluationKey.split("::")[0] ?? "";
}

/**
 * 入围名单：高分优先，并在名单够长时留一个探索位。
 * 探索位按买家名字与轮次旋转，同一买家重复拉取不会换人，刷新不制造新展示。
 */
function selectShortlist<T extends { merchantId: string; productId: string }>(
  sorted: T[],
  limit: number,
  rotationKey: string,
): Array<T & { explored: boolean }> {
  const withFlag = sorted.map((item) => ({ ...item, explored: false }));
  if (withFlag.length <= limit || limit < 3) return withFlag.slice(0, limit);

  const exploreSlots = 1;
  const core = withFlag.slice(0, limit - exploreSlots);
  const rest = withFlag.slice(limit - exploreSlots);
  const start = hashString(rotationKey) % rest.length;
  const rotated = rest.slice(start).concat(rest.slice(0, start));
  const explored = rotated.slice(0, exploreSlots).map((item) => ({ ...item, explored: true }));
  return core.concat(explored);
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
