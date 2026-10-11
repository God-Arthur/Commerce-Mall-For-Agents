// 判别：McAfee 两种边界约定，哪一种才是真正 DSIC？
// 修正：case(b) 双边价格不同 —— 买方付 v_(k)，卖方收 c_(k)，中间价差归平台。
type R = { pBuy: number; pSell: number; traded: number; branch: "a" | "b" | "none" };

function variantA(bids: number[], asks: number[]): R {
  const v = [...bids].sort((a, b) => b - a);
  const c = [...asks].sort((a, b) => a - b);
  const m = v.length, n = c.length;
  let k = 0;
  for (let i = 1; i <= Math.min(m, n); i++) if (v[i - 1] >= c[i - 1]) k = i;
  if (k === 0) return { pBuy: 0, pSell: 0, traded: 0, branch: "none" };
  const vn1 = k < m ? v[k] : 0;
  const cn1 = k < n ? c[k] : 1;
  const p0 = (vn1 + cn1) / 2;
  if (c[k - 1] <= p0 && p0 <= v[k - 1]) return { pBuy: p0, pSell: p0, traded: k, branch: "a" };
  return { pBuy: v[k - 1], pSell: c[k - 1], traded: k - 1, branch: "b" };
}

function variantB(bids: number[], asks: number[]): R {
  const v = [...bids].sort((a, b) => b - a);
  const c = [...asks].sort((a, b) => a - b);
  const m = v.length, n = c.length;
  let k = 0;
  for (let i = 1; i <= Math.min(m, n); i++) if (v[i - 1] >= c[i - 1]) k = i;
  if (k === 0) return { pBuy: 0, pSell: 0, traded: 0, branch: "none" };
  if (k < m && k < n) {
    const p0 = (v[k] + c[k]) / 2;
    if (c[k - 1] <= p0 && p0 <= v[k - 1]) return { pBuy: p0, pSell: p0, traded: k, branch: "a" };
  }
  return { pBuy: v[k - 1], pSell: c[k - 1], traded: k - 1, branch: "b" };
}

// 计算某 agent 在某报价下的效用
function util(
  fn: (b: number[], a: number[]) => R,
  tb: number[], ta: number[],
  who: { side: "b" | "a"; idx: number; report: number }
): number {
  const b = who.side === "b" ? tb.map((x, i) => (i === who.idx ? who.report : x)) : [...tb];
  const a = who.side === "a" ? ta.map((x, i) => (i === who.idx ? who.report : x)) : [...ta];
  const r = fn(b, a);
  // 按【当前】报价排序决定谁拿到席位（席位归属与报价一致）
  const vb = b.map((x, i) => ({ x, i })).sort((p, q) => q.x - p.x);
  const sa = a.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x);
  if (who.side === "b") {
    for (let i = 0; i < r.traded; i++) if (vb[i].i === who.idx) return tb[who.idx] - r.pBuy;
  } else {
    for (let i = 0; i < r.traded; i++) if (sa[i].i === who.idx) return r.pSell - ta[who.idx];
  }
  return 0;
}

function checkDSIC(name: string, fn: (b: number[], a: number[]) => R, grid: number[], maxM: number, maxN: number) {
  let viol = 0, cases = 0; const firsts: string[] = [];
  const combos = <T,>(arr: T[], k: number): T[][] =>
    k === 0 ? [[]] : arr.flatMap((x, i) => combos(arr.slice(i + 1), k - 1).map((r) => [x, ...r]));
  for (let m = 1; m <= maxM; m++)
    for (let n = 1; n <= maxN; n++)
      for (const tb of combos(grid, m))
        for (const ta of combos(grid, n)) {
          for (let i = 0; i < m; i++) {
            const base = util(fn, tb, ta, { side: "b", idx: i, report: tb[i] });
            for (const rep of grid) {
              if (rep === tb[i]) continue;
              cases++;
              const u = util(fn, tb, ta, { side: "b", idx: i, report: rep });
              if (u > base + 1e-9) {
                viol++;
                if (firsts.length < 3) firsts.push(`买方${i}真值${tb[i]}报${rep}: 诚实${base} > 偏离${u} | B${JSON.stringify(tb)} A${JSON.stringify(ta)}`);
              }
            }
          }
          for (let i = 0; i < n; i++) {
            const base = util(fn, tb, ta, { side: "a", idx: i, report: ta[i] });
            for (const rep of grid) {
              if (rep === ta[i]) continue;
              cases++;
              const u = util(fn, tb, ta, { side: "a", idx: i, report: rep });
              if (u > base + 1e-9) {
                viol++;
                if (firsts.length < 3) firsts.push(`卖方${i}真值${ta[i]}报${rep}: 诚实${base} > 偏离${u} | B${JSON.stringify(tb)} A${JSON.stringify(ta)}`);
              }
            }
          }
        }
  console.log(`${name}: 检验数=${cases}  违反=${viol}`);
  firsts.forEach((f) => console.log(`   反例 -> ${f}`));
}

console.log("=== 网格 {1,2,3,4,5}, m,n<=3 ===");
checkDSIC("变体A(人工上下界 0/1)", variantA, [1, 2, 3, 4, 5], 3, 3);
checkDSIC("变体B(需k+1双方在册)", variantB, [1, 2, 3, 4, 5], 3, 3);
console.log("\n=== 含并列价网格 {1,2,2,3,4}, m,n<=3 ===");
checkDSIC("变体A(含并列)", variantA, [1, 2, 2, 3, 4], 3, 3);
checkDSIC("变体B(含并列)", variantB, [1, 2, 2, 3, 4], 3, 3);