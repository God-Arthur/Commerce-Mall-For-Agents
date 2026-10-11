/**
 * 仿真脚本：直观展示「说真话是占优策略」。
 *
 * 运行：node scripts/simulate.ts
 *
 * 这个脚本不打印一堆统计数字，而是回答一个具体问题：
 *   「如果我要少付一点钱，我该怎么做？」
 * 答案是：什么都不要做。
 */
import { clearMarket } from "../src/mechanism/mcafee.ts";

// ── 一个小工具：打印对齐表格 ──────────────────────────────────
function bar(n: number, width = 30): string {
  const full = Math.round((n / 100) * width);
  return "█".repeat(Math.max(0, Math.min(width, full))) + "·".repeat(Math.max(0, width - full));
}

const S = (id: string, c: number, q = 1) => ({ agentId: id, cost: c, quantity: q });
const B = (id: string, v: number, q = 1) => ({ agentId: id, value: v, quantity: q });

// ─────────────────────────────────────────────────────────────────
console.log("=".repeat(74));
console.log("McAfee 占优策略双向拍卖 —— 说真话为什么是占优策略");
console.log("=".repeat(74));

// ─────────────────────────────────────────────────────────────────
console.log("\n【场景一】压价确实有用吗？\n");
console.log("市场里有 3 个买方、3 个卖方（诚实报价）：");
console.log("  买方出价:  b1=30  b2=26  b3=19");
console.log("  卖方要价:  s1=8   s2=17  s3=40");
console.log("\n完全效率下 2 笔交易（b3=19 < s3=40，不该成交）");

const truthB = [B("b1", 30), B("b2", 26), B("b3", 19)];
const truthA = [S("s1", 8), S("s2", 17), S("s3", 40)];
const base = clearMarket(truthB, truthA);

console.log(`\n诚实出清结果: 分支=${base.branch}  成交=${base.tradedQuantity} 笔`);
console.log(`  买方统一付: ${base.clearingPriceBuyer}`);
console.log(`  卖方统一收: ${base.clearingPriceSeller}`);
if (base.clearingPriceBuyer !== null) {
  console.log(`  买方 b1 效用 = 30 - ${base.clearingPriceBuyer} = ${(30 - base.clearingPriceBuyer!).toFixed(1)}`);
}

function utilForB(bidValue: number, idx: number): number {
  const bids = truthB.map((b, i) => (i === idx ? B(`b${idx + 1}`, bidValue) : b));
  const r = clearMarket(bids, truthA);
  const ranked = bids.slice().sort((x, y) => y.value - x.value).map((q) => q.agentId);
  const winners = new Set(ranked.slice(0, r.tradedQuantity));
  return winners.has(`b${idx + 1}`) ? bidValue - r.clearingPriceBuyer! : 0;
}

const b1Honest = utilForB(30, 0);
console.log(`\nb1 的效用随自己报价的变化（其余 agent 全部如实报价）。`);
console.log(`b1 的**真实价值是 30** —— 「真实效用」那一列才是他实际能拿到的，`);
console.log(`「报价效用」那一列假设他的真实价值等于报价，是用来暴露骗局的：\n`);
console.log(`  ${"报价".padEnd(8)}${"成交".padEnd(6)}${"每单位价".padEnd(10)}${"报价效用".padEnd(10)}${"真实效用".padEnd(10)}`);
console.log(`  ${"-".repeat(50)}`);
for (const bid of [19, 21, 22, 25, 26, 28, 30, 33, 40, 60]) {
  const bids = truthB.map((b, i) => (i === 0 ? B("b1", bid) : b));
  const r = clearMarket(bids, truthA);
  const ranked = bids.slice().sort((x, y) => y.value - x.value).map((q) => q.agentId);
  const traded = r.tradedQuantity > 0 && ranked.slice(0, r.tradedQuantity).includes("b1");
  // 报价效用：假装真实价值 = 报价（骗自己的算法才会这么算）
  const inflated = traded ? bid - r.clearingPriceBuyer! : 0;
  // 真实效用：真实价值恒为 30
  const real = traded ? 30 - r.clearingPriceBuyer! : 0;
  const mark = bid === 30 ? " <- 如实报价" : "";
  console.log(
    `  ${String(bid).padEnd(8)}${(traded ? "是" : "否").padEnd(6)}` +
    `${(traded ? r.clearingPriceBuyer! : "-").toString().padEnd(10)}` +
    `${inflated.toFixed(1).padEnd(10)}${real.toFixed(1).padEnd(10)}${mark}`
  );
}
console.log(`\n  看「真实效用」这一列：最高就是 ${b1Honest.toFixed(1)}，在如实报价 30 时取到。`);
console.log(`  - 压价到 26 及以下 → 挤不进前 k 名，失去成交，真实效用 0；`);
console.log(`  - 抬价到 33、40、60 → 成交价格纹丝不动（仍是 ${base.clearingPriceBuyer}），真实效用恒为 ${b1Honest.toFixed(1)}。`);
console.log(`\n  注意「报价效用」那一列在报价 40 时跳到 14 —— 这是虚高的。`);
console.log(`  agent 若真以为自己值 40，就会以为自己赚了 14；`);
console.log(`  但他实际只付出了 ${base.clearingPriceBuyer}，真实收益还是 ${b1Honest.toFixed(1)}。`);
console.log(`  **虚高的期望会把他引向持续抬价，而抬价对真实效用毫无帮助 ——`);
console.log(`  这正是 DSIC 的经济学意义：价格由「没能成交的人」的报价决定，不由自己决定。**`);

