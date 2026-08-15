// Take a new LiquidityLauncher from "it exists" to "it is in the config" —
// quickly, and without the speed costing anything.
//
//   CHAIN=robinhood npx tsx scripts/launcher-add.ts                 # what am I missing?
//   CHAIN=robinhood npx tsx scripts/launcher-add.ts 0xNEW…          # prove one
//   CHAIN=robinhood npx tsx scripts/launcher-add.ts 0xNEW… --write  # and apply it
//
// The two halves are deliberately unequal. FINDING a deployment is a search
// problem and the explorer is good at it, so `--scan` walks the deployer's
// transactions there. ACCEPTING one is a trust problem, and the explorer is
// worth nothing for it — every check that decides is re-derived from RPC
// through the same `provesLauncher` the release gate uses (lib/launcherProvenance.ts).
//
// So a wrong or malicious suggestion cannot get further than the screen. The
// case is live rather than theoretical: 0xe050309b… on Robinhood Chain runs
// launcher-shaped code, mints real tokens daily, and is a stranger's. It is the
// negative witness in launcherProvenance.test.ts for exactly that reason.
//
// Never prints the RPC URL.
import { readFileSync, writeFileSync } from 'node:fs'
import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { CHAIN } from '../src/config/chains'
import {
  launchpadLaunchers,
  type LaunchpadConfig,
  type LaunchpadRelease,
} from '../src/config/chains/launchpad'
import { create2Deployed, provesLauncher } from '../src/lib/launcherProvenance'

function rpcUrl(): string {
  const explicit = process.env.RPC?.trim()
  if (explicit) return explicit
  try {
    const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    const saved = envText.match(/^\s*RPC\s*=\s*(\S+)\s*$/m)?.[1]
    if (saved) return saved
  } catch {
    /* public chain RPC below */
  }
  return CHAIN.publicRpc
}

const pad = CHAIN.launchpad
if (!pad) {
  console.log(`${CHAIN.name} declares no launchpad — nothing to add to.`)
  process.exit(0)
}

const args = process.argv.slice(2)
const write = args.includes('--write')
const hexArgs = args.filter((a) => a.startsWith('0x'))
const target = hexArgs.find((a) => a.length === 42)
// An explicit deployment transaction skips the explorer entirely. That is the
// escape hatch for the case the scan cannot serve: a launcher older than the
// deployer's last page, or an explorer that is down. The proof does not get
// weaker for it — it never used the explorer for anything but the lookup.
const givenTx = hexArgs.find((a) => a.length === 66) as Hex | undefined
if (target && !isAddress(target, { strict: false })) {
  console.error(`not an address: ${target}`)
  process.exit(2)
}
if (hexArgs.some((a) => a.length !== 42 && a.length !== 66)) {
  console.error('arguments must be a 20-byte address and optionally a 32-byte transaction hash')
  process.exit(2)
}

const rpc = rpcUrl()
const chain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [rpc] } },
})
const pc = createPublicClient({ chain, transport: http(rpc, { batch: true }) }) as PublicClient

const known = new Map(
  launchpadLaunchers(pad).map(({ release, launcher }) => [
    launcher.address.toLowerCase(),
    release,
  ]),
)

/**
 * What a release's launchers actually run, read live.
 *
 * The classifier's whole basis: a new deployment that hashes to a release's
 * bytecode IS that generation, and one that does not is a new generation whose
 * name is a decision rather than a lookup. Read from the chain rather than
 * pinned in the config, so a release cannot be classified against a codehash
 * that was true once.
 */
async function releaseCodehashes(): Promise<Map<string, LaunchpadRelease>> {
  const out = new Map<string, LaunchpadRelease>()
  for (const { release, launcher } of launchpadLaunchers(pad!)) {
    const code = await pc.getCode({ address: launcher.address })
    if (code && code !== '0x') out.set(keccak256(code), release)
  }
  return out
}

/**
 * Prove one address, and say where it belongs.
 *
 * Returns the release it matches, `null` for a genuinely new generation, or
 * throws with the reason it is nobody's. There is no third outcome where
 * something unproven is reported as a maybe: a launcher decides which markets
 * wear a sale mark, so "probably theirs" is the same as no.
 */
