/**
 * 商家评分引擎（奖励层核心）
 * ─────────────────────────────────────────────────────────────────
 * 任务书核心公式：
 *   product_power_score = w1*realized_fit_mean + w2*no_regret_rate
 *                       + w3*repeat_rate + w4*durability
 *   discovery_score     = discovery_rate × discovery_precision
 *   merchant_rank       = f(product_power_score, discovery_score)
 *
 * ─────────────────────────────────────────────────────────────────
 * 本文件的设计第一原则：**分数不是「好不好」，而是「有多难伪造」**
 * ─────────────────────────────────────────────────────────────────
 * 任何评分体系一旦成为利益分配依据，就会被 Goodhart 定律攻击：
 * 当一个指标成为目标，它就不再是好的指标。因此本引擎的每一个设计
 * 都必须回答同一个问题：「商家如果想刷分，他会怎么做？我的设计能挡住吗？」
 *
 * 已实现的反操纵防线（详见各函数注释）：
 *   1. 最小样本量        —— 新商家无法靠 1 条好评冲顶
 *   2. 指数时间衰减      —— 旧功劳持续贬值，无法「躺着领奖」
 *   3. null 重归一化     —— 缺失数据不惩罚，避免刷「少评价但极高分」
 *   4. 发现精度          —— 广撒网 = 低精度 = 低分
 *   5. 精度对产品力的反噬 —— 大量低质推送本身即产品力差的信号
 *   6. merchant_rank 用几何平均 + 下限保护 —— 单一维度无法独立撑起排名
 *   7. 异常检测          —— fit_eval 飙升 / 单日量爆表 → 人工复核
 *   8. 红利封顶          —— 刷量套利有上限
 *
 * 依赖：仅 node: 内置模块 + ./domain.ts（领域类型，单向依赖）
 */

import type {
  Evaluation,
  MerchantScore,
  OutcomeRecord,
  ProductPowerMetrics,
  RewardConfig,
} from "./domain.ts";
import { DEFAULT_REWARD_CONFIG } from "./domain.ts";

/**
 * merchant_rank 中产品力的指数权重（发现度占 1 - 该值）
 *
 * 为什么是几何平均而不是加权和？
 *   加权和有一个致命漏洞：A(产品力 0.05, 发现度 1.0) 与
 *   B(产品力 0.80, 发现度 0.30) 在 α=0.7 的加权和下分别是
 *   0.335 与 0.65 —— 尚可；但把 α 调到 0.5 就会让「只刷发现分」的
 *   商家追平真正做产品的商家。加权和的任何权重取值都无法保证
 *   「单一维度不能独立撑起排名」，因为加法天生允许补偿。
 *
 *   几何平均天然具备「短板惩罚」性质：
 *   A: 0.05^0.7 * 1.0^0.3 ≈ 0.137
 *   B: 0.80^0.7 * 0.30^0.3 ≈ 0.663
 *   差距被指数放大，且**无论怎么调 α，只要 α>0.5**，
 *   「产品力极低」就会在数值上被「发现度满分」压过去。
 *   这是 Goodhart 漏洞的结构性封堵，而非参数调优。
 */
export const RANK_PRODUCT_EXPONENT = 0.7;

/**
 * 几何平均的输入下限（epsilon floor）
 *
 * 直接对 0 取几何平均会让「还没积累足够推送量」的商家 rank = 0，
 * 即冷启动商家永远无法进入候选集 —— 这是另一种不公平。
 * 因此对两个分量取 max(x, RANK_FLOOR)，让缺失值以「接近 0 但非 0」
 * 的中性偏保守姿态参与：既不奖励空白，也不彻底埋葬新商家。
 */
export const RANK_FLOOR = 0.05;

/** 发现精度低于该值即视为「广撒网」，触发对产品力的额外惩罚 */
export const PRECISION_PENALTY_THRESHOLD = 0.15;

