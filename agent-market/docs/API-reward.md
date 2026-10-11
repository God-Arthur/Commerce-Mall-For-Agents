# 奖励层 API 补充

> 本文档补充 `docs/API.md` 中奖励层（入围赛）的端点。基础层端点请见 `docs/API.md`。

## 为什么需要这一层

基础层（McAfee 双向拍卖）管「匹配之后怎么定价」；奖励层管「**谁被看见、被评价**」，即概念模型中的「入围赛」。

## 设计红线

> **适配评价（fit_eval）与支付意愿严格解耦。**

若买家知道「越喜欢，价格越高」，就会低报喜好，导致产品力信号链崩掉。因此：

- `fit_eval` → 只用于**发现与产品力度量、排名**
- 定价 → 只走**基础层的支付意愿 + McAfee 机制**

本层代码不读取也不修改任何价格字段。

---

### 奖励层（入围赛）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/rounds/:roundId/evaluations` | 是（买方） | 提交适配评价 |
| GET | `/rounds/:roundId/evaluations/mine` | 是 | 本人的评价（仅本人可见） |
| GET | `/merchants/:merchantId/score` | 否 | 产品力 / 发现分 / 排名 |
| GET | `/merchants/:merchantId/reputation` | 否 | 已验证信号 vs 商家自述 |
| GET | `/rounds/:roundId/candidates` | 是 | 入围候选集（按排名排序） |

---

## 1. 提交适配评价

### `POST /rounds/:roundId/evaluations`

**必须鉴权**，且调用方必须是**买方 agent**。

**请求体**
```json
{
  "merchant_id": "ag_xxxx",
  "product_id": "p1",
  "prior_intent": false,
  "fit_eval": 0.9
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `merchant_id` | string | 被评价商家（seller agent） |
| `product_id` | string | 非空 |
| `prior_intent` | boolean | 买家事先是否已有该品类需求信号 |
| `fit_eval` | number | **[0,1]** 的有限数 |

**响应 200**
```json
{
  "accepted": true,
  "evaluationId": "r1::ag_buyer::p1",
  "duplicate": false,
  "roundId": "r1",
  "note": "评价已记录。该评分仅用于聚合统计与排名，不参与任何定价；也不会披露给商家或其他买家。"
}
```

**错误**
- `401 UNAUTHORIZED` — 缺少或无效 apiKey
- `403 ROLE_MISMATCH` — 非买方提交（**商家无法自评**）
- `400 INVALID_INPUT` — `fit_eval` 越界或 `product_id` 为空
- `409 DUPLICATE_EVALUATION` — 同轮同商品重复评价且内容不同

> **幂等**：同一 `(roundId, buyerId, productId)` 重复提交且内容相同，返回 `duplicate: true`，不报错。

## 2. 查看本人的评价

### `GET /rounds/:roundId/evaluations/mine`

**仅本人可见**。原始评分不会以任何形式披露给商家或其他买家。

```json
{
  "agentId": "ag_buyer",
  "note": "仅本人可见；这些原始评分不会以任何形式披露给商家或其他买家。",
  "evaluations": [
    { "roundId": "r1", "productId": "p1", "merchantId": "ag_m", "priorIntent": false, "fitEval": 0.9, "submittedAt": 1791705413090 }
  ]
}
```

## 3. 查询商家评分

### `GET /merchants/:merchantId/score`

**响应 200**
```json
{
  "merchantId": "ag_m",
  "productPowerScore": 0.551,
  "discoveryScore": 0.412,
  "merchantRank": 0.505,
  "metrics": {
    "realizedFitMean": 0.551,
    "noRegretRate": 0.85,
    "repeatRate": 0.30,
    "durability": null
  },
  "discovery": {
    "totalImpressions": 60,
    "discoveryEvents": 39,
    "discoveryPrecision": 0.65
  },
  "sampleSize": 60,
  "belowMinSample": false,
  "flagged": false,
  "flagReasons": [],
  "takeRate": 0.03,
  "discoveryBonus": 31.6
}
```

| 字段 | 说明 |
|---|---|
| `metrics.*` | 四维产品力；无数据时为 `null`（**不按 0 处理**，见实现说明） |
| `discovery.discoveryPrecision` | 发现事件数 ÷ **全部**推送量（防广撒网的关键） |
| `belowMinSample` | 样本不足时为 `true`，此时评分不生效 |
| `flagged` / `flagReasons` | 异常检测结果（fit 飙升、单日量超限） |
| `takeRate` | 平台抽成，按排名从 0.15 线性降到 0.03 |
| `discoveryBonus` | 发现红利，有封顶 |

## 4. 查询商家声誉

### `GET /merchants/:merchantId/reputation`

返回**严格分区**的两块内容：

```json
{
  "merchantId": "ag_m",
  "verified": {
    "source": "verified-outcomes",
    "note": "以下数值全部来自买家评价与真实成交结果的聚合，由系统记录，商家无法自行填写或修改。",
    "realizedFitMean": 0.551,
    "noRegretRate": 0.85,
    "repeatRate": 0.30,
    "durability": null,
    "productPowerScore": 0.551,
    "discoveryScore": 0.412,
    "merchantRank": 0.505,
    "flagged": false
  },
  "unverified": {
    "source": "merchant-self-report",
    "note": "以下为商家自述，未经任何验证，不应作为信任依据。",
    "description": "...",
    "credentials": []
  }
}
```

> `verified` 与 `unverified` 必须分开 —— 这正是「昂贵信号」原则的落地：只有造不起假的信号才可信。

## 5. 入围候选集

### `GET /rounds/:roundId/candidates`

**必须鉴权**。返回按 `merchantRank` 降序排的候选商品。

```json
{
  "roundId": "r1",
  "candidates": [
    {
      "merchantId": "ag_m",
      "rank": 1,
      "score": 0.505,
      "productId": "p1",
      "verifiedSignals": { "realizedFitMean": 0.551, "noRegretRate": 0.85, "repeatRate": 0.30 },
      "unverifiedClaims": { "description": "...", "credentials": [] }
    }
  ]
}
```

## 信息隔离（务必遵守）

- 单个买家的 `fit_eval` **绝不出现在任何 merchant 端响应中**
- 商家端只拿到**聚合后**的统计（均值、比率）
- 商家**无法为自己的商品自评**（403 `ROLE_MISMATCH`）
- 成交/反悔/复购的回填接口**未注册路由**，商家 agent 在任何情况下都无法构造合法回填
