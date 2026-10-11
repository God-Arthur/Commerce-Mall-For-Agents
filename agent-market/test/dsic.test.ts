/**
 * DSIC（占优策略激励相容）实证仿真 —— 本项目最重要的验证。
 *
 * 做法：穷举。对每个「真实价值 / 真实成本」组合，
 * 让每个 agent 轮流尝试各种偏离报价，其余 agent 全部如实报价，
 * 断言「如实报价的效用 >= 任意偏离的效用」。
 *
 * 关键：本测试直接调用生产实现 clearMarket，而不是测试专用副本。
 * 否则验证的就不是真正上线的那份代码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearMarket } from "../src/mechanism/mcafee.ts";

const EPS = 1e-9;

/**
 * 计算某 agent 在指定（可能偏离的）报价下的效用。
 * 席位归属按该次报价排序确定。
 */
function utility(
  truthB: number[],
  truthA: number[],
  side: "buyer" | "seller",
  idx: number,
  report: number
): number {
  const bids = truthB.map((v, i) => ({
    agentId: `b${i}`,
    value: side === "buyer" && i === idx ? report : v,
    quantity: 1,
  }));
  const asks = truthA.map((c, i) => ({
    agentId: `s${i}`,
    cost: side === "seller" && i === idx ? report : c,
    quantity: 1,
  }));
  const r = clearMarket(bids, asks);

  const order = side === "buyer"
    ? asks
    : bids;
  const me = side === "buyer" ? `b${idx}` : `s${idx}`;
  const winners = new Set<string>();
  // 按排序名次取前 tradedQuantity 名
  const ranked = (side === "buyer" ? bids : asks)
    .slice()
    .sort((x, y) =>
      side === "buyer" ? y.value - x.value : x.cost - y.cost
    )
    .map((q) => q.agentId);
  for (let i = 0; i < r.tradedQuantity && i < ranked.length; i++) winners.add(ranked[i]);

  if (!winners.has(me)) return 0;
  return side === "buyer" ? truthB[idx] - r.clearingPriceBuyer! : r.clearingPriceSeller! - truthA[idx];
}

/** 枚举从候选值中取 k 个（可重复，体现并列价）。 */
function combos<T>(arr: T[], k: number, start = 0, prefix: T[] = []): T[][] {
  if (prefix.length === k) return [[...prefix]];
  const out: T[][] = [];
  for (let i = start; i < arr.length; i++) {
    out.push(...combos(arr, k, i, [...prefix, arr[i]]));
  }
  return out;
}

interface Violation {
  side: "buyer" | "seller";
  idx: number;
  truth: number;
  report: number;
  honest: number;
  deviate: number;
  buyers: number[];
  sellers: number[];
}

function exhaustiveDsic(
  grid: number[],
  maxBuyers: number,
  maxSellers: number
): { checks: number; violations: Violation[] } {
  const violations: Violation[] = [];
  let checks = 0;

  for (let m = 1; m <= maxBuyers; m++) {
    for (let n = 1; n <= maxSellers; n++) {
      for (const tb of combos(grid, m)) {
        for (const ta of combos(grid, n)) {
          for (let i = 0; i < m; i++) {
            const honest = utility(tb, ta, "buyer", i, tb[i]);
            for (const rep of grid) {
              if (rep === tb[i]) continue;
              checks++;
              const dev = utility(tb, ta, "buyer", i, rep);
              if (dev > honest + EPS) {
                violations.push({
                  side: "buyer", idx: i, truth: tb[i], report: rep,
                  honest, deviate: dev, buyers: [...tb], sellers: [...ta],
                });
              }
            }
          }
          for (let i = 0; i < n; i++) {
            const honest = utility(tb, ta, "seller", i, ta[i]);
            for (const rep of grid) {
              if (rep === ta[i]) continue;
              checks++;
              const dev = utility(tb, ta, "seller", i, rep);
              if (dev > honest + EPS) {
                violations.push({
                  side: "seller", idx: i, truth: ta[i], report: rep,
                  honest, deviate: dev, buyers: [...tb], sellers: [...ta],
                });
              }
            }
          }
        }
      }
    }
  }
  return { checks, violations };
}