async function classify(
  address: Address,
  deployTx: Hex,
): Promise<{ release: LaunchpadRelease | null; codehash: string }> {
  const tx = await pc.getTransaction({ hash: deployTx })
  const proof = provesLauncher({
    address,
    tx: { from: tx.from, to: tx.to, input: tx.input },
    deployer: pad!.deployer,
    create2Factory: pad!.create2Factory,
  })
  if (!proof.ok) throw new Error(`${deployTx} does not deploy ${address}: ${proof.reason}`)
  const code = await pc.getCode({ address })
  if (!code || code === '0x') throw new Error(`${address} has no code`)
  const codehash = keccak256(code)
  return { release: (await releaseCodehashes()).get(codehash) ?? null, codehash }
}

/**
 * The deployer's contract creations, newest first, straight from the explorer.
 *
 * Suggestion only. Each created address is recomputed from the transaction's
 * OWN calldata rather than read out of the explorer's answer, so the only thing
 * being trusted here is which transactions to look at.
 */
async function scan(): Promise<{ address: Address; hash: Hex; when: string }[]> {
  const api = CHAIN.explorer.url.replace(/\/+$/, '')
  const res = await fetch(
    `${api}/api/v2/addresses/${pad!.deployer}/transactions?filter=from`,
  )
  if (!res.ok) throw new Error(`explorer returned HTTP ${res.status}`)
  const body = (await res.json()) as {
    items?: { hash: Hex; to?: { hash: string } | null; timestamp?: string }[]
  }
  const out: { address: Address; hash: Hex; when: string }[] = []
  for (const item of body.items ?? []) {
    if (item.to?.hash?.toLowerCase() !== pad!.create2Factory.toLowerCase()) continue
    const tx = await pc.getTransaction({ hash: item.hash })
    const address = create2Deployed(pad!.create2Factory, tx.input)
    if (address) out.push({ address, hash: item.hash, when: (item.timestamp ?? '').slice(0, 19) })
  }
  return out
}

/** the config source for this chain, edited in place */
function configPath(): URL {
  return new URL(`../src/config/chains/${CHAIN.key}.ts`, import.meta.url)
}

/**
 * Append a launcher to a release, or open a new one.
 *
 * A textual insert on purpose: the file is read by people far more often than
 * by this script, and its comments carry the measurements behind every address.
 * A rewrite through a parser would preserve the values and lose the reasons.
 */
function applyEdit(release: LaunchpadRelease | null, address: Address, deployTx: Hex): void {
  const path = configPath()
  const source = readFileSync(path, 'utf8')
  const entry =
    `          {\n` +
    `            address: '${address}' as Address,\n` +
    `            deployTx: '${deployTx}' as Hex,\n` +
    `          },\n`
  if (!release) {
    console.log(
      '\nThis is a NEW generation, and naming one is a judgement this script will not make.\n' +
        `Add a release to ${CHAIN.key}.ts with its id and short label, then re-run with --write:\n\n` +
        `      {\n        id: '<next>',\n        short: '<LABEL>',\n        launchers: [\n${entry}        ],\n      },\n\n` +
        `Then widen LaunchpadReleaseId in config/chains/launchpad.ts to include it.`,
    )
    return
  }
  // Anchor on the release's id line, then on the `launchers: [` that follows
  // it — the first one after the anchor belongs to that release.
  const idAt = source.indexOf(`id: '${release.id}'`)
  if (idAt < 0) throw new Error(`cannot find release '${release.id}' in ${CHAIN.key}.ts`)
  const openAt = source.indexOf('launchers: [', idAt)
  if (openAt < 0) throw new Error(`release '${release.id}' has no launchers list`)
  // APPEND, at the array's closing bracket. The list is chronological — a
  // release's second launcher is its redeploy — and prepending would put the
  // newest first inside a `releases` array that runs oldest-first, so the file
  // would read in two directions at once.
  const closeAt = source.indexOf('\n        ],', openAt)
  if (closeAt < 0) throw new Error(`release '${release.id}' launchers list is not closed as expected`)
  const insertAt = closeAt + 1
  writeFileSync(path, source.slice(0, insertAt) + entry + source.slice(insertAt))
  console.log(`\nwrote ${release.short} launcher into src/config/chains/${CHAIN.key}.ts`)
  console.log('now run, in this order:')
  console.log('  npm test')
  console.log(`  CHAIN=${CHAIN.key} npx tsx scripts/chain-check.ts`)
  console.log(`  CHAIN=${CHAIN.key} npm run smoke:launchpad`)
}

