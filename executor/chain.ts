import { createPublicClient, http, type Address } from 'viem'
import { robinhood } from 'viem/chains'
import { clFactoryAbi, clGaugeAbi, clPmAbi, clPoolAbi, erc20Abi, uniV3FactoryAbi, uniV3PmAbi, uniV3PoolAbi, voterAbi } from '../src/abi'
import { ADDR, UNI } from '../src/config/addresses'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'
import { EXECUTOR } from './config'
import { recordRpcRequest } from './rpc-metrics'

/** Read/preflight RPC retries tolerate short provider outages and rate limits. */
export const publicClient = createPublicClient({
  chain: robinhood,
  transport: http(EXECUTOR.rpcUrl, {
    batch: true,
    onFetchRequest: recordRpcRequest('read'),
    retryCount: EXECUTOR.rpcRetryCount,
    retryDelay: EXECUTOR.rpcRetryDelayMs,
    timeout: EXECUTOR.rpcTimeoutMs,
  }),
})

/**
 * Raw broadcasts are handled separately by signer.ts. Transport-level retries
 * are disabled there so only the exact same durable serialized transaction is
 * ever retried after an ambiguous network failure.
 */
export const broadcastClient = createPublicClient({
  chain: robinhood,
  transport: http(EXECUTOR.rpcUrl, { onFetchRequest: recordRpcRequest('broadcast'), retryCount: 0, timeout: EXECUTOR.rpcTimeoutMs }),
})
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Actual wallet amounts after each receipt; plans never spend cached estimates. */
export async function readTokenBalances(owner: Address, tokens: readonly Address[]): Promise<Record<string, bigint>> {
  const values = await Promise.all(tokens.map((token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })))
  return Object.fromEntries(tokens.map((token, index) => [token.toLowerCase(), values[index]]))
}

export async function readAllowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
}

/** Simulate a fees-only collect without changing state. */
export async function readCollectableFees(config: StrategyConfig): Promise<{ amount0: bigint; amount1: bigint }> {
  if (!config.activeTokenId) throw new Error('strategy has no active token id')
  if (config.staking?.enabled) {
    const raw = await publicClient.readContract({ address: config.positionManager, abi: clPmAbi, functionName: 'positions', args: [BigInt(config.activeTokenId)] })
    const position = raw as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
    return { amount0: position[10], amount1: position[11] }
  }
  const abi = config.protocol === 'up33' ? clPmAbi : uniV3PmAbi
  const simulation = await publicClient.simulateContract({
    account: config.owner,
    address: config.positionManager,
    abi,
    functionName: 'collect',
    args: [{ tokenId: BigInt(config.activeTokenId), recipient: config.owner, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }],
  } as never)
  const result = simulation.result as unknown as readonly [bigint, bigint]
  return { amount0: BigInt(result[0]), amount1: BigInt(result[1]) }
}

type SnapshotReadOptions = { allowRewardReadFailure?: boolean; skipRewardRead?: boolean }

