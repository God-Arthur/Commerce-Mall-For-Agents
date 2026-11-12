/**
 * 闭环：上架 → 入围展示 → 评价 → 价格表出价 → 出清回填 → 事后反馈 → 复购。
 * 定价只看价格表，不看 fit_eval。商家不能自填成交。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MarketEngine } from "../src/engine.ts";
import { createApp } from "../src/server.ts";
import { RewardService } from "../src/reward/service.ts";
import { ScoringEngine } from "../src/reward/scoring.ts";
import { answersForValue } from "../src/elicitation/price-list.ts";

const GRID = [0, 5, 10, 15, 20, 25, 30, 40];

interface Call {
  (method: string, path: string, body?: unknown, apiKey?: string): Promise<{ status: number; json: any }>;
}

async function withServer(fn: (call: Call) => Promise<void>): Promise<void> {
  const engine = new MarketEngine();
  const reward = new RewardService(engine);
  const server = createApp(engine, reward);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  try {
    await fn(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("上架后、尚无评价时，候选集里已经有这个商品", async () => {
  await withServer(async (call) => {
    const seller = (await call("POST", "/agents", { role: "seller", name: "s" })).json;
    const buyer = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    await call("POST", "/rounds", { roundId: "r" });
    const listed = await call(
      "POST",
      "/rounds/r/listings",
      { product_id: "mug", cost: 4, quantity: 1 },
      seller.apiKey,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.json.productId, "mug");

    const candidates = await call("GET", "/rounds/r/candidates?limit=5", undefined, buyer.apiKey);
    assert.equal(candidates.status, 200);
    assert.equal(candidates.json.total, 1);
    assert.equal(candidates.json.candidates[0].productId, "mug");
    assert.equal(candidates.json.candidates[0].merchantId, seller.agentId);
  });
});

test("fit_eval 改变不影响出清价；诱发接口拒绝直接塞 value 或 fit_eval", async () => {
  await withServer(async (call) => {
    const prices: number[] = [];
    for (const fit of [0.05, 0.99]) {
      const roundId = `r-${fit}`;
      const buyer = (await call("POST", "/agents", { role: "buyer", name: `b-${fit}` })).json;
      const other = (await call("POST", "/agents", { role: "buyer", name: `o-${fit}` })).json;
      const seller = (await call("POST", "/agents", { role: "seller", name: `s-${fit}` })).json;
      const seller2 = (await call("POST", "/agents", { role: "seller", name: `s2-${fit}` })).json;
      await call("POST", "/rounds", { roundId });
      await call("POST", `/rounds/${roundId}/listings`, { product_id: "mug", cost: 5 }, seller.apiKey);
      await call("POST", `/rounds/${roundId}/asks`, { cost: 12 }, seller2.apiKey);
      await call("POST", `/rounds/${roundId}/bids`, { value: 20 }, other.apiKey);

      const rejected = await call(
        "POST",
        `/rounds/${roundId}/elicitations`,
        { fit_eval: fit, price_list: answersForValue(20, GRID) },
        buyer.apiKey,
      );
      assert.equal(rejected.status, 400);
      assert.equal(rejected.json.error.code, "FIT_NOT_A_PRICE");

      const elicited = await call(
        "POST",
        `/rounds/${roundId}/elicitations`,
        { price_list: answersForValue(30, GRID) },
        buyer.apiKey,
      );
      assert.equal(elicited.status, 200);
      assert.equal(elicited.json.elicitedValue, 30);
      assert.equal(elicited.json.bidSubmitted, true);

      await call(
        "POST",
        `/rounds/${roundId}/evaluations`,
        { merchant_id: seller.agentId, product_id: "mug", prior_intent: false, fit_eval: fit },
        buyer.apiKey,
      );

      const cleared = await call("POST", `/rounds/${roundId}/clear`);
      assert.equal(cleared.status, 200);
      prices.push(cleared.json.clearingPriceBuyer);
    }
    assert.equal(prices[0], prices[1]);
    assert.equal(prices[0], 20);
  });
});

test("出清写入成交，买方可以补反悔；商家不能，也不能自填成交", async () => {
  await withServer(async (call) => {
    const buyer = (await call("POST", "/agents", { role: "buyer", name: "b" })).json;
    const other = (await call("POST", "/agents", { role: "buyer", name: "o" })).json;
    const seller = (await call("POST", "/agents", { role: "seller", name: "s" })).json;
    const seller2 = (await call("POST", "/agents", { role: "seller", name: "s2" })).json;
    await call("POST", "/rounds", { roundId: "r1" });
    await call("POST", "/rounds/r1/listings", { product_id: "mug", cost: 5 }, seller.apiKey);
    await call("POST", "/rounds/r1/asks", { cost: 12 }, seller2.apiKey);
    await call("POST", "/rounds/r1/bids", { value: 20 }, other.apiKey);
    await call(
      "POST",
      "/rounds/r1/elicitations",
      { price_list: answersForValue(30, GRID) },
      buyer.apiKey,
    );
    await call(
      "POST",
      "/rounds/r1/evaluations",
      { merchant_id: seller.agentId, product_id: "mug", prior_intent: false, fit_eval: 0.2 },
      buyer.apiKey,
    );

    const early = await call(
      "POST",
      "/rounds/r1/feedback",
      { product_id: "mug", no_regret: true },
      buyer.apiKey,
    );
    assert.equal(early.status, 409);
    assert.equal(early.json.error.code, "ROUND_OPEN");

    const cleared = await call("POST", "/rounds/r1/clear");
    assert.ok(cleared.json.outcomesRecorded >= 1);

    const missingRoute = await call(
      "POST",
      "/rounds/r1/outcomes",
      { traded: true, no_regret: true, repeat: true },
      seller.apiKey,
    );
    assert.equal(missingRoute.status, 404);

    const sellerFeedback = await call(
      "POST",
      "/rounds/r1/feedback",
      { product_id: "mug", no_regret: true },
      seller.apiKey,
    );
    assert.equal(sellerFeedback.status, 403);

    const forged = await call(
      "POST",
      "/rounds/r1/feedback",
      { product_id: "mug", traded: true, repeat: true, no_regret: true },
      buyer.apiKey,
    );
    assert.equal(forged.status, 400);
    assert.equal(forged.json.error.code, "OUTCOME_NOT_SELF_REPORTED");

    const before = await call("GET", `/merchants/${seller.agentId}/score`);
    assert.equal(before.json.metrics.noRegretRate, null);

    const feedback = await call(
      "POST",
      "/rounds/r1/feedback",
      { product_id: "mug", no_regret: false, delayed_fit_eval: 0.4 },
      buyer.apiKey,
    );
    assert.equal(feedback.status, 200);
    assert.equal(feedback.json.updated, true);

    const after = await call("GET", `/merchants/${seller.agentId}/score`);
    assert.equal(after.json.metrics.noRegretRate, 0);

    const flip = await call(
      "POST",
      "/rounds/r1/feedback",
      { product_id: "mug", no_regret: true },
      buyer.apiKey,
    );
    assert.equal(flip.status, 409);
    assert.equal(flip.json.error.code, "OUTCOME_LOCKED");
  });
});

test("第二次成交把复购从未知改成真，而不是由买家自己声称", async () => {
  const engine = new MarketEngine();
  const reward = new RewardService(engine);
  const buyer = engine.registerAgent("buyer", "b").agent;
  const other = engine.registerAgent("buyer", "o").agent;
  const seller = engine.registerAgent("seller", "s").agent;
  const seller2 = engine.registerAgent("seller", "s2").agent;

  const run = (roundId: string) => {
    engine.createRound(roundId);
    engine.submitAsk(roundId, seller, 5, 1);
    reward.registerListing({ roundId, merchant: seller, productId: "mug" });
    engine.submitAsk(roundId, seller2, 12, 1);
    engine.submitBid(roundId, other, 20, 1);
    engine.submitBid(roundId, buyer, 30, 1);
    reward.recordEvaluation({
      roundId,
      buyer,
      merchantId: seller.id,
      productId: "mug",
      priorIntent: true,
      fitEval: 0.8,
    });
    const result = engine.clearRound(roundId);
    reward.ingestClearing(result);
    assert.equal(reward.ingestClearing(result).recorded, 0);
  };

  run("r1");
  assert.equal(reward.scoreOf(seller.id).metrics.repeatRate, null);
  run("r2");
  const repeatRate = reward.scoreOf(seller.id).metrics.repeatRate;
  assert.ok(repeatRate !== null && repeatRate > 0.99, `复购率应接近 1，实际 ${repeatRate}`);
});

test("多出来的展示会稀释发现精度，只评价不展示时口径不变", () => {
  const now = Date.UTC(2026, 0, 1);
  const focused = new ScoringEngine(undefined, () => now);
  const sprayed = new ScoringEngine(undefined, () => now);
  for (let i = 0; i < 12; i++) {
    const evaluation = {
      roundId: "r",
      merchantId: "m",
      productId: `p${i}`,
      buyerAgentId: `b${i}`,
      priorIntent: i < 10 ? false : true,
      fitEval: i < 10 ? 0.9 : 0.2,
      submittedAt: now,
    };
    focused.appendEvaluation(evaluation);
    sprayed.appendEvaluation({ ...evaluation });
  }
  for (let i = 0; i < 80; i++) sprayed.appendImpression("m", now);

  const a = focused.score("m");
  const b = sprayed.score("m");
  assert.equal(a.discovery.discoveryEvents, 10);
  assert.equal(b.discovery.discoveryEvents, 10);
  assert.ok(b.discovery.totalImpressions >= 80);
  assert.ok(b.discovery.discoveryPrecision < a.discovery.discoveryPrecision);
  assert.ok(b.discoveryScore < a.discoveryScore);
});

test("冷启动时探索位会让名单以外的商家也被看到，最高分者始终在列", async () => {
  await withServer(async (call) => {
    const buyer = (await call("POST", "/agents", { role: "buyer", name: "buyer" })).json;
    const names = ["alpha", "bravo", "charlie", "delta", "echo"];
    await call("POST", "/rounds", { roundId: "r" });
    for (const name of names) {
      const seller = (await call("POST", "/agents", { role: "seller", name })).json;
      await call(
        "POST",
        "/rounds/r/listings",
        { product_id: name, cost: 3 },
        seller.apiKey,
      );
    }
    const listed = await call("GET", "/rounds/r/candidates?limit=3", undefined, buyer.apiKey);
    assert.equal(listed.json.candidates.length, 3);
    const explored = listed.json.candidates.filter((c: { explored: boolean }) => c.explored);
    assert.equal(explored.length, 1);
    const shown = listed.json.candidates.map((c: { productId: string }) => c.productId);
    assert.ok(shown.includes("alpha"));
    assert.ok(shown.includes("bravo"));
  });
});
