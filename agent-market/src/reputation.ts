/**
 * 声誉模块
 *
 * 重要设计约束：声誉分**绝不参与同一轮内的定价**。
 * 一旦让声誉进入定价，agent 就有动机去操纵声誉以改善成交条件，
 * 这会直接破坏 McAfee 机制的 DSIC —— 那是本平台的立身之本。
 * 因此声誉只作为「信息产品」和「下一轮的信号」输出。
 */
import type { FulfillmentRecord, Reputation } from "./domain.ts";

export class ReputationService {
  private records: FulfillmentRecord[] = [];

  record(rec: FulfillmentRecord): void {
    this.records.push(rec);
  }

  /** 某 agent 的全部履约记录。 */
  history(agentId: string): FulfillmentRecord[] {
    return this.records.filter((r) => r.agentId === agentId);
  }

  /**
   * 声誉分：履约加权得分，归一化到 [0,1]。
   * 权重 = log(1+成交额)，让大额履约更重要但不至于被单笔绑架。
   * 无履约记录时返回 0.5（中性，不奖不罚，避免冷启动被歧视）。
   */
  score(agentId: string): Reputation {
    const mine = this.records.filter((r) => r.agentId === agentId);
    if (mine.length === 0) {
      return { agentId, score: 0.5, totalFulfilled: 0, totalBreached: 0, notional: 0 };
    }
    let wSum = 0;
    let wOk = 0;
    let ok = 0;
    let bad = 0;
    let notional = 0;
    for (const r of mine) {
      const w = Math.log(1 + Math.max(0, r.notional));
      wSum += w;
      notional += r.notional;
      if (r.fulfilled) { wOk += w; ok++; } else { bad++; }
    }
    const score = wSum === 0 ? (ok > 0 ? 1 : 0) : wOk / wSum;
    return { agentId, score, totalFulfilled: ok, totalBreached: bad, notional };
  }
}