# LP Terminal 系统评审与改进路线图

> 评审日期：2026-09-07
> 评审视角：DeFi / Web3 LP 从业者
> 文档性质：独立技术评审。结论分三类标注 ——「已核实」为评审人直接读码确认；
> 「高置信」为深度读码审计结论（含证据行）；「建议」为从业者判断。
> 行号引用以评审时 main 分支（`562e340`）为准，代码演化后可能漂移。

## 0. 方法与范围

评审覆盖仓库全部子系统，约 10 万行 TypeScript：

| 子系统 | 位置 | 规模 |
|---|---|---|
| Web 终端（React SPA） | `src/`（含 lib/hooks/components/tabs） | ~54k 行 |
| 池索引器（SQLite + HTTP API） | `indexer/` | ~26k 行 |
| 无人值守策略执行器 | `executor/` | ~10k 行 |
| 共享策略/推荐引擎 | `shared/` | ~3k 行 |
| 冒烟/链上校验脚本 | `scripts/` | ~4k 行 |

评审方式：通读 README（946 行）与链配置（`src/config/chains/*`，每条链地址均有链上验证注释）；
对 executor、indexer、web 资金路径、推荐/量化引擎四块做独立深度读码（子代理），
关键安全/数学断言由评审人逐一到源码核验；未跑通实时链上冒烟（`npm run smoke:*` 属带网操作，不在本次静态评审范围）。

---

## 1. 总体评价（Executive Summary）

**结论先行：这是一套工程素养远超绝大多数 DeFi 产品的"个人资金操作系统"，
但还不是一套想清楚了"为谁服务、靠什么赚钱、凭什么决策"的产品。**

它的强项全部集中在**执行与安全工程**——fail-closed 的链身份校验、快照 provenance、
抗价格操纵的定价轨、journal-first 的无人值守执行、精确授权与恢复语义，都是教科书级。
它的弱项集中在**决策质量与产品模型**：数据是第三方 top-N 快照且永不过期、
推荐/排名的量化口径存在已核实的偏差、P/L 口径会被后来的价格追溯改写、
在 ve(3,3) 链上却不提供治理闭环、费用模型（10% 收入抽成）未在任何文档披露。

一句话比喻：这是一台精密、自带黑匣子与恢复舱的自动驾驶卡车，
但导航只收录"前 200 名热门路段"，车速表还有已知的系统误差，
且它更擅长"把车安全开向目的地"而不是"决定该不该去"。

---

## 2. 值得肯定之处（Strength Inventory）

以下均为「已核实」（评审人直接读码/读文确认）。

### 2.1 链配置的可审计性（已核实）

- `src/config/chains/robinhood.ts` / `bsc.ts` 中**每条合约地址都带链上验证注释**
  （验证日期、通过哪个 accessor 交叉验证、与哪些仿冒品区分）。
  BSC 的 v2 fee（2500 vs 3000 ppm）、UP33 tick-spacing-keyed vs Pancake fee-keyed
  这种"两个 DEX 槽、四种 ABI 形状"的差异被显式建模（`ChainConfig.homeCl.keyedBy`、
  `homeV2.feePpm`、`assertRoute`），而非散落在调用点。
- `docs/up33-contract-map.md` 是全仓库最好的文档：每个用户动作 → 精确调用序列，
  且记录"文档 vs 链上差异"（gauge cap Enforced、动态费率实为静态 override、
  CL 未质押 10% levy、治理高度集中）。**把"参数随时可变"当默认假设**是对的。

### 2.2 索引器的抗操纵定价轨（已核实）

- 2026-07-22 单池 `$3.5e50` 假价事故后建成的四道堤坝（`indexer/state.ts` 头注）：
  spot 可用性门槛（无 in-range 流动性/贴边界 tick 无投票权）、
  BFS-by-hop 最短路定价、credible-dollar 深度（防"假价制造假深度"）、
  depth-weighted median（单池需压过诚实池总和才能移动价格）。
- 每次 `reprice()` **全量重建**池推导价格，污染无法跨周期存活（`state.ts:590-727`）；
  发布原子（单事务）。
