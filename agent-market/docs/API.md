# Agent 市场 —— API 文档

基于 **McAfee (1992) 占优策略双向拍卖**的 agent 撮合平台。
所有请求/响应均为 JSON。鉴权通过 `X-API-Key` 请求头。

---

## 端点总览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/agents` | 否 | 注册 agent，返回 apiKey |
| GET | `/agents/:agentId/reputation` | 是 | 查询声誉分 |
| POST | `/rounds` | 否 | 创建交易轮次（开市） |
| GET | `/rounds` | 否 | 列出租次 |
| POST | `/rounds/:roundId/bids` | 是（买方） | 提交出价 |
| POST | `/rounds/:roundId/asks` | 是（卖方） | 提交要价 |
| POST | `/rounds/:roundId/clear` | 否 | 触发本轮出清 |
| GET | `/rounds/:roundId/result` | 是 | 查询本轮结果（按角色裁剪） |
| GET | `/market-data` | 否 | 聚合行情 |
| GET | `/health` | 否 | 健康检查 |

### 奖励层（入围赛）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/rounds/:roundId/evaluations` | 是（买方） | 提交适配评价 |
| GET | `/rounds/:roundId/evaluations/mine` | 是 | 本人的评价（仅本人可见） |
| GET | `/merchants/:merchantId/score` | 否 | 产品力 / 发现分 / 排名 |
| GET | `/merchants/:merchantId/reputation` | 否 | 已验证信号 vs 商家自述 |
| GET | `/rounds/:roundId/candidates` | 是 | 入围候选集（按排名排序） |

---

## 1. 注册 agent

### `POST /agents`

**请求**
```json
{ "role": "buyer", "name": "buyer-alpha" }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `role` | `"buyer" \| "seller"` | 角色 |
| `name` | string | 名称，非空 |

**响应 200**
```json
{
  "agentId": "ag_1a2b3c4d",
  "role": "buyer",
  "name": "buyer-alpha",
  "apiKey": "sk_9f8e7d6c...",
  "createdAt": 1791704366629,
  "note": "妥善保管 apiKey，后续请求通过 X-API-Key 头携带"
}
```

**错误**
- `400 INVALID_ROLE` — role 不是 buyer/seller
- `400 INVALID_NAME` — name 为空

---

## 2. 创建交易轮次

### `POST /rounds`

创建轮次是市场运营方（开市）的动作，不要求 apiKey。

**请求**
```json
{ "roundId": "r2026-10-11-am" }
```
`roundId` 可省略，省略时自动生成。

**响应 200**
```json
{ "roundId": "r2026-10-11-am", "status": "open", "openedAt": 1791704366629 }
```

**错误**：`409 ROUND_EXISTS` — 同名轮次已存在

### `GET /rounds`
```json
[{ "roundId": "r2026-10-11-am", "status": "open", "openedAt": 1791704366629 }]
```

---

## 3. 提交报价

### `POST /rounds/:roundId/bids` （买方）

> **`value` 的语义**：这不是消费者事先给定的数字，而是买方 agent 通过评价候选商品、**诱发**出来的支付意愿 `v`。这是「消费者只能给出需求评价」这一前提的直接产物。

**请求头**：`X-API-Key: sk_...`
**请求体**
```json
{ "value": 42.5, "quantity": 2 }
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `value` | number | 有限数，>= 0 |
| `quantity` | integer | > 0，缺省 1 |

**响应 200**
```json
{ "accepted": true, "roundId": "r2026-10-11-am", "quantity": 2 }
```

**错误**
- `401 UNAUTHORIZED` — 缺少或无效 apiKey
- `403 ROLE_MISMATCH` — 非买方提交出价
- `400 INVALID_PRICE` — value 非法
- `400 INVALID_QUANTITY` — quantity 非正整数
- `409 ROUND_CLOSED` — 轮次已出清

### `POST /rounds/:roundId/asks` （卖方）

**请求体**
```json
{ "cost": 30, "quantity": 3 }
```

错误同上（`403` 适用于买方提交要价）。

> 同一 agent 在同一轮**重复提交 = 覆盖**，不累加。agent 可据此修改报价。

---

## 4. 触发出清

### `POST /rounds/:roundId/clear`

按 McAfee 机制统一撮合本轮全部报价。

**响应 200**
```json
{
  "roundId": "r2026-10-11-am",
  "efficientQuantity": 2,
  "tradedQuantity": 1,
  "tradeCount": 1,
  "branch": "b",
  "clearingPriceBuyer": 26,
  "clearingPriceSeller": 17,
  "efficiencyLoss": 1,
  "platformSpread": 9,
  "settlements": [
    {
      "buyerAgentId": "ag_xxxx",
      "sellerAgentId": "ag_yyyy",
      "quantity": 1,
      "buyerPays": 26,
      "sellerReceives": 17,
      "status": "settled"
    }
  ],
  "clearedAt": 1791704366700
}
```

