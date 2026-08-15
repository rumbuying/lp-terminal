import { parseAbi } from 'viem'
export { erc20Abi } from 'viem'

// Signatures below were extracted verbatim from Blockscout-verified ABIs
// (see docs/up33-contract-map.md §4). Only what the app calls is included.

export const wethAbi = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function balanceOf(address) view returns (uint256)',
])

export const voterAbi = parseAbi([
  'function length() view returns (uint256)',
  'function pools(uint256) view returns (address)',
  'function gauges(address pool) view returns (address)',
  'function isAlive(address gauge) view returns (bool)',
  'function weights(address pool) view returns (uint256)',
  'function totalWeight() view returns (uint256)',
  'function claimable(address gauge) view returns (uint256)',
  'function capMode() view returns (uint8)',
])

export const minterAbi = parseAbi([
  'function weekly() view returns (uint256)',
  'function epochCount() view returns (uint256)',
  'function activePeriod() view returns (uint256)',
])

export const v2FactoryAbi = parseAbi([
  'function allPoolsLength() view returns (uint256)',
  'function allPools(uint256) view returns (address)',
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
  'function getFee(address pool, bool _stable) view returns (uint256)',
])

export const v2PoolAbi = parseAbi([
  'function metadata() view returns (uint256 dec0, uint256 dec1, uint256 r0, uint256 r1, bool st, address t0, address t1)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function getReserves() view returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast)',
  'function claimable0(address) view returns (uint256)',
  'function claimable1(address) view returns (uint256)',
  'function claimFees() returns (uint256 claimed0, uint256 claimed1)',
])

export const v2RouterAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  'function quoteAddLiquidity(address tokenA, address tokenB, bool stable, address _factory, uint256 amountADesired, uint256 amountBDesired) view returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function quoteRemoveLiquidity(address tokenA, address tokenB, bool stable, address _factory, uint256 liquidity) view returns (uint256 amountA, uint256 amountB)',
  'function addLiquidity(address tokenA, address tokenB, bool stable, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, bool stable, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
])

// v2 Gauge instances are not individually verified on Blockscout; this is the
// standard Velodrome V2 Gauge interface. Selectors are validated against the
// live chain by scripts/smoke.ts (earned/balanceOf must respond via eth_call).
export const v2GaugeAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function earned(address _account) view returns (uint256)',
  'function deposit(uint256 _amount)',
  'function withdraw(uint256 _amount)',
  'function getReward(address _account)',
  'function rewardRate() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
  'function stakingToken() view returns (address)',
])

export const clFactoryAbi = parseAbi([
  'function allPoolsLength() view returns (uint256)',
  'function allPools(uint256) view returns (address)',
  'function getPool(address, address, int24) view returns (address)',
  'function tickSpacings() view returns (int24[])',
  'function tickSpacingToFee(int24) view returns (uint24)',
])

export const clPoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function stakedLiquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function unstakedFee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function gauge() view returns (address)',
  // The two reads the liquidity distribution is reconstructed from. `ticks`
  // returns ten fields on Slipstream and eight on stock v3; both are declared
  // down to the two that matter, because a static-return decode reads fixed
  // word offsets and ignores whatever follows. That one fragment then serves
  // every v3 fork instead of one per fork.
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet)',
  'function tickBitmap(int16) view returns (uint256)',
])

export const clPmAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint((address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, uint160 sqrtPriceX96) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function approve(address to, uint256 tokenId)',
  'function burn(uint256 tokenId) payable',
])

// Note: CLGauge also has getReward(address); only the tokenId variant is included
// to keep viem overload resolution unambiguous.
export const clGaugeAbi = parseAbi([
  'function deposit(uint256 tokenId)',
  'function withdraw(uint256 tokenId)',
  'function getReward(uint256 tokenId)',
  'function earned(address account, uint256 tokenId) view returns (uint256)',
  'function stakedValues(address depositor) view returns (uint256[] staked)',
  'function rewardRate() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
])

// ---- Uniswap v3 (official Robinhood Chain deployment; see addresses.UNI) ----
// Same core math as Slipstream but fee-keyed: positions() carries uint24 fee
// where Slipstream has int24 tickSpacing, and slot0 has an extra feeProtocol
// word. increase/decrease/collect/burn are signature-identical to clPmAbi —
// call those fragments against UNI.V3_NPM instead of duplicating them here.

export const uniV3FactoryAbi = parseAbi([
  'function getPool(address, address, uint24) view returns (address)',
])

export const uniV3PmAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  // mint is the ONE write that differs from Slipstream (uint24 fee instead of
  // int24 tickSpacing, and no sqrtPriceX96 pool-creation field)
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
])

export const uniV3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet)',
  'function tickBitmap(int16) view returns (uint256)',
])

