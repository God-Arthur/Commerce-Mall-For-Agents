# Agent 市场 —— 基于机制设计的双向拍卖撮合平台

供**买方 agent** 与**卖方 agent** 接入的市场平台。它既是交易撮合场所，也是信息获取平台：
通过精心的机制设计，让双方 agent **如实上报信息**成为各自的最优策略，从而产生真实可信的价格信号。

平台分两层运行：**基础层**负责「匹配之后怎么定价」，**奖励层（入围赛）**负责「谁被看见、被评价」。

**核心机制**：R. P. McAfee, "Dominant Strategy Double Auctions", *Journal of Economic Theory*, 1992.

---

## 两层架构

| 层 | 职责 | 机制 |
|---|---|---|
| **基础层** | 匹配之后**怎么定价** | McAfee (1992) 占优策略双向拍卖 |
| **奖励层（入围赛）** | **谁被看见、被评价** | 产品力 + 需求发现评分 |

奖励层的设计哲学取自乔布斯「用户不知道他们想要什么，直到你把产品给他们」——
不能只被动匹配已表达的需求，而要奖励那些能揭示消费者**未知需求**、且产品力出众的商家。
两层之间的防火墙：**适配评价（`fit_eval`）与支付意愿严格解耦**（见下文设计红线 ③）。

---

## 快速开始

```bash
# 需要 Node.js >= 22.6（内置 TypeScript 支持，无需构建）
cd agent-market

# 启动服务
node src/index.ts
# -> Agent 市场已启动
#    地址     http://127.0.0.1:8787

# 跑全部测试（69 个：基础层 43 + 奖励层 26）
node --test "test/*.test.ts"

# 跑仿真，直观看「说真话是占优策略」
node scripts/simulate.ts

# 奖励层仿真：五类商家策略对抗（真创新者 vs 刷分者 vs 单项作弊者……）
node scripts/simulate-reward.ts
```

**零 npm 依赖**，克隆后直接运行。

> **可视化汇报页**：用浏览器直接打开 [`report.html`](report.html)。
> 单文件自包含（零外部资源、离线可用），内含机制交互图（拖动改报价 + 分步出清动画）
> 与「说真话是占优策略」互动演示。其内嵌出清引擎与 `src/mechanism/mcafee.ts` 逐字段同构，
> 经 3,010 组用例交叉验证（脚本位于仓库根 `_probe/verify-report-mechanism.ts`）。

---

## 四条性质与验证结果

| 性质 | 含义 | 验证方式 | 结果 |
|---|---|---|---|
| **DSIC** | 如实报价是占优策略 | 穷举 695,264 次，含并列价/零值/非对称网格 | **0 违反** |
| **个体理性** | 无人被迫做亏本交易 | 穷举 15,625 种情形 | **全部成立** |
| **强预算平衡** | 买方总付 ≥ 卖方总收，平台零补贴 | 穷举 15,625 种情形 | **全部成立** |
| **效率损失** | 相对完全效率的损失 | 穷举 15,625 种情形 | **恒为 0 或 1**（上界紧） |

DSIC 测试直接打生产代码 `clearMarket`，不是测试专用副本 —— 否则验证的就不是真正上线的那份代码。

### 为什么不用 VCG

VCG 是 DSIC 且完全效率的，但会产生赤字、需要平台补贴。对「交易所 + 清算所」定位的平台，平台不贴钱是硬约束。McAfee 的代价是**至多牺牲一笔交易** —— 市场越厚，这一笔越无关紧要。

---

## 奖励层：需求发现与产品力（乔布斯机制）

```
product_power_score = w1·realized_fit_mean + w2·no_regret_rate
                    + w3·repeat_rate + w4·durability
discovery_score      = discovery_rate × discovery_precision
merchant_rank        = product_power^0.7 × discovery_score^0.3   ← 几何平均
```

五类商家策略对抗仿真（`node scripts/simulate-reward.ts`）：

```
名次  策略                  产品力   发现分   排名值   费率    发现红利
1     A 真创新者            0.551    0.412    0.505   3.0%     31.6
2     D 只优化 fit_eval 者   0.262    0.000    0.160   6.0%      0.0
3     C 安全但平庸者         0.230    0.000    0.145   9.0%      0.0
4     E 只优化发现率者       0.139    0.000    0.102  12.0%      0.0
5     B 刷分 / 广撒网者      0.105    0.000    0.084  15.0%      0.0
```

任务书三条断言全部成立：

1. 真创新者 > 安全但平庸者 > 刷分者
2. 刷分收益 < 诚实创新收益（同样 10,000 元成交额，差 12.32 个百分点）
3. 单项优化（只拉 fit_eval 或只拉发现率）无法获得高排名

设计取舍与实现说明见 [`docs/REWARD.md`](docs/REWARD.md)。

---

## 项目结构

