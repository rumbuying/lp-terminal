# 成交量趋势与流动性迁移监测 — 需求文档（PRD）

> 状态：v1.1 · 四项开放问题已拍板（§13 决议记录），可进入 Phase 1 实施
> 关联文档：`docs/up33-contract-map.md`（合约与数据源基准）、`indexer/poolRank.ts`（现有排名实现）、`shared/recommendation/model.ts`（推荐模型）
> 涉及模块：indexer / api / shared / src（前端） / executor（三期）

---

## 1. 背景

### 1.1 问题定义

当前选池与推荐体系以 **APR** 为核心展示指标（`poolRank.feeApr` = 7 日均量 × 费率 × 365 / TVL）。
APR 是**滞后的确认指标**：

- `feeApr` 用 7 日均量计算。当成交量因竞争池出现而迁移走，真实手续费收入**当天**下滑，
  但 7 日均值的 APR 数字最长存在 **~7 天的高估幻觉期**；
- `emitApr`（排放）按快照 `rewardRate` 年化，合约只承诺到 `periodFinish`（本周四 flip），
  票重每周重排，同样不保证延续。

成交量是两者共同的先行变量：手续费收入 = 成交量 × 费率；排放分配也随投票者对量的反应而变。

### 1.2 两个核心用户问题（本 PRD 的立项理由）

1. **量跌归因**：一个热门代币池的成交量快速下降，往往是因为出现了更好的同类池
   （典型：更低费率档、更优 venue）。能否**自动定位**那个承接了成交量的池？
2. **量升进场**：一个池的成交量稳步上升，意味着币种热度爬升，是好的 LP 进场点。
   能否把它从噪音（小时级尖峰、刷量）中筛出来？

### 1.3 现有资产的缺口

项目已具备（无需新建采集链路）：

| 资产 | 位置 | 现状 |
|---|---|---|
| `pool_market_snapshots` | `indexer/store.ts:123` | 每池 5 分钟桶快照（vol5m/1h/6h/24h + TVL + tick + fee），保留 180 天，`upsertStats` 自动写入 |
| UP33 CL 子图 `poolDayData` | `indexer/poolRank.ts` | 40 天日频量/价，仅用于 APR/σ 计算 |
| GT OHLCV 日频 | `indexer/poolRank.ts` | univ3/pancake v3 候选池 45 天，仅用于 σ 与量 |
| `v4_pool_days` | `indexer/store.ts:261` | v4 池日频原始 token 量 |
| `volumePersistence` | `indexer/poolRank.ts:136` | 7 日均/生命周期均比值，UI 压缩成一个箭头 |
| `chooseLookback` walk-forward | `shared/recommendation/model.ts:115` | 小时级尖峰/放缓判别，仅服务回看窗口选择 |
| `/api/pool-groups` | `indexer/api.ts` | 按**单 token** 聚合的跨池分组，**只有当前值无历史** |

缺口：天级趋势特征计算、按**交易对**（token0+token1）的跨池份额时序、迁移事件检测与展示。

---

## 2. 目标与非目标

### 2.1 目标

- G1 每个可排名池输出**成交量趋势分类**（五态），可排序、可筛选、可解释（附数字依据）。
- G2 对任意池，一键回答"量去哪了"：展示同交易对全家族池的量与份额时序，自动判定
  **迁移 / 退潮 / 扩张**，并支持一键跳转到承接池。
- G3 迁移事件在发生当周（早于 APR 断崖确认）主动浮出：排名页警报条（仅页面内展示，
  §13 决议 3）+ 推荐降级 + 持仓警示（三期）。
- G4 新竞争池上线即预警（早于任何份额变化）。
- G5 所有新指标经过与 `poolRank.ts` 同级的工程约束：纯函数可单测、快照降级、
  明确的数据来源标注与不足时的显式缺失（null 语义，不编造）。

### 2.2 非目标

- 不做自动执行迁移/退出（三期仅做"评估建议"，执行仍走既有 strategy 流程）。
- 不引入图表库；sparkline/份额图复用手写 SVG 模式（`StrategyPnlCurve.tsx`）。
- 不替代现有 LVR coverage / σ / 尘埃门槛 —— 趋势信号是**叠加维度**，不绕过风险过滤。
- 本链（Robinhood）优先，不做跨链抽象（与 `POOL_RANK_ENABLED` 同策略）。
- v2 池（univ2/pancakev2/up33-v2）**不进入排名，也不进入归因面板**（§13 决议 2）。
  代价显式接受：v2 承接的量不可见，"退潮"诊断必须携带 v2 盲区提示，防止把
  "迁往 v2"误报为"币种退潮"（见 §9.4）。

