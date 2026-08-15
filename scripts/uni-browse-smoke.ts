// Live smoke for the univ3 POOLS browse layer: replicates fetchUniBrowse
// (src/lib/uniBrowse.ts) with the REAL abi/address/clmath modules — env.ts
// can't load under node, so the flow is mirrored, not imported.
// Never prints the RPC URL.
import { readFileSync } from 'node:fs'
import { createPublicClient, defineChain, encodeFunctionData, getAddress, http, zeroAddress, type Address, type PublicClient } from 'viem'
import { uniV3FactoryAbi, uniV3PmAbi, uniV3PoolAbi } from '../src/abi/index'
import { ADDR, UNI } from '../src/config/addresses'
import { CHAIN } from '../src/config/chains'
import { getLiquidityForAmounts, getSqrtRatioAtTick, minAmountsForLiquidity } from '../src/lib/clmath'

function rpcUrl(): string {
  const explicit = process.env.RPC?.trim()
  if (explicit) return explicit
  // The shared workspace RPC is documented as Robinhood-only. Never point a
  // CHAIN=bsc smoke at it merely because the file exists.
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

type DsPair = { chainId?: string; dexId?: string; labels?: string[]; pairAddress?: string; volume?: { h24?: number }; liquidity?: { usd?: number } }
const v3PairsOf = (json: unknown): DsPair[] => {
  const arr = Array.isArray(json) ? (json as DsPair[]) : ((json as { pairs?: DsPair[] })?.pairs ?? [])
  const looksLikeV3 = (pair: DsPair) => {
    const labels = (pair.labels ?? []).map((label) => label.toLowerCase())
    // BSC Uniswap v3 rows are currently unlabeled; reject explicit v2/v4 and
    // let the pool ABI + official factory round-trip prove the remainder.
    return labels.includes('v3') || !labels.some((label) => label === 'v2' || label === 'v4')
  }
  return arr.filter(
    (p) =>
      p?.chainId === CHAIN.slugs.dexscreener &&
      p?.dexId === CHAIN.slugs.dexIds.uni &&
      looksLikeV3(p),
  )
}
type McRes = { status: string; result?: unknown }
const ok = <T,>(r: McRes | undefined): T | undefined => (r && r.status === 'success' ? (r.result as T) : undefined)

const FEE_TS: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 }

