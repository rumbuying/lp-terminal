import assert from 'node:assert/strict'
import test from 'node:test'
import { planLabels, routeSankey, type SankeyLayout, type SankeyLink } from './routeSankey'
import type { SolverHop, SolverLeg } from './solver'

// addresses/shares below are verbatim from live solver.lp-terminal.xyz quotes
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const UP = '0x57c0e45cb534413d1c20a4240955d6bb250bb4f1'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const CASH = '0x3a5c4e2f9c1b8d7e6a0f2b3c4d5e6f7a8b9c0d1e'

const hop = (
  protocol: string,
  pool: string,
  tokenIn: string,
  tokenOut: string,
  feePpm = 10_000,
): SolverHop => ({ protocol, pool, tokenIn, tokenOut, feePpm })
const leg = (shareBps: number, ...hops: SolverHop[]): SolverLeg => ({
  shareBps,
  amountIn: 0n,
  amountOut: 0n,
  hops,
})

const ok = (layout: SankeyLayout | null): SankeyLayout => {
  assert.ok(layout, 'expected a drawable layout')
  return layout
}
const near = (a: number, b: number, tol = 0.001) =>
  assert.ok(Math.abs(a - b) < tol, `${a} is not within ${tol} of ${b}`)

test('nothing drawable', () => {
  assert.equal(routeSankey([]), null)
  assert.equal(routeSankey([leg(10_000)]), null)
})

test('refuses anything that is not a simple path', () => {
  const good = leg(5000, hop('up33cl', '0xa', WETH, UP))
  const cases = [
    leg(5000, { protocol: 'univ3', pool: '0xb', tokenIn: '', tokenOut: '' }),
    leg(5000, hop('univ3', '0xb', WETH, WETH)),
    leg(5000, hop('univ3', '0xb', WETH, UP), hop('univ3', '0xc', UP, WETH)),
  ]
  for (const bad of cases) {
    assert.equal(routeSankey([bad]), null)
    assert.equal(routeSankey([good, bad]), null, 'one bad leg voids the whole map')
  }
  assert.ok(routeSankey([good]))
})

test('a two-hop path is three nodes in three columns and two links', () => {
  const layout = ok(
    routeSankey([leg(10_000, hop('up33cl', '0xa', CASH, WETH), hop('univ3', '0xb', WETH, USDG))]),
  )
  assert.equal(layout.cols, 3)
  assert.deepEqual(
    layout.nodes.map((n) => [n.token, n.col, n.end]),
    [
      [CASH, 0, 'in'],
      [WETH, 1, null],
      [USDG, 2, 'out'],
    ],
  )
  assert.equal(layout.links.length, 2)
  // the waypoint hands on everything it received: the link out of WETH leaves
  // exactly where the link into WETH arrived
  const [into, outOf] = [
    layout.links.find((l) => l.to === WETH)!,
    layout.links.find((l) => l.from === WETH)!,
  ]
  near(into.ty0, outOf.sy0)
  near(into.ty1, outOf.sy1)
})

test('every node conserves: its links meet it edge to edge, filling it exactly', () => {
  const layout = ok(
    routeSankey([
      leg(6300, hop('univ3', '0xa', USDG, WETH), hop('up33cl', '0xb', WETH, CASH)),
      leg(2100, hop('univ3', '0xa', USDG, WETH), hop('up33v2', '0xc', WETH, CASH)),
      leg(1600, hop('univ3', '0xa', USDG, WETH), hop('univ3', '0xd', WETH, CASH)),
    ]),
  )
  for (const node of layout.nodes) {
    for (const side of ['out', 'in'] as const) {
      const links = layout.links.filter((l) =>
        side === 'out' ? l.from === node.token && l.fromCol === node.col : l.to === node.token && l.toCol === node.col,
      )
      if (links.length === 0) continue
      const edges = links
        .map((l) => (side === 'out' ? [l.sy0, l.sy1] : [l.ty0, l.ty1]))
        .sort((a, b) => a[0] - b[0])
      near(edges[0][0], node.y0)
      near(edges[edges.length - 1][1], node.y1)
      // contiguous: no gaps and no overlaps between neighbours
      for (let i = 1; i < edges.length; i++) near(edges[i][0], edges[i - 1][1])
    }
  }
})

