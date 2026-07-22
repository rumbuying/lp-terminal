# UP33 合约地图 & 用户全流程（前端构建基准）

> 目标：把 UP33（`up.`，Robinhood Chain 上的 Velodrome V2 + Slipstream ve(3,3) DEX）的每个用户动作
> 精确映射到链上合约调用，作为自建前端的工程参考。
> 所有函数签名均已通过 Robinhood Chain Blockscout 的**已验证源码**核对（编译器 0.8.19）。

- **Chain**: Robinhood Chain，`chainId = 4663`，gas token = ETH
- **RPC**: `.env` 里的 `RPC`（Alchemy `robinhood-mainnet`）；官方公开 RPC `https://rpc.mainnet.chain.robinhood.com`
- **Explorer**: https://robinhoodchain.blockscout.com
- **官方子图 (Goldsky)**:
  - CL/v3: `https://api.goldsky.com/api/public/project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-v3-mainnet/0.1.1/gn`
  - Gauges: `https://api.goldsky.com/api/public/project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-gauges-mainnet/0.1.0/gn`

---

## 0. 实时状态（2026-07-16 04:03 UTC，block 10954835）—— 协议已全面上线

**关键：今天 00:00 UTC 发生了第一次 epoch flip，世界与 07-13 研究时完全不同：**

| 指标 | 07-13（上线前） | 07-16（现在） | 含义 |
|---|---|---|---|
| `Minter.epochCount` | 0 | **1** | 第一期排放已发生 |
| `Minter.weekly` | 10,000,000 | **10,300,000** UP | +3% 增长期已启动 |
| `UP.totalSupply` | 500,000,000 | **510,526,315** | +10M 排放 + 526k team share |
| `Voter.capMode` | Disabled | **Enforced (2)** | **gauge cap 现在真的在生效** |
| `Voter.totalWeight` | ~7,828 | **~100,183,267** veUP | 创世大锁已投票 |
| 池 / gauge | 3 v2 + 15 CL / 15 | **6 v2 + 21 CL / 22（全 alive）** | 新增 UPHOOD/DOWN/WISHBONE/ARROW/VEX/PONS/RUGD 等 |
| gauge streaming | rewardRate=0 | **rewardRate>0，periodFinish=2026-07-23 00:00 UTC** | UP 正在按秒流向质押 LP |

- `epoch_next = 2026-07-23T00:00:00Z`（下一次 flip / 投票截止）。
- 池和 gauge 列表**会持续变化**，前端必须**动态枚举**（见 §5），不要硬编码。

---

## 1. 合约清单

### 核心合约（Blockscout 已验证）

| 角色 | 地址 | 说明 |
|---|---|---|
| **UP** token | `0x57C0E45cB534413D1C20A4240955d6bB250BB4F1` | 排放/治理代币，ERC-20，18 dec |
| **veUP** (VotingEscrow) | `0x5d321dE36F0bf98D92b291280514F3878582B7B6` | 锁仓 ERC-721 NFT，投票权 + fee 权 |
| **Voter** | `0x7F749fDD351C1Ceed82d76d7699CB631Eb8332a7` | 投票、gauge 注册、claim 分发、cap |
| **Minter** | `0x912EC7A90e8C9829eE0e0f6a4Db5270776Fc3Da5` | 每周排放、team share、rebase |
| **RewardsDistributor** | `0xC75C2cC04f65d7C1e541474C8ce927b544Fff849` | rebase 分发（当前 rate=0） |
| **v2 PoolFactory** | `0xFA5429AEBa338BEa2BFcc1b9a889862Ee395bc28` | v2 stable/volatile 池 |
| **v2 Router** | `0xf5198743240fAC98db71868F34c70139b1eb0474` | v2 加/减流动性、swap、zap |
| **v2 GaugeFactory** | `0x6df2E93cc56E96330dce2B60e34D88AF3EF23580` | 部署 v2 gauge |
| **CLFactory** | `0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3` | Slipstream CL 池 |
| **CL PositionManager** (NFT) | `0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf` | CL 仓位 NFT（mint/increase/decrease/collect） |
| **CL SwapRouter** | `0xC062b870E813fcA720f1e002c234369Ab3aB9415` | CL swap |
| **CL Quoter** | `0x03983AB2C057a2eac211ff01738a1e49ff325B49` | CL 报价（revert 式，eth_call） |
| **WETH** | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 标准 WETH9，18 dec |
| **Multicall3** | `0xcA11bde05977b3631167028862bE2a173976CA11` | 标准地址，批量读 |

### 第三方：KyberSwap（只读美元估值）

- Aggregator API base：`https://aggregator-api.kyberswap.com`，chain slug
  **`robinhood`**（对应 chainId 4663）。
