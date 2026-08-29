# LP TERMINAL

Personal terminal-style frontend for LPs on Robinhood Chain (chainId 4663) and
BNB Smart Chain (chainId 56). Robinhood combines UP33 (ve(3,3) DEX) with the
official **Uniswap v2 + v3** deployments; the BSC build also reads, swaps and
manages **Uniswap v4**. POSITIONS manages held liquidity and POOLS browses/adds
liquidity with protocol badges (brand mark + colored label). Uniswap v2/v3 and
BSC PancakeSwap v2/v3 discovery run through the self-hosted **pool indexer**
(see below); that indexer also owns BSC's complete PoolId-keyed v4 catalog. The Graph remains its
hash-pinned identity-bootstrap/current-featured-stat source and the candidate
position-id source.
UI is branded **LP TERMINAL** (general LP terminal, terminal _style_ — full-bleed
layout, not a boxed console). The canonical `https://lp-terminal.xyz` serves
both chains from one browser origin. `up33-terminal.xyz` (Robinhood) and
`bsc.lp-terminal.xyz` (BSC) remain compatibility entry points only. (Repo dir
keeps the historical name.)
Contract reference: `docs/up33-contract-map.md`.

## Chains

Every chain ships in every bundle, and the user picks one:

```bash
npm run build                 # BNB Smart Chain (56) — the default
CHAIN=robinhood npm run build # Robinhood Chain (4663)
```

The active chain resolves one entry from `src/config/chains/`, and everything
downstream reads it: addresses, the DexScreener and Kyber slugs, the explorer
and its API shape, the native coin, the RPC, and which features exist at all.

Two different questions hang off that, and `src/config/chains/index.ts` answers
them separately:

- **`BUILD_CHAIN`** — the bundle's default chain and the chain served by that
  stack's legacy unscoped `/rpc` and `/api` paths. It is fixed by `CHAIN=` for
  the build; it does not limit what the canonical gateway can select.
- **`CHAIN`** — what the user is looking at: `?chain=` in the link, else what
  this browser remembers, else `BUILD_CHAIN`. A bad `?chain=` is ignored; a bad
  `CHAIN=` throws, because one is the user's typo and the other is ours.

Switching chains is a **page load**, not a re-render: `CHAIN_ID`, every address
and every transport is a module constant, so a switch that left the page
standing would leave half the app on the old chain. `src/lib/chainPref.ts` holds
that contract. The selector navigates with an ordinary same-origin link; the
new page then remembers the explicit choice in localStorage and keeps it in the
address bar, so any copied link carries the chain.

Production chain switches stay on `https://lp-terminal.xyz`: the URL becomes
`?chain=bsc` or `?chain=robinhood`, preserving the current path, query and tab.
The canonical same-origin BFF exposes exactly two chain namespaces:

- **BSC** — `/_chain/bsc/rpc` and `/_chain/bsc/api/*`.
- **Robinhood** — `/_chain/robinhood/rpc` and
  `/_chain/robinhood/api/*`.

Caddy strips the fixed prefix and forwards each namespace to its own web/indexer
stack. The stacks, RPC credentials and SQLite databases remain isolated; only
the browser origin is shared. Unknown `/_chain/*` paths return 404, while
unscoped `/rpc*` and `/api*` on the canonical host return 410 so a stale tab
cannot silently cross chains.

The bundle receives `VITE_CHAIN_GATEWAY_HOST=lp-terminal.xyz`, but enables these
routes only when the runtime `location.hostname` exactly matches that host. The
same BSC bundle on `bsc.lp-terminal.xyz`, and the Robinhood bundle on
`up33-terminal.xyz`, therefore retain their own legacy `/rpc` and `/api` paths.
On those compatibility hosts, selecting the other chain uses its public RPC and
does not trust the host's one-chain indexer. Local and plain-static builds keep
the same build-chain/public-RPC fallback. Indexer responses also identify their
chain and are rejected unless both key and chain id match the chain on screen.

The rest carry their chain in the request path (`/kyber/<slug>`,
`/dexscreener`, `/goldsky/<deployment>`, `/thegraph/<deployment>`) and serve
either chain unchanged.

`src/config/features.ts` derives what a chain can do from its config, so nothing
offers what isn't there. On BSC that means no emissions surfaces (BSC has no
ve(3,3) protocol behind this terminal) and no BRIDGE tab (its route model
settles through Robinhood's own canonical inbox). A chain with no solver
configured falls back to direct routes only; both chains ship one today.

v2 LP discovery differs in KIND rather than in presence, and the POSITIONS tab
says which one is running. Robinhood enumerates what the wallet holds through
Blockscout and finds any pair; BSC has no free equivalent, so it derives
candidate pairs and reads their balances (below), which makes the count a floor
rather than a total. The V2 section header carries a `swept` hint there, and an
empty result says so in full — a wallet holding LP in an unlisted pair would
otherwise read a truthful `0` and conclude it owns nothing.

The Graph is a **discovery source**, not a transaction or routing authority.
On BSC the indexer imports a canonical-block-hash-pinned, identity-only full v4
PoolId snapshot from it, then
discovers later `PoolManager.Initialize` events over RPC; The Graph also supplies
candidate position ids and refreshes the small featured raw-stat set. Pool state,
ownership and every write are checked on-chain. SWAP independently constructs
supported routes, probes them through `StateView` and quotes them on-chain. Once
the V4 snapshot is complete, a Graph outage leaves the local full directory and
RPC pool tail available; it only pauses raw-stat refresh and discovery of
additional position NFTs.

Before trusting a chain config, make it earn it:

```bash
npm run check:bsc
```

That asks the chain whether every configured contract exists, then requires a
real quote from Uniswap V2/V3/V4 and PancakeSwap V2/V3 through the app's own
route code. A valid DexScreener mark still enforces the price-drift guard; an
unavailable display-only mark warns without masking successful on-chain checks.

### The two DEX slots

Every chain gets two: Uniswap, and the chain's own DEX (`protocol: 'univ3'` and
`protocol: 'home'`). Robinhood's home slot is UP33, BSC's is PancakeSwap.

A slot is a **venue**, not a pool family. Each one holds every `kind` that venue
offers — `v2`, `v3`, `cl` — and the swap tab shows one row per venue carrying
the best of its legs, because that is the comparison a trader wants. Reaching a
new pool family therefore widens `kind`; it never adds a slot.

The two slots differ in one thing that reaches four ABIs — what identifies a
pool inside a token pair. UP33's Slipstream fork keys pools by **tick spacing**;
Pancake v3, like Uniswap, keys them by **fee tier**, with a 2500 rung Uniswap
does not have. `CHAIN.homeCl.keyedBy` records which, `src/lib/homeCl.ts` is the
only module that reads it, and a discovered route carries its own shape so a
tick spacing can never be encoded where a fee tier belongs — `assertRoute`
refuses the mismatch before any calldata exists.

### The v2 legs

Both venues can have one, and they do not charge the same fee: measured from
the routers on BSC, Pancake's pairs take **25 bps** where Uniswap's take **30**.
So a v2 route carries its fee and `assertRoute` checks it against the venue it
claims to be on — a Pancake route bearing Uniswap's 3000 would settle 5 bps
light. `chain-check` re-measures both from `getAmountOut` on every run, so the
number keeps being tested rather than trusted.

`CHAIN.homeV2` also names the router that **executes** the leg, which is not
`addr.V2_ROUTER`: the plain v2 router has no sweep fragment, so a swap through
it could not pay the terminal fee in the same transaction. PancakeSwap's
SmartRouter carries the whole SwapRouter02 surface instead (verified by selector
against the deployed bytecode, and it embeds no Permit2, so a plain ERC-20
approval reaches it), which is why one ABI drives both venues' v2 legs.

`homeV2` is **null** on Robinhood: UP33's v2 is a Solidly fork routing on
`(from, to, stable)` structs rather than an address path, and no route for it
can validate at all until there is an encoder.

### Finding LP a wallet no longer holds

