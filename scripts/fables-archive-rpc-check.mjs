// Read-only gate for the Robinhood Chain Anvil fork upstream. Never print the URL.
const endpoint = process.env.FABLES_FORK_UPSTREAM_RPC
if (!endpoint) throw new Error('FABLES_FORK_UPSTREAM_RPC is required')
let parsed
try { parsed = new URL(endpoint) }
catch { throw new Error('FABLES_FORK_UPSTREAM_RPC must be a valid URL') }
if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:'
  && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))
  throw new Error('FABLES_FORK_UPSTREAM_RPC must use HTTPS or loopback HTTP')

let nextId = 0
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`)
  const body = await response.json()
  if (body.error) throw new Error(`${method} failed: ${body.error.code ?? 'RPC error'}`)
  return body.result
}

try {
  const chainId = await rpc('eth_chainId', [])
  if (chainId !== '0x1237') throw new Error('RPC chain ID is not Robinhood mainnet 4663')
  const head = BigInt(await rpc('eth_blockNumber', []))
  if (head < 100_001n) throw new Error('RPC head is too early for the historical proof check')
  const fixedBlock = `0x${(head - 100_000n).toString(16)}`
  const hook = '0x06a889870c8f83640d6816319f72e2aa579b6080'
  const accounts = [
    ['0x0000000000000000000000000000000000000000', []],
    [hook, [`0x${'0'.repeat(64)}`]],
    ['0x159a113e012593d9b3cc63ad45e30f0467e13ef3', []],
    [hook, [`0x${'0'.repeat(64)}`]],
  ]
  for (const [address, slots] of accounts) {
    const proof = await rpc('eth_getProof', [address, slots, fixedBlock])
    if (!proof || !Array.isArray(proof.accountProof) || proof.accountProof.length === 0
      || !Array.isArray(proof.storageProof) || proof.storageProof.length !== slots.length)
      throw new Error('historical eth_getProof returned incomplete account or storage proof')
  }
  process.stdout.write(JSON.stringify({ chainId: 4663, head: head.toString(),
    proofBlock: (head - 100_000n).toString(), fixedBlockProof: 'ok', proofChecks: accounts.length }) + '\n')
} catch (error) {
  process.stderr.write(`Fables fork RPC preflight failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
}
