/**
 * McAfee (1992) 占优策略双向拍卖 —— 核心出清引擎
 *
 * 出处：R. P. McAfee, "Dominant Strategy Double Auctions",
 *      Journal of Economic Theory, 1992.
 *
 * ─────────────────────────────────────────────────────────────────────
 * 机制规格
 * ─────────────────────────────────────────────────────────────────────
 * 采用周期性出清（call market）：一轮内收集全部报价，轮末统一撮合。
 *
 * 设 m 个买方出价降序排列 v_(1) >= v_(2) >= ... >= v_(m)，
 *    n 个卖方要价升序排列 c_(1) <= c_(2) <= ... <= c_(n)。
 *
 * 1. 有效数量 k* := max { i : v_(i) >= c_(i) }，即完全效率下的成交笔数。
 *    若 k* = 0，本轮无成交。
 *
 * 2. 分支判定：
 *    (a) 若"至少存在 k*+1 个买方"且"至少存在 k*+1 个卖方"
 *        （否则 v_(k*+1) 或 c_(k*+1) 不存在，p0 无从定义）：
 *        计算中间价 p0 := ( v_(k*+1) + c_(k*+1) ) / 2。
 *        若 c_(k*) <= p0 <= v_(k*)，则 k* 笔全部按**统一价 p0** 成交。
 *
 *    (b) 否则（中间价落在边际区间之外，或 k*+1 方缺位）：
 *        **牺牲第 k* 笔边际交易**，只成交 k*-1 笔：
 *        前 k*-1 个买方各付 v_(k*)，前 k*-1 个卖方各收 c_(k*)。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么 (b) 要牺牲一笔交易
 * ─────────────────────────────────────────────────────────────────────
 * DSIC 要求「任何人报的价格不依赖于自己的报价」。
 * 分支 (a) 的 p0 依赖 v_(k*+1) 与 c_(k*+1) —— 那是**没能成交**的那个人的报价，
 * 所以成交者的价格与自己的报价无关，激励相容。
 *
 * 但当 k* = m（所有买方都够格）或 k* = n 时，第 k*+1 位根本不存在。
 * 若强行用「人工上界/下界」补位（部分文献转述的写法），
 * 会让**已成交者的报价开始影响成交者的价格**，DSIC 即被破坏。
 * 因此正确的处理是退回分支 (b)：牺牲那笔边际交易，
 * 用「未成交者的边际报价」v_(k*) / c_(k*) 定价 —— 它们同样不属于成交者。
 *
 * 这正是 Myerson–Satterthwaite 定理所要求付出的代价：至多牺牲一笔交易。
 * 该代价已由 test/dsic.test.ts 穷举验证。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 强预算平衡
 * ─────────────────────────────────────────────────────────────────────
 * 分支 (a)：成交 k* 笔，买方总付 k*·p0，卖方总收 k*·p0 —— 恰好相等。
 * 分支 (b)：成交 k*-1 笔，买方总付 (k*-1)·v_(k*)，卖方总收 (k*-1)·c_(k*)。
 *           由 k* 的定义 v_(k*) >= c_(k*)，故买方总付 >= 卖方总收。
 *           平台无需贴钱，多出的价差归平台所有（市场MakerSpread）。
 */

/** 单个买方的报价（value 为支付意愿，即由评价过程诱发出的 v）。 */
export interface BuyerBid {
  agentId: string;
  value: number;
  quantity: number;
}

/** 单个卖方的要价（cost 为真实成本 c）。 */
export interface SellerAsk {
  agentId: string;
  cost: number;
  quantity: number;
}

/** 一笔成交记录。 */
export interface Fill {
  buyerAgentId: string;
  sellerAgentId: string;
  /** 数量。数量不匹配时按比例拆分。 */
  quantity: number;
  /** 买方支付的**每单位**价格。 */
  buyerPrice: number;
  /** 卖方收到的**每单位**价格。分支 (b) 时低于 buyerPrice。 */
  sellerPrice: number;
}