/** 精度惩罚的最大强度：精度为 0 时产品力乘以 (1 - 0.5) = 0.5 */
export const PRECISION_PENALTY_STRENGTH = 0.5;

/** 异常检测所需的最小历史样本（低于此数不判飙升，避免冷启动误伤） */
const SPIKE_MIN_HISTORY = 5;

/**
 * 时效因子的地板值。
 *
 * 加权平均 Σ(w·x)/Σw 对「同质老样本」失效：一家十年前拿了 10 条满分、
 * 此后再无任何评价的商家，其历史均值仍是 1.0，永远躺赢。
 * 时效因子专门收拾这种情况：取「最新一条评价」的新鲜度，
 * 长期停更的商家因子降到地板，历史好口碑被显著折价。
 *
 * 取 0.3 而非 0：完全归零等于宣判商家死刑，等于用「不新鲜」替代
 * 「表现差」，同样是另一种不公平。折价到三成，保留翻身可能。
 */
const RECENCY_FLOOR = 0.3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 单条评价的唯一定位键，用于把成交回填记录关联到评价 */
export function evaluationKeyOf(e: {
  roundId: string;
  merchantId: string;
  productId: string;
  buyerAgentId: string;
}): string {
  return `${e.roundId}::${e.merchantId}::${e.productId}::${e.buyerAgentId}`;
}

