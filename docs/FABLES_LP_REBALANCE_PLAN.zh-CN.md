# Fables LP 自动再平衡需求与实施计划

> 状态：实施中；A～C 的合约与 fork 验证记录见 [FABLES_IMPLEMENTATION_EVIDENCE.zh-CN.md](./FABLES_IMPLEMENTATION_EVIDENCE.zh-CN.md)，D～E 尚未验收
>
> 日期：2026-09-26
>
> 适用：Robinhood Chain（chain ID 4663）上的 Fables 集中流动性仓位
>
> 与现有策略的关系：[LP_STRATEGY_REQUIREMENTS.zh-CN.md](./LP_STRATEGY_REQUIREMENTS.zh-CN.md)、[LP_STRATEGY_IMPLEMENTATION_PLAN.zh-CN.md](./LP_STRATEGY_IMPLEMENTATION_PLAN.zh-CN.md)

## 1. 目标和边界

用户为**已有 Fables LP 区间**启用策略后，executor 持续读取该仓位及池的链上状态。价格离开区间并满足用户设置的越界确认条件时，executor 自动完成：

1. 核实旧区间、所有者、份额、池身份和执行钱包余额；
2. 全额退出旧区间，将本金提到策略钱包；
3. 领取旧区间的全部可领取交易手续费，并核对实际到账；
4. 以退出后重新读取的价格计算新区间，按实际可用资产调整两侧比例；
5. 向**同一个 Fables 池**存入新区间，并核实新份额。

这一循环可反复执行。**不预测 Fables 动态交易费率，不以 APR、预计手续费或手续费覆盖 gas 成本作为越界后的执行前提。** 手续费只作为链上应收及实际到账金额记账。越界确认、滑点、gas 余额、交易时效、路由和资产身份检查仍然生效。

首期支持未质押的 Fables 区间份额；支持已经由 Fables 官网创建的仓位。首期不实现跨池迁移、Fables 积分/未来排放领取、自动质押、单币 zap 或 Fables 新池创建。当前官方文档将质押、投票和代币排放列为计划中的功能，不应把 UP33 奖励逻辑套用到 Fables。

手续费领取到策略钱包后，沿用现有 `fees.handling`：`convert_to_quote` 转为计价币并保留、`hold_tokens` 保留原币、`reinvest` 才进入新 LP 本金。界面应展示实际领取的净额与相应处理结果；这三种设置都不影响越界触发。

## 2. 已核实的协议事实与开工验证

Fables 池使用 Robinhood Chain 的 Uniswap v4 PoolManager，但官网 LP 仓位由每个池的 hook 维护为**同一 tick 区间共享的 ERC-6909 份额**，不是 Uniswap v4 PositionManager NFT。池身份是完整 PoolKey 与 PoolId，不能仅凭共享的 PoolManager 地址识别。官方文档说明了 `deposit`、`withdraw`、`withdrawAndClaim`、`claimFees` 的行为；当前官网前端 ABI 还使用 `rangeId`、`rangeKey`、`balanceOf` 和 FablesLens 的 `userRanges`、`quoteWithdraw`、`poolHeads`、`canClaim` 读取仓位。