/** 出清结果。 */
export interface ClearingResult {
  /** 完全效率下的成交笔数。 */
  efficientQuantity: number;
  /** 实际成交量（按 quantity 计）。分支 (b) 时少于完全效率。 */
  tradedQuantity: number;
  /** 实际成交笔数（参与成交的 agent 对数）。 */
  tradeCount: number;
  /** 分支标识。 */
  branch: "a" | "b" | "none";
  /** 成交明细。 */
  fills: Fill[];
  /** 买方付出的每单位统一价（分支 a）；无成交时为 null。 */
  clearingPriceBuyer: number | null;
  /** 卖方收到的每单位统一价（分支 a）；无成交时为 null。 */
  clearingPriceSeller: number | null;
  /** 相对完全效率损失的成交笔数，恒为 0 或 1。 */
  efficiencyLoss: number;
}

/** 报价条目在排序后的内部表示。 */
interface Ranked<T> {
  agentId: string;
  price: number;
  quantity: number;
  /** 并列价时的稳定次序，保证结果可复现。 */
  tieBreak: number;
}

/** 对输入做合法性校验。机制的正确性依赖输入合法，因此这里必须严格。 */
function validateQuotes(quotes: Array<{ value?: number; cost?: number; quantity?: number }>): void {
  for (const q of quotes) {
    const price = q.value ?? q.cost;
    if (typeof price !== "number" || !Number.isFinite(price)) {
      throw new TypeError(`报价必须是有限数值，收到：${String(price)}`);
    }
    if (typeof q.quantity !== "number" || !Number.isInteger(q.quantity) || q.quantity <= 0) {
      throw new TypeError(`数量必须是正整数，收到：${String(q.quantity)}`);
    }
  }
}

/**
 * 核心：McAfee 出清。
 *
 * 数量处理的说明：
 * McAfee (1992) 原文针对「单位需求、单位供给」。本实现支持多数量，
 * 做法是把每个报价视为 quantity 个同价单位，排序后按名次分配：
 * 名次第 i 的买方获得至多 quantity 个单位，累计到 tradedQuantity 为止。
 * 这样每个**单位**都严格遵循单位级 McAfee 规则，
 * 且按单位计算的 DSIC / IR / 预算平衡 / 效率损失性质逐单位成立。
 */
