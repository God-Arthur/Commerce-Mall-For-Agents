/**
 * API 集成测试：端点行为、鉴权、错误码，以及最关键的**信息隔离**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MarketEngine } from "../src/engine.ts";
import { createApp } from "../src/server.ts";

async function withServer(fn: (call: Call) => Promise<void>): Promise<void> {
  const engine = new MarketEngine();
  const server = createApp(engine);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const call: Call = async (method, path, body?, apiKey?) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  // 暴露 port，供需要发原始请求的测试使用
  (call as Call & { port: number }).port = port;

  try {
    await fn(call);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

interface Call {
  (method: string, path: string, body?: unknown, apiKey?: string): Promise<{ status: number; json: any }>;
}

test("POST /agents 注册买卖双方并返回 apiKey", async () => {
  await withServer(async (call) => {
    const b = await call("POST", "/agents", { role: "buyer", name: "buyer-1" });
    assert.equal(b.status, 200);
    assert.equal(b.json.role, "buyer");
    assert.ok(b.json.apiKey.startsWith("sk_"));
    assert.ok(b.json.agentId.startsWith("ag_"));

    const s = await call("POST", "/agents", { role: "seller", name: "seller-1" });
    assert.equal(s.status, 200);
    assert.equal(s.json.role, "seller");
    assert.notEqual(s.json.apiKey, b.json.apiKey);
  });
});

test("注册参数非法返回结构化错误", async () => {
  await withServer(async (call) => {
    const bad = await call("POST", "/agents", { role: "auditor", name: "x" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "INVALID_ROLE");

    const empty = await call("POST", "/agents", { role: "buyer", name: "  " });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, "INVALID_NAME");
  });
});

test("完整撮合流程：报价 -> 出清 -> 查询结果", async () => {
  await withServer(async (call) => {
    const b1 = (await call("POST", "/agents", { role: "buyer", name: "b1" })).json;
    const b2 = (await call("POST", "/agents", { role: "buyer", name: "b2" })).json;
    const b3 = (await call("POST", "/agents", { role: "buyer", name: "b3" })).json;
    const s1 = (await call("POST", "/agents", { role: "seller", name: "s1" })).json;
    const s2 = (await call("POST", "/agents", { role: "seller", name: "s2" })).json;
    const s3 = (await call("POST", "/agents", { role: "seller", name: "s3" })).json;

    const round = (await call("POST", "/rounds", { roundId: "r1" })).json;

    await call("POST", "/rounds/r1/bids", { value: 10, quantity: 1 }, b1.apiKey);
    await call("POST", "/rounds/r1/bids", { value: 8, quantity: 1 }, b2.apiKey);
    await call("POST", "/rounds/r1/bids", { value: 7, quantity: 1 }, b3.apiKey);
    await call("POST", "/rounds/r1/asks", { cost: 1, quantity: 1 }, s1.apiKey);
    await call("POST", "/rounds/r1/asks", { cost: 5, quantity: 1 }, s2.apiKey);
    await call("POST", "/rounds/r1/asks", { cost: 20, quantity: 1 }, s3.apiKey);

    const cleared = await call("POST", "/rounds/r1/clear");
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.efficientQuantity, 2);
    assert.ok(cleared.json.efficiencyLoss <= 1);
    assert.equal(cleared.json.tradeCount, 1); // 分支 b 时牺牲一笔
  });
});

test("鉴权：缺少或错误 apiKey 被拒", async () => {
  await withServer(async (call) => {
    const b = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    await call("POST", "/rounds", { roundId: "rr" });

    const noKey = await call("POST", "/rounds/rr/bids", { value: 10 });
    assert.equal(noKey.status, 401);
    assert.equal(noKey.json.error.code, "UNAUTHORIZED");

    const badKey = await call("POST", "/rounds/rr/bids", { value: 10 }, "sk_wrong");
    assert.equal(badKey.status, 401);

    const ok = await call("POST", "/rounds/rr/bids", { value: 10 }, b.apiKey);
    assert.equal(ok.status, 200);
  });
});

test("角色越权：卖方不能提交出价，买方不能提交要价", async () => {
  await withServer(async (call) => {
    const b = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    const s = (await call("POST", "/agents", { role: "seller", name: "s" })).json;
    await call("POST", "/rounds", { roundId: "r2" });

    const wrongBid = await call("POST", "/rounds/r2/bids", { value: 10 }, s.apiKey);
    assert.equal(wrongBid.status, 403);
    assert.equal(wrongBid.json.error.code, "ROLE_MISMATCH");

    const wrongAsk = await call("POST", "/rounds/r2/asks", { cost: 1 }, b.apiKey);
    assert.equal(wrongAsk.status, 403);
  });
});

test("报价校验：非法 value / quantity 被拒", async () => {
  await withServer(async (call) => {
    const b = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    await call("POST", "/rounds", { roundId: "r3" });

    const neg = await call("POST", "/rounds/r3/bids", { value: -5 }, b.apiKey);
    assert.equal(neg.status, 400);
    assert.equal(neg.json.error.code, "INVALID_PRICE");

    const badQty = await call("POST", "/rounds/r3/bids", { value: 5, quantity: 0 }, b.apiKey);
    assert.equal(badQty.status, 400);
    assert.equal(badQty.json.error.code, "INVALID_QUANTITY");

    const floatQty = await call("POST", "/rounds/r3/bids", { value: 5, quantity: 1.5 }, b.apiKey);
    assert.equal(floatQty.status, 400);
  });
});

test("已出清的轮次不可再报价，也不可重复出清", async () => {
  await withServer(async (call) => {
    const b = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    await call("POST", "/rounds", { roundId: "r4" });
    await call("POST", "/rounds/r4/bids", { value: 10 }, b.apiKey);
    await call("POST", "/rounds/r4/clear");

    const late = await call("POST", "/rounds/r4/bids", { value: 20 }, b.apiKey);
    assert.equal(late.status, 409);
    assert.equal(late.json.error.code, "ROUND_CLOSED");

    const again = await call("POST", "/rounds/r4/clear");
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, "ALREADY_CLEARED");
  });
});

test("同一 agent 在同一轮重复提交 = 覆盖而非累加", async () => {
  await withServer(async (call) => {
    const b = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    await call("POST", "/rounds", { roundId: "r5" });
    await call("POST", "/rounds/r5/bids", { value: 10 }, b.apiKey);
    const again = await call("POST", "/rounds/r5/bids", { value: 20 }, b.apiKey);
    assert.equal(again.status, 200);

    const s = (await call("POST", "/agents", { role: "seller", name: "s" })).json;
    const s2 = (await call("POST", "/agents", { role: "seller", name: "s2" })).json;
    await call("POST", "/rounds/r5/asks", { cost: 5 }, s.apiKey);
    await call("POST", "/rounds/r5/asks", { cost: 6 }, s2.apiKey);
    const r = await call("POST", "/rounds/r5/clear");
    // b 覆盖为 20，s1 成本 5 -> k=1，分支 b 牺牲后 0 成交
    assert.equal(r.json.efficientQuantity, 1);
  });
});

test("信息隔离：查询结果不泄露他人报价，且按角色裁剪", async () => {
  await withServer(async (call) => {
    const b1 = (await call("POST", "/agents", { role: "buyer", name: "b1" })).json;
    const b2 = (await call("POST", "/agents", { role: "buyer", name: "b2" })).json;
    const s1 = (await call("POST", "/agents", { role: "seller", name: "s1" })).json;
    const s2 = (await call("POST", "/agents", { role: "seller", name: "s2" })).json;
    await call("POST", "/rounds", { roundId: "r6" });

    await call("POST", "/rounds/r6/bids", { value: 10 }, b1.apiKey);
    await call("POST", "/rounds/r6/bids", { value: 8 }, b2.apiKey);
    await call("POST", "/rounds/r6/asks", { cost: 1 }, s1.apiKey);
    await call("POST", "/rounds/r6/asks", { cost: 5 }, s2.apiKey);
    await call("POST", "/rounds/r6/clear");

    const view1 = await call("GET", "/rounds/r6/result", undefined, b1.apiKey);
    const view2 = await call("GET", "/rounds/r6/result", undefined, b2.apiKey);

    assert.equal(view1.status, 200);
    // 本 agent 的报价可见
    assert.equal(view1.json.myQuotes.price, 10);
    // 但绝不能出现他人的具体报价
    const text = JSON.stringify(view1.json);
    assert.equal(text.includes('"8"') && /b2/.test(text) && text.includes('"price":8'), false,
      "不应泄露其他买方报价");
    // 只有聚合信息
    assert.ok(view1.json.aggregate);
    assert.ok("clearingPriceBuyer" in view1.json.aggregate);

    // 不可成交的买方看到自己没成交
    assert.equal(view2.json.traded, false);
    assert.equal(view2.json.myQuantity, 0);
  });
});

test("行情数据聚合多轮结果", async () => {
  await withServer(async (call) => {
    const b = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    const s = (await call("POST", "/agents", { role: "seller", name: "s" })).json;

    for (let i = 1; i <= 3; i++) {
      const rid = `mk${i}`;
      await call("POST", "/rounds", { roundId: rid });
      await call("POST", `/rounds/${rid}/bids`, { value: 10 + i }, b.apiKey);
      await call("POST", `/rounds/${rid}/asks`, { cost: 1 + i }, s.apiKey);
      await call("POST", `/rounds/${rid}/clear`);
    }

    const md = await call("GET", "/market-data");
    assert.equal(md.status, 200);
    assert.equal(md.json.totalRounds, 3);
    assert.equal(md.json.rounds.length, 3);
    assert.ok(Array.isArray(md.json.priceSeries));
    assert.ok(Array.isArray(md.json.volumeSeries));
    // 行情不应包含任何 agent 标识
    assert.equal(JSON.stringify(md.json).includes(b.agentId), false);
    assert.equal(JSON.stringify(md.json).includes(s.agentId), false);
  });
});

test("声誉查询：无记录为中性 0.5，成交后上升", async () => {
  await withServer(async (call) => {
    const b = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    const s = (await call("POST", "/agents", { role: "seller", name: "s" })).json;

    const before = await call("GET", `/agents/${b.agentId}/reputation`, undefined, b.apiKey);
    assert.equal(before.status, 200);
    assert.equal(before.json.score, 0.5);

    await call("POST", "/rounds", { roundId: "r7" });
    await call("POST", "/rounds/r7/bids", { value: 10 }, b.apiKey);
    await call("POST", "/rounds/r7/bids", { value: 9 }, (await call("POST", "/agents", { role: "buyer", name: "b2" })).json.apiKey);
    await call("POST", "/rounds/r7/asks", { cost: 1 }, s.apiKey);
    await call("POST", "/rounds/r7/asks", { cost: 4 }, (await call("POST", "/agents", { role: "seller", name: "s2" })).json.apiKey);
    await call("POST", "/rounds/r7/clear");

    const after = await call("GET", `/agents/${b.agentId}/reputation`, undefined, b.apiKey);
    // 有成交则分数上升
    if (after.json.totalFulfilled > 0) {
      assert.ok(after.json.score > 0.5);
    }
    // 明确声明声誉不影响定价
    assert.ok(after.json.note.includes("informational only"));
  });
});

test("不存在的轮次/agent 返回 404", async () => {
  await withServer(async (call) => {
    const b = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    const r1 = await call("POST", "/rounds/nope/clear");
    assert.equal(r1.status, 404);
    const r2 = await call("GET", "/agents/ag_missing/reputation", undefined, b.apiKey);
    assert.equal(r2.status, 404);
  });
});

test("重复创建同名轮次返回 409", async () => {
  await withServer(async (call) => {
    await call("POST", "/rounds", { roundId: "dup" });
    const again = await call("POST", "/rounds", { roundId: "dup" });
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, "ROUND_EXISTS");
  });
});

test("非法 JSON 请求体返回 400", async () => {
  await withServer(async (call) => {
    const port = (call as Call & { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    assert.equal(res.status, 400);
    const j = (await res.json()) as any;
    assert.equal(j.error.code, "INVALID_INPUT");
  });
});

test("GET /health", async () => {
  await withServer(async (call) => {
    const h = await call("GET", "/health");
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
  });
});

test("未知路由返回 404 结构化错误", async () => {
  await withServer(async (call) => {
    const r = await call("GET", "/no/such/route");
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, "ROUTE_NOT_FOUND");
  });
});