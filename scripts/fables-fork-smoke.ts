/**
 * Destructive transaction proof on an isolated Anvil fork only. Run an
 * Anvil fork with a logs/storage capable RPC, then set
 * FABLES_FORK_RPC=http://127.0.0.1:8545.
 */
import { createPublicClient, encodeFunctionData, getAddress, http, toEventSelector, toHex, type Address, type Hex } from 'viem'
import { fablesHookAbi, fablesLensAbi } from '../src/abi/fables'
import { FABLES_AUTO_POOL_IDS, FABLES_LENS } from '../src/config/fables'
import { robinhoodConfig } from '../src/config/chains/robinhood'
import { quoteFablesExit } from '../src/lib/fablesExitQuote'
import { readFablesPosition } from '../src/lib/fables'
import { prepareFablesClaimCall, prepareFablesDepositCall, prepareFablesExitCall } from '../src/lib/fablesWrite'

const rpc = process.env.FABLES_FORK_RPC
if (!rpc || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(rpc))
  throw new Error('FABLES_FORK_RPC must be an explicit loopback Anvil URL')
const client = createPublicClient({ transport: http(rpc, { timeout: 120_000 }) })
const remote = createPublicClient({ transport: http(robinhoodConfig.publicRpc, { timeout: 30_000 }) })

const hookKinds = [
  {
    name: 'legacy-native',
    hook: '0x06a889870c8f83640d6816319f72e2aa579b6080',
    expectedMethod: 'withdraw',
  },
  {
    name: 'new-combined',
    hook: '0x5eb87f69be00df39981622fd60a8de4b7837e080',
    expectedMethod: 'withdrawAndClaim',
  },
] as const

async function findFixture(kind: typeof hookKinds[number]) {
  const head = await client.getBlockNumber()
  const topic = toEventSelector('Deposited(address,uint256,uint128)')
  for (const history of [20_000n, 100_000n]) {
    const logs = await remote.request({
      method: 'eth_getLogs', params: [{ address: kind.hook, topics: [topic],
        fromBlock: toHex(head > history ? head - history : 0n), toBlock: toHex(head) }],
    }) as Array<{ topics: Hex[] }>
    const seen = new Set<string>()
    for (const log of logs.reverse()) {
      if (log.topics.length !== 3) throw new Error('malformed Fables deposit log')
      const owner = getAddress(`0x${log.topics[1].slice(-40)}`)
      const rangeId = BigInt(log.topics[2])
      const identity = `${owner}:${rangeId}`
      if (seen.has(identity)) continue
      seen.add(identity)
      try {
        const shares = await client.readContract({ address: kind.hook, abi: fablesHookAbi,
          functionName: 'balanceOf', args: [owner, rangeId] })
        if (shares <= 1n) continue
        const quote = await quoteFablesExit(client, { owner, hook: kind.hook, rangeId, slippageBps: 100 })
        if (quote.position.shares > 1n && quote.exitMethod === kind.expectedMethod)
          return { ...kind, owner, rangeId, quote }
      } catch (error) {
        if (error instanceof Error && ['E_FABLES_POSITION_EMPTY', 'E_FABLES_STAKED_UNSUPPORTED',
          'E_FABLES_CLAIM_PAUSED'].includes(error.message)) continue
        throw error
      }
    }
  }
  throw new Error(`${kind.name}: no live, withdrawable example in recent deposit events`)
}

async function anvil(method: string, params: unknown[]): Promise<unknown> {
  return client.request({ method, params } as never)
}

async function send(from: Address, to: Address, data: Hex, value = 0n): Promise<Hex> {
  const hash = await client.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data, gas: '0x989680', value: toHex(value) }],
  } as never) as Hex
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`fork transaction reverted: ${hash}`)
  return hash
}