export async function readStakingCustody(config: StrategyConfig, tokenId = config.activeTokenId, options?: SnapshotReadOptions) {
  if (!config.staking?.enabled || !config.staking.gauge || !tokenId) throw new Error('E_STAKING_CONFIG')
  const earnedRead = options?.skipRewardRead
    ? Promise.resolve({ earned: undefined, error: undefined })
    : publicClient.readContract({ address: config.staking.gauge, abi: clGaugeAbi, functionName: 'earned', args: [config.owner, BigInt(tokenId)] })
      .then((earned) => ({ earned, error: undefined }))
      .catch((error) => {
        if (!options?.allowRewardReadFailure) throw error
        return { earned: undefined, error: error instanceof Error ? error.message.slice(0, 160) : 'reward read unavailable' }
      })
  const [nftOwner, stakedIds, reward, poolGauge, alive] = await Promise.all([
    publicClient.readContract({ address: config.positionManager, abi: clPmAbi, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
    publicClient.readContract({ address: config.staking.gauge, abi: clGaugeAbi, functionName: 'stakedValues', args: [config.owner] }),
    earnedRead,
    publicClient.readContract({ address: config.pool, abi: clPoolAbi, functionName: 'gauge' }),
    publicClient.readContract({ address: ADDR.VOTER, abi: voterAbi, functionName: 'isAlive', args: [config.staking.gauge] }),
  ])
  const deposited = stakedIds.some((id) => id === BigInt(tokenId))
  return { nftOwner, deposited, earned: reward.earned, rewardReadError: reward.error, poolGauge, alive }
}

export async function readPoolState(config: StrategyConfig) {
  const poolAbi = config.protocol === 'up33' ? clPoolAbi : uniV3PoolAbi
  const [slot0, spacing, feePpm, unstakedFeePpm] = await Promise.all([
    publicClient.readContract({ address: config.pool, abi: poolAbi, functionName: 'slot0' }),
    publicClient.readContract({ address: config.pool, abi: poolAbi, functionName: 'tickSpacing' }),
    publicClient.readContract({ address: config.pool, abi: poolAbi, functionName: 'fee' }),
    config.protocol === 'up33'
      ? publicClient.readContract({ address: config.pool, abi: clPoolAbi, functionName: 'unstakedFee' })
      : Promise.resolve(0),
  ])
  const state = slot0 as unknown as readonly [bigint, number]
  return {
    sqrtPriceX96: state[0],
    tick: Number(state[1]),
    tickSpacing: Number(spacing),
    feePpm: Number(feePpm),
    unstakedFeePpm: Number(unstakedFeePpm),
  }
}

/** Reads the full identity needed by the planner. Never uses indexer/cache data. */
export async function readStrategySnapshot(config: StrategyConfig, options?: SnapshotReadOptions): Promise<StrategyPositionSnapshot> {
  if (!config.activeTokenId) throw new Error('strategy has no active token id')
  const tokenId = BigInt(config.activeTokenId)
  const pmAbi = config.protocol === 'up33' ? clPmAbi : uniV3PmAbi
  const poolAbi = config.protocol === 'up33' ? clPoolAbi : uniV3PoolAbi
  const [blockNumber, nftOwner, raw, slot0, spacing, feePpm, unstakedFeePpm, dRisk, dQuote, poolToken0, poolToken1] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.readContract({ address: config.positionManager, abi: pmAbi, functionName: 'ownerOf', args: [tokenId] }),
    publicClient.readContract({ address: config.positionManager, abi: pmAbi, functionName: 'positions', args: [tokenId] }),
    publicClient.readContract({ address: config.pool, abi: poolAbi, functionName: 'slot0' }),
    publicClient.readContract({ address: config.pool, abi: poolAbi, functionName: 'tickSpacing' }),
    publicClient.readContract({ address: config.pool, abi: poolAbi, functionName: 'fee' }),
    config.protocol === 'up33'
      ? publicClient.readContract({ address: config.pool, abi: clPoolAbi, functionName: 'unstakedFee' })
      : Promise.resolve(0),
    publicClient.readContract({ address: config.riskToken, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: config.quoteToken, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: config.pool, abi: poolAbi, functionName: 'token0' }),
    publicClient.readContract({ address: config.pool, abi: poolAbi, functionName: 'token1' }),
  ])
  const p = raw as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
  const s = slot0 as unknown as readonly [bigint, number]
  let rewardOwed: bigint | undefined = options?.skipRewardRead ? undefined : 0n
  let rewardReadError: string | undefined
  if (config.staking?.enabled) {
    const custody = await readStakingCustody(config, tokenId.toString(), options)
    if (!config.staking.gauge || !same(custody.poolGauge, config.staking.gauge) || !same(nftOwner, config.staking.gauge) || !custody.deposited || !custody.alive)
      throw new Error('E_STAKING_CUSTODY')
    rewardOwed = custody.earned
    rewardReadError = custody.rewardReadError
  } else if (!same(nftOwner, config.owner)) throw new Error('E_OWNER')
  if (!same(p[2], config.riskToken) && !same(p[3], config.riskToken)) throw new Error('position risk token does not match strategy')
  if (!same(p[2], config.quoteToken) && !same(p[3], config.quoteToken)) throw new Error('position quote token does not match strategy')
  if (!same(poolToken0, p[2]) || !same(poolToken1, p[3])) throw new Error('E_POOL_IDENTITY')
  if (config.protocol === 'up33' && Number(p[4]) !== Number(spacing)) throw new Error('E_POOL_IDENTITY')
  if (config.protocol === 'univ3' && Number(p[4]) !== Number(feePpm)) throw new Error('E_POOL_IDENTITY')
  const canonicalPool = config.protocol === 'up33'
    ? await publicClient.readContract({ address: ADDR.CL_FACTORY, abi: clFactoryAbi, functionName: 'getPool', args: [p[2], p[3], Number(spacing)] })
    : await publicClient.readContract({ address: UNI.V3_FACTORY, abi: uniV3FactoryAbi, functionName: 'getPool', args: [p[2], p[3], Number(feePpm)] })
  if (!same(canonicalPool, config.pool)) throw new Error('E_POOL_IDENTITY')
  return {
    chainId: 4663,
    observedAt: Math.floor(Date.now() / 1000),
    blockNumber: blockNumber.toString(),
    owner: config.owner,
    protocol: config.protocol,
    pool: config.pool,
    positionManager: config.positionManager,
    tokenId: tokenId.toString(),
    token0: p[2],
    token1: p[3],
    token0Decimals: same(p[2], config.riskToken) ? Number(dRisk) : Number(dQuote),
    token1Decimals: same(p[3], config.riskToken) ? Number(dRisk) : Number(dQuote),
    tickSpacing: Number(spacing), feePpm: Number(feePpm), unstakedFeePpm: Number(unstakedFeePpm), tick: Number(s[1]), sqrtPriceX96: s[0].toString(),
    tickLower: Number(p[5]), tickUpper: Number(p[6]), liquidity: p[7].toString(), tokensOwed0: p[10].toString(), tokensOwed1: p[11].toString(),
    staked: config.staking?.enabled === true,
    gauge: config.staking?.enabled ? config.staking.gauge : undefined,
    nftOwner,
    rewardOwed: rewardOwed?.toString(),
    rewardReadError,
  }
}

