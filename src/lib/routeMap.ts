/**
 * What the SHEEP CHOICE route map MEANS, as opposed to where it draws.
 *
 * Odos's order-route plan is the model: token nodes, flows between them whose
 * thickness is the share of the trade taking that path, and shared intermediate
 * tokens drawn as ONE node so a split that reconverges reads as a single shape
 * rather than as parallel strangers.
 *
 * The questions answered here are the ones that stay true whatever shape the
 * picture takes — which tokens the map will name, what order branches read in,
 * what fee a hop charges, what colour a venue owns. Geometry lives next door in
 * lib/routeSankey and consumes all of it; keeping the two apart is what let the
 * drawing change from a stacked grid to a Sankey without re-deciding any of
 * this.
 *
 * Legs are never folded together. A sliver carrying three tenths of a percent
 * is drawn three tenths of a percent thick and keeps the pool it crossed —
 * thickness is what the picture is for, and a hairline a reader can point at
 * beats a summary band they have to take on trust.
 *
 * One thing Odos does that this cannot: key eight venues by hue and print a
 * legend. Hue is spoken for here — green, red and amber mean up, down and warn
 * in every theme, and MONO has no hue at all — so venue identity is carried by
 * text written onto the flow, and colour only reinforces it.
 */
import type { SolverHop, SolverLeg } from './solver'

/**
 * Waypoints the map will name.
 *
 * A leg can be thin and still be worth drawing; a NODE cannot, because a node
 * costs a name tag whatever it carries. A live WBNB→USDT quote reached the
 * output through seven different tokens, the last two carrying 1.0% and 0.3%,
 * and each got a chip — so the middle of the picture became a column of seven
 * labels printed over the flows they were supposed to be labelling. A menu,
 * not a diagram.
 *
 * The heaviest few keep their identity. The rest become ONE node that says how
 * many it stands for, which is the honest summary: the shares still sum, the
 * flows still go somewhere real and keep their own pools, and the picture stops
 * claiming that a token carrying three tenths of a percent is a landmark.
 *
 * Rank alone was not enough. Measured across five live BSC routes the shares
 * past the first waypoint fall away fast — 19%, 4.0%, 1.9%, 1.2%, 0.8%, 0.3% on
 * one of them — so "top three" kept naming tokens at 1.9% and 2.4%, whose bars
 * are the 3px minimum and sit touching each other. Their tags cannot both fit
 * beside a 3px bar, so they get pushed apart into a vertical stack of four
 * pills in the middle of the map: a legend box drawn over the flows. A waypoint
 * therefore also has to be big enough to be a landmark, which is where the
 * conventional "gather anything under a few percent into Other" lands.
 *
 * The heaviest waypoint is exempt: a route's main road is a landmark at any
 * width, and a map whose every waypoint is a count says less than one that
 * names the road.
 */
const MAX_WAYPOINTS = 3
const MIN_WAYPOINT_BPS = 300 // 3%
const FOLDED_TOKEN_PREFIX = 'others:'

/** the collective waypoint's id carries its count, so the drawing can name it
 *  without being handed the fold's bookkeeping separately */
export function foldedTokenCount(token: string): number | null {
  if (!token.startsWith(FOLDED_TOKEN_PREFIX)) return null
  const n = Number(token.slice(FOLDED_TOKEN_PREFIX.length))
  return Number.isInteger(n) && n > 0 ? n : null
}

/** a hop's fee in bps — v3 pools quote parts-per-million, v2 pools quote bps */
export function hopFeeBps(hop: SolverHop): number | null {
  if (hop.feePpm !== undefined) return hop.feePpm / 100
  return hop.feeBps ?? null
}

/**
 * Venue colour, as an `r, g, b` triple for rgba().
 *
 * Odos keys its DEXes by hue and prints a legend to decode it. Here the name is
 * already written into the ribbon, so hue is REINFORCEMENT rather than the only
 * key — which is what makes it safe on a palette where green, red and amber
 * already mean up, down and warn. The list dodges those three where it counts:
 * the venues in almost every route take cyan, violet and blue, nothing is a
 * semantic red, and the two that do lean warm (gigadex orange, sheriff gold)
 * are rare enough never to sit next to a loss figure and be misread.
 *
 * Assignments are per protocol, not per position, so a venue keeps its colour
 * as the split moves between quotes — the thing you learn to recognise.
 */