---

## 3. 概念模型：三层信号

```
L3 代币热度  —— 该 token 在全部池的总成交量趋势
               回答："这个币整体凉了没凉？"
L2 配对份额  —— 同一交易对（token0+token1）在所有 venue/费率档的份额分布时序
               回答："量去哪了？"（迁移归因）
L1 池级趋势  —— 单池成交量趋势分类
               回答："能不能进？要不要跑？"
```

### 3.1 判别逻辑（G2 的核心）

单池成交量下降是歧义信号，必须结合 L2 消解：

| 观测 | 判定 | 用户行动指引 |
|---|---|---|
| pair 总量平稳 + 本池份额下降 + 某兄弟池份额上升 | **迁移** | 跳转承接池；本池仓位评估退出 |
| pair 总量下降 + 本池份额大致不变 | **退潮** | 币种热度下降，不存在"更好的池"，考虑离场 |
| pair 总量上升 + 本池份额下降 | **增量入口转移** | 新池承接的是增量（常为新盘），按新池评估 |
| pair 总量上升 + 本池份额上升 | **币池双升** | 最强进场信号 |

> 注：本表判定基于 CL/v3/v4 家族内的量。v2 池不在监测内（决议 2），故 `retreat`
> 结论天生带有"量可能去了 v2"的盲区，展示层必须附注（§9.4）。

### 3.2 与既有信号的关系

- 趋势分类（天级）与 `chooseLookback` 的 `short_spike`（小时级）**正交**：
  rising 要求"天级爬升"且"非小时级尖峰"，两者同时成立才计为可信爬升。
- LVR coverage 回答"这个池**值不值得**做 LP"；趋势回答"**现在**是不是好时点"。
  两者交集才是进场雷达的输出。

---

## 4. 用户故事

| # | 角色 | 故事 | 阶段 |
|---|---|---|---|
| U1 | LP 候选人 | 我打开池排名，按"成交量趋势"排序并筛选 rising，得到一张进场候选列表，每行有 14 天量 sparkline 和 vs7d 偏离 | P1 |
| U1b | LP 候选人 | 一个上线第 4 天的池量能在爬升，徽章是 🔥"新盘热"而非 🟢——我知道它有潜力但未经时间验证，转正（≥7 天）前不给推荐加成 | P1 |
| U2 | LP 候选人 | 我看到某池 APR 38% 但标着 🔴断崖，点开归因面板看到量已迁到 Uni v3 30bp 池，点击跳转直接去新池开仓 | P2 |
| U3 | 持仓 LP | 我持仓的池出现橙色警示：份额 7 天 82%→31%，预期手续费收入 −63%，我点"评估策略" | P3 |
| U4 | 持仓 LP | 我持仓的 pair 上线了一个新池（daysActive=3），面板标"新竞争池，份额 +5pp/日"，我在它抢走量之前调仓 | P2 |
| U5 | 推荐用户 | 推荐卡上写着推荐理由"量连续 5 天爬升 +38%/周，非尖峰"，而不是只有 APR | P3 |
| U6 | 排查者 | 我想知道某 token 是整体退潮还是只是某个池失宠，L3 视图给我 token 级总量趋势 | P3 |

---

## 5. 功能需求

需求编号规则：FR-<域>-<序号>。优先级：P1（必须，Phase 1）/ P2（必须，Phase 2）/ P3（Phase 3）。

### 5.1 指标引擎（indexer，新模块 `indexer/volumeTrend.ts`）

**FR-CALC-1 (P1) 池级趋势分类**
- 输入：单池日频成交量序列（来源见 §7）+ 近 48h 小时序列（`pool_market_snapshots` 聚合）。
- 计算指标（全部纯函数，导出可单测，与 `poolRank.ts` 的 `dailySigma` 同风格）：
  - `vsBaseline` = max(当前 vol24h, 近 24h 快照聚合量) ÷ 7 日均量；
  - `slope7dPct` = 近 7 天 log(volume) OLS 日斜率 × 7（对数域周增幅，%）；样本 < 5 天时为 null；
  - `consecutiveRiseDays` / `consecutiveFallDays`：连续同向天数（量 > 前日 ×1.05 计升，< ×0.95 计降）。
