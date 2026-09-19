# 幼龄池 LP 策略 PRD（新币高换手窗口）

| 项 | 值 |
|---|---|
| 版本 | v2.1，开发基线；v2 基础上新增 EM-D0 微型资金试验通道（§2/§7.5/§9.1）：3 天运行门槛的先行链路验证，统计证据标准不变、仅约束扩量 |
| 日期 | 2026-09-19 |
| 当前可开工 | EM-A 观测、EM-C0 最小收益回放；随后 EM-B 证据与信号、EM-C 样本外验证 |
| 资金状态 | EM-A/B/C 全程只读；EM-D 默认关闭，开发完成、回测达标均不自动开启资金动作 |
| 读者 | 产品、indexer / executor / 前端开发、测试、策略与安全审阅人 |
| 接续文档 | [策略需求](LP_STRATEGY_REQUIREMENTS.zh-CN.md)、[实施规格](LP_STRATEGY_IMPLEMENTATION_PLAN.zh-CN.md) §11/12/13、[量趋势 PRD](VOLUME-TREND-PRD.zh-CN.md) §5.4/9.1 |

本版将评审意见转为可实现契约。本文只改变幼龄池新增流水线，保留成熟池日级排名和现有执行安全校验；不把已有系统上线当作本策略有效性的证据。EM-D 为后续有条件范围，当前开发无需等待资金批准。数值分别标明工程默认、研究初值或实验上限，均不代表已验证的盈利参数。

## 1. 背景与待验证假设

### 1.1 系统及代码基线

LP Terminal 由浏览器前端、只读 indexer（Node + SQLite）和持有专用钱包保险库的 executor 组成。现有再平衡周期为 mint → 边界触发 → 撤出/换币/再 mint，收益以 USDG 结算。原稿记载的生产发现时延等指标需在 EMG-A00 重新测量，本文不声称已做生产验证。

| 现有能力 | 复用点 / 边界 |
|---|---|
| `indexer/v4Rpc.ts` | TokenFactory / PoolManager Initialize 游标；来源不证明发行人身份或安全 |
| v23-tail、`adaptiveLogs.ts` | UP33/V3 发现、自适应日志窗口、失败不推进纪律 |
| `indexer/v4Positions.ts` | 官方 PositionManager NFT 归属；不等于全部 v4 核心仓位或锁仓证明 |
| `indexer/poolRank.ts` | EmergingRow 当前仅 UP33/V3 且展示集截断；不能作观测或回测全集 |
| `recommendation_cohort` | 复用保留失败样本的思想；现表不是不可变实验账本 |
| `src/lib/apr.ts` | 已区分区间状态、活跃流动性份额和 UP33 扣费，回放不能退化为全池 APR |
| `executor/volumeAlert.ts` | 只读审计边界；不照搬其长缓存和进程内抑制实现 |
| `executor/capital-policy.ts` | 现有本金管理；组合实验额度、并发预留仍需新增 |
| IDX-01 `pool_history` | 当前规划中的公共历史；本需求扩展字段，不另造小时聚合真相 |

### 1.2 场所与收益口径

- 仅 Robinhood Chain 的 UP33 CL、官方 Uniswap v3、官方 Uniswap v4；排除 BSC 和全部 V2。
- UP33 首期研究未质押手续费仓位；排放不能与手续费相加，净费用必须扣除适用的协议/未质押侧扣费。
- V3 按实际费率及协议扣费重放；V4 记录 PoolKey、PoolId、hook、逐笔费用及适用的 hook 结算，不能以创建时费率替代实际费率。
- `volume × fee / TVL` 仅作池级观察；具体仓位收益由区间、活跃流动性份额、成交路径、库存和成本决定。
- `σ²/8` 是特定连续价格模型下恒定乘积池的 LVR 比率；CL 需对应区间模型。LVR、相对持币的 IL、USDG 本金盈亏分别归因，不能重复扣减。既有 coverage 保留为成熟池启发式指标，不能据此宣称任意 CL 策略必赚或必亏。
- 既有 `head - INDEXER_FINALITY_BLOCKS`（当前默认 12）为确认深度策略，不等同于 L1 最终性保证；新数据必须能够处理重组。

### 1.3 可证伪假设

部分新币在已标记主体减持后，仍可能存在持续成交和退出深度；在信号实际可用、完成入场之后，某种 CL 仓位的净费用可能覆盖库存损失与成本。必须验证等待后的剩余窗口、相对简单选择规则的增益、样本外收益及计划规模下的进入/撤 LP/卖币能力。

“分配期→确认期”只是研究分段，不是每个币必经的状态。余额下降不证明隐藏关联方已退出，多个地址成功卖出不证明本钱包未来可卖出；不预设正收益或胜率形态。

## 2. 范围与阶段边界

| 阶段 | 交付 | 开启条件 | 禁止 |
|---|---|---|---|
| EM-A | 发现账本、事件/状态证据、聚合、只读 API | 本版即可开工 | 安全认证、入场推荐、签名 |
| EM-C0 | 单场所固定区间收益回放及核对夹具 | A 事件/状态契约完成，先于完整 B/UI | 池级费用代替仓位收入 |
| EM-B | 模板门禁、行为风险、观察信号、审计告警 | A 可复算，按证据覆盖开放 | 创建策略、调用资金计划器 |
| EM-C | 前瞻纸面实验、时间切分、组合回放、证据报告 | C0 核对通过，B 冻结版本 | 训练集结果直接批准入场 |
| EM-D0 | 人工确认微型资金试验（打通端到端链路） | §9.1 微型试验条件：C0 verified_replay 通过 + EM-A/B 验收 + 观测流水线连续 ≥3 天健康运行，并显式启用 | 自动入场、扩大预算、把结果外推为盈利证据 |
| EM-D | 加大/重复资金实验、扩大场所与模板 | §7.5 eligible_for_canary_review + §9、§12 满足并显式启用 | 自动入场、无限重开、超出冻结预算 |

观测可宽，候选/回放必须窄。首个回放适配器优先选择数据齐全的官方 V3 静态费率池；V4 首期仅无 hook 池，非零 hook 及 UP33 需专门核对。目标链没有满足条件的池则报告覆盖不足；本地 fork 夹具可验证实现，但不作为策略收益样本。

首期候选仅限已审阅、部署身份可验证的固定供给、无税、无 rebase、无黑名单/暂停/任意限售、不能随意升级的代币模板；quote 为审核过的 USDG，其他币对只观察。不新增社交源、不建全链 holder 服务、不扩大私钥接触面。

## 3. 身份、时间与状态契约

### 3.1 身份与年龄

- `poolKey = chainId:venue:canonicalId`；V3/UP33 canonicalId 为小写池地址，V4 为 bytes32 PoolId，并校验 PoolKey 和配置内 PoolManager。禁止把 PoolId 强转 address。
- 分别存 `poolCreatedAt/tokenCreatedAt/launchAt/firstSeenAt`，未知为 null，不相互代填。
- 观测条件：池龄 <7d，或投机侧 token 经证实出生 <7d。新池配老币可观察，但不进入“新币供给释放”候选；币龄未知亦不通过。
- `baseToken` 明确为新币、`quoteToken` 为 USDG，不默认 token1 是 quote；跨池按 token 身份归并，不按名称。