- 前端只读取 fee-free routes 的 `amountOutUsd`，用于 UP 奖励、APR、仓位与
  Add-LP 模拟的美元展示。
- Kyber 价格不进入 MARKET/ZAP route、Zap sizing、slippage、minimum 或交易执行；
  代码不暴露 Kyber transaction builder。
- 相关参数只有 `KYBERSWAP_AGGREGATOR_API_BASE_URL` / `KYBERSWAP_CHAIN`。

### Fee / cap 模块（治理可替换）

| 角色 | 地址 | 现状 |
|---|---|---|
| CL SwapFeeModule | `0x0F19e5EcA92523F728A43F5C5BfdFb1561B34272` | **静态** per-pool override（非文档宣传的动态费率） |
| CL UnstakedFeeModule | `0xbb7A7015fD9744dF83d688D5C71C9efE613b976d` | 默认对未质押 CL LP 的 fee **抽 10%**（可 per-pool 设 0–50%） |
| GaugeCapController | `0x5739B0FcF359DF7a386C0fDD27464Dd15eE1687D` | **源码未验证**；capMode 现已 Enforced |

### 治理

- **Genesis 2/3 Safe** `0x0eEA30aBa3f07abFA20E4b544F55e0f917d9DFd8`：持有 4 个创世 permanent veNFT（#1–#4，约 437.5M 票权）、v2/CL fee manager、pauser、governor、emergency council、epoch governor、cap controller owner。高度集中。
- Minter `team()` 仍是单 EOA `0x85Fb9f9BC8a44663A234AdB4CfE4E1459C096651`（`pendingTeam` 已设为 Safe，尚未 `acceptTeam()`）。

---

## 2. 代币清单（实时，含小数位）

`USDG 是 6 位小数`，其余均 18 位 —— 前端所有金额换算必须按各自 decimals，切勿假设 18。

| Symbol | Address | dec |
|---|---|---|
| UP | `0x57c0e45cb534413d1c20a4240955d6bb250bb4f1` | 18 |
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` | 18 |
| USDG | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | **6** |
| VIRTUAL | `0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31` | 18 |
| CASHCAT | `0x020bfc650a365f8bb26819deaabf3e21291018b4` | 18 |
| DIH | `0x17bb0c898254406b1ea2e8e99b0c263e26c9e4a4` | 18 |
| JUGGERNAUT | `0xd7321801caae694090694ff55a9323139f043b88` | 18 |
| TENDIES | `0x45242320dbb855eea8fd36804c6487e10e97fcf9` | 18 |
| UPHOOD | `0x62f1…30b63` / `0xa153…59ee`（两个） | 18 |
| DOWN | `0x4cd75000eb7a5951abfd57fc7ea2ac8aa1622935` | 18 |
| WISHBONE | `0x77581054581b9c525e7dd7a0155de43867532d03` | 18 |
| VEX | `0x8ff92566f2e81bdd68edfaa8cde73942a723796b` | 18 |
| ARROW | `0xf2915d1e3c1b0c769d0c756ec43f1c1f6c99cd03` | 18 |
| PONS | `0x39dbed3a2bd333467115de45665cc57f813c4571` | 18 |
| RUGD | `0xa07a181570a59d00fc5923552b04e5467dc87250` | 18 |

> ⚠️ 池里很多是新发/未验证 token（DIH、CASHCAT、RUGD…）。前端应把"资产风险"与"排放 APR"分开展示，不要把高票诱饵池当低风险机会。

---

## 3. ve(3,3) 价值流（一句话模型）

```
lock UP → veUP 投票给 gauge → 下一 epoch UP 排放按票重流向各 gauge
        → LP 质押到 gauge 赚 UP（放弃自己那份手续费）
        → 质押流动性产生的手续费 + 外部 incentives 归投票者
        → 领取 → 续锁/再投票