async function main(): Promise<void> {
  const p = pad as LaunchpadConfig
  console.log(`${p.label} on ${CHAIN.name} — deployer ${p.deployer}`)

  if (!target) {
    const found = await scan()
    const codehashes = await releaseCodehashes()
    // Three buckets, and only one of them is a to-do list. Most of what this
    // deployer ships is strategies and hooks — printing those by name buries
    // the answer under the thing that is always true.
    const seen: string[] = []
    const missing: { address: Address; when: string; short: string }[] = []
    let others = 0
    for (const f of found) {
      if (known.has(f.address.toLowerCase())) {
        seen.push(f.address)
        continue
      }
      const code = await pc.getCode({ address: f.address })
      const hit = code && code !== '0x' ? codehashes.get(keccak256(code)) : undefined
      if (hit) missing.push({ address: f.address, when: f.when, short: hit.short })
      else others++
    }
    // The page is a real bound and it is easy to misread as a disagreement: a
    // launcher older than the deployer's last 50 transactions is configured and
    // correct while being invisible here. Say so rather than let the two
    // numbers look like they contradict each other.
    const configured = known.size
    console.log(
      `\nexplorer's first page: ${found.length} CREATE2 deployments\n` +
        `  ${seen.length} of the ${configured} configured launchers appear on it` +
        (seen.length < configured
          ? ` (${configured - seen.length} predate the page — configured, just older)`
          : '') +
        `\n  ${others} other contracts (strategies, hooks, factories)\n`,
    )
    if (missing.length === 0) {
      console.log('no unconfigured launcher on this page — nothing to add.')
      return
    }
    console.log(`${missing.length} LAUNCHER(S) MISSING FROM CONFIG:`)
    for (const m of missing) console.log(`  ${m.address}  ${m.when}  runs ${m.short} code`)
    console.log(
      `\nadd each with:\n  CHAIN=${CHAIN.key} npx tsx scripts/launcher-add.ts <address> --write`,
    )
    return
  }

  const address = target as Address
  if (known.has(address.toLowerCase())) {
    console.log(`\nalready configured as ${known.get(address.toLowerCase())!.short}.`)
    return
  }
  // The deployment transaction is the one thing an address alone cannot give,
  // so it is looked up — and then immediately re-proved against the address.
  let deployTx = givenTx
  if (!deployTx) {
    const found = await scan()
    deployTx = found.find((f) => f.address.toLowerCase() === address.toLowerCase())?.hash
  }
  if (!deployTx) {
    // Two very different situations, and the message must not merge them: this
    // page is bounded, so absence from it is evidence and not a verdict.
    console.error(
      `\nno CREATE2 deployment by ${p.deployer} on the explorer's first page produces ${address}.\n\n` +
        'If it is genuinely theirs but older than that page, pass its deployment transaction and\n' +
        'the proof runs without the explorer at all:\n' +
        `  CHAIN=${CHAIN.key} npx tsx scripts/launcher-add.ts ${address} 0x<deployTx> --write\n\n` +
        'If you have no such transaction, that is the answer: this address is not this launchpad\'s.',
    )
    process.exit(1)
  }
  const { release, codehash } = await classify(address, deployTx)
  console.log(`\n  address   ${address}`)
  console.log(`  deployTx  ${deployTx}`)
  console.log(`  proven    deployer-signed, CREATE2-derived to this address`)
  console.log(`  codehash  ${codehash}`)
  console.log(`  release   ${release ? release.short : 'NEW generation'}`)
  if (write) applyEdit(release, address, deployTx)
  else console.log('\nre-run with --write to apply it.')
}

await main()