const VENUE_RGB: Record<string, string> = {
  up33cl: '86, 210, 224', // teal — the house CL pools
  up33v2: '166, 140, 255', // violet
  univ3: '96, 152, 255', // blue
  univ2: '232, 124, 200', // magenta
  univ4: '124, 200, 255', // ice
  pancakev3: '104, 214, 168', // jade
  // the v2 sibling, same family a shade deeper — on BSC these two are the
  // route's two busiest venues and were never meant to be told apart by hue
  // alone, but a hash-picked spare put a lone violet band between two greens
  pancakev2: '76, 170, 142',
  sushiv3: '255, 136, 178', // sushi pink
  swaphoodv3: '196, 235, 74', // robinhood neon
  gigadexv3: '255, 168, 96', // orange
  robinswapv3: '156, 226, 110', // lime
  sheriff: '230, 196, 96', // gold
  ekubov3: '74, 188, 208', // ocean
  slivers: '152, 162, 174', // slate — the collective band stays visually quiet
}
// a venue we have never seen still needs to differ from its neighbours, and to
// pick the SAME colour every render — hash the id rather than count arrivals
const SPARE_RGB = ['150, 200, 220', '206, 168, 230', '176, 208, 150', '224, 186, 150']

export function venueRgb(protocol: string): string {
  const known = VENUE_RGB[protocol]
  if (known) return known
  let hash = 0
  for (let i = 0; i < protocol.length; i++) hash = (hash * 31 + protocol.charCodeAt(i)) % 4096
  return SPARE_RGB[hash % SPARE_RGB.length]
}

/**
 * Does this leg trace a simple path — every hop naming two real tokens, no
 * token visited twice? A solver that predates the per-hop token fields sends
 * empty strings, which would collapse every node onto one token and leave the
 * depth relaxation below climbing forever; a cycle would do the same. Neither
 * can come out of the router, but both can come out of a version mismatch.
 */
export function tracesAPath(leg: SolverLeg): boolean {
  const seen = new Set([leg.hops[0].tokenIn])
  for (const hop of leg.hops) {
    if (!hop.tokenIn || !hop.tokenOut || seen.has(hop.tokenOut)) return false
    seen.add(hop.tokenOut)
  }
  return true
}

/**
 * Every prefix of a leg's path, coarsest first, at two grains: which TOKENS it
 * has reached, and which POOLS it took to get there. The two are separate keys
 * because they answer different questions — the token path is the SHAPE a reader
 * has to be able to trust ("does this go through USDG or not"), the pool path is
 * only which door it used.
 */
type PathStep = { token: string; pool: string }

function pathSteps(leg: SolverLeg): PathStep[] {
  const steps: PathStep[] = []
  let token = leg.hops[0].tokenIn
  let pool = leg.hops[0].tokenIn
  for (const hop of leg.hops) {
    token += `>${hop.tokenOut}`
    pool += `>${hop.pool}>${hop.tokenOut}`
    steps.push({ token, pool })
  }
  return steps
}

/**
 * Band order: depth-first through the route, taking the heaviest branch first.
 *
 * Ordering legs by their own share alone is what a stacked bar would do, and it
 * INTERLEAVES paths of different shapes: on a live WETH→CASHCAT quote a 2.7% leg
 * running through USDG landed between the 12% and 2% legs that go straight
 * across, so a direct hop appeared to pass through USDG, and its label ran under
 * the wall of a token it never touched. Both readings are wrong, and the second
 * is worse than wrong because it looks fine.
 *
 * Sorting on path prefixes instead — each ranked by the total share flowing
 * through it — makes every branch a contiguous block: everything that reaches
 * USDG sits together, and direct legs are simply the block that reaches the
 * output in one hop, so the two can never be mixed. Blocks stay heaviest-first,
 * so the map still reads top-down by size.
 *
 * TOKEN before pool, and that ordering is the whole fix. Keying on the pool path
 * alone looked right and did nothing: thirteen legs through thirteen different
 * pools are thirteen groups of one, which is just share order again. Grouping on
 * the token reached, and only then on the pool used to reach it, gives both — a
 * shape a reader can trust, and same-pool legs adjacent so they still merge.
 */