- 分类规则（初始阈值，均可调，见 §8.4）：

  | class | 条件（按序短路） | 语义 |
  |---|---|---|
  | `collapsing` | vsBaseline < 0.35 | 断崖：APR 幻觉期开始 |
  | `fading` | vsBaseline < 0.6 连续 ≥ 2 天 | 走弱 |
  | `new_hot` | 满足 rising 的量能条件但 `daysActive < 7` | 新盘热：爬升成立，历史不足以验证持续性（决议 1：单独标注，不并入 rising） |
  | `rising` | slope7dPct > +20% 且 vsBaseline > 1.2 且 consecutiveRiseDays ≥ 3 **且 daysActive ≥ 7** | 稳步爬升（已验证） |
  | `stable` | 0.8 ≤ vsBaseline ≤ 1.2 | 平稳 |
  | `unknown` | 数据不足（日样本 < 5 或 7 日均量 < $50 尘埃线） | 显式缺失 |

  未命中任何规则的落 `stable`（vsBaseline ∈ (1.2, ∞) 但斜率不足，视为"高波动平稳"）。
- 输出附加 `confidence`：0–1，由日样本天数（<8 天降权）、今日快照覆盖度（snapshots 今日条数/288）加权；
  `new_hot` 的 confidence 天然受 daysActive < 7 降权。
- **转正机制**：`new_hot` 不需要事件驱动——每个 rank 周期（12h）重算，daysActive 达到 7
  且仍满足 rising 量能条件时自动变为 `rising`；UI 副行显示"转正还剩 N 天"。

**FR-CALC-2 (P2) 配对分组与份额序列**
- pair key：`min(token0,token1) + ':' + max(token0,token1)`（地址小写、排序后拼接）。
- 分组范围：`pools` 表 `proto IN ('up33cl','univ3','pancakev3')` +
  `v4_pools`（pool_id 身份，与 `pool_market_snapshots` 的 identity-agnostic 设计一致）。
  v2 协议（univ2/pancakev2）**不收集**（决议 2）。
- 每池产出 45 天日频 USD 量序列；pair 层聚合出总量序列与每池 `share(t)` 序列。
- v4 的 `v4_pool_days` 是原始 token 量（volume0/volume1），需乘 indexer 自有价格图换算 USD；
  无价格的日期该池不计入当日 pair 总量，并在响应中标注 `usdCoverage`。

**FR-CALC-3 (P2) 迁移事件检测**
- 事件条件（窗口 ≤ 7 天，逐 pair 计算）：
  - 池 A：份额从 ≥ 50% 降至 ≤ 30%；
  - 同 pair 存在池 B：份额上升 ≥ 20pp；
  - pair 总量同期下降 < 30%（排除整体退潮伪装成迁移）。
- 事件字段：`{ fromPool, toPool, fromShare, toShare, windowDays, magnitudeUsd,
  feeFromBps, feeToBps, venueFrom, venueTo, daysActiveOfTo, nearEpochFlip, detectedAt }`。
- 事件判定在每次 pool-rank 快照刷新时重算；事件列表保留最近 14 天，去重键
  `fromPool+toPool+windowStart`，同键事件只更新不重复推送。

**FR-CALC-4 (P2) 新池预警**
- 条件：pair 内某池 `daysActive < 14` 且份额日增 ≥ 5pp 且当日量 ≥ $1,000。
- 输出并入归因面板与警报条（与迁移事件共用渲染通道，类型字段区分）。

**FR-CALC-5 (P3) 代币热度（L3）**
- 每 token 聚合其全部池的日频量总和，输出与 FR-CALC-1 同构的五态分类
  （token 级不使用 `new_hot`——新盘热是池级概念，token 级按 rising/退潮正常判定）。
- 用于归因面板顶部诊断行（"pair 退潮"时同时看 token 是否整体退潮）。

### 5.2 API

**FR-API-1 (P1) `/api/pool-rank` 快照扩展**
- `rows[]` 每行新增：

```jsonc
{
  "trend": {                      // unknown 时整个对象仍存在，字段显式 null
    "class": "rising",            // rising|new_hot|stable|fading|collapsing|unknown
    "vsBaseline": 1.38,
    "slope7dPct": 21.4,           // null 当样本不足
    "consecutiveRiseDays": 5,     // 或 consecutiveFallDays，仅保留命中的
    "daysToVerified": null,       // 仅 new_hot：距转正（daysActive≥7）剩余天数
    "confidence": 0.86,
    "dailyVol": [ /* 14 天日频 USD 量， oldest→newest， 缺日为 null */ ],
    "daysSampled": 12
  }
}
```
- 快照顶层新增 `migrationEvents: MigrationEvent[]`（P1 阶段恒为 `[]`，字段先占位）。
- 兼容性：纯增量字段；老前端忽略新字段不受影响。