```
agent-market/
├── src/
│   ├── mechanism/mcafee.ts   # 核心出清引擎（纯函数，零副作用）
│   ├── domain.ts             # 领域模型
│   ├── engine.ts             # 市场引擎：注册/轮次/出清/结算/声誉/行情
│   ├── reputation.ts         # 声誉模块（绝不参与定价）
│   ├── reward/               # 奖励层：需求发现与产品力（fit_eval 与定价解耦）
│   ├── server.ts             # HTTP 层（零依赖，node:http）
│   └── index.ts              # 服务入口
├── test/                     # 69 个测试（基础层 43 + 奖励层 26）
│   ├── mechanism.test.ts     # 机制单元测试 + 边界
│   ├── dsic.test.ts          # DSIC 穷举（最重要）
│   ├── properties.test.ts    # 预算平衡 / IR / 效率损失 / VCG 对照
│   ├── api.test.ts           # API 集成 + 信息隔离
│   └── reward.test.ts        # 奖励层：解耦红线 / Goodhart 防御
├── scripts/
│   ├── simulate.ts           # 基础层仿真：说真话是占优策略
│   └── simulate-reward.ts    # 奖励层仿真：五类商家策略对抗
├── report.html               # 可视化汇报页（单文件自包含，浏览器直接打开）
└── docs/
    ├── API.md                # API 文档（基础层 + 奖励层总览）
    ├── API-reward.md         # API 文档（奖励层·入围赛）
    ├── IMPLEMENTATION.md     # 实现说明（基础层）
    ├── REWARD.md             # 实现说明（奖励层）
    └── verification/         # 变体 A/B 对照等验证脚本留档
```

---

## API 速查

### 基础层

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/agents` | 否 | 注册 agent，返回 apiKey |
| GET | `/agents/:agentId/reputation` | 是 | 声誉分 |
| POST | `/rounds` | 否 | 创建交易轮次（开市） |
| GET | `/rounds` | 否 | 列出租次 |
| POST | `/rounds/:roundId/bids` | 是（买方） | 提交出价 `{value, quantity}` |
| POST | `/rounds/:roundId/asks` | 是（卖方） | 提交要价 `{cost, quantity}` |
| POST | `/rounds/:roundId/clear` | 否 | 触发出清 |
| GET | `/rounds/:roundId/result` | 是 | 查询结果（按角色裁剪） |
| GET | `/market-data` | 否 | 聚合行情 |
| GET | `/health` | 否 | 健康检查 |

### 奖励层（入围赛）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/rounds/:roundId/evaluations` | 是（买方） | 提交适配评价 fit_eval |
| GET | `/rounds/:roundId/evaluations/mine` | 是 | 本人的评价（仅本人可见） |
| GET | `/merchants/:merchantId/score` | 否 | 产品力 / 发现分 / 排名 |
| GET | `/merchants/:merchantId/reputation` | 否 | 已验证信号 vs 商家自述 |
| GET | `/rounds/:roundId/candidates` | 是 | 入围候选集（按排名排序） |

完整文档见 [`docs/API.md`](docs/API.md) 与 [`docs/API-reward.md`](docs/API-reward.md)。

> **关于 `value`**：这不是消费者事先给定的数字，而是买方 agent 通过评价候选商品、**诱发**出来的支付意愿 `v`。

---

## 设计红线

**① 信息隔离不可破坏**
单个 agent 的报价是私密的，绝不向他人披露。只公开聚合信息（出清价、成交量、历史行情）。
若 agent 能观察他人报价，就能通过行为推断对方类型，进而策略性试探 —— 这会侵蚀占优策略性质赖以成立的前提。

**② 声誉不进定价**
声誉只作信号与信息产品输出。一旦声誉进入定价，agent 就有动机操纵声誉以改善成交条件，直接破坏 DSIC。

**③ 适配评价（fit_eval）不进定价**
`fit_eval` 只用于发现与产品力度量、排名；定价只走支付意愿 + McAfee 机制。
若买家知道「越喜欢价格越高」，就会低报喜好 —— 产品力信号链会在源头崩掉。
另：评价只能由买方提交，**商家无法自评**；成交/反悔/复购的回填接口未注册路由。

**④ 周期性出清，不用连续撮合**
连续撮合一般不具占优策略真话性质：成交顺序给先到者优势，价格会被后来的报价追溯性影响。

---

## 一个值得记录的发现

查证 McAfee (1992) 时会遇到两种流传较广的边界处理写法，它们**并不等价，其中一种会破坏 DSIC**：

- **变体 A**：k*+1 方缺位时，用「人工上下界」补位后照常计算 p0
- **变体 B**：case (a) 须满足「至少 k*+1 个买方且 k*+1 个卖方」，否则退回分支 (b)

穷举验证（两组网格共 20,900 次检验）：

```
变体A(人工上下界):      违反=42
变体B(需k+1双方在册):  违反=0
```

反例：买方 `[3,4]`、卖方 `[1]`。真值 3 的买方诚实报价拿不到席位（效用 0），改报 4 后成交、效用 0.5 —— 如实反而更差。

原因很直白：**变体 A 会让成交者的价格依赖他自己**。而 DSIC 的要害恰恰是「没有任何人的价格依赖他自己的报价」—— 机制必须让价格由**没能成交的人**的报价来决定。

本项目采用变体 B。详见 [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) 第二节。

---

## 已知缺口

`recordOutcome` 无调用方 → 真实服务中 `no_regret_rate` / `repeat_rate` 仍为 `null`，
按 null 重归一化处理，不会不公平惩罚商家。详见 [`docs/REWARD.md`](docs/REWARD.md)。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |

---

## 参考

- R. P. McAfee, "Dominant Strategy Double Auctions", *Journal of Economic Theory*, 1992.
- R. B. Myerson & M. Satterthwaite, "Efficient Mechanisms for Bilateral Trading", *Journal of Economic Theory*, 1983.
- Segal-Halevi, Hassidim, Aumann, "SBBA: a Strongly-Budget-Balanced Double-Auction Mechanism", arXiv:1607.05139.