export function orderLegs(legs: SolverLeg[]): SolverLeg[] {
  const byToken = new Map<string, number>()
  const byPool = new Map<string, number>()
  for (const leg of legs)
    for (const step of pathSteps(leg)) {
      byToken.set(step.token, (byToken.get(step.token) ?? 0) + leg.shareBps)
      byPool.set(step.pool, (byPool.get(step.pool) ?? 0) + leg.shareBps)
    }
  // heaviest branch first; equal weights fall back to the key and then to
  // arrival order, so the same quote always draws the same picture
  const rank = (weight: Map<string, number>, x: string, y: string) =>
    (weight.get(y) ?? 0) - (weight.get(x) ?? 0) || (x < y ? -1 : 1)

  const keyed = legs.map((leg, index) => ({ leg, index, steps: pathSteps(leg) }))
  keyed.sort((a, b) => {
    const depth = Math.min(a.steps.length, b.steps.length)
    for (let i = 0; i < depth; i++) {
      const [x, y] = [a.steps[i], b.steps[i]]
      if (x.token !== y.token) return rank(byToken, x.token, y.token)
      if (x.pool !== y.pool) return rank(byPool, x.pool, y.pool)
    }
    // one path is a prefix of the other: the shorter one leaves the branch first
    return a.steps.length - b.steps.length || a.index - b.index
  })
  return keyed.map((entry) => entry.leg)
}

/**
 * Fold every waypoint past the heaviest few into one collective node.
 *
 * Runs BEFORE the sliver fold and makes it more effective: legs that took seven
 * different tokens are seven path shapes and fold into seven bands, while the
 * same legs rewritten through one collective token are one shape and fold into
 * one. That is the whole reason the order matters.
 *
 * A leg keeps its own pools whenever its path survives the rename intact, which
 * is nearly always: renaming a waypoint costs a leg nothing it was carrying, and
 * a leg at 4% through the fourth-heaviest token still deserves its venue name.
 * Volume is the sliver fold's job, and the rename is what lets it do that job in
 * one band instead of one per token.
 *
 * The exception is two folded tokens sitting next to each other: the renamed
 * path would then visit the collective node twice, which is no longer a path.
 * Those legs give up their pool identity to a collective band — the same trade
 * the sliver fold makes, for the same reason.
 */
export function condenseWaypoints(route: SolverLeg[]): SolverLeg[] {
  const through = new Map<string, number>()
  for (const leg of route)
    for (const hop of leg.hops.slice(0, -1))
      through.set(hop.tokenOut, (through.get(hop.tokenOut) ?? 0) + leg.shareBps)
  const keep = new Set(
    [...through.entries()]
      // heaviest first; the address breaks a tie so the same quote folds the
      // same way every render
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .filter(([, bps], rank) => rank < MAX_WAYPOINTS && (rank === 0 || bps >= MIN_WAYPOINT_BPS))
      .map(([token]) => token),
  )
  if (keep.size === through.size) return route
  const collective = `${FOLDED_TOKEN_PREFIX}${through.size - keep.size}`
  const rename = (token: string) =>
    through.has(token) && !keep.has(token) ? collective : token

  const kept: SolverLeg[] = []
  const shrunk = new Map<string, SolverLeg[]>()
  for (const leg of route) {
    const path = renamedPath(leg, rename)
    if (path.length - 1 === leg.hops.length) {
      kept.push({
        ...leg,
        hops: leg.hops.map((hop, i) => ({ ...hop, tokenIn: path[i], tokenOut: path[i + 1] })),
      })
      continue
    }
    const key = path.join('>')
    const held = shrunk.get(key)
    if (held) held.push(leg)
    else shrunk.set(key, [leg])
  }

  for (const [key, grouped] of shrunk) {
    const path = key.split('>')
    kept.push({
      shareBps: grouped.reduce((sum, leg) => sum + leg.shareBps, 0),
      amountIn: grouped.reduce((sum, leg) => sum + leg.amountIn, 0n),
      amountOut: grouped.reduce((sum, leg) => sum + leg.amountOut, 0n),
      hops: path.slice(1).map((tokenOut, i) => ({
        protocol: 'slivers',
        pool: `waypoints:${i}:${key}`,
        tokenIn: path[i],
        tokenOut,
        // a band stands for the legs behind it, or — where there is only one —
        // for the pools that one leg crossed, so the count is never "+1"
        folded: grouped.length > 1 ? grouped.length : grouped[0].hops.length,
      })),
    })
  }
  return kept
}

/** A leg's token path with folded waypoints renamed, and a doubled collective
 *  node collapsed — entry→A→B→out with both A and B folded would otherwise
 *  visit the collective token twice, and a path that revisits a token is not
 *  one the map will draw. */
function renamedPath(leg: SolverLeg, rename: (token: string) => string): string[] {
  const path = [leg.hops[0].tokenIn, ...leg.hops.map((hop) => rename(hop.tokenOut))]
  return path.filter((token, i) => i === 0 || token !== path[i - 1])
}