test('legs through one pool are ONE link, sized by their combined share', () => {
  const layout = ok(
    routeSankey([
      leg(6000, hop('univ3', '0xentry', USDG, WETH), hop('up33cl', '0xb', WETH, CASH)),
      leg(4000, hop('univ3', '0xentry', USDG, WETH), hop('up33v2', '0xc', WETH, CASH)),
    ]),
  )
  const entry = layout.links.filter((l) => l.pool === '0xentry')
  assert.equal(entry.length, 1, 'one pool, one flow')
  assert.equal(entry[0].shareBps, 10_000)
  assert.equal(entry[0].legs, 2)
  // and it is the full height of both nodes it joins, being the only way across
  const usdg = layout.nodes.find((n) => n.token === USDG)!
  near(entry[0].sy1 - entry[0].sy0, usdg.y1 - usdg.y0)
})

test('a direct leg beside a two-hop leg spans the waypoint column', () => {
  const layout = ok(
    routeSankey([
      leg(5800, hop('univ3', '0xa', USDG, WETH), hop('up33cl', '0xb', WETH, CASH)),
      leg(4200, hop('up33v2', '0xc', USDG, CASH)),
    ]),
  )
  const direct = layout.links.find((l) => l.pool === '0xc')!
  assert.equal(direct.fromCol, 0)
  assert.equal(direct.toCol, 2, 'it passes behind the WETH column rather than through it')
  assert.equal(layout.cols, 3)
})

test('thickness is the share, and a bigger leg is drawn bigger', () => {
  const layout = ok(
    routeSankey([
      leg(7100, hop('up33cl', '0xa', WETH, CASH)),
      leg(1700, hop('univ3', '0xb', WETH, CASH)),
      leg(1200, hop('up33v2', '0xc', WETH, CASH)),
    ]),
  )
  const thickness = (pool: string) => {
    const l = layout.links.find((x) => x.pool === pool)!
    return l.sy1 - l.sy0
  }
  assert.ok(thickness('0xa') > thickness('0xb'), '71% draws thicker than 17%')
  assert.ok(thickness('0xb') > thickness('0xc'), '17% draws thicker than 12%')
  // the three of them are the whole trade, so they fill the entry node exactly
  const entry = layout.nodes.find((n) => n.end === 'in')!
  near(thickness('0xa') + thickness('0xb') + thickness('0xc'), entry.y1 - entry.y0)
})

test('nothing is drawn outside the canvas the layout asked for', () => {
  const wide = Array.from({ length: 9 }, (_, i) =>
    leg(
      i === 0 ? 9200 : 100,
      hop(i % 2 ? 'univ3' : 'up33cl', `0x${String(i).repeat(6)}`, WETH, CASH),
    ),
  )
  for (const route of [wide, [leg(10_000, hop('up33cl', '0xa', WETH, CASH))]]) {
    const layout = ok(routeSankey(route))
    for (const node of layout.nodes) {
      assert.ok(node.y0 >= -0.001 && node.y1 <= layout.height + 0.001, 'node inside the canvas')
      assert.ok(node.y1 > node.y0, 'node has height')
    }
    for (const link of layout.links)
      for (const y of [link.sy0, link.sy1, link.ty0, link.ty1])
        assert.ok(y >= -0.001 && y <= layout.height + 0.001, `link edge ${y} inside the canvas`)
  }
})