**FR-API-2 (P2) `GET /api/volume/pair?pool=<address|poolId>`**
- 响应：

```jsonc
{
  "ready": true, "generatedAt": 1750000000, "windowDays": 45,
  "pair": { "token0": "0x..", "token1": "0x..", "symbol0": "WETH", "symbol1": "CASHCAT" },
  "diagnosis": {                   // FR-CALC 判别结论
    "kind": "migration",           // migration|retreat|expansion_shift|both_rising|unknown
    "headline": "7 天内份额 82%→31%，量迁至 Uni v3 30bp 池",
    "caveats": []                  // 如 retreat 时附 "v2 池不在监测内"（§9.4）
  },
  "series": { "days": [ /* 45 个 UTC 日起点 */ ],
    "pairTotal": [ /* pair 日总量 USD */ ] },
  "pools": [ {
      "identity": "0x..", "proto": "up33cl", "feeBps": 125, "tickSpacing": 10,
      "tvlUsd": 540000, "gaugeAlive": true, "daysActive": 38,
      "dailyVol": [ /* 45 */ ], "share": [ /* 45，0–1 */ ],
      "trend": { /* 同 FR-API-1 */ },
      "isNewcomer": false,         // FR-CALC-4
      "usdCoverage": 0.97          // v4 无价日占比等的标注
  } ],
  "events": [ /* 命中该 pair 的迁移/新池事件 */ ]
}
```
- 约束：同步路由、读 kv 缓存快照（计算随 pool-rank 周期在主循环外完成，复用
  `refreshRecommendationSnapshotInBackground` 的 worker 模式若超时）；
  缓存 TTL 与 pool-rank 快照一致（12h 节奏）；`pool` 参数不识别时 400。
- 不确定 pool 属于任何 pair 时返回 `{ ready: false, reason: 'pool_not_grouped' }`。
- 响应中的 `pools[]` 只含 CL/v3/v4 家族成员（决议 2，无 v2 行）。

### 5.3 前端

**FR-UI-1 (P1) PoolRank 趋势列升级**
- 现 `TrendMark`（↗/→/↘）替换为**五态徽章**组件（决议 4：直接替换，不做新旧并存开关）：
  - 🟢 `rising`（绿）/ 🔥 `new_hot`（青，副行含 `新盘<7天`，tooltip 注明
    "转正条件：daysActive ≥ 7 后重新判定，还剩 N 天"）/ ⚪ `stable`（灰）/
    🟠 `fading`（琥珀）/ 🔴 `collapsing`（红）/ `unknown` 显示 "—"；
  - 徽章副行：`+38%/周 · vs7d ×1.4`（相应数字 null 时省略对应段）；
  - `title` tooltip 展示完整依据（含 consecutiveRiseDays、daysSampled）。
- `new_hot` 不携带"进场"语义文案；未通过 rank 门槛（尘埃/σ）的新盘仍显示
  "未验证热量"灰绿徽章（§9.1）。判序：**门槛先行**——先过 rank 门槛，再看 class。
- `volDay` 列旁内联 14 天 sparkline（30×14 px，SVG 迷你柱，复用 `PnlValueCurve`
  的 viewBox 手法；缺日画空档）。
- 手机端（`show-m` 行）：徽章并入 TVL 下的 `cell-sub` 行，sparkline 隐藏（详情看行展开）。

**FR-UI-2 (P1) 排序与筛选**
- 表头排序选项新增"成交量趋势"（`poolRank.sortTrend`）；排序键 = class 权重
  （rising > new_hot > stable > fading > collapsing > unknown），同级按 vsBaseline 降序。
- 新增筛选开关"仅显示爬升池"（默认关）：包含 `rising` 与 `new_hot` 两类，
  靠徽章自区分，不单设开关。

**FR-UI-3 (P1) 迁移警报条**
- 快照 `migrationEvents` 非空时，表格上方渲染事件条（最多 3 条，多则折叠计数）：
  `🚚 WETH/CASHCAT：7 天内 UP33 CL (125bp) → Uni v3 (30bp)，份额 82%→31%，≈$412k →追踪`。
- `→追踪` 点击展开该 pair 归因面板（P2 前为跳转 POOLS + 定位兄弟池的降级行为：
  P1 阶段事件列表恒空，此条不出现，组件先行实现并空渲染）。