### 3.2 两个时间及可用性

证据携带 `blockNumber/blockHash/blockTimestamp`、`observedAt`（首次收到）、`availableAt`（确认且完整后首次可决策）、`source/version`。时间为 Unix 秒，轮询以 Ms 后缀标毫秒；链上金额为最小单位十进制字符串。

回放仅使用 `availableAt <= decisionAt` 的证据；补扫记录实际补扫时间，不假装系统当时已知。`idealized_historical` 可研究历史机会，但不得成为 EM-D 放行证据。

新鲜度按扫描水位/快照时间，不按最后 Swap 时间。完整扫描无成交=有效零量；未扫描、重组中、超时=unknown，不能写零。

### 3.3 状态

观测状态 `discovered → queued → backfilling → tracking → aged_out`，另有 `capacity_deferred/data_gap/reorg_repair` 原因态；变化追加记录。

信号状态 `observing / blocked / watch_candidate / invalidated`。`watch_candidate` 文案为“观察条件满足”，不叫“安全”“买入”“待签名”。告警发送状态独立；EM-A/B/C 一律 `canCreateStrategy=false`。观察门禁 pass 不替代 §9 的交易预检或资金授权。

## 4. 采集、存储与容量

### 4.1 发现全集与固定观测集

接入发现源 durable 数据/游标，不只消费进程内 fresh；重启补齐未入账发现。所有池进入轻量账本，含未详细采集原因。

详细采集默认上限 200 池，按首次发现时间和 poolKey 稳定录取，固定保留到年龄退出条件及已登记实验的最长72h前向窗口均结束；不因 TVL/量下降提前删除。超额记 capacity_deferred，按原队列补位；无完整历史不能成为可放行样本。报告公布发现、录取、漏采比例及适用总体，不外推全链。

实验前向窗口、EM-D 持仓和 recovery 残余对应池必须 pin，优先于新录取；满额停止录取，不能淘汰持仓。池老化不终止已开始实验。同 token 的 Transfer/权限共用 token 流。

### 4.2 协议采集与游标

| 场所 | 日志过滤 | 收益重放额外要求 |
|---|---|---|
| V3 / UP33 | factory 证明的池地址；Swap、Mint、Burn、所需配置事件 | 初始状态、tick 流动性、协议扣费/动态费率历史；UP33 未质押费用分配 |
| V4 | PoolManager 地址+事件 topic+PoolId indexed topic，按供应商限制分批 | Initialize、Swap、ModifyLiquidity、Donate、配置；PoolKey/hook；区分 swap/LP/protocol/hook 收支 |
| Token | Transfer，必要时 receipt/已知 launcher 事件 | 供给起点、mint/burn、完整余额；模板下 balanceOf/totalSupply 对账 |
| 仓位/锁仓 | PositionManager/核心仓位及已审核 locker 事件/状态 | owner/operator、区间、L、解锁、提前提取、升级权限 |

每流持久化连续水位和块哈希；原始事件、派生失效标记、游标推进同事务提交。重复送达幂等；允许重读，不重复累计。派生消费者另持 durable 水位，聚合失败不能伪装 ready。

RPC 拒绝缩窗、限流退避；单块失败阻塞该流，不能跳块。检查点哈希变化即暂停相关信号，找共同祖先，撤销孤块及派生后重放；无法找到完整祖先则人工修复。已发候选追加 invalidation。

### 4.3 持久化模型

下表为最低逻辑契约，迁移遵循仓库 SQLite 方式；可拆表，不可减少精度、时点历史、主键和保留要求。链上整数 TEXT/BigInt，安全额度用整数 micro-USD 或结算币最小单位；REAL 仅展示/统计。

| 表 | 主键 / 核心字段 | 用途 |
|---|---|---|
| `emerging_discovery` | poolKey；venue、canonicalId、token0/1、各年龄、origin、firstSeenAt | 含失败/未录取的发现账本 |
| `emerging_observation_events` | eventId；poolKey、状态、原因、occurredAt/observedAt | 录取/排队/pin/缺口/老化历史 |
| `emerging_scan_cursors` | chainId+streamKey；blockNumber/hash、lastScanAt、completeThroughTs、status | 池/token/配置流水位 |
| `emerging_chain_events` | chainId+txHash+logIndex；blockNumber/hash、txIndex、blockTs、contract、kind、poolKey/token、payload、observedAt/availableAt、canonical | 原始有序事实及解码版本 |
| `emerging_state_snapshots` | poolKey+blockHash+snapshotKind；state、ticks、feeConfig、source、observedAt/availableAt、completeness | 历史初始/周期检查点 |
| `emerging_actor_evidence` | evidenceId；token、address、role、clusterId、confidence、来源、有效/可用时间、version | 角色与关联证据，聚类版本化 |
| `emerging_gate_evidence` | evidenceId；poolKey、researchProfileHash、gateId、状态、reason、supportingIds、checkedBlock/hash、availableAt、expiresAt、policyVersion | 门禁历史，失效新增修订 |
| `emerging_signal_events` | signalId；poolKey、researchProfileHash、状态、decisionAt、anchor、evidenceIds、metrics、版本、完整性 | 不可变决策快照 |
| `emerging_experiments` | experimentId；manifestHash、signalId、poolKey、config、split、entryAt、horizon、pinUntil、status、resultArtifactHash | 独立实验 cohort |

Swap payload 至少有 amount0/1、sqrtPrice、tick、liquidity、原始 sender、费用、交易者解析；Transfer 有 from/to/value，不能仅存 dev 转出。同块同钱包同收款人的多次 Transfer 不碰撞。重组后的孤块事实归档；同交易重新上链前先撤销旧派生，canonical 表可更新归属，旧版本保留在归档。

交易者解析为 `{address|null, method, confidence, resolverVersion}`，原始 sender、transaction.from、推断参与者分开。路由/聚合器/账户抽象解析不了归 unknown，不当成真实用户。跨分钟去重、中位数、回环来自明细，不能累加分钟去重数/中位数。

### 4.4 分钟与 IDX-01

唯一 `pool_minute_buckets` 保存 poolKey、minuteTs、complete、缺失源、sourceThroughBlock/hash、聚合版本、swapCount、amount0/1 汇总、volQuote/Usd、fee0/1（可得时）、buy/sellCount/Volume、OHLC/VWAP、resolved/unknownTraderCount、priceCoverage。

