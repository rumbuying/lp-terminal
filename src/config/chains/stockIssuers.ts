import type { Address, Hex } from 'viem'

/**
 * Tokenized equities, and how the chain itself proves who issued one.
 *
 * The problem this exists for is impersonation, and it is not hypothetical. On
 * BSC eight live tokens call themselves TSLA and two more call themselves
 * TSLAB; on Robinhood Chain seven call themselves TSLA and seven more NVDA.
 * Measured 2026-08-04 against the terminal's own catalog. A symbol is a string
 * anyone can mint, so a symbol can never be the thing that says "this is really
 * Tesla" — only the contract can.
 *
 * Every issuer here happens to deploy its tokens as a PROXY, which is what
 * makes the question answerable without trusting a list. A proxy holds no logic
 * of its own: it forwards every call to code named in a fixed ERC-1967 storage
 * slot. So if a token's runtime bytecode is byte-for-byte the issuer's proxy
 * AND that slot names the issuer's own beacon (or admin), then every call that
 * token can ever answer is answered by the issuer's contract. There is no
 * remaining room for it to be someone else's token.
 *
 * Both halves are load-bearing and neither is sufficient alone:
 *
 *  - Codehash alone fails for Ondo, whose proxy is stock OpenZeppelin
 *    BeaconProxy that reads its beacon from storage. Anyone can deploy that
 *    same bytecode pointed at a beacon of their own.
 *  - Slot alone fails for everyone: storage is writable by whatever code the
 *    contract actually runs, so an impostor can seed the slot with the real
 *    beacon and behave however it likes.
 *
 * Together they close: the codehash pins WHICH code runs (and we have read it —
 * it does nothing but delegate to the slot), the slot pins WHERE it delegates.
 *
 * Robinhood's and Binance's proxies additionally bake the beacon into the
 * bytecode as a PUSH32 immutable, so for those two the codehash alone already
 * implies the beacon. The uniform two-part check is kept anyway: it costs one
 * extra batched storage read and it is the same code path for all four.
 *
 * WHY THE ANCHOR AND NOT THE IMPLEMENTATION: a beacon's implementation is meant
 * to be upgraded, and Backed's admin can swap its proxies' implementation at
 * will. Anchoring on the beacon/admin identity survives those upgrades; a
 * pinned implementation address would silently un-mark every stock token the
 * first time an issuer shipped a patch. scripts/chain-check.ts re-measures
 * these anchors against live tokens so drift fails at the release boundary.
 */
export type StockIssuerId = 'robinhood' | 'bstock' | 'ondo' | 'backed'

/** ERC-1967 beacon slot: `keccak256('eip1967.proxy.beacon') - 1` */
export const ERC1967_BEACON_SLOT =
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as Hex

/** ERC-1967 admin slot: `keccak256('eip1967.proxy.admin') - 1` */
export const ERC1967_ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as Hex

/**
 * Who an issuer is, as the UI says it.
 *
 * Colors are the issuer's own where the issuer has one the eye already knows —
 * Binance's yellow is the same #F0B90B the BNB mark in ChainMark wears, and
 * Robinhood's lime is theirs. Backed ships no color that survives a dark
 * terminal, so its hue is chosen for separation from the other three and from
 * every theme accent, and is claimed as nothing more than that.
 *
 * `terms` is the issuer's own legal page — and it is the issuer's statement,
 * not ours: the token contract returns that exact string from `terms()`.
 * Recorded as a constant because the function is `pure`, so every token of an
 * issuer returns the identical value and reading it per token buys nothing.
 * Only Robinhood and Backed publish one; Binance and Ondo expose no such
 * function, so no link is claimed for them rather than one being guessed.
 */
export type StockIssuerBrand = {
  id: StockIssuerId
  /** full name for the badge and tooltips */
  label: string
  /** the chip's text — short enough for a dense row */
  short: string
  /** brand color for the mark and the verified symbol */
  color: string
  /** the same color at badge-border weight */
  line: string
  /** the issuer's terms, verbatim from its own `terms()`; absent where it publishes none */
  terms?: string
  /**
   * Where the issuer publishes its own token's picture, addressed by contract.
   *
   * Only reachable for a token this issuer has already been PROVEN to have
   * minted, so it cannot put Apple's logo on an impersonator: the proof runs
   * first and an unproven token never gets here. Robinhood serves one per token
   * from its wallet CDN — measured 2026-08-05, NVDA's returns a PNG while USDG,
   * WETH and a launchpad token all return 403, so the path is the issuer's own
   * set and not a wildcard. The other three publish no such endpoint, and none
   * is invented for them.
   */
  logo?: (address: string) => string
}

export const STOCK_ISSUERS: Record<StockIssuerId, StockIssuerBrand> = {
  robinhood: {
    id: 'robinhood',
    label: 'Robinhood',
    short: 'ROBINHOOD',
    color: '#ccff00',
    line: 'rgba(204, 255, 0, 0.55)',
    terms: 'https://robinhood.com/stocktoken/rhj',
    logo: (address) => `https://cdn.robinhood.com/ncw_assets/logos/${address.toLowerCase()}.png`,
  },
  bstock: {
    id: 'bstock',
    label: 'Binance bStock',
    short: 'BSTOCK',
    color: '#f0b90b',
    line: 'rgba(240, 185, 11, 0.55)',
  },
  ondo: {
    id: 'ondo',
    label: 'Ondo Global Markets',
    short: 'ONDO',
    color: '#4d8dff',
    line: 'rgba(77, 141, 255, 0.55)',
  },
  backed: {
    id: 'backed',
    label: 'Backed xStocks',
    short: 'XSTOCK',
    color: '#ff7ac6',
    line: 'rgba(255, 122, 198, 0.55)',
    terms: 'https://www.backedassets.fi/legal-documentation',
  },
}

/**
 * One issuer's deployment on one chain: the proxy shape it ships, and the
 * address that proxy is bound to.
 *
 * `slot` says which ERC-1967 role `anchor` fills. Beacon for the three
 * beacon-proxy issuers; admin for Backed, whose transparent proxy has no beacon
 * and whose implementation moves.
 */
export type StockIssuerAnchor = {
  issuer: StockIssuerId
  slot: Hex
  /** the beacon or proxy-admin every one of this issuer's tokens is bound to */
  anchor: Address
  /** keccak256 of the issuer's proxy runtime bytecode */
  proxyCodehash: Hex
  /** a live token of this issuer, so chain-check can re-measure both halves */
  witness: { symbol: string; address: Address }
}
