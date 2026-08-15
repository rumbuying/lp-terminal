/**
 * Sankey geometry for the SHEEP CHOICE route map.
 *
 * The map used to be a stacked bar wearing a Sankey's name: a leg was given one
 * row band and kept it across every column, so links were rectangles, nothing
 * ever crossed, and the picture could not show a split reconverging — the one
 * shape a router's answer is actually about.
 *
 * This is the real thing. A token is a NODE with a height, a flow is a LINK that
 * leaves its source node at one height and arrives at its target at another, and
 * the curve between the two is what a reader follows. Splits fan out, merges fan
 * in, and a leg that skips a waypoint passes behind it.
 *
 * The arithmetic lives here, away from the DOM, so every claim the picture makes
 * is assertable. Semantics stay in lib/routeMap — sliver folding, branch
 * ordering and venue colour are unchanged by the shape of the drawing, and this
 * module deliberately borrows rather than restates them.
 *
 * Coordinates come out in pixels against the height this module chooses. There
 * is no viewBox scaling: text inside an SVG that is stretched to fit stops
 * matching the terminal's type scale, and a route map whose labels are 0.9× the
 * text beside it looks like a bug in the font stack.
 */
import { condenseWaypoints, hopFeeBps, orderLegs, tracesAPath } from './routeMap'
import type { SolverLeg } from './solver'

/** Gap between two stacked nodes in the same column. Wide enough to read as a
 *  separation, narrow enough that a column of six still has room to be flows.
 *  No flow crosses a gap, so on a route drawn as forty hairlines each one is a
 *  black gash through the weave — which is what keeps this number small. */
const NODE_GAP = 6
/** Height a single band prefers not to drop below. A 0.3% sliver is real and
 *  has to be visible; below about this it is a hairline. */
const MIN_BAND = 3
/**
 * …but the floors together never take more of a span than this.
 *
 * The floor is a favour to the tail, and past a few dozen bands it turns into
 * a tax on everyone: forty bands at a 3px floor claim 120px of a 248px map
 * before a single share is weighed, so a 35% flow and a 0.3% flow come out
 * 10px and 3px apart and the picture stops meaning what its thickness says.
 * Under this budget the floor shrinks instead — the tail is a hairline rather
 * than nothing, and everything above it is drawn to scale. At a sixth, forty
 * bands cost the biggest flow about a tenth of its height and the smallest
 * still lands on a whole pixel.
 */
const FLOOR_BUDGET = 0.16
/**
 * The map's height. Fixed.
 *
 * It used to grow with how crowded the route was, which meant the panel around
 * it moved every time the router changed its mind — the same quote refreshed
 * on a timer can go from four parallel flows to nine and back. A route map
 * that resizes under the pointer costs more than the pixels it saves on a
 * simple route, and thickness already says everything the height was saying.
 */
const HEIGHT = 248

export type SankeyNode = {
  token: string
  col: number
  /** stacking position within the column, 0 = top */
  order: number
  y0: number
  y1: number
  /** share of the whole trade passing through, in bps */
  shareBps: number
  end: 'in' | 'out' | null
}

export type SankeyLink = {
  protocol: string
  pool: string
  feeBps: number | null
  shareBps: number
  /** legs merged into this one link */
  legs: number
  /** on a collective sliver band: how many real legs it stands for */
  folded?: number
  from: string
  to: string
  fromCol: number
  toCol: number
  /** where it leaves the source node */
  sy0: number
  sy1: number
  /** where it arrives at the target node */
  ty0: number
  ty1: number
}

export type SankeyLayout = {
  cols: number
  height: number
  nodes: SankeyNode[]
  links: SankeyLink[]
}

type LinkAcc = {
  protocol: string
  pool: string
  feeBps: number | null
  shareBps: number
  legs: number
  folded?: number
  from: string
  to: string
  fromCol: number
  toCol: number
  /** first time the route mentioned this edge — the tie-break that keeps the
   *  same quote drawing the same picture */
  seq: number
}

/**
 * Share `height` out by weight, guaranteeing every part at least `floor`.
 *
 * Pure proportionality deletes the tail: a 0.4% leg of a 100px map is a band
 * four tenths of a pixel tall, which is nothing on screen while its share still
 * counts in the total — the picture would then be quietly missing a path the
 * trade actually takes. Every part is given the floor first and the remainder is
 * divided by weight, so the ranking survives (equal floors cannot reorder
 * anything) and the parts still sum to exactly `height`. Where the floors would
 * eat more than FLOOR_BUDGET of the span, the floor itself shrinks rather than
 * the shares being flattened to pay for it.
 */
