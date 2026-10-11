/** 领域模型：agent、轮次、结算、声誉、行情。 */

export type Role = "buyer" | "seller";

export interface Agent {
  id: string;
  role: Role;
  name: string;
  apiKey: string;
  createdAt: number;
}

export type RoundStatus = "open" | "cleared";

/** 一条报价记录。仅本 agent 可见。 */
export interface Quote {
  agentId: string;
  price: number;
  quantity: number;
  submittedAt: number;
}

export interface Round {
  id: string;
  status: RoundStatus;
  openedAt: number;
  closedAt: number | null;
  /** 本轮买方的具体报价 —— 私密，绝不向他人披露。 */
  buyerQuotes: Map<string, Quote>;
  /** 本轮卖方的具体要价 —— 私密。 */
  sellerQuotes: Map<string, Quote>;
  /** 出清后的公开聚合结果。 */
  result: RoundResult | null;
}

/** 本轮对外公开的结果（聚合口径，不含任何单个 agent 的报价）。 */
export interface RoundResult {
  roundId: string;
  efficientQuantity: number;
  tradedQuantity: number;
  tradeCount: number;
  branch: "a" | "b" | "none";
  clearingPriceBuyer: number | null;
  clearingPriceSeller: number | null;
  efficiencyLoss: number;
  /** 平台留存价差（分支 b 时非零）。 */
  platformSpread: number;
  /** 模拟结算流水。 */
  settlements: Settlement[];
  clearedAt: number;
}

/** 模拟支付/托管记录。不接真实支付。 */
export interface Settlement {
  buyerAgentId: string;
  sellerAgentId: string;
  quantity: number;
  /** 买方应付总额 */
  buyerPays: number;
  /** 卖方应收总额 */
  sellerReceives: number;
  status: "escrowed" | "settled";
}

/** 履约历史记录。 */
export interface FulfillmentRecord {
  roundId: string;
  agentId: string;
  role: Role;
  /** 该 agent 在本轮的成交数量 */
  quantity: number;
  /** 该 agent 在本轮的成交额（买方为付出，卖方为收到） */
  notional: number;
  /** 是否按时履约（v1 中自动结算即视为履约） */
  fulfilled: boolean;
}

export interface Reputation {
  agentId: string;
  score: number;
  totalFulfilled: number;
  totalBreached: number;
  notional: number;
}

/** 行情：历史聚合数据，作为「信息产品」对外提供。 */
export interface MarketTicker {
  roundId: string;
  clearingPrice: number | null;
  tradedQuantity: number;
  tradeCount: number;
  spread: number | null;
  clearedAt: number;
}