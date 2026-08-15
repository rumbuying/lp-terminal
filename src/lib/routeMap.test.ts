import assert from 'node:assert/strict'
import test from 'node:test'
import { condenseWaypoints, foldedTokenCount, venueRgb } from './routeMap'
import type { SolverHop, SolverLeg } from './solver'

// addresses/shares below are verbatim from live solver.lp-terminal.xyz quotes
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const UP = '0x57c0e45cb534413d1c20a4240955d6bb250bb4f1'
// the seven waypoints a live WBNB→USDT quote reached the output through
const BTCB = '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c'
const USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
const USD1 = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d'
const ETH = '0x2170ed0880ac9a755fd29b2688956bd959f933f8'
const U = '0xa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82'
const XRP = '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe'

const hop = (protocol: string, pool: string, tokenIn: string, tokenOut: string, feePpm = 10_000): SolverHop => ({
  protocol,
  pool,
  tokenIn,
  tokenOut,
  feePpm,
})
const leg = (shareBps: number, ...hops: SolverHop[]): SolverLeg => ({
  shareBps,
  amountIn: 0n,
  amountOut: 0n,
  hops,
})

test('venue colours are stable, distinct, and defined for every routed protocol', () => {
  // every protocol the solver can name (lib/solver VENUES) must be hand-assigned:
  // a hashed fallback could collide with the venue right beside it
  const routed = [
    'univ2',
    'univ3',
    'univ4',
    'up33cl',
    'up33v2',
    'pancakev3',
    'swaphoodv3',
    'gigadexv3',
    'sushiv3',
    'robinswapv3',
    'sheriff',
    'ekubov3',
  ]
  const colours = routed.map(venueRgb)
  assert.equal(new Set(colours).size, routed.length, 'no two routed venues share a colour')
  for (const rgb of colours) assert.match(rgb, /^\d{1,3}, \d{1,3}, \d{1,3}$/)
  // an unknown venue still resolves, and to the same colour every time
  assert.equal(venueRgb('brandnewdex'), venueRgb('brandnewdex'))
  assert.match(venueRgb('brandnewdex'), /^\d{1,3}, \d{1,3}, \d{1,3}$/)
})

// the two-hop legs of a WBNB→USDT-shaped route, one per waypoint
const via = (token: string, shareBps: number, tag = token.slice(2, 6)) =>
  leg(shareBps, hop('pancakev3', `0xin${tag}`, WETH, token), hop('pancakev3', `0xout${tag}`, token, UP))

test('waypoints past the heaviest few become one node that says how many', () => {
  const route = [
    leg(3000, hop('pancakev3', '0xdirect', WETH, UP)),
    via(BTCB, 1690),
    via(USDC, 450),
    via(USD1, 400),
    via(ETH, 310),
    via(U, 270),
    via(CAKE, 100),
    via(XRP, 30),
  ]
  const folded = condenseWaypoints(route)
  const share = (legs: SolverLeg[]) => legs.reduce((sum, l) => sum + l.shareBps, 0)
  assert.equal(share(folded), share(route), 'every share survives the fold')

  const waypoints = new Set(folded.flatMap((l) => l.hops.slice(0, -1).map((h) => h.tokenOut)))
  assert.deepEqual([...waypoints].sort(), [BTCB, USDC, USD1, 'others:4'].sort())
  assert.equal(foldedTokenCount('others:4'), 4)
  assert.equal(foldedTokenCount(BTCB), null, 'a real address is never read as a count')

  // the three heaviest keep their pools, and so does every leg through the
  // collective — a rename costs a leg nothing it was carrying
  const collective = folded.filter((l) => l.hops.some((h) => h.tokenOut === 'others:4'))
  assert.equal(collective.length, 4)
  assert.deepEqual(
    collective.map((l) => l.shareBps).sort((a, b) => b - a),
    [310, 270, 100, 30],
  )
  for (const l of collective) {
    assert.equal(l.hops[0].protocol, 'pancakev3', 'the venue that carried it is still named')
    assert.equal(l.hops[0].tokenIn, WETH)
    assert.equal(l.hops[1].tokenOut, UP, 'the output token is never renamed')
  }
  // the direct leg has no waypoint to fold and comes through untouched
  assert.ok(folded.some((l) => l.hops.length === 1 && l.hops[0].pool === '0xdirect'))
})

test('a waypoint too thin to be a landmark folds even when it ranks in the top few', () => {
  // rank alone kept USDC and USD1 here, and a 2.5% bar is the 3px minimum: two
  // chips that cannot sit beside their own bars, stacked into a legend
  const route = [via(BTCB, 9000), via(USDC, 250), via(USD1, 240), via(ETH, 230)]
  const folded = condenseWaypoints(route)
  const waypoints = new Set(folded.flatMap((l) => l.hops.slice(0, -1).map((h) => h.tokenOut)))
  assert.deepEqual([...waypoints].sort(), [BTCB, 'others:3'].sort())
  const share = (legs: SolverLeg[]) => legs.reduce((sum, l) => sum + l.shareBps, 0)
  assert.equal(share(folded), share(route), 'every share survives the fold')
})

test("the heaviest waypoint is a landmark at any width, and keeps its name", () => {
  // almost everything goes direct, so no waypoint clears 3% — naming the widest
  // one still says more about the route than a map of nothing but counts
  const route = [leg(9700, hop('pancakev3', '0xdirect', WETH, UP)), via(BTCB, 150), via(USDC, 100), via(USD1, 50)]
  const waypoints = new Set(
    condenseWaypoints(route).flatMap((l) => l.hops.slice(0, -1).map((h) => h.tokenOut)),
  )
  assert.deepEqual([...waypoints].sort(), [BTCB, 'others:2'].sort())
})

test('folding waypoints stands down at three or fewer, and never touches the ends', () => {
  const three = [via(BTCB, 4000), via(USDC, 3000), via(USD1, 3000)]
  assert.equal(condenseWaypoints(three), three, 'identity, not a rebuild')
  // a direct-only route has no waypoints at all
  const direct = [leg(6000, hop('univ3', '0xa', WETH, UP)), leg(4000, hop('univ2', '0xb', WETH, UP))]
  assert.equal(condenseWaypoints(direct), direct)
})

test('two folded waypoints in a row give up their pools rather than draw a loop', () => {
  // WETH→CAKE→XRP→UP: both middles fold, so the renamed path would visit the
  // collective node twice — which is not a path the map can draw
  const long = leg(
    120,
    hop('univ3', '0x1', WETH, CAKE),
    hop('univ2', '0x2', CAKE, XRP),
    hop('univ3', '0x3', XRP, UP),
  )
  const folded = condenseWaypoints([via(BTCB, 4000), via(USDC, 3000), via(USD1, 2880), long])
  const collapsed = folded.find((l) => l.hops.some((h) => h.protocol === 'slivers'))
  assert.ok(collapsed, 'the doubled leg is drawn as a collective band')
  assert.equal(collapsed.shareBps, 120)
  assert.deepEqual(
    collapsed.hops.map((h) => [h.tokenIn, h.tokenOut]),
    [
      [WETH, 'others:2'],
      ['others:2', UP],
    ],
  )
  // one leg behind the band, so the count is the pools it crossed — never "+1"
  assert.deepEqual(collapsed.hops.map((h) => h.folded), [3, 3])
})
