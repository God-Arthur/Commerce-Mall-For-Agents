/**
 * HTTP 层：零依赖，基于 node:http。
 *
 * 选择说明：任务允许 Fastify/Express 等轻量框架。这里用 Node 内置 http，
 * 理由有三：(1) 零第三方依赖，避免依赖树带来的供应链与安装风险；
 * (2) 本项目是内存存储的单进程 MVP，路由表很小，框架收益有限；
 * (3) 信息隔离规则需要在最外层统一强制，自建中间件链更直接。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MarketEngine, MarketError } from "./engine.ts";
import { RewardService } from "./reward/service.ts";

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  apiKey: string | null;
  engine: MarketEngine;
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  /** 是否需要 API key */
  auth: boolean;
}

const MAX_BODY = 1_000_000;

/**
 * @param engine 基础层引擎
 * @param rewardService 可选的奖励层实例，默认内部自建。
 *   之所以允许注入：出清结算流程必须往**同一个** RewardService 实例里回填
 *   成交结果（recordOutcome），否则回填落进了另一个实例，评分侧根本读不到。
 *   系统侧应自建一个实例并在此注入，保持全局单一真相源。
 */
export function createApp(engine: MarketEngine, rewardService?: RewardService) {
  const routes: Route[] = [];

  // 奖励层（需求发现与产品力）。持有基础层引擎实例，
  // 仅用于鉴权与校验 agent / 轮次存在性 —— 不参与、也不修改定价。
  const reward = rewardService ?? new RewardService(engine);

  const add = (method: string, path: string, auth: boolean, handler: Handler) => {
    routes.push({ method, parts: path.split("/").filter(Boolean), handler, auth });
  };

  // ── Agent 注册与鉴权 ─────────────────────────────────────────
  add("POST", "/agents", false, ({ body }) => {
    const { agent, apiKey } = engine.registerAgent(body?.role, body?.name);
    return {
      agentId: agent.id,
      role: agent.role,
      name: agent.name,
      apiKey,
      createdAt: agent.createdAt,
      note: "妥善保管 apiKey，后续请求通过 X-API-Key 头携带",
    };
  });

  add("GET", "/agents/:agentId/reputation", true, ({ params }) =>
    engine.reputationOf(params.agentId)
  );

  // ── 轮次 ─────────────────────────────────────────────────────
  // 创建轮次是市场运营方的动作（开市），不属于任何 agent 的私有操作，
  // 因此不要求 apiKey —— 否则调用方必须先有一个 agent 身份才能开市，
  // 这对「行情生产者」不合理。报价提交与结果查询才需要鉴权。
  add("POST", "/rounds", false, ({ body }) => {
    const round = engine.createRound(body?.roundId);
    return { roundId: round.id, status: round.status, openedAt: round.openedAt };
  });

  add("GET", "/rounds", false, () =>
    engine.listRounds().map((r) => ({ roundId: r.id, status: r.status, openedAt: r.openedAt }))
  );

  // ── 报价提交 ─────────────────────────────────────────────────
  // 注意 value 是买方 agent 评价消费者需求后「诱发」的支付意愿 v，
  // 不是消费者事先给定的数字。
  add("POST", "/rounds/:roundId/bids", true, ({ params, body, apiKey, engine: e }) => {
    const agent = e.authenticate(apiKey!);
    const q = e.submitBid(params.roundId, agent, body?.value, body?.quantity ?? 1);
    return { accepted: true, roundId: params.roundId, quantity: q.quantity };
  });

  add("POST", "/rounds/:roundId/asks", true, ({ params, body, apiKey, engine: e }) => {
    const agent = e.authenticate(apiKey!);
    const q = e.submitAsk(params.roundId, agent, body?.cost, body?.quantity ?? 1);
    return { accepted: true, roundId: params.roundId, quantity: q.quantity };
  });

  // ── 出清与查询 ───────────────────────────────────────────────
  add("POST", "/rounds/:roundId/clear", false, ({ params, engine: e }) => e.clearRound(params.roundId));

  // 结果查询：需鉴权，且按调用者角色裁剪信息
  add("GET", "/rounds/:roundId/result", true, ({ params, apiKey, engine: e }) => {
    const agent = e.authenticate(apiKey!);
    return engine.agentRoundView(params.roundId, agent);
  });

  // ── 奖励层：适配评价（fit eval） ─────────────────────────────
  //
  // 红线：fit_eval 只进入「产品力度量与排名」，绝不进入定价。
  // 报价仍然只来自基础层的支付意愿 value / cost。
  //
  // 需鉴权 + 买方角色。响应只回执「已接收」，
  // 不回显 fit_eval，也不透露任何其他买家的评价。
  add("POST", "/rounds/:roundId/evaluations", true, ({ params, body, apiKey, engine: e }) => {
    const agent = e.authenticate(apiKey!);
    const r = reward.recordEvaluation({
      roundId: params.roundId,
      buyer: agent,
      merchantId: body?.merchant_id,
      productId: body?.product_id,
      priorIntent: body?.prior_intent,
      fitEval: body?.fit_eval,
    });
    return {
      accepted: true,
      evaluationId: r.evaluationId,
      duplicate: r.duplicate,
      roundId: params.roundId,
      note:
        "评价已记录。该评分仅用于聚合统计与排名，不参与任何定价；也不会披露给商家或其他买家。",
    };
  });

  // 私密回执：只有评价者本人能看到自己的原始 fit_eval。
  // 模式对齐基础层 agentRoundView 的「按角色裁剪」。
  add("GET", "/rounds/:roundId/evaluations/mine", true, ({ params, apiKey, engine: e }) => {
    const agent = e.authenticate(apiKey!);
    return reward.myEvaluations(agent, params.roundId);
  });

  // 商家评分：聚合口径，无需鉴权（响应本身已是聚合量，不含任何单条评价）。
  add("GET", "/merchants/:merchantId/score", false, ({ params }) =>
    reward.scoreOf(params.merchantId)
  );

  // 商家声誉：已验证信号 vs 商家自述，分栏返回，避免调用方混淆。
  add("GET", "/merchants/:merchantId/reputation", false, ({ params }) =>
    reward.reputationOf(params.merchantId)
  );

  // 入围候选集：需鉴权，按调用方买方身份裁剪（排除其自己已评价过的商品）。
  add("GET", "/rounds/:roundId/candidates", true, ({ params, query, apiKey, engine: e }) => {
    const agent = e.authenticate(apiKey!);
    const raw = query.get("limit");
    return reward.shortlistFor(params.roundId, agent, raw === null ? 10 : Number(raw));
  });

  // 注意：RewardService.recordOutcome（成交 / 反悔 / 复购回填）
  // 刻意【不注册路由】—— 验证结果只能由系统流程写入，
  // 商家在协议层面没有任何途径提交自评。

  // ── 行情数据服务 ─────────────────────────────────────────────
  add("GET", "/market-data", false, () => engine.marketData());

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, payload: unknown) => {
      const data = JSON.stringify(payload, null, 2);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(data),
      });
      res.end(data);
    };

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const parts = path.split("/").filter(Boolean);

      // CORS，便于 agent 跨域接入
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-api-key",
        });
        res.end();
        return;
      }

      if (path === "/health") return send(200, { ok: true, uptime: process.uptime() });

      const route = routes.find(
        (r) => r.method === req.method && r.parts.length === parts.length &&
          r.parts.every((p, i) => p.startsWith(":") || p === parts[i])
      );
      if (!route) {
        return send(404, {
          error: { code: "ROUTE_NOT_FOUND", message: `无此路由：${req.method} ${path}` },
        });
      }

      const params: Record<string, string> = {};
      route.parts.forEach((p, i) => {
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i]);
      });

      const apiKey = (req.headers["x-api-key"] as string) ?? null;
      if (route.auth && !apiKey) {
        return send(401, {
          error: { code: "UNAUTHORIZED", message: "缺少 X-API-Key 头" },
        });
      }

      const body = await readBody(req);
      const payload = await route.handler({
        params, query: url.searchParams, body, apiKey, engine,
      });
      send(200, payload);
    } catch (err) {
      if (err instanceof MarketError) {
        return send(err.status, { error: { code: err.code, message: err.message } });
      }
      if (err instanceof TypeError) {
        return send(400, { error: { code: "INVALID_INPUT", message: err.message } });
      }
      return send(500, {
        error: { code: "INTERNAL_ERROR", message: (err as Error)?.message ?? "未知错误" },
      });
    }
  });

  return server;
}

async function readBody(req: IncomingMessage): Promise<any> {
  if (req.method !== "POST" && req.method !== "PUT") return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new TypeError("请求体过大");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("请求体不是合法 JSON");
  }
}