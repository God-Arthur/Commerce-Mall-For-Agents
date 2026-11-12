/**
 * 价格表诱发：保留价来自「买或不买」，fit_eval 不参与，也不能从本接口塞进来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { answersForValue, elicitReservation } from "../src/elicitation/price-list.ts";
import { clearMarket } from "../src/mechanism/mcafee.ts";

const GRID = [0, 5, 10, 15, 20, 25, 30];

test("诚实价格表的保留价等于不超过真实价值的最高网格价", () => {
  assert.equal(elicitReservation(answersForValue(22, GRID)), 20);
  assert.equal(elicitReservation(answersForValue(5, GRID)), 5);
  assert.equal(elicitReservation(answersForValue(4, GRID)), 0);
  assert.equal(elicitReservation(answersForValue(-1, GRID)), null);
});

test("不单调或自相矛盾的价格表被拒绝", () => {
  assert.throws(
    () => elicitReservation([
      { price: 5, accept: false },
      { price: 10, accept: true },
    ]),
    (err: unknown) => (err as { code: string }).code === "NON_MONOTONE",
  );
  assert.throws(
    () => elicitReservation([
      { price: 10, accept: true },
      { price: 10, accept: false },
    ]),
    (err: unknown) => (err as { code: string }).code === "INCONSISTENT_PRICE_LIST",
  );
  assert.throws(
    () => elicitReservation([]),
    (err: unknown) => (err as { code: string }).code === "EMPTY_PRICE_LIST",
  );
});

test("诱发函数的结果不随旁边的 fit_eval 改变", () => {
  const rows = answersForValue(18, GRID);
  const withLowFit = { fitEval: 0.05, rows };
  const withHighFit = { fitEval: 0.99, rows };
  assert.equal(elicitReservation(withLowFit.rows), elicitReservation(withHighFit.rows));
  assert.equal(elicitReservation(withLowFit.rows), 15);
});

test("在固定市场上，少报或多报价格表都不会提高真实效用", () => {
  const othersB = [28, 17];
  const asks = [6, 11, 21];
  const truth = 24;
  const honestBid = elicitReservation(answersForValue(truth, GRID))!;

  const payoff = (bid: number | null): number => {
    if (bid === null) return 0;
    const bids = [
      { agentId: "me", value: bid, quantity: 1 },
      ...othersB.map((value, i) => ({ agentId: `b${i}`, value, quantity: 1 })),
    ];
    const sellerAsks = asks.map((cost, i) => ({ agentId: `s${i}`, cost, quantity: 1 }));
    const cleared = clearMarket(bids, sellerAsks);
    const ranked = [...bids].sort((a, b) => b.value - a.value || a.agentId.localeCompare(b.agentId));
    const won = ranked.slice(0, cleared.tradedQuantity).some((b) => b.agentId === "me");
    return won ? truth - cleared.clearingPriceBuyer! : 0;
  };

  const honest = payoff(honestBid);
  for (const reported of [0, 5, 10, 15, 20, 25, 30, 40, 60]) {
    const bid = elicitReservation(answersForValue(reported, GRID));
    assert.ok(
      payoff(bid) <= honest + 1e-9,
      `报成 ${reported} 的效用 ${payoff(bid)} 高于如实 ${honest}`,
    );
  }
});