- 快照 provenance：canonical RPC block-hash 钉住、count-exactness、boot 重验、
  destructive rewind 拒绝（`v3Subgraph.ts`、`v4Subgraph.ts`、`catalog.ts`），
  且 README 诚实声明"不声称密码学完备"。

### 2.3 前端资金路径的安全细节（已核实）

- `src/lib/swapExec.ts` / `tx.ts`：exact-amount approval（非无限授权）、
  Permit2 双授权带 1h 过期、approval 后 **re-prepare + spender/token 身份复检**
  （防市场变动后带陈旧 calldata 签名）、发送前 requireSender（防换账户后
  新账户为旧计划买单）、广播后 min-out 三方校验
  （展示 floor、执行前 re-quote、链上 min、收据 Transfer 实测）。
- `tx.ts` 的"已广播但连接断 ≠ 失败"语义、`swapSubmissions` 去重、
  >10% 滑点二次确认（`swapGate.ts`）、quote-freeze 防陈旧报价接管
  （`solverRefresh.ts`）——比多数交易所前端严谨。

### 2.4 无人值守执行器的 journal-first 设计（已核实）

- 计划是 **intent-only**（`planner.ts`：不预签 calldata），每步执行前重建 calldata；
- tx hash 先落库再广播，恢复按 hash/nonce/calldata 对账，ambiguous 交易绝不重发
  （`executor/supervisor.ts`、`executor/recovery.ts`、`executor/recovery-runner.ts` 98KB）；
- 钱包级资金守恒不变量（`E_ALLOCATION_MISMATCH`，`store.ts:817-917`）；
- signer 只存于 AES-256-GCM vault（scrypt）+ 0600 文件，loopback 绑定、
  origin 过滤、admin token 与 wallet 会话分离（`executor/config.ts`、`vault.ts`、`wallet-auth.ts`）。
- `ORIGINAL` 快速流由服务端强制 recommendedSafeguards（`executor/simple.ts:78-110`）
  ——把"窄带 ±5% + 零确认 spot trigger 在 gas 翻倍时 48h churn 20-44 次、
  gas 吃掉 17-24% 净手续费"的真实事故（README/`schema.ts:91-104`）固化成默认防护。

### 2.5 文档与工程文化（已核实）

- README 有专门的 **Known v1 limits** 章节，不隐藏缺陷；
- 每个环境变量/调参旋钮都有注释与测量依据（`indexer/config.ts` 每个 cadence 都有"为什么"）；
- 138 个测试文件、~11k 行 indexer 测试覆盖定价轨/快照/API 契约；
- 代码中大量"为什么不用 X"的注释（如 v2 为什么用 sweep 而非 explorer、v4 为什么用
  CLOSE_CURRENCY 而非 SETTLE_PAIR——后者基于实测 5 个 out-of-range 仓位全部 revert）。

---

## 3. 深层问题（The Soul-Level Critique）

### 3.1 它是执行机器，不是决策系统——而 LP 的两难恰恰是决策（高置信）

一个 LP 只问两个问题：**这个池的手续费收入是否值得它的无常损失（LVR）？
我到底该不该在这里，而不是直接持有？**

现状：
- 推荐/排名宇宙 = Robinhood **前 100 TVL** + BSC **前 12 成交量**（`indexer/poolRank.ts:184-239`），
  幸存者偏差固化：没有失败池、没有退市记录、没有真实回测。
- 收入模型（`shared/recommendation/model.ts:374-387`）用池面 vol × 固定份额 ×
  仅按 downtime 打折的 in-range 比例，**没有区间内成交量占比项**；
  `replayRange` 的 recenter 免费且瞬时（`model.ts:202-244`）→ 窄带被系统性高估，
  argmax 出的推荐必然偏窄带；**入场成本从不计费**，只计 reopen（`model.ts:385-386`）。
- 期望 IL/LVR 从不从净收益里扣；"CVaR95"实为重叠加窗最大回撤均值，样本有效数极小
  （`model.ts:262-311`），风险权重 1/0.5/0.2 未校准。

**最深处的问题：系统可以"完美地执行一个错误的开始"。**

