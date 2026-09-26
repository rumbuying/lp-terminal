/** Probe the pause storage layout only on an isolated Anvil fork. */
import { createPublicClient, http, toHex } from 'viem'
import { fablesHookAbi } from '../src/abi/fables'

const rpc = process.env.FABLES_FORK_RPC
if (!rpc || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(rpc))
  throw new Error('FABLES_FORK_RPC must be an explicit loopback Anvil URL')
const client = createPublicClient({ transport: http(rpc, { timeout: 120_000 }) })
const hook = '0x5eb87f69be00df39981622fd60a8de4b7837e080'

async function anvil(method: string, params: unknown[]): Promise<unknown> {
  return client.request({ method, params } as never)
}

async function run() {
  if (!await anvil('anvil_nodeInfo', []) || await client.getChainId() !== 4663)
    throw new Error('not a Robinhood Anvil fork')
  const before = await client.readContract({ address: hook, abi: fablesHookAbi, functionName: 'paused' })
  if (before) throw new Error('hook already paused')
  const timestamp = (await client.getBlock()).timestamp
  let slot: number | null = null
  for (let i = 0; i < 128; i++) {
    const key = toHex(i, { size: 32 })
    const prior = await client.getStorageAt({ address: hook, slot: key })
    await anvil('anvil_setStorageAt', [hook, key, toHex(timestamp + 3600n, { size: 32 })])
    try {
      if (await client.readContract({ address: hook, abi: fablesHookAbi, functionName: 'paused' })) {
        slot = i
        break
      }
    } catch {
      // A temporary write to another variable may make a view revert.
    } finally {
      await anvil('anvil_setStorageAt', [hook, key, prior ?? toHex(0n, { size: 32 })])
    }
  }
  if (slot === null) throw new Error('pausedUntil storage slot not found')
  console.log(JSON.stringify({ hook, pausedUntilSlot: slot }))
}

run().catch(error => { console.error(error); process.exitCode = 1 })