| 事实或接口 | 实施含义 | 交付前验证 |
| --- | --- | --- |
| `PoolKey = currency0/currency1/fee/tickSpacing/hooks`，`PoolId` 为其哈希 | 池必须通过 registry 白名单和链上 PoolId 反算核对 | 逐池核对官网、registry、PoolManager、StateView；拒绝未登记或已停用池 |
| `rangeId` 对应池与 tickLower/tickUpper；一个区间可能有多个持有人 | 策略记录用户份额，不把池总流动性当成用户流动性 | 用 `rangeKey`、`balanceOf`、lens 的 `shares/totalShares/totalStaked` 交叉核对 |
| Hook ABI 的 `withdraw` 参数名为 `liquidity`；官网前端用用户 `shares` 作为该参数 | 不可按 v3/v4 NFT 的 liquidity 字段直接编码 | 对已验证合约源码/ABI及主网 fork 进行全额、部分和边界舍入测试 |
| 较新的池提供 `withdrawAndClaim`；较早池撤出本金后费用仍待 `claimFees` | 退出调用按**实际池能力**选择；旧池允许零本金但仍有待领费用 | 每个首期池验证收款语义、暂停时行为、费用领取后余额归零 |
| 新版 `withdrawAndClaim` 在池暂停时会拒绝，普通 `withdraw` 仍可退出本金但没有 `maxFeeBps` 上限 | 自动流程遇暂停先停留并提示；不得静默改用无费用上限的普通退出 | 主网 fork 验证暂停路径；紧急退出作为单独的用户操作 |
| `canClaim` 返回费用与手续费上限信息 | 领取前读当前值并设置 `maxFeeBps`，费率变化导致 revert 时重新读链 | 不使用文档里某日的费率作为交易常量 |
| Fables 的 swap fee 随交易变化 | 不把 v4 动态费标记 `0x800000` 解释成固定 ppm | 本功能完全不依赖费率预估；展示历史收益另行计算 |