### 3.2 σ 单位错误 → 覆盖率高估约 4 倍（已核实）

`indexer/poolRank.ts:314` 的 UP33 行取 `Number(d.sqrtPrice)` 的对数收益作为日波动率；
而头注（:24-25）声称测的是"池汇率"（exchange rate）。子图 `sqrtPrice` 字段是
**价格的平方根刻度**（Q64.96 定点 √price，或 v3-schema 语义的 √(token1/token0)）。
对 √price 取对数收益 ≈ 对 price 取对数收益的一半 ⇒

- `sigmaDaily` 低估约 2 倍 → `sigmaAnnual²/8`（LVR benchmark 分母）低估约 4 倍
  ⇒ **`coverage = feeApr / (σ²/8)` 高估约 4 倍**（`poolRank.ts:129-133, 341`）；
- `LVR_FLOOR = 1`（`model.ts:34, 362, 415`）实际退化为 ~0.25 的地板——
  保守型用户可能被推荐给"跑输对冲再平衡者"的池子。

v3 腿（:381-393）用 GT token-currency OHLCV close 是对的；UP33 腿没有对应修正。
**修复方向**：对 √price 系列平方后取收益，或用与 v3 腿相同的 token-currency close。

### 3.3 数据护城河是借来的、有时效的、不可自我审计的（已核实）

- 成交量 100% 依赖 GT/DexScreener 的 top-N 榜单（README:626-628 自认：
  BSC ~2.6M Swap 事件/天，自算 vol 被刻意跳过）→ 长尾池无 VOL/FEES/APR 列。
- **没有 per-pool 价格/OHLCV 历史表**：`tokens` 表只存最新价（`indexer/store.ts:72-81`）；
  `pool_tick_samples` 只覆盖 analytics 队列（~80 池）。
- **种子价永不过期**（已核实）：`state.ts:598` 的种子装载只看 `price_src <> 'pool'`，
  不看 `price_updated`——一个跌出 GT 榜单的代币带着最后一次 GT 价**永久当 credible root**，
  与 README"GT+USDG 是唯一 CREDIBLE seeds"（README:556-558）的表述冲突。
- **`pool_stats` 只写不衰**（已核实）：`store.ts:2370` 的 upsert 仅在匹配时覆盖，
  仓库无任何过期/清零路径（grep 验证）→ 死池的 `vol24h_usd` 永久保留，
  永久留在 hot 扫描集（`store.ts:2650-2684`，`hotAddrs` 无 recency 过滤）、
  永久参与 `sort=vol` 排名、永久显示假的 VOL/FEE-APR 列。
- **渐进式目录 TVL = 新鲜余额 × 最多 24h 前的价格**：全量 reprice 为日频
  （`config.ts:98`），余额刷新分钟级（`main.ts:441-466`）→ 两次 reprice 之间
  排名 TVL 用新鲜分子 × 陈旧分母，可漂移。
- **hop-1 quote 深度用整池余额**（已核实，`state.ts:634-637`）：v3 池的 ERC-20 余额
  包含 out-of-range 与捐赠部分——灰尘 in-range + 大额闲置余额的池可声称远超
  真实可成交深度的权重（`v3SpotOk` 只要求 `liquidity>0`，`state.ts:402-409`）；
  单报价 token 绕过 median 保护（`state.ts:424`）；USDG 锚 $1 无 depeg 感知。

### 3.4 P/L 口径会被后来的价格追溯改写（高置信）

- 历史 gas 的美元化用**当前价**一次性折算（`executor/performance.ts:147-174`，
  代码自身带 `gas_quote_current_price` 警告，:521）→ 30 天曲线、日历日收益
  （`executor/calendar.ts` 5 分钟快照差分）会被后来价格运动追溯改写，
  把行情波动错记为策略表现。
- baseline 兜底会**伪造 P/L**：无 baseline/mint-basis 时回落到
  "首次 principal_exit 按退出价估值"（`performance.ts:282-292`）；
  profit withdrawal 只认 USDG/WETH/ETH，抽到其他稳定币直接丢失（:294-299）。