export function clearMarket(
  bids: BuyerBid[],
  asks: SellerAsk[]
): ClearingResult {
  validateQuotes(bids);
  validateQuotes(asks);

  const empty: ClearingResult = {
    efficientQuantity: 0,
    tradedQuantity: 0,
    tradeCount: 0,
    branch: "none",
    fills: [],
    clearingPriceBuyer: null,
    clearingPriceSeller: null,
    efficiencyLoss: 0,
  };
  if (bids.length === 0 || asks.length === 0) return empty;

  // 1) 排序：买方降序，卖方升序。同价时按 agentId 字典序，保证确定性。
  const vb: Ranked<BuyerBid>[] = bids
    .map((b, i) => ({ agentId: b.agentId, price: b.value, quantity: b.quantity, tieBreak: i }))
    .sort((x, y) => (y.price - x.price) || x.agentId.localeCompare(y.agentId));
  const sa: Ranked<SellerAsk>[] = asks
    .map((a, i) => ({ agentId: a.agentId, price: a.cost, quantity: a.quantity, tieBreak: i }))
    .sort((x, y) => (x.price - y.price) || x.agentId.localeCompare(y.agentId));

  // 2) 有效数量 k*：满足 v_(k) >= c_(k) 的最大 k。
  //    按「对等单位数」推进，任一方供应耗尽即停。
  const units: Ranked<BuyerBid>[] = [];
  for (const b of vb) for (let i = 0; i < b.quantity; i++) units.push(b);
  const sunits: Ranked<SellerAsk>[] = [];
  for (const a of sa) for (let i = 0; i < a.quantity; i++) sunits.push(a);

  let k = 0;
  const kMax = Math.min(units.length, sunits.length);
  while (k < kMax && units[k].price >= sunits[k].price) k++;
  const efficientQuantity = k;

  if (k === 0) return empty;

  // 3) 分支判定
  const vKm1 = units[k];          // v_(k+1)：第 k+1 高买价
  const cKm1 = sunits[k];         // c_(k+1)：第 k+1 低卖价
  const canUseBreakeven = k < units.length && k < sunits.length;

  let buyerPrice: number;
  let sellerPrice: number;
  let tradedUnits: number;
  let branch: "a" | "b";

  if (canUseBreakeven) {
    const p0 = (vKm1.price + cKm1.price) / 2;
    if (sunits[k - 1].price <= p0 && p0 <= units[k - 1].price) {
      buyerPrice = p0;
      sellerPrice = p0;
      tradedUnits = k;
      branch = "a";
    } else {
      buyerPrice = units[k - 1].price;   // v_(k)
      sellerPrice = sunits[k - 1].price;  // c_(k)
      tradedUnits = k - 1;
      branch = "b";
    }
  } else {
    // k+1 方缺位：必须牺牲边际交易，才能保持「成交者的价格与自己的报价无关」
    buyerPrice = units[k - 1].price;
    sellerPrice = sunits[k - 1].price;
    tradedUnits = k - 1;
    branch = "b";
  }

  // 分支 (b) 且 k* = 1 时，牺牲后成交 0 笔。
  // 这与「k* = 0 本就无有效交易」是不同情形：
  // 前者说明机制确实识别出了一笔有效交易并为保持 DSIC 主动放弃它，
  // 该信息对上层（效率损失统计、行情）有意义，因此保留 branch 标记。
  if (tradedUnits <= 0) {
    return {
      efficientQuantity,
      tradedQuantity: 0,
      tradeCount: 0,
      branch,
      fills: [],
      clearingPriceBuyer: null,
      clearingPriceSeller: null,
      efficiencyLoss: efficientQuantity,
    };
  }

  // 4) 分配：买方名次靠前者优先，卖方名次靠前者优先，逐单位配对。
  const fills = assignFills(units, sunits, tradedUnits, buyerPrice, sellerPrice);

  return {
    efficientQuantity,
    tradedQuantity: tradedUnits,
    tradeCount: fills.length,
    branch,
    fills,
    clearingPriceBuyer: buyerPrice,
    clearingPriceSeller: sellerPrice,
    efficiencyLoss: efficientQuantity - tradedUnits,
  };
}

/**
 * 把 tradedUnits 个单位配对成成交记录。
 * 同一 agent 的连续单位会合并为一条 Fill，减少返回体积。
 */
function assignFills(
  units: Ranked<BuyerBid>[],
  sunits: Ranked<SellerAsk>[],
  tradedUnits: number,
  buyerPrice: number,
  sellerPrice: number
): Fill[] {
  const fills: Fill[] = [];
  let bi = 0;
  let si = 0;
  let remaining = tradedUnits;

  // 各自记录已分配给该 agent 的数量，用于判断库存是否耗尽
  const bUsed = new Map<number, number>();
  const sUsed = new Map<number, number>();

  while (remaining > 0) {
    const b = units[bi];
    const s = sunits[si];
    const bDone = bUsed.get(b.tieBreak) ?? 0;
    const sDone = sUsed.get(s.tieBreak) ?? 0;
    if (bDone >= b.quantity) { bi++; continue; }
    if (sDone >= s.quantity) { si++; continue; }

    const chunk = Math.min(b.quantity - bDone, s.quantity - sDone, remaining);
    const last = fills[fills.length - 1];
    if (
      last &&
      last.buyerAgentId === b.agentId &&
      last.sellerAgentId === s.agentId &&
      last.buyerPrice === buyerPrice &&
      last.sellerPrice === sellerPrice
    ) {
      last.quantity += chunk;
    } else {
      fills.push({
        buyerAgentId: b.agentId,
        sellerAgentId: s.agentId,
        quantity: chunk,
        buyerPrice,
        sellerPrice,
      });
    }
    bUsed.set(b.tieBreak, bDone + chunk);
    sUsed.set(s.tieBreak, sDone + chunk);
    remaining -= chunk;
  }
  return fills;
}