// Live smoke for the launchpad token proof (src/lib/launchpadToken.ts) and the
// picture it feeds (src/lib/tokenImage.ts).
//
// The unit tests pin the pure halves — the document parser, the CREATE2
// comparison, the URL guards — against captured data. This one asks the chain,
// because the claim being made is about the chain: that the factory's own
// derivation separates its tokens from everything else, in both directions.
//
// It therefore checks both. Three tokens that must prove out, and four things
// that must NOT: an equity token, the chain's dollar, its wrapper, and a plain
// wallet address. A prover that says yes to everything would pass a
// positive-only smoke and would be worthless.
//
// Never prints the RPC URL.
import { readFileSync } from 'node:fs'
import { createPublicClient, defineChain, http, type Address, type PublicClient } from 'viem'
import { CHAIN } from '../src/config/chains'
import type { LaunchpadReleaseId } from '../src/config/chains/launchpad'
import { readLaunchpadToken } from '../src/lib/launchpadToken'
import { pairSide } from '../src/lib/pairSide'
import { tokenImageUrl } from '../src/lib/tokenImage'

function rpcUrl(): string {
  const explicit = process.env.RPC?.trim()
  if (explicit) return explicit
  if (CHAIN.key === 'robinhood') {
    try {
      const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
      const saved = envText.match(/^\s*RPC\s*=\s*(\S+)\s*$/m)?.[1]
      if (saved) return saved
    } catch {
      /* public chain RPC below */
    }
  }
  return CHAIN.publicRpc
}

const pad = CHAIN.launchpad
if (!pad) {
  console.log(`${CHAIN.name} declares no launchpad — nothing to prove here.`)
  process.exit(0)
}

const rpc = rpcUrl()
const chain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [rpc] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})
const pc = createPublicClient({ chain, transport: http(rpc, { batch: true }) }) as PublicClient

let fails = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) fails++
}

/**
 * Live witnesses, read off the factory's own TokenCreated logs 2026-08-05.
 *
 * One per LAUNCHER, not one per release — v2 runs at two addresses and a config
 * that listed only the vanity one would still pass a per-release check while
 * silently demoting every sale the first address ran. Which is exactly what
 * happened to FRONG and UNIDUCK below: both are v2 sales, and both read as bare
 * mints for as long as the config knew one launcher.
 */
const SALES: [string, Address, LaunchpadReleaseId][] = [
  ['JEFF', '0xADA436e4919372333bAA3e2cBBC9D6bA77df8B42', 'v1'],
  ['FRONG', '0xb8E6B62B223ee17559385E1DC61f6433d4c3b979', 'v2'],
  ['UNIDUCK', '0x624c8B39eDf52B9EE7b4Af49Ec758524eF677636', 'v2'],
  ['POOLS', '0xC1763A8D030015EE661753B8c9dE3A8Cd54c82bF', 'v2'],
]
/** a token minted straight off the factory by a wallet — rare, and not a sale */
const MINTED: [string, Address] = ['TEST', '0x544B36b453CFa0A33dBf7f89aE8701b478dc666a']
/** the ones that carry a picture the chain itself supplied */
const PICTURED: [string, Address][] = [
  ['FRONG', '0xb8E6B62B223ee17559385E1DC61f6433d4c3b979'],
  ['UNIDUCK', '0x624c8B39eDf52B9EE7b4Af49Ec758524eF677636'],
]
/**
 * Things that must not prove out, one of each kind of not-a-launchpad-token.
 *
 * The launcher earns its place here: it is a live contract, it is the `creator`
 * of thousands of these tokens, and it is not one. A prover that reached for the
 * creator instead of the CREATE2 derivation would mark it.
 */
const OUTSIDERS: [string, Address][] = [
  ['USDG (the chain dollar)', CHAIN.addr.STABLE],
  ['WETH (the wrapper)', CHAIN.addr.WNATIVE],
  ['a wallet with no code', '0x32f4B2e69EbD7746596AF8699DAC1908F43107aD'],
  ['the launcher itself', '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0'],
]

for (const [sym, address, release] of SALES) {
  const proof = await readLaunchpadToken(pc, address, pad)
  check(`${sym} proves out against ${pad.label}`, proof !== null)
  check(
    `${sym} is a ${release} sale, not a bare mint`,
    proof?.release === release,
    `creator ${proof?.creator ?? '—'} → ${proof?.release ?? 'none'}`,
  )
}

const minted = await readLaunchpadToken(pc, MINTED[1], pad)
check(`${MINTED[0]} proves out`, minted !== null)
check(
  `${MINTED[0]} is a bare mint, so it claims no release`,
  minted !== null && minted.release === null,
  `creator ${minted?.creator ?? '—'}`,
)

// every launcher the config vouches for is reachable from some live sale
const seen = new Set(SALES.map(([, , r]) => r))
for (const release of pad.releases)
  check(`${release.short} has a live witness in this smoke`, seen.has(release.id))

for (const [sym, address] of PICTURED) {
  const proof = await readLaunchpadToken(pc, address, pad)
  check(`${sym} carries a picture the chain itself supplied`, !!proof?.image, proof?.image ?? '(none)')
  const url = tokenImageUrl({ address, knownTokens: CHAIN.knownTokens, launchpad: proof })
  check(`${sym}'s picture resolves to an https URL`, !!url?.startsWith('https://'), url ?? '(rejected)')
}

for (const [what, address] of OUTSIDERS) {
  const proof = await readLaunchpadToken(pc, address, pad)
  check(`${what} does NOT prove out`, proof === null)
}

// the pair orientation the row and the trade panel both read
check(
  'a launchpad token quoted in the chain dollar is the market side',
  pairSide(MINTED[0][1], CHAIN.addr.STABLE) === 0,
)
check(
  'the dollar outranks the wrapper, so WETH/USDG is a WETH market',
  pairSide(CHAIN.addr.WNATIVE, CHAIN.addr.STABLE) === 0,
)

console.log(fails === 0 ? '\nall good' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