### 3.5 无人值守执行的最大敞口：公开内存池多笔交易 + 无 MEV 保护（高置信）

执行器每周期为多笔**顺序公开交易**（decrease→collect→swap→mint，`runner.ts`），
在 BSC 三明治机器人横行的链上跑 meme/股票池。保护仅 per-swap minOut，
而 **recovery 会把滑点逐次放宽到 1000 bps 且不再复查 impact 上限**
（`executor/swap-escalation.ts:12-17`）。叠加：

- 钱包锁是**进程内**的（`wallet-lock.ts:1-21`）——双进程共享 data dir 可双签 nonce；
- reorg 深度不监测：本地 `confirmed` 行不对 head 回退复查；
- nonce 与链外钱包活动竞争，恢复反复撞 "nonce too low"；
- 队列期间价格已回区间的 job 仍会执行（trigger 不在执行时重验，`runner.ts:96-105`
  只查 tokenId/liquidity）→ 无效 recenter 烧 gas。

recovery/收据/隔离是**对症治疗**；药方是原子执行、私有结算、或更少但更高质量的周期。

### 3.6 收入模型是隐式的，且未披露（已核实）

- `executor/fee-tax.ts:7-8`：`FEE_TAX_BPS = 1_000`（10%）；阈值 Robinhood `1_000_000n`
  （=1 USDG, 6 位小数），BSC `10^decimals`（=1 USDT）。**收入 > $1 即抽 10%**。
- 界面称 "income tax" / "net income after tax"（`src/i18n/en.ts:289`），
  **README 与 .env.example 只字未提**；扣除的 USDG 留在钱包但**不进 allocations、
  不参与资金守恒检查、无独立 treasury 账**（executor 审计结论，runner.ts:654-665
  仅记 ledger `income_tax` 行）。
- 前端 swap/zap 0 bps 且 `KYBERSWAP_FEE_RECEIVER` 为构建硬性要求
  （vite.config 校验格式）——费用语义若为运营抽成，**必须在用户开策略的第一屏讲清**。

### 3.7 在 ve(3,3) 链上却只读 ve(3,3)（已核实）

UP33 排放方向由投票决定，本终端读透 gauge/rewardRate、做好质押，
但锁仓/投票/bribe 全部只读（README:924 "later versions"）；
合约接口在 `docs/up33-contract-map.md §4.2-4.3` 全部就绪。LP 赚多少 UP 取决于
别人投票，而自己不能投——丢掉了 ve(3,3) 的一半收益决策。

---

## 4. 子系统审计要点

### 4.1 Executor（无人值守执行器）——TOP 问题

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| 1 | 资金 | 公开内存池顺序 exit/swap/mint，无 MEV 保护；recovery 滑点放宽至 1000bps | `runner.ts`; `swap-escalation.ts:12-17` |
| 2 | 资金 | `original`（unguarded）配置可零 min、无 plan expiry 执行 | `steps.ts:104-106`; `runner.ts:103` |
| 3 | 资金 | 钱包锁仅进程内，双进程可双签 | `wallet-lock.ts:1-21` |
| 4 | 资金 | recovery re-quote/send 在 1000bps 内无 impact 复检 | `recovery-runner.ts` sendRecoverySwap |
| 5 | 正确性 | reorg > confirmations 后本地 confirmed 不复查 | `signer.ts:27` |
| 6 | 正确性 | nonce 与链外钱包活动竞争 → 反复 "nonce too low" | `signer.ts:88` |
| 7 | 效率 | 队列期间价格回区间仍执行 recenter | `runner.ts:96-105` |
| 8 | 记账 | 10% 抽成留钱包但未入 allocations/无 treasury 账 | `fee-tax.ts`; `runner.ts:654-665` |
| 9 | 运维 | 单 RPC + 单聚合器依赖，无 failover | `chain.ts:27-36` |
| 10 | 运维 | 无推送告警/kill-switch 仅 API | `executor/api.ts` |

