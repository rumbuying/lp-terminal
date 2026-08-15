import { useTranslation } from 'react-i18next'
import { CHAIN } from '../config/chains'
import { STOCK_ISSUERS, type StockIssuerId } from '../config/chains/stockIssuers'
import { squattedSymbol } from '../lib/knownToken'
import { clampWidth, shortAddr } from '../lib/format'

/**
 * What the terminal knows about a token's identity, said next to its symbol.
 *
 * A symbol is not an identity. Eight live tokens on BSC call themselves TSLA,
 * four call themselves USDC, and seven on Robinhood Chain call themselves NVDA.
 * This surface exists because the string in a pair name is the one part of a
 * pool that a stranger controls completely.
 *
 * Two credentials arrive here and they are NOT the same strength, so the marks
 * are shaped to keep that difference visible:
 *
 *  ▣ PROVEN, from the token's own bytecode (lib/stockToken.ts). The contract
 *    runs its issuer's proxy and delegates to its issuer's beacon, leaving no
 *    room for it to be anyone else's. Colored per issuer.
 *
 *  ⚠ CONTRADICTED, from a name check (lib/knownToken.ts). Much weaker: it says
 *    only that this symbol belongs to a different address on this chain. It
 *    cannot separate impersonation from an accidental ticker collision, so the
 *    wording reports the address and never a motive.
 *
 * Everything else carries no mark, and that silence is deliberate in both
 * directions — most tokens impersonate nothing, and a mark on every row would
 * leave the two above indistinguishable from decoration.
 */
const PROVEN = '▣'
const CONTRADICTED = '⚠'

/** the issuer's own color, for the mark and the symbol beside it */
export function stockColor(issuer: StockIssuerId): string {
  return STOCK_ISSUERS[issuer].color
}

/**
 * A token symbol carrying whatever its identity is worth — a drop-in wherever a
 * symbol is rendered as text.
 *
 * The squat check runs HERE rather than at each call site because it is pure: a
 * string against the chain config, no RPC and nothing to cache. Every surface
 * rendering a symbol therefore gets it by construction and none can forget it.
 * The issuer proof does have to ask the chain, so it stays a prop.
 */
export function TokenSymbol(props: {
  symbol: string
  /** the contract behind the symbol — without it, only the issuer mark shows */
  address?: string
  issuer?: StockIssuerId | null
  /**
   * Clip the rendered name to this many display columns, for surfaces whose
   * width a stranger must not get to set (see PairAddrs).
   *
   * Clipping happens HERE rather than at the call site so the identity checks
   * below always see the whole symbol. Handed a truncated name they would be
   * comparing against something the token never claimed, and a squat would go
   * unmarked — the failure would stay invisible today only because every
   * reserved ticker is shorter than any budget worth setting.
   */
  max?: number
}) {
  const { t } = useTranslation()
  const shown = props.max === undefined ? props.symbol : clampWidth(props.symbol, props.max)

  if (props.issuer) {
    const brand = STOCK_ISSUERS[props.issuer]
    return (
      <span
        className="tok-proven"
        style={{ color: brand.color }}
        title={t('stock.verifiedTip', { issuer: brand.label })}
      >
        <span className="tok-glyph" aria-hidden="true">
          {PROVEN}
        </span>
        {shown}
      </span>
    )
  }

  const squat = props.address
    ? squattedSymbol(CHAIN.knownTokens, { symbol: props.symbol, address: props.address })
    : null
  if (!squat) return <>{shown}</>
  return (
    <span
      className="tok-squat"
      title={t('token.squatTip', {
        symbol: squat.symbol,
        chain: CHAIN.name,
        address: shortAddr(squat.address),
      })}
    >
      <span className="tok-glyph" aria-hidden="true">
        {CONTRADICTED}
      </span>
      {shown}
    </span>
  )
}

/**
 * The named chip, for surfaces with room to say who the issuer is — an expanded
 * pool row, a position card. Links to the issuer's own terms where the issuer
 * publishes them from its token contract; plain text where it does not, rather
 * than inventing a destination.
 */
export function StockBadge(props: { issuer: StockIssuerId; symbol?: string }) {
  const { t } = useTranslation()
  const brand = STOCK_ISSUERS[props.issuer]
  const style = { color: brand.color, borderColor: brand.line }
  const title = t('stock.verifiedTip', { issuer: brand.label })
  const body = (
    <>
      <span aria-hidden="true">{PROVEN}</span>
      {props.symbol ? `${props.symbol} · ${brand.short}` : brand.short}
    </>
  )
  if (!brand.terms)
    return (
      <span className="badge stock" style={style} title={title}>
        {body}
      </span>
    )
  return (
    <a
      className="badge stock"
      style={style}
      href={brand.terms}
      target="_blank"
      rel="noreferrer"
      title={t('stock.termsTip', { issuer: brand.label })}
    >
      {body}
      <span aria-hidden="true">↗</span>
    </a>
  )
}

/**
 * The counterpart chip: this token is not the one it is named after.
 *
 * States what was measured — the symbol, and the address that symbol actually
 * means on this chain — and stops there. It does not call the token a scam,
 * because a ticker collision is not evidence of intent and nothing here can
 * tell the two apart.
 */
export function SquatBadge(props: { symbol: string; address: string }) {
  const { t } = useTranslation()
  const squat = squattedSymbol(CHAIN.knownTokens, { symbol: props.symbol, address: props.address })
  if (!squat) return null
  return (
    <span
      className="badge squat"
      title={t('token.squatTip', {
        symbol: squat.symbol,
        chain: CHAIN.name,
        address: shortAddr(squat.address),
      })}
    >
      <span aria-hidden="true">{CONTRADICTED}</span>
      {t('token.squatBadge', { symbol: squat.symbol })}
    </span>
  )
}