| 字段 | 说明 |
|---|---|
| `efficientQuantity` | 完全效率下的成交笔数 `k*` |
| `tradedQuantity` | 实际成交量 |
| `branch` | `"a"` 统一价全额成交 / `"b"` 牺牲边际笔、双边定价 / `"none"` 无有效交易 |
| `clearingPriceBuyer` | 买方每单位支付价；无成交时为 `null` |
| `clearingPriceSeller` | 卖方每单位收取价；无成交时为 `null` |
| `efficiencyLoss` | 相对完全效率损失的笔数，恒为 0 或 1 |
| `platformSpread` | 平台留存的价差 |

**错误**：`409 ALREADY_CLEARED`、`404 ROUND_NOT_FOUND`

---

## 5. 查询本轮结果

### `GET /rounds/:roundId/result`

**必须鉴权**，且响应**按调用者角色裁剪**。

**响应 200**
```json
{
  "roundId": "r2026-10-11-am",
  "status": "cleared",
  "myQuotes": { "agentId": "ag_xxxx", "price": 30, "quantity": 2, "submittedAt": 1791704366600 },
  "aggregate": {
    "clearingPriceBuyer": 26,
    "clearingPriceSeller": 17,
    "tradedQuantity": 1,
    "tradeCount": 1,
    "efficiencyLoss": 1
  },
  "myTrades": [
    {
      "quantity": 1,
      "counterpartyAgentId": "ag_yyyy",
      "pricePerUnit": 26,
      "amount": 26
    }
  ],
  "traded": true,
  "myQuantity": 1
}
```

> **信息隔离**：该响应只包含**本 agent 的报价与成交**，以及**全场聚合口径**。
> 其他 agent 的具体报价绝不出现在响应中。理由见实现说明第七节。

---

## 6. 聚合行情

### `GET /market-data`

不对应任何单个 agent 的私有信息，可自由访问。

**响应 200**
```json
{
  "rounds": [
    { "roundId": "r1", "clearingPrice": 26, "tradedQuantity": 1, "tradeCount": 1, "spread": 9, "clearedAt": 1791704366700 }
  ],
  "totalRounds": 3,
  "totalTraded": 42,
  "avgClearingPrice": 25.33,
  "lastClearingPrice": 24,
  "priceSeries": [{ "roundId": "r1", "price": 26 }],
  "volumeSeries": [{ "roundId": "r1", "quantity": 1 }]
}
```

---

## 7. 声誉分

### `GET /agents/:agentId/reputation`

**响应 200**
```json
{
  "agentId": "ag_xxxx",
  "score": 0.87,
  "totalFulfilled": 12,
  "totalBreached": 0,
  "notional": 3450,
  "note": "reputation is informational only; it never affects pricing within a round (DSIC 保护)"
}
```

- `score` ∈ [0,1]，履约加权（`log(1+成交额)` 权重），无记录时为中性 `0.5`
- **声誉分不参与任何一轮的定价**，仅作信号与信息产品输出

**错误**：`404 AGENT_NOT_FOUND`

---

## 8. 错误响应格式

所有错误统一为：
```json
{ "error": { "code": "MACHINE_CODE", "message": "人类可读说明" } }
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `INVALID_ROLE` / `INVALID_NAME` | 注册参数非法 |
| 400 | `INVALID_PRICE` / `INVALID_QUANTITY` | 报价参数非法 |
| 400 | `INVALID_INPUT` | 请求体非合法 JSON 或过大 |
| 401 | `UNAUTHORIZED` | apiKey 缺失或无效 |
| 403 | `ROLE_MISMATCH` | 角色越权 |
| 404 | `ROUND_NOT_FOUND` / `AGENT_NOT_FOUND` | 资源不存在 |
| 404 | `ROUTE_NOT_FOUND` | 路由不存在 |
| 409 | `ROUND_CLOSED` / `ALREADY_CLEARED` / `ROUND_EXISTS` | 轮次状态冲突 |

---

## 典型调用序列

```bash
# 1. 注册买卖双方
curl -X POST localhost:8787/agents -H 'content-type: application/json' \
  -d '{"role":"buyer","name":"b1"}'
curl -X POST localhost:8787/agents -H 'content-type: application/json' \
  -d '{"role":"seller","name":"s1"}'

# 2. 开市
curl -X POST localhost:8787/rounds -H 'content-type: application/json' \
  -d '{"roundId":"r1"}'

# 3. 报价
curl -X POST localhost:8787/rounds/r1/bids -H 'content-type: application/json' \
  -H 'x-api-key: sk_...' -d '{"value":30,"quantity":1}'
curl -X POST localhost:8787/rounds/r1/asks -H 'content-type: application/json' \
  -H 'x-api-key: sk_...' -d '{"cost":20,"quantity":1}'

# 4. 出清
curl -X POST localhost:8787/rounds/r1/clear

# 5. 各方查结果（只看得到自己的成交 + 聚合数据）
curl localhost:8787/rounds/r1/result -H 'x-api-key: sk_...'

# 6. 看行情
curl localhost:8787/market-data
```