### 4.2 Indexer（池索引器）——TOP 问题

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| 1 | DoS | 单线程同步 SQLite + 无鉴权：非 canonical 参数使 recommendation-candidates 内联跑 ~30s；token 搜索实测 3.6-29.4s 阻塞事件循环 | `api.ts:3208-3226, 2878-2888` |
| 2 | 数据 | credible 种子永不失效；GT/DexScreener 旧价成永久根 | `state.ts:595-600`; `store.ts:2246-2250` |
| 3 | 数据 | `pool_stats` 无过期；死池 24h vol 永久驱动排名与 hot 扫描 | `store.ts:2370-2415, 2650-2684` |
| 4 | 数据 | 渐进式目录 TVL = 新鲜余额 × ≤24h 旧价；长尾多数无 state | `config.ts:98`; `state.ts:756-770` |
| 5 | 操纵面 | hop-1 深度=整池余额（含 out-of-range）；单报价 token 无 median 保护；USDG 锚无 depeg 感知 | `state.ts:634-637, 424, 601-604` |
| 6 | 资源 | ≤250k 目录每 5min 全量 reprice + coalesced 追跑 ≈ 连续运转；无 VACUUM/checkpoint 维护 | `main.ts:485-494`; `coalescingScheduler.ts:49-58` |
| 7 | 一致性 | reprice worker 全表发布事务与 API 靠 30s busy_timeout 互斥；SIGTERM 不 drain | `store.ts:13-21`; `state.ts:699-719`; `main.ts:625-633` |
| 8 | API | `/api/pools` 首页按 TVL 排序，续页按地址游标——两页排序语义不一致；count 逐页重算 | `api.ts:846-881` |
| 9 | 队列 | hydration 退避行被持续"刷新"占据裁剪位，恶意/空返回 token 可饿死合法需求 | `store.ts:2551-2564` |
| 10 | 依赖 | BSC keyless 单公共 RPC SPOF；THEGRAPH_API_KEY 缺失即 boot 失败 | `config.ts:184-186`; `v3Subgraph.ts:191-195` |

### 4.3 Web 资金路径——TOP 问题

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| 1 | 资金 | solver = 托管：allowance 流经固定 AllowanceHolder 给**服务器自选的 settler**，内层 calldata 不校验——solver 被攻破/被 MITM 可抽走已授权额度 | `solver.ts:436-455` |
| 2 | 资金 | home-CL swap 的 recipient 为 `zeroAddress`（v2/v3 腿用 router 中转），sweep 结算语义仓库内无法证明 | `directSwap.ts:948` |
| 3 | 资金 | bridge 对 keyless HTTP 返回的 calldata 按原样签名，无合约身份 allowlist；Relay `expiresAt` 可 null | `bridge/across.ts:46-64`; `relay.ts:50-57`; `exec.ts:49` |
| 4 | 资金 | native 输出 swap 跳过收据后 min-out 校验 | `swapExec.ts:185, 285` |
| 5 | MEV | min-out 锚定展示报价而非执行报价；薄池 10-50% 容忍度可远低于展示价成交 | `swapGate.ts:8` |
| 6 | 并发 | pending 条目在广播后才持久化 → 双标签近同时双击可双发 | `SwapTab.tsx:433-446` |
| 7 | 语义 | "LIMIT"实为 LP range order：回撤反向成交、无自动执行、需手动 withdraw 落袋；标签仅 localStorage | `limit.ts:54-85` |
| 8 | 兼容 | FoT/rebasing/先 0 后 approve 类代币在自定义 token 路径不支持 | `tx.ts:297-307` |
| 9 | UX | 除 solver 外无签名前 eth_call 模拟/预估 gas 展示 | — |
| 10 | UX | v2 remove-liquidity 的 min 取自缓存储备 → >1% 波动即 revert（仅 gas 损失） | `PositionsTab.tsx` ~:1920 |