Three readers run per refresh, and each answers a question the others cannot.

A **wallet reader** asks what the address holds. On Robinhood that is
Blockscout's holder-balance endpoint, which finds any pair. BSC has no free
equivalent, so there the pairs are _derived_: a v2 factory deploys by CREATE2,
so `keccak256(0xff, factory, keccak256(t0,t1), initCodeHash)` names a pair
offline with no RPC and no index. Coverage is bounded by the candidate list —
a pair nobody proposed is a pair nobody checks.

A **farm reader** asks what the address deposited. Staking transfers the LP
token, so the wallet's balance is genuinely zero and every reader above is
correct to report nothing. `CHAIN.homeV2Farm` (MasterChefV2) is the only
contract that still records the depositor, and only under a pid — a fungible
LP token carries no identity to enumerate, so it is `userInfo(pid, user)` asked
once per pid, bounded by `poolLength`. The pid map is resolved once per session
because an lpToken never changes.

That farm names addresses without saying which factory made them, so each one
is verified by the same CREATE2 arithmetic. Measured on BSC: **147 of 187 pids
verify, 0 wrong-factory**; the other 40 are dummy tokens (`dCAKEPOOL`,
`dLOTTO`) and StableSwap LPs, which have no `token0()` and drop out on their
own. Every pid now has `allocPoint` 0 — CAKE farming there is finished — yet
**144 pairs still custody LP**, Cake/WBNB alone holding 52% of its own supply.
That LP keeps earning trading fees, so `v2PosMetrics` prices it on the fee
branch rather than reporting emissions that ended: custody moved the token, not
its claim on the reserves.

The **CL farm** (`homeClFarm`, MasterChefV3) is the same problem with an easier
answer — an NFT carries identity, so ERC-721 enumeration walks it directly.

When two readers find the same pair, `mergeV2ByPair` folds them into one card.
That is safe because each leaves the other's field at zero: the wallet reader
never reports `stakedLp`, the farm reader never reports `walletLp`. The
underlying is recomputed from total LP rather than summed.

**Uniswap v4** is the one case no contract can enumerate from either direction.
Its PositionManager mints ERC-721s but implements neither `totalSupply` nor
`tokenOfOwnerByIndex`, and there is no factory or per-pool contract to scan.
The configured The Graph subgraph therefore supplies candidate token ids that
might belong to a wallet and the block-pinned seed from which the self-hosted
POOLS catalog is built. Later pools come from `Initialize` logs. Ownership is
re-read from PositionManager, and every catalog row's state and PoolKey-to-PoolId
round trip are checked against the singleton before use, so stale index data can
omit/waste a read but cannot grant ownership or authorize a transaction against
a different pool.

Three things about that reader are load-bearing:

- **The pool key comes from the position**, never from a rung ladder. v4 leaves
  fee a free field, and live BSC positions sit on 27400/548 and 599900/11998.
  The key is then checked against the truncated pool id the position stores, so
  a mis-decode cannot quietly report another pool's price.
- **The id query orders newest-first.** GraphQL defaults to id order, and with
  a cap that hands back a busy wallet's _oldest_ positions — nearly all closed.
  Two BSC wallets holding 40+ live positions each read as completely empty
  before that was fixed.
- **Fees are derived, not collected.** There is no `collect` to simulate, so
  uncollected fees are fee growth across the range minus the position's
  snapshot, with the subtraction wrapping deliberately — those accumulators are
  allowed to overflow, and checked arithmetic would throw on a busy pool.

`ClPool.address` carries the singleton for a v4 pool, because that is where the
pool genuinely lives; `poolId` is what tells one from another. Anything keying
a map by address therefore collides across v4 pools and must key by `poolId`.

If The Graph is unavailable after a completed snapshot, the indexer keeps the
full v4 directory and continues its RPC `Initialize` tail; featured TVL/volume
stays at the last good refresh. Discovery of additional v4 NFTs still degrades.
A v4 position already loaded in the session collects, increases, decreases and
withdraws through on-chain calls; v2/v3 discovery and operations are independent.

### Writing v4 liquidity

Every other CL card writes through named entrypoints — `increaseLiquidity`,
`decreaseLiquidity`, `collect`. v4 has **one** write entrypoint,
`modifyLiquidities`, taking an encoded list of actions (`lib/uniV4Write.ts`,
encoders in `lib/uniV4.ts`). Four things follow, and all four were settled by
simulating against the deployed manager rather than by reading the docs:

- **Close currencies, do not settle them.** Every v4 liquidity change credits
  the position's accrued fees into the same delta as the principal, so an
  out-of-range position's inactive side comes out _positive_ — and `SETTLE_PAIR`,
  which can only pay, reverts with `DeltaNotNegative` (`0x3351b260`). Measured on
  five live out-of-range BSC positions: all five reverted with `SETTLE_PAIR`, all
  five passed with `CLOSE_CURRENCY`. That also means an increase always settles
  the fees, and a decrease pays principal and fees in **one** transaction where
  the v3 card needs two.
- **The pool key is the address.** A v4 pool has no contract, so the payload
  names it by key — one wrong field still encodes, still executes, and modifies a
  different pool. Every op rebuilds the key from the card and refuses unless it
  hashes back to the id the position was read under.
- **The coin is a currency.** A native-keyed pool is paid in `msg.value`, and the
  manager settles from its own balance, so `SWEEP` has to return the remainder or
  it sits there for whoever sweeps next. These are the common case on BSC.
- **Liquidity is an input, not a result.** A v3 NPM derives it from the live
  price at execution and so can quietly deposit less; v4 fixes it in the payload
  and caps the pull with `amountMax`. Sizing it for the worst price in a narrow
  band (`V4_DEPOSIT_BAND_BPS`) is what lets the typed amounts go in as the
  ceiling verbatim — the deposit always lands and can never spend more than was
  typed. What that gives up is real and is tabulated at the constant.

Zap covers both an existing v4 NFT and a new v4 pool selected from POOLS. It
splits a single input, swaps the counter-side amount, completes ERC-20 → Permit2
→ PositionManager approval, then mints/increases through `modifyLiquidities` and
closes both currency deltas so unused funds return. Native BNB is the v4
`address(0)` currency and is paid with `msg.value`; WBNB input is unwrapped when
the target side is native rather than wrapped.

### Uniswap v4

v4 is the first venue here with no factory and no pool contract. One singleton
holds every pool, and a pool is named by `keccak256(abi.encode(poolKey))`. On
BSC the self-hosted indexer provides the complete searchable POOLS directory.
It imports a count-complete, block-pinned The Graph snapshot into PoolId-keyed
SQLite tables, records provenance, then tails the singleton's `Initialize`
events over RPC. Its landing page samples high-activity pools plus pools with
the largest raw BNB, WBNB or USDT sides; the table remains sorted by 24h volume
by default and can be searched by pair, symbol, either token address, or exact
`poolId`; `*` plus **LOAD MORE V4** walks deterministic 64-hex PoolId cursor
pages. The frontend uses The Graph directly only when the indexer is
unreachable, predates V4 catalog support, or identifies itself as a deployment
for another chain. A V4-capable indexer that is still warming gets up to 30
minutes to publish its catalog and is not bypassed. Explicit searches bypass
the landing-page dust filter.
A wallet does not need to hold an existing v4 NFT before selecting a compatible
row and minting a new position with pair funding or ZAP. Hooked pools stay
browseable, but ZAP is disabled before any swap can run; pair funding warns that
the generic path sends empty hook data, which a hook with pool-specific deposit
requirements may reject during on-chain simulation.

That catalog is deliberately not fed into SWAP route selection. The swap path
still computes supported keys, asks `StateView.getSlot0` whether each is live,
and obtains executable on-chain quotes (or uses the deployed solver where a
chain has one). The indexer makes pools browseable; neither it nor its Graph
bootstrap proves that a route exists or chooses how a trade executes.

Three things about it are not like the other venues, and each is load-bearing:

