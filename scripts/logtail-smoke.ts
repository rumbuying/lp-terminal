// Proves the event-tail signal on Robinhood Chain: one eth_getLogs over the
// last SPAN blocks surfaces every pool that traded, grouped by event.
// Run: npm run smoke:logtail
import { numberToHex } from 'viem'
import { pc } from '../indexer/rpc'
import { TOPICS } from '../indexer/logtail'

const SPAN = 1_500
const NAMES = ['v2 Sync', 'v3 Swap', 'v3 Mint', 'v3 Burn']

const head = Number(await pc.getBlockNumber())
const from = head - SPAN + 1
const logs = (await pc.request({
  method: 'eth_getLogs',
  params: [{ fromBlock: numberToHex(from), toBlock: numberToHex(head), topics: [TOPICS] }],
})) as { address: string; topics: string[] }[]

const pools = new Set<string>()
const byTopic = new Map<string, number>()
for (const l of logs) {
  pools.add(l.address.toLowerCase())
  byTopic.set(l.topics[0], (byTopic.get(l.topics[0]) ?? 0) + 1)
}

console.log(`blocks ${from}-${head} (${SPAN}): ${logs.length} logs, ${pools.size} distinct pools`)
TOPICS.forEach((t, i) => console.log(`  ${NAMES[i].padEnd(8)} ${byTopic.get(t) ?? 0}`))
console.log('sample pools:', [...pools].slice(0, 8).join(' '))
