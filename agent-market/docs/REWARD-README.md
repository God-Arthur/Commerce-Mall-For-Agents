# 奖励层速览（存档）

> **已归档**：主 [README.md](../README.md) 现已完整覆盖两层（架构 / 命令 / 端点 / 红线 / 仿真结果）。
> 本文档保留作为历史记录；奖励层详细设计见 [REWARD.md](REWARD.md)，API 细节见 [API-reward.md](API-reward.md)。

## 新增命令

```bash
node scripts/simulate-reward.ts   # 五类商家策略对抗仿真
node --test "test/*.test.ts"      # 全部 69 个测试（基础层 43 + 奖励层 26）
```

## 两层架构

| 层 | 职责 | 机制 |
|---|---|---|
| 基础层 | 匹配之后**怎么定价** | McAfee (1992) 占优策略双向拍卖 |
| **奖励层** | **谁被看见、被评价**（入围赛） | 产品力 + 需求发现评分 |

## 仿真结果

```
名次  策略                  产品力   发现分   排名值   费率    发现红利
1     A 真创新者            0.551    0.412    0.505   3.0%     31.6
2     D 只优化 fit_eval 者    0.262    0.000    0.160   6.0%      0.0
3     C 安全但平庸者        0.230    0.000    0.145   9.0%      0.0
4     E 只优化发现率者      0.139    0.000    0.102  12.0%      0.0
5     B 刷分 / 广撒网者     0.105    0.000    0.084  15.0%      0.0
```

任务书三条断言全部成立：
1. 真创新者 > 安全但平庸者 > 刷分者
2. 刷分收益 < 诚实创新收益（同样 10000 元成交额，差 12.32 个百分点）
3. 单项优化无法获得高排名

## 新增端点

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/rounds/:roundId/evaluations` | 是（买方） |
| GET | `/rounds/:roundId/evaluations/mine` | 是 |
| GET | `/merchants/:merchantId/score` | 否 |
| GET | `/merchants/:merchantId/reputation` | 否 |
| GET | `/rounds/:roundId/candidates` | 是 |

详见 `docs/API-reward.md`。

## 两条新红线

**适配评价绝不进定价。** `fit_eval` 只用于发现与产品力度量、排名；
定价只走支付意愿 + McAfee 机制。若买家知道「越喜欢价格越高」就会低报喜好，信号链会崩。

**商家无法自评。** 评价只能由买方提交；成交/反悔/复购的回填接口未注册路由。

## 已知缺口

`recordOutcome` 无调用方 → 真实服务中 `no_regret_rate` / `repeat_rate` 仍为 `null`，
按 null 重归一化处理，不会不公平惩罚商家。

详细设计取舍与实现说明见 `docs/REWARD.md`。