type MonitorBaseline = { key: string; validatedAt: number; snapshot: StrategyPositionSnapshot }
const monitorBaselines = new Map<string, MonitorBaseline>()
const monitorLatest = new Map<string, { key: string; observedAtMs: number; snapshot: StrategyPositionSnapshot }>()

const monitorKey = (config: StrategyConfig) => `${config.id}:${config.revision}:${config.activeTokenId}`
const monitorBaseline = (config: StrategyConfig) => {
  const key = monitorKey(config)
  const cached = monitorBaselines.get(config.id)
  return cached && cached.key === key && Date.now() - cached.validatedAt < EXECUTOR.monitorIdentityTtlSeconds * 1000 ? cached : undefined
}

function rememberMonitorSnapshot(config: StrategyConfig, snapshot: StrategyPositionSnapshot) {
  monitorLatest.set(config.id, { key: monitorKey(config), observedAtMs: Date.now(), snapshot })
  return snapshot
}

/** Latest chain snapshot already paid for by boundary monitoring. */
export function latestMonitorSnapshot(config: StrategyConfig): StrategyPositionSnapshot | undefined {
  const cached = monitorLatest.get(config.id)
  const maxAgeMs = Math.max(config.trigger.pollSeconds, EXECUTOR.monitorMinSeconds) * 2_000
  return cached && cached.key === monitorKey(config) && Date.now() - cached.observedAtMs <= maxAgeMs ? cached.snapshot : undefined
}

/**
 * Monitoring needs only the live pool price and the position's mutable range /
 * liquidity. Token metadata, canonical factory identity, gauge liveness and
 * custody are slow-changing facts; revalidate them periodically and always do
 * the full read again in preflight before a signature.
 */
export async function readMonitorSnapshot(config: StrategyConfig, blockNumber: bigint): Promise<StrategyPositionSnapshot> {
  const result = (await readMonitorSnapshots([config], blockNumber)).get(config.id)
  if (result instanceof Error) throw result
  if (!result) throw new Error('E_MONITOR_SNAPSHOT')
  return result
}

/**
 * Reads every due strategy in one Multicall3. A failed subcall is isolated to
 * its strategy; slow-changing identity baselines are still fully revalidated.
 */
