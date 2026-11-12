/**
 * 把价格表诱发的保留价写入本轮出价。
 *
 * 这里只碰基础层的报价簿。适配评价不经过本模块。
 */
import { MarketEngine, MarketError } from "../engine.ts";
import type { Agent } from "../domain.ts";
import { ElicitationError, elicitReservation } from "./price-list.ts";

export interface ElicitationResult {
  roundId: string;
  elicitedValue: number | null;
  bidSubmitted: boolean;
  note: string;
}

export function submitPriceList(
  engine: MarketEngine,
  roundId: string,
  buyer: Agent,
  priceList: unknown,
  quantity = 1,
): ElicitationResult {
  if (buyer.role !== "buyer") {
    throw new MarketError(403, "只有买方 agent 可以用价格表诱发出价", "ROLE_MISMATCH");
  }

  let reservation: number | null;
  try {
    reservation = elicitReservation(priceList);
  } catch (err) {
    if (err instanceof ElicitationError) {
      throw new MarketError(400, err.message, err.code);
    }
    throw err;
  }

  if (reservation === null) {
    engine.withdrawQuote(roundId, buyer);
    return {
      roundId,
      elicitedValue: null,
      bidSubmitted: false,
      note: "价格表上没有任何可接受的价格，本轮不提交出价。诱发过程不读取 fit_eval。",
    };
  }

  engine.submitBid(roundId, buyer, reservation, quantity);
  return {
    roundId,
    elicitedValue: reservation,
    bidSubmitted: true,
    note: "出价等于价格表上的最高可接受价格。该计算不读取 fit_eval，适配评价不进入定价。",
  };
}
