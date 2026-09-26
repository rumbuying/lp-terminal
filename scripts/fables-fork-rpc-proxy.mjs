// Test-only, read-only compatibility shim for Anvil's Ethereum header parser.
// Robinhood Chain's Nitro block JSON omits EIP-4844/withdrawal header fields;
// Anvil's Cancun fork needs them for local EVM execution. This process never
// forwards transaction methods to the upstream network.
import { createServer } from 'node:http'

const upstream = 'https://rpc.mainnet.chain.robinhood.com'
const emptyRoot = `0x${'0'.repeat(64)}`
const methods = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_call', 'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getProof', 'eth_feeHistory', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'net_version',
])

function patch(request, response) {
  if (!response?.result || !['eth_getBlockByNumber', 'eth_getBlockByHash'].includes(request?.method))
    return response
  const block = response.result
  block.blobGasUsed ??= '0x0'
  block.excessBlobGas ??= '0x0'
  block.parentBeaconBlockRoot ??= emptyRoot
  block.withdrawalsRoot ??= emptyRoot
  block.withdrawals ??= []
  return response
}

createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
      if (chunks.reduce((sum, item) => sum + item.length, 0) > 2_000_000)
        throw new Error('RPC request too large')
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const calls = Array.isArray(request) ? request : [request]
    if (!calls.length || calls.some(call => !methods.has(call?.method)))
      throw new Error('test proxy forwards read-only RPC methods only')
    const upstreamResponse = await fetch(upstream, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const response = await upstreamResponse.json()
    const byId = new Map(calls.map(call => [call.id, call]))
    const patched = Array.isArray(response)
      ? response.map(item => patch(byId.get(item.id), item))
      : patch(byId.get(response.id), response)
    res.writeHead(upstreamResponse.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(patched))
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(error) }))
  }
}).listen(8546, '0.0.0.0')