```

- 每 epoch = 7 天，周四 00:00 UTC flip。
- 本期票决定**下期**排放；本期 fee/incentive 在 flip 后可领。
- **质押 = 赚 UP、手续费给 voters；未质押 = 保留手续费、不赚 UP**（二选一）。
- CL 只有价格在区间内才赚有效排放和手续费。

---

## 4. 合约接口速查（已验证签名）

### 4.1 ERC-20 / WETH（标准）
```
approve(address spender, uint256 amount)
allowance(address owner, address spender) -> uint256
balanceOf(address) -> uint256
WETH.deposit() payable        // ETH -> WETH
WETH.withdraw(uint256 wad)     // WETH -> ETH
```

### 4.2 veUP VotingEscrow — 锁仓
```
// 写
createLock(uint256 _value, uint256 _lockDuration) -> uint256 tokenId   // duration 单位秒，最长 4y
createLockFor(uint256 _value, uint256 _lockDuration, address _to) -> uint256
increaseAmount(uint256 _tokenId, uint256 _value)          // 加仓（需先 approve UP）
increaseUnlockTime(uint256 _tokenId, uint256 _lockDuration) // 延长
merge(uint256 _from, uint256 _to)
split(uint256 _from, uint256 _amount)
lockPermanent(uint256 _tokenId)
unlockPermanent(uint256 _tokenId)
withdraw(uint256 _tokenId)     // 仅到期后
delegate(uint256 delegator, uint256 delegatee)
// 读
locked(uint256 _tokenId) -> (int128 amount, uint256 end, bool isPermanent)
balanceOfNFT(uint256 _tokenId) -> uint256          // 当前投票权
balanceOfNFTAt(uint256 _tokenId, uint256 _t) -> uint256
ownerOf(uint256 _tokenId) -> address
balanceOf(address _owner) -> uint256               // 用户持有的 veNFT 数量
tokenOfOwnerByIndex(address, uint256) -> uint256    // 枚举用户的 veNFT（ERC721Enumerable）
supply() -> uint256                                // 锁定的 UP 总量
```

### 4.3 Voter — 投票、claim、gauge
```
// 写
vote(uint256 _tokenId, address[] _poolVote, uint256[] _weights)   // 每 epoch 一次，最多 30 池
reset(uint256 _tokenId)
poke(uint256 _tokenId)                              // 按当前衰减刷新已投票权
claimRewards(address[] _gauges)                     // LP：领 UP 排放（等价 gauge.getReward）
claimFees(address[] _fees, address[][] _tokens, uint256 _tokenId)    // voter：领手续费
claimBribes(address[] _bribes, address[][] _tokens, uint256 _tokenId) // voter：领 incentives
createGauge(address _poolFactory, address _pool)    // 白名单 token 可 permissionless 建 gauge
distribute(address[] _gauges)                       // permissionless，把本期 UP 推进 gauge
// 读
length() -> uint256                                 // gauge/pool 数量
pools(uint256) -> address                           // 枚举 pool
gauges(address pool) -> address                     // pool -> gauge
poolForGauge(address gauge) -> address
isAlive(address gauge) -> bool
isGauge(address) -> bool
weights(address pool) -> uint256                    // 池累计票重
totalWeight() -> uint256
usedWeights(uint256 tokenId) -> uint256             // 某 NFT 已用票权
votes(uint256 tokenId, address pool) -> uint256     // 某 NFT 投给某池的票
poolVote(uint256 tokenId, uint256 i) -> address     // 某 NFT 投过的池列表
lastVoted(uint256 tokenId) -> uint256
gaugeToFees(address gauge) -> address               // -> FeesVotingReward 地址
gaugeToBribe(address gauge) -> address               // -> IncentiveVotingReward 地址
claimable(address gauge) -> uint256                 // gauge 待分发 UP
epochStart/epochNext/epochVoteStart/epochVoteEnd(uint256 ts) -> uint256
capMode() -> uint8  // 0 Disabled / 1 ObserveOnly / 2 Enforced
```

### 4.4 Minter — 排放
```
updatePeriod()          // permissionless；7 天到期后触发本期 mint + flip
nudge()                 // epoch governor 微调 tail rate ±1bp
weekly() / activePeriod() / epochCount() / tailEmissionRate() / teamRate() / rebaseRateBps()
```

### 4.5 v2 Router — v2 流动性 & swap
```
// 加/减流动性
addLiquidity(tokenA, tokenB, bool stable, amountADesired, amountBDesired, amountAMin, amountBMin, to, deadline)
addLiquidityETH(token, bool stable, amountTokenDesired, amountTokenMin, amountETHMin, to, deadline) payable
removeLiquidity(tokenA, tokenB, bool stable, liquidity, amountAMin, amountBMin, to, deadline)
removeLiquidityETH(token, bool stable, liquidity, amountTokenMin, amountETHMin, to, deadline)
// 报价（view）
quoteAddLiquidity(tokenA, tokenB, stable, _factory, amountADesired, amountBDesired) -> (amountA, amountB, liquidity)
quoteRemoveLiquidity(tokenA, tokenB, stable, _factory, liquidity) -> (amountA, amountB)
getReserves(tokenA, tokenB, stable, _factory) -> (reserveA, reserveB)
getAmountsOut(amountIn, Route[] routes) -> uint256[]     // Route = (from,to,stable,factory)
poolFor(tokenA, tokenB, stable, _factory) -> address
defaultFactory() -> address                              // 传给上面 _factory 的默认值
// swap（Route[] = (address from, address to, bool stable, address factory)）
swapExactTokensForTokens(amountIn, amountOutMin, Route[], to, deadline)
swapExactETHForTokens(amountOutMin, Route[], to, deadline) payable
swapExactTokensForETH(amountIn, amountOutMin, Route[], to, deadline)
zapIn(...) / zapOut(...)                                  // 可选：一步 zap + 可选 stake
```

### 4.6 v2 PoolFactory / v2 Pool
```
Factory.getPool(tokenA, tokenB, bool stable) -> address   // 找池
Factory.allPools(uint256) / allPoolsLength()               // 枚举
Factory.getFee(address pool, bool stable) -> uint256       // 分母 10_000
Pool.getReserves() -> (r0, r1, blockTimestampLast)
Pool.token0()/token1()/stable()/totalSupply()
Pool.balanceOf(user) -> uint256                            // 未质押 LP token 余额
Pool.claimable0(user)/claimable1(user) -> uint256          // 未质押 LP 待领手续费
Pool.claimFees()                                           // 未质押 LP 领手续费
```

### 4.7 v2 Gauge（标准 Velodrome V2 Gauge；实例未单独验证，构建时用 eth_call 确认 selector）
```
deposit(uint256 _amount)                  // 质押 LP token（先 approve pool->gauge）
deposit(uint256 _amount, address _recipient)
withdraw(uint256 _amount)                 // 取回 LP token
getReward(address _account)               // 领 UP 排放
earned(address _account) -> uint256       // 待领 UP
balanceOf(address) -> uint256             // 已质押 LP token
stakingToken() -> address                 // = pool 地址
rewardToken() -> address                  // = UP
rewardRate()/periodFinish()/left()/rewardRateByEpoch(uint256)
```

### 4.8 CLFactory / CL PositionManager / CL Pool / CL Gauge（Slipstream）

**CLFactory**
```
getPool(tokenA, tokenB, int24 tickSpacing) -> address
allPools(uint256) / allPoolsLength() / isPool(address)
```
**CL Pool**（读为主；写由 gauge/PM 调）
```
slot0() -> (uint160 sqrtPriceX96, int24 tick, uint16 obsIndex, uint16 obsCard, uint16 obsCardNext, bool unlocked)
token0()/token1()/tickSpacing()/fee()/unstakedFee()/liquidity()/stakedLiquidity()
gaugeFees() -> (uint128, uint128)
positions(bytes32 key) -> (uint128 liquidity, ...)          // key = keccak(owner,tickLower,tickUpper)
```
**CL PositionManager (NFT, ERC721Enumerable)**
```
// 写
mint((address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper,
      uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min,
      address recipient, uint256 deadline, uint160 sqrtPriceX96)) payable -> tokenId  // sqrtPriceX96=0 表示池已存在
increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable
decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable
collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable   // 领未质押 CL 手续费
burn(uint256 tokenId) payable
// 读
balanceOf(user) / tokenOfOwnerByIndex(user, i) / ownerOf(tokenId)
positions(uint256 tokenId) -> (uint96 nonce, address operator, address token0, address token1,
   int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity,
   uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)
```
**CL Gauge**（质押 = 把 NFT 交给 gauge）
```
// 写
deposit(uint256 tokenId)          // 质押 CL NFT（先 PositionManager.approve(gauge, tokenId)）
withdraw(uint256 tokenId)         // 取回 NFT
getReward(uint256 tokenId)        // 领该仓位 UP
getReward(address account)        // 领该地址全部质押仓位 UP
// 读
earned(address account, uint256 tokenId) -> uint256
stakedValues(address depositor) -> uint256[]     // ★ 该地址已质押的 tokenId 列表（枚举质押 CL 仓位的关键）
stakedContains(address, uint256 tokenId) -> bool
stakedLength(address depositor) -> uint256
rewardRate()/rewardRateByEpoch(uint256)/periodFinish()/left()
rewardToken() -> address
```

### 4.9 CL Quoter / CL SwapRouter
```
Quoter.quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96))
   -> (uint256 amountOut, uint160 sqrtPriceX96After, uint32 ticksCrossed, uint256 gasEstimate)   // nonpayable，用 eth_call 模拟
SwapRouter.exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient,
   uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable -> amountOut
```

### 4.10 KyberSwap valuation（HTTP API，只读）

```
GET {BASE}/robinhood/api/v1/routes?tokenIn=&tokenOut=&amountIn=&gasInclude=false
  -> data.routeSummary.amountOutUsd