- **The native coin is a currency, not a wrapper.** A v4 pool keys BNB directly
  as `address(0)`, and that is a _different pool_ from the WBNB one — on BSC the
  native BNB/USDT 0.05% pool holds about twelve times the wrapped pool's
  liquidity. So `v4Currency` deliberately does not do what `erc20Of` does.
- **ERC-20 input is pulled through Permit2**, so a v4 swap needs two approvals:
  the token to Permit2, then Permit2 to the router. `permit2Operator` on the
  built transaction is what tells `executeSwap` to run the second leg. Adding
  liquidity needs the same two legs with the _PositionManager_ as the operator —
  `chain-check` reads `POSITION_MANAGER.permit2()` rather than assuming it.
- **`tickSpacing` and hooks are part of the pool's name**, not consequences of
  the fee, so a directory row carries the complete key and `assertRoute` refuses
  a mismatched route. The independent SWAP probe path only proposes pool-key
  shapes its encoders explicitly support; discovering a row never silently
  broadens executable routing.

The swap struct the router decodes is a **version** question — v4-periphery
later added a `minHopPriceX36` field that shifts everything after
`amountOutMinimum`. `chain-check` settles it on every run by looking for the
per-hop-slippage error selectors in the deployed bytecode: their absence is what
says the pre-per-hop struct is still correct.

LP positions on v4 are found and written too — see "Finding LP a wallet no
longer holds" and "Writing v4 liquidity" above.

Pool discovery follows from that. A fee-keyed home CL has a fixed ladder, so its
pools are found the way Uniswap's already were: by asking the factory. A
tick-spacing-keyed one has no such ladder and keeps using the enumerated pool
list from `usePools`.

Routing tests are split by shape — `directSwap.test.ts` fixtures are indexed for
the tick-spacing path, `directSwapFeeKeyed.test.ts` covers the calldata of the
fee-keyed one — so **run the suite on both targets** to cover both:

```bash
npm test && CHAIN=bsc npm test
```

## Run

```bash
npm install
npm run smoke     # optional: live-chain read-layer validation (TickMath, ABIs, quotes)
npm run indexer   # pool indexer on :8787 (optional but recommended; BSC first boot
                  # imports pinned Uni V3, Pancake V3 and Uni V4 snapshots)
npm run dev       # http://localhost:5173 (proxies /api -> :8787)
```

For `CHAIN=bsc`, Uniswap V2 and PancakeSwap V2 independently enumerate their
official factories through `allPairsLength`/`allPairs`. Uniswap V3's first full
directory is a block-pinned The Graph snapshot: the indexer
rejects indexing errors, requires the downloaded count to equal the subgraph
protocol's `totalPoolCount`, reads the factory tier from `FIXED_TRADING_FEE`,
and verifies every row with the on-chain official factory before publishing
provenance. A snapshot more than 10,000 blocks behind finalized head is rejected.
RPC then scans only the bounded post-snapshot catch-up and later increments.
PancakeSwap V3 uses the same snapshot-plus-tail boundary with the reviewed
Messari-schema Graph deployment. The Graph snapshot is the historical
completeness trust root: its fixed count and complete pagination are what claim
that no pre-snapshot pool was omitted. Every page is pinned to a canonical BSC block
hash, its exact count and deployment are fixed for the whole traversal, Graph
contributes only candidate addresses/creation blocks, and token addresses,
fee and tick spacing are read from each pool on-chain. Every fee tier must
exist on the official factory and every pool must round-trip through its
`getPool` before storage. Those on-chain checks prove row authenticity, not
catalog completeness; without an independent full factory-log scan the result
must not be described as cryptographically exhaustive. On every boot the stored
snapshot block/hash is checked again against canonical RPC before its tail
cursor may be reused. There is deliberately no
BSC V3 full-history RPC fallback. A BSC deployment
therefore needs a server-side `THEGRAPH_API_KEY`, an explicit chain-56 endpoint
behind the browser's `/rpc`, and at least one indexer endpoint that supports
incremental `eth_getLogs`; none may enter a public bundle or committed file. A
public endpoint that answers `eth_getLogs` with an empty result rather than an
error is the trap here — it looks healthy and indexes nothing.

V4 follows the same snapshot-plus-tail boundary with a different identity. The
indexer first reads the published `uniswap-v4-bnb` head, resolves the chosen
finalized block's canonical hash from BSC RPC, and pins every historic Graph
page by that hash. Each page must resolve back to the same block number/hash,
deployment, configured PoolManager and exact pool count. The full import is
identity-only: PoolId/currencies/tick spacing/hooks plus token display metadata;
it does not bless a fee, created block, executable state or a 162k-row stats
snapshot. Every row is stamped with one deterministic 32-byte snapshot
generation, and provenance is published atomically only when that generation's
row count exactly matches the advertised count. Post-snapshot `Initialize`
events then supply canonical fee/creation identity and all later pools over RPC.

The V4 API advertises its own capability and readiness. Its first page freezes
both `catalogBlock` (the finalized RPC-tail boundary) and `catalogGeneration`
(the published snapshot); continuation requests carry both alongside the
PoolId cursor, and restart on a generation conflict. The frontend waits up to
30 minutes for a capable-but-warming indexer; direct Graph fallback is reserved
for an unreachable/older indexer or a deployment serving a different chain.
`V4_STATS_MS` (default ten minutes) refreshes and exposes only the current small
featured raw-stat generation, never the full identity directory.
`/api/health` exposes independent Uniswap V2/V3, PancakeSwap V2/V3 and Uniswap
V4 capabilities: official factories, local/factory counts, snapshot provenance
and RPC cursors. Its top-level `ready` is aggregate, so an incomplete Pancake
directory or a degraded V4 tail makes it false; `catalog.*.ready` identifies the
protocol boundary that failed.

Production locks Uniswap V3 to reviewed Graph ID
`8f1KyiuNYiNGrjagzEVpf6k6KkPG517prtjdrJihgHw` and deployment
`QmctqZqG2SY5wvwLVBPZY8God2cW3wjNQ14Z4swKeJJX9D`. Overrides must set
`INDEXER_V3_SUBGRAPH_ID` and `INDEXER_V3_SUBGRAPH_DEPLOYMENT` together.
Production also locks PancakeSwap V3 to reviewed Graph ID
`78EUqzJmEVJsAKvWghn7qotf9LVGqcTQxJhT5z84ZmgJ` and deployment
`QmQhHo4B63yqxLsqFTMjEF6VQJ6xYorn6k5r5a8takVnJQ`. Overrides use
`INDEXER_PANCAKE_V3_SUBGRAPH_ID` plus
`INDEXER_PANCAKE_V3_SUBGRAPH_DEPLOYMENT`; health and deploy verification require
the published snapshot provenance to match both. The large BSC directory uses
progressive enrichment above 250,000 address-keyed pools. READY proves the
official directory snapshots/cursors, not that every permissionless token
cooperated with metadata/state calls: one malicious `decimals()` revert must
not hold the entire site offline. Boot attempts a bounded useful seed, while
multi-million catalogs keep only bounded top, hot, active, recent and
API-requested tiers hydrated. They retain the complete factory-backed identity
directory but do not run a repeating full-state census over the dust tail.
Factory tails discover new pools every five minutes; the shared landing tier
refreshes every minute, and exact stale rows enter one bounded durable hydration
queue so concurrent users share the same work. Metadata → state → bounded TVL
ordering and retry backoff isolate bad tokens instead of hammering them. Full
price-graph propagation runs in one coalescing worker at boot and every 24
hours; the 5-minute stats and 4-hour active passes update TVL only for their
bounded address sets. The v2/v3 landing query unions bounded, protocol-scoped
indexed candidates before sorting, while exact totals come from
trigger-maintained counters. Relevant defaults are exposed as `TAIL_MS`,
`FRONTPAGE_MS`, `LOGTAIL_MS`, `TARGETED_STATE_STALE_MS`,
`API_POOL_CACHE_ENTRIES`, `API_POOL_CACHE_MS`,
`API_POOL_CACHE_STALE_MS`, `INDEXER_PROGRESSIVE_CATALOG_THRESHOLD`,
`INDEXER_BOOTSTRAP_POOL_LIMIT`, `INDEXER_PROGRESSIVE_TIER_LIMIT`,
`INDEXER_CATALOG_FRESH_ADDRESS_LIMIT`, `HYDRATION_DEMAND_N`,
`HYDRATION_DEMAND_MAX`, `RECENT_HYDRATION_N`, `LANDING_CANDIDATE_N`,
`REPRICE_MS` and `INDEXER_SQLITE_BUSY_TIMEOUT_MS`.

