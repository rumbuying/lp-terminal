import { getAddress, type Address } from 'viem'

// This command is intentionally read-only. It derives every pool identity from
// the canonical contracts, then exercises the same preflight used by the live
// executor without importing or unlocking a private key.
const tokenId = BigInt(process.env.LP_PREFLIGHT_TOKEN_ID ?? '34711')
const { ADDR } = await import('../src/config/addresses')
const { clFactoryAbi, clPmAbi, clPoolAbi } = await import('../src/abi')
const { publicClient } = await import('../executor/chain')
const raw = await publicClient.readContract({ address: ADDR.CL_PM, abi: clPmAbi, functionName: 'positions', args: [tokenId] })
const position = raw as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]
const owner = await publicClient.readContract({ address: ADDR.CL_PM, abi: clPmAbi, functionName: 'ownerOf', args: [tokenId] })
const pool = await publicClient.readContract({ address: ADDR.CL_FACTORY, abi: clFactoryAbi, functionName: 'getPool', args: [position[2], position[3], Number(position[4])] })
const [poolToken0, poolToken1] = await Promise.all([
  publicClient.readContract({ address: pool, abi: clPoolAbi, functionName: 'token0' }),
  publicClient.readContract({ address: pool, abi: clPoolAbi, functionName: 'token1' }),
])
if (poolToken0.toLowerCase() !== position[2].toLowerCase() || poolToken1.toLowerCase() !== position[3].toLowerCase()) throw new Error('E_POOL_IDENTITY')

const { originalStrategyDraft } = await import('../shared/strategy/schema')
const base = originalStrategyDraft({
  owner: getAddress(owner),
  protocol: 'up33',
  pool: getAddress(pool),
  positionManager: ADDR.CL_PM,
  activeTokenId: tokenId.toString(),
  riskToken: getAddress(position[2]),
  quoteToken: getAddress(position[3]),
  name: `real preflight #${tokenId}`,
})
const config = {
  ...base,
  enabled: true,
  execution: { ...base.execution, mode: 'executor_auto' as const, walletId: 'preflight_read_only', signerAddress: getAddress(owner), dryRun: true },
}
const { preflightStrategy } = await import('../executor/preflight')
const report = await preflightStrategy(config)
console.log(JSON.stringify({
  ready: report.ready,
  checkedAt: report.checkedAt,
  blockNumber: report.blockNumber,
  position: report.position,
  pool,
  token0: position[2],
  token1: position[3],
  currentTicks: { lower: Number(position[5]), upper: Number(position[6]) },
  nextRange: report.range,
  gas: report.gas,
  routes: report.routes,
  expected: report.expected,
  limitations: report.limitations,
}, null, 2))