```

- 不发送 fee 参数，不调用 `route/build`，不读取 routerAddress，不产生 approve 或交易 calldata。
- 当前 `useUpPrice` 每 60 秒取 1 UP→USDG 的 `amountOutUsd`；失败时估值保持不可用，
  不回退为交易报价。

---

### 4.11 Uniswap v3（官方部署，2026-07-02 上线 — "primary public AMM"）

官方地址（developers.uniswap.org deployments；配对已于 2026-07-16 链上验证：
`NPM.factory() == FACTORY`、`NPM.WETH9() == WETH`、minted 156k+。⚠️ Blockscout
上还有多个同名野生 fork —— 认准下面这两个）：

```
UniswapV3Factory            0x1f7d7550B1b028f7571E69A784071F0205FD2EfA   owner 0x2bad…46cd
NonfungiblePositionManager  0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3
QuoterV2                    0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7   (直连报价)
SwapRouter02                0xcaf681a66d020601342297493863e78c959e5cb2   (直连 swap + 原子 9 bps)
UniversalRouter             0x8876789976decbfcbbbe364623c63652db8c0904   (未接入)
Permit2                     0x000000000022D473030F116dDEE9F6B43aC78BA3   (canonical)
```

与 Slipstream 的差异（前端已适配）：
- `positions(tokenId)` 第 4 槽是 **uint24 fee**（Slipstream 是 int24 tickSpacing）
- `slot0()` 是 **7 字段**（多一个 uint8 feeProtocol；Slipstream 6 字段）——
  `fetchSqrtPriceX96` 用只解码 `(sqrtPriceX96, tick)` 前缀的最小 ABI 两者通吃
- fee → tickSpacing：100→1 / 500→10 / 3000→60 / 10000→200（工厂已启用全部四档）
- 池按 `getPool(token0, token1, fee)` 发现；无 gauge / 质押 / unstakedFee 概念
- **写接口 increase/decrease/collect/burn 与 Slipstream 签名完全一致** ——
  前端复用 clPmAbi 片段、只换 NPM 地址（实测 collect 模拟通过）

### 4.12 Uniswap v2（官方部署；POOLS + 直连 swap）

官方地址（developers.uniswap.org v2 deployments；配对已于 2026-07-16 链上验证：
`Router02.factory() == FACTORY`、`Router02.WETH() == WETH`）：

```
UniswapV2Factory   0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f
UniswapV2Router02  0x89e5DB8B5aA49aA85AC63f691524311AEB649eba
```

- 香草 v2：固定 0.30% 费率，无 stable 档，LP 是同质化 ERC-20（非 NFT），
  手续费滚入储备自动复利；与 UP33 的 Solidly 式 v2 Router **签名不同**
  （`addLiquidity` 无 `stable` 参数、无 `quoteAddLiquidity`）—— 前端用
  `uniV2RouterAbi` 走 `UNI.V2_ROUTER`，mins = desired×(1−滑点)
- 目录可直接枚举：`allPairsLength()` / `allPairs(i)`（2026-07-16 实测 11,825 对，
  日增 ~百对）；池状态 `getReserves()` + `totalSupply()`
- 头寸管理（LP 余额 / removeLiquidity）暂未接入 —— 只有浏览 + 加流动性

Uniswap v4 同日上线但未接入：PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`、
PositionManager `0x58dAeC3116AaE6D93017bAaEA7749052e8a04FA7`、StateView
`0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`、Quoter `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`。


## 5. 用户全流程 → 精确调用序列

### A. 查看（只读，全部走 Multicall3 批量）

**枚举所有池/gauge（动态，勿硬编码）**
1. `Voter.length()` → N
2. 对 i∈[0,N)：`Voter.pools(i)` → pool；`Voter.gauges(pool)` → gauge；`Voter.isAlive(gauge)`、`Voter.weights(pool)`
3. 每个 pool：`token0/token1`；CL 再读 `tickSpacing/fee/slot0/liquidity/stakedLiquidity`，v2 读 `stable/getReserves`
4. 每个 gauge：`rewardRate/periodFinish/left`、`Voter.claimable(gauge)`、`Voter.gaugeToFees/gaugeToBribe`
5. 未列入 Voter 的新池（还没 gauge）：`CLFactory.allPools`/`v2Factory.allPools` 补全

**APR 估算**：`池周排放 ≈ weekly × weights(pool)/totalWeight`（capMode=Enforced 时还要按 cap 打折）；`LP 收益 ∝ 自己有效流动性 / gauge 总有效流动性`。UP 计价需 Quoter 报一个 UP→WETH。

