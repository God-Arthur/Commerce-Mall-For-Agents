/**
 * 价格表诱发支付意愿。
 *
 * 消费者不直接报一个「策略性价格」，只对一组标价回答买或不买。
 * 诱发值 = 被接受的最高价格。这个函数的参数里没有 fit_eval：
 * 适配评价走另一条通道，不能参与这里的计算。
 *
 * 单调性：接受了某个价格，就必须接受所有更低的价格。
 * 不单调的回答不是一个自洽的保留价，直接拒绝。
 */

export interface PriceListRow {
  price: number;
  accept: boolean;
}

export class ElicitationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 从价格表诱发保留价。
 * 没有任何可接受价格时返回 null，表示本轮不进入拍卖。
 */
export function elicitReservation(rows: unknown): number | null {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ElicitationError("EMPTY_PRICE_LIST", "价格表不能为空");
  }

  const parsed: PriceListRow[] = rows.map((row, i) => {
    if (row === null || typeof row !== "object") {
      throw new ElicitationError("INVALID_PRICE_LIST", `第 ${i} 行不是对象`);
    }
    const price = (row as { price?: unknown }).price;
    const accept = (row as { accept?: unknown }).accept;
    if (typeof price !== "number" || !Number.isFinite(price)) {
      throw new ElicitationError("INVALID_PRICE", `第 ${i} 行价格不是有限数值`);
    }
    if (price < 0) {
      throw new ElicitationError("INVALID_PRICE", `第 ${i} 行价格不能为负`);
    }
    if (typeof accept !== "boolean") {
      throw new ElicitationError("INVALID_ACCEPT", `第 ${i} 行 accept 必须是布尔值`);
    }
    return { price, accept };
  });

  const sorted = [...parsed].sort((a, b) => a.price - b.price);
  const unique: PriceListRow[] = [];
  for (const row of sorted) {
    const last = unique[unique.length - 1];
    if (last && last.price === row.price) {
      if (last.accept !== row.accept) {
        throw new ElicitationError(
          "INCONSISTENT_PRICE_LIST",
          `价格 ${row.price} 的接受与否互相矛盾`,
        );
      }
      continue;
    }
    unique.push(row);
  }

  let seenReject = false;
  for (const row of unique) {
    if (seenReject && row.accept) {
      throw new ElicitationError(
        "NON_MONOTONE",
        `价格表不单调：拒绝了更低的价格后又接受了 ${row.price}`,
      );
    }
    if (!row.accept) seenReject = true;
  }

  let best: number | null = null;
  for (const row of unique) {
    if (row.accept) best = row.price;
  }
  return best;
}

/** 真实保留价 v 在给定网格上的诚实回答：价格不超过 v 就接受。 */
export function answersForValue(trueValue: number, grid: readonly number[]): PriceListRow[] {
  return grid.map((price) => ({ price, accept: trueValue >= price }));
}
