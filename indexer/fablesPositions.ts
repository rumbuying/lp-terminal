// Fables ERC-6909 ownership discovery. The index is deliberately a candidate
// set: shares can be transferred or fully withdrawn, so no stored row is
// considered a live position until the hook and lens agree at one block.
import { numberToHex, toEventSelector, type Hex } from 'viem'
import { FABLES_HOOKS } from '../src/config/fables'
import { readFablesPools } from '../src/lib/fables'
import { scanAdaptiveLogWindows } from './adaptiveLogs'
import { CHAIN, INDEXER_FINALITY_BLOCKS, log, now } from './config'
import { pc, withRotatingRpcClient } from './rpc'
import { addFablesCandidate, kvGet, kvSet, tx } from './store'

const DEPOSITED = toEventSelector('Deposited(address,uint256,uint128)')
const WITHDRAWN = toEventSelector('Withdrawn(address,uint256,uint128)')
const FEES_CLAIMED = toEventSelector('FeesClaimed(address,uint256,uint256,uint256)')
const TRANSFER = toEventSelector('Transfer(address,address,uint256,uint256)')
const TOPICS = [DEPOSITED, WITHDRAWN, FEES_CLAIMED, TRANSFER]
const HOOKS = Object.keys(FABLES_HOOKS) as Hex[]
const ZERO = '0x0000000000000000000000000000000000000000'

type FablesLog = { address: Hex; topics: Hex[]; blockNumber: Hex }
export type FablesCandidateEvent = { owner: string; hook: string; rangeId: string; block: number }

function addressTopic(topic: Hex): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic) || !/^0{24}$/i.test(topic.slice(2, 26)))
    throw new Error('malformed Fables address topic')
  return `0x${topic.slice(26)}`.toLowerCase()
}

/** Decode only identity-bearing topics; amount data is never an index authority. */
export function fablesCandidatesFromLog(row: FablesLog): FablesCandidateEvent[] {
  const hook = row.address.toLowerCase()
  if (!(hook in FABLES_HOOKS)) throw new Error(`unreviewed Fables hook log: ${hook}`)
  const block = Number(row.blockNumber)
  if (!Number.isSafeInteger(block) || block < 0) throw new Error('invalid Fables log block')
  const selector = row.topics[0]?.toLowerCase()
  let owners: string[]
  let id: Hex
  if (selector === TRANSFER.toLowerCase()) {
    if (row.topics.length !== 4) throw new Error('malformed Fables Transfer log')
    owners = [addressTopic(row.topics[1]), addressTopic(row.topics[2])]
    id = row.topics[3]
  } else if ([DEPOSITED, WITHDRAWN, FEES_CLAIMED].some(topic => topic.toLowerCase() === selector)) {
    if (row.topics.length !== 3) throw new Error('malformed Fables range log')
    owners = [addressTopic(row.topics[1])]
    id = row.topics[2]
  } else throw new Error(`unexpected Fables log selector: ${selector}`)
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error('invalid Fables range ID topic')
  return [...new Set(owners.filter(owner => owner !== ZERO))].map(owner => ({
    owner, hook, rangeId: BigInt(id).toString(), block,
  }))
}

const configuredWindow = Number(process.env.INDEXER_FABLES_RPC_WINDOW_BLOCKS)
const RPC_WINDOW_BLOCKS = Number.isSafeInteger(configuredWindow) && configuredWindow > 0
  ? configuredWindow : 500_000

export async function tailFablesPositions(): Promise<number> {
  if (CHAIN.id !== 4663) return 0
  const head = Number(await pc.getBlockNumber()) - INDEXER_FINALITY_BLOCKS
  if (!Number.isSafeInteger(head) || head < 0) throw new Error('invalid Fables finalized head')
  const pools = await readFablesPools(pc, BigInt(head))
  const active = pools.filter(pool => pool.active)
  if (active.some(pool => !pool.reviewed)) throw new Error('active Fables pool requires review')
  const activeHooks = new Set(active.map(pool => pool.key.hooks.toLowerCase()))
  if (activeHooks.size !== HOOKS.length || HOOKS.some(hook => !activeHooks.has(hook)))
    throw new Error('Fables registry hook set changed')

  const saved = kvGet('fables_position_cursor')
  const cursor = saved === null || saved === undefined || saved === '' ? -1 : Number(saved)
  if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor > head)
    throw new Error(`invalid Fables position cursor: ${saved}`)
  let indexed = 0
  await scanAdaptiveLogWindows<FablesLog[]>({
    fromBlock: cursor + 1,
    toBlock: head,
    maxWindowBlocks: RPC_WINDOW_BLOCKS,
    // The public Robinhood RPC accepts broad windows serially but can reject
    // simultaneous multi-hook requests as invalid parameters.
    concurrency: 1,
    fetchWindow: async (lo, hi) =>
      await withRotatingRpcClient(client => client.request({
        method: 'eth_getLogs',
        params: [{ address: HOOKS, topics: [TOPICS], fromBlock: numberToHex(lo), toBlock: numberToHex(hi) }],
      })) as FablesLog[],
    commitWindow: ({ toBlock, rows }) => {
      tx(() => {
        for (const row of rows)
          for (const candidate of fablesCandidatesFromLog(row))
            addFablesCandidate(candidate.owner, candidate.hook, candidate.rangeId, candidate.block)
        kvSet('fables_position_cursor', String(toBlock))
      })
      indexed += rows.length
    },
    onShrink: n => log(`[fables] RPC log range rejected; shrinking to ${n} blocks`),
    singleBlockError: 'RPC rejects a one-block Fables log request; configure a logs-capable RPC',
  })
  tx(() => {
    kvSet('fables_positions_backfilled', '1')
    kvSet('fables_positions_scanned_at', String(now()))
  })
  return indexed
}