- UTC 左闭右开 `[minuteTs,minuteTs+60)`，必需流全部扫完且窗口闭合才 complete。无成交完整桶写零量，OHLC 为 null；状态延续另标 carryForward，不创造零波动样本。
- 单边成交量计一次；USDG 不自动等于美元，保留 quote 数量，USD 估值来自带时间戳认可源，不能仅用自池价格证明 TVL/退出能力。
- `pool_history` 1h 是唯一公共小时结果，新增 intervalVolumeQuote/Usd、intervalFee0/1、OHLC、quality、sourceBlock、aggregateVersion；既有 vol24h_usd 保持滚动24h语义，不当小时量。
- `pool_history.address` 兼容 canonicalId，proto 保留协议；适配器与 poolKey 互转。当前分链 DB；未来共享 DB 需主键加 chainId。历史 API 保留最多5000点。
- 1h 精确去重/分布/回环来自事件，不只依赖分钟数值。状态/成交共同水位才可标 complete。

### 4.5 保留与资源预算

通用分钟7天、5m（若需要）30天、1h365天，非实验原始事件/状态至少30天；轻量发现/状态变更/拒绝原因账本至少365天。所有实验从初始化检查点到最终退出/72h观察完成的事件、权限、信号、版本、估值及成本源归档，校验和固定，默认365天且报告发布后至少180天，取较晚者；失败实验同样保留。删原始前验证归档可读、哈希和依赖完整，pin 数据不删。

工程初值：60s 非重叠 loop、最多4并发 RPC、新流水线5 requests/s且不超供应商总预算，窗口最多10,000事件后分批提交。超大响应拆块区间；单块只能用供应商支持的分页/receipt等完整路径，否则阻塞。池数量不等于成本上限，另记请求、字节、事件、DB增长和积压。

空闲磁盘<20%或连续3轮扫描>60s停止新录取，优先 pin/存量；<10%停止非必要写入并告警，不能删除未归档证据。独立开关/预算不得拖垮已有服务；EM-A 用200池及峰值夹具压测，历史重放离线运行。

## 5. 证据与门禁

### 5.1 模板注册与信任

新增版本化 emergingPolicy：chain/场所、token 模板及部署证明、认可 quote、hook、locker适配器、费用模型、权限特征、审阅证据。默认没有批准的新币/hook/locker；“待审”不会 pass。观察及 C0 夹具不依赖注册表放行。

不能通过一次 owner/minter multicall 宣称无后门。读取走既有 mc/RPC，模板证明另需 bytecode、部署参数、源码/审阅工件和代理权限分析。不能证明=unknown，明确不兼容=fail。已知无 owner 的模板与未知合约调用失败不同。

首期非零 hook、可升级 base、税币、rebase、非标准 Transfer 不进候选；扩展需适配器、对抗测试和新 policyVersion。部署来源与功能安全分别证明，知名 factory 不是放行理由。

### 5.2 标记主体及库存释放

角色分别为 tx_initiator、factory_caller、launcher、declared_beneficiary、genesis_recipient、funding_related。V4 优先解码已知 launcher 的发行受益参数；池创建者/交易发起者只是线索，launcher 不是最终 dev。复用现有 provenance，不混同经济控制人。

holder 账本只对证实出生/供给起点的新 token 构建，全量 Transfer 含 mint/burn，按时点供给并核对余额。老币/缺口补齐前为 unknown；不宣称新池扫描天然有界。资金关联不是身份定论，聚类变化版本化，不回填过去决策。

分母为当时 totalSupply 减已证实不可取回的非流通余额，同时保留总供给口径。系统托管、关联主体各自列示；集中度剔除已识别系统托管，不剔除可出售的关联主体。未知托管降低完整性。

原 distribution-complete 改为 tracked_inventory_reduced：已解释的高置信度发行关联主体合计余额≤分母0.5%，连续6h，期间无未解释大额转移且无超额潜在增发/待解锁供给。大额定义为同一关联来源1h累计转出>分母0.1%，防分笔绕过。余额重新>0.5%、未解释大额转出、权限改变或归因失效即失效。

首次满足为 reductionStartedAt，稳定窗结束为 reductionConfirmedAt，后者才可用于候选。拆分、托管、卖出分开解释；无法解释=unknown，没发现发行主体不能按零余额通过。本事件不保证没有隐藏关联方。

### 5.3 八项观察门禁

状态 pass/fail/unknown；缺失、过期、未覆盖=unknown，证实违规=fail；全部 pass 才算后续信号，每次存证据。G07/G08依赖拟定金额，门禁和信号必须绑定researchProfileHash（金额、区间、预算、退出配置）；初始UI只展示一个预登记的100 USDG研究profile，训练网格分别存档，不能共享不同规模的pass。尚未配置profile时仅观察，无候选。

| ID | 门禁 | 首期 pass |
|---|---|---|
| G01 | 身份与年龄 | 官方池/PoolKey匹配，base证实<7d，quote获认可，来源/发行角色可解释 |
| G02 | 代币能力 | 两侧模板审阅；base固定供给、无税/rebase/黑名单/暂停/任意限售或改变这些条件的权限；quote按专门信任模型监测 |
| G03 | 池/hook/费用 | 适配器支持交易/流动性语义，首期v4 hooks=0；费用/扣费历史完整 |
| G04 | 受保护有效深度 | 审核locker/不可取回安排有非零仓位，保护剩余≥30d；受保护活跃L份额≥80%，仅用受保护买盘在冲击≤5%下可承接至少10,000 USDG卖出 |
| G05 | 集中度 | holder完整对账，非系统持仓按关联主体合并后top10/分母<30%，供给口径可查 |
| G06 | 库存释放 | §5.2事件确认且未失效，发行角色映射完整，不只看创建地址 |
| G07 | 计价/退出深度 | quote估值新鲜；拟定纸面规模可用已有深度卖回USDG，冲击≤2%，路径和误差留档；不依赖本仓位提供退出买盘 |
| G08 | 数据/卖出证据 | 必需流及状态新鲜完整；≥3个已解析且未发现关联主体、≥5次卖出，到账与模板一致；至少一笔已观察卖出规模覆盖纸面退出规模 |

G04 根据 tick 曲线仅重建受保护仓位，不能拿 TVL/NFT数/全池锁仓比例替代。NFT burn 不等于锁仓，V3官方burn通常意味着已撤空。V4核心owner可能是PositionManager，需解析最终控制权；非官方NFT管理仓位也在分母，无法解释=unknown。审查locker operator、提前提取、升级、迁移。

数值为研究初值，不是安全证明；报告逐gate阻断率。无池通过=覆盖不足，不自动放宽。身份/禁止能力不因样本少放宽；经济阈值只能训练期版本化校准。

### 5.4 行为风险与对账

behaviorRisk 为 low_observed/suspect/unknown；low_observed 文案“未发现指定异常”，不叫真实量认证。完整小时计算去重经济参与者、持续主体、unknown量、单笔中位数/top1/top5、主体成交集中度；先解析/归并同交易再统计。

回环定义：同主体10min内反向、quote量差≤10%，先到先配、一笔最多一次，已匹配两侧量/总量。另记关联组回环、资金来源和节奏；不自动把套利判刷量。可得时存成交后1/5/15min相对独立参考价的方向变化，无参考=null，不自证低逆向选择。