function splitWithFloor(weights: number[], height: number, floor: number): number[] {
  if (weights.length === 0) return []
  const base = Math.min(floor, (height * FLOOR_BUDGET) / weights.length)
  const total = weights.reduce((sum, w) => sum + w, 0)
  const free = Math.max(0, height - base * weights.length)
  return weights.map(
    (w) => base + (total > 0 ? (w / total) * free : free / weights.length),
  )
}

/** Gaps are a preference, not a claim on the canvas: a column crowded enough
 *  that its separators would not fit gives them up rather than stacking nodes
 *  off the bottom of the picture. */
function gapFor(count: number, height: number): number {
  return Math.min(NODE_GAP, (height * 0.4) / Math.max(1, count - 1))
}

/**
 * Stack a column's nodes against a scale shared by the WHOLE picture.
 *
 * Normalising each column to its own total is the tempting version and it lies:
 * a waypoint carrying 5% of the trade is the only node in its column, so it
 * fills the canvas and reads as though everything went through it. The scale is
 * therefore global — set by the busiest column, applied everywhere — so a bar's
 * height means the same thing in column three as in column one, and a route
 * that mostly bypasses a token SHOWS that token as a short bar.
 *
 * Columns lighter than the busiest come out shorter than the canvas and are
 * centred in it, which is what gives a partial waypoint its floating look.
 */
function stackColumn(nodes: SankeyNode[], height: number, scale: number): void {
  if (nodes.length === 0) return
  const gap = gapFor(nodes.length, height)
  let y = 0
  for (const node of nodes) {
    const h = MIN_BAND + node.shareBps * scale
    node.y0 = y
    node.y1 = y + h
    y = node.y1 + gap
  }
  const slack = height - (y - gap)
  if (slack > 0.5)
    for (const node of nodes) {
      node.y0 += slack / 2
      node.y1 += slack / 2
    }
}

/**
 * Lay a route out as a Sankey.
 *
 * Returns null on the same terms the old map did: a leg whose hops do not trace
 * a simple path means a version mismatch between this bundle and the router, and
 * a map missing one leg would show shares that do not add up — worse than no map
 * at all, because the numbers printed beside it are still right.
 */