// The panel around the map is what pays for a height that moves: the same quote
// refreshed on a timer can go from four parallel flows to nine and back, and a
// route map that resizes under the pointer costs more than the pixels it saves.
test('every route is drawn at the same height', () => {
  const spread = (n: number) =>
    ok(
      routeSankey(
        Array.from({ length: n }, (_, i) =>
          leg(Math.round(10_000 / n), hop('up33cl', `0x${String(i).repeat(6)}`, WETH, CASH)),
        ),
      ),
    ).height
  const twoHop = ok(
    routeSankey([leg(10_000, hop('up33cl', '0xa', WETH, USDG), hop('univ3', '0xb', USDG, CASH))]),
  ).height
  assert.deepEqual([spread(1), spread(6), spread(30), spread(70), twoHop], Array(5).fill(spread(1)))
})

test('fees: ppm from CL pools, bps from v2 pools, null when absent', () => {
  const layout = ok(
    routeSankey([
      leg(5000, hop('up33cl', '0xa', WETH, UP, 10_000)),
      leg(3000, { protocol: 'up33v2', pool: '0xb', tokenIn: WETH, tokenOut: UP, feeBps: 30 }),
      leg(2000, { protocol: 'mystery', pool: '0xc', tokenIn: WETH, tokenOut: UP }),
    ]),
  )
  const feeOf = (pool: string) => layout.links.find((l) => l.pool === pool)!.feeBps
  assert.equal(feeOf('0xa'), 100)
  assert.equal(feeOf('0xb'), 30)
  assert.equal(feeOf('0xc'), null)
})

// nothing is ever left out: a path the trade takes belongs on the picture of
// where the trade goes, however thin it is
test('a crowded route draws every leg, and none of them rounds to nothing', () => {
  const tiny = [9_500, 100, 100, 100, 100, 50, 50]
  const layout = ok(
    routeSankey(tiny.map((share, i) => leg(share, hop('univ3', `0x${i}`, WETH, UP)))),
  )
  assert.equal(layout.links.length, tiny.length, 'every leg is drawn')
  assert.ok(
    layout.links.every((l) => l.sy1 - l.sy0 >= 2.9),
    'no leg is thinner than the visible floor',
  )
  const many = Array.from({ length: 14 }, (_, i) =>
    leg(10_000 / 14, hop('univ3', `0x${i}`, WETH, UP)),
  )
  assert.equal(ok(routeSankey(many)).links.length, 14)
})

// A sliver tail used to be gathered into one summary band. It is drawn now: a
// leg carrying three tenths of a percent is a hairline at three tenths of a
// percent, and a reader who wants to know what it is can point at it.
test('a sliver tail is drawn leg by leg, and stays on a whole pixel', () => {
  const route = [
    leg(3500, hop('pancakev3', '0xbig', WETH, UP)),
    ...Array.from({ length: 40 }, (_, i) => leg(160, hop('univ2', `0xd${i}`, WETH, UP))),
    ...Array.from({ length: 4 }, (_, i) => leg(20, hop('univ3', `0xt${i}`, WETH, UP))),
  ]
  const layout = ok(routeSankey(route))
  assert.equal(layout.links.length, route.length, 'no leg was gathered into another')
  assert.ok(
    layout.links.every((l) => l.protocol !== 'slivers'),
    'no band stands for legs it did not name',
  )
  assert.ok(
    layout.links.every((l) => l.sy1 - l.sy0 >= 1),
    'the thinnest leg still lands on a whole pixel',
  )
})

// The floor keeps the tail visible, and past a few dozen bands it would start
// paying for that out of everyone else's height instead.
test('thickness stays proportional however many legs there are', () => {
  const route = [
    leg(4000, hop('pancakev3', '0xbig', WETH, UP)),
    leg(2000, hop('univ3', '0xmid', WETH, UP)),
    ...Array.from({ length: 40 }, (_, i) => leg(100, hop('univ2', `0xd${i}`, WETH, UP))),
  ]
  const layout = ok(routeSankey(route))
  const thick = (pool: string) => {
    const held = layout.links.find((l) => l.pool === pool)!
    return held.sy1 - held.sy0
  }
  // 40% against 20%: within a tenth of twice the height, floors and all
  assert.ok(
    Math.abs(thick('0xbig') / thick('0xmid') - 2) < 0.1,
    `${thick('0xbig')} / ${thick('0xmid')} should be about 2`,
  )
  // and it keeps at least four fifths of the height its share alone would buy,
  // so forty hairlines never crowd the flow a reader is actually looking at
  const owed = layout.height * 0.4
  assert.ok(thick('0xbig') >= owed * 0.8, `${thick('0xbig')} of the ${owed} its share buys`)
})