首期分类：unknown量>20%或数据缺口→unknown；否则任一主体组占量>30%、最大单笔>20%、回环量>50%→suspect；其余 low_observed。分类表示异常筛查，不是诈骗裁决。

GT/子图单独给 reconciliation=matched/mismatch/unavailable，同池同区间同估值口径且窗口完整才比；偏差>50%需解释，未解释则质量降级。外部不可用但自扫与链上核对完整可继续观察；matched不证明真实需求，unavailable不等于fake。

## 6. 信号、阈值与排序

### 6.1 参数版本

纯函数统一读 EMERGING_THRESHOLDS；工程参数归 EMERGING_TUNE，模板归 emergingPolicy，资金归 executor 实验配置。每实验冻结四类版本/hash，不静默修改。下表及§5是研究初值，实现时单点配置与表驱动测试校对。

| 键 | 初值 | 定义 |
|---|---|---|
| emergingMaxAgeDays | 7 | 观测范围，候选另验币龄 |
| actorResidualMaxPct / actorStableHours / actorFlowMaxPctPerHour | 0.5% / 6h / 0.1% | §5.2 |
| maxTop10Pct | 30%（严格小于） | G05 |
| lpMinLockDays / minProtectedActiveShare / minProtectedDepthQuote | 30d / 80% / 10,000 USDG | G04，深度冲击≤5% |
| maxExitImpactPct | 2% | G07，签名前独立重验 |
| minSellActors / minSellTrades | 3 / 5 | G08 |
| maxUnknownActorVolume / maxActorVolumeShare / maxSingleTradeShare / maxRoundTripShare | 20% / 30% / 20% / 50% | §5.4，超过阻断 |
| roundTripWindow / roundTripSizeTolerance | 10min / 10% | 回环配对 |
| reconciliationTolerance | 50% | 外部对账 |
| persistenceHours / retentionRatioMin / collapseRatio | 12h / 0.5 / 0.35 | §6.2 |
| priceBarMinutes / stabilizationHours / sigmaRatioMax | 5min / 6h / 0.8 | §6.2 |
| reboundMin / reboundSigmaMultiplier / minReturnSamplesPerWindow | 5% / 2 / 24 | 反弹阈值及每3h有效收益率数 |
| sourceStaleSeconds / permissionStaleSeconds | 180s / 300s | 流水位/快照、可变权限新鲜度 |
| quietVolumeQuotePerHour | 100 USDG | 每小时需满足，防无成交假企稳 |

静态代码证明按版本缓存；锁仓/余额/权限/深度持续刷新，变更事件立即失效。放宽参数需新实验版本。

### 6.2 留存与企稳

从 reductionConfirmedAt 之后收集12个完整UTC小时，舍弃首个不完整小时；最早候选还需等待此窗，不能回溯重叠稳定6h与留存12h。

前6h均量A、后6h均量B、最新完整小时V、前11h均量M：A>0、B/A≥0.5、V/M≥0.35，12h每小时≥quietVolumeQuotePerHour。分母零/缺桶=unknown。删除v1未定义的量半衰期；仅可在报告探索。

最近6h的5min成交收盘对数收益，前3h样本标准差σA、后3hσB（分母n−1），各≥24个相邻且均有成交的有效收益率，σA>0、σB/σA≤0.8。最近价格≥观察低点×(1+max(5%,2×σB))，σB是5min尺度、不年化。低点仅用 reductionStartedAt 后、决策前已知成交；首次候选冻结anchorLow，不能随下跌下移。可疑单笔低点由行为/价格质量阻断。

### 6.3 合取、排序、失效

```text
八项gate全pass且新鲜
  ∧ behaviorRisk=low_observed
  ∧ tracked_inventory_reduced有效
  ∧ 留存通过 ∧ 企稳通过
  → watch_candidate（只读研究信号）
```

记录 signalId、decisionAt、输入证据及可用时间、anchorLow、版本；历史补扫不补发实时机会。逐项解释阻断原因，不以总分掩盖缺项。

首期不做任意加权综合分数。候选以“最近6完整小时实际LP净手续费/同窗平均可信TVL”排序，标明过去6h观察值，不是预测收入。净费无法归因则值=null、不可收益排序；非候选按发现时间。APR如保留仅次级展示、不用于EM-D。同分按poolKey。

任一gate/数据失效、库存事件失效、V/M<0.35、跌破冻结anchorLow、受保护流动性减少/期限不足、权限或费用不再支持，即invalidated。价格/权限/流动性每轮或直接快照检测，不等小时收盘；量按完整小时。再满足时新建signalId，保留旧记录。

## 7. 收益回放与实验放行

### 7.1 EM-C0：先证明能算对一笔仓位

首个适配器只支持固定区间、未质押、无复投、无重开的仓位。与现有 CL 数学共享纯函数或已验证公式，不独立发明 tick/币种方向算法。最小闭环：给定入场块/价格/金额/区间 → mint → 有序成交与流动性变动 → 触发退出 → 移除流动性/领取资产 → 卖回 USDG → 账本核对。

必须具有入场前完整 tick 状态检查点及其后的有序事件（blockNumber、txIndex、logIndex），或从池初始化完整重放。Swap 最终 tick/liquidity 本身不足以还原跨 tick 的各段费用；应按协议交换步进拆分费用、穿越 tick、更新活跃 L。虚拟仓位按当段自身 L 与池活跃 L 的比例分费（计入新增自身 L），扣协议费用；再按实际适配器处理 UP33 分配、V4 Donate/hook 收支。动态费用历史缺失即 unsupported，禁止用当前费率回填。

同交易即时加减仓也必须按日志顺序处理，不忽略 JIT 竞争。费用保留原币数量，未兑换的新币费用不是已实现 USDG；初始金额、舍入、价格方向、区间边界规则与实际 PositionManager 一致。

两种保真度显式区分：

- `verified_replay`：真实已存在仓位在保留状态的 fork/历史核对中，本金与费用符合协议整数舍入，交易成本来源完整。
- `shadow_estimate`：虚拟新仓位按历史市场路径计算，无法证明“加入后所有交易者仍照原路径执行”。标明反事实误差；限定虚拟 L≤对应活跃 L 的1%、资金≤退出深度的0.5%，不满足则容量不支持。加入/撤出冲击、分费稀释照算，不能称理论已实现收益。不同虚拟实验独立回放，组合结果不能重复占用同一深度。

纸面实验属于 shadow_estimate；只有其基础引擎先经 verified_replay 核对才能提供放行证据。未知交易行为不能通过更精细回放消除，须在成本/延迟/竞争压力场景报告敏感性。

### 7.2 冻结实验 manifest

每次实验启动前固定：universe/录取政策、信号/模板/数据/代码版本，纸面起始净值与绝对实验预算、区间算法、金额、入场延迟、费用模型、退出规则、基准、训练/验证/保留集边界、样本要求、统计方法及停止规则。manifest 使用规范化 JSON+SHA-256，和原始输入/结果归档；同一 manifest 重放输出一致。不能只落 kv 最新状态。