export function routeSankey(route: SolverLeg[]): SankeyLayout | null {
  const real = route.filter((leg) => leg.hops.length > 0)
  if (real.length === 0) return null
  if (!real.every(tracesAPath)) return null
  // Waypoints fold; legs never do. A sliver carrying three tenths of a percent
  // is drawn three tenths of a percent thick — that is what thickness is FOR,
  // and a reader who wants to know how much went through a hairline can point
  // at it. Gathering a tail into one summary band traded a picture that answers
  // for one that has to be believed.
  const shown = orderLegs(condenseWaypoints(real))

  // One column per token, placed by the LONGEST path from the input, so a direct
  // leg drawn beside a two-hop leg still ends on the SAME output node — a trade
  // that appeared to end in two different places would be a lie about the route.
  const depth = new Map<string, number>([[shown[0].hops[0].tokenIn, 0]])
  const passes = Math.max(...shown.map((leg) => leg.hops.length))
  for (let pass = 0; pass < passes; pass++)
    for (const leg of shown)
      for (const hop of leg.hops)
        depth.set(
          hop.tokenOut,
          Math.max(depth.get(hop.tokenOut) ?? 0, (depth.get(hop.tokenIn) ?? 0) + 1),
        )
  const cols = Math.max(...depth.values()) + 1

  // Merge every leg crossing the same pool between the same two tokens into ONE
  // link. A Sankey's edge IS the pool: three legs that each found their way into
  // WETH through the same UNI V3 pool are one flow of the combined size, and
  // drawing them as three strangers overstates how many places the trade went.
  const links = new Map<string, LinkAcc>()
  // First touch order per token, which becomes the stacking order in its column.
  // Taken from `shown`, so the branch ordering that lib/routeMap works hard to
  // establish — heaviest branch first, each branch contiguous — survives here.
  const firstSeen = new Map<string, number>()
  const through = new Map<string, number>()
  let seq = 0
  let touched = 0
  for (const leg of shown) {
    const entry = leg.hops[0].tokenIn
    if (!firstSeen.has(entry)) firstSeen.set(entry, touched++)
    through.set(entry, (through.get(entry) ?? 0) + leg.shareBps)
    for (const hop of leg.hops) {
      if (!firstSeen.has(hop.tokenOut)) firstSeen.set(hop.tokenOut, touched++)
      through.set(hop.tokenOut, (through.get(hop.tokenOut) ?? 0) + leg.shareBps)
      const fromCol = depth.get(hop.tokenIn) ?? 0
      const toCol = depth.get(hop.tokenOut) ?? fromCol + 1
      const key = `${fromCol}|${toCol}|${hop.pool}|${hop.protocol}`
      const held = links.get(key)
      if (held) {
        held.shareBps += leg.shareBps
        held.legs++
        continue
      }
      links.set(key, {
        protocol: hop.protocol,
        pool: hop.pool,
        feeBps: hopFeeBps(hop),
        shareBps: leg.shareBps,
        legs: 1,
        from: hop.tokenIn,
        to: hop.tokenOut,
        fromCol,
        toCol,
        seq: seq++,
        ...(hop.folded ? { folded: hop.folded } : {}),
      })
    }
  }

  const nodes: SankeyNode[] = [...through.entries()]
    .map(([token, shareBps]) => ({
      token,
      col: depth.get(token) ?? 0,
      order: firstSeen.get(token) ?? 0,
      y0: 0,
      y1: 0,
      shareBps,
      end:
        (depth.get(token) ?? 0) === 0
          ? ('in' as const)
          : (depth.get(token) ?? 0) === cols - 1
            ? ('out' as const)
            : null,
    }))
    .sort((a, b) => a.col - b.col || a.order - b.order)

  const height = HEIGHT
  const byCol = new Map<number, SankeyNode[]>()
  for (const node of nodes) {
    const held = byCol.get(node.col)
    if (held) held.push(node)
    else byCol.set(node.col, [node])
  }
  // One ruler for every column: the tightest column is the one that has to fit,
  // so it sets the pixels-per-bps everyone else is drawn with.
  let scale = Infinity
  for (const column of byCol.values()) {
    const total = column.reduce((sum, node) => sum + node.shareBps, 0)
    if (total <= 0) continue
    const gaps = gapFor(column.length, height) * (column.length - 1)
    const room = height - gaps - column.length * MIN_BAND
    scale = Math.min(scale, Math.max(0, room) / total)
  }
  if (!Number.isFinite(scale)) scale = 0
  for (const column of byCol.values()) stackColumn(column, height, scale)

  const nodeAt = new Map(nodes.map((node) => [`${node.col}:${node.token}`, node]))

  // `seq` rides along only to break ties deterministically; it is stripped on
  // the way out so the shape a caller sees is geometry and nothing else.
  type Placed = SankeyLink & { seq: number }
  const placed: Placed[] = [...links.values()].map((link) => ({ ...link, sy0: 0, sy1: 0, ty0: 0, ty1: 0 }))

  // Where each link meets its nodes. Outgoing links stack down the source node
  // ordered by where they LAND, and incoming links stack down the target node
  // ordered by where they CAME FROM — the standard Sankey rule, and the thing
  // that keeps two flows from needlessly crossing on their way between the same
  // pair of columns.
  const rank = (token: string, col: number) => nodeAt.get(`${col}:${token}`)?.order ?? 0
  const placeEndpoints = () => {
  for (const node of nodes) {
    const span = node.y1 - node.y0
    const out = placed
      .filter((l) => l.fromCol === node.col && l.from === node.token)
      .sort((a, b) => rank(a.to, a.toCol) - rank(b.to, b.toCol) || a.seq - b.seq)
    let y = node.y0
    splitWithFloor(out.map((l) => l.shareBps), span, MIN_BAND).forEach((h, i) => {
      out[i].sy0 = y
      out[i].sy1 = y + h
      y += h
    })
    const inbound = placed
      .filter((l) => l.toCol === node.col && l.to === node.token)
      .sort((a, b) => rank(a.from, a.fromCol) - rank(b.from, b.fromCol) || a.seq - b.seq)
    y = node.y0
    splitWithFloor(inbound.map((l) => l.shareBps), span, MIN_BAND).forEach((h, i) => {
      inbound[i].ty0 = y
      inbound[i].ty1 = y + h
      y += h
    })
  }
  }

  // Settle each column toward the flow feeding it.
  //
  // A stack centred in the canvas puts a 5% waypoint in the middle of the
  // picture while the band reaching it LEAVES the entry node near the bottom —
  // so a thin flow climbs the full height and crosses everything on the way,
  // which is a lot of ink for a leg carrying a twentieth of the trade.
  //
  // The target is the height each inbound link actually departs at, not the
  // centre of the node it departs from: on a skewed route those are nowhere
  // near each other, and an earlier version of this used the node centre and
  // was very nearly a no-op. That is why endpoints are placed first, relaxed
  // against, and then placed again.
  //
  // The shift is per COLUMN, never per node, so the stacking order — which
  // carries the branch grouping lib/routeMap establishes — is untouched. Two
  // passes is enough at the depths a route reaches; this is a relaxation, not a
  // solve, and it is clamped so a column can never leave the canvas.
  for (let pass = 0; pass < 2; pass++) {
    placeEndpoints()
    for (let col = 1; col < cols; col++) {
      const column = byCol.get(col)
      if (!column || column.length === 0) continue
      let weight = 0
      let drift = 0
      for (const node of column) {
        for (const link of placed) {
          if (link.toCol !== col || link.to !== node.token) continue
          drift += link.shareBps * ((link.sy0 + link.sy1) / 2 - (link.ty0 + link.ty1) / 2)
          weight += link.shareBps
        }
      }
      if (weight <= 0) continue
      const top = Math.min(...column.map((n) => n.y0))
      const bottom = Math.max(...column.map((n) => n.y1))
      const shift = Math.max(-top, Math.min(height - bottom, drift / weight))
      for (const node of column) {
        node.y0 += shift
        node.y1 += shift
      }
    }
  }
  placeEndpoints()

  return {
    cols,
    height,
    nodes,
    links: placed
      .sort((a, b) => b.shareBps - a.shareBps || a.seq - b.seq)
      .map(({ seq: _seq, ...link }) => link),
  }
}

