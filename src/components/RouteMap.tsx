import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { clampWidth, displayWidth, fmtNum, shortAddr } from '../lib/format'
import { foldedTokenCount, venueRgb } from '../lib/routeMap'
import { planLabels, routeSankey, type SankeyLink } from '../lib/routeSankey'
import { legSharePct, venueLabel, type SolverLeg } from '../lib/solver'
import type { TokenInfo } from '../types'

/**
 * The SHEEP CHOICE route map — where the trade actually goes, as a Sankey.
 *
 * Tokens are nodes with height, flows are links whose THICKNESS is the share of
 * the trade taking them, and a link leaves its source at one height and arrives
 * at its target at another. That last part is the whole point: a split fans out,
 * a merge fans in, and a route that splits and reconverges reads as one shape
 * instead of as parallel strangers. The picture answers "how much went where"
 * before a single number is read.
 *
 * Venue names are written ON the flows rather than keyed by colour. Hue is
 * already committed in this app — green, red and amber mean up, down and warn in
 * every theme, and MONO has no hue at all — so colour here is reinforcement, and
 * a legend nobody can decode would be worse than a label. A band with nowhere to
 * put its name — too thin for a line of type, or with a heavier flow's label
 * already in the space — keeps its colour and gives the name to the tooltip.
 *
 * Hovering is a PROBE: the card answers immediately, because the native title's
 * second of silence is an eternity on a terminal. The flow under the pointer
 * lights and everything else dims, and probing a NODE lights every flow through
 * that token — which is how you ask "what actually goes through WETH".
 *
 * Geometry — columns, stacking, where each link meets each node — is computed
 * and tested in lib/routeSankey. This file is paint and pointers.
 */

/** Width of a node bar. Solid enough to be an object you can point at, narrow
 *  enough that three of them do not eat the flow area. */
const NODE_W = 7
/** The knocked-out tag that names an intermediate token, drawn on its node.
 *  The width is a ceiling on what a chip MAY take, and each chip takes only
 *  what its own name needs — so the wide end of this range is reached by one
 *  collective count, never by a column of four-letter symbols. */
const TAG_W = 72
const TAG_H = 14
const TAG_MIN_W = 34
/** Roughly this many pixels per column at the tag's face and size. */
const TAG_CHAR_W = 6.4
/** …and at the flow label's, which is a size up from the tag. Measured off the
 *  rendered labels at 6.0, the venue's letter-spacing included; the rest is for
 *  the monospace the machine actually resolves, which is not always this one.
 *  Overshooting costs a character, undershooting prints a word through a chip,
 *  so the slack sits on the side that costs less. */
const LBL_CHAR_W = 6.2
/** Clear air between a flow label and whatever it must not run into. */
const LBL_GAP = 6
/** The line a flow label occupies, for asking what it can run into. */
const LBL_H = 12
/** How far under that line the fee prints, when there is one. */
const FEE_DY = 11
/** A band that has to climb keeps at least this much of its bend, so a steep
 *  one reads as a curve rather than as a bent stick. */
const CURVE_MIN = 0.2
/** Below this a band is thinner than the outline that would separate it from
 *  its neighbour, so it is drawn as fill alone. */
const EDGE_MIN = 2

type Probe = { tip: string; key: string; x: number; y: number }