训练期允许比较以下有限网格；验证后只冻结一个配置进入保留集，全部尝试记录在报告中：

| 参数 | 初始研究配置 |
|---|---|
| 纸面初始投入 | 100 / 500 / 1,000 USDG，均受深度/份额约束；不支持记不可执行，不自动缩量掩盖失败 |
| 区间 | 以入场价为中心±10% / ±20% / ±40%，按现有 tickSpacing 对齐；不使用未来波动 |
| 入场时刻 | decisionAt + max(120s, 前瞻测得的人工确认+执行延迟p95)，取其后的第一个可执行块；缺延迟观测时仅研究、不放行 |
| 出场 | 首次信号失效、越出区间或 TTL 到期即开始退出；小时量条件只在完整小时触发，其余按事件/扫描延迟 |
| TTL | 6 / 24 / 48 / 72h；是退出启动时限，不保证到账 |
| 再平衡 | C0与首轮canary固定0次；fee_guarded不默认继承；未来重开需新manifest及独立验证 |
| 观察 | 24/48/72h共同观察点，以及首次退出时点；提前退出后持有USDG，不为凑窗口重开 |

未成交的候选保留为 rejected/skipped 并给原因；不能只统计成功 mint。事件进入条件依赖金额时，每个金额配置独立记录门禁和拒绝数，不用大金额事后替换小金额结果。

### 7.3 成本、基准与不可退出

核心结果为 USDG 现金流账本：

```text
结算净损益 = 中途回收USDG + 最终结算收到USDG
           - 所有投入USDG - 未在现金流中计入的Gas及其他执行成本
```

真实执行与纸面模拟分别标记actual/simulated，未结算时不能标已实现闭仓收益。费用已在 withdraw/collect 金额中则不再加一次；滑点/税费已体现在换回数额中则不再扣一次。观察时点的组合净值另将残余按可信可执行净回收价估值，并单列数量、时间与流动性折价；无可执行路线/可信价格的残余在保守净值和压力场景中计零，不从样本删除。USDG 对美元偏离另报美元净值和估值来源。

成本包括入场换币、mint、撤 LP、collect、退出换币、approval（如需）、失败重试 Gas、路径费用、冲击和可测的延迟损耗。历史 Kyber 报价无法可靠取得时不能用今天报价代替；前瞻保存只读报价及可用时间，或使用已验证链上路径模型。模型不可支持的成本为 missing，不可放行。对退出失败保留故障及恢复时间，不能假设 TTL 时按中价卖出。

基准同时给出：持有初始 USDG、持有入场时等量 token 组合、相同区间不因观察信号提前退出的 LP。全部使用一致资金、成本、估值和观察时点。IL/LVR作为解释列，不额外从现金流扣减。UP33排放、hook额外收入若没有对应适配器，明确排除且限制结论适用范围。

### 7.4 无前视的 cohort 与时间切分

1. 从发现账本前瞻登记所有录取池，先有总体再有信号；保留 rug、退市、零量、拒绝、缺口和录取溢出。筛选前流失单列原因和最坏情景。
2. 信号所有输入受 availableAt 约束，包括角色识别、权限审阅、12h留存；晚到数据只影响晚到后的新决策。示例：10:00开始降余额，16:00稳定确认；随后第一个完整小时起满12h，再加执行延迟，不能回到10:00建仓。
3. 按日历时间先训练、再验证、最后未接触的保留集，不随机打散池。跨切分的信号lookback至最长72h结果窗口全部purge，并留至少72h embargo；同token或已知同主体群不跨训练/保留集。同币多池/重复信号不是独立样本。
4. 训练选阈值，验证选一个配置；保留集只在预登记终点评估一次。看完保留集再改参数必须启用未来的新保留集。线上纸面日志可看采集质量，不能边看保留集盈亏边改规则。
5. 用与§9相同的全组合现金/并发/深度约束重放，包含未投资现金，不把各池最优结果无约束相加。候选争用额度时按冻结排序和时间处理；相同token跨池合并敞口。首轮每token只允许第一次可执行信号入场，后续信号仍保留但不增加独立样本数；记录本金规模与占比，不把小额实验收益外推至大额。

报告包括：发现至候选漏斗、每门禁覆盖/阻断率、每个样本及拒绝清单、净损益/收益率分位数、均值/中位数、最大回撤、尾部损失、退出成功/失败、剩余不可卖资产、手续费/库存/成本贡献、收益集中度、策略容量、全部参数试验次数。按协议和模板分层，不以一种协议的结果覆盖另一种。

### 7.5 EM-C 的证据标准

证据分两层，本节标准只约束“扩量与常态化运行”。另设 EM-D0 微型资金试验（§9.1）：开启条件是工程与运行就绪（C0 verified_replay 通过、EM-A/B 验收、观测流水线连续 ≥3 天健康运行），不是统计证据；预算冻结在单 token、极小绝对额，结果只能用于验证链路与退出能力，任何 D0 结果都不得作为盈利证据或扩量理由。3 天窗口无法产生本节要求的置信区间与跨行情样本，这是数学约束而非流程偏好；把证据标准本身改为 3 天会使放行决定退化为单行情运气。

30个样本只够验证数据/核算流程；删除“30样本且60%费用≥IL即放开”。以下是首版证据政策，须在保留集开始前固定，不因结果不佳临时降低：

| 条件 | 判定 |
|---|---|
| 回放真实性 | 该场所/模板的协议夹具通过；费用/本金按整数舍入对账，现金流无重复；输入可归档复算 |
| 前瞻覆盖 | 全部前瞻观察跨度≥60日；其中训练/验证结束后的未接触保留集自身≥28日、含≥100个独立且模拟入场的token，并至少两个不重叠14日窗口有模拟入场样本。时间切分隔离期不充当交易样本 |
| 净收益 | 保留集按冻结组合计算、全成本及未卖资产保守计价后净收益>0；相对持有USDG的日收益均值95%置信区间下界>0 |
| 相关性 | 用日历7日moving-block bootstrap、10,000次和冻结随机种子计算区间；同日仓位一起抽样，不按单池独立抽样。统计有效性不足须明确insufficient，不因达到100个币忽略相关性 |
| 集中与稳健 | 去掉贡献最大的一个token后仍净正；执行成本×2、延迟×2、可获费用×0.5的联合压力情景下净损益不负；报告参数邻域，不能仅尖点有效 |
| 风险与退出 | 最大回撤≤冻结实验预算的50%；全部假设入场样本都计入，包括失败。未解释的对账差异为0；未解决的退出故障/残余处置缺口必须修复后复验 |
| 可执行性 | 前瞻收集拟用路由/钱包规模模拟、确认延迟及成本证据；尚未支持的协议/hook/模板不共享放行资格 |

输出只能为 `insufficient_evidence / reject / eligible_for_canary_review`；最后一个只是允许审阅小额实验，不自动开交易开关。100个token和60天不是盈利保证；低流量市场可能长期不足，观测产品仍可交付。声明检查终点和最长观察期，到期不足就报告不足，不无限重复检验直到显著。