async function main() {
  // 1. token-pairs discovery for the configured wrapped native token
  const dsChain = CHAIN.slugs.dexscreener
  const tp = await (await fetch(`https://api.dexscreener.com/token-pairs/v1/${dsChain}/${ADDR.WNATIVE}`)).json()
  const cands = v3PairsOf(tp)
  check(
    `dexscreener token-pairs finds v3 ${CHAIN.wrappedSymbol} pools`,
    cands.length >= 1,
    `${cands.length} candidates`,
  )
  const configuredPools = (await pc.multicall({
    contracts: CHAIN.uniV3Fees.map((fee) => ({
      abi: uniV3FactoryAbi,
      address: UNI.V3_FACTORY,
      functionName: 'getPool',
      args: [ADDR.WNATIVE, ADDR.STABLE, fee],
    })) as never,
  })) as McRes[]
  const knownPools = new Set(
    configuredPools
      .map((row) => ok<Address>(row)?.toLowerCase())
      .filter((address): address is string => !!address && address !== zeroAddress),
  )
  // Token-pairs is capped/activity-ranked. A hub pool can fall out of the
  // wrapped-native page but remain reachable from the stable side (or vice
  // versa), so test the union just like a user querying either token.
  const tpStable = await (
    await fetch(`https://api.dexscreener.com/token-pairs/v1/${dsChain}/${ADDR.STABLE}`)
  ).json()
  const hubRows = [...cands, ...v3PairsOf(tpStable)]
  check(
    `${CHAIN.stable.symbol}/${CHAIN.wrappedSymbol} has a factory-verified DexScreener v3 row`,
    hubRows.some((p) => !!p.pairAddress && knownPools.has(p.pairAddress.toLowerCase())),
    `${hubRows.length} combined rows / ${knownPools.size} on-chain tiers`,
  )

  // 2. rank by TVL + cap (same as the lib)
  const seen = new Map<string, DsPair>()
  for (const p of cands) { const a = p.pairAddress?.toLowerCase(); if (a && !seen.has(a)) seen.set(a, p) }
  const picks = [...seen.values()].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)).slice(0, 30)
  console.log(`   top pools by TVL: ${picks.slice(0, 5).map((p) => `${p.pairAddress?.slice(0, 8)}($${Math.round(p.liquidity?.usd ?? 0)})`).join(' ')}`)

  // 3. hydrate from the pool contracts
  const addrs = picks.map((p) => getAddress(p.pairAddress!))
  const det = (await pc.multicall({
    contracts: addrs.flatMap((a) => [
      { abi: uniV3PoolAbi, address: a, functionName: 'token0' },
      { abi: uniV3PoolAbi, address: a, functionName: 'token1' },
      { abi: uniV3PoolAbi, address: a, functionName: 'fee' },
      { abi: uniV3PoolAbi, address: a, functionName: 'tickSpacing' },
      { abi: uniV3PoolAbi, address: a, functionName: 'slot0' },
      { abi: uniV3PoolAbi, address: a, functionName: 'liquidity' },
    ]) as never,
  })) as McRes[]
  type Hyd = { addr: Address; token0: Address; token1: Address; fee: number; ts: number; sqrtP: bigint; tick: number; liq: bigint }
  const hyd: Hyd[] = []
  addrs.forEach((a, i) => {
    const token0 = ok<Address>(det[i * 6]); const token1 = ok<Address>(det[i * 6 + 1])
    const fee = ok<number>(det[i * 6 + 2]); const ts = ok<number>(det[i * 6 + 3])
    const s0 = ok<readonly [bigint, number]>(det[i * 6 + 4]); const liq = ok<bigint>(det[i * 6 + 5])
    if (!token0 || !token1 || fee === undefined || ts === undefined || !s0) return
    hyd.push({ addr: a, token0, token1, fee, ts, sqrtP: s0[0], tick: s0[1], liq: liq ?? 0n })
  })
  check('all candidates hydrate on-chain', hyd.length === addrs.length, `${hyd.length}/${addrs.length}`)
  check('fee↔tickSpacing mapping consistent', hyd.every((h) => FEE_TS[h.fee] === h.ts))

  // 4. factory.getPool authenticity round-trip
  const gp = (await pc.multicall({
    contracts: hyd.map((h) => ({ abi: uniV3FactoryAbi, address: UNI.V3_FACTORY, functionName: 'getPool', args: [h.token0, h.token1, h.fee] })) as never,
  })) as McRes[]
  const verified = hyd.filter((h, i) => {
    const m = ok<Address>(gp[i])
    return !!m && m !== zeroAddress && m.toLowerCase() === h.addr.toLowerCase()
  })
  check('factory.getPool verifies every pool', verified.length === hyd.length, `${verified.length}/${hyd.length} (drops would be spoofs)`)

  // 5. symbol search path
  const sr = await (
    await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(`${CHAIN.wrappedSymbol} ${CHAIN.stable.symbol}`)}`,
    )
  ).json()
  check(
    `symbol search returns ${CHAIN.key} v3 pairs`,
    v3PairsOf(sr).length >= 1,
    `${v3PairsOf(sr).length} matches`,
  )

  // 6. mint calldata: canonical univ3 selector + slippage mins sane on live state
  const h0 = verified.find((h) => knownPools.has(h.addr.toLowerCase())) ?? verified[0]
  if (!h0) {
    check('mint smoke has an authentic hydrated pool', false)
    console.log(`\n${fails} CHECKS FAILED`)
    process.exit(1)
  }
  const lower = Math.floor((h0.tick - 600) / h0.ts) * h0.ts
  const upper = Math.ceil((h0.tick + 600) / h0.ts) * h0.ts
  const amt0 = 10n ** 15n
  const liq = getLiquidityForAmounts(h0.sqrtP, getSqrtRatioAtTick(lower), getSqrtRatioAtTick(upper), amt0, 2n ** 120n)
  const mins = minAmountsForLiquidity(h0.sqrtP, getSqrtRatioAtTick(lower), getSqrtRatioAtTick(upper), liq, 100)
  const data = encodeFunctionData({
    abi: uniV3PmAbi,
    functionName: 'mint',
    args: [{ token0: h0.token0, token1: h0.token1, fee: h0.fee, tickLower: lower, tickUpper: upper, amount0Desired: amt0, amount1Desired: 2n ** 120n, amount0Min: mins.amount0Min, amount1Min: mins.amount1Min, recipient: '0x0000000000000000000000000000000000000001', deadline: 2n ** 40n }],
  })
  check('mint selector == canonical 0x88316456', data.slice(0, 10) === '0x88316456', data.slice(0, 10))
  check('band-edge mins nonzero for in-range band', mins.amount0Min > 0n && mins.amount1Min > 0n, `${mins.amount0Min}/${mins.amount1Min}`)

  console.log(fails === 0 ? '\nALL UNI-BROWSE SMOKE CHECKS PASSED' : `\n${fails} CHECKS FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

void main()