- **仅页面内展示，不接入 Flash/推送通道**（决议 3）；后续需要推送时作为独立需求再评。

**FR-UI-4 (P2) 行展开归因面板**
- 触发：每行新增展开箭头（`aria-expanded`，键盘可达）。
- 内容自上而下：
  1. **诊断横幅**：`kind` 四态一句话结论（§3.1 表格的文案化）+ pair 总量趋势微标
     + `caveats`（退潮时附 v2 盲区提示）；
  2. **量与份额图**：45 天双图——pair 日总量柱 + 各池份额堆叠面积（单 SVG，
     兄弟池 ≤ 6 池，超出合并为"其他"）；
  3. **兄弟池对照表**：池（含 ● 本池高亮）、venue、费率、TVL、7d 份额变化（`82%→31% ▼`）、
     gauge 有无、费率APR（流出池标注"(滞后)"，承接池标注"(新)"）、操作列 `→跳`
     （`queuePoolJump`，v4 池跳 v4 交易面板）；仅 CL/v3/v4 行（决议 2）；
  4. **事件卡**：命中的迁移/新池事件明细。
- 数据：`useVolumePair(identity)` hook（react-query，staleTime 与 usePoolRank 一致 10min，
  refetchInterval 30min），展开行挂载时才请求。

**FR-UI-5 (P3) Recommendations 趋势证据**
- 卡片市场区块新增一行 `📈 市场热度: <class> (+38%/周, 连续5天)`；
  `new_hot` 显示为 `🔥 新盘热（剩 N 天转正）`，不作推荐理由展示；
  `fading/collapsing` 池的卡片追加警告徽标 `成交量迁出 → <venue> <fee>`（事件存在时）。
- `unknown` 不渲染该行（保持现状卡片密度）。

**FR-UI-6 (P3) Positions/Strategy 持仓警示**
- 仓位行所属池 `class ∈ {fading, collapsing}` 或为迁移事件 `fromPool` 时：
  橙色警示条 `份额 7 天 82%→31%，预期手续费收入 −63% [查看归因] [评估策略]`。
  预期收入变化 = (toShare/fromShare − 1) × 当前费率APR（估算值，标注"估算"）。
- 持仓页只读警示；`评估策略` 跳 STRATEGY 并预填该池（复用 rec prefill 通道）。

**FR-UI-7 (P1) i18n**
- `src/i18n/zh.ts` / `en.ts` 的 `poolRank` 块新增：五态徽章文案（含 `new_hot` 的
  "新盘热/剩 N 天转正"）、`sortTrend`、`risingOnly`、警报条模板、归因面板全部文案
  （含 `diagnosis.*` 四态 headline 模板与 v2 盲区提示）；两种语言同步交付，缺 key 视为 bug。

### 5.4 推荐与执行（P3）

**FR-REC-1** `RecommendationCandidate` 增加 `volumeTrend?: { class, vsBaseline, slope7dPct }`
（由 candidates 组装时从 rank 快照索引附上，与 `poolRank` prior 同通道、同新鲜度门）。
**FR-REC-2** 计分影响：`fading/collapsing` → confidence 上限 0.5 且 warnings 加
`volume_fading`；`rising` 且 walk-forward reason ≠ `short_spike` → confidence +0.05（封顶 1）。
**`new_hot` 不加成**（决议 1：天数不足，等转正后自然适用）。不新增硬 gate
（趋势是时点信号，硬 gate 留给结构性门槛）。
**FR-EXEC-1** executor 周期任务新增检查：持仓池卷入迁移事件 → 记录告警事件并触发
退出评估（复用 rebalance 触发器模式），不自动交易。

---

## 6. 页面形态基准（验收用）

完成后的 POOL RANK 页（文字线框，完整交互稿见评审附件）：

