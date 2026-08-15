import { useEffect, useState } from 'react'
import { CHAIN } from '../config/chains'
import type { StockIssuerId } from '../config/chains/stockIssuers'
import type { LaunchpadToken } from '../lib/launchpadToken'
import { monogram, monogramHue, tokenImageUrl } from '../lib/tokenImage'

export type TokenAvatarProps = {
  symbol: string
  address: string
  issuer?: StockIssuerId | null
  launchpad?: LaunchpadToken | null
  /** box size in px — the pair column runs 18, the trade panel 22 */
  size?: number
  /** the side of the pair this row is about, drawn with the accent ring */
  target?: boolean
  title?: string
}

/**
 * A token's picture, or its letters when nothing has proven a picture.
 *
 * The fallback is not a failure state: most tokens have no provable image (see
 * lib/tokenImage.ts) and a monogram is what they are supposed to look like. It
 * is keyed on the ADDRESS, so two tokens sharing a symbol get different colors —
 * the row's ▣/⚠ marks say which is which, and the tile stops quietly agreeing
 * with the impersonator.
 *
 * A URL that 404s or is blocked falls back to the same monogram rather than to a
 * broken-image glyph. That happens for real: the issuer CDN answers 403 for
 * anything outside its own set, and an IPFS gateway can simply be unreachable.
 */
export function TokenAvatar(props: TokenAvatarProps) {
  const size = props.size ?? 18
  const src = tokenImageUrl({
    address: props.address,
    issuer: props.issuer,
    launchpad: props.launchpad,
    knownTokens: CHAIN.knownTokens,
  })
  const [broken, setBroken] = useState(false)
  // a new src is a new claim — give it its own chance to load
  useEffect(() => setBroken(false), [src])

  const box = { width: size, height: size }
  const cls = `tok-avatar${props.target ? ' is-target' : ''}`
  if (!src || broken)
    return (
      <span
        className={`${cls} mono`}
        style={{ ...box, fontSize: Math.round(size * 0.42), background: `hsl(${monogramHue(props.address)} 45% 22%)` }}
        title={props.title ?? props.symbol}
        aria-hidden="true"
      >
        {monogram(props.symbol)}
      </span>
    )
  return (
    <img
      className={cls}
      style={box}
      src={src}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      decoding="async"
      // the picture is third-party by construction, and these URLs sit on a page
      // with a connected wallet — so the origin serving it learns nothing about
      // where it was rendered. No crossOrigin: nothing here reads the pixels
      // back, and requiring CORS would blank every host that does not send it.
      referrerPolicy="no-referrer"
      title={props.title ?? props.symbol}
      onError={() => setBroken(true)}
    />
  )
}

/**
 * Both sides of a pair, the traded one first.
 *
 * Which token a row is ABOUT is the thing the pair column never said: "SPCX/USDG"
 * reads as two equals, when one of them is the market and the other is what it
 * is priced in. The target leads, overlaps the quote, and wears the ring.
 */
export function PairAvatars(props: {
  target: TokenAvatarProps
  quote: TokenAvatarProps
  size?: number
}) {
  return (
    <span className="pair-avatars">
      <TokenAvatar {...props.target} size={props.size} target />
      <TokenAvatar {...props.quote} size={props.size} />
    </span>
  )
}
