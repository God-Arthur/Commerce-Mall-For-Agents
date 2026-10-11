/**
 * 市场引擎：agent 注册鉴权、轮次、报价、出清、结算、行情。
 * MVP 内存存储，单进程。
 */
import { randomUUID, randomBytes } from "node:crypto";
import { clearMarket } from "./mechanism/mcafee.ts";
import { ReputationService } from "./reputation.ts";
import type {
  Agent,
  MarketTicker,
  Role,
  Round,
  RoundResult,
  Settlement,
} from "./domain.ts";

export class MarketError extends Error {
  // 注意：Node 的 strip-only 类型剥离不支持构造函数参数属性（public x in 构造参数），
  // 因此这里显式声明并赋值。
  status: number;
  code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class MarketEngine {
  private agents = new Map<string, Agent>();
  private apiKeyIndex = new Map<string, string>();
  private rounds = new Map<string, Round>();
  private tickers: MarketTicker[] = [];
  private reputation = new ReputationService();

  // ── 1. Agent 注册与鉴权 ────────────────────────────────────────

  registerAgent(role: Role, name: string): { agent: Agent; apiKey: string } {
    if (role !== "buyer" && role !== "seller") {
      throw new MarketError(400, `role 必须是 "buyer" 或 "seller"`, "INVALID_ROLE");
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new MarketError(400, "name 不能为空", "INVALID_NAME");
    }
    const id = `ag_${randomUUID().slice(0, 8)}`;
    const apiKey = `sk_${randomBytes(24).toString("hex")}`;
    const agent: Agent = { id, role, name: name.trim(), apiKey, createdAt: Date.now() };
    this.agents.set(id, agent);
    this.apiKeyIndex.set(apiKey, id);
    return { agent, apiKey };
  }

  authenticate(apiKey: string): Agent {
    const id = this.apiKeyIndex.get(apiKey);
    if (!id) throw new MarketError(401, "API key 无效", "UNAUTHORIZED");
    const agent = this.agents.get(id)!;
    return agent;
  }

  getAgent(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new MarketError(404, `agent ${id} 不存在`, "AGENT_NOT_FOUND");
    return a;
  }

  // ── 2. 轮次管理 ───────────────────────────────────────────────

  createRound(id?: string): Round {
    const rid = id ?? `r_${randomUUID().slice(0, 8)}`;
    if (this.rounds.has(rid)) {
      throw new MarketError(409, `轮次 ${rid} 已存在`, "ROUND_EXISTS");
    }
    const round: Round = {
      id: rid,
      status: "open",
      openedAt: Date.now(),
      closedAt: null,
      buyerQuotes: new Map(),
      sellerQuotes: new Map(),
      result: null,
    };
    this.rounds.set(rid, round);
    return round;
  }

  getRound(id: string): Round {
    const r = this.rounds.get(id);
    if (!r) throw new MarketError(404, `轮次 ${id} 不存在`, "ROUND_NOT_FOUND");
    return r;
  }

  listRounds(): Round[] {
    return [...this.rounds.values()].sort((a, b) => b.openedAt - a.openedAt);
  }

  private submitQuote(roundId: string, agent: Agent, price: number, quantity: number): Quote {
    const round = this.getRound(roundId);
    if (round.status !== "open") {
      throw new MarketError(409, `轮次 ${roundId} 已出清，不可再报价`, "ROUND_CLOSED");
    }
    if (typeof price !== "number" || !Number.isFinite(price)) {
      throw new MarketError(400, "price 必须是有限数值", "INVALID_PRICE");
    }
    if (price < 0) {
      throw new MarketError(400, "price 不能为负", "INVALID_PRICE");
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new MarketError(400, "quantity 必须是正整数", "INVALID_QUANTITY");
    }
    const quote: Quote = { agentId: agent.id, price, quantity, submittedAt: Date.now() };
    // 同一 agent 在同一轮重复提交 = 覆盖（支持 agent 修改报价）
    if (agent.role === "buyer") round.buyerQuotes.set(agent.id, quote);
    else round.sellerQuotes.set(agent.id, quote);
    return quote;
  }

  submitBid(roundId: string, agent: Agent, value: number, quantity: number): Quote {
    if (agent.role !== "buyer") {
      throw new MarketError(403, "只有买方 agent 可以提交出价", "ROLE_MISMATCH");
    }
    return this.submitQuote(roundId, agent, value, quantity);
  }

  submitAsk(roundId: string, agent: Agent, cost: number, quantity: number): Quote {
    if (agent.role !== "seller") {
      throw new MarketError(403, "只有卖方 agent 可以提交要价", "ROLE_MISMATCH");
    }
    return this.submitQuote(roundId, agent, cost, quantity);
  }

  // ── 3. 出清 + 4. 结算 ─────────────────────────────────────────

  clearRound(roundId: string): RoundResult {
    const round = this.getRound(roundId);
    if (round.status === "cleared") {
      throw new MarketError(409, `轮次 ${roundId} 已出清`, "ALREADY_CLEARED");
    }

    const bids = [...round.buyerQuotes.values()].map((q) => ({
      agentId: q.agentId,
      value: q.price,
      quantity: q.quantity,
    }));
    const asks = [...round.sellerQuotes.values()].map((q) => ({
      agentId: q.agentId,
      cost: q.price,
      quantity: q.quantity,
    }));

    const cleared = clearMarket(bids, asks);

    // 模拟结算：买方付款进托管，卖方收款，价差归平台
    const settlements: Settlement[] = cleared.fills.map((f) => ({
      buyerAgentId: f.buyerAgentId,
      sellerAgentId: f.sellerAgentId,
      quantity: f.quantity,
      buyerPays: round2(f.quantity * f.buyerPrice),
      sellerReceives: round2(f.quantity * f.sellerPrice),
      status: "settled",
    }));

    const buyerTotal = settlements.reduce((s, x) => s + x.buyerPays, 0);
    const sellerTotal = settlements.reduce((s, x) => s + x.sellerReceives, 0);

    const result: RoundResult = {
      roundId,
      efficientQuantity: cleared.efficientQuantity,
      tradedQuantity: cleared.tradedQuantity,
      tradeCount: cleared.tradeCount,
      branch: cleared.branch,
      clearingPriceBuyer: cleared.clearingPriceBuyer,
      clearingPriceSeller: cleared.clearingPriceSeller,
      efficiencyLoss: cleared.efficiencyLoss,
      platformSpread: round2(buyerTotal - sellerTotal),
      settlements,
      clearedAt: Date.now(),
    };

    round.status = "cleared";
    round.closedAt = result.clearedAt;
    round.result = result;

    // 记录履约 → 声誉
    for (const s of settlements) {
      this.reputation.record({
        roundId, agentId: s.buyerAgentId, role: "buyer",
        quantity: s.quantity, notional: s.buyerPays, fulfilled: true,
      });
      this.reputation.record({
        roundId, agentId: s.sellerAgentId, role: "seller",
        quantity: s.quantity, notional: s.sellerReceives, fulfilled: true,
      });
    }

    // 行情
    this.tickers.push({
      roundId,
      clearingPrice: cleared.clearingPriceBuyer,
      tradedQuantity: cleared.tradedQuantity,
      tradeCount: cleared.tradeCount,
      spread: cleared.branch === "a"
        ? 0
        : cleared.branch === "b" && cleared.clearingPriceBuyer !== null
          ? round2(cleared.clearingPriceBuyer - (cleared.clearingPriceSeller ?? 0))
          : null,
      clearedAt: result.clearedAt,
    });

    return result;
  }

  // ── 5. 行情数据服务 ───────────────────────────────────────────

  marketData(): {
    rounds: MarketTicker[];
    totalRounds: number;
    totalTraded: number;
    avgClearingPrice: number | null;
    lastClearingPrice: number | null;
    priceSeries: Array<{ roundId: string; price: number | null }>;
    volumeSeries: Array<{ roundId: string; quantity: number }>;
  } {
    const priced = this.tickers.filter((t) => t.clearingPrice !== null);
    const avg =
      priced.length === 0
        ? null
        : round2(priced.reduce((s, t) => s + (t.clearingPrice as number), 0) / priced.length);
    return {
      rounds: this.tickers,
      totalRounds: this.tickers.length,
      totalTraded: this.tickers.reduce((s, t) => s + t.tradedQuantity, 0),
      avgClearingPrice: avg,
      lastClearingPrice: this.tickers.length ? (this.tickers[this.tickers.length - 1].clearingPrice ?? null) : null,
      priceSeries: this.tickers.map((t) => ({ roundId: t.roundId, price: t.clearingPrice })),
      volumeSeries: this.tickers.map((t) => ({ roundId: t.roundId, quantity: t.tradedQuantity })),
    };
  }

  // ── 6. 声誉 ───────────────────────────────────────────────────

  reputationOf(agentId: string) {
    this.getAgent(agentId); // 存在性校验
    return {
      ...this.reputation.score(agentId),
      // 明确告知：该分数不影响本轮定价
      note: "reputation is informational only; it never affects pricing within a round (DSIC 保护)",
    };
  }

  /**
   * 单个 agent 视角的本轮结果。
   * 信息隔离的关键：只告知「你是否成交、成交多少、付了多少」，
   * 绝不返回任何他人的具体报价。
   */
  agentRoundView(roundId: string, agent: Agent) {
    const round = this.getRound(roundId);
    const r = round.result;
    const mine = r
      ? r.settlements.filter((s) =>
          agent.role === "buyer" ? s.buyerAgentId === agent.id : s.sellerAgentId === agent.id
        )
      : [];

    const qty = mine.reduce((s, x) => s + x.quantity, 0);
    return {
      roundId,
      status: round.status,
      // 私密回执：仅本 agent 的
      myQuotes:
        agent.role === "buyer"
          ? round.buyerQuotes.get(agent.id) ?? null
          : round.sellerQuotes.get(agent.id) ?? null,
      // 公开聚合：全场口径
      aggregate: r
        ? {
            clearingPriceBuyer: r.clearingPriceBuyer,
            clearingPriceSeller: r.clearingPriceSeller,
            tradedQuantity: r.tradedQuantity,
            tradeCount: r.tradeCount,
            efficiencyLoss: r.efficiencyLoss,
          }
        : null,
      // 我的成交
      myTrades: mine.map((s) => ({
        quantity: s.quantity,
        counterpartyAgentId: agent.role === "buyer" ? s.sellerAgentId : s.buyerAgentId,
        pricePerUnit: agent.role === "buyer"
          ? (s.buyerPays / s.quantity)
          : (s.sellerReceives / s.quantity),
        amount: agent.role === "buyer" ? s.buyerPays : s.sellerReceives,
      })),
      traded: qty > 0,
      myQuantity: qty,
    };
  }
}

function round2(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}