## 8. API、前端与告警

### 8.1 只读接口契约

新增 `GET /api/emerging/pools?limit=50&cursor=...&status=...&venue=...`，limit上限200；按快照generation+稳定poolKey分页，游标失效返回409及重取提示。`GET /api/emerging/pools/:poolKey` 返回单池证据摘要和信号历史，poolKey须URL编码并校验链/协议；不得拼接为SQL。聚合历史复用IDX-01，不公开无限原始日志查询。

最小返回契约（省略字段须在共享类型中继续定义，不得用任意any）：

```ts
type EmergingPoolView = {
  schemaVersion: 1
  poolKey: string
  researchProfileHash: string | null
  venue: 'up33-cl' | 'univ3' | 'univ4'
  baseToken: string | null
  quoteToken: string | null
  poolCreatedAt: number | null
  tokenCreatedAt: number | null
  observation: { state: string; reasons: string[]; pinnedUntil: number | null }
  dataQuality: {
    status: 'complete' | 'partial' | 'stale' | 'unsupported'
    completeThroughTs: number | null
    missingStreams: string[]
  }
  gates: Record<string, {
    status: 'pass' | 'fail' | 'unknown'
    reason: string
    evidenceId: string | null
    availableAt: number | null
    expiresAt: number | null
  }>
  behaviorRisk: 'low_observed' | 'suspect' | 'unknown'
  signal: { id: string | null; state: 'observing' | 'blocked' | 'watch_candidate' | 'invalidated'; decisionAt: number | null }
  observedNetFeeYield6h: number | null
  thresholdVersion: string
  policyVersion: string
  canCreateStrategy: false // EM-A/B/C编译及运行契约，不随signal变化
}
```

envelope含schemaVersion、generation、generatedAt、nextCursor、phase、ready、发现/详细跟踪/容量排队计数。功能禁用返回503+明确code；数据仍回填返回200、ready=false和原因，不伪装空市场。新增API不改变现有pool-rank字段或成熟池排序。

### 8.2 前端与只读审计

POOLS/STRATEGY 展示观察列表、分项门禁、证据时间、未知原因、过去6h费用指标、容量/历史缺口。V4使用新观察类型，不能向旧 `PoolRankVenue` 强制断言。既有EmergingRow可通过poolKey挂接摘要；无新API时保持原样。英中文案同步，醒目区分“未发现异常”和“安全证明”。

新增 `executor/emergingAlert.ts` 仅fetch/API校验/audit，不import plan/runner执行器、签名、vault或交易构建模块；测试锁定依赖边界。indexer保存完整signal history，executor只订阅已配置观察列表及已有策略相关池，避免给所有新币刷审计日志。允许记录创建观察信号、失效、恢复及数据事故；不外发消息。

executor轮询60s，缓存最长60s。抑制键为poolKey+code+signalId+状态修订，持久化到审计存储；同一状态24h抑制，但严重升级、失效、恢复即时写入，不能被“当天已告警”吞掉。进程重启不重复告警。审计写入/HTTP失败不阻塞原有资金loop；记录告警投递积压。首期不新增“从候选创建策略”按钮。

## 9. EM-D：后续资金实验契约（默认关闭）

### 9.1 开关、范围与额度

EM-D必须另外完成实现/验收，并有显式实验配置启用；不能由分数、API字段、定时任务或回测报告自动启用。配置固定manifest、允许venue/token模板、策略版本、专用钱包、起始净值N、绝对USDG预算和用户接受的最大损失。只复用已有签名模式，不因授权入场而增加权限范围。

首轮实验上限（可下调；提高需新评审）：单token总投入≤起始N的0.25%，全部幼龄仓位/预留/未卖残余占用合计≤N的1%，最多3个token，同token多池合并；同时受shadow份额/深度上限和现有钱包日限额约束。实际cap为比例额度与明确绝对USDG预算之较小值。未能获得可信N时禁止创建实验，不按当前可操纵池价扩容。

EM-D0 微型试验（先行通道，早于 EM-D 全部条件）：显式启用前须满足 C0 verified_replay 通过、EM-A/B 验收、观测流水线连续 ≥3 天无 E_EMERGING_DATA_GAP / E_EMERGING_VOLUME_STALE 级中断；单 token、单仓位，投入 ≤ min(N 的 0.1%, 100 USDG)，与预登记 100 USDG 研究 profile 一致；人工确认入场，全程沿用 §9.2/§9.3 预检、保护退出与恢复；微型预算累计亏损 20% 即停止。D0 的唯一目的是打通 入场 → TTL/保护退出 → 结算 → 审计 全链路，其结果不进入 §7.5 证据、不解锁任何扩量，失败结论同样只归因链路问题。

累计净亏损达到实验总预算的50%停止新增入场并执行已授权退出；损失阈值不是本金损失保证。亏损不能因重建strategyId、重启、TTL重置或转钱包清零。并发创建job必须在同一executor数据库事务预留钱包/实验额度；所有手动、API、恢复后重开入口统一检查。残余资产未处置不释放其占用成本，不能用零估值骗出新额度。另预留Gas/退出费用，禁止自动补入更多本金。

### 9.2 入场预检与运行策略

人工点击后重新读取链上状态并以拟用钱包、路由、金额验证：余额/allowance、买入、mint、撤LP/collect、卖回USDG、费用/深度及slippage；需要串联状态时用隔离fork或受支持模拟，不能只验证一个独立eth_call。历史别人卖出不替代本钱包验证。取决于未知hook/税/权限则拒绝。

签名前snapshot/quote最长30s；变化或过期重新规划。预检引用信号不自动执行，人工确认不得绕过现有identity、router、slippage、资金隔离和日限额。观察低点与初始mint时间冻结，TTL不因服务重启或收费刷新。

首轮固定区间、无质押、无复投、无重开；现有编辑器预填一个明确的emerging实验标记和已验证退出策略，不能偷偷使用fee_guarded的再mint循环。不同执行模式依现有授权能力；需要钱包确认的模式须显示退出不能保证无人值守，不能混入无人值守canary验收。

### 9.3 退出及恢复

状态为 `entry_pending → active → exit_requested → liquidity_removed → settlement_pending → closed`；任一步失败进入recovery并保留实际资产。只有已回收USDG且残余已明确处置后closed，撤LP成功不等于结算成功。

- 触发：跌破冻结anchorLow、区间越界、已确认权限/流动性危险、量崩塌、TTL到期、累计预算止损、人工退出。创建实验时明确授权这些自动保护退出；未授权模式则进入等待钱包确认并告警。
- 必需indexer数据陈旧先禁止入场/加仓/重开，使用executor直接RPC复核；持续5min不能恢复则请求保护退出。不能把“入场gate未知”用作阻塞所有退出的条件；仍须通过交易本身的路由/滑点/nonce等安全检查。
- 无法换回USDG时记录residualExposure、数量、失败原因及下次重试；不放宽slippage抢跑卖出、不无限重试、不因TTL假记成功。重试沿用既有recovery的有界预算；新实验必须配置单次/总Gas上限。
- 数据源失效、链停摆或合约限制可能使保护动作失败；组合风险按全损预算设计，不声称TTL或止损提供损失上限。

