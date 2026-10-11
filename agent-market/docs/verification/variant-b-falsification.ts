// 变体B 大规模复核：DSIC / IR / 强预算平衡 / 效率损失<=1
type R = { pBuy: number; pSell: number; traded: number; branch: "a" | "b" | "none" };

function mech(bids: number[], asks: number[]): R {
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
function util(tb: number[], ta: number[], side: "b" | "a", idx: number, report: number): number {
  const b = side === "b" ? tb.map((x, i) => (i === idx ? report : x)) : [...tb];
  const a = side === "a" ? ta.map((x, i) => (i === idx ? report : x)) : [...ta];
  const r = mech(b, a);
  const vb = b.map((x, i) => ({ x, i })).sort((p, q) => q.x - p.x);
  const sa = a.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x);
  if (side === "b") { for (let i = 0; i < r.traded; i++) if (vb[i].i === idx) return tb[idx] - r.pBuy; }
  else { for (let i = 0; i < r.traded; i++) if (sa[i].i === idx) return r.pSell - ta[idx]; }
  return 0;
}
const combos = <T,>(arr: T[], k: number): T[][] =>
  k === 0 ? [[]] : arr.flatMap((x, i) => combos(arr.slice(i + 1), k - 1).map((r) => [x, ...r]));

function run(name: string, grid: number[], maxM: number, maxN: number) {
  let viol = 0, irV = 0, bbV = 0, effV = 0, maxLoss = 0, cases = 0;
  const firsts: string[] = [];
  for (let m = 1; m <= maxM; m++)
    for (let n = 1; n <= maxN; n++)
      for (const tb of combos(grid, m))
        for (const ta of combos(grid, n)) {
          cases++;
          const r = mech(tb, ta);
          // 效率损失：完全效率成交数 k* vs 实际
          const kStar = (() => { const v=[...tb].sort((a,b)=>b-a), c=[...ta].sort((a,b)=>a-b);
            let k=0; for(let i=1;i<=Math.min(m,n);i++) if(v[i-1]>=c[i-1]) k=i; return k; })();
          const loss = kStar - r.traded;
          if (loss > maxLoss) maxLoss = loss;
          if (loss > 1) { effV++; if(firsts.length<3) firsts.push(`效率损失${loss} B${JSON.stringify(tb)} A${JSON.stringify(ta)}`); }
          // 强预算平衡
          if (r.traded * r.pBuy < r.traded * r.pSell - 1e-9) { bbV++; if(firsts.length<3) firsts.push(`BB破 B${JSON.stringify(tb)} A${JSON.stringify(ta)} pB=${r.pBuy} pS=${r.pSell}`); }
          // IR
          const v=[...tb].sort((a,b)=>b-a), c=[...ta].sort((a,b)=>a-b);
          for(let i=0;i<r.traded;i++){
            if(v[i]-r.pBuy < -1e-9){irV++; if(firsts.length<3) firsts.push(`买方IR破 B${JSON.stringify(tb)} A${JSON.stringify(ta)}`);}
            if(r.pSell-c[i] < -1e-9){irV++; if(firsts.length<3) firsts.push(`卖方IR破 B${JSON.stringify(tb)} A${JSON.stringify(ta)}`);}
          }
          // DSIC
          for (let i=0;i<m;i++){ const base=util(tb,ta,"b",i,tb[i]);
            for(const rep of grid){ if(rep===tb[i])continue;
              if(util(tb,ta,"b",i,rep)>base+1e-9){viol++; if(firsts.length<3) firsts.push(`买方${i}真${tb[i]}报${rep} ${base}->${util(tb,ta,"b",i,rep)} B${JSON.stringify(tb)} A${JSON.stringify(ta)}`);} } }
          for (let i=0;i<n;i++){ const base=util(tb,ta,"a",i,ta[i]);
            for(const rep of grid){ if(rep===ta[i])continue;
              if(util(tb,ta,"a",i,rep)>base+1e-9){viol++; if(firsts.length<3) firsts.push(`卖方${i}真${ta[i]}报${rep} ${base}->${util(tb,ta,"a",i,rep)} B${JSON.stringify(tb)} A${JSON.stringify(ta)}`);} } }
        }
  console.log(`${name}: 情形=${cases} DSIC违反=${viol} IR违反=${irV} BB违反=${bbV} 效率损失>1=${effV} 最大损失笔数=${maxLoss}`);
  firsts.forEach(f=>console.log(`   -> ${f}`));
}

run("网格{1..6} m,n<=3", [1,2,3,4,5,6], 3, 3);
run("网格{0,1,2,3,4} 含0值 m,n<=3", [0,1,2,3,4], 3, 3);
run("网格{1,2,2,3,3,4} 重价 m,n<=3", [1,2,2,3,3,4], 3, 3);
run("网格{1..5} m,n<=4", [1,2,3,4,5], 4, 4);