**查看"我的仓位"**
- 钱包余额：各 token `balanceOf(user)`
- 未质押 v2 LP：对每个 v2 pool `pool.balanceOf(user)` + `claimable0/1(user)`
- 已质押 v2 LP：对每个 v2 gauge `gauge.balanceOf(user)` + `gauge.earned(user)`
- 未质押 CL NFT：`PM.balanceOf(user)` → `tokenOfOwnerByIndex` → `positions(tokenId)`；用 (token0,token1,tickSpacing) → `CLFactory.getPool` 定位池
- 已质押 CL NFT：对每个 CL gauge `gauge.stakedValues(user)` → tokenId[]，再 `gauge.earned(user, tokenId)`、`PM.positions(tokenId)`
- 我的锁：`veUP.balanceOf(user)` → `tokenOfOwnerByIndex` → `locked(tokenId)` + `balanceOfNFT(tokenId)` + `Voter.usedWeights/lastVoted/votes`
- 可领：LP 用上面的 `earned`；voter fee/incentive 用 `gaugeToFees/gaugeToBribe` 指向的 reward 合约的 `earned(token, tokenId)`

### B. 提供流动性（Provide liquidity）

**v2**
1. `UP/WETH/... approve(v2Router, amount)`（两种 token）
2. `quoteAddLiquidity(...)` 预估 → 设 `amountAMin/BMin`（滑点）
3. `v2Router.addLiquidity(tokenA, tokenB, stable, aDesired, bDesired, aMin, bMin, user, deadline)`
   （含 ETH 用 `addLiquidityETH{value:...}`）
→ 得到 v2 LP token（ERC-20，在 pool 合约里）

**CL**
1. 选 tickSpacing（决定 base fee 档）与 tickLower/tickUpper（须对齐 tickSpacing）
2. `token0/token1 approve(PositionManager, amount)`
3. `PositionManager.mint({token0, token1, tickSpacing, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient:user, deadline, sqrtPriceX96:0})`
→ 得到 CL 仓位 NFT

### C. 质押 / 取消质押（Stake / Unstake）

**v2**：`pool.approve(gauge, lpAmount)` → `gauge.deposit(lpAmount)`；取消 `gauge.withdraw(lpAmount)`
**CL**：`PositionManager.approve(gauge, tokenId)`（或 setApprovalForAll）→ `gauge.deposit(tokenId)`；取消 `gauge.withdraw(tokenId)`
> 质押时 gauge 会先把质押前累计的手续费付给你，之后手续费归 voters、你改赚 UP。无锁定、无罚金。

### D. 领取（Claim）

- **LP 排放（UP）**：`gauge.getReward(user)`（CL 也可 `getReward(tokenId)`）；或批量 `Voter.claimRewards([gauges])`
- **未质押手续费**：v2 `pool.claimFees()`；CL `PositionManager.collect({tokenId, recipient:user, amount0Max:max, amount1Max:max})`
- **voter 手续费**：`Voter.claimFees([feesRewards], [[tokens]], tokenId)`
- **voter incentives/bribes**：`Voter.claimBribes([bribeRewards], [[tokens]], tokenId)`
  （feesRewards/bribeRewards 地址来自 `gaugeToFees/gaugeToBribe`）

### E. 锁仓（Lock）
- 新建：`UP.approve(veUP, value)` → `veUP.createLock(value, durationSeconds)`
- 加仓：`veUP.increaseAmount(tokenId, value)`；延长：`increaseUnlockTime(tokenId, durationSeconds)`
- 永久：`lockPermanent(tokenId)` / `unlockPermanent(tokenId)`；合并 `merge(from,to)`；到期取回 `withdraw(tokenId)`

### F. 投票（Vote）
- `Voter.vote(tokenId, [pool1,pool2,...], [w1,w2,...])`（权重比例即可，合约按和归一；最多 30 池）
- 改主意：`reset(tokenId)`（同 epoch 不能再投）；`poke(tokenId)` 按衰减刷新
- 窗口：flip 后第 1 小时不能投；下次 flip 前最后 1 小时仅 whitelisted NFT 可投

### G. 激励一个池（Incentivize）
- `token.approve(bribeReward, amount)` → `IncentiveVotingReward(gaugeToBribe(gauge)).notifyRewardAmount(token, amount)`
- token 须在白名单；存入不可撤回，给**本 epoch** voters

### H. 交易（Swap）—— Uniswap + UP33 直连比价

1. **候选**：Uniswap v2、Uniswap v3 四个官方 fee tier 与 UP33 CL；每条 route
   都用链上 Router/Quoter 报完整输入，protocol 内先取最优，再按 9 bps 后净输出
   选择全局最优。UP33 Solidly v2 因无原子 fee-sweep 路径，不进入 swap 候选。
2. **完整性**：factory/pool 不存在是 `absent`；discovery 或完整报价失败是
   `failed`。一个已发现 route 失败会使该 protocol 整体不参与排名，不用较差 route
   静默兜底。ZAP 只有在 Uniswap/UP33 比较完整时才规划。