## 10. 异常、可观测性与上线纪律

### 10.1 新增稳定原因/错误码

以下命名在实施规格§12登记为扩展命名空间；只读API/告警使用原因码，EM-D按列动作，不能让研究错误意外触发交易。

| 码 | 含义 | A/B/C动作；D附加动作 |
|---|---|---|
| E_EMERGING_DISABLED | 功能关闭 | API明确503；不产生信号 |
| E_EMERGING_CAPACITY | 详细采集满额 | 排队/计数，不淘汰pin |
| E_EMERGING_DATA_GAP | 水位缺口/重组待修复 | unknown、信号失效；D禁止新增并复核 |
| E_EMERGING_VOLUME_STALE | 必需事件/状态过期 | 不排序/不候选；D按§9.3处置 |
| E_EMERGING_TEMPLATE_UNSUPPORTED | 模板/hook/费用不支持 | 只展示，保留原因 |
| E_EMERGING_GATE_UNKNOWN | 证据不够 | 阻断并列缺项 |
| E_EMERGING_GATE_FAILED | 明确违规 | 阻断/失效，审计 |
| E_EMERGING_AUTH_SUSPECT | 行为异常（保留旧名称） | suspect，不能解释为诈骗确证 |
| E_EMERGING_REPLAY_INCOMPLETE | 缺tick/费率/权限/成本历史 | 回放不可放行，不补造数据 |
| E_EMERGING_BUDGET | 实验限额/累计损失不允许 | D拒绝新增，已持仓执行既定风险动作 |
| E_EMERGING_TTL_EXPIRED | 到期请求退出 | D进入exit_requested，不保证closed |
| E_EMERGING_EXIT_BLOCKED | 撤LP/结算失败 | D recovery、保留残余/占额、告警 |

### 10.2 运行与回滚

必须暴露：每流lag/重试/缺块、完整桶比例、零成交与缺数据数量、各gate覆盖率、解析unknown量、queue/pin数量、每轮RPC/字节/耗时、DB大小/归档校验、信号翻转、审计积压、回放误差。没有可用候选是正常结果，不算服务事故。

特性开关 `emergingObserveEnabled/emergingSignalsEnabled/emergingExecutionEnabled` 分离，默认全部false；只读部署可显式开前两者，第三者只有§9允许。迁移先加表/字段、保留旧读取；先影子采集/对账、再API/UI、再告警。回滚关闭新loop/展示即可，保留数据库/归档，不做破坏性回退。D启用后关闭新增入场不能停止已有持仓保护和recovery。

不能将CPU密集回放放入生产indexer请求线程。日志不包含私钥/保险库/签名材料。本需求不部署生产；将来部署遵循AGENTS.md：成功切换并健康检查后运行prune-releases.sh先dry-run再apply，保留每个适用release root最新3个，核验symlink、服务及磁盘/inode。

## 11. 文件级任务与实施顺序

新文件名为目标位置，按仓库模块习惯可微调；不要把扫描、权限、统计和回测全部塞入一个emerging.ts。共享类型只放可序列化契约，indexer不得依赖executor资金模块。

| ID | 任务 / 主要文件 | 交付与依赖 |
|---|---|---|
| EMG-A00 | 基线及能力清单；只读探测脚本/记录 | 测量发现延迟、RPC历史/日志/状态能力、样本池/模板/hook/locker覆盖；不足显式记载，不阻塞基础采集 |
| EMG-A01 | 身份/发现账本/队列；shared/emerging/types.ts、indexer/emerging.ts、main.ts | durable发现恢复、200池调度、pin/容量原因；依赖A00接口盘点 |
| EMG-A02 | 迁移/事件/水位；indexer/store.ts、emergingStore.ts、emergingScan.ts | 原始事实幂等、重组回滚、精度、token流去重；依赖A01 |
| EMG-A03 | 主体/Transfer/供给账本；emergingActors.ts | 三类来源解码、角色/聚类版本、余额核对；依赖A02 |
| EMG-A04 | API；indexer/api.ts、共享契约 | 分页/错误/新鲜度/canCreateStrategy=false；依赖A01/A02，未就绪字段unknown |
| EMG-A05 | 初始tick/费用状态、分钟/小时；emergingAggregate.ts、pool_history增量 | 各协议初始状态、共同水位、IDX-01唯一小时聚合；依赖A02 |
| EMG-A06 | 归档/保留/预算/可观测性 | 内容哈希、pin、恢复、压测；依赖A02/A05，必须先于长期采集 |
| EMG-C00 | 最小回放；indexer/emergingReplay.ts、协议适配器及fixture | 先一个支持场所，真仓位核对+虚拟仓位限制；依赖A02/A05，不能等B全部结束 |
| EMG-B01 | 模板注册/八门禁；emergingPolicy.ts、emergingGates.ts | pass/fail/unknown、逐证据时间/过期、支持矩阵；依赖A03/A05 |
| EMG-B02 | 行为/留存/企稳纯函数；emergingMetrics.ts | 方向/去重/回环/完整窗及统一阈值；依赖A02/A05 |
| EMG-B03 | 信号状态/冻结快照；emergingSignals.ts | 初次/失效/恢复、不回填候选；依赖B01/B02 |
| EMG-B04 | 观察UI、i18n；现有POOLS/STRATEGY组件 | V4独立类型、兼容旧API、无资金按钮；依赖A04/B03 |
| EMG-B05 | 只读审计；executor/emergingAlert.ts及审计去重存储 | 重启幂等、升级不抑制、无执行依赖；依赖B03 |
| EMG-C01 | cohort/manifest/时间切分；emergingBacktest.ts离线入口 | 完整前瞻全集、成本与拒绝记录、纸面组合；依赖C00/B03/A06 |
| EMG-C02 | 报告/统计/稳健性 | 每样本可复算，预登记标准三态判定；依赖C01及足够前瞻数据 |
| EMG-C03 | 各场所/模板扩展 | 每适配器独立核对及证据资格；不能借别场所报告放行 |
| EMG-D01 | 资格/配置与人工向导 | 独立执行开关、冻结manifest、当前钱包串联预检；仅C审阅通过后 |
| EMG-D02 | 组合预算/并发预留；capital-policy.ts、store.ts、创建job入口 | 所有入口检查、token聚合、残余占额、累计损失；依赖D01 |
| EMG-D03 | 无重开策略、保护退出/TTL；runner.ts、recovery.ts | 真实状态结算、过期与退出失败处置；依赖D02 |
| EMG-D04 | canary审计与暂停 | 有限预算完整链路、PnL与纸面偏差、退出演练；依赖D03及显式启用 |