// The live WETH->CASHCAT shape that exposed it: legs ordered by their own share
// put a 2.7% leg running THROUGH USDG between the 12% and 2% legs that go
// straight across, so a direct hop looked like it passed through USDG. The
// Sankey inherits lib/routeMap's branch ordering, so it inherits the guarantee.
test('paths of different shapes never interleave', () => {
  const CC = '0x020bfc650a365f8bb26819deaabf3e21291018b4'
  const layout = ok(
    routeSankey([
      leg(2100, hop('swaphoodv3', '0xsw', WETH, USDG, 500), hop('univ4', '0xa92a', USDG, CC, 2690)),
      leg(2000, hop('univ4', '0x3ddd', WETH, CC, 2690)),
      leg(1100, hop('up33cl', '0xup', WETH, USDG, 10_000), hop('univ4', '0xa92a', USDG, CC, 2690)),
      leg(1100, hop('gigadexv3', '0x8607', WETH, CC, 2000)),
      leg(1100, hop('univ3', '0xd42a', WETH, CC, 3000)),
      leg(700, hop('univ4', '0xu4', WETH, USDG, 2690), hop('univ4', '0xa92a', USDG, CC, 2690)),
      leg(500, hop('gigadexv3', '0xg2', WETH, USDG, 2000), hop('univ4', '0xa92a', USDG, CC, 2690)),
      leg(200, hop('univ4', '0xu4b', WETH, CC, 2690)),
      leg(1200, hop('univ4', '0xu4', WETH, USDG, 2690), hop('up33cl', '0xccl', USDG, CC, 10_000)),
    ]),
  )
  // Everything leaving the entry token, in the order it leaves.
  const leaving = layout.links
    .filter((l) => l.fromCol === 0)
    .sort((a, b) => a.sy0 - b.sy0)
  const through = leaving.filter((l) => l.to === USDG)
  const direct = leaving.filter((l) => l.to === CC)
  assert.ok(through.length > 1 && direct.length > 1, 'the fixture has to mix both shapes')
  // through-USDG is the heavier branch, so it leaves the node first and whole:
  // no direct leg is allowed to sit between two legs that reach USDG
  const lastThrough = leaving.lastIndexOf(through[through.length - 1])
  const firstDirect = leaving.indexOf(direct[0])
  assert.ok(firstDirect > lastThrough, 'a direct leg landed inside the through-USDG block')
  // and the two legs sharing the univ4 entry pool merged rather than being
  // separated by an unrelated venue
  assert.ok(
    through.some((l) => l.legs === 2 && l.protocol === 'univ4'),
    'same-pool legs inside a block still merge',
  )
})

// The one band left that stands for more than itself. A leg crossing two
// gathered waypoints back to back cannot keep both: the renamed path would
// visit the collective node twice, which is no longer a path.
test('a leg through two gathered waypoints draws as one collective band', () => {
  const A = '0xa11ce00000000000000000000000000000000001'
  const B = '0xb0b0000000000000000000000000000000000002'
  const C = '0xc0c0000000000000000000000000000000000003'
  const layout = ok(
    routeSankey([
      leg(4000, hop('up33cl', '0xi1', WETH, USDG), hop('univ3', '0xo1', USDG, UP)),
      leg(3000, hop('up33cl', '0xi2', WETH, CASH), hop('univ3', '0xo2', CASH, UP)),
      leg(2880, hop('up33cl', '0xi3', WETH, A), hop('univ3', '0xo3', A, UP)),
      // B and C are both outside the heaviest three, and this leg crosses them
      // one after the other
      leg(120, hop('univ3', '0xa', WETH, B), hop('univ2', '0xb', B, C), hop('univ3', '0xc', C, UP)),
    ]),
  )
  const bands = layout.links.filter((l) => l.folded)
  assert.equal(bands.length, 2, 'one band per hop of the collapsed path')
  assert.ok(
    bands.every((l) => l.protocol === 'slivers' && l.feeBps === null),
    'a collective band names no single pool and charges no single fee',
  )
  // thickness still means share: 1.2% of the trade, well under the 40% leg
  const widest = Math.max(...layout.links.map((l) => l.sy1 - l.sy0))
  assert.ok(bands.every((l) => l.sy1 - l.sy0 < widest / 10))
  // every OTHER leg kept the pool it crossed
  assert.ok(layout.links.some((l) => l.pool === '0xi3' && !l.folded))
})