Local environment comes from the workspace-level **`../.env`** (via Vite
`envDir`; this repo shares RPC settings with sibling projects):

| key                                 | use                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `RPC`                               | private build-chain RPC (**secret** — personal/local builds only; leave unset for public builds, see Deploy)            |
| `KYBERSWAP_FEE_RECEIVER`            | required build-time receiver address retained by the zero-fee execution paths (legacy env name)                         |
| `KYBERSWAP_AGGREGATOR_API_BASE_URL` | Kyber API used for read-only USD valuation; MARKET and ZAP do not call it                                              |
| `VITE_WALLETCONNECT_PROJECT_ID`     | optional; only needed for WalletConnect QR pairing (injected wallets work without it)                                  |

**ZAP** and **MARKET** are currently free (**0 bps**).
Direct swaps send their gross output to the selected router and complete the swap
plus fee sweep in one transaction — a fee settles via `sweepTokenWithFee` /
`unwrapWETH9WithFee` (which require 1–100 bps), a 0-bps swap through the plain
`sweepToken` / `unwrapWETH9`. Displayed output and minimum-output checks are net
of the fee. Fee policy and slippage stay independent. Non-transactional valuation (UP rewards,
APR, positions and add-LP simulations) uses a fee-free Kyber quote; that display
price never enters route selection, Zap sizing, minimum output or execution.

Interactive POOLS/SWAP/POSITIONS writes are browser-wallet only (RainbowKit /
injected EIP-6963). The optional unattended strategy executor is a separate,
loopback-only service with its own explicit signer and encrypted local state;
see “Recommendations and unattended strategies” below.

**i18n (en/zh)**: react-i18next with typed keys — catalogs in `src/i18n/en.ts` (source of
truth) + `zh.ts` (`typeof en` enforces identical key structure at compile time). Language:
header `lang:` switcher, persisted (`up33.lang.v1`), `?lang=` view-only override
(screenshots), `<html lang>` + RainbowKit modal locale follow. Non-React modules
(tx step labels, zap planner) import the singleton `t` from `src/i18n`; revert hints
resolve lazily so they follow the active language at error time. Number/date formats
stay en-US in both locales (terminal convention; zh uses the same digit grouping).
The `#lab` dev page stays English.

## Tabs

Tab order includes `POOLS · SWAP · POSITIONS · BRIDGE · STRATEGY · STRATEGY
HISTORY · P/L CALENDAR · RECOMMEND`. Keyboard: `1` pools, `2` swap, `3`
positions, `5` bridge, `6` strategy, `9` recommend, `4` opens LIMIT, and `/`
focuses the pool filter. Tabs
are hash-routed (`#pools`, `#swap`, …) so reloads and deep links keep your
place. `#lab` renders the component lab (synthetic data) for visual tweaking.
(The old DASH tab was removed with the LP-terminal refocus. The header carries
the block number, the `lang:` switcher and the wallet; the contract directory
lives in `docs/up33-contract-map.md`. Epoch/flip were dropped from the header —
an LP reads them off the emissions columns, and the countdown was re-rendering
the header every second to show it.)

