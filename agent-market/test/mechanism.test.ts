/**
 * 机制单元测试：已知输入/输出 + 边界情况。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearMarket } from "../src/mechanism/mcafee.ts";

const B = (agentId: string, value: number, quantity = 1) => ({ agentId, value, quantity });
const S = (agentId: string, cost: number, quantity = 1) => ({ agentId, cost, quantity });

test("无成交：买方最高价低于卖方最低成本", () => {
  const r = clearMarket([B("b1", 5)], [S("s1", 8)]);
  assert.equal(r.branch, "none");
  assert.equal(r.tradedQuantity, 0);
  assert.equal(r.tradeCount, 0);
  assert.deepEqual(r.fills, []);
});

test("单边为空", () => {
  assert.equal(clearMarket([], [S("s1", 1)]).tradedQuantity, 0);
  assert.equal(clearMarket([B("b1", 10)], []).tradedQuantity, 0);
});

test("仅一笔有效交易且 k+1 方缺位：牺牲该笔，保留 branch 标记", () => {
  const r = clearMarket([B("b1", 10)], [S("s1", 5)]);
  assert.equal(r.branch, "b");
  assert.equal(r.efficientQuantity, 1);
  assert.equal(r.tradedQuantity, 0);
  assert.equal(r.efficiencyLoss, 1);
  assert.equal(r.clearingPriceBuyer, null);
});

test("有效交易 1 笔、双方均有富余但中间价越界：同样牺牲该笔", () => {
  // v=[10,1], c=[5,8] -> k=1; p0=(1+8)/2=4.5 不在 [c_(1),v_(1)]=[5,10]
  const r = clearMarket([B("b1", 10), B("b2", 1)], [S("s1", 5), S("s2", 8)]);
  assert.equal(r.branch, "b");
  assert.equal(r.efficientQuantity, 1);
  assert.equal(r.tradedQuantity, 0);
  assert.equal(r.clearingPriceBuyer, null);
  assert.equal(r.efficiencyLoss, 1);
});

test("分支 a：中间价落在边际区间内，按统一价全额成交", () => {
  // v=[10,8,1], c=[2,3,9] -> k=2; p0=(1+9)/2=5 落在 [c_(2),v_(2)]=[3,8]
  const r = clearMarket(
    [B("b1", 10), B("b2", 8), B("b3", 1)],
    [S("s1", 2), S("s2", 3), S("s3", 9)]
  );
  assert.equal(r.branch, "a");
  assert.equal(r.efficientQuantity, 2);
  assert.equal(r.tradedQuantity, 2);
  assert.equal(r.clearingPriceBuyer, 5);
  assert.equal(r.clearingPriceSeller, 5);
  assert.equal(r.efficiencyLoss, 0);
});

test("分支 b：仍有成交时双边价格不同，价差归平台", () => {
  // v=[10,7,1], c=[1,5,20] -> k=2; p0=(1+20)/2=10.5 越过 v_(2)=7
  const r = clearMarket(
    [B("b1", 10), B("b2", 7), B("b3", 1)],
    [S("s1", 1), S("s2", 5), S("s3", 20)]
  );
  assert.equal(r.branch, "b");
  assert.equal(r.efficientQuantity, 2);
  assert.equal(r.tradedQuantity, 1);
  assert.equal(r.clearingPriceBuyer, 7);   // v_(k)
  assert.equal(r.clearingPriceSeller, 5);  // c_(k)
  assert.equal(r.efficiencyLoss, 1);
  assert.ok(
    r.tradedQuantity * r.clearingPriceBuyer! >= r.tradedQuantity * r.clearingPriceSeller!,
    "强预算平衡"
  );
});

test("并列价：全部同价仍能正确出清", () => {
  const r = clearMarket(
    [B("b1", 10), B("b2", 10), B("b3", 10)],
    [S("s1", 5), S("s2", 5), S("s3", 5)]
  );
  assert.equal(r.efficientQuantity, 3);
  assert.equal(r.branch, "b");
  assert.equal(r.tradedQuantity, 2);
  assert.equal(r.efficiencyLoss, 1);
});

test("并列且恰好相等 b_k == c_k 仍算有效", () => {
  // v=[10,3], c=[3,9] -> k=1 (10>=3); p0=(3+9)/2=6 落在 [3,10]
  const r = clearMarket([B("b1", 10), B("b2", 3)], [S("s1", 3), S("s2", 9)]);
  assert.equal(r.efficientQuantity, 1);
  assert.equal(r.tradedQuantity, 1);
  assert.equal(r.branch, "a");
});

test("买卖数量不等：按单位逐个匹配", () => {
  // 买方 2 单位报 10，卖方 3 单位要 5 -> k=2，买方无第 3 单位 -> 分支 b 成交 1
  const r = clearMarket([B("b1", 10, 2)], [S("s1", 5, 3)]);
  assert.equal(r.branch, "b");
  assert.equal(r.efficientQuantity, 2);
  assert.equal(r.tradedQuantity, 1);
  assert.equal(r.efficiencyLoss, 1);
});

test("多买方多卖方数量混合", () => {
  const r = clearMarket(
    [B("b1", 20, 2), B("b2", 8, 3)],
    [S("s1", 3, 4), S("s2", 12, 1)]
  );
  // v=[20,20,8,8,8] c=[3,3,3,3,12]
  // k: 20>=3,20>=3,8>=3,8>=3 成立, 8>=12 不成立 -> k=4
  // k+1=5 双方在册 -> p0=(8+12)/2=10, 越过 v_(4)=8 -> 分支 b, 成交 3
  assert.equal(r.branch, "b");
  assert.equal(r.efficientQuantity, 4);
  assert.equal(r.tradedQuantity, 3);
  assert.equal(r.efficiencyLoss, 1);
});

test("非法输入被拒绝", () => {
  assert.throws(() => clearMarket([B("b1", NaN)], [S("s1", 1)]), TypeError);
  assert.throws(() => clearMarket([B("b1", Infinity)], [S("s1", 1)]), TypeError);
  assert.throws(() => clearMarket([B("b1", 10, 0)], [S("s1", 1)]), TypeError);
  assert.throws(() => clearMarket([B("b1", 10, -3)], [S("s1", 1)]), TypeError);
  assert.throws(() => clearMarket([B("b1", 10, 1.5)], [S("s1", 1)]), TypeError);
});

test("零值报价合法（免费商品）", () => {
  const r = clearMarket([B("b1", 0), B("b2", 0)], [S("s1", 0), S("s2", 0)]);
  assert.equal(r.efficientQuantity, 2);
  assert.equal(r.branch, "b");
  assert.equal(r.tradedQuantity, 1);
});

test("成交记录的每单位价格与总览一致，总量吻合", () => {
  const r = clearMarket(
    [B("b1", 20, 2), B("b2", 8, 3), B("b3", 1, 1)],
    [S("s1", 3, 4), S("s2", 12, 2)]
  );
  for (const f of r.fills) {
    assert.equal(f.buyerPrice, r.clearingPriceBuyer);
    assert.equal(f.sellerPrice, r.clearingPriceSeller);
  }
  const totalQty = r.fills.reduce((s, f) => s + f.quantity, 0);
  assert.equal(totalQty, r.tradedQuantity);
});

test("成交方一定是报价排序的前若干名", () => {
  const r = clearMarket(
    [B("b1", 20, 2), B("b2", 8, 3), B("b3", 1, 1)],
    [S("s1", 3, 4), S("s2", 12, 2)]
  );
  const winnerBuyers = new Set(r.fills.map((f) => f.buyerAgentId));
  const winnerSellers = new Set(r.fills.map((f) => f.sellerAgentId));
  // b3 报价最低，不应成交
  assert.equal(winnerBuyers.has("b3"), false);
  // s2 成本最高，不应成交
  assert.equal(winnerSellers.has("s2"), false);
});