```
┌─ 池排名 ───────────────────────────────────────────── 12h 前更新 ─┐
│ ⚠ 🚚 WETH/CASHCAT: UP33 CL(125bp) → Uni v3(30bp) 份额82%→31% →追踪 │  ← FR-UI-3
│ 排序:[覆盖率▾|成交量趋势▲|费率APR|TVL]  筛选:[仅爬升 ✓]            │  ← FR-UI-2
│ # 交易对            TVL    日量+sparkline      APR  σ  覆盖  趋势  推荐 │
│ 1 WETH/VEX UP33CL   $310k  $85k ▁▂▃▅▇ +140%   46% 4.2% 3.1 🟢+38%/周 ✓│  ← FR-UI-1
│ 2 USDG/ARROW Unv3   $88k   $40k ▁▂▃▄▅ +90%    31% 5.1% 2.2 🔥新盘·剩3天 观察│
│ 3 WETH/CASHCAT      $540k  $71k ▇▇▆▃▁ −78%    38% 6.8% 1.9 🔴量已迁出 ⛔│
└──────────────────────────────────────────────────────────────────┘
        │ 行展开（FR-UI-4）
        ▼
  诊断: 迁移（pair总量平稳，非退潮）
  [45天 pair总量柱 + 份额堆叠面积图]
  兄弟池对照表（●本池高亮，→跳承接池，仅 CL/v3/v4）
```

---

## 7. 数据需求

### 7.1 数据源矩阵

| 用途 | 主源 | 回填/补充 | 粒度 | 保留 |
|---|---|---|---|---|
| 近 48h 拐点方向 | `pool_market_snapshots`（自有） | — | 5m 桶 | 180d |
| 日频量（up33cl） | UP33 CL 子图 `poolDayData` | 自有快照聚合（子图晚到时） | 日 | 40d(子图)/180d(自有) |
| 日频量（univ3/pancakev3） | GT OHLCV `currency=usd` | 自有快照 | 日 | 45d |
| 日频量（univ4） | `v4_pool_days` × indexer 价格 | 自有快照 | 日 | 全量 |
| TVL/fee/gauge/费率 | 链上 multicall（现有 `fetchUp33Onchain` 扩展） | — | 快照时点 | — |

> v2 协议（univ2/pancakev2/up33-v2）不采集、不进任何统计（决议 2）；
> 其流量构成 §9.4 的显式盲区。

### 7.2 滚动窗口精度（必须处理）

DexScreener/GT 的 vol24h 是**重叠滚动窗口**快照：相邻快照高度自相关，直接回归会把趋势
钝化、把断崖延迟。处理规则：

- **天级指标**（vsBaseline、slope、share）只用**独立日桶**：外部日频源为主，
  自有快照按 UTC 日切聚合（当日未满一天用外推标注 `partial:true`，不参与斜率）；
- **近 48h** 只用 vol1h 序列且只取**方向**（连续 6 个 1h 窗口中位数 vs 前 48h 中位数），
  不进入天级计算；
- 禁止对 vol5m/1h/6h/24h 快照列直接做回归/斜率（写进 `volumeTrend.ts` 模块头注释与测试）。

### 7.3 冷启动

- indexer 新库 `pool_market_snapshots` 为空时：日频序列全部来自外部源（子图/OHLCV/v4），
  `daysSampled` 按实际可用天数计，分类照常输出（confidence 相应降权）；
- 历史拼接原则：**单源优先不混编** —— 每池选"覆盖天数最多的单一来源"作为日频主序列，
  其余来源仅作交叉校验（差异 > 30% 时 log 告警并在 `trend` 中标注 `sourceReconciled:false`）。

---

## 8. 指标与阈值

### 8.1 正式定义汇总

| 指标 | 定义 | 用在 |
|---|---|---|
| vsBaseline | max(vol24h_now, 近24h快照聚合) ÷ 7 日均量 | 分类、徽章副行 |
| slope7dPct | 7 日 log(vol) OLS 日斜率×7 | rising/new_hot 判定、副行 |
| consecutiveRise/FallDays | 连续同向日数（±5% 容差） | rising/fading 判定 |
| share(t) | 池日量 ÷ pair 当日总量 | 迁移检测、份额图 |
| daysActive | `pools.added_ts`（或子图首日）至今 | new_hot 判定与转正、新池预警 |

### 8.2 判定顺序（短路）

`unknown → collapsing → fading → new_hot → rising → stable`；一行只落一个 class。
`new_hot` 在 `rising` 之前判定：量能条件相同，仅由 daysActive 分流。

### 8.3 迁移事件阈值

§5.1 FR-CALC-3 所列（50%→30%、+20pp、7 天窗、pair 总量降幅 <30% 保护）。

### 8.4 调参原则

- 初始阈值即本文件数值；上线后两周内用实盘回看校准：目标是
  `rising` 池的 7 日后费率APR 实现值 / 预测值 ≥ 0.8（趋势信号的有效性检验）；
- 校准方式为**历史数据回放 + 上线后两周实盘复核**，不做新旧 UI 并存 A/B（决议 4）；
- 阈值集中在 `volumeTrend.ts` 顶部常量导出（`TREND_THRESHOLDS`），禁止散落；
  修改需同步更新本文档表格。