// ─────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(74));
console.log("\n【场景二】压价看起来占便宜，实际触发机制放弃整笔交易\n");
console.log("场景：1 个买方（真实价值 10），3 个卖方（真实成本 2、5、30）");
console.log("这个市场里，b1 如果少报一点，会发生什么？\n");

const s2B = [B("b1", 10)];
const s2A = [S("s1", 2), S("s2", 5), S("s3", 30)];
console.log(`${"b1 报价".padEnd(10)}${"出清分支".padEnd(12)}${"成交".padEnd(10)}${"b1 效用".padEnd(12)}说明`);
console.log(`  ${"-".repeat(62)}`);
for (const bid of [3, 5, 8, 10, 12]) {
  const r = clearMarket([B("b1", bid)], s2A);
  const u = r.tradedQuantity > 0 ? bid - r.clearingPriceBuyer! : 0;
  const note =
    r.branch === "none" ? "报价太低，没有任何有效交易"
    : r.tradedQuantity === 0 ? "有效交易存在，但被牺牲（DSIC 代价）"
    : `按统一价 ${r.clearingPriceBuyer} 成交`;
  console.log(
    `  ${String(bid).padEnd(10)}${r.branch.padEnd(12)}` +
    `${String(r.tradedQuantity).padEnd(10)}${u.toFixed(1).padEnd(12)}${note}`
  );
}
console.log(`\n  结论：如实报价 10 时，效用 0（机制牺牲了这笔交易）。`);
console.log(`        压价到 8、5、3 同样是 0 —— 压价一分钱好处都没有。`);
console.log(`\n        抬价到 12 也还是 0 —— 无论他报多少，这笔交易都做不成。`);
console.log(`        「牺牲一笔」正是 Myerson–Satterthwaite 定理所要求的代价：`);
// ─────────────────────────────────────────────────────────────────
console.log("\n【场景三】市场厚度增加，牺牲的那一笔占比迅速变小\n");
console.log("同一机制，买卖双方各 n 个（价值均匀分布在 10~90，成本均匀分布在 5~50）\n");
console.log(`  ${"n".padEnd(6)}${"完全效率".padEnd(12)}${"实际成交".padEnd(12)}${"损失".padEnd(8)}损失占比`);
console.log(`  ${"-".repeat(50)}`);
for (const n of [1, 2, 3, 5, 10, 20, 50]) {
  const buyers = Array.from({ length: n }, (_, i) => B(`b${i}`, 10 + (80 * i) / Math.max(1, n - 1 || 1)));
  const sellers = Array.from({ length: n }, (_, i) => S(`s${i}`, 5 + (45 * i) / Math.max(1, n - 1 || 1)));
  const r = clearMarket(buyers, sellers);
  const lossRatio = r.efficientQuantity === 0 ? 0 : r.efficiencyLoss / r.efficientQuantity;
  console.log(
    `  ${String(n).padEnd(6)}${String(r.efficientQuantity).padEnd(12)}` +
    `${String(r.tradedQuantity).padEnd(12)}${String(r.efficiencyLoss).padEnd(8)}` +
    `${(lossRatio * 100).toFixed(1)}%`
  );
}
console.log(`\n  结论：无论市场多薄，损失都恰好是 1 笔（看「损失」列，永远 <= 1）；`);
console.log(`        市场越厚，这 1 笔越无关紧要（如 n=50 时占 0%）。`);
console.log(`        这就是 McAfee 机制的卖点：用「至多一笔」的确定性代价，`);
console.log(`        换来了 DSIC + IR + 强预算平衡三者同时成立。`);

// ─────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(74));
console.log("\n【场景四】强预算平衡：平台永远不贴钱\n");
const b4 = [B("b1", 30), B("b2", 26), B("b3", 19), B("b4", 12), B("b5", 8)];
const a4 = [S("s1", 8), S("s2", 17), S("s3", 40), S("s4", 5)];
const r4 = clearMarket(b4, a4);
const buyerTotal = r4.tradedQuantity * (r4.clearingPriceBuyer ?? 0);
const sellerTotal = r4.tradedQuantity * (r4.clearingPriceSeller ?? 0);
console.log(`  买方总付款: ${buyerTotal.toFixed(1)}  ${bar(buyerTotal / 3)}`);
console.log(`  卖方总收款: ${sellerTotal.toFixed(1)}  ${bar(sellerTotal / 3)}`);
console.log(`  平台留存  : ${(buyerTotal - sellerTotal).toFixed(1)}  ${bar((buyerTotal - sellerTotal) / 3)}`);
console.log(`\n  买方总付 >= 卖方总收：${buyerTotal >= sellerTotal ? "成立" : "不成立"}（平台零补贴）`);

console.log("\n" + "=".repeat(74));
console.log("\n仿真结束。想自己验证？运行：node --test \"test/*.test.ts\"");
console.log("=".repeat(74));