3. **滑点**：同 route 用约 1% 小额 probe 与完整报价的单位价格差估算 impact，
   自动选择 0.5%（绿）/ 1%（黄）/ 3%（红）。raw amount 小于 100 或 probe
   不可用时 AUTO 保持 neutral，必须手选 0.5% / 1% / 3%。
4. **执行**：route 在用户确认后固定；发送前同 route fresh quote 必须覆盖冻结的
   net minimum。ERC20 只做 exact approval，真实 approve 后重新 prepare。
5. **原子 fee**：Uniswap SwapRouter02 或 UP33 CL Router 把 gross output 留在 router，
   同一 multicall 调 `sweepTokenWithFee` / `unwrapWETH9WithFee` 收取固定 9 bps。
   用户 minimum 是 fee 后净额；不做 aggregator 拆单、provider fallback 或 Kyber 执行。

### H2. 区间限价单（LIMIT，"部署 LP 卖币"）

单边 CL 仓位当限价单：把要卖的 token 单边 mint 进一个**严格在现价之外**的区间（卖 token0 → 区间在上方；卖 token1 → 区间在下方，均指 token1/token0 价格空间），价格穿越区间的过程即逐步成交，完全穿越后仓位 100% 变成目标 token，withdraw 落袋。

- 完全成交均价 = 区间两端价格的**几何平均** `√(pa·pb)`（闭式，已对 BigInt 路径验证到 1e-12）
- 成交进度：卖 token1 时 `fill = (√B−√P)/(√B−√A)`，卖 token0 镜像
- 调用序列 = `approve(PM)` → `PM.mint`（单边 desired，另一侧 0；卖侧 min≈100% 兜底"价格已进区间"）→ 出场 `decreaseLiquidity(100%)+collect`
- **非挂单语义**：价格回撤会"反向成交"；无自动执行；区间内赚池费（unstaked 扣 10% levy）。CL gauge 不适用（出区间质押零排放，且质押把手续费让给 voters）
- 前端在 `#limit`；订单意图存 localStorage（tokenId→sell/buy），POSITIONS 显示 fill%

---

## 6. 文档 vs 链上：必须知道的差异（已随上线更新）

1. **Gauge cap 现在是 Enforced（≠ 07-13 的 Disabled）**。排放会按"池手续费 WETH 价值 × cap multiple"封顶，超出被 burn。前端做 APR 时若 capMode=2 不能只用 `weekly × 票重占比`，需考虑 cap 打折（controller 源码未验证，精确值最好读 `Voter.claimable(gauge)` 实际到账，而非纯理论推算）。
2. **"动态费率"当前实为静态 override**：SwapFeeModule 只读 per-pool `customFee`，不看波动率/成交量。以 `pool.fee()` 实际值为准（例：WETH/UP CL 曾是 2% 静态，而非文档表的 0.3%）。
3. **CL 未质押 LP 有 10% fee levy**：文档说"未质押保留全部手续费"，实际默认扣 10% 给 gauge。算未质押 CL 真实收益要先扣。
4. **rebase 当前为 0**；team share 5%。
5. **治理高度集中**：单一 2/3 Safe 可改 fee/module、pause、kill/revive gauge、切 cap 模式。前端应把这些当"参数随时可变"，读实时值而非缓存假设。

### 6.6 APR 公式 ↔ 已部署源码逐行核对（2026-07-16，全部取自 Blockscout 已验证合约）

**CL 手续费**（`CLPool.calculateFees/splitFees/applyUnstakedFees`，WETH/UP 池实例已验证）：
- 每步 swap：`feeAmount = amountIn × fee()/1e6`（fee 实时读 factory SwapFeeModule）
- staked 份额 `feeAmount × stakedLiq/liq` → `gaugeFees` →（`CLGauge._claimFees→pool.collectFees`）→ FeesVotingReward（voters）
- unstaked 份额再抽 `unstakedFee()/1e6`（现 10%）→ 也进 `gaugeFees`
- 余下记 `feeGrowthGlobal += net/(liq−stakedLiq)` ⇒ **未质押仓位实得 = 总fee × (1−levy) × L/活跃总流动性**
- `stake()` 把 NFT 仓位流动性移入 gauge 虚拟仓位，`Position.update(..., staked=true)` 跳过 tokensOwed 累积 ⇒ **质押仓位手续费严格为 0**