---

## 9. 边界与对抗场景

| # | 场景 | 处理 |
|---|---|---|
| 9.1 | 刷量诱饵：新池 rising 但 TVL 微小、txCount/量比异常 | 徽章"进场"语义仅对通过 rank 现有门槛（7d 费用量 ≥$50、σ 合理）的池展示；未过门槛的显示"未验证热量"灰绿徽章，不进排序加权。判序：rank 门槛先行，class 判定在后 |
| 9.2 | MEV/套利搬量：池间量再平衡 ≠ 用户热度迁移 | 迁移事件要求**连续多日**份额转移 + `txns24h` 同步变化（快照已存）辅助确认；单一尖峰日不触发事件 |
| 9.3 | epoch flip 干扰：投票重排导致 LP/量再分布 | 事件标注 `nearEpochFlip: detectedAt 距 flip < 48h`，提示"可能与排放重排相关" |
| 9.4 | v2 池盲区（决议 2 的直接后果） | v2 不进排名、不进面板、不进 pair 总量。`retreat`（退潮）诊断的 headline 与面板必须附注"v2 池不在监测内"（`diagnosis.caveats`），防止把迁往 v2 的量误报为币种退潮 |
| 9.5 | 子图晚到/回填造成日量突变 | 日桶 `partial` 标注；斜率计算剔除 partial 桶；突变 > 3× 前日且无 tx 支撑时按数据事故丢弃该桶并 log |
| 9.6 | v4 池价格缺失 | 该日不计入 pair 总量，`usdCoverage` 下降；< 60% 时该 pair 诊断降级 `unknown` |
| 9.7 | pair 家族过大（同对 >10 池） | 份额图取前 6，其余并入"其他"；对照表可滚动 |
| 9.8 | 新盘转正边界：daysActive 恰在 7 天附近震荡 | 转正仅前进不回退：一旦判定 `rising`，后续周期除非量能条件破坏（跌出 rising 阈值），不因 daysActive 回退为 new_hot（daysActive 单调递增，天然满足） |

---

## 10. 非功能需求

- **NFR-1 性能**：`volumeTrend` 计算随 pool-rank 12h 周期运行，单次增量 ≤ 现有 rank 周期
  时长的 +30%；`/api/volume/pair` P99 ≤ 50ms（kv 直读，无在线计算）。
- **NFR-2 预算**：GT 请求预算随候选扩容调整为 ≤ 每周期 70 次（30 候选 × 2 OHLCV
  + 2 次榜单页 + UP 价；归因面板兄弟池 OHLCV 复用候选池数据，仅增量拉新池），
  遵守 `gtPaceMs` 节流与 429 退避（复用 `gtFetch`）；周期时长预计 10–16 分钟，
  在 30 分钟并发守卫内。
- **NFR-3 降级**：任一数据源失败 → 该池 `trend.class='unknown'`，页面显式 "—"，
  不静默回退为 stable；快照失败沿用上一份（现有 kv stale-on-failure 语义）。
- **NFR-4 可测性**：分类、斜率、份额、迁移判定全部纯函数单测（每函数 ≥ 正/反/边界 3 例），
  覆盖 §9 场景表；API 契约有 responseCache 级快照测试。
- **NFR-5 i18n**：中英同步；数字格式沿用 `fmtUsd/fmtCompact`。
- **NFR-6 可观测**：每周期 log 池数/unknown 占比/事件数；`unknown` 占比 > 40% 连续 2 周期
  时在 health 中暴露。

---

## 11. 验收标准

### Phase 1
- [ ] rank 快照每行含 `trend`，unknown 显式存在而非缺字段；
- [ ] UI 五态徽章（含 🔥 new_hot 及"剩 N 天转正"副行）+ 数字副行 + 14 天 sparkline，
      排序"成交量趋势"与"仅爬升"筛选可用；
- [ ] 手机端不溢出（cell-sub 承载徽章，sparkline 隐藏）；
- [ ] `volumeTrend` 纯函数单测全绿（含滚动窗口禁令、new_hot 判序与转正的防回归用例）；
- [ ] zh/en i18n 全量 key。