// ---- Uniswap v2 (official; UNI.V2_FACTORY / UNI.V2_ROUTER) ----
// Vanilla Uniswap v2 — NOT the Solidly-style UP33 v2 (no stable flag, 0.30%
// fixed fee). Pairs are fungible ERC-20 LP tokens, not NFTs.

export const uniV2FactoryAbi = parseAbi([
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
  'function getPair(address, address) view returns (address)',
])

export const uniV2PairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

export const uniV2RouterAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
])

export const uniV3QuoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
])

export const uniSwapRouterAbi = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMinimum, address[] path, address recipient) payable returns (uint256 amountOut)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function sweepTokenWithFee(address token, uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable',
  'function unwrapWETH9WithFee(uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable',
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
])

// On-chain the quoter fns are nonpayable (revert-and-catch quoting); declared
// view here so they can ride eth_call/multicall — semantics are identical.
export const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

/**
 * Fee-keyed sibling of clSwapRouterAbi, for a home CL that identifies pools by
 * fee tier (PancakeSwap v3).
 *
 * Pancake's SwapRouter is the SwapRouter *v1* shape, NOT SwapRouter02 —
 * verified on-chain 2026-08-02 by selector against the deployed bytecode:
 * exactInputSingle is 0x414bf389 (deadline inside the struct) and 0x04e45aaf
 * (SwapRouter02's deadline-free variant) is absent, and it carries
 * multicall(bytes[]) rather than multicall(uint256,bytes[]). So the only thing
 * that differs from clSwapRouterAbi is uint24 fee where Slipstream has int24
 * tickSpacing — same field order, same settlement fragments.
 */
export const clSwapRouterFeeAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function sweepTokenWithFee(address token, uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable',
  'function unwrapWETH9WithFee(uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable',
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
])

export const clSwapRouterAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function sweepTokenWithFee(address token, uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable',
  'function unwrapWETH9WithFee(uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable',
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
])

/**
 * A CL farm that takes CUSTODY of the position NFT — PancakeSwap's
 * MasterChefV3.
 *
 * Staking there transfers the NFT, so the position manager reports the FARM as
 * its owner and `npm.balanceOf(user)` stops seeing it entirely. The farm is the
 * only contract that still associates the position with its depositor, and it
 * does so through the same two ERC-721 enumeration fragments the NPMs use —
 * which is why one reader can walk either.
 *
 * `nonfungiblePositionManager()` is the link chain-check verifies: a farm wired
 * to a different NPM would enumerate token ids that mean nothing here.
 */
export const clFarmAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function pendingCake(uint256 tokenId) view returns (uint256)',
  'function nonfungiblePositionManager() view returns (address)',
])

/**
 * A v2 farm that takes CUSTODY of LP tokens — PancakeSwap's MasterChefV2.
 *
 * Its v3 sibling above can be walked with ERC-721 enumeration because an NFT
 * carries its own identity. A fungible LP token cannot, so this farm keys
 * deposits by POOL INDEX instead: there is no "which pools is this user in",
 * only `userInfo(pid, user)` asked once per pid. `poolLength` bounds that
 * sweep, and `lpToken(pid)` names what each pid actually holds — including
 * dummy tokens for pools that are not pairs at all, which is why the caller
 * derives each one by CREATE2 before believing it.
 */
export const v2FarmAbi = parseAbi([
  'function poolLength() view returns (uint256)',
  'function lpToken(uint256 pid) view returns (address)',
  'function userInfo(uint256 pid, address user) view returns (uint256 amount, uint256 rewardDebt, uint256 boostMultiplier)',
  'function pendingCake(uint256 pid, address user) view returns (uint256)',
  'function withdraw(uint256 pid, uint256 amount)',
])

/**
 * A launchpad token, and the factory that can prove it is one.
 *
 * `getUERC20Address` is the whole proof: it recomputes the CREATE2 address the
 * factory would deploy a token with this identity to, and only the factory can
 * deploy there. The five getters on the token are its side of that identity —
 * an ordinary ERC-20 reverts on `creator()` and `graffiti()`, which is the
 * cheapest possible rejection and the reason the read is shaped this way.
 *
 * `tokenURI` returns a `data:application/json;base64` document carrying the
 * token's description, website and image. It is the token's own claim about
 * itself, held to exactly the standard `symbol()` is: displayed, and marked
 * where the chain contradicts it.
 */
export const launchpadTokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function creator() view returns (address)',
  'function graffiti() view returns (bytes32)',
  'function tokenURI() view returns (string)',
])

export const launchpadFactoryAbi = parseAbi([
  'function getUERC20Address(string name, string symbol, uint8 decimals, address creator, bytes32 graffiti) view returns (address)',
])