// Normalising each column against its own total would draw this waypoint at
// full height, because it is the only node in its column — and a token 42% of
// the trade never touches would then look like the road everything took.
test('a waypoint only part of the trade uses is drawn short', () => {
  const layout = ok(
    routeSankey([
      leg(5800, hop('univ3', '0xa', USDG, WETH), hop('up33cl', '0xb', WETH, CASH)),
      leg(4200, hop('up33v2', '0xc', USDG, CASH)),
    ]),
  )
  const entry = layout.nodes.find((n) => n.end === 'in')!
  const waypoint = layout.nodes.find((n) => n.token === WETH)!
  const tall = entry.y1 - entry.y0
  const short = waypoint.y1 - waypoint.y0
  assert.ok(short < tall * 0.75, `waypoint ${short} should be well under the entry's ${tall}`)
  // and it is short in PROPORTION: 58% of the trade, so ~58% of the bar
  assert.ok(Math.abs(short / tall - 0.58) < 0.08, `${short / tall} is not about 0.58`)
  // and it sits where its inflow actually arrives rather than in the middle of
  // the canvas — otherwise the band feeding it climbs the whole picture
  const feed = layout.links.find((l) => l.to === WETH)!
  const feedMid = (feed.sy0 + feed.sy1) / 2
  const nodeMid = (waypoint.y0 + waypoint.y1) / 2
  assert.ok(
    Math.abs(feedMid - nodeMid) < 2,
    `waypoint centre ${nodeMid} should meet its inflow at ${feedMid}`,
  )
})

/** a band leaving column 0 at [sy0, sy1) — the only geometry a label reads */
const band = (shareBps: number, sy0: number, sy1: number, over: Partial<SankeyLink> = {}): SankeyLink => ({
  protocol: 'pancakev3',
  pool: '0xp',
  feeBps: 5,
  shareBps,
  legs: 1,
  from: WETH,
  to: UP,
  fromCol: 0,
  toCol: 1,
  sy0,
  sy1,
  ty0: sy0,
  ty1: sy1,
  ...over,
})
/** the box a printed label occupies, as RouteMap draws it */
const labelBox = (link: SankeyLink, fee: boolean): [number, number, number] => {
  const mid = (link.sy0 + link.sy1) / 2
  return [link.fromCol, fee ? mid - 8 : mid - 6, fee ? mid + 16 : mid + 6]
}
const noOverlap = (links: SankeyLink[], plan: Map<number, boolean>) => {
  const boxes = [...plan.entries()].map(([i, fee]) => labelBox(links[i], fee))
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++)
      assert.ok(
        boxes[a][0] !== boxes[b][0] || boxes[a][1] >= boxes[b][2] || boxes[b][1] >= boxes[a][2],
        `labels ${a} ${JSON.stringify(boxes[a])} and ${b} ${JSON.stringify(boxes[b])} overlap`,
      )
}