- **[1] POOLS** — a market list, and beside it the panel that acts on the row you pick. Past 1200px the two sit side by side; below it the panel stacks above the list, because a tap near the bottom of a phone must not open the answer off-screen. The panel has two tabs and remembers which one you last used (default SWAP): **SWAP** routes through the ordinary swap path — the same solver and the same direct venues the full SWAP tab uses, opening on the chain's own coin as the spend side — so the row names the asset and the router still decides where the size goes; **PROVIDE LP** is the deposit form, and that one _is_ about the pool you clicked.

  The chips above the list name **assets, not venues**. Which factory minted a pool is still on every row (protocol badge) and still decides how a deposit is built; it is not what a landing page should be sorted into. `ALL`, plus — where the chain can prove them — the launchpad's own markets and one chip per tokenized-equity issuer. Both alternatives are proven on-chain rather than listed: the launchpad's factory re-derives a candidate's CREATE2 address from its self-reported `(name, symbol, decimals, creator, graffiti)` and only that factory can deploy there (`src/lib/launchpadToken.ts`; `npm run smoke:launchpad` re-measures it against live tokens, in both directions), and the issuer proof is the existing proxy-bytecode + ERC-1967 anchor check. On a chain with a launchpad, an unproven v4 row is held out of the browse list — searching an address still reaches it, and a held pool is never hidden.

  Each row leads with the two tokens' **pictures**, the traded side first and ringed. A picture is a stronger claim than a symbol, so only a proven source supplies one: the token's own `tokenURI` document once the factory has vouched for it, the issuer's CDN once the bytecode has, or the chain's reserved-symbol list — everything else gets letters on a hue derived from its address, so two tokens sharing a ticker never share a tile.

  The table itself is one view across the protocols available on the selected chain. The shared address-keyed indexer API serves full **Uniswap v2/v3 and PancakeSwap v2/v3** directories with search and deterministic pagination; Uniswap v4 uses its separate PoolId cursor. Robinhood uses factory history; on BSC each address-keyed row retains its exact `univ2`, `univ3`, `pancakev2` or `pancakev3` source tag, while the client maps Pancake rows onto the configured home V2/CL execution contracts. Indexed totals include all four address-keyed families. If that indexer is unavailable, the compatibility fallback is explicitly **Uniswap v3 only** (DexScreener top 30 plus official-factory verification); it is never substituted for the full catalog. BSC V4 imports a PoolManager-bound PoolId snapshot before tailing `Initialize`; its landing page prioritizes active pools and BNB/WBNB/USDT anchors, while search accepts pair, symbol, token address or exact `poolId`, and `*` plus **LOAD MORE V4** walks the complete index. Explicit searches bypass the landing-page dust filter. Columns: fee rate, reserves/price, **TVL / VOL 24H / FEES 24H**, **FEE APR / EMIT APR**, emissions and vote share; executable state remains chain-derived. Add-liquidity in the panel covers v2 auto-ratio and CL/v3/v4 range minting.

  **⚡ ZAP — one-token add (all generic pool kinds + increase)**: every generic add panel has a `FUND: PAIR | ⚡ ZAP` switch. ZAP funds a new or existing position with ONE token: it solves how much to swap so both sides match the target ratio (CL band math / v2 reserves), compares executable on-chain routes, previews the frozen plan and then runs the numbered transactions. For a native-keyed v4 pool, BNB remains currency `address(0)` and is supplied as `msg.value`; WBNB input is unwrapped before deposit. ERC-20 sides complete ERC-20 → Permit2 → PositionManager approval, then `modifyLiquidities` mints/increases, closes both currency deltas and returns unused funds. A nonzero-hook v4 pool disables ZAP up front so an empty-hook-data deposit cannot fail after an unnecessary swap; pair funding remains available with a warning. This is independent of The Graph after a pool key has been selected: the catalog discovers the pool, while route probing, quote solving, approvals and execution remain on-chain. Any failure **halts** — every intermediate asset is a normal wallet balance, nothing strands. `REWARDS` shows its full emissions sub-line on the selected row — it is detail about one pool, so it is shown for the pool being looked at.

  APR semantics (ve(3,3): a position earns one or the other, never both):
  - `FEE APR` — **unstaked** LP net fee yield: `vol24h × feeRate × 365 / TVL`, CL further × (1 − unstaked levy). Staked LPs earn **zero** fees (theirs go to the pool's voters). CL number is the pool average — a concentrated in-range position earns proportionally more.
  - `EMIT APR` — **staked** LP UP yield: `rewardRate × 31.536M × UP price / staked TVL`, where staked TVL is v2 `gauge.totalSupply/pool.totalSupply × TVL`, CL `stakedLiquidity/liquidity × TVL` (active-liquidity proxy; out-of-range staked earns nothing). `rewardRate` is the live post-cap stream, so gauge-cap burns are already reflected; it is only committed until the Thursday flip (`periodFinish`), and later cap releases within an epoch can raise it (values refresh live). `∞` = emissions streaming to ~zero staked TVL (first staker takes it all).
  - Simple APR, no compounding; both dilute as TVL/staked TVL grows.
  - **Add-LP simulation**: both add panels show a `PROJECTED` line for _your_ prospective position — deposit USD (priced via USDG/WETH/UP anchors), your share of active liquidity, and your fee/emit APR. For CL this is position-specific: `share = L_yours / (activeLiquidity + L_yours)` (fees) and `/ (stakedLiquidity + L_yours)` (emissions), so range concentration and self-dilution are captured exactly — e.g. a ±2% range earns several× the pool-average APR while in range. Out-of-range ranges warn that they earn nothing.

- **[2] POSITIONS** — summary strip (**LP VALUE** in USD across everything incl. uncollected fees, **PENDING UP** with USD value + live `+UP/day` accrual + **CLAIM ALL**, range status, open range-order count with filled alert), then every held LP sorted staked-first / biggest-first. Every card answers the two questions an LP manages by — **worth** (`value ≈ $…`, tokens priced off the pool's own price against USDG/WETH/UP anchors; fees/pending shown in USD too) and **earning right now** (`earning` line: staked → `UP/day + $/day + APR + share of staked liq`; unstaked/univ3 in range → `fee APR + $/day + share of active liq` from 24h stats — indexer stats fetched per held uniswap pool; out of range → red zero; emissions dry → amber). **Multi-protocol**: UP33 CL/v2 positions plus wallet positions from the official Uniswap v3 NPM (`0x7399…E0D3`, pairing chain-verified — Blockscout also lists several unofficial forks). Each card carries a protocol badge (UP arrow / Uniswap unicorn, brand-colored). Uniswap pools are discovered per position via `factory.getPool`, unknown pair tokens get erc20 metadata fetched live, fees use the same `collect`-simulation, and increase/decrease/collect/withdraw all work (write entrypoints are signature-identical; only the NPM address differs). No staking on univ3 (no gauges), and SWAP→LIMIT tags never attach to univ3 ids (tokenIds are only unique per NPM):
  - On BSC, v4 candidate token ids come from The Graph but ownership, pool key, balances and fees are re-read on-chain. Collect, increase, decrease and full withdrawal execute through `PositionManager.modifyLiquidities`; discovery failure does not disable operations for a position already loaded.
  - CL: **range bar** (ends = your price bounds, marker = current price, % drift to each bound, re-entry distance when out of range, in/near/out coloring), holdings, uncollected fees (exact, via `collect` simulation) or pending UP when staked. Actions: stake/unstake, claim UP, collect fees, increase, decrease (decrease+collect), withdraw (double-click confirm). The increase panel shows wallet balances + MAX, auto-links the two amounts at the live pool price, and previews the exact pull/new size — the range itself is immutable (`increaseLiquidity` has no tick params; it stacks liquidity on the band fixed at mint). Range orders placed via SWAP→LIMIT carry a `LIMIT sell→buy` badge, an order-mode range bar (waiting/filling x%/filled instead of the red out-of-range alarm, priced in the sell token), and a state-aware one-click action: `CANCEL — GET <sell> BACK` (unfilled) / `CLOSE NOW` (partial) / `WITHDRAW → LOCK IN <buy>` (filled); the tag clears on 100% withdraw.
  - after any claim (or CL unstake, which auto-claims) confirms, the log shows the exact UP received with a **SWAP → ETH** button — it jumps to SWAP prefilled with the claimed amount.
  - v2: wallet vs staked LP, underlying amounts, claimable pool fees, pending UP. Actions: stake all / unstake all / claim UP / claim fees / remove %.
- **[3] SWAP** — two modes:
  - **MARKET** — compares direct **Uniswap v2/v3/v4** (where configured) and the chain's home-DEX quotes side-by-side and selects the best net output by default. v4 routes are computed, probed and quoted on-chain; neither the indexer nor its Graph POOLS fallback is used as route input. The quote-derived price impact chooses 0.5% (green), 1% (amber), or 3% (red) slippage; users can override it with the same three explicit values. If the amount is too small for a distinct impact probe, AUTO stays unavailable and the user must choose a slippage explicitly. The selected route executes with no terminal fee (MARKET is currently free) and no silent provider fallback. UP33 Solidly v2 is deliberately excluded because its router has no atomic fee-sweep path. Native-coin wrap/unwrap is built in.
  - **LIMIT · SELL VIA LP** (`#limit`, key `4`) — sell a token with a **one-sided CL range order**. The point is **maker-not-taker economics**: a market swap through the pool pays its fee (1% on WETH/UP); a range order pays none and _earns_ fees while filling (the panel shows the comparison and an est. $/day while in-band). Pick sell/buy tokens (auto-picks the deepest CL pool; chips if several fee tiers), 25/50/75/MAX amount chips with USD estimate, choose a band: **TIGHT · 1 TICK** (default — one tick-spacing hugging market, fills on the first uptick) or +1→3% … +10→25% / custom, snapped to tick spacing; a `?` chip opens a structured band explainer (start/end/avg/grid rows). The panel renders as a structured **order ticket** (aligned key-value sections, no prose walls) phrased in the sell token's price: `ORDER` (fill-start / fully-sold / avg-fill premiums with exact prices — avg is the band's geometric mean, exact closed form — band ticks with a `≡ TIGHT` marker when a small custom band snaps onto the tight one, order-mode range bar), `PROJECTED · FULL FILL` (avg price vs market, exact proceeds + USD, est. fee income $/day while in band), `FEES · MAKER VS TAKER` (0% vs pool fee ≈ $ on your size), `MECHANICS` (fills / un-fills / after-fill withdraw / don't stake). Placing mints an out-of-range one-sided position (sell-side min ≈ 100% guards against the price having entered the band). Fills as the token appreciates through the band and earns pool fees while filling; **un-fills if price retreats** and nothing auto-executes — withdraw after fill to lock in.

## Safety rails

- MARKET and ZAP swap commits share one `lib/swapExec.ts` sequence: fresh quote/build for the selected direct route → fixed router/asset/recipient/minimum gate → exact approval → re-prepare after a real approval → chain-pinned send → receipt → actual output check. A selected route failure always stops; it never falls through to another protocol. Kyber is exposed only as a fee-free USD valuation function; the codebase has no Kyber transaction builder or execution intent.
- Direct venue swaps execute the swap and any configured terminal output fee atomically through their configured router path. MARKET and ZAP are currently free and settle through the plain sweep/unwrap variants. Minimum output remains expressed net of the configured fee and converted to the required gross router minimum, so lowering slippage never substitutes for fee collection if a fee is re-enabled.
- Auto slippage is a small deterministic policy over quote-derived price impact: 0.5% green, 1% amber, 3% red. A manual choice replaces the automatic tier. After a slippage-caused halt (MARKET or ZAP), AUTO floors at ~1.5× the tolerance that just failed, rounded up to 0.1% and only ever raised, so the failed number is never re-offered until the pair or amount changes. ZAP additionally requires the fresh route's `tokenOut` to be the pool's counter-token and never widens the frozen preview minimum during execution. Deposits then use the received-amount ground truth from the receipt, and approvals stay exact-amount per step.
- Exact-amount approvals only (no infinite approvals).
- All writes are pinned to the build's configured chain id; the wrong-network banner blocks confusion.
- Reads follow their lifecycle instead of one global timer: public pool catalogs are shared and remain fresh for five minutes, account positions load only where needed and are invalidated after relevant writes, and visible balances use a slower minute cadence. SWAP quotes and ZAP previews refresh only while useful, while execution always re-quotes fresh. Pools hosting your range orders retain a dedicated **4s slot0 feed** (single multicall) so fill %, holdings and the range bar track near-live; numeric updates flash **green ▲ / red ▼** by direction, and the range-bar marker glides so drift direction is visible.

## Pool indexer (`indexer/`)

The heavier backend behind Uniswap v2/v3/v4 and PancakeSwap v2/v3 discovery. Zero npm dependencies
beyond the app's own (`viem`, `tsx`; storage is node's built-in `node:sqlite`,
requires node ≥ 22.13). One process, resumable refresh loops, a read-only HTTP
API:

- **Catalog** — address-keyed v2/v3 identities retain one of `univ2`, `univ3`,
  `pancakev2` or `pancakev3` and come only from the corresponding official
  factory. On BSC, univ3 starts from a count-complete, block-pinned The Graph snapshot, reads the
  immutable `FIXED_TRADING_FEE` tier, verifies every pool against the official
  factory, rejects snapshots more than 10,000 blocks behind, and only then runs
  the bounded RPC tail. PancakeSwap V3 starts from a canonical-hash-pinned,
  count-complete third-party Messari-schema address snapshot. That Graph
  snapshot is the historical-completeness trust root; executable
  identity is read from each pool and needs the official factory's fee-tier and
  `getPool` proof before publication. Factory proof establishes that each row
  is real, but cannot establish that Graph omitted no rows; absent an independent
  full log audit this catalog is not claimed to be cryptographically exhaustive.
  Its stored block/hash is revalidated against canonical RPC at every boot;
  RPC owns the subsequent tail. Other chains retain `PoolCreated` history via
  Blockscout/windowed RPC. Both BSC V2 catalogs use independent
  `allPairsLength`/`allPairs` cursors.
  V4 has no factory or pool address, so its candidate directory lives in
  separate PoolId-keyed tables. The identity-only Graph snapshot is pinned by
  the canonical BSC RPC block hash and must report that same number/hash, the
  exact configured PoolManager, stable deployment/count provenance and complete
  pagination. Rows are tagged with one deterministic snapshot generation; the
  indexer publishes it only after `COUNT(snapshot_generation = current)` exactly
  equals the snapshot count. Event-verified tail rows may make the total larger.
  Subsequent `Initialize` logs supply immutable PoolKeys over RPC.
  The browser still reads StateView and proves the PoolKey hash before a row
  becomes actionable. The ordinary address-keyed tables never receive V4 rows.
- **State sweeps** (multicall, 400 calls/aggregate) — both V3 families: `slot0` +
  `liquidity` + both erc20 balances; both V2 families: `getReserves` + `totalSupply`.
  Catalogs up to 250k pools keep the complete-before-ready sweep. Larger
  BSC catalogs publish the complete factory-backed identity directory once its
  snapshots and cursors are proven, then prime a bounded 256-pool
  TVL/GeckoTerminal seed. They do not repeatedly sweep the multi-million-row
  dust tail. Top, hot, active and stats tiers are capped at 1,000 rows; exact
  API lookups and newest unhydrated rows share a bounded durable queue drained
  by the minute landing refresh. Failed token/state reads isolate and retry the
  affected rows instead of blocking the whole directory or causing a full scan.
  The threshold, seed size, tier limit and cadences are operator-tunable.
  V4 executable state is read by PoolId from StateView on the client; the
  singleton's token balances are deliberately never treated as per-pool
  reserves. Native BNB remains currency `address(0)` in storage and API rows.
- **Pricing → TVL** — GeckoTerminal token prices (plus USDG ≈ $1, which
  bootstraps before the first GT cycle) are the only CREDIBLE seeds; everything
  else is propagated from them through pool SPOT prices. Anyone can open a pool
  at any price, so four rails stand between a manipulated pool and the
  frontpage: a v3 pool with **no in-range liquidity or a boundary tick** doesn't
  get a vote (its `slot0` is free to move); propagation is a **BFS by hop**, so
  a token settles at the shortest path to a seed and never re-prices from a
  longer one; a quote's weight is **credible dollars**, capped past hop 1 by the
  depth behind the side it came from, so an inflated price can't inflate its own
  authority; and a token's quotes combine by **depth-weighted median**, so one
  pool has to outweigh every honest pool to move a price. Nothing pool-derived
  survives a pass — `reprice()` rebuilds it all from the seeds, so a poisoned
  price self-heals on the next cycle. TVL = sum of priced sides, bounded three
  ways (one side priced → 2×; a pool-priced side dwarfing its credible
  counterparty → 2× credible; any pool-priced side → ≤ 100× the credible depth
  behind its price), each flagged approximate. `/api/health` exposes
  `corruptTvlPools` as the canary — it should always be 0. All REAL numbers are
  display/ranking only — never tx inputs.

  _Why all of it:_ on 2026-07-22 a single v3 pool parked at `MAX_TICK` with zero
  in-range liquidity, holding $1,464 of real USDG, priced its counter-token at
  $3.5e50. Under the old "deepest priced-side pool wins" rule that fabricated
  price also fabricated a fabricated depth, so it out-bid every honest quote
  permanently and spread: 138 poisoned tokens, and **120 of the 120 rows the
  POOLS tab fetches** were fantasy — the first real pool sat at rank 216.

- **Stats** — GeckoTerminal top lists (network + uniswap-v2 + uniswap-v3, top
  200 each, paced ≤ 30 calls/min free tier) every 5 min: 24h volume/txns +
  GT's own reserve figure. GT has no UP33 entry — UP33 stats stay on the
  frontend's dexscreener/goldsky path. V4's full snapshot imports no accounting.
  A separate latest-state query writes raw, token-denominated Graph TVL and
  current/previous day buckets only for the current small featured set, prunes
  the prior featured generation, and refreshes every `V4_STATS_MS` (default 10m)
  while the identity directory itself stays on the RPC tail.
- **API** — `GET /api/pools?q=&proto=univ2,univ3,pancakev2,pancakev3&min_tvl=&sort=tvl|vol|created&limit=&after=0x…`
  (the first page is usefully ranked; `nextCursor` then walks the complete,
  filter-stable pool-address space without an offset ceiling). Invalid protocol
  names fail closed instead of silently broadening a venue filter; response
  totals always carry all four address-keyed families, including zero counts,
  plus protocol-scoped `proto=univ4` pages whose cursor is a 64-hex PoolId (never
  mixed with the 40-hex address cursor). V4 rows carry `poolId`, shared
  `PoolManager`, currencies, tick spacing, hooks and raw display stats;
  the first response returns `catalogBlock` + `catalogGeneration`. A continuation
  must echo them as `catalog_block` + `catalog_generation` with `after`, freezing
  tail membership and snapshot identity across the traversal; a changed
  generation returns 409 and the client restarts. Only rows in the current
  featured-stat generation carry raw stats.
  `catalogs.univ4.ready` distinguishes a published catalog from a capable
  indexer still completing its first import. The frontend retries the latter
  for up to 30 minutes and only uses its direct Graph fallback when the indexer
  is unreachable, predates V4 support, or reports another chain.
  (response shape mirrors the frontend's `PoolsData`/`PoolStat`; bigints as
  strings), `GET /api/tokens?q=` (symbol/address autocomplete), and
  `GET /api/health` (per-venue readiness, factories, counts, pinned provenance,
  cursors and rss). Top-level readiness fails closed across every venue supported
  by the configured chain.

  `GET /api/recommendation-candidates` is deliberately a separate bounded
  analytics feed. It combines current state with retained market/tick samples
  for UP33 CL, Uniswap v3/v4 and PancakeSwap v3. UP33 rows come from a complete
  official-factory enumeration but remain outside the public Uniswap/Pancake
  pool catalog, counts, cursors and solver adjacency.

Data lives in `indexer/data/index.<chain>-<id>.db` locally and `/data/index.db`
in production (WAL SQLite); delete only the chain-scoped DB to re-backfill from
scratch — the kv cursors make every loop resumable. Measured context for
the design (2026-07-16): ~100k+ univ3 pools **growing ~20k/day** (launchpad
factories mint a pool per token; ⚠ an earlier Blockscout-paged count said
21,979 — a silent-undercount artifact, the RPC-window scan is ground truth) +
11,640 univ2 pairs, plus 162,206 BSC V4 PoolIds at the 2026-08-03 review,
≥95% dust, ~2.6M Swap events/day
chain-wide — which is why volume comes from GT instead of self-indexed swaps
(revisit with Envio HyperIndex, which supports chain 4663 natively, if
self-computed fee/APR analytics are ever wanted). At this scale a full state
sweep is ~1k multicall aggregates (~7 min hourly); the hot tier stays tiny
because real TVL, not pool count, bounds it.

## Recommendations and unattended strategies

`RECOMMEND` ranks pools for a chosen capital amount, objective (fees or rewards)
and risk level. The model walk-forward selects a usable volume horizon, replays
candidate ranges over retained tick history, subtracts measured/default gas and
execution costs, and applies hard opening gates. A recommendation remains
observable when gated, but only ungated rows appear as actionable picks. Opening
one sends the exact PoolId (for v4), ticks, percentages and capital assumption
into the POOLS liquidity panel; it does not silently replace the range with a UI
default.

The indexer intentionally enumerates the entire official UP33 CL factory for
this feed. There is no fixed “first N pools” cutoff, so newly created Robinhood
markets—the likely home of a newly popular token—cannot disappear merely
because they sit at the registry tail. Market statistics still have to mature
and pass the model gates before a row becomes actionable.

`STRATEGY` is the opt-in execution layer. It supports chain-bound UP33,
Uniswap v3, PancakeSwap v3 and Uniswap v4 positions, including BSC native-BNB
v4 pools and Permit2. It records plans, signed transactions, receipts,
allocations, costs, P/L snapshots and recovery state before advancing. Browser
wallet sessions and admin tokens are scoped by chain, every executor response
is checked against the selected chain id, and the canonical gateway uses
`/_chain/<chain>/executor/*`; a compatibility host fails closed for a chain it
does not serve.

The normal frontend keeps browser-wallet signing. Enabling unattended execution
adds a hot signer: either an AES-256-GCM encrypted local vault protected by a
master-key file, or an explicit 0600 private-key file. Exact approvals remain
the default; low-transaction mode deliberately retains broader approvals and
must be treated as a separate risk choice. The API binds loopback and must sit
behind TLS, strict Origin filtering and authentication.

Recovery is conservative. Confirmed v3/UP33 steps are reconciled from durable
receipts and chain state. Confirmed v4 lifecycle mutations whose receipts do not
carry the v3 accounting events are quarantined for manual review instead of
guessing amounts; the same fail-closed rule applies to an unrecorded confirmed
native-profit swap. This can require operator intervention, but it cannot
silently invent balances and continue spending.

Useful checks:

```bash
npm run test:strategy
npm run smoke:strategy
npm run smoke:executor
CHAIN=bsc npm run executor
CHAIN=robinhood npm run executor
```

## Deploy

The frontend remains a static SPA. Production adds a thin stateless Caddy/nginx
BFF for same-origin data/RPC calls and one pool-indexer process per chain.
Interactive writes remain browser-signed; unattended writes exist only when the
separate stateful executor is explicitly deployed. Limit-order tags remain
device-local in chain-scoped `localStorage`.

Private RPC credentials are server concerns. Direct Uniswap and UP33 quotes are
on-chain reads, so MARKET and ZAP need no aggregator API key. Every frontend
bundle contains both chains; its build chain controls the default and the
compatibility host's unscoped paths:

| mode                         | chain reads                                                   |
| ---------------------------- | ------------------------------------------------------------- |
| personal / local dev         | `RPC` from `../.env` for the build chain, then public RPC     |
| canonical production         | same-origin `/_chain/<chain>/rpc`                             |
| compatibility production     | same-origin `/rpc` for that host's chain; public for the other |
| plain static hosting         | public RPC                                                    |

BSC Graph-backed bootstrap/discovery is the separate exception. Production
serves the full V4 pool directory from `/_chain/bsc/api` on the canonical host;
that indexer uses the Graph credential for mandatory, block-pinned V3 and V4
snapshots (V4 pages are pinned by a BSC-RPC-proven block hash and atomically
published as one generation) and periodic current-featured V4 raw-stat
refreshes. The browser-facing `/thegraph`
proxy remains for wallet-position discovery and the guarded V4 directory
fallback used only when the BSC indexer API is unreachable, too old, or serving
another chain. The key is server-only; never create a
`VITE_THEGRAPH_API_KEY` or
otherwise expose it to the bundle. BSC deployment fails closed when it is
absent. After verified snapshots exist, V3 and V4 keep tailing over RPC; a later
Graph outage leaves both local pool directories intact but pauses V4 raw-stat
refreshes and discovery of previously unseen wallet positions.

Wallet-facing chain metadata (`wallet_addEthereumChain`) always advertises the
**public** RPC — a private key-bearing URL never reaches users' wallets.

On top of all modes, **each user can bring their own RPC**: the footer `rpc:`
control accepts any http(s) JSON-RPC url, sanity-checks it with an `eth_chainId`
probe (must match the chain on screen), stores it in that browser's chain-scoped
localStorage and applies on reload. A user-set endpoint takes priority over
everything above; RESET returns to the deployment default.

### Self-hosting

`npm run build` produces a static `dist/` — hash routing needs no rewrite rules,
so any static host works (CF Pages / Netlify / S3):

```bash
RPC="" npm run build                     # BSC; RPC MUST be empty for a public build
RPC="" CHAIN=robinhood npm run build     # Robinhood
```

To keep a private RPC key server-side, serve `dist/` behind a reverse proxy that
terminates these same-origin paths. Nothing here is app-specific — any nginx /
caddy / Cloudflare Worker will do:

| path            | proxies to                             | why                                                                        |
| --------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| `/rpc`          | your JSON-RPC upstream for this chain  | the key stays server-side; the app auto-detects the path and uses it        |
| `/api`          | your `indexer` process on :8787        | pool discovery — optional, but the catalog is the good version              |
| `/executor`     | your build-chain executor on :8790/8791 | opt-in strategy API; strip the prefix and never expose it without TLS/auth   |
| `/kyber`        | `https://aggregator-api.kyberswap.com` | build with `KYBERSWAP_AGGREGATOR_API_BASE_URL=/kyber`                       |
| `/dexscreener`  | `https://api.dexscreener.com`          | TVL/volume enrichment                                                       |
| `/goldsky`      | `https://api.goldsky.com`              | UP33 v2 subgraph (Robinhood)                                                |
| `/thegraph`     | `https://gateway.thegraph.com`         | BSC position discovery and the guarded v4 fallback; the key stays in the proxy |

One chain per build, one indexer and (when enabled) one executor per chain, with
separate databases, vaults, API tokens and RPC credentials. To serve both chains
from a single origin, run a stack per chain and give each a fixed path namespace:
the bundle expects `/_chain/<chain>/rpc`, `/_chain/<chain>/api/*` and
`/_chain/<chain>/executor/*`, and enables those routes only when the runtime
`location.hostname` matches `VITE_CHAIN_GATEWAY_HOST` exactly, so the same build
stays safe on every other host. Refuse unscoped `/rpc` and `/api` on that
combined origin, and never map a namespaced executor to the other chain's
process. The client checks the executor's `x-lp-chain-id` response header as a
second boundary.

The supplied systemd templates run explicit per-chain instances. Put all
chain-specific values in root-owned files such as
`/etc/lp-terminal-indexer/bsc.env` and
`/etc/lp-terminal-executor/bsc.env`, then enable the matching instances:

```bash
sudo systemctl enable --now lp-terminal-indexer@bsc lp-terminal-indexer@robinhood
sudo systemctl enable --now lp-terminal-executor@bsc lp-terminal-executor@robinhood
```

An executor environment must at least align `CHAIN`,
`LP_EXECUTOR_CHAIN_ID`, `LP_EXECUTOR_PORT`, `LP_EXECUTOR_DATA_DIR`,
`LP_EXECUTOR_INDEXER_BASE`, the three secret-file paths, and
`LP_EXECUTOR_ALLOWED_ORIGIN`. Use different directories and secret files for
`bsc` and `robinhood`; example keys and the expected ports are documented in
`.env.example`. The templates are `deploy/lp-terminal-indexer@.service` and
`deploy/lp-terminal-executor@.service`.

Routing the data APIs through your own origin means the browser only ever talks
to your origin + the chain RPC + wallet relays, so users on restrictive networks
keep every feature. Recommended if you expose these publicly: rate-limit `/rpc`
per-IP plus a global ceiling, and 403 requests carrying a foreign browser
`Origin` so other sites can't burn your upstream quota through users' browsers.
No-Origin clients (scripts) can stay allowed and rate-limited.

`vite.config.ts` exposes the full chain namespaces in dev, so a chain switch
stays on `127.0.0.1:5173` and reaches isolated local sidecars. Start the two
indexers (and the optional executors) in separate terminals:

```bash
npm run indexer:robinhood   # :8787
npm run indexer:bsc         # :8788
npm run executor:robinhood  # :8790, optional
npm run executor:bsc        # :8791, optional
CHAIN=robinhood npm run dev
```

Preview retains the single build-chain compatibility routes, so that server
mode is testable locally without deploying anything:

```bash
RPC="" npm run build && npm run preview   # /rpc upstream stays in the node process
```

Two constraints worth knowing before you touch the build config:

- Relative API bases need `new URL(x, location.origin)` — a bare
  `new URL('/kyber/…')` throws and silently kills all quotes.
- viem's `ccip` module is the bundle's only lazy chunk on an error path, and it
  is imported inside **every** eth_call error before the selector check. It is
  deliberately pinned into the eager bundle (`src/main.tsx`) so a redeploy can't
  404 it under an open tab and mask the real revert reason. Other stale lazy
  chunks (wallet SDKs, RainbowKit locales) are handled by a `vite:preloadError`
  guarded auto-reload. Serve old + new asset generations side by side across a
  deploy if you want open tabs to survive it.

Other targets:

- **Plain static hosts** (CF Pages / Netlify / S3): `RPC="" npm run build`, deploy
  `dist/` — hash routing needs no rewrite rules and reads use the public RPC.
  They provide neither the self-hosted `/api` catalog nor the credentialed
  `/thegraph` fallback by default, so BSC v4 catalog and position discovery are
  unavailable (selected/already loaded on-chain actions and v2/v3 remain
  usable).
- **Local emulation of the server mode**: `RPC="" npm run build && npm run preview`
  (the preview server emulates the data and RPC proxies).

## Security

Threat model researched against real dApp incidents (BadgerDAO injected-script
approval drain, Curve/CoW DNS hijacks, Ledger Connect Kit npm supply chain) and
the OWASP Web3 attack-vector list. The default architecture remains a static SPA
plus a stateless reverse proxy. The optional executor is a distinct, stateful
trust boundary with loopback binding, authenticated APIs, chain-isolated data,
encrypted vaults, durable transaction journals and explicit operator recovery.

**Wallet-interaction safety (the money paths)**

- browser-wallet signing only in the standard frontend; no key material is sent
  to the SPA server or browser storage. An explicitly enabled executor keeps its
  signer only in its encrypted local vault or configured 0600 file
- exact-amount approvals by default; executor low-transaction mode is an
  explicit exception that retains allowances/operator approval. Selected direct router, route, assets, recipient and net
  minimum are gated before signing; writes are chainId-pinned with deadlines
- terminal fees execute atomically with the swap; native-route minimums come from
  fresh on-chain quotes
- token picker rows always show the contract address (anti symbol-spoofing);
  contract directory lists full addresses linked to the explorer

**XSS / injected-drainer defenses**

- CSP `script-src 'self'`: no inline scripts, no eval, no third-party or CDN
  scripts — everything self-hosted and content-hashed. React escaping only
  (no `dangerouslySetInnerHTML`), `noreferrer` on external links
- headers: `X-Frame-Options DENY` + `frame-ancestors 'none'` (clickjacking),
  `nosniff`, `Referrer-Policy`, `Permissions-Policy` (all sensors off),
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` (wallet popups still work),
  `frame-src` limited to WalletConnect verify. HSTS at the edge
- `connect-src` stays `https:/wss:` by design: the footer bring-your-own-RPC
  feature and wallet relays need it; the script-src wall is the real defense

**Supply chain**

- dependencies exact-pinned (`.npmrc save-exact`) + lockfile — a compromised
  patch release can't slip in via re-install (Ledger-style attack)
- `npm audit` on every dependency change; transitive `axios` and `ws` versions
  are held at the reviewed root override until their parent dependency floors
  catch up
- zero analytics/trackers/third-party runtime scripts

**Frontend integrity (DNS/CDN hijack detection)**

- fetch your own LIVE site the way a user does and byte-compare every file
  against your local build. Anything injected in transit shows up as a diff.
  Worth running at the end of every deploy, and any time you are suspicious
- the CSP blocks inline-script injection at the browser level even if the HTML
  were tampered with on the way

**If you put a CDN in front of it**

- terminate TLS strictly end to end, and lock the origin so it only completes
  handshakes with the CDN — direct-to-IP scans then get nothing
- restrict certificate issuance with CAA records, and turn DNSSEC on
- registrar and CDN accounts: hardware-key 2FA and minimal-scope API tokens
  (BadgerDAO fell to a leaked Cloudflare API key)
- watch certificate-transparency logs (crt.sh) for certs you did not ask for

## Known v1 limits

- ZAP considers supported direct single-pool Uniswap v2/v3/v4 and home-DEX
  routes only; it does not split orders. MARKET additionally compares a
  split-routing solver quote and picks the best net output, and falls back to
  direct routes alone on a chain with no solver configured.
- UP33 Solidly v2 is excluded from swaps until it has an atomic terminal-fee path.
  Its LP discovery and liquidity features are unaffected.
- Kyber route quotes are used only for non-transactional USD valuation. Kyber is not
  selected by MARKET or ZAP, and the codebase exposes no Kyber transaction builder.
- veUP locking / voting / bribes are read-only concerns for later versions.
- Uniswap v2/v3 long-tail pools outside GeckoTerminal's top-200 lists show
  chain-derived TVL but no 24h volume (blank VOL/FEES/APR columns) — computing
  volume ourselves would mean indexing ~2.6M Swap events/day (measured);
  deliberately skipped.
- Uniswap v2 POSITIONS management (LP-token balances, remove-liquidity) is not
  wired yet — POOLS browse + add-liquidity only. v2 LPs are plain ERC-20s, so
  wallet-level tracking works meanwhile.
- Creating a NEW univ3 pool (`createAndInitializePoolIfNecessary`) is not
  wired up — mint into existing pools only.
- Uniswap v4 is live on Robinhood Chain but not wired there (`uniV4: null` in
  its chain config; the indexer's catalog model extends to v4's `Initialize`
  events if/when wanted). The BSC build swaps, reads and writes v4.
- BSC V3 and V4 bootstrap snapshots, V4 raw-stat refreshes and wallet-position
  discovery use The Graph. An outage blocks a fresh V3/V4 bootstrap and hides
  previously unseen wallet NFTs, but completed V3/V4 catalogs keep tailing over
  RPC and the full local V4 directory remains browseable. Selected or already
  loaded V4 positions still use on-chain reads/writes.