### 4.4 推荐/量化引擎——TOP 问题

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| 1 | 量化 | UP33 σ 用 √price ⇒ coverage 高估 ~4×，LVR_FLOOR 失效 | `poolRank.ts:314-315, 341` |
| 2 | 量化 | 期望 IL/LVR 从不从净收益扣除；"CVaR"是未校准的加窗回撤启发式 | `model.ts:306-311, 388-390` |
| 3 | 量化 | 窄带手续费高估（无 in-band vol 项、recenter 免费瞬时）⇒ band/pool 选择有偏 | `model.ts:374-381, 202-244` |
| 4 | 量化 | coverage 用 gross（税前）feeApr；close-to-close σ 低估日内 | `poolRank.ts:339-341` |
| 5 | 偏差 | 幸存者偏差宇宙（top-100 TVL / top-12 vol），无失败池、无回测 | `poolRank.ts:184-239` |
| 6 | 记账 | 历史 gas 按当前价重估 ⇒ 累计 P/L、日历、曲线被追溯改写 | `performance.ts:147-174`; `calendar.ts:54-71` |
| 7 | 记账 | baseline/withdrawal 兜底伪造或漏计终身 P/L | `performance.ts:282-299` |
| 8 | 成本 | 无入场成本；成本画像样本少且按 start 资金归一；默认值无依据 | `model.ts:385-386`; `executor/recommendation.ts:48-73` |
| 9 | 数据 | UP 价格 mark 陈旧 ⇒ emitApr 与 rewards 投影失真 | `api.ts:3329-3331` |
| 10 | 展示 | 头条显示未风险调整的 netUsd；跨 fees/rewards 模式与不等宽 band 混排 | `RecommendationsTab.tsx:37-40, 127` |

---

## 5. 改进路线图（按优先级）

### 🔴 P0 — 资金安全（先修，再谈功能）

1. **执行器周期原子化/私有化**：out-of-range 退出做成单笔 atomic（v3 multicall 全退 +
   v4 单笔 `modifyLiquidities`），swap+mint 尽量收进一笔；BSC 接入私有交易/MEV-share；
   recovery 滑点爬升每次复查 impact 上限而非仅 minOut（`swap-escalation.ts`）。
2. **执行时重验 trigger**：job 排队期间价格回区间 ⇒ 放弃并释放，不无效 recenter
   （`runner.ts:96-105` 现只查 tokenId/liquidity）。
3. **进程级钱包租约**：wallet-lock 落 DB/文件锁 + fencing token，杜绝双进程双签
   （`wallet-lock.ts:1-21`）；执行前对 pending nonce 做链上对账。
4. **消除无防护模式可达性**：`safeguards.enabled=false` 时零 min、无 plan expiry
   （`steps.ts:104-106`; `runner.ts:103`）——把"无防护"改为显式红色二次确认状态；
   ORIGINAL 快速流已强制 recommendedSafeguards（`simple.ts:78-110`），编辑器需同标准。
5. **reorg 回退监测**：本地 confirmed 行周期性对照 finalized head，超深回退进 quarantine。
6. **10% 抽成去向与披露**：明确为平台费并在创建策略时展示净收益口径，或改为可配置；
   被扣 USDG 纳入 allocations 或独立 treasury 账户并接受守恒检查
   （`fee-tax.ts`; `runner.ts:654-665`）。

### 🟠 P1 — 量化正确性（决策可信度）

7. **修 σ 单位 bug**：UP33 σ 对 price（√price 平方后取对数收益）而非 √price；
   或改用与 v3 腿一致的 token-currency close（`poolRank.ts:314`）；修后重标 `LVR_FLOOR`。
8. **净收益扣除期望 IL/LVR + 入场成本**：用每池 σ 与区间宽度给闭式 IL 期望，
   把 `riskAdjustedNetUsd` 从"CVaR 启发式"改为"期望收益 − 期望 LVR − 入场成本 − 周期成本"。
9. **区间内成交量占比**：用 `liquidityDistribution` 的 tick 流动性数据估算 band 内成交比例，
   `grossFeeUsd` 乘该比例，消除窄带系统性高估（`model.ts:374-381`）。
10. **成本画像用 cycle 实际资金归一**，无样本时降置信而非回落默认值
    （`executor/recommendation.ts:48-73`）。
11. **P/L 逐笔钉价**：历史 gas/费用按发生当时价格折算（ledger 有 blockNumber 可查），
    曲线/日历基于冻结估值，不被当前价追溯改写（`performance.ts:147-174`; `calendar.ts`）。
