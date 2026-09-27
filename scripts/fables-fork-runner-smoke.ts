/** Full executor cycle on a loopback Anvil fork with a disposable test signer. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, encodeFunctionData, getAddress, http, toEventSelector, toHex,
  type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { fablesHookAbi } from '../src/abi/fables'
import { FABLES_AUTO_POOL_IDS, fablesHook } from '../src/config/fables'
import { robinhoodConfig } from '../src/config/chains/robinhood'
import { quoteFablesExit } from '../src/lib/fablesExitQuote'

const rpc = process.env.FABLES_FORK_RPC
if (!rpc || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(rpc))
  throw new Error('FABLES_FORK_RPC must be an explicit loopback Anvil URL')
const fork = createPublicClient({ transport: http(rpc, { timeout: 120_000 }) })
const discoveryRpc = process.env.FABLES_FORK_UPSTREAM_RPC
  ? 'http://127.0.0.1:8546' : robinhoodConfig.publicRpc
const remote = createPublicClient({ transport: http(discoveryRpc, { timeout: 30_000 }) })
const hook = getAddress(process.env.FABLES_TEST_HOOK
  || '0x06a889870c8f83640d6816319f72e2aa579b6080')
const poolId = (process.env.FABLES_TEST_POOL_ID
  || '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551').toLowerCase() as Hex
if (!/^0x[0-9a-f]{64}$/.test(poolId) || !fablesHook(hook))
  throw new Error('fork fixture must name a reviewed Fables hook and PoolId')
const testKey = generatePrivateKey()
const testAccount = privateKeyToAccount(testKey)

async function anvil(method: string, params: unknown[]) {
  return fork.request({ method, params } as never)
}

async function fixture() {
  if (process.env.FABLES_TEST_OWNER && process.env.FABLES_TEST_RANGE_ID) {
    const owner = getAddress(process.env.FABLES_TEST_OWNER)
    const rangeId = BigInt(process.env.FABLES_TEST_RANGE_ID)
    const quote = await quoteFablesExit(fork, { owner, hook, rangeId, slippageBps: 100 })
    if (quote.position.pool.id.toLowerCase() !== poolId || quote.position.inRange)
      throw new Error('explicit fork fixture is not an out-of-range position in the selected pool')
    return { owner, rangeId, quote }
  }
  const head = await fork.getBlockNumber()
  const remoteHead = await remote.getBlockNumber()
  const scanHead = remoteHead < head ? remoteHead : head
  const topic = toEventSelector('Deposited(address,uint256,uint128)')
  for (const history of [20_000n, 100_000n, 300_000n]) {
    process.stdout.write(`Scanning ${history} recent fork blocks for a funded out-of-range position\n`)
    const logs = await remote.request({ method: 'eth_getLogs', params: [{ address: hook,
      topics: [topic], fromBlock: toHex(scanHead > history ? scanHead - history : 0n), toBlock: toHex(scanHead) }] }) as
      Array<{ topics: Hex[] }>
    const seen = new Set<string>()
    for (const log of logs.reverse()) {
      const owner = getAddress(`0x${log.topics[1].slice(-40)}`)
      const rangeId = BigInt(log.topics[2])
      const id = `${owner}:${rangeId}`
      if (seen.has(id)) continue
      seen.add(id)
      try {
        const shares = await fork.readContract({ address: hook, abi: fablesHookAbi,
          functionName: 'balanceOf', args: [owner, rangeId] })
        if (shares <= 0n) continue
        const quote = await quoteFablesExit(fork, { owner, hook, rangeId, slippageBps: 100 })
        if (quote.position.pool.id.toLowerCase() === poolId)
          process.stdout.write(JSON.stringify({ candidateOwner: owner, rangeId: rangeId.toString(),
            inRange: quote.position.inRange, shares: shares.toString(),
            principal: [quote.principal0.toString(), quote.principal1.toString()] }) + '\n')
        if (quote.position.pool.id.toLowerCase() === poolId && !quote.position.inRange
          && (quote.principal0 > 0n || quote.principal1 > 0n))
          return { owner, rangeId, quote }
      } catch (error) {
        if (error instanceof Error && ['E_FABLES_POSITION_EMPTY','E_FABLES_STAKED_UNSUPPORTED',
          'E_FABLES_CLAIM_PAUSED'].includes(error.message)) continue
        throw error
      }
    }
  }
  throw new Error('no live out-of-range Fables position in the selected pool in recent events')
}

function quoteValueInUsdg(principal0: bigint, principal1: bigint, sqrtPriceX96: bigint,
  usdIs0: boolean): bigint {
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96
  const q192 = 1n << 192n
  return usdIs0 ? principal0 + principal1 * q192 / ratioX192
    : principal1 + principal0 * ratioX192 / q192
}

async function run() {
  if (!await anvil('anvil_nodeInfo', []) || await fork.getChainId() !== 4663)
    throw new Error('not a Robinhood Anvil fork')
  const found = await fixture()
  const key = found.quote.position.pool.key
  const usdIs0 = key.currency0.toLowerCase() === robinhoodConfig.addr.STABLE.toLowerCase()
  const usdIs1 = key.currency1.toLowerCase() === robinhoodConfig.addr.STABLE.toLowerCase()
  if (usdIs0 === usdIs1) throw new Error('test fixture must contain exactly one USDG leg')
  const quoted = quoteValueInUsdg(
    found.quote.principal0 + found.quote.claimable0,
    found.quote.principal1 + found.quote.claimable1,
    found.quote.position.sqrtPriceX96, usdIs0)
  if (quoted <= 0n) throw new Error('fixture has no USDG spot value')
  const target = 200_000_000n
  const transferredShares = quoted > target
    ? found.quote.position.shares * target / quoted : found.quote.position.shares
  if (transferredShares <= 0n) throw new Error('fixture shares too small for bounded test')
  const transferAbi = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'receiver', type: 'address' }, { name: 'id', type: 'uint256' },
      { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const
  await anvil('anvil_setBalance', [found.owner, toHex(5n * 10n ** 18n)])
  await anvil('anvil_setBalance', [testAccount.address, toHex(5n * 10n ** 18n)])
  const transferHash = await anvil('eth_sendTransaction', [{ from: found.owner, to: hook,
    data: encodeFunctionData({ abi: transferAbi, functionName: 'transfer',
      args: [testAccount.address, found.rangeId, transferredShares] }), gas: toHex(10_000_000) }]) as Hex
  if ((await fork.waitForTransactionReceipt({ hash: transferHash })).status !== 'success')
    throw new Error('test share transfer failed')
  const moved = await quoteFablesExit(fork, { owner: testAccount.address, hook, rangeId: found.rangeId, slippageBps: 100 })
  if (moved.position.shares !== transferredShares || moved.position.inRange)
    throw new Error('test share transfer changed the expected position')
  if (quoteValueInUsdg(moved.principal0 + moved.claimable0,
    moved.principal1 + moved.claimable1, moved.position.sqrtPriceX96, usdIs0) > target)
    throw new Error('transferred fork position exceeds 200 USDG spot-value cap')
  process.stdout.write(JSON.stringify({ fixtureOwner: found.owner, rangeId: found.rangeId.toString(),
    originalQuote: [found.quote.principal0.toString(), found.quote.principal1.toString()],
    transferredQuote: [moved.principal0.toString(), moved.principal1.toString()] }) + '\n')
  if (moved.principal0 === 0n && moved.principal1 === 0n)
    throw new Error('transferred shares have no exit principal')

  const directory = mkdtempSync(join(tmpdir(), 'fables-runner-fork-'))
  const keyPath = join(directory, 'signer.key')
  writeFileSync(keyPath, `${testKey}\n`, { mode: 0o600 })
  process.env.LP_EXECUTOR_DATA_DIR = directory
  process.env.LP_EXECUTOR_RPC = rpc
  process.env.LP_EXECUTOR_CHAIN_ID = '4663'
  process.env.LP_EXECUTOR_PRIVATE_KEY_FILE = keyPath
  process.env.LP_EXECUTOR_PRIVATE_KEY_WALLET_ID = 'fables-fork-signer'
  process.env.LP_EXECUTOR_CONFIRMATIONS = '1'
  FABLES_AUTO_POOL_IDS.add(poolId)
  const [{ addWallet }, store, jobs, runner] = await Promise.all([
    import('../executor/store'), import('../executor/fablesStore'),
    import('../executor/fablesJobs'), import('../executor/fablesRunner'),
  ])
  const at = Math.floor(Date.now() / 1000)
  addWallet({ id: 'fables-fork-signer', label: 'Fork signer', address: testAccount.address,
    vaultPath: `private-key-file:${keyPath}`, createdAt: at, updatedAt: at })
  const config = {
    version: 2, protocol: 'fables', chainId: 4663,
    id: 'fables-fork-cycle', name: 'Fables fork cycle', enabled: true,
    owner: testAccount.address, poolManager: robinhoodConfig.uniV4!.POOL_MANAGER,
    positionRef: { kind: 'fables_range', poolId, hook, rangeId: found.rangeId.toString(),
      tickLower: moved.position.tickLower, tickUpper: moved.position.tickUpper },
    riskToken: usdIs0 ? key.currency1 : key.currency0,
    quoteToken: robinhoodConfig.addr.STABLE,
    range: { lowerPct: 5, upperPct: 5 },
    trigger: { pollSeconds: 4, confirmationSeconds: 0, cooldownMinutes: 0 },
    fees: { handling: 'reinvest' },
    safeguards: { maxSlippageBps: 500, maxSwapImpactBps: 500,
      maxRebalancesPerDay: 6, maxPlanAgeSeconds: 300, maxClaimFeeBps: 1_000,
      allowLegacyUnboundedFeeExit: true, minNativeGasReserveWei: '10000000000000000' },
    execution: { mode: 'executor_auto', walletId: 'fables-fork-signer',
      signerAddress: testAccount.address, dryRun: false,
      maxDailyTurnoverQuote: '1000000000' },
    revision: 1, createdAt: at, updatedAt: at,
  } as const
  store.upsertFablesStrategy(config)
  store.updateFablesMonitorState(config.id, { revision: 1, outSide: 'upper',
    outSince: at, lastTick: moved.position.tick, lastBlock: moved.position.observedBlock.toString() }, 'dry_run_ready')
  const job = jobs.createFablesJob(config)
  let previous = ''
  for (let i = 0; i < 15; i += 1) {
    await runner.runFablesOnce()
    const current = jobs.fablesJobById(job.id)!
    const state = `${current.state}:${current.stage}:${jobs.fablesJobTransactions(job.id).length}`
    if (state !== previous) process.stdout.write(`${state}\n`)
    previous = state
    if (current.state === 'completed') {
      process.stdout.write(JSON.stringify({ forkBlock: (await fork.getBlockNumber()).toString(),
        oldRangeId: config.positionRef.rangeId,
        newRangeId: store.fablesStrategyById(config.id)!.config.positionRef.rangeId,
        txHashes: jobs.fablesJobTransactions(job.id).map(tx => tx.hash),
        db: directory }) + '\n')
      return
    }
    if (current.state === 'failed') throw new Error(`Fables fork job failed: ${current.errorCode}`)
  }
  const current = jobs.fablesJobById(job.id)!
  throw new Error(`Fables fork job did not complete: ${current.stage} ${current.errorCode}; db=${directory}`)
}

run().catch(error => { console.error(error); process.exitCode = 1 })