**CL 排放**（`CLPool._updateRewardsGrowthGlobal` + `CLGauge._earned/_notifyRewardAmount`）：
- `rewardGrowthGlobal += rewardRate×dt/stakedLiquidity`（分母=**活跃质押流动性**；为 0 时该段 UP 进 `rollover`，滚入下期 notify）
- 仓位收益 = `L × ΔrewardGrowthInside(区间)`，出区间不增长
- notify 仅 Voter 可调：`rewardRate = (amount+rollover+leftover)/到下周四的秒数`，`periodFinish` = 下次 flip

**Voter cap**（`_distributeEnforced`）：gauge 只收到 `release = min(nominal, cap 允许累计 − 已放)`；withheld 期末结算时 `burnFrom` 烧掉 ⇒ **`gauge.rewardRate()` 就是 cap 后真值**；同 epoch 内后续 `distribute()` 可能增量 release、把 rate 上调（前端 ~20s 轮询能跟上）。

**v2**（`Pool._update0/_update1` + `Gauge.rewardPerToken`，Gauge 源码取自已验证 GaugeFactory）：
- fee = `amountIn × getFee/10000` → 转出到 PoolFees，`index0 += fee×1e18/totalSupply` ⇒ **每枚 LP token 均匀累积**（gauge 持有部分由 gauge 领走给 voters ⇒ 质押者 0 手续费）
- 排放 `rewardPerToken = rewardRate×dt/totalSupply`（gauge 内质押 LP token）

⇒ **前端 `src/lib/apr.ts` 与上述一致**：池列（vol×fee×(1−levy)×365/TVL、rewardRate×年秒×UP价/质押TVL）是文档化的"代表性仓位"近似；per-position 模拟的份额公式 `L/(activeL+L)`（fee）与 `L/(stakedL+L)`（emit）为**合约级精确**。年化假设当前 rate 持续（合约只承诺到 periodFinish）。

---

## 7. 前端读数策略

- **批量读**：所有 view 走 `Multicall3.aggregate3`，一次 RPC 拿全量池/gauge/仓位。
- **交易报价**：Uniswap v2/v3 + UP33 CL 直接用官方 Router/Quoter；Kyber 仅用于美元估值。
- **枚举 tokenId**：veUP 与 CL PM 都是 ERC721Enumerable，用 `balanceOf + tokenOfOwnerByIndex`；CL 质押仓位用 `CLGauge.stakedValues`。
- **子图**（可选，加速历史/TVL/volume）：Goldsky CL + gauges 子图；但写前必须以 RPC 实时读为准。
- **epoch 计时**：`Voter.epochNext(now)` 得下次 flip；UI 显示倒计时与投票窗口开关。
- **小数位**：USDG=6，其余 18；所有格式化按各 token decimals。
- **swap 报价**：输入去抖后并行读取 Uniswap v2/v3 与 UP33 CL；15s 自动刷新，
  pool absent、quote failed、impact unavailable 分别展示。
- **24h volume/TVL（实测可用，2026-07-16）**：CL 池用 DexScreener 批量端点（`api.dexscreener.com/latest/dex/pairs/robinhood/<addr,addr,…>`，一次 ≤30 地址，rolling 24h USD，CORS 开放；v2 池不收录）；v2 池用**官方 Goldsky v2 子图** `project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-v2-mainnet/0.1.0/gn`（标准 uniswap-v2 schema：`pairs`/`pairDayDatas`/`pairHourDatas`，同步在链头；小池 trackedUSD 可能为 0，用 USDG 侧≈$ 或 WETH 侧×WETH 价兜底）。GeckoTerminal 对 `robinhood` 的覆盖已完整（2026-07-16 晚实测：14 个 DEX 含
uniswap v2/v3/v4 + pancake，各榜单 top 10 页×20，池对象带 vol m5–h24/储备/买卖笔数/
代币 USD 价，免费档 30 req/min；**无 up33 条目** —— UP33 统计仍走 DexScreener +
Goldsky）。Uniswap 池的 TVL/vol 由自建 indexer 供给（`up33-terminal/indexer/`）。
fees 24h = vol × 池费率（gross）。
- **token list / USD 价**：token list 合并 UP33 factory registry 与 Uniswap pool
  index（index 不可用时显式标记 fallback）；Kyber routes 的 `amountOutUsd` 只给
  UP 奖励/APR/仓位与模拟面板做只读美元估值。

## 8. 安全 / 体验注意
- 每次交易只按精确额度 approve（不授权 max）；写前校验 `chainId==4663`。
- CL tick 必须对齐 tickSpacing；mint 前用 slot0 当前 tick 辅助选区间。
- 出区间的 CL 仓位不赚费/排放，UI 要显式标"out of range"。
- claim/领取分三类（LP 排放 / 未质押手续费 / voter fee+incentive），入口分开，避免误解。
- 展示"资产风险"独立于"排放 APR"：很多池是新发未验证 token。