12. **baseline 兜底不造假**：无可靠 baseline 时拒绝计算并标 `not_tracked`，
    与 STRATEGY HISTORY 现有语义一致（`performance.ts:282-299`）。

### 🟡 P2 — 数据层（5 年后价值所在）

13. **自索引 Swap/费用数据**（README:626-631 已自认方向）：接 Envio HyperIndex
    （原生支持 chain 4663）。目标：per-pool 真实费用时间序列（fee APR 从链上算）、
    任意池 OHLCV/价格历史表（回测/IL 归因/操纵审计前提）、长尾池 24h volume。
14. **种子与统计保鲜期**：种子价带 `price_updated` 时效（>4h 降级/剔除，
    `state.ts:595-600`）；`pool_stats` 引入 age-out，死池从 hot 集与 `sort=vol` 消失
    （`store.ts:2370-2415, 2650-2684`）。
15. **定价轨补漏**：hop-1 深度上限 = 真实 in-range 可成交深度而非整池余额
    （`state.ts:634-637`）；单报价 token 至少要求两条独立路径；GT 种子与深池链上 spot
    交叉验证；USDG 锚引入 depeg 感知。
16. **索引器运维**：重型查询走 worker + per-IP 限流；reprice 发布与 API 间加队列；
    VACUUM/checkpoint 维护；优雅停机 drain（`api.ts:3208-3226`; `main.ts:625-633`）。

### 🔵 P3 — 产品功能（LP 每天会用的东西）

17. **持仓级 IL/LVR 仪表盘 + 对照基准**：每张 POSITIONS/STRATEGY 卡给出
    `vs 50/50 HODL`、`vs 全区间 LP`、`vs 对冲再平衡`对照；把 `marketAndLpQuote` 残差
    拆成"IL vs 价格变动"两个可解释数字（`performance.ts:509`）。
18. **真实历史回测**：用已存的 `pool_tick_samples` 做"此策略在过去 30 天跑一遍"
    drill-down（费用/reopen/LVR/gas 全扣）；`simulator.ts` 是线性路径玩具
    （`simulator.ts:50`），不作为决策依据。
19. **ve(3,3) 治理闭环（Robinhood）**：veUP 锁仓/加仓/延长 + 投票 + bribe/claim；
    至少做锁仓 ROI 对比（锁定投票 vs 直接质押 LP）与
    "该池排放下周会不会断"信号接入 RECOMMEND rewards 模式。
20. **提醒与告警**：range order 成交进度、策略 guard 暂停/进入 recovery/quarantine 推送
    （现仅轮询 `/status` 或手动看 RECOVERY 队列）；indexer `corruptTvlPools` canary 告警。
21. **浏览器持仓成本基准**：POSITIONS 增加买入成本/已实现/未实现 P/L；
    补齐 v2 remove-liquidity 管理（README:929-931 自认未接线）。
22. **架构收敛**：前端终端 + 双链索引器 + 无人值守执行器 + solver 客户端 + 隐藏的 bridge
    已超"个人终端"边界——明确产品定位：个人工具则砍未上线复杂度；
    做产品则先清 P0/P1 并补费用披露与用户协议。

---

## 6. 结论

这套系统最动人的地方与最大的问题同源：**作者把"安全"理解为工程问题，并解决得极好；
但 LP 业务的真正风险——选错池、做错区间、算错 LVR、错过行情——是数学与决策问题，
目前被工程安全感盖住了。** README 对"假数据"的警惕（定价轨、provenance）令人敬佩，
但同样的警惕尚未延伸到"真实但过期的数据"与"自洽但错误的模型"（σ 单位、P/L 追溯重估）。

若只做三件事，排序：**① 让推荐与持仓评价建立在真实费用/价格历史上（P2-13 + P1-7/8）；
② 给无人值守执行器装上原子与私有执行（P0-1/2）；③ 在每个收益数字旁放 HODL 对照线（P3-17）。**
前两件决定资金是否安全，第三件决定用户是否真的知道自己在赚什么钱。

---

*本文档由独立评审生成，仅供仓库所有者参考；行号引用以评审时 main 分支为准。*