function report(name: string, grid: number[], m: number, n: number) {
  const { checks, violations } = exhaustiveDsic(grid, m, n);
  const detail = violations
    .slice(0, 5)
    .map(
      (v) =>
        `\n    ${v.side === "buyer" ? "买方" : "卖方"}${v.idx} 真值${v.truth} 改报${v.report}: ` +
        `如实 ${v.honest} < 偏离 ${v.deviate} | 买方${JSON.stringify(v.buyers)} 卖方${JSON.stringify(v.sellers)}`
    )
    .join("");
  assert.equal(
    violations.length,
    0,
    `${name}: 如实报价未达弱占优，出现 ${violations.length} 个反例（共 ${checks} 次检验）${detail}`
  );
  console.log(`  ${name}: ${checks} 次检验，0 违反`);
}

test("DSIC 穷举：网格 {1..5}，买方<=3 卖方<=3", () => {
  report("网格{1..5}", [1, 2, 3, 4, 5], 3, 3);
});

test("DSIC 穷举：含并列价 网格 {1,2,2,3,4}", () => {
  report("网格{1,2,2,3,4}", [1, 2, 2, 3, 4], 3, 3);
});

test("DSIC 穷举：含 0 值 网格 {0,1,2,3,4}", () => {
  report("网格{0..4}", [0, 1, 2, 3, 4], 3, 3);
});

test("DSIC 穷举：网格 {1..5}，买方<=4 卖方<=4", () => {
  report("网格{1..5} 4x4", [1, 2, 3, 4, 5], 4, 4);
});

test("DSIC 穷举：非对称网格 {0,1,3,7}", () => {
  report("网格{0,1,3,7}", [0, 1, 3, 7], 4, 4);
});

test("DSIC：单边独家的极端情形", () => {
  // 1 买方 1 卖方时机制必然放弃交易，任何偏离都无法获利
  const r = clearMarket(
    [{ agentId: "b1", value: 10, quantity: 1 }],
    [{ agentId: "s1", cost: 5, quantity: 1 }]
  );
  assert.equal(r.tradedQuantity, 0);
  assert.equal(r.efficientQuantity, 1);
});

test("DSIC：连续值（非整数）抽样检验", () => {
  // 整数网格之外，用连续随机值再做 2000 轮，确认不是只在网格上成立
  let violations = 0;
  let checks = 0;
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let t = 0; t < 400; t++) {
    const m = 1 + Math.floor(rnd() * 4);
    const n = 1 + Math.floor(rnd() * 4);
    const tb = Array.from({ length: m }, () => Math.round(rnd() * 1000) / 10);
    const ta = Array.from({ length: n }, () => Math.round(rnd() * 1000) / 10);
    for (let i = 0; i < m; i++) {
      const honest = utility(tb, ta, "buyer", i, tb[i]);
      for (const rep of [Math.round(rnd() * 1000) / 10, Math.round(rnd() * 100) / 10]) {
        checks++;
        if (utility(tb, ta, "buyer", i, rep) > honest + EPS) violations++;
      }
    }
    for (let i = 0; i < n; i++) {
      const honest = utility(tb, ta, "seller", i, ta[i]);
      for (const rep of [Math.round(rnd() * 1000) / 10, Math.round(rnd() * 100) / 10]) {
        checks++;
        if (utility(tb, ta, "seller", i, rep) > honest + EPS) violations++;
      }
    }
  }
  assert.equal(violations, 0, `连续值抽样出现 ${violations} 个反例（共 ${checks} 次）`);
  console.log(`  连续值抽样: ${checks} 次检验，0 违反`);
});