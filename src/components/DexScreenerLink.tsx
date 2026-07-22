import { useTranslation } from 'react-i18next'
import { dsPairUrl } from '../lib/dexscreener'

// DexScreener's own mark, from their favicon (their CDN refuses plain fetches
// and ships no public SVG), re-encoded lossless to 686 B and inlined so the
// page stays self-contained under CSP — same treatment as ProtoBadge's UP icon.
// The art is a white glyph on a black rounded square: on this terminal's near-
// black panels the square disappears and only the glyph reads.
const DS_ICON =
  'data:image/webp;base64,UklGRqYCAABXRUJQVlA4TJoCAAAvL8ALEHfBoG0kR8m17zvPn+zRYNi2jSPp2vf491/2GLaNpCjH/Om/1idUkW1jNaH/lyYk8Bp4DW7s/ee6xoI8IZfeDyigFRDAf4HsTUMYrQGIssfI5zznV0CQKJEiUSIIFFVSVEmRKJGiSgoIkgsEiir9vyBILhAkUkCCtW1RW31tv86Txj/526tXbOlA0p+w//UpQrKCiP5PQEopvb5c8wxvH67SYvPIs31sUkrNLc/4tknpkeXqQgRi+NiV8TFdsFgDVu7fi3j5UNJ9o9BLyfNdgRiKTQqumZUNSTFUNCHZ7TJrD0IxVDWh/LDiYP0BlYPaUIMBJwys2lo9kzoUq2XCuiPF6phwrKJwlH2Ng9BBa4yAI6eyz44OGGtMQCDpSkaSAfiq8Qt8UYVia0wp7/SVwmw0ZTsB8ecHwNRRzc1CpT0VcOTupyPlQ9lNgDDUg9IBJiT/9yS3BjgKAKvxB2C/oTin5AR8km9uVHZWC3NTznsA6DlXw7zCbgGw8LPjfranhPCHZSl7ywCgYFEYke/LfC6O1KV3uhVTmWWCsPNLn0IJmWORYjmQrSFrHemXoCUewwK8cBuX4pZdwOIIXyBRdQm2oy7949awrHrYrBuEUwZH4TRzlIjsRNmtI2k52KaNgHU05I8s77HWcQQGjlirZQYbcsdNG42t5XpDKOphwpiBo/PskT1SDGOBWOhIP9sDOLIVGoA486T4o6wLA0kqAK8AoKQCwNsEQEly8KvajosBJvwBEEgPwLONMJ5Q4ck2AsdNC8CEdBhOwSAkFcDYAxhItsaTdpxPQAjAxHlXcl2QDQBgrHrzVEcMMKnzcFmH24gt616lpzocHes+pdTc1ql926SUmqfzeWrS4sX93TlcP1+mlBI='

/**
 * The pair's DexScreener chart, one click away — sits right of the protocol
 * mark, wherever a pair is named.
 *
 * A plain anchor by design: the browser does the navigating, so there is no
 * runtime-built URL string for untrusted data to land in. `rel` names both
 * tokens even though `noreferrer` already implies `noopener` — the promise
 * that the opened tab gets no handle back into this one (the tab that has the
 * user's wallet connected) shouldn't quietly rest on that implication.
 *
 * Renders nothing when the pool address doesn't validate: see lib/dexscreener.
 */
export function DexScreenerLink({ pool }: { pool: string }) {
  const { t } = useTranslation()
  const href = dsPairUrl(pool)
  if (!href) return null
  return (
    <a
      className="ds-btn"
      href={href}
      target="_blank"
      rel="noreferrer noopener external"
      title={t('pools.dsTip')}
      // the table row / card header behind this is its own toggle
      onClick={(e) => e.stopPropagation()}
    >
      <img src={DS_ICON} alt="" aria-hidden="true" />
      DS↗
    </a>
  )
}