关键路径：`A00 → A01 → A02 → A05 → C00`；A03/B01与聚合后B02可独立开发，B03/UI/告警随后；`C00 + B03 + A06 → C01 → C02`。首批PR优先A01/A02，再A05/C00，不先交付高APR推荐页面。具体历史/模拟能力不足只阻断对应适配器放行，基础只读工程仍可完成。

## 12. 验收与发布门槛

### 12.1 EM-A：数据可用而且可复验

- 在已配置RPC健康、非容量排队条件下，确认可见的V4发现事件到API行p95≤2min，UP33/V3≤6min；同时报告从链上创建时刻计的端到端延迟，包含确认等待。发现及时不等于门禁ready。
- 重启、窗口重叠、重复日志、崩溃于提交边界都不跳块、不重复累计；两次同块同from/to的Transfer都保留；事件整数与receipt核对精确一致，USD聚合允许的<1%仅适用于相同价格口径，不能容忍丢事件。
- 重组、扫描缺口、无成交、未闭合小时各有夹具，stale/zero/unknown区分正确；池年龄和token年龄分离，quote方向反转仍正确。
- 200池容量、同token多池、超过7d的pin、失败池保留、归档恢复都有集成验证；输出实测RPC/磁盘预算，资源超限降级不影响既有服务。

### 12.2 EM-B：证据不越权

- 八门禁各有pass/fail/unknown及过期用例；未批准模板、launcher代发、关联转移、空NFT burn、可升级locker、未知v4 owner、税币必须按规范阻断。
- 交易者router混淆、跨分钟同人、多地址组、对账缺源、完整零量、稀疏假低σ、未来才确认的低点/库存事件有对抗夹具；阈值仅一个来源。
- 任一缺失/陈旧不能产生候选；snapshot保留availableAt及版本。状态失效/恢复可复算，API和UI永远不能在A/B/C创建资金策略。
- B05按code/signal修订持久抑制，故障/重启不重复，严重状态不被24h压制；依赖检查证明没有新增签名/计划资金入口。

### 12.3 EM-C：核算正确与策略有效分别验收

- C0夹具覆盖：双向quote、跨tick、多次进出区间、竞争者加减仓/JIT、零成交、费用扣除、舍入、动态费率变化（支持时）、退出失败；至少一笔真实仓位逐项对账到协议舍入精度。
- 不能仅用同一个实现生成expected值再断言相等；对照独立协议调用/已知链上receipt/fork执行结果。无可靠archive条件则该适配器标unsupported。
- 用构造前视/幸存者偏差数据证明：未来识别不改过去信号、失败池不消失、同token不跨分集、成本/费用不双计、无路线残余不按中价变现。
- manifest、输入hash、脚本版本、全部尝试配置、每样本输出齐全，可在离线环境重复得到相同结果。报表准确输出§7.5三态，样本不足仍是工程交付成功，不能伪造通过。

### 12.4 EM-D：独立验收，当前不开放

必须测试并发超额、修改strategyId绕限、同币多池、残余占额、重复TTL、indexer失联、quote失效、撤LP成功但卖出失败、服务重启恢复及预算耗尽。真实canary需要人工确认入场，按受限预算完成mint到USDG结算；未通过退出能力/审计核对不得扩大。只支持报告中明确通过的模板与场所。EM-D0 的验收即本段链路测试本身；通过仅代表执行链路可用，不改变 §7.5 三态判定对扩量的约束。

### 12.5 交付检查矩阵

| 检查 | 运行要求 |
|---|---|
| 类型/前端构建 | 涉及共享类型/API/UI时执行npm run typecheck及npm run build |
| indexer单元/集成 | 新增测试纳入当前测试入口；若使用子目录确保runner能发现，覆盖robinhood及BSC禁用回归 |
| executor边界 | B05或D变更执行npm run test:strategy及针对新模块的测试；B阶段不得新增资金副作用 |
| 只读smoke | 显式CHAIN=robinhood；使用预登记池/区块、预算限额及无签名账户，不需要生产私钥 |
| 文档/配置一致 | 对照本PRD门禁ID、原因码、参数版本、API语义、保留期限及任务依赖 |

## 附录 A：术语与语义迁移

| 旧术语/说法 | v2契约 |
|---|---|
| dev清仓完成 | 已标记关联主体库存下降，带身份/余额证据，不保证全部内幕供给消失 |
| 量真实pass | 未发现指定异常，数据质量和行为风险分开 |
| LP销毁 | 检查实际不可撤仓位与有效深度，NFT burn不能证明 |
| 入场确认 | A/B/C仅watch_candidate，无创建策略能力 |
| 费用≥IL即有效 | 全成本USDG现金流、独立样本外、组合尾部及退出证据 |
| TTL强撤成功 | TTL请求退出，直到残余处置完才closed |
| score/APR | 过去6h净费用观察比率，不是仓位预测收益 |

## 附录 B：评审决议及未完成项

| 原评审项 | 已落实 | 剩余证据工作 |
|---|---|---|
| 窗口是否可捕获 | §1/6/7定义可证伪假设、真实确认延迟、基准 | 前瞻样本；可能得到reject |
| 门禁完备性 | §5八门禁、模板范围、hook/locker/关联主体 | 实际部署模板及锁仓审阅，默认不批准 |
| 量真伪 | §5.4置信边界、去重解析、独立对账 | resolver覆盖及阈值训练 |
| 回测偏差 | §3/4/7固定全集、availableAt、pin、时间切分 | 原始数据与已验证协议适配器 |
| 风险遗漏 | §9退出结算、失联、重开限制、残余占额 | D状态机和恢复演练 |
| 资金参数 | §9单token0.25%、总1%、累计亏损门槛、绝对预算 | C证据及显式实验启用，当前无资金授权 |
| 阈值占位 | §6版本化初值，§7预登记校准 | 样本不足不放宽结构门禁 |
| 证据窗口（60+28天）过长 | 拆分为 EM-D0 微型试验（观测健康运行 ≥3 天门槛，§9.1）与 §7.5 扩量证据两层；D0 不构成盈利证据 | D0 结果仅验链路与退出能力；扩量仍需完整前瞻证据 |

## 附录 C：方法依据（核对日期2026-09-19）

- [Uniswap v4 PoolManager与singleton](https://developers.uniswap.org/docs/protocols/v4/concepts/poolmanager)：日志/身份适配依据。
- [Uniswap v4事件与接口](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol)：Swap、ModifyLiquidity、费用与sender语义；实现时固定依赖commit，不能仅引用main作为审阅证据。
- [V3 PositionManager源码](https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol)：费用归属、清空后burn规则；按目标部署版本核对。
- [LVR原始论文](https://arxiv.org/html/2208.06046v5)：恒定乘积与CL模型、IL/LVR区分。
- [OpenZeppelin权限模型](https://docs.openzeppelin.com/contracts/5.x/access-control)：owner与角色权限的区别，不构成任意token安全认证。

这些资料用于协议/方法定义，不证明本链具体部署安全或本策略收益。开发阶段的每个模板、协议适配器及版本都须形成自身可复验工件。