export function RouteMap({ route, tokens }: { route: SolverLeg[]; tokens: TokenInfo[] }) {
  const { t } = useTranslation()
  const layout = useMemo(() => routeSankey(route), [route])
  const symbolOf = useMemo(() => {
    const known = new Map(tokens.map((token) => [token.address.toLowerCase(), token.symbol]))
    return (address: string) => known.get(address) ?? shortAddr(address)
  }, [tokens])
  const root = useRef<HTMLDivElement>(null)
  const flow = useRef<HTMLDivElement>(null)
  const [probe, setProbe] = useState<Probe | null>(null)
  // The map is drawn in real pixels rather than scaled from a viewBox: an SVG
  // stretched to fit would take its text with it, and labels at 0.9x the size of
  // the line beside them read as a broken font stack rather than as a diagram.
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const box = flow.current
    if (!box) return
    const measure = () => setWidth(box.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  // A quote refreshes on a timer. Re-running the entry animation every few
  // seconds on an unchanged picture is just flicker, so it remounts only when
  // the SHAPE moves — a venue enters or leaves, or the split shifts enough to
  // redraw a band. The animation then means "the route changed".
  const shape = layout?.links.map((l) => `${l.protocol}:${l.pool}:${l.shareBps}`).join('|') ?? ''
  useEffect(() => setProbe(null), [shape])

  if (!layout) return null
  const { cols, height, nodes, links } = layout
  const first = nodes.find((node) => node.end === 'in')
  const last = nodes.find((node) => node.end === 'out')
  const pct = (shareBps: number) => fmtNum(shareBps / 100, 4)
  const tag = (symbol: string, max: number) => clampWidth(symbol, max)

  // Columns share the width evenly; the node bars sit ON the column lines, so
  // the first and last hug the two ends and the flows own everything between.
  const colX = (col: number) => (cols < 2 ? 0 : (col * (width - NODE_W)) / (cols - 1))
  /** columns carrying a knocked-out token tag, whose tags have to clear each other */
  const tagged = new Set(nodes.filter((node) => !node.end).map((node) => node.col))
  // A quarter of the map, where a fixed slab was held to a sixth: a chip now
  // takes only the room its own name needs, so the share a whole column of them
  // costs is far below this ceiling and only a long name ever reaches it.
  const tagW = Math.max(TAG_MIN_W, Math.min(TAG_W, width / 4))
  // one character of padding either side of the longest name a chip may carry
  const tagChars = Math.max(3, Math.floor(tagW / TAG_CHAR_W) - 1)
  /**
   * What a waypoint chip says.
   *
   * The collective node stands for the waypoints too small to name, so it says
   * how many — the same shape the collective BAND uses when it says "+18
   * POOLS", which is how the two counts stay apart. Where the map is too narrow
   * to spell the word, the count prints alone and the tooltip carries the rest;
   * that reads better than "+4 TOKE…".
   */
  const tagText = (token: string): string => {
    const folded = foldedTokenCount(token)
    if (folded === null) return tag(symbolOf(token), tagChars)
    const full = t('rmap.viaMany', { n: folded })
    return displayWidth(full) <= tagChars ? full : t('rmap.viaManyShort', { n: folded })
  }
  /** Chips are sized to what they carry. A fixed slab makes a two-letter symbol
   *  look redacted and still has to truncate a collective's count. */
  const chipW = (text: string) => Math.min(tagW, (displayWidth(text) + 2) * TAG_CHAR_W)
  /**
   * Where each waypoint tag prints.
   *
   * Centred on its node, then relaxed in two passes so no tag prints on top of
   * another. Two waypoints at the same depth share a column, and on a route
   * where both carry a few percent their nodes are small and adjacent —
   * centred naively, the two tags printed on top of each other and neither
   * could be read.
   */
  const tagY = new Map<string, number>()
  for (const col of tagged) {
    const column = nodes.filter((n) => !n.end && n.col === col).sort((a, b) => a.y0 - b.y0)
    // Down-pass: each tag clears the one above it. Seeded so the first clears
    // the top edge rather than hanging over the card's border.
    const ys: number[] = []
    let last = TAG_H / 2 + 1 - (TAG_H + 2)
    for (const node of column) {
      last = Math.max((node.y0 + node.y1) / 2, last + TAG_H + 2)
      ys.push(last)
    }
    // Up-pass: the bottom edge is a wall that pushes back. Clamping to it
    // without this printed every overflowing tag at the SAME y, which is how
    // USDC and Cake landed on one pixel on a route where both carried 5%.
    let limit = height - TAG_H / 2 - 1
    for (let i = ys.length - 1; i >= 0; i--) {
      ys[i] = Math.min(ys[i], limit)
      limit = ys[i] - TAG_H - 2
      tagY.set(`${column[i].col}:${column[i].token}`, ys[i])
    }
  }
  /** The waypoint chips that will actually print, each with the box it needs. */
  const chips = nodes
    .map((node, i) => {
      const mid = tagY.get(`${node.col}:${node.token}`) ?? (node.y0 + node.y1) / 2
      const text = tagText(node.token)
      return { node, i, mid, text, w: chipW(text) }
    })
    .filter(({ node }) => !node.end)
    // A tag relaxed clear of its own bar has stopped naming anything — it sits
    // over whatever flow happens to pass behind it and points at nothing. That
    // token keeps its name in the tooltip, which is where a node too short to
    // carry a legible tag has always kept it.
    .filter(({ node, mid }) => mid >= node.y0 - TAG_H / 2 && mid <= node.y1 + TAG_H / 2)
  /** How far a column's chips reach from its bar, so a label beside one clears
   *  it. Taken from the widest chip that column actually prints. */
  const chipReach = new Map<number, number>()
  for (const chip of chips)
    chipReach.set(chip.node.col, Math.max(chipReach.get(chip.node.col) ?? 0, chip.w / 2 + 5))
  /** Everything downstream a flow label could print over: the node bars and the
   *  opaque chips that name them, each with the band of the map it stands in. */
  const obstacles = [
    ...nodes.map((node) => ({ col: node.col, x0: colX(node.col), top: node.y0, bottom: node.y1 })),
    ...chips.map((chip) => ({
      col: chip.node.col,
      x0: colX(chip.node.col) + NODE_W / 2 - chip.w / 2,
      top: chip.mid - TAG_H / 2,
      bottom: chip.mid + TAG_H / 2,
    })),
  ]
  /** where a column's flow labels start */
  const labelX = (col: number) => colX(col) + NODE_W + (chipReach.get(col) ?? 7)
  /**
   * …and how much room a label on a given line has there.
   *
   * A label used to run as far as its text needed. Nothing stopped it: the SVG
   * lets its content overflow on purpose, so on a narrow map the name of a flow
   * leaving one column printed straight through the opaque chip naming the next
   * one, and a label in the last column ran out over the output token's name.
   * Measured on five live BSC routes at 360px, three to four labels per route
   * ran into the next column's chip.
   *
   * So a label runs until it reaches ink that would obscure it, on its own line
   * — the column lines themselves are not ink. Columns are evenly spaced, but a
   * column's bars need not be: on the busiest live route column 1 holds three
   * waypoints and all three sit in the bottom fifth, and the flows above them
   * cross a third of the map with nothing in it. Walling every label at the
   * next column line cut "37% PANCAKE V3" to "37% PANCAK…" to clear empty air.
   *
   * What does not fit is given up in the order that costs the reader least —
   * the fee line first, then the venue's name shortened, then the label
   * altogether — and all of it stays in the hover card.
   */
  const labelRoom = (col: number, top: number, bottom: number) => {
    let wall = width
    for (const o of obstacles)
      if (o.col > col && top < o.bottom && bottom > o.top) wall = Math.min(wall, o.x0)
    return wall - LBL_GAP - labelX(col)
  }

  /** which flows keep their names, and which of those keep a fee line */
  const labelFee = planLabels(links)

  const linkPath = (l: SankeyLink): string => {
    const x0 = colX(l.fromCol) + NODE_W
    const x1 = colX(l.toCol)
    const dx = x1 - x0
    /**
     * How far each control point sits from its own end of the band.
     *
     * Both at the midpoint — the textbook default — is right while a band runs
     * roughly level: it leaves and arrives horizontally, so its thickness is
     * read against the node it touches rather than against a slope. It stops
     * being right once the band has to climb further than the column gap is
     * wide. The ribbon then leaves flat, lurches through the whole climb in the
     * few pixels either side of the midpoint, and arrives flat — and through
     * that lurch its apparent width, measured across the flow rather than down
     * the page, pinches to a thread before flaring back. On a 360px map a live
     * USDT→Cake route had a band climbing half a pixel for every pixel it had
     * to travel, which is where the picture starts looking like a mistake.
     *
     * Pulling the control points back toward their own ends as the climb
     * steepens spends the height evenly along the run instead, which is a
     * diagonal the eye can follow. A level band is untouched — the common case
     * keeps exactly the shape it had.
     */
    const climb = Math.abs((l.ty0 + l.ty1) / 2 - (l.sy0 + l.sy1) / 2)
    const bend = dx <= 0 ? 0.5 : Math.max(CURVE_MIN, 0.5 * Math.min(1, dx / Math.max(1, climb)))
    const c0 = x0 + dx * bend
    const c1 = x1 - dx * bend
    return [
      `M${x0},${l.sy0}`,
      `C${c0},${l.sy0} ${c1},${l.ty0} ${x1},${l.ty0}`,
      `L${x1},${l.ty1}`,
      `C${c1},${l.ty1} ${c0},${l.sy1} ${x0},${l.sy1}`,
      'Z',
    ].join('')
  }

  const at = (e: MouseEvent): { x: number; y: number } => {
    const rect = root.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: Math.max(0, Math.min(e.clientX - rect.left + 10, rect.width - 290)),
      y: e.clientY - rect.top + 16,
    }
  }
  const arm = (tip: string, key: string) => (e: MouseEvent) => setProbe({ tip, key, ...at(e) })
  const track = (e: MouseEvent) => setProbe((held) => (held ? { ...held, ...at(e) } : held))
  const disarm = () => setProbe(null)
  // What the probe lights. A link lights itself; a node lights every flow that
  // touches it, which is the question a waypoint invites.
  const linkKey = (l: SankeyLink) => `l:${l.fromCol}:${l.pool}:${l.protocol}`
  const litLink = (l: SankeyLink): boolean => {
    if (!probe) return false
    if (probe.key === linkKey(l)) return true
    const [kind, col, token] = probe.key.split(' ')
    if (kind !== 'n') return false
    return (
      (l.from === token && l.fromCol === Number(col)) || (l.to === token && l.toCol === Number(col))
    )
  }
  const nodeKey = (col: number, token: string) => `n ${col} ${token}`
  const litNode = (col: number, token: string): boolean => {
    if (!probe) return false
    if (probe.key === nodeKey(col, token)) return true
    const held = links.find((l) => linkKey(l) === probe.key)
    return !!held && ((held.from === token && held.fromCol === col) || (held.to === token && held.toCol === col))
  }

  return (
    <div className="rmap" ref={root}>
      <div className="rmap-flow">
        <span
          className="rmap-end"
          title={
            first
              ? t('rmap.tokenTip', { sym: symbolOf(first.token), addr: shortAddr(first.token) })
              : undefined
          }
        >
          {first ? tag(symbolOf(first.token), 9) : ''}
        </span>
        <div className="rmap-canvas" ref={flow} style={{ height }}>
          {width > 0 && (
            <svg
              key={shape}
              className={`rmap-svg${probe ? ' probing' : ''}`}
              width={width}
              height={height}
              onMouseLeave={disarm}
            >
              <defs>
                {/* One gradient per link: the flow reads left-to-right because it
                    brightens at the mouth and settles as it travels, which is the
                    only place direction of travel is stated on the picture. */}
                {links.map((l, i) => (
                  <linearGradient key={`g${i}`} id={`rmap-g${i}`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={`rgba(${venueRgb(l.protocol)}, 0.72)`} />
                    <stop offset="14%" stopColor={`rgba(${venueRgb(l.protocol)}, 0.5)`} />
                    <stop offset="100%" stopColor={`rgba(${venueRgb(l.protocol)}, 0.38)`} />
                  </linearGradient>
                ))}
                {/* The collective sliver band is a summary, and the hatch is
                    what says so. It used to be the whole band — an opaque
                    two-tone stripe that read as a hole punched through the
                    picture rather than as a flow, and the loudest ink on the
                    map for its least important content. Now it is a texture
                    SCORED INTO an ordinary slate band: the same gradient every
                    other flow gets, ruled through in the page's own colour so
                    it stays a texture on every theme. */}
                <pattern
                  id="rmap-fold"
                  width="6"
                  height="6"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="1" height="6" fill="var(--bg)" opacity="0.55" />
                </pattern>
              </defs>

              {links.map((l, i) => (
                <path
                  key={`p${i}`}
                  className={`rmap-link${litLink(l) ? ' lit' : ''}`}
                  d={linkPath(l)}
                  fill={`url(#rmap-g${i})`}
                  // Two bands of neighbouring venues stack edge to edge, and a
                  // fill alone lets them read as one mass. The hairline is what
                  // says "these are two flows" without costing any height — and
                  // it stands down on a band no thicker than the outline itself,
                  // where forty of them would edge each other into one glare.
                  stroke={l.sy1 - l.sy0 >= EDGE_MIN ? `rgba(${venueRgb(l.protocol)}, 0.55)` : 'none'}
                  strokeWidth={0.75}
                  style={{ '--rmap-i': i } as React.CSSProperties}
                  onMouseEnter={arm(
                    l.folded
                      ? t('rmap.sliversTip', { n: l.folded, pct: pct(l.shareBps) })
                      : t('rmap.hopTip', {
                          venue: venueLabel(l.protocol),
                          fee: l.feeBps === null ? '?' : fmtNum(l.feeBps / 100, 4),
                          pct: pct(l.shareBps),
                          pool: shortAddr(l.pool),
                        }),
                    linkKey(l),
                  )}
                  onMouseMove={track}
                  onMouseLeave={disarm}
                />
              ))}

              {/* …and the hatch is ruled over the band it belongs to, after it,
                  so a collective still reads as a flow of its own size. It takes
                  no pointer events: the band underneath owns the probe. */}
              {links.map((l, i) =>
                l.folded ? (
                  <path
                    key={`f${i}`}
                    className={`rmap-link fold${litLink(l) ? ' lit' : ''}`}
                    d={linkPath(l)}
                    fill="url(#rmap-fold)"
                    style={{ '--rmap-i': i } as React.CSSProperties}
                  />
                ) : null,
              )}

              {nodes.map((node, i) => (
                <rect
                  key={`n${i}`}
                  className={`rmap-node${node.end ? ' end' : ''}${litNode(node.col, node.token) ? ' lit' : ''}`}
                  x={colX(node.col)}
                  y={node.y0}
                  width={NODE_W}
                  height={Math.max(1, node.y1 - node.y0)}
                  style={{ '--rmap-i': i } as React.CSSProperties}
                  {...(node.end
                    ? {}
                    : {
                        onMouseEnter: arm(
                          foldedTokenCount(node.token) === null
                            ? t('rmap.viaTip', {
                                pct: pct(node.shareBps),
                                sym: symbolOf(node.token),
                                addr: shortAddr(node.token),
                              })
                            : t('rmap.viaManyTip', {
                                pct: pct(node.shareBps),
                                n: foldedTokenCount(node.token),
                              }),
                          nodeKey(node.col, node.token),
                        ),
                        onMouseMove: track,
                        onMouseLeave: disarm,
                      })}
                />
              ))}

              {/* Flow labels ride the mouth of the band rather than its middle: a
                  link that skips a column passes BEHIND a node, and a centred
                  label lands on it — "GIGADEX CL" once came out as "GIG DEX CL". */}
              {links.map((l, i) => {
                const wantsFee = labelFee.get(i)
                if (wantsFee === undefined) return null
                // Clear the waypoint tag where there is one. Both are anchored to
                // the same column, and a label starting right at the bar lands
                // under the knockout — "100% UNI V3" came out as "% UNI V3".
                const x = labelX(l.fromCol)
                const mid = (l.sy0 + l.sy1) / 2
                // the line this label will stand on, fee and all, so its room is
                // measured against the chips actually beside it
                const top = mid - LBL_H / 2 - (wantsFee ? 2 : 0)
                const bottom = mid + LBL_H / 2 + (wantsFee ? FEE_DY : 0)
                const columns = Math.floor(labelRoom(l.fromCol, top, bottom) / LBL_CHAR_W)
                const head = `${legSharePct(l.shareBps)}%`
                const venue = l.folded ? t('rmap.slivers', { n: l.folded }) : venueLabel(l.protocol)
                // the share is the one thing the label exists to say, so a
                // column count that cannot hold it plus a letter of venue is a
                // label that has stopped being worth its ink
                const room = columns - displayWidth(head) - 1
                if (room < 2) return null
                // planLabels only asks for a fee line on a hop that HAS a fee
                const fee = wantsFee ? t('rmap.fee', { pct: fmtNum(l.feeBps! / 100, 4) }) : ''
                const withFee = wantsFee && displayWidth(fee) <= columns
                return (
                  <g key={`t${i}`} className={`rmap-lbl${litLink(l) ? ' lit' : ''}`} style={{ '--rmap-i': i } as React.CSSProperties}>
                    <text x={x} y={withFee ? mid - 2 : mid} dominantBaseline="middle">
                      <tspan className="rmap-pct">{head}</tspan>{' '}
                      <tspan className="rmap-venue">{clampWidth(venue, room)}</tspan>
                    </text>
                    {withFee && (
                      <text className="rmap-fee" x={x} y={mid + FEE_DY} dominantBaseline="middle">
                        {fee}
                      </text>
                    )}
                  </g>
                )
              })}

              {/* A waypoint is labelled ON itself, knocked out of whatever flows
                  behind it. Under the map a caption could only say "this
                  column", and at three hops one column can hold two different
                  tokens — which one it meant would be a guess. Centred on the
                  node and clamped into the canvas, so a node that starts at the
                  top edge does not hang its tag over the card's border. */}
              {chips.map(({ node, i, mid, text, w }) => (
                <g
                  key={`w${i}`}
                  className={`rmap-wall${foldedTokenCount(node.token) === null ? '' : ' many'}`}
                  style={{ '--rmap-i': i } as React.CSSProperties}
                >
                  <rect
                    className="rmap-wall-bg"
                    x={colX(node.col) - w / 2 + NODE_W / 2}
                    y={mid - TAG_H / 2}
                    width={w}
                    height={TAG_H}
                    rx={2}
                  />
                  <text
                    x={colX(node.col) + NODE_W / 2}
                    y={mid}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {text}
                  </text>
                </g>
              ))}
            </svg>
          )}
        </div>
        <span
          className="rmap-end"
          title={
            last
              ? t('rmap.tokenTip', { sym: symbolOf(last.token), addr: shortAddr(last.token) })
              : undefined
          }
        >
          {last ? tag(symbolOf(last.token), 9) : ''}
        </span>
      </div>
      {probe && (
        <div className="rmap-tip" style={{ left: probe.x, top: probe.y }}>
          {probe.tip}
        </div>
      )}
    </div>
  )
}