async function run() {
  const info = await anvil('anvil_nodeInfo', [])
  if (!info || await client.getChainId() !== 4663) throw new Error('not a Robinhood Anvil fork')
  const forkBaseBlock = await client.getBlockNumber()
  const results = []
  for (const kind of hookKinds) {
    const fixture = await findFixture(kind)
    const { quote } = fixture
    if (quote.exitMethod !== fixture.expectedMethod || quote.position.shares <= 0n)
      throw new Error(`${fixture.name}: wrong hook capability or missing shares`)
    // This process-local exception is solely for proof on Anvil. The shipped
    // production manifest remains empty until every release gate is met.
    FABLES_AUTO_POOL_IDS.add(quote.position.pool.id.toLowerCase())
    await anvil('anvil_setBalance', [fixture.owner, '0x56bc75e2d63100000'])
    if (fixture.expectedMethod === 'withdrawAndClaim') {
      // Slot 13 is pausedUntil for this pinned hook bytecode. It is set only
      // on Anvil and reverted before the rest of the proof runs.
      const pauseSnapshot = await anvil('evm_snapshot', [])
      await anvil('anvil_setStorageAt', [fixture.hook, toHex(13, { size: 32 }),
        toHex((await client.getBlock()).timestamp + 3600n, { size: 32 })])
      const paused = await client.readContract({ address: fixture.hook, abi: fablesHookAbi,
        functionName: 'pausedFor', args: [quote.position.pool.id] })
      if (!paused) throw new Error('fork pause override did not take effect')
      try {
        await quoteFablesExit(client, { ...fixture, slippageBps: 100 })
        throw new Error('paused exit was incorrectly quoted as executable')
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'E_FABLES_CLAIM_PAUSED') throw error
      }
      const pauseArgs = [quote.position.pool.key, quote.position.tickLower,
        quote.position.tickUpper, quote.position.shares / 2n,
        fixture.owner, 0n, 0n, (await client.getBlock()).timestamp + 300n] as const
      const combined = encodeFunctionData({ abi: fablesHookAbi, functionName: 'withdrawAndClaim',
        args: [...pauseArgs, quote.maxFeeBpsToPass] })
      try {
        await send(fixture.owner, fixture.hook, combined)
        throw new Error('paused combined exit unexpectedly succeeded')
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('fork transaction reverted:'))
          throw error
      }
      const principalOnly = encodeFunctionData({ abi: fablesHookAbi,
        functionName: 'withdraw', args: pauseArgs })
      await send(fixture.owner, fixture.hook, principalOnly)
      const remaining = await client.readContract({ address: fixture.hook, abi: fablesHookAbi,
        functionName: 'balanceOf', args: [fixture.owner, fixture.rangeId] })
      if (remaining !== quote.position.shares - quote.position.shares / 2n)
        throw new Error('paused principal-only exit burned wrong shares')
      if (await anvil('evm_revert', [pauseSnapshot]) !== true)
        throw new Error('could not restore fork after pause proof')
      await anvil('anvil_mine', [1])
    }
    const snapshotId = await anvil('evm_snapshot', [])
    const half = quote.position.shares / 2n
    if (half <= 0n) throw new Error(`${fixture.name}: cannot test partial withdrawal`)
    const partialArgs = [
      quote.position.pool.key, quote.position.tickLower, quote.position.tickUpper,
      half, fixture.owner, 0n, 0n, (await client.getBlock()).timestamp + 300n,
    ] as const
    const partialData = quote.exitMethod === 'withdrawAndClaim'
      ? encodeFunctionData({ abi: fablesHookAbi, functionName: 'withdrawAndClaim',
        args: [...partialArgs, quote.maxFeeBpsToPass] })
      : encodeFunctionData({ abi: fablesHookAbi, functionName: 'withdraw', args: partialArgs })
    await send(fixture.owner, fixture.hook, partialData)
    const partialShares = await client.readContract({ address: fixture.hook, abi: fablesHookAbi,
      functionName: 'balanceOf', args: [fixture.owner, fixture.rangeId] })
    if (partialShares !== quote.position.shares - half)
      throw new Error(`${fixture.name}: withdraw argument did not burn exactly that many shares`)
    const [partialView] = await client.readContract({ address: FABLES_LENS, abi: fablesLensAbi,
      functionName: 'userRanges', args: [fixture.hook, fixture.owner, [fixture.rangeId]] })
    if (!partialView[0] || partialView[0].totalShares - partialView[0].shares
      !== quote.position.totalShares - quote.position.shares)
      throw new Error(`${fixture.name}: another holder's shares changed`)
    if (await anvil('evm_revert', [snapshotId]) !== true)
      throw new Error(`${fixture.name}: could not restore fork after partial withdrawal`)
    // viem briefly caches the pre-revert head. Mine an empty block so that
    // same height is again valid for any in-flight cached block number.
    await anvil('anvil_mine', [1])
    const exit = await prepareFablesExitCall(client, {
      ...fixture, slippageBps: 100, maxClaimFeeBps: 1_000,
      lifetimeSeconds: 300, allowLegacyUnboundedFeeExit: true,
    })
    const exitHash = await send(fixture.owner, exit.to, exit.data)
    const sharesAfter = await client.readContract({
      address: fixture.hook, abi: fablesHookAbi, functionName: 'balanceOf',
      args: [fixture.owner, fixture.rangeId],
    })
    if (sharesAfter !== 0n) throw new Error(`${fixture.name}: shares remain after exit`)
    let claimHash: Hex | null = null
    if (fixture.expectedMethod === 'withdraw') {
      const claim = await prepareFablesClaimCall(client, {
        owner: fixture.owner, hook: fixture.hook,
        rangeId: fixture.rangeId, maxClaimFeeBps: 1_000,
      })
      claimHash = await send(fixture.owner, claim.to, claim.data)
    }
    const [after] = await client.readContract({
      address: FABLES_LENS, abi: fablesLensAbi, functionName: 'userRanges',
      args: [fixture.hook, fixture.owner, [fixture.rangeId]],
    })
    if (!after[0] || after[0].shares !== 0n || after[0].claimable0 !== 0n || after[0].claimable1 !== 0n)
      throw new Error(`${fixture.name}: principal or fees remain after settlement`)
    const emptyPosition = await readFablesPosition(client, {
      owner: fixture.owner, hook: fixture.hook, rangeId: fixture.rangeId, allowEmpty: true,
    })
    if (emptyPosition.shares !== 0n || emptyPosition.claimable0 !== 0n || emptyPosition.claimable1 !== 0n)
      throw new Error(`${fixture.name}: empty-range recovery read disagrees with lens`)
    results.push({ name: fixture.name, poolId: quote.position.pool.id,
      exitHash, claimHash, sharesBefore: quote.position.shares.toString(),
      sharesAfter: '0', claimableAfter: ['0', '0'], partialShares: partialShares.toString() })
    if (fixture.name === 'legacy-native') {
      // A fresh out-of-range native-only range has no swap fees. It must still
      // be removable; fee collection is skipped when no claim exists.
      const spacing = quote.position.pool.key.tickSpacing
      const tickLower = Math.ceil((quote.position.tick + 100) / spacing) * spacing
      const tickUpper = tickLower + spacing * 10
      const deposit = await prepareFablesDepositCall(client, {
        owner: fixture.owner, poolId: quote.position.pool.id,
        tickLower, tickUpper, budget0: 10_000_000_000_000_000n,
        budget1: 0n, slippageBps: 100,
        nativeGasReserve: 10_000_000_000_000_000n,
        lifetimeSeconds: 300,
      })
      const depositHash = await send(fixture.owner, deposit.to, deposit.data, deposit.value)
      const [newView] = await client.readContract({ address: FABLES_LENS, abi: fablesLensAbi,
        functionName: 'userRanges', args: [fixture.hook, fixture.owner, [deposit.rangeId]] })
      if (!newView[0] || newView[0].shares !== deposit.liquidity
        || newView[0].claimable0 !== 0n || newView[0].claimable1 !== 0n)
        throw new Error('fresh range did not mint the expected zero-fee shares')
      const zeroFeeExit = await prepareFablesExitCall(client, {
        owner: fixture.owner, hook: fixture.hook, rangeId: deposit.rangeId,
        slippageBps: 100, maxClaimFeeBps: 1_000, lifetimeSeconds: 300,
        allowLegacyUnboundedFeeExit: true,
      })
      const zeroFeeExitHash = await send(fixture.owner, zeroFeeExit.to, zeroFeeExit.data)
      const [settledView] = await client.readContract({ address: FABLES_LENS, abi: fablesLensAbi,
        functionName: 'userRanges', args: [fixture.hook, fixture.owner, [deposit.rangeId]] })
      if (!settledView[0] || settledView[0].shares !== 0n
        || settledView[0].claimable0 !== 0n || settledView[0].claimable1 !== 0n)
        throw new Error('zero-fee test range did not settle to zero')
      results.push({ name: 'legacy-native-zero-fee', poolId: quote.position.pool.id,
        depositHash, exitHash: zeroFeeExitHash, rangeId: deposit.rangeId.toString(),
        sharesMinted: deposit.liquidity.toString() })
    }
  }
  console.log(JSON.stringify({ forkBaseBlock: forkBaseBlock.toString(),
    finalForkBlock: (await client.getBlockNumber()).toString(), results }))
}

run().catch(error => { console.error(error); process.exitCode = 1 })