test('two names that would print through each other: the heavier one keeps it', () => {
  // both bands clear the height a name needs, and their mouths are 13px apart —
  // one line of type is twelve
  const links = [band(1000, 13, 26), band(2000, 0, 13)]
  const plan = planLabels(links)
  assert.deepEqual([...plan.keys()], [1], 'the 20% flow is named, the 10% flow is not')
  noOverlap(links, plan)

  // the same two bands leaving DIFFERENT columns never contend: they are drawn
  // a whole column apart, and only the vertical was ever in question
  const apart = [band(1000, 13, 26, { fromCol: 1 }), band(2000, 0, 13)]
  assert.equal(planLabels(apart).size, 2)
})

test('a fee line is given up before a name is', () => {
  // the live WBNB→USDT collision: a 30px band's fee line reached down into the
  // mouth of the 14px band under it, and "11% PANCAKE V3 / fee 0.05%" printed
  // straight through "6% +18 POOLS"
  const links = [band(3000, 0, 30), band(1400, 30, 44)]
  const plan = planLabels(links)
  assert.deepEqual([...plan.entries()].sort(), [[0, false], [1, false]], 'both names print, neither fee does')
  noOverlap(links, plan)

  // given the room, the fat band keeps its fee
  const roomy = [band(3000, 0, 30), band(1400, 60, 74)]
  assert.deepEqual([...planLabels(roomy).entries()].sort(), [[0, true], [1, false]])
})

test('a band with no room for type hands its name to the tooltip', () => {
  // under thirteen pixels there is nowhere to put a line of text
  assert.equal(planLabels([band(4000, 0, 12.9)]).size, 0)
  assert.equal(planLabels([band(4000, 0, 13)]).size, 1)
  // a fee line wants twice that, and a collective band has no single fee to name
  assert.equal(planLabels([band(4000, 0, 25.9)]).get(0), false)
  assert.equal(planLabels([band(4000, 0, 26)]).get(0), true)
  assert.equal(planLabels([band(4000, 0, 40, { feeBps: null })]).get(0), false)
  assert.equal(planLabels([band(4000, 0, 40, { folded: 12 })]).get(0), false)
})

test('every flow label on a real route clears every other', () => {
  const route = [
    leg(3550, hop('pancakev3', '0xa', WETH, UP)),
    leg(1330, hop('univ3', '0xb', WETH, UP)),
    leg(1190, hop('pancakev3', '0xc', WETH, USDG), hop('pancakev3', '0xd', USDG, UP)),
    leg(840, hop('pancakev3', '0xe', WETH, USDG), hop('pancakev3', '0xf', USDG, UP)),
    leg(810, hop('pancakev3', '0xg', WETH, UP)),
    leg(720, hop('univ2', '0xh', WETH, UP)),
    leg(530, hop('univ3', '0xi', WETH, USDG), hop('univ3', '0xj', USDG, UP)),
    leg(490, hop('sushiv3', '0xk', WETH, USDG), hop('sushiv3', '0xl', USDG, UP)),
    leg(380, hop('up33cl', '0xm', WETH, UP)),
    leg(160, hop('up33v2', '0xn', WETH, UP)),
  ]
  const layout = ok(routeSankey(route))
  const plan = planLabels(layout.links)
  assert.ok(plan.size >= 6, `only ${plan.size} of ${layout.links.length} flows kept a name`)
  noOverlap(layout.links, plan)
  // and the flows that keep their names are the ones worth naming
  const named = [...plan.keys()].map((i) => layout.links[i].shareBps)
  const mute = layout.links.map((l, i) => (plan.has(i) ? 0 : l.shareBps))
  assert.ok(Math.min(...named) >= Math.max(...mute), 'a named flow is never smaller than a mute one')
})

test('the same quote draws the same picture', () => {
  const route = [
    leg(6300, hop('univ3', '0xa', USDG, WETH), hop('up33cl', '0xb', WETH, CASH)),
    leg(2100, hop('univ3', '0xa', USDG, WETH), hop('up33v2', '0xc', WETH, CASH)),
    leg(1600, hop('up33v2', '0xd', USDG, CASH)),
  ]
  assert.deepEqual(routeSankey(route), routeSankey(route.slice()))
})
