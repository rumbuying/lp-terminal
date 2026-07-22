// Live smoke of the bridge layer: token DISCOVERY per remote (relay/across
// support surfaces, same-token only), then every discovered route × direction
// quoted through each supporting engine, printed as the normalized BridgeQuote
// the UI consumes. Read-only (quotes only, placeholder payer) — safe any time.
//   npm run smoke:bridge
import { formatUnits, parseUnits } from 'viem'
import { REMOTE_CHAINS, resolveIntent, type BridgeDir } from '../src/config/bridge'
import { quoteAcross } from '../src/lib/bridge/across'
import { quotePortal } from '../src/lib/bridge/portal'
import { quoteRelay } from '../src/lib/bridge/relay'
import { fetchBridgeTokens, toTokenOption } from '../src/lib/bridge/tokens'
import type { BridgeFee, BridgeProviderId, BridgeQuote } from '../src/lib/bridge/types'

const FEE: BridgeFee = { bps: 0, receiver: '0x1111111111111111111111111111111111111111' }
const REMOTES = [
  REMOTE_CHAINS.find((r) => r.label === 'ETHEREUM')!,
  REMOTE_CHAINS.find((r) => r.label === 'BASE')!,
]

let failures = 0
for (const remote of REMOTES) {
  const supports = await fetchBridgeTokens(remote)
  console.log(`\n== ${remote.label} — discovered same-token routes ==`)
  for (const s of supports) {
    console.log(
      `  ${s.symbol.padEnd(5)} dec=${s.decimals}  rh=${s.robinhoodToken.slice(0, 10)} remote=${s.remoteToken.slice(0, 10)}  ` +
        `relay=${s.relay} across=${s.across} portal=${s.portal}`,
    )
  }
  for (const s of supports) {
    for (const dir of ['in', 'out'] as BridgeDir[]) {
      const token = toTokenOption(s, dir)
      if (token.providers.length === 0) continue
      const amount = token.symbol === 'USDG' ? parseUnits('100', token.decimals) : parseUnits('0.05', token.decimals)
      const leg = resolveIntent({ dir, token, remote, amount })
      const inNum = Number(formatUnits(amount, leg.inputDecimals))
      const runners: Partial<Record<BridgeProviderId, () => Promise<BridgeQuote>>> = {
        portal: () => Promise.resolve(quotePortal(leg, amount)),
        relay: () => quoteRelay(leg, amount, FEE, null),
        across: () => quoteAcross(leg, amount, FEE, null),
      }
      for (const provider of token.providers) {
        const t0 = Date.now()
        try {
          const q = await runners[provider]!()
          const outNum = Number(formatUnits(q.outputAmount, leg.outputDecimals))
          const impact = ((outNum / inNum - 1) * 100).toFixed(2)
          console.log(
            `  ${token.symbol.padEnd(5)} ${dir.padEnd(3)} ${provider.padEnd(6)} out=${outNum.toFixed(6)} ${leg.outputSymbol.padEnd(4)} ` +
              `impact=${impact}%  eta=${q.etaSec}s  steps=${q.steps.map((st) => st.kind).join('+')}  ` +
              `(${Date.now() - t0}ms)`,
          )
        } catch (e) {
          failures++
          console.log(
            `  ${token.symbol.padEnd(5)} ${dir.padEnd(3)} ${provider.padEnd(6)} FAILED: ${(e as Error).message.slice(0, 90)} (${Date.now() - t0}ms)`,
          )
        }
      }
    }
  }
}
console.log(`\n${failures === 0 ? 'ALL ROUTES QUOTED' : `${failures} route quote(s) failed`}`)