/** 一次排名计算的输出条目 */
export interface RankedMerchant {
  merchantId: string;
  /** 0-based 名次，0 为最优 */
  position: number;
  score: MerchantScore;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export class ScoringEngine {
  private readonly config: RewardConfig;
  private readonly nowFn: () => number;
  private readonly evaluations: Evaluation[] = [];
  private readonly outcomes: OutcomeRecord[] = [];
  /** merchantId -> outcomes 索引，避免每次打分都全表扫描 */
  private readonly outcomesByMerchant: Map<string, OutcomeRecord[]> = new Map();

  /**
   * @param config 可选的自定义配置，默认使用 DEFAULT_REWARD_CONFIG
   * @param nowFn  可注入的时钟（便于测试与回放），默认 Date.now
   */
  constructor(config?: RewardConfig, nowFn?: () => number) {
    this.config = config ?? DEFAULT_REWARD_CONFIG;
    this.nowFn = nowFn ?? Date.now;
  }

  /** 只读暴露当前配置，便于调用方展示「口径」 */
  getConfig(): RewardConfig {
    return this.config;
  }

  /**
   * 记录一条适配评价。
   *
   * 注意：评价是**只追加**的，没有任何「修改/删除」入口。
   * 这一点本身是一条反操纵设计 —— 如果商家能撤回差评，
   * 那么「好评率」这个指标就退化成了「撤回差评的执行力」。
   */
  appendEvaluation(evaluation: Evaluation): void {
    this.evaluations.push(evaluation);
  }

  /**
   * 回填成交/反悔/复购/延迟复评结果。
   *
   * 这些字段**只能由系统依据真实交易与后续行为写入**，不接受商家自述。
   * 本方法同样只追加：已回填的反悔结果不可被覆盖（退货流程无法被商家撤销）。
   */
  appendOutcome(outcome: OutcomeRecord): void {
    this.outcomes.push(outcome);
    const bucket = this.outcomesByMerchant.get(outcome.merchantId);
    if (bucket) bucket.push(outcome);
    else this.outcomesByMerchant.set(outcome.merchantId, [outcome]);
  }

  /** 某商家的评价条数（= 样本量） */
  sampleSize(merchantId: string): number {
    let n = 0;
    for (const e of this.evaluations) if (e.merchantId === merchantId) n++;
    return n;
  }

  /** 某商家的全部评价，按提交时间升序 */
  evaluationsOf(merchantId: string): Evaluation[] {
    return this.evaluations
      .filter((e) => e.merchantId === merchantId)
      .sort((a, b) => a.submittedAt - b.submittedAt);
  }

  /** 某商家的全部成交回填记录 */
  outcomesOf(merchantId: string): OutcomeRecord[] {
    return this.outcomesByMerchant.get(merchantId) ?? [];
  }

  // ─────────────────────────────────────────────────────────────────
  // 核心：计算单个商家的 MerchantScore
  // ─────────────────────────────────────────────────────────────────

  /**
   * 计算某商家的完整评分。
   *
   * @param merchantId 商家 id
   * @param rankPercentile 该商家在候选集中的相对位置 ∈[0,1]，1 = 最优。
   *   单独调用本方法时无法知道全局排名，默认取 0（即拿基础费率）。
   *   需要费率时优先使用 {@link rankAll}，它会自动完成全局排名。
   */
  score(merchantId: string, rankPercentile = 0): MerchantScore {
    const now = this.nowFn();
    const cfg = this.config;

    const evals = this.evaluationsOf(merchantId);
    const outs = this.outcomesOf(merchantId);
    const sampleSize = evals.length;
    const belowMinSample = sampleSize < cfg.minSampleSize;

    // ── 1. 产品力四维 ──────────────────────────────────────────────
    // 时间衰减的两项职责，必须分开实现，否则一定顾此失彼：
    //
    //   (A) 让「极老的坏证据」退出计算 —— 一年前那批差评不该拖垮今天的表现。
    //       这由「加权平均」Σ(w·x)/Σw 天然满足：40 条一年前差评的权重
    //       约为 2^-12 ≈ 0.0002，在分母里几乎不存在，自然退出。
    //
    //   (B) 让「整体停更的老口碑」不能永久躺赢 —— 一家三年没动过的商家，
    //       不该靠十年前的满分永久占据高排名。
    //       注意：加权平均对这件事**完全失效**。因为若样本同质（都是 1.0），
    //       Σ(w·x)/Σw = 1.0 恒成立，权重被完全约掉 —— 无论多老都是 1.0。
    //
    //   早期实现曾试图靠「分母不衰减」(Σ(w·x)/N) 同时解决 (A)(B)，实测发现
    //   会让 (A) 崩坏：40 条一年前差评 + 6 条今天好评，本该 ≈0.95 却只有 0.124
    //   （老差评权重虽趋近 0，但仍全额占据分母，把新表现稀释了）。
    //
    //   因此最终方案：分母用 Σw（保证 A），再乘一个基于「最新评价新鲜度」的
    //   时效因子（保证 B）。两者职责单一，互不干扰。
    const decay = (ts: number): number => {
      const ageDays = Math.max(0, (now - ts) / DAY_MS);
      return Math.pow(0.5, ageDays / cfg.halfLifeDays);
    };

    /**
     * 时效因子 ∈ [RECENCY_FLOOR, 1]。
     *
     * 取「最新一条评价」的新鲜度：越久没有新评价，越接近下限。
     * 一个商家若三个月没拿到任何新评价，因子降至地板，
     * 其历史好口碑会被显著折价 —— 无法靠吃老本永久霸榜。
     */
    let recency = 1;
    if (evals.length > 0) {
      let newest = Number.NEGATIVE_INFINITY;
      for (const e of evals) if (e.submittedAt > newest) newest = e.submittedAt;
      recency = Math.max(RECENCY_FLOOR, decay(newest));
    }

    let fitNum = 0;
    let fitDen = 0;
    for (const e of evals) {
      const w = decay(e.submittedAt);
      fitNum += w * clamp01(e.fitEval);
      fitDen += w;
    }
    /**
     * 加权平均（分母 = Σw）：极老样本自然退出，满足职责 (A)。
     * 内部始终有值（空样本为 0），用于 durability 的分母。
     */
    const decayedFitMean = fitDen > 0 ? fitNum / fitDen : 0;
    /** 经时效因子折价后的适配均值：同时满足 (A)(B)。 */
    const freshFitMean = clamp01(decayedFitMean * recency);

    const noRegretRate = decayedRatio(
      outs.filter((o) => o.noRegret !== null),
      (o) => (o.noRegret === true ? 1 : 0),
      (o) => decay(o.recordedAt)
    );

    const repeatRate = decayedRatio(
      outs.filter((o) => o.repeat !== null),
      (o) => (o.repeat === true ? 1 : 0),
      (o) => decay(o.recordedAt)
    );

    // ── 2. durability：用「延迟复评」区分真品质与一时新鲜 ─────────────
    // 一次成交当下的兴奋不等于长期满意。durability = 延迟复评均值 / 当期适配均值，
    // 上限 1。产品力强但三个月后买家给 0 分的商家，会在这一项上被打回原形。
    let delayed = weightedRate(
      outs.filter((o) => o.delayedFitEval !== null),
      (o) => clamp01(o.delayedFitEval as number),
      (o) => decay(o.recordedAt)
    );

    let durability: number | null = null;
    if (delayed === null) {
      // 没有延迟复评数据 —— 按 null 处理（中性），绝不按 0 处理
      durability = null;
    } else if (belowMinSample) {
      // 分母（当期适配均值）不可信时，durability 同样不可信
      durability = null;
    } else {
      durability = decayedFitMean <= 0 ? 0 : clamp01(delayed / decayedFitMean);
    }

    const metrics: ProductPowerMetrics = {
      // 样本不足时置 null（不计入评分），而不是置 0（不公平地惩罚新商家）
      // realizedFitMean 额外乘了时效因子：整体停更的老口碑会被折价，
      // 使「无法靠吃老本永久躺赢」这一职责生效（见上方注释）。
      realizedFitMean: belowMinSample ? null : freshFitMean,
      noRegretRate,
      repeatRate,
      durability,
    };

    // ── 3. 发现相关 ────────────────────────────────────────────────
    // 发现事件的定义必须**两个条件同时成立**，缺一不可：
    //   (a) priorIntent === false：买家事先真的没有这个需求信号
    //   (b) fitEval >= discoveryFitThreshold：推给他的东西确实合用
    // 只有 (b) 是「好推荐」，只有 (a) 是「凭空创造需求」，两者取交集
    // 才是平台要奖励的「需求发现」（乔布斯机制）。
    let evImpr = 0;
    let evEvents = 0;
    for (const e of evals) {
      const w = decay(e.submittedAt);
      evImpr += w;
      if (e.priorIntent === false && e.fitEval >= cfg.discoveryFitThreshold) {
        evEvents += w;
      }
    }

    const totalImpressions = sampleSize;
    const rawDiscoveryEvents = evals.filter(
      (e) => e.priorIntent === false && e.fitEval >= cfg.discoveryFitThreshold,
    ).length;

    // 分母是**全部**推送量，不是只有高适配的那部分。
    // 这是防「广撒网碰运气」的关键：推 1000 条中 30 条蒙对了，
    // 精度只有 3%，远低于只推 10 条命中 4 条的商家。
    const discoveryPrecision = evImpr > 0 ? clamp01(evEvents / evImpr) : 0;
    const discoveryRate = evImpr > 0 ? clamp01(evEvents / evImpr) : 0;

    // 推送量不足时发现分不生效（置 0）：否则 1 次推送 1 次发现就能拿满分
    const discoveryScore =
      totalImpressions >= cfg.minImpressions
        ? clamp01(discoveryRate * discoveryPrecision)
        : 0;

    // ── 4. 精度对产品力的反噬惩罚 ────────────────────────────────────
    // 为什么低精度要罚产品力？
    //   因为「大量低质推送」本身就是产品力差的**外生证据**：
    //   一个真正了解用户需求的商家，天然推送得准；只能靠广撒网的商家，
    //   说明它并不理解买家要什么。这条惩罚把 discovery 的信息量
    //   反向注入 product_power，防止商家用「无脑铺量」去美化发现分。
    // 注意只在本商家推送量足够时才施加，否则 3 次推送 0 次发现的新商家
    // 会被无端腰斩。
    const precisionPenalty =
      totalImpressions >= cfg.minImpressions
        ? 1 -
          PRECISION_PENALTY_STRENGTH *
            Math.max(
              0,
              (PRECISION_PENALTY_THRESHOLD - discoveryPrecision) /
                PRECISION_PENALTY_THRESHOLD,
            )
        : 1;

    // ── 5. 产品力得分：加权求和 + null 重归一化 ───────────────────────
    // null 重归一化是本引擎最关键的「反刷分」细节之一：
    //   若把 null 当 0，一个只做 1 笔完美交易的商家会拿到 0.35/1.0 的分数，
    //   从而**奖励数据稀疏**——这恰好是刷分者最喜欢的行为（少评价、
    //   挑好的评）。重归一化让「没数据」的维度自动退出分母，
    //   使各商家的分数只在同一口径下可比。
    const dims: Array<[number, number | null]> = [
      [cfg.weights.realizedFitMean, metrics.realizedFitMean],
      [cfg.weights.noRegretRate, metrics.noRegretRate],
      [cfg.weights.repeatRate, metrics.repeatRate],
      [cfg.weights.durability, metrics.durability],
    ];
    let wUsed = 0;
    let acc = 0;
    for (const [w, m] of dims) {
      if (m === null) continue;
      acc += w * clamp01(m);
      wUsed += w;
    }
    // 所有维度皆不可用 → 0 分 + belowMinSample
    const rawPower = wUsed > 0 ? acc / wUsed : 0;
    const productPowerScore =
      belowMinSample || wUsed <= 0 ? 0 : clamp01(rawPower * precisionPenalty);

    // ── 6. 异常检测 ────────────────────────────────────────────────
    const flagReasons = this.detectAnomalies(evals);
    const flagged = flagReasons.length > 0;

    // ── 7. merchant_rank ───────────────────────────────────────────
    const merchantRank = rankOf(productPowerScore, discoveryScore);

    // ── 8. 发现红利与费率 ──────────────────────────────────────────
    // 样本不足或被标记异常的商家不享受红利，也不享受费率优惠：
    //   宁可暂时少给，也不能让可疑商家先拿到钱再去解释。
    const bonusEligible = !belowMinSample && !flagged;
    const discoveryBonus = bonusEligible
      ? Math.min(
          cfg.discoveryBonusCap,
          cfg.discoveryBonusBase * evEvents * discoveryScore,
        )
      : 0;

    const takeRate =
      belowMinSample || flagged
        ? cfg.baseTakeRate
        : takeRateFor(cfg, clamp01(rankPercentile));

    return {
      merchantId,
      productPowerScore,
      discoveryScore,
      merchantRank,
      metrics,
      discovery: {
        totalImpressions,
        discoveryEvents: rawDiscoveryEvents,
        discoveryPrecision,
      },
      sampleSize,
      belowMinSample,
      flagged,
      flagReasons,
      takeRate,
      discoveryBonus,
    };
  }

  /**
   * 计算所有出现过的商家的排名（用于候选集排序）。
   *
   * 费率必须**在全局排名的语境下**才能确定：费率是相对位次的函数，
   * 单看一个商家无法知道自己排第几。所以这里一次性算出全部分数、
   * 排序、再回填费率与名次。
   */
  rankAll(): RankedMerchant[] {
    const ids = new Set<string>();
    for (const e of this.evaluations) ids.add(e.merchantId);
    for (const o of this.outcomes) ids.add(o.merchantId);

    const scored = [...ids].map((id) => ({ id, s: this.score(id, 0) }));
    // 排序：merchantRank 降序；同分时样本量大者优先（更可信）
    scored.sort((a, b) => {
      if (b.s.merchantRank !== a.s.merchantRank) {
        return b.s.merchantRank - a.s.merchantRank;
      }
      return b.s.sampleSize - a.s.sampleSize;
    });

    const n = scored.length;
    return scored.map((item, i) => {
      // 分位：最优者 1，最差者 0；n=1 时视为最优
      const percentile = n <= 1 ? 1 : (n - 1 - i) / (n - 1);
      const score: MerchantScore =
        item.s.flagged || item.s.belowMinSample
          ? item.s
          : { ...item.s, takeRate: takeRateFor(this.config, percentile) };
      return { merchantId: item.id, position: i, score };
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // 异常检测
  // ─────────────────────────────────────────────────────────────────

  /**
   * 两种触发条件（任一命中即 flagged，交人工复核）：
   *
   * A. fit_eval 异常飙升
   *    判定：某次评价的 fitEval > 该商家**此前**历史均值的 spikeFactor 倍，
   *    且此前历史样本 ≥ SPIKE_MIN_HISTORY。
   *    为什么要用「此前」而不是「含本次」的历史均值？
   *      因为若把本次算进去，一个刷分者可以连续提交高分自我抬高均值，
   *      序列前几次永远不会被标记；用**严格前缀均值**则第一次跃升就会被抓住。
   *    为什么要有最小历史样本？
   *      冷启动商家的前几单评价天然方差大（均值可能只有 0.5），
   *      0.9 的首单就会被判飙升 —— 这是误伤，必须避免。
   *
   * B. 单日评价数超限
   *    判定：某个自然日（UTC）的评价数 > dailyVolumeLimit。
   *    真实买家的评估频率受人类作息约束，单日数百条只可能是机器批量生成。
   *
   * 注意：「历史样本足够」必须按**记录条数**判定，不能按衰减后的权重和判定。
   * 若按权重和判定，一个评价集中在几个半衰期之前的老商家，其权重和可能
   * 远小于 5，于是永远达不到阈值、永远不会被检测 —— 这恰好给了刷分者
   * 一条可乘之机：「先把历史评价摊到很久以前，再集中爆一批高分」。
   * 记录条数才是「证据量」的诚实度量。
   */
  private detectAnomalies(evals: Evaluation[]): string[] {
    const reasons: string[] = [];
    const cfg = this.config;

    // A. fit_eval 飙升（使用严格前缀均值，按记录条数判定样本充分性）
    let histNum = 0;
    let histDen = 0;
    let histCount = 0;
    for (const e of evals) {
      if (histCount >= SPIKE_MIN_HISTORY && histDen > 0) {
        const histMean = histNum / histDen;
        if (e.fitEval > histMean * cfg.spikeFactor) {
          reasons.push(
            `适配分异常飙升：该次评价 fitEval=${e.fitEval.toFixed(3)}，` +
              `超过此前 ${histCount} 条历史均值 ${histMean.toFixed(3)} 的 ` +
              `${cfg.spikeFactor} 倍阈值，疑似刷分或数据异常`,
          );
        }
      }
      const w = Math.pow(
        0.5,
        Math.max(0, (this.nowFn() - e.submittedAt) / DAY_MS) / cfg.halfLifeDays,
      );
      histNum += w * clamp01(e.fitEval);
      histDen += w;
      histCount++;
    }

    // B. 单日评价数超限
    const perDay = new Map<number, number>();
    for (const e of evals) {
      const day = Math.floor(e.submittedAt / DAY_MS);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    for (const [day, count] of perDay) {
      if (count > cfg.dailyVolumeLimit) {
        reasons.push(
          `单日评价量超限：${new Date(day * DAY_MS).toISOString().slice(0, 10)} ` +
            `共 ${count} 条评价，超过上限 ${cfg.dailyVolumeLimit}，疑似机器刷量`,
        );
      }
    }
    return reasons;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 纯函数工具（导出以便单独测试与复用）
// ─────────────────────────────────────────────────────────────────────

/**
 * 衰减加权比率。
 *
 * 分母只统计「有结论」的记录（由调用方通过 filter 保证），
 * 没有任何结论时返回 null 而不是 0 —— 见文件头「null 重归一化」说明：
 * 把「没数据」当成「表现差」，等于奖励数据稀疏，是刷分者的最爱。
 */
export function weightedRate<T>(
  rows: T[],
  value: (row: T) => number,
  weight: (row: T) => number,
): number | null {
  if (rows.length === 0) return null;
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const w = weight(r);
    num += w * value(r);
    den += w;
  }
  if (den <= 0) return null;
  return clamp01(num / den);
}

/**
 * 衰减加权比率 —— 时间衰减场景专用，与 {@link weightedRate} 的关键差异：
 *
 *   weightedRate : Σ(w·x) / Σw   ← 权重被约掉，衰减对「比率型」指标失效
 *   decayedRatio : Σ(w·x) / N    ← 分母固定为样本数，衰减真正生效
 *
 * 用 decayedRatio 时，「整体变老的一批样本」分数会真实下降，
 * 老资格商家无法靠早期积累永久躺赢。
 *
 * 无任何记录时返回 null（表示「无数据」，交由调用方做 null 重归一化），
 * 绝不返回 0 —— 把「没数据」当「表现差」等于奖励数据稀疏。
 */
export function decayedRatio<T>(
  rows: T[],
  value: (row: T) => number,
  weight: (row: T) => number,
): number | null {
  if (rows.length === 0) return null;
  let num = 0;
  for (const r of rows) num += weight(r) * value(r);
  return clamp01(num / rows.length);
}

/**
 * merchant_rank = (产品力 ^ α) × (发现度 ^ (1-α))，α = RANK_PRODUCT_EXPONENT。
 *
 * 反 Goodhart 的核心论证：
 *   几何平均是「短板决定论」。若 α ≥ 0.5，则任何 α < 1 的取值下，
 *   把产品力从 0.8 压到 0.05 造成的损失（0.8^0.7 ≈ 0.65 → 0.05^0.7 ≈ 0.13，
 *   掉 80%）都远大于把发现度从 0.3 拉满到 1.0 的收益（0.3^0.3 ≈ 0.70 → 1.0，
 *   涨 43%）。因此「产品力极低 + 发现度高」的商家在数值上**不可能**
 *   超过「产品力高 + 发现度中等」的商家。
 *   对比加权和：0.05*α + 1.0*(1-α) 与 0.8*α + 0.3*(1-α) 在 α=0.5 时
 *   分别是 0.525 与 0.55 —— 几乎持平，意味着「只刷发现分」是一条
 *   有效的攻击路径。几何平均从结构上消灭了这条路径。
 *
 * @see RANK_PRODUCT_EXPONENT
 */
export function rankOf(productPowerScore: number, discoveryScore: number): number {
  const p = Math.max(clamp01(productPowerScore), RANK_FLOOR);
  const d = Math.max(clamp01(discoveryScore), RANK_FLOOR);
  const a = RANK_PRODUCT_EXPONENT;
  return clamp01(Math.pow(p, a) * Math.pow(d, 1 - a));
}

/**
 * 抽成费率：按相对位次从 baseTakeRate 线性降到 minTakeRate。
 *
 * 平台抽成在这里扮演「排名 → 收益」的传导带：只有持续被买家 agent
 * 选入候选集的高排名商家，才拿得到更低的费率。这是一个**自洽的**激励——
 * 它不需要外挂的惩罚机制，商家想少交抽成，唯一路径就是让真实买家
 * 愿意继续买它。
 *
 * @param percentile ∈[0,1]，1 = 最优商家
 */
export function takeRateFor(cfg: RewardConfig, percentile: number): number {
  const q = clamp01(percentile);
  return cfg.baseTakeRate + (cfg.minTakeRate - cfg.baseTakeRate) * q;
}