export async function readMonitorSnapshots(
  configs: readonly StrategyConfig[],
  blockNumber: bigint,
): Promise<Map<string, StrategyPositionSnapshot | Error>> {
  const out = new Map<string, StrategyPositionSnapshot | Error>()
  const fast: { config: StrategyConfig; cached: MonitorBaseline }[] = []
  const full: StrategyConfig[] = []
  for (const config of configs) {
    if (!config.activeTokenId) {
      out.set(config.id, new Error('strategy has no active token id'))
      continue
    }
    const cached = monitorBaseline(config)
    if (cached) fast.push({ config, cached })
    else full.push(config)
  }

  await Promise.all(full.map(async (config) => {
    try {
      const snapshot = await readStrategySnapshot(config, { allowRewardReadFailure: true, skipRewardRead: true })
      monitorBaselines.set(config.id, { key: monitorKey(config), validatedAt: Date.now(), snapshot })
      out.set(config.id, rememberMonitorSnapshot(config, snapshot))
    } catch (error) {
      out.set(config.id, error instanceof Error ? error : new Error('monitor identity read failed'))
    }
  }))

  if (fast.length === 0) return out
  try {
    const contracts = fast.flatMap(({ config }) => {
      const tokenId = BigInt(config.activeTokenId!)
      return [
        {
          address: config.positionManager,
          abi: config.protocol === 'up33' ? clPmAbi : uniV3PmAbi,
          functionName: 'positions',
          args: [tokenId],
        },
        {
          address: config.pool,
          abi: config.protocol === 'up33' ? clPoolAbi : uniV3PoolAbi,
          functionName: 'slot0',
        },
      ]
    })
    const results = await publicClient.multicall({ contracts: contracts as never, allowFailure: true, blockNumber }) as { status: 'success' | 'failure'; result?: unknown; error?: Error }[]
    fast.forEach(({ config, cached }, index) => {
      const positionResult = results[index * 2]
      const slot0Result = results[index * 2 + 1]
      if (positionResult?.status !== 'success' || slot0Result?.status !== 'success') {
        out.set(config.id, positionResult?.error ?? slot0Result?.error ?? new Error('monitor multicall failed'))
        return
      }
      const p = positionResult.result as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
      const s = slot0Result.result as readonly [bigint, number]
      if (!same(p[2], cached.snapshot.token0) || !same(p[3], cached.snapshot.token1)) {
        out.set(config.id, new Error('E_POOL_IDENTITY'))
        return
      }
      const snapshot: StrategyPositionSnapshot = {
        ...cached.snapshot,
        observedAt: Math.floor(Date.now() / 1000),
        blockNumber: blockNumber.toString(),
        tick: Number(s[1]),
        sqrtPriceX96: s[0].toString(),
        tickLower: Number(p[5]),
        tickUpper: Number(p[6]),
        liquidity: p[7].toString(),
        tokensOwed0: p[10].toString(),
        tokensOwed1: p[11].toString(),
        rewardOwed: undefined,
        rewardReadError: undefined,
      }
      out.set(config.id, rememberMonitorSnapshot(config, snapshot))
    })
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('monitor multicall failed')
    for (const { config } of fast) out.set(config.id, failure)
  }
  return out
}

/** Valuation reuses the fresh monitor snapshot and only refreshes UP rewards. */
export async function readPerformanceSnapshot(config: StrategyConfig): Promise<StrategyPositionSnapshot> {
  const cached = latestMonitorSnapshot(config)
  if (!cached) return readStrategySnapshot(config, { allowRewardReadFailure: true })
  if (!config.staking?.enabled || !config.staking.gauge || !config.activeTokenId) return cached
  try {
    const earned = await publicClient.readContract({
      address: config.staking.gauge,
      abi: clGaugeAbi,
      functionName: 'earned',
      args: [config.owner, BigInt(config.activeTokenId)],
    })
    return { ...cached, rewardOwed: earned.toString(), rewardReadError: undefined }
  } catch (error) {
    return {
      ...cached,
      rewardOwed: undefined,
      rewardReadError: error instanceof Error ? error.message.slice(0, 160) : 'reward read unavailable',
    }
  }
}
