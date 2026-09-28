/** Read-only mainnet gas probes for the user's reviewed ETH/PONS Fables pool. */
import { createPublicClient, getAddress, http, type Hex } from 'viem'
import { erc20Abi } from '../src/abi'
import { FABLES_AUTO_POOL_IDS } from '../src/config/fables'
import { robinhoodConfig } from '../src/config/chains/robinhood'
import { readFablesPosition } from '../src/lib/fables'
import { quoteFablesExit } from '../src/lib/fablesExitQuote'
import { prepareFablesDepositCall, prepareFablesExitCall } from '../src/lib/fablesWrite'

const rpc = process.env.FABLES_LIVE_CHECK_RPC
  ?? process.env.FABLES_FORK_UPSTREAM_RPC
  ?? robinhoodConfig.publicRpc
const client = createPublicClient({ transport: http(rpc, { timeout: 30_000 }) })
const owner = getAddress('0x2Bb53df69EFA1b967660F2780DDcF6f76F90ae78')
const hook = getAddress('0x594e8e6281eDf2d363a0293a50004Cf868E7a080')
const poolId = '0xb59001413cb070e28433826f927b7265a0813213ba21f454d86896cee3cce674' as Hex
const rangeId = 539370627915511154826653668589983232122555185378305681796357519476144749006n
async function main() {
  if (await client.getChainId() !== 4663) throw new Error('E_FABLES_CHAIN')
  const position = await readFablesPosition(client, { owner, hook, rangeId })
  if (position.pool.id.toLowerCase() !== poolId || position.pool.key.currency0.toLowerCase()
    !== '0x0000000000000000000000000000000000000000')
    throw new Error('E_FABLES_TARGET_POOL_CHANGED')
  const quote = await quoteFablesExit(client, { owner, hook, rangeId, slippageBps: 100 })

  // Only this process can use the reviewed write builders. No signer is loaded,
  // and estimateGas/eth_call cannot broadcast or mutate mainnet state.
  FABLES_AUTO_POOL_IDS.add(poolId)
  try {
    let exit: { method: string; gas: string; amount0Min: string; amount1Min: string } | null = null
    if (!position.inRange) {
      const call = await prepareFablesExitCall(client, {
        owner, hook, rangeId, expectedShares: position.shares,
        requireOutOfRange: true, slippageBps: 100, maxClaimFeeBps: 1000,
        lifetimeSeconds: 300,
      })
      const gas = await client.estimateGas({ account: owner, to: call.to, data: call.data, value: call.value })
      exit = { method: call.method, gas: gas.toString(),
        amount0Min: call.amount0Min.toString(), amount1Min: call.amount1Min.toString() }
    }

    // A bounded ETH-only range above spot exercises the same deposit builder
    // without spending the existing LP proceeds or requiring a PONS allowance.
    const spacing = position.pool.key.tickSpacing
    const tickLower = Math.floor(position.tick / spacing) * spacing + 2 * spacing
    const tickUpper = tickLower + 4 * spacing
    const deposit = await prepareFablesDepositCall(client, {
      owner, poolId, tickLower, tickUpper,
      expectedTick: position.tick,
      budget0: 1_000_000_000_000_000n, budget1: 0n,
      slippageBps: 100, nativeGasReserve: 10_000_000_000_000_000n,
      lifetimeSeconds: 300,
    })
    const depositGas = await client.estimateGas({ account: owner,
      to: deposit.to, data: deposit.data, value: deposit.value })
    const centeredLower = Math.floor(position.tick / spacing) * spacing - 2 * spacing
    const centeredUpper = centeredLower + 6 * spacing
    const centeredCall = await prepareFablesDepositCall(client, {
      owner, poolId, tickLower: centeredLower, tickUpper: centeredUpper,
      expectedTick: position.tick,
      budget0: 1_000_000_000_000_000n, budget1: 10_000_000_000_000_000_000n,
      slippageBps: 100, nativeGasReserve: 10_000_000_000_000_000n,
      lifetimeSeconds: 300,
    })
    const allowance = await client.readContract({ address: position.pool.key.currency1,
      abi: erc20Abi, functionName: 'allowance', args: [owner, centeredCall.to] })
    const centeredGas = allowance >= centeredCall.max1
      ? (await client.estimateGas({ account: owner, to: centeredCall.to,
        data: centeredCall.data, value: centeredCall.value })).toString()
      : null
    process.stdout.write(JSON.stringify({ chainId: 4663,
      observedBlock: position.observedBlock.toString(), tick: position.tick,
      oldRange: [position.tickLower, position.tickUpper], outOfRange: !position.inRange,
      shares: position.shares.toString(),
      principal: [quote.principal0.toString(), quote.principal1.toString()],
      claimable: [quote.claimable0.toString(), quote.claimable1.toString()],
      exit, deposit: { tickLower, tickUpper, gas: depositGas.toString(),
        liquidity: deposit.liquidity.toString(), value: deposit.value.toString(),
        max0: deposit.max0.toString(), max1: deposit.max1.toString() },
      centeredDeposit: { tickLower: centeredLower, tickUpper: centeredUpper,
        gas: centeredGas, allowance: allowance.toString(),
        liquidity: centeredCall.liquidity.toString(),
        max0: centeredCall.max0.toString(), max1: centeredCall.max1.toString() },
    }) + '\n')
  } finally { FABLES_AUTO_POOL_IDS.delete(poolId) }
}

main().catch(error => {
  const detail = error instanceof Error && error.message.startsWith('E_FABLES_')
    ? error.message : error instanceof Error ? error.name : 'unknown error'
  console.error(`Fables read-only preflight failed: ${detail}`)
  process.exitCode = 1
})
