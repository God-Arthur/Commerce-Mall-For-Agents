/**
 * 其余三条性质：强预算平衡（IR）、个体理性（IR）、效率损失上界。
 * 以及与 VCG 的效率对照。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearMarket } from "../src/mechanism/mcafee.ts";

const EPS = 1e-9;

function combos<T>(arr: T[], k: number, start = 0, prefix: T[] = []): T[][] {
  if (prefix.length === k) return [[...prefix]];
  const out: T[][] = [];
  for (let i = start; i < arr.length; i++) out.push(...combos(arr, k, i, [...prefix, arr[i]]));
  return out;
}

const bidsOf = (v: number[]) => v.map((value, i) => ({ agentId: `b${i}`, value, quantity: 1 }));
const asksOf = (c: number[]) => c.map((cost, i) => ({ agentId: `s${i}`, cost, quantity: 1 }));

const GRID = [1, 2, 3, 4, 5];

test("强预算平衡：买方总付款 >= 卖方总收款", () => {
  let checks = 0;
  for (let m = 1; m <= 4; m++)
    for (let n = 1; n <= 4; n++)
      for (const tb of combos(GRID, m))
        for (const ta of combos(GRID, n)) {
          const r = clearMarket(bidsOf(tb), asksOf(ta));
          checks++;
          if (r.tradedQuantity === 0) continue;
          const buyerTotal = r.tradedQuantity * r.clearingPriceBuyer!;
          const sellerTotal = r.tradedQuantity * r.clearingPriceSeller!;
          assert.ok(
            buyerTotal >= sellerTotal - EPS,
            `预算不平衡：买方付 ${buyerTotal} < 卖方收 ${sellerTotal} | B${JSON.stringify(tb)} A${JSON.stringify(ta)}`
          );
        }
  console.log(`  强预算平衡: ${checks} 种情形全部通过`);
});

test("个体理性：成交买方付款 <= 估值，成交卖方收款 >= 成本", () => {
  let checks = 0;
  for (let m = 1; m <= 4; m++)
    for (let n = 1; n <= 4; n++)
      for (const tb of combos(GRID, m))
        for (const ta of combos(GRID, n)) {
          const r = clearMarket(bidsOf(tb), asksOf(ta));
          checks++;
          if (r.tradedQuantity === 0) continue;
          const v = [...tb].sort((a, b) => b - a);
          const c = [...ta].sort((a, b) => a - b);
          for (let i = 0; i < r.tradedQuantity; i++) {
            assert.ok(
              v[i] - r.clearingPriceBuyer! >= -EPS,
              `买方 IR 破：估值 ${v[i]} < 付款 ${r.clearingPriceBuyer} | B${JSON.stringify(tb)} A${JSON.stringify(ta)}`
            );
            assert.ok(
              r.clearingPriceSeller! - c[i] >= -EPS,
              `卖方 IR 破：收款 ${r.clearingPriceSeller} < 成本 ${c[i]} | B${JSON.stringify(tb)} A${JSON.stringify(ta)}`
            );
          }
        }
  console.log(`  个体理性: ${checks} 种情形全部通过`);
});

test("效率损失：相对完全效率至多牺牲 1 笔交易", () => {
  let checks = 0;
  let maxLoss = 0;
  let lostSome = 0;
  for (let m = 1; m <= 4; m++)
    for (let n = 1; n <= 4; n++)
      for (const tb of combos(GRID, m))
        for (const ta of combos(GRID, n)) {
          const r = clearMarket(bidsOf(tb), asksOf(ta));
          checks++;
          assert.ok(
            r.efficiencyLoss <= 1,
            `效率损失 ${r.efficiencyLoss} > 1 | B${JSON.stringify(tb)} A${JSON.stringify(ta)}`
          );
          if (r.efficiencyLoss > maxLoss) maxLoss = r.efficiencyLoss;
          if (r.efficiencyLoss === 1) lostSome++;
        }
  console.log(
    `  效率损失: ${checks} 种情形，最大损失 ${maxLoss} 笔，其中 ${lostSome} 种确实牺牲了一笔`
  );
  assert.equal(maxLoss, 1, "应存在恰好牺牲 1 笔的情形，证明该上界是紧的");
});

test("效率损失上界对多数量同样成立", () => {
  const cases = [
    { v: [10, 10], q: [3, 1], c: [5, 5, 5], k: [4, 4, 1] },
    { v: [20, 8], q: [2, 3], c: [3, 12], k: [4, 1] },
    { v: [9, 9, 9], q: [2, 2, 2], c: [4, 4, 4, 4], k: [2, 2, 2, 1] },
    { v: [15], q: [10], c: [1, 1, 1], k: [5, 3, 2] },
  ];
  for (const cs of cases) {
    const bids = cs.v.map((value, i) => ({ agentId: `b${i}`, value, quantity: cs.q[i] }));
    const asks = cs.c.map((cost, i) => ({ agentId: `s${i}`, cost, quantity: cs.k[i] }));
    const r = clearMarket(bids, asks);
    assert.ok(r.efficiencyLoss <= 1, `效率损失 ${r.efficiencyLoss} > 1`);
    console.log(
      `  多数量: k*=${r.efficientQuantity} 成交=${r.tradedQuantity} 损失=${r.efficiencyLoss} 分支=${r.branch}`
    );
  }
});

test("VCG 对照：说明为何不选 VCG", () => {
  // 单买方单卖方：VCG 可以完全有效且 DSIC，但需要平台补贴
  // 买方估值 10，卖方成本 5，完全效率的剩余 = 5
  const v = 10;
  const c = 5;
  const efficientSurplus = v - c;
  // VCG 在单点情形要买方付 0、卖方收 0（临界支付），平台得贴 efficientSurplus
  const platformSubsidy = efficientSurplus;
  assert.ok(platformSubsidy > 0);

  // McAfee 在同一情形下：1 买方 1 卖方必然放弃交易，平台不需要贴钱
  const r = clearMarket(bidsOf([v]), asksOf([c]));
  assert.equal(r.tradedQuantity, 0);
  assert.equal(r.tradedQuantity * (r.clearingPriceBuyer ?? 0) >= r.tradedQuantity * (r.clearingPriceSeller ?? 0), true);
  console.log(
    `  VCG 在单笔情形需平台补贴 ${platformSubsidy}；McAfee 放弃该笔交易，平台支出 0`
  );
});

test("分支 (a) 严格预算平衡：买卖双方支付/收款完全相等", () => {
  let checked = 0;
  for (let m = 1; m <= 4; m++)
    for (let n = 1; n <= 4; n++)
      for (const tb of combos(GRID, m))
        for (const ta of combos(GRID, n)) {
          const r = clearMarket(bidsOf(tb), asksOf(ta));
          if (r.branch !== "a" || r.tradedQuantity === 0) continue;
          checked++;
          assert.equal(r.clearingPriceBuyer, r.clearingPriceSeller);
          assert.equal(
            r.tradedQuantity * r.clearingPriceBuyer!,
            r.tradedQuantity * r.clearingPriceSeller!
          );
        }
  console.log(`  分支 a 严格预算平衡: ${checked} 种情形通过`);
});