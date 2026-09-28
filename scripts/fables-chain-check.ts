/** Read-only deployment gate for the Fables Robinhood Chain adapter. */
import { createPublicClient, http, keccak256, type Address } from 'viem'
import { fablesRegistryAbi } from '../src/abi/fables'
import {
  FABLES_HOOKS,
  FABLES_KNOWN_POOL_IDS,
  FABLES_LENS,
  FABLES_LENS_CODE_HASH,
  FABLES_REGISTRY,
  FABLES_REGISTRY_CODE_HASH,
  fablesHook,
} from '../src/config/fables'
import { robinhoodConfig } from '../src/config/chains/robinhood'
import { v4PoolId, v4StateViewAbi } from '../src/lib/uniV4'

const rpc = process.env.FABLES_CHECK_RPC || robinhoodConfig.publicRpc
const client = createPublicClient({ transport: http(rpc) })

async function assertCodeHash(address: Address, expected: string) {
  const code = await client.getCode({ address })
  if (!code || code === '0x') throw new Error(`no runtime code: ${address}`)
  const actual = keccak256(code)
  if (actual.toLowerCase() !== expected.toLowerCase())
    throw new Error(`runtime code changed at ${address}: ${actual}`)
}

async function main() {
  const chainId = await client.getChainId()
  if (chainId !== 4663) throw new Error(`expected Robinhood Chain 4663; got ${chainId}`)
  const deployment = robinhoodConfig.uniV4
  if (!deployment) throw new Error('Robinhood v4 deployment missing')
  await Promise.all([
    assertCodeHash(FABLES_REGISTRY, FABLES_REGISTRY_CODE_HASH),
    assertCodeHash(FABLES_LENS, FABLES_LENS_CODE_HASH),
  ])
  const blockNumber = await client.getBlockNumber()
  const rows = await client.readContract({
    address: FABLES_REGISTRY, abi: fablesRegistryAbi, functionName: 'activePools', blockNumber,
  })
  const seen = new Set<string>()
  const hooks = new Set<Address>()
  for (const row of rows) {
    const key = row.key
    const id = v4PoolId({
      currency0: key.currency0, currency1: key.currency1,
      fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks,
    }).toLowerCase()
    if (id !== row.id.toLowerCase()) throw new Error(`registry PoolId mismatch: ${row.id}`)
    if (seen.has(id)) throw new Error(`duplicate PoolId: ${id}`)
    seen.add(id)
    if (!row.active) continue
    if (!FABLES_KNOWN_POOL_IDS.has(id)) throw new Error(`new active pool requires review: ${id}`)
    const reviewedHook = fablesHook(key.hooks)
    if (!reviewedHook) throw new Error(`unreviewed hook: ${key.hooks}`)
    if (key.fee !== 0x800000) throw new Error(`unexpected Fables fee marker: ${id}`)
    hooks.add(key.hooks)
    const slot0 = await client.readContract({
      address: deployment.STATE_VIEW, abi: v4StateViewAbi,
      functionName: 'getSlot0', args: [row.id], blockNumber,
    })
    if (slot0[0] <= 0n) throw new Error(`pool not initialized: ${id}`)
  }
  for (const hook of hooks) await assertCodeHash(hook, fablesHook(hook)!.codeHash)
  if (hooks.size !== Object.keys(FABLES_HOOKS).length)
    throw new Error(`reviewed hook set drift: ${hooks.size} active, ${Object.keys(FABLES_HOOKS).length} pinned`)
  console.log(JSON.stringify({ chainId, blockNumber: blockNumber.toString(), pools: rows.length,
    activePools: rows.filter(row => row.active).length, verifiedHooks: hooks.size }))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