### Phase 2
- [ ] `/api/volume/pair` 返回 §5.2 契约，kv 直读、缓存命中时 P99 ≤ 50ms；
- [ ] 行展开面板：诊断四态、45 天双图、兄弟池对照表、`→跳` 全链路（含 v4 跳转）；
- [ ] 归因面板**无 v2 行**，`retreat` 诊断携带 v2 盲区提示（决议 2）；
- [ ] 迁移事件与警报条：构造历史数据回放能命中 §8.3 阈值；epoch flip 标注生效；
- [ ] 新池预警（daysActive<14 且 +5pp/日）出现在面板与警报通道。

### Phase 3
- [ ] 推荐卡热度行（含 new_hot 展示、fading 警告）+ confidence 调整生效，回归测试更新；
- [ ] 持仓警示条 + `评估策略` 预填链路；
- [ ] executor 退出评估触发（仅记录与评估，不自动交易）。

---

## 12. 实施计划

| 阶段 | 内容 | 主要触点 |
|---|---|---|
| P1 | `volumeTrend.ts` 计算引擎（五态分类 + new_hot 转正）+ rank 快照扩展 + 徽章/排序/警报条 UI + i18n | `indexer/volumeTrend.ts`(新)、`indexer/poolRank.ts`、`indexer/api.ts`、`src/hooks/usePoolRank.ts`、`src/components/tabs/PoolRankTab.tsx`、`src/i18n/{zh,en}.ts` |
| P2 | pair 分组（仅 CL/v3/v4）+ 份额序列 + 事件检测 + `/api/volume/pair` + 归因面板 | `indexer/volumeTrend.ts`、`indexer/api.ts`、`indexer/store.ts`(查询)、`src/hooks/useVolumePair.ts`(新)、`src/components/tabs/PoolRankTab.tsx`、`src/lib/poolJump.ts` |
| P3 | 推荐/持仓/executor 集成 + L3 代币热度 | `shared/recommendation/*`、`executor/*`、`src/components/tabs/{Recommendations,Positions}Tab.tsx` |

依赖：P1 无外部依赖（纯已有数据）；P2 依赖 GT 预算核定；P3 依赖 P2 事件流稳定运行 ≥ 1 个 epoch。

---

## 13. 决议记录（评审已拍板）

| # | 问题 | 决议 | 落点 |
|---|---|---|---|
| 1 | `rising` 是否要求 daysActive ≥ 7（新盘如何处理） | **单独标"新盘热"（`new_hot`）**：满足 rising 量能条件但 daysActive < 7 的池自成一类——不并入 rising、不给推荐加成、徽章青色"新盘<7天"并显示转正倒计时；daysActive ≥ 7 后自动按 rising 重新判定 | FR-CALC-1 / FR-UI-1 / FR-UI-2 / FR-REC-2 / §8.2 |
| 2 | 归因面板是否纳入 v2 池（代价：Goldsky v2 子图 +2 请求/周期） | **不纳入**：v2 不进排名、不进面板、不进 pair 统计（仅 CL/v3/v4）；`retreat` 诊断附 v2 盲区提示防误报 | §2.2 / §7.1 / FR-API-2 / §9.4 |
| 3 | 迁移警报是否推送（Flash 通道） | **仅页面内展示**：不接推送通道；后续需要时作为独立需求再评 | FR-UI-3 |
| 4 | 校准期是否新旧趋势展示并存 A/B | **不并存**：五态徽章直接替换旧箭头；校准走历史回放 + 两周实盘复核 | FR-UI-1 / §8.4 |

---

## 14. 术语表

| 术语 | 含义 |
|---|---|
| 迁移 (migration) | 同 pair 成交量从池 A 持续转移到池 B |
| 退潮 (retreat) | pair 总量整体下降，无承接池（注意 v2 盲区） |
| 份额 (share) | 池日量占 pair 当日总量比例 |
| vsBaseline | 当前量相对自身 7 日均量的倍数 |
| APR 幻觉期 | 量迁移后 7 日均值 APR 仍高估的窗口 |
| pair 家族 | 同一 token0+token1 在所有 CL/v3/v4 venue/费率档的池集合 |
| 新盘热 (new_hot) | 满足 rising 量能条件但上线 <7 天的池；单独标注、不加成，≥7 天自动转正 |
| 转正 | new_hot 池 daysActive 达到 7 天且量能条件仍成立时变为 rising |
| 未验证热量 | 未通过 rank 门槛（尘埃/σ）的池，趋势徽章显示灰绿，不参与进场语义 |
| LVR coverage | 现有 rank 的费率APR ÷ (σ年²/8)，结构性门槛 |
| walk-forward | 现有推荐模型的样本外回看窗口择优 |