/** A band needs about this much height before a name inside it is readable
 *  rather than a smear; the name line is about eleven pixels tall, so under
 *  this the label was taller than the flow it named. */
const LABEL_MIN = 13
/** …and this much before the fee line joins the name. */
const FEE_MIN = 26
/** Room a label claims, measured from the mouth of its band: the name line
 *  straddles the mouth, and the fee line hangs under it. */
const LBL_UP = 6
const LBL_DOWN = 6
const LBL_FEE_UP = 8
const LBL_FEE_DOWN = 16
/** breathing room between two labels — touching is already unreadable */
const LBL_PAD = 1.5

/**
 * Which flows keep their names, and which of those keep a fee line.
 *
 * A label rides the mouth of its band, so two bands leaving the same column a
 * few pixels apart put their names in the same place: on a live WBNB→USDT route
 * "11% PANCAKE V3 / fee 0.05%" printed straight through "6% +18 POOLS" and
 * neither could be read. Names go out first and heaviest flow first, so a flow
 * that finds its room already claimed gives its name up to the tooltip, exactly
 * as a band too thin to hold text does. Fee lines are handed out afterwards, out
 * of whatever is left: a venue without its fee still says where the money went,
 * while a name lost to a collision says nothing at all.
 *
 * Keyed by position in `links`; an index that is absent prints no label, and
 * `true` means the fee line prints under the name.
 */
export function planLabels(links: SankeyLink[]): Map<number, boolean> {
  const plan = new Map<number, boolean>()
  const claims: Array<{ col: number; owner: number; top: number; bottom: number }> = []
  const free = (col: number, top: number, bottom: number, self: number) =>
    claims.every(
      (c) =>
        c.col !== col || c.owner === self || bottom + LBL_PAD <= c.top || top - LBL_PAD >= c.bottom,
    )
  const named = links
    .map((link, i) => ({ link, i, mid: (link.sy0 + link.sy1) / 2 }))
    .filter(({ link }) => link.sy1 - link.sy0 >= LABEL_MIN)
    .sort((a, b) => b.link.shareBps - a.link.shareBps || a.i - b.i)
    .filter(({ link, i, mid }) => {
      if (!free(link.fromCol, mid - LBL_UP, mid + LBL_DOWN, i)) return false
      claims.push({ col: link.fromCol, owner: i, top: mid - LBL_UP, bottom: mid + LBL_DOWN })
      return true
    })
  for (const { link, i, mid } of named) {
    const wants = link.sy1 - link.sy0 >= FEE_MIN && link.feeBps !== null && !link.folded
    const room = wants && free(link.fromCol, mid - LBL_FEE_UP, mid + LBL_FEE_DOWN, i)
    plan.set(i, room)
    const own = claims.find((c) => c.owner === i)
    if (room && own) {
      own.top = mid - LBL_FEE_UP
      own.bottom = mid + LBL_FEE_DOWN
    }
  }
  return plan
}