官网资料：[仓位管理](https://www.fables.fi/docs/managing-positions)、[合约与地址](https://www.fables.fi/docs/contracts-and-addresses)、[费用与收益](https://www.fables.fi/docs/fees-and-returns)、[安全说明](https://www.fables.fi/docs/security)。[DeFiLlama Fables 适配器](https://github.com/DefiLlama/dimension-adapters/blob/master/dexs/fables.ts)从 FablesPoolRegistry 枚举池，并说明这些仓位不在 Uniswap PositionManager 的池键目录中。

**开工验证门：**在写自动签名调用前，固定首期支持的池清单，核对官网公布的 hook/registry/lens 地址、链上 runtime bytecode、已验证合约源码、ABI、当前池状态和每个写方法的实际参数含义。官网前端资源可辅助研究，不能单独作为生产资金操作的合约规范。若任一首期池无法完成验证，该池保持只读，不进入自动执行白名单。

## 3. 用户流程与产品要求

### 3.1 发现与启用

- “仓位”和“策略”页列出钱包在已登记 Fables 池的区间：币对、池 ID、hook、上下 tick、价格区间、份额、对应本金、待领净费用、区间内/外状态。
- 仓位候选 ID 可由 Fables hook 的 `Deposited`、`Withdrawn`、ERC-6909 `Transfer` 事件建索引；最终的份额、区间与费用一律重新从链上 hook/lens 读取。索引缺失或落后时显示读取异常，不把空列表解释为“没有仓位”；提供池 ID/区间的手动导入作为兜底。
- 同一钱包在同一池同一区间的存款属于同一个份额仓位。策略以 `chainId + poolId + hook + rangeId + owner` 绑定；启用前检查是否已有策略管理该份额，避免两条策略同时全额退出。
- 用户选择当前仓位、区间宽度或固定 ticks、越界确认时间、手续费处理方式及执行钱包。首期策略上下边界动作均为“退出并按最新价格居中重开”。执行钱包必须就是份额所有者，不接受跨钱包转移来完成再平衡。
- UI 不显示预测手续费作为执行条件。状态至少区分“区间内”“越界确认中”“执行中”“待恢复”“暂停”“已完成一轮”。

### 3.2 触发规则

- 从同一已验证池的链上价格读取 tick；比较旧仓位 `tickLower/tickUpper`。越界确认期间持续读取，不以单次异常 RPC 响应触发。
- 达到配置的越界确认时间后重新读取仓位与价格；若价格回到区间内，不发送退出交易。
- Fables 策略禁用 `fee_break_even`、`minNetAprPct`、`minCycleFeeCoverage` 与依赖收益估算的自适应缩放门槛。初版使用用户固定宽度，重新以**存入前最新价格**计算上下 tick；每日次数、波动、滑点等独立风控可继续由用户配置。
- 手续费为零也必须能触发并完成再平衡。独立的阈值/定时领取任务不是首期范围。

### 3.3 一轮交易

| 阶段 | 必要动作和完成证据 |
| --- | --- |
| 预检 | 确认 registry 中池有效、PoolKey/PoolId/hook 匹配；用户份额大于零；钱包有 gas；两个币可正常读取余额和授权；预计需要换币时先确认存在可用路由。预检不估计未来手续费。 |
| 退出 | 支持的池使用 `withdrawAndClaim`，早期池使用 `withdraw` 后独立 `claimFees`。使用 deadline、最小到账量；仅带领取的调用具备 `maxFeeBps`。新版池暂停时不自动回退到无费用上限的 `withdraw`。等待确认后核对份额变化和钱包实际到账。 |
| 费用结清 | 若零份额仍有应收费用，继续领取。费用因暂停或交易失败无法领取时进入待恢复状态，显示资金和应收费用所在位置，不静默跳过。 |
| 调整资产 | 根据**已到账**的本金和手续费处理规则、最新池价格计算所需两币比例；必要时以新报价和滑点保护换币。若路由/价格状态变化，重新报价或停在可恢复的钱包状态。 |
| 新区间存入 | 再次读取池价格，按 tickSpacing 对齐新区间，使用当前钱包余额确定 `deposit` 的 liquidity、`amount0Max/amount1Max`、deadline；原生 ETH 池保留 gas 余额。 |
| 完成 | 从回执和链上读数核对新区间 `rangeId`、所有者份额、新旧区间余额以及实际投入/留存金额；原子提交策略的新仓位引用、账本和周期记录。 |

任何“读取成功”都不能替代交易回执。若退出后价格大幅变化，必须在存入前重算新区间和金额；不得沿用退出前的计划。若已存入但链上读数暂时不可得，不再次发送 `deposit`，先用 nonce、回执和份额事件恢复事实。

## 4. 工程设计与改动点

### 4.1 仓位模型

在 `shared/strategy/types.ts` 和 `schema.ts` 增加 `fables` 协议身份及**区分 NFT 与份额仓位的结构化引用**，如 `positionRef: { kind: 'fables_range', poolId, hook, rangeId, tickLower, tickUpper }`。Fables 不伪装为 `activeTokenId`；旧策略记录需保持可读并有明确的版本迁移。快照分别保存 `shares`、归属用户的有效 liquidity、本金数量、净可领费用、PoolKey 与读取块高，避免把 shares 与 liquidity 混为一谈。

在 `src/config/networks.ts` 及 Robinhood 配置中增加 Fables registry/lens 和 hook 白名单的读取入口；`pool` 字段仍代表 v4 PoolManager，具体池始终用 `poolId` 区分。所有合约地址由已验证配置和链上 registry 校验，不能从用户提交的配置直接决定自动签名目标。

### 4.2 只读适配器和仓位发现

- 新增 Fables ABI 与 `FablesPositionAdapter`：通过已知 `rangeId` 读 `rangeKey`、`balanceOf`、lens `userRanges`、`quoteWithdraw`、`canClaim` 和 StateView/`poolHeads`，校验数据一致性。
- 在 indexer 为已登记 hook 建增量事件索引，处理存入、撤出和份额转移；保存候选 ID、owner、hook、池及游标。事件日志只用于发现，executor 的交易前状态以链上读取为准。
- 扩展 `src/hooks/usePositions.ts`、仓位/策略 UI、公共策略状态和绩效读取，显示 Fables 份额仓位；不能走现有 Uniswap PositionManager NFT 枚举路径。

### 4.3 执行适配器

- 在 `executor/chain.ts`、`steps.ts`、`preflight.ts` 增加 Fables 专用读取和调用构造。复用现有 tick 数学、钱包锁、签名器、换币及 gas/滑点限制；不调用 NFT 的 `ownerOf`、`decreaseLiquidity`、`burn` 或 `modifyLiquidities`。
- 在 `executor/monitor.ts`、`runner.ts` 中按仓位类型分流。执行步骤记录交易 nonce、hash、块高、调用方法、预期与实际份额、钱包余额差和待领费用。手续费以净到账额进入现有收益账本。
- `executor/recovery.ts` 与 `recovery-runner.ts` 增加 Fables 状态：旧份额尚在、已退出但费用未领、费用已领且资产在钱包、已换币待存入、已存入待确认。对未知 nonce 或不明确的回执保持停机核查，不自动重发有资金影响的交易。
- 首期不依赖 Fables 官方前端或第三方 indexer 执行交易；停机期间的链上状态也能通过本项目 RPC 与已保存 job 恢复。

## 5. 测试与验收

主网 fork 的写入闭环需要可读取固定块历史状态、包括 `eth_getProof` 的 Robinhood Chain archive RPC；官方公共 RPC 的历史状态保留时间不足，不能作为 D/E 阶段 fork 验收环境。测试 RPC 只供本地 Anvil fork 读取，交易仅广播到本地 loopback 节点。

### 5.1 必须通过的测试

1. **接口与身份：**在 Robinhood 主网 fork 上用首期每类 hook 验证 PoolKey、rangeId、份额、费用与余额；未登记池、错误 hook、错误 owner、错误 ticks 全部拒绝。
2. **交易闭环：**至少覆盖旧池 `withdraw + claimFees` 和新池 `withdrawAndClaim`；全额退出、零费用、含费用、原生 ETH、价格在两笔交易之间跳变、同区间多人持有及份额舍入。
3. **失败恢复：**在退出、领取、换币、存入和回执确认各阶段注入重启/超时/交易失败；保证不会重复退出、重复存入、丢失待领费用或占用另一策略的钱包资产。
4. **策略规则：**无任何手续费收益时仍按越界触发；价格返回区间则取消；连续轮次始终以新价格居中，存入后更新的是新 `rangeId` 而非 NFT ID。
5. **账本：**本金、净手续费、换币结果、gas 和留存余额可与回执及链上余额对齐；现有 Uniswap/UP33 策略回归测试不退化。

### 5.2 上线验收

- 只读模式能稳定发现并展示真实 Fables 仓位，链上份额与官网显示可逐项核对；读数不可用时明确报错。
- dry-run 可给出当前旧仓位、退出/领取方式、拟建新区间、所需资产比例和交易约束；不显示预测手续费决定。
- 经主网 fork 和小额真实资金完整跑通至少两轮“越界—退出—领费—换币（如需）—存入—核账”；人工核对每轮交易和资产去向。
- 在恢复演练中，executor 重启后能从链上事实继续，或者安全暂停并给出可操作的资产位置；不能出现再次发送未确认交易。
- 自动签名仅对通过合约验证门和测试的池开启；新池默认只读，完成同样验证后再加入允许名单。

## 6. 实施顺序

| 阶段 | 交付物 | 完成条件 |
| --- | --- | --- |
| A. 合约验证 | 首期池与 hook 清单、ABI/字节码核对、主网 fork 调用证据 | 写方法、份额单位和费用领取差异均已证明 |
| B. 只读接入 | 事件发现、链上仓位快照、前端展示 | 能发现、读取、校验真实用户仓位；无自动交易 |
| C. 交易构造 | 退出、领取、存入适配器及预检 | fork 上完成闭环，滑点和原生币余额限制生效 |
| D. 自动执行与恢复 | 监控分流、持久化步骤、幂等恢复、账本 | 注入失败测试通过，原有协议回归通过 |
| E. 小额验证与发布 | 限定池启用、真实交易核账、监控与回滚开关 | 连续两轮成功，失败演练可停机和恢复 |

此计划是实施基线，不代表 Fables 已接入或任何生产资金操作已获授权。实际部署另按项目生产发布流程执行。
