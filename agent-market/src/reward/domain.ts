/**
 * 奖励层领域模型：「需求发现与产品力」（乔布斯机制）
 *
 * ─────────────────────────────────────────────────────────────────
 * 与基础层的关系
 * ─────────────────────────────────────────────────────────────────
 * 基础层（McAfee 双向拍卖）管「匹配之后怎么定价」；
 * 本层管「谁被看见、被评价」——即入围赛。
 *
 * ─────────────────────────────────────────────────────────────────
 * 第一原则：一切奖励信号必须来自已验证的真实结果，绝不来自商家自述
 * ─────────────────────────────────────────────────────────────────
 * 对应概念模型中的「昂贵信号」——只有造不起假的信号才可信。
 * 因此本层不采信任何商家填写的自我介绍，只采信：
 *   - 买家 agent 的适配评价（fitEval）
 *   - 实际成交与否
 *   - 成交后的反悔 / 退货
 *   - 复购行为
 *
 * ─────────────────────────────────────────────────────────────────
 * 关键设计：适配评价与支付意愿严格解耦
 * ─────────────────────────────────────────────────────────────────
 * 若买家知道「越喜欢、价格越高」，就会低报喜好，导致 fit_eval 失真。
 * 因此：
 *   - fitEval 只用于【发现与产品力的度量、排名】
 *   - 定价只走【基础层的支付意愿 + McAfee 机制】
 * 两条信号通道在代码层面隔离，engine.pricing 不得读取 fitEval。
 */

import type { Role } from "./domain.ts";

/**
 * 适配评价（fit evaluation）
 *
 * 注意：这是买家 agent 对「商品是否贴合消费者需求」的判断，
 * 与支付意愿（value / cost）严格分离，不参与定价。
 */
export interface Evaluation {
  /** 评价所属轮次 */
  roundId: string;
  /** 被评价的商家（对应基础层的 seller agent） */
  merchantId: string;
  /** 商品标识 */
  productId: string;
  /** 评价者（买方 agent） */
  buyerAgentId: string;
  /**
   * 买家事先是否已有该品类的需求信号。
   * false = 买家原本不知道自己想要这个 → 满足则构成「发现事件」。
   */
  priorIntent: boolean;
  /** 适配 / 喜好评分，区间 [0,1] */
  fitEval: number;
  /**
   * 评价发生的时间戳（毫秒）。
   *
   * 评分引擎据此计算**时间衰减**：它代表的是「这条评价是什么时候产生的」，
   * 而不是「数据什么时候被录入系统」。两者混用会让衰减失真 ——
   * 批量回填的旧数据会看起来很新，从而逃过时间衰减的惩罚。
   */
  submittedAt: number;
}

/** 成交后回填的验证结果（不可由商家填写，只能由系统记录） */
export interface OutcomeRecord {
  evaluationKey: string;
  merchantId: string;
  buyerAgentId: string;
  productId: string;
  /** 是否成交 */
  traded: boolean;
  /** 成交后是否反悔 / 退货 */
  noRegret: boolean | null;
  /** 买家是否复购同一商家 */
  repeat: boolean | null;
  /** 延迟复评（用于 durability），无则 null */
  delayedFitEval: number | null;
  /** 回填时间戳 */
  recordedAt: number;
}

/** 商家评分的四个产品力维度（均为已验证口径） */
export interface ProductPowerMetrics {
  /** 被评价商品的平均适配分（需达最小样本量） */
  realizedFitMean: number | null;
  /** 成交后未反悔比例 */
  noRegretRate: number | null;
  /** 买家复购该商家的比例 */
  repeatRate: number | null;
  /** 满意度随时间的保持度 */
  durability: number | null;
}

/** 商家完整评分 */
export interface MerchantScore {
  merchantId: string;
  /** 产品力得分 ∈ [0,1] */
  productPowerScore: number;
  /** 需求发现得分 ∈ [0,1] */
  discoveryScore: number;
  /** 入围优先级排名依据：数值越大越优先进入买家候选集 */
  merchantRank: number;
  /** 各维度明细 */
  metrics: ProductPowerMetrics;
  /** 发现相关原始量 */
  discovery: {
    /** 推送候选总数 */
    totalImpressions: number;
    /** 发现事件数（无先验意图 + 高适配） */
    discoveryEvents: number;
    /** 发现精度 = 发现事件数 / 推送候选总数 */
    discoveryPrecision: number;
  };
  /** 样本量，低于最小样本时评分不生效 */
  sampleSize: number;
  /** 是否因样本不足而未生效 */
  belowMinSample: boolean;
  /** 是否触发异常检测（需人工复核） */
  flagged: boolean;
  /** 异常原因 */
  flagReasons: string[];
  /** 平台抽成费率（高排名更低） */
  takeRate: number;
  /** 是否获得发现红利 */
  discoveryBonus: number;
}

/** 评分权重配置（v1 默认值，可调） */
export interface RewardConfig {
  weights: {
    realizedFitMean: number;
    noRegretRate: number;
    repeatRate: number;
    durability: number;
  };
  /** fit_eval 达到该阈值才算「发现事件」 */
  discoveryFitThreshold: number;
  /** 产品力生效所需的最小评价数 */
  minSampleSize: number;
  /** 发现分生效所需的最小推送数 */
  minImpressions: number;
  /** 时间衰减半衰期（天） */
  halfLifeDays: number;
  /** 平台基础抽成 */
  baseTakeRate: number;
  /** 最高排名可获得的最低抽成 */
  minTakeRate: number;
  /** 发现红利的基准金额（模拟） */
  discoveryBonusBase: number;
  /** 单次发现红利上限（防止刷量套利） */
  discoveryBonusCap: number;
  /** 异常检测：单次 fit_eval 相对其历史均值的最大允许跃升 */
  spikeFactor: number;
  /** 异常检测：单日评价数上限 */
  dailyVolumeLimit: number;
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  weights: {
    realizedFitMean: 0.35,
    noRegretRate: 0.3,
    repeatRate: 0.2,
    durability: 0.15,
  },
  discoveryFitThreshold: 0.75,
  minSampleSize: 5,
  minImpressions: 10,
  halfLifeDays: 30,
  baseTakeRate: 0.15,
  minTakeRate: 0.03,
  discoveryBonusBase: 5,
  discoveryBonusCap: 50,
  spikeFactor: 3.0,
  dailyVolumeLimit: 200,
};

/** 商家注册时的自述信息 —— 明确标注【不参与评分】 */
export interface MerchantProfile {
  merchantId: string;
  /** 商家自述简介，仅展示用 */
  description: string;
  /** 自述资质，仅展示用 */
  claimedCredentials: string[];
  registeredAt: number;
}

/**
 * 奖励层只读的基础层类型（避免循环依赖，运行时用接口鸭子类型）。
 * 注意：此处刻意不 import engine.ts，防止 engine -> reward -> engine 的循环。
 */
export interface BaseLayerRef {
  getAgent(id: string): { id: string; role: Role; name: string };
}

/** 入围候选条目 */
export interface ShortlistEntry {
  merchantId: string;
  rank: number;
  score: number;
  productId: string;
  /** 展示给买家 agent 的已验证信号（昂贵信号） */
  verifiedSignals: {
    realizedFitMean: number | null;
    noRegretRate: number | null;
    repeatRate: number | null;
  };
  /** 商家自述（标注为未验证） */
  unverifiedClaims: {
    description: string;
    credentials: string[];
  };
}