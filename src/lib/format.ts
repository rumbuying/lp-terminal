import { formatUnits } from 'viem'

const SUB_DIGITS = '₀₁₂₃₄₅₆₇₈₉'
const subscriptNum = (n: number): string =>
  String(n)
    .split('')
    .map((d) => SUB_DIGITS[Number(d)])
    .join('')

/** significant-digit number formatting with thousands separators.
    many-zero decimals compress to the common web3 notation: 0.000072051 → 0.0₄72051 */
export function fmtNum(x: number, sig = 5): string {
  if (!Number.isFinite(x)) return '—'
  if (x === 0) return '0'
  sig = Math.max(1, Math.min(sig, 21)) // toPrecision throws outside [1,100]
  const neg = x < 0
  const a = Math.abs(x)
  let s: string
  if (a >= 1) {
    const intDigits = Math.floor(Math.log10(a)) + 1
    const frac = Math.max(0, Math.min(sig - intDigits, 8))
    s = a.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: frac })
  } else {
    s = a.toPrecision(sig)
    if (s.includes('e')) {
      const exp = Math.ceil(-Math.log10(a))
      s = a.toFixed(Math.min(exp + sig, 18))
    }
    s = s.replace(/\.?0+$/, '')
    const zeros = s.match(/^0\.(0{4,})(?=[1-9])/)
    if (zeros) s = `0.0${subscriptNum(zeros[1].length)}${s.slice(2 + zeros[1].length)}`
  }
  return (neg ? '-' : '') + s
}

export function fmtAmount(v: bigint, decimals: number, sig = 5): string {
  return fmtNum(Number(formatUnits(v, decimals)), sig)
}

/** exact decimal-point shift for scientific-notation pastes — string math only,
 *  a float round-trip would corrupt exactly the tiny amounts this serves */
function shiftDecimal(int: string, frac: string, exp: number): string | null {
  if (!Number.isFinite(exp) || Math.abs(exp) > 30) return null
  const digits = int + frac
  const point = int.length + exp
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length)
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}

/** normalize user-typed token amounts (the web3 small-amount conventions):
 *  whitespace stripped, decimal comma → dot, pasted scientific notation
 *  ("5e-5") expanded exactly, and the fraction CLAMPED to the token's decimals
 *  — text the token cannot represent must not sit in the box silently quoting
 *  zero. Returns the normalized string, or null when the text is not an amount
 *  (caller keeps the previous value, the controlled input swallows the key). */
export function sanitizeAmountInput(raw: string, decimals: number): string | null {
  let s = raw
    .replace(/\s+/g, '')
    // Chinese-IME width normalization: with an IME active the digit/dot keys
    // emit fullwidth ０-９／。／．／，— rejecting just the dot turned a typed
    // "0。05" into "005", a 100× amount error, so map instead of reject
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[。．]/g, '.')
    .replace('，', ',')
    .replace(',', '.')
  if (s === '') return ''
  const sci = s.match(/^(\d*)\.?(\d*)[eE]([+-]?\d+)$/)
  if (sci && (sci[1] || sci[2])) {
    const shifted = shiftDecimal(sci[1], sci[2], Number(sci[3]))
    if (shifted === null) return null
    s = shifted
  }
  if (!/^\d*\.?\d*$/.test(s)) return null
  const [int, frac = ''] = s.split('.')
  if (frac.length > decimals) return decimals === 0 ? int : `${int}.${frac.slice(0, decimals)}`
  return s
}

/** compact amount for dense table cells: 24.9M, 338.4K, 12.4, 0.0421.
 *  Bounded by construction — ~8 characters whatever the input. Intl's compact
 *  notation stops at T and then silently degrades into a grouped number
 *  ("298,973,758,851.7T", 18 chars), which is the one thing a fixed-width cell
 *  cannot absorb: it widened the pool table past the viewport. */
export function fmtCompact(x: number): string {
  if (!Number.isFinite(x)) return '—'
  if (x !== 0 && Math.abs(x) < 1) return fmtNum(x, 3)
  if (Math.abs(x) >= 1e15) return x.toExponential(1)
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x)
}

export function fmtCompactAmount(v: bigint, decimals: number): string {
  return fmtCompact(Number(formatUnits(v, decimals)))
}

export function fmtUsd(x: number | string | undefined): string {
  const n = typeof x === 'string' ? Number(x) : x
  if (n === undefined || !Number.isFinite(n)) return ''
  // bounded width: sub-cent USD precision is noise everywhere in this app,
  // and long fractions (dust TVLs) were stretching table columns
  if (n > 0 && n < 0.01) return '<$0.01'
  // exact dollars are this function's job, but the inputs include third-party
  // figures (dexscreener) we don't get to sanity-check: past a trillion the
  // number is wrong, and rendering it exactly costs 30 characters of column
  if (Math.abs(n) >= 1e12) return '$' + fmtCompact(n)
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 })
}

export function fmtPct(x: number, dp = 2): string {
  if (!Number.isFinite(x)) return '—'
  return x.toFixed(dp) + '%'
}

export function shortAddr(a: string): string {
  return a.slice(0, 6) + '…' + a.slice(-4)
}

/* Characters that render into the cell before them — accents, variation
   selectors, the zero-width joiner — and so cost no column of their own. */
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u
/* The two-cell ranges: Hangul, the kana and CJK blocks including the astral
   extensions, and the fullwidth forms. Listed explicitly because JS regex has
   no `East_Asian_Width` property to ask for.

   Emoji ride a property instead of a range list. They are spread across five
   discontinuous blocks and gain more with each Unicode revision, so a list is
   a silent under-count waiting to happen — 🚀 alone sits in Transport, outside
   the Emoticons range an earlier draft of this stopped at. The property rounds
   a few legacy dingbats (™, ©) up to two columns, which is the safe direction:
   this is a budget, and over-stating a width clips a name one character early
   rather than letting it past the edge of the column. */
const WIDE =
  /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]|[\u{17000}-\u{18aff}\u{20000}-\u{3fffd}]/u

function charWidth(ch: string): number {
  if (ZERO_WIDTH.test(ch)) return 0
  return WIDE.test(ch) ? 2 : 1
}

/**
 * How many columns a string occupies in this terminal's monospace face.
 *
 * A count of characters is not a width, and the difference is not cosmetic: a
 * CJK ideograph, kana, Hangul syllable or fullwidth form takes TWO cells in
 * every monospace font. A name that passes a 32-character cap can therefore lay
 * out 64 columns — which is how a Chinese token name pushed the pools table's
 * right-hand columns off the screen while the cap that was supposed to stop it
 * reported no problem.
 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

/**
 * Clip to `max` display columns, the ellipsis paid for out of the same budget.
 *
 * Walks code points instead of slicing. `.slice()` counts UTF-16 units and cuts
 * an emoji or an astral ideograph in half, leaving a replacement glyph sitting
 * in the one field on the row that a stranger controls completely.
 */
export function clampWidth(s: string, max: number): string {
  if (max <= 0) return ''
  if (displayWidth(s) <= max) return s
  let out = ''
  let width = 0
  for (const ch of s) {
    const w = charWidth(ch)
    if (width + w > max - 1) break // the ellipsis owns the last column
    out += ch
    width += w
  }
  return out + '…'
}

/** signed bps difference of a vs b (positive = a better) */
export function bpsDiff(a: bigint, b: bigint): number {
  if (b === 0n) return 0
  return Number(((a - b) * 1_000_000n) / b) / 100
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
