# LP TERMINAL

Personal terminal-style frontend for LPs on Robinhood Chain (chainId 4663):
UP33 (ve(3,3) DEX) plus the official **Uniswap v2 + v3** deployments. POSITIONS
shows and manages UP33 + univ3, POOLS browses/adds liquidity across all three,
distinguished by protocol badges (brand mark + colored label). Discovery runs
on a self-hosted **pool indexer** (see below) with a client-side fallback.
UI is branded **LP TERMINAL** (general LP terminal, terminal *style* — full-bleed
layout, not a boxed console); domain will eventually move to `lp-terminal.xyz`,
`up33-terminal.xyz` serves it for now. (Repo dir keeps the historical name.)
Contract reference: `docs/up33-contract-map.md`.

Unattended LP strategy development and production operations are documented in
[`docs/LP_STRATEGY_HANDOFF.zh-CN.md`](docs/LP_STRATEGY_HANDOFF.zh-CN.md). Start
there before changing the executor, recovery logic, production data, or wallet
secrets.

## Run

```bash
npm install
npm run smoke     # optional: live-chain read-layer validation (TickMath, ABIs, quotes)
npm run indexer   # pool indexer on :8787 (first boot backfills ~10 min; optional but
                  # recommended — without it POOLS falls back to dexscreener discovery)
npm run dev       # http://localhost:5173 (proxies /api -> :8787)
```

Local environment comes from the repo-root **`.env`** (via Vite `envDir`;
copy `.env.example` to get started):

| key | use |
|---|---|
| `RPC` | private Robinhood Chain RPC (**secret** — personal/local builds only; leave unset for public builds, see Deploy) |
| `KYBERSWAP_FEE_RECEIVER` | required build-time address that receives the fixed 9 bps terminal output fee (legacy env name) |
| `KYBERSWAP_AGGREGATOR_API_BASE_URL` | Kyber API used for read-only USD valuation; MARKET and ZAP do not call it |
| `KYBERSWAP_CHAIN` | Kyber valuation chain slug (`robinhood`) |
| `VITE_SOLVER_URL` | optional override for the swap-solver quote API (defaults to the hosted public instance) |
| `VITE_WALLETCONNECT_PROJECT_ID` | optional; only needed for WalletConnect QR pairing (injected wallets work without it) |

MARKET and ZAP charge the same **9 bps terminal output fee**. Direct swaps send
their gross output to the selected router and complete the swap plus fee sweep in
one transaction; displayed output and minimum-output checks are net of the fee.
Fee policy and slippage stay independent. Non-transactional valuation (UP rewards,
APR, positions and add-LP simulations) uses a fee-free Kyber quote; that display
price never enters route selection, Zap sizing, minimum output or execution.

Normal terminal writes are browser-wallet only (RainbowKit / injected EIP-6963).
The optional unattended strategy executor is a separate opt-in service that can
store a dedicated hot-wallet key in an encrypted server-side vault; see the
handoff document above. Private keys are never stored by the static frontend.

**i18n (en/zh)**: react-i18next with typed keys — catalogs in `src/i18n/en.ts` (source of
truth) + `zh.ts` (`typeof en` enforces identical key structure at compile time). Language:
header `lang:` switcher, persisted (`up33.lang.v1`), `?lang=` view-only override
(screenshots), `<html lang>` + RainbowKit modal locale follow. Non-React modules
(tx step labels, zap planner) import the singleton `t` from `src/i18n`; revert hints
resolve lazily so they follow the active language at error time. Number/date formats
stay en-US in both locales (terminal convention; zh uses the same digit grouping).
The `#lab` dev page stays English.

## Tabs

Keyboard: `1–3` switch tabs, `4` opens LIMIT, `/` focuses the pool filter. Tabs
are hash-routed (`#pools`, `#swap`, …) so reloads and deep links keep your
place. `#lab` renders the component lab (synthetic data) for visual tweaking.
(The old DASH tab was removed with the LP-terminal refocus. The header carries
the block number, the `lang:` switcher and the wallet; the contract directory
lives in `docs/up33-contract-map.md`. Epoch/flip were dropped from the header —
an LP reads them off the emissions columns, and the countdown was re-rendering
the header every second to show it.)

- **[1] POOLS** — one table, three protocols, sorted by volume by default (where the trading actually is; TVL is one click away). UP33 v2 + CL pools come from live factory enumeration; **Uniswap v2 + v3 pools** come from the pool indexer (`/api` — the FULL catalog built from factory events — six figures and growing ~20k pools/day, launchpads mint univ3 pools continuously — chain-derived TVL, GeckoTerminal stats). Columns: fee rate, reserves/price, **TVL / VOL / FEES** with a synchronized **5M / 1H / 6H / 24H** selector (intraday windows for DexScreener/GeckoTerminal-covered pools; uncovered and Goldsky-only pools stay blank), **FEE APR / EMIT APR**, UP/wk emissions, vote share; fees use selected-window volume × pool rate while FEE APR remains 24h-based. All numeric headers are sortable; `● MY POOLS` marks pools you're in. The `UNISWAP ⌕` row searches the whole catalog — token address / pool address / symbol / `sym0/sym1` pair, empty = everything by TVL — with a `HIDE <$1K` dust chip (on by default: 95% of the catalog is dust meme pools); if the indexer is down it falls back to DexScreener discovery with on-chain `factory.getPool` verification (v3 top 30, amber notice). Inline add-liquidity everywhere: v2 auto-ratio (UP33 Solidly router or vanilla Router02, per pool); CL/univ3 with the full range picker — symmetric presets (±0.5/1/2/5/10/20/30%, FULL), custom ±%, **one-sided ↑ABOVE / ↓BELOW** (single-token deposits that start earning when price enters — sell-the-rise / buy-the-dip), **price-bounds input** (snapped to tick spacing), raw ticks — with a live range-bar preview; amounts rebalance automatically when the range changes. univ3 mints go through the official NPM (fee-keyed mint struct, no levy, no gauge — fee APR only).

  **⚡ ZAP — one-token add (all four pool kinds + increase)**: every add panel has a `FUND: PAIR | ⚡ ZAP` switch. ZAP funds the position with ONE token (either side, or native ETH when a side is WETH — wrapped as step 1): it solves how much to swap so the two piles match the deposit ratio the target needs (CL band math / v2 reserves), then compares direct Uniswap and UP33 CL quotes for that swap. It previews the plan (`SPLIT / SWAP` with net min-out + impact + route, `DEPOSIT` with est. dust, `PROJECTED` APRs), lists the exact tx sequence (numbered, live states), then runs it step by step: wrap? → approve → direct swap with atomic 9 bps fee → approve both sides → mint / increase / addLiquidity. There is no aggregator allocation or route splitting. The displayed plan and its minimum are frozen when execution starts; the deposit uses the amounts that **actually arrived** (receipt Transfer logs), never the quote. Any failure **halts** — every intermediate asset is a normal wallet balance, nothing strands. `REWARDS` column shows its full emissions sub-line only under the `UP33` filter (elsewhere it's a slim `—`/APR column).

  APR semantics (ve(3,3): a position earns one or the other, never both):
  - `FEE APR` — **unstaked** LP net fee yield: `vol24h × feeRate × 365 / TVL`, CL further × (1 − unstaked levy). Staked LPs earn **zero** fees (theirs go to the pool's voters). CL number is the pool average — a concentrated in-range position earns proportionally more.
  - `EMIT APR` — **staked** LP UP yield: `rewardRate × 31.536M × UP price / staked TVL`, where staked TVL is v2 `gauge.totalSupply/pool.totalSupply × TVL`, CL `stakedLiquidity/liquidity × TVL` (active-liquidity proxy; out-of-range staked earns nothing). `rewardRate` is the live post-cap stream, so gauge-cap burns are already reflected; it is only committed until the Thursday flip (`periodFinish`), and later cap releases within an epoch can raise it (values refresh live). `∞` = emissions streaming to ~zero staked TVL (first staker takes it all).
  - Simple APR, no compounding; both dilute as TVL/staked TVL grows.
  - **Add-LP simulation**: both add panels show a `PROJECTED` line for *your* prospective position — deposit USD (priced via USDG/WETH/UP anchors), your share of active liquidity, and your fee/emit APR. For CL this is position-specific: `share = L_yours / (activeLiquidity + L_yours)` (fees) and `/ (stakedLiquidity + L_yours)` (emissions), so range concentration and self-dilution are captured exactly — e.g. a ±2% range earns several× the pool-average APR while in range. Out-of-range ranges warn that they earn nothing.
- **[2] POSITIONS** — summary strip (**LP VALUE** in USD across everything incl. uncollected fees, **PENDING UP** with USD value + live `+UP/day` accrual + **CLAIM ALL**, range status, open range-order count with filled alert), then every held LP sorted staked-first / biggest-first. Every card answers the two questions an LP manages by — **worth** (`value ≈ $…`, tokens priced off the pool's own price against USDG/WETH/UP anchors; fees/pending shown in USD too) and **earning right now** (`earning` line: staked → `UP/day + $/day + APR + share of staked liq`; unstaked/univ3 in range → `fee APR + $/day + share of active liq` from 24h stats — indexer stats fetched per held uniswap pool; out of range → red zero; emissions dry → amber). **Multi-protocol**: UP33 CL/v2 positions plus wallet positions from the official Uniswap v3 NPM (`0x7399…E0D3`, pairing chain-verified — Blockscout also lists several unofficial forks). Each card carries a protocol badge (UP arrow / Uniswap unicorn, brand-colored). Uniswap pools are discovered per position via `factory.getPool`, unknown pair tokens get erc20 metadata fetched live, fees use the same `collect`-simulation, and increase/decrease/collect/withdraw all work (write entrypoints are signature-identical; only the NPM address differs). No staking on univ3 (no gauges), and SWAP→LIMIT tags never attach to univ3 ids (tokenIds are only unique per NPM):
  - CL: **range bar** (ends = your price bounds, marker = current price, % drift to each bound, re-entry distance when out of range, in/near/out coloring), holdings, uncollected fees (exact, via `collect` simulation) or pending UP when staked. Actions: stake/unstake, claim UP, collect fees, increase, decrease (decrease+collect), withdraw (double-click confirm). The increase panel shows wallet balances + MAX, auto-links the two amounts at the live pool price, and previews the exact pull/new size — the range itself is immutable (`increaseLiquidity` has no tick params; it stacks liquidity on the band fixed at mint). Range orders placed via SWAP→LIMIT carry a `LIMIT sell→buy` badge, an order-mode range bar (waiting/filling x%/filled instead of the red out-of-range alarm, priced in the sell token), and a state-aware one-click action: `CANCEL — GET <sell> BACK` (unfilled) / `CLOSE NOW` (partial) / `WITHDRAW → LOCK IN <buy>` (filled); the tag clears on 100% withdraw.
  - after any claim (or CL unstake, which auto-claims) confirms, the log shows the exact UP received with a **SWAP → ETH** button — it jumps to SWAP prefilled with the claimed amount.
  - v2: wallet vs staked LP, underlying amounts, claimable pool fees, pending UP. Actions: stake all / unstake all / claim UP / claim fees / remove %.
- **[3] SWAP** — two modes:
  - **MARKET** — compares direct **Uniswap v2/v3** and **UP33 CL** quotes side-by-side and selects the best net output by default. The quote-derived price impact chooses 0.5% (green), 1% (amber), or 3% (red) slippage; users can override it with the same three explicit values. If the amount is too small for a distinct impact probe, AUTO stays unavailable and the user must choose a slippage explicitly. The selected route executes with an atomic 9 bps terminal output fee and no silent provider fallback. UP33 Solidly v2 is deliberately excluded because its router has no atomic fee-sweep path. ETH⇄WETH wrap/unwrap is built in.
  - **LIMIT · SELL VIA LP** (`#limit`, key `4`) — sell a token with a **one-sided CL range order**. The point is **maker-not-taker economics**: a market swap through the pool pays its fee (1% on WETH/UP); a range order pays none and *earns* fees while filling (the panel shows the comparison and an est. $/day while in-band). Pick sell/buy tokens (auto-picks the deepest CL pool; chips if several fee tiers), 25/50/75/MAX amount chips with USD estimate, choose a band: **TIGHT · 1 TICK** (default — one tick-spacing hugging market, fills on the first uptick) or +1→3% … +10→25% / custom, snapped to tick spacing; a `?` chip opens a structured band explainer (start/end/avg/grid rows). The panel renders as a structured **order ticket** (aligned key-value sections, no prose walls) phrased in the sell token's price: `ORDER` (fill-start / fully-sold / avg-fill premiums with exact prices — avg is the band's geometric mean, exact closed form — band ticks with a `≡ TIGHT` marker when a small custom band snaps onto the tight one, order-mode range bar), `PROJECTED · FULL FILL` (avg price vs market, exact proceeds + USD, est. fee income $/day while in band), `FEES · MAKER VS TAKER` (0% vs pool fee ≈ $ on your size), `MECHANICS` (fills / un-fills / after-fill withdraw / don't stake). Placing mints an out-of-range one-sided position (sell-side min ≈ 100% guards against the price having entered the band). Fills as the token appreciates through the band and earns pool fees while filling; **un-fills if price retreats** and nothing auto-executes — withdraw after fill to lock in.

## Safety rails

- MARKET and ZAP swap commits share one `lib/swapExec.ts` sequence: fresh quote/build for the selected direct route → fixed router/asset/recipient/minimum gate → exact approval → re-prepare after a real approval → chain-pinned send → receipt → actual output check. A selected route failure always stops; it never falls through to another protocol. Kyber is exposed only as a fee-free USD valuation function; the codebase has no Kyber transaction builder or execution intent.
- Uniswap v2/v3 and UP33 CL swaps execute the swap and 9 bps terminal output fee atomically in router multicalls. Minimum output is expressed net of the fee and converted to the required gross router minimum, so lowering slippage never substitutes for fee collection.
- Auto slippage is a small deterministic policy over quote-derived price impact: 0.5% green, 1% amber, 3% red. A manual choice replaces the automatic tier. ZAP additionally requires the fresh route's `tokenOut` to be the pool's counter-token and never widens the frozen preview minimum during execution. Deposits then use the received-amount ground truth from the receipt, and approvals stay exact-amount per step.
- Browser-wallet flows use exact-amount approvals. The unattended executor has
  a separately confirmed low-transaction option for persistent approvals.
- All writes pinned to chainId 4663; wrong-network banner blocks confusion.
- Everything reads live on-chain state each ~15s (protocol went live 2026-07-16; parameters are Safe-controlled and can change anytime). Pools hosting your range orders get a dedicated **4s slot0 feed** (single multicall) so fill %, holdings and the range bar track near-live; numeric updates flash **green ▲ / red ▼** by direction, and the range-bar marker glides so drift direction is visible.

## Pool indexer (`indexer/`)

The heavier backend behind uniswap discovery. Zero npm dependencies beyond the
app's own (`viem`, `tsx`; storage is node's built-in `node:sqlite`, requires
node ≥ 22.13). One process, four loops, a read-only HTTP API:

- **Catalog** — the authoritative pool list, built ONLY from the official
  factories: univ3 `PoolCreated` logs (backfill via Blockscout's uncapped
  etherscan-style `getLogs`, ~22 pages for full history, with automatic
  fallback to windowed RPC `getLogs` if Blockscout flakes; then a 10s RPC
  tail), univ2 `allPairsLength`/`allPairs` enumeration (backfill == tail).
  Third-party APIs never admit a pool — they only enrich — so spoofed/fork
  pools are structurally excluded (stronger than the old per-query
  `factory.getPool` round-trip, which remains as the client-side fallback).
- **State sweeps** (multicall, 400 calls/aggregate) — univ3: `slot0` +
  `liquidity` + both erc20 balances; univ2: `getReserves` + `totalSupply`.
  Hot pools (TVL ≥ $10k, GT-listed, or < 1h old) refresh every 60s; the whole
  catalog hourly (~280 aggregates); new pools immediately.
- **Pricing waterfall → TVL** — GeckoTerminal token prices seed (ground truth
  while < 30 min old), then prices propagate through the deepest priced-side
  pool (≥ $300 depth so dust can't set prices), USDG ≈ $1 bootstraps before
  the first GT cycle. TVL = sum of priced sides (one side priced → 2×, flagged
  approximate). All REAL numbers are display/ranking only — never tx inputs.
- **Stats** — GeckoTerminal top lists (network + uniswap-v2 + uniswap-v3, top
  200 each, paced ≤ 30 calls/min free tier) every 5 min: 5m/1h/6h/24h volume + 24h txns +
  GT's own reserve figure. GT has no UP33 entry — UP33 stats stay on the
  frontend's dexscreener/goldsky path.
- **API** — `GET /api/pools?q=&proto=univ2,univ3&min_tvl=&sort=tvl|vol|created&limit=&offset=`
  (response shape mirrors the frontend's `PoolsData`/`PoolStat`; bigints as
  strings; `ready:false` while the first backfill runs → frontend keeps its
  fallback), `GET /api/tokens?q=` (symbol/address autocomplete),
  `GET /api/health` (counts, cursors, rss).

Data lives in `indexer/data/index.db` (WAL SQLite); delete it to re-backfill
from scratch — the kv cursors make every loop resumable. Measured context for
the design (2026-07-16): ~100k+ univ3 pools **growing ~20k/day** (launchpad
factories mint a pool per token; ⚠ an earlier Blockscout-paged count said
21,979 — a silent-undercount artifact, the RPC-window scan is ground truth) +
11,640 univ2 pairs, ≥95% dust, 100ms blocks (~862k/day), ~2.6M Swap events/day
chain-wide — which is why volume comes from GT instead of self-indexed swaps
(revisit with Envio HyperIndex, which supports chain 4663 natively, if
self-computed fee/APR analytics are ever wanted). At this scale a full state
sweep is ~1k multicall aggregates (~7 min hourly); the hot tier stays tiny
because real TVL, not pool count, bounds it.

## Deploy

The frontend remains a static SPA. Production adds a thin stateless reverse-proxy
boundary for same-origin data/RPC calls and the pool-indexer process; wallet
writes are still created and signed only in the browser. Limit-order tags remain
device-local in `localStorage`.

Private RPC credentials are server concerns. Direct Uniswap and UP33 quotes are
on-chain reads, so MARKET and ZAP need no aggregator API key. One frontend build
serves every server deployment:
The default wallet-confirmed app is a **fully static SPA**. Optional unattended
strategies are an explicit opt-in through the separate loopback-only `executor/`
service, which stores an imported hot-wallet key in a locally encrypted vault.
UP33 CL strategies may also adopt an NFT already deposited in a live gauge.
For those strategies the executor proves depositor custody, withdraws the old
NFT when its range breaks (the withdrawal auto-claims UP), sells only the UP
received by that withdrawal into WETH and, for non-WETH quote pairs, performs a
second WETH-to-quote swap. The final quote asset is held or reinvested before the
LP is rebuilt, then the replacement NFT is approved and deposited into the same gauge.
Every added transaction is nonce/hash tracked and recovery can resume after the
withdrawal, reward swap, mint, NFT approval, or gauge deposit. Unstaked and
Uniswap strategies retain the original execution path.
An optional **low-transaction mode** keeps the original exact-approval mode
available while changing future cycles to: multicall decrease+collect, retain
the empty old NFT, keep maximum ERC-20 allowances for the position manager and
selected swap routers, and grant the configured gauge ERC-721 operator approval.
Those persistent approvals survive disabling/deleting a strategy until revoked
on-chain; switching the setting off changes future execution but is not itself
an approval-revocation transaction.
The browser otherwise talks directly to the chain RPC for reads; writes are
signed and sent by the user's wallet. Limit-order tags remain device-local in
browser `localStorage`.

| mode | chain reads |
|---|---|
| personal / local dev | `RPC` from `.env` or public RPC |
| server (recommended) | same-origin `/rpc` |
| plain static hosting | public RPC |

Wallet-facing chain metadata (`wallet_addEthereumChain`) always advertises the
**public** RPC — a private key-bearing URL never reaches users' wallets.

The executor should read provider and signer secrets from root-owned/config-only
files rather than command-line arguments:

```bash
LP_EXECUTOR_RPC_FILE=/etc/lp-terminal-executor/rpc.url
LP_EXECUTOR_RPC_RETRY_COUNT=5
LP_EXECUTOR_RPC_RETRY_DELAY_MS=400
LP_EXECUTOR_RPC_TIMEOUT_MS=15000

# Optional raw-file signer (use both variables together):
LP_EXECUTOR_PRIVATE_KEY_FILE=/etc/lp-terminal-executor/wallet.key
LP_EXECUTOR_PRIVATE_KEY_WALLET_ID=wallet_server_01
```

Each file must be a regular file with permissions `0600` or stricter. The RPC
file contains one complete `http(s)` endpoint. The signer file contains one
`0x`-prefixed 32-byte private key. `LP_EXECUTOR_RPC` and
`LP_EXECUTOR_RPC_FILE` are mutually exclusive. Read/preflight calls retry short
provider outages; raw broadcasts only retry the exact same locally hashed,
durably recorded transaction.

On top of all modes, **each user can bring their own RPC**: the footer `rpc:`
control accepts any http(s) JSON-RPC url, sanity-checks it with an `eth_chainId`
probe (must be 4663), stores it in that browser's localStorage and applies on
reload. A user-set endpoint takes priority over everything above; RESET returns
to the deployment default.

### Self-hosting

`npm run build` produces a static `dist/` — hash routing needs no rewrite rules,
so any static host works (CF Pages / Netlify / S3):

```bash
RPC="" npm run build   # RPC MUST be empty for any build you serve publicly
```

To keep a private RPC key server-side, serve `dist/` behind a reverse proxy that
terminates these same-origin paths. Nothing here is app-specific — any nginx /
caddy / Cloudflare Worker will do:

| path | proxies to | why |
|---|---|---|
| `/rpc` | your JSON-RPC upstream | key stays server-side; app auto-detects and uses it |
| `/kyber` | `https://aggregator-api.kyberswap.com` | build with `KYBERSWAP_AGGREGATOR_API_BASE_URL=/kyber` |
| `/dexscreener` | `https://api.dexscreener.com` | UP33 TVL/volume stats |
| `/goldsky` | `https://api.goldsky.com` | UP33 v2 subgraph |
| `/api` | your `indexer` process on :8787 | uniswap pool discovery (optional) |

Routing the data APIs through your own origin means the browser only ever talks
to your origin + the chain RPC + wallet relays, so users on restrictive networks
keep every feature. Recommended if you expose these publicly: rate-limit `/rpc`
per-IP plus a global ceiling, and 403 requests carrying a foreign browser
`Origin` so other sites can't burn your upstream quota through users' browsers.

`vite.config.ts` emulates every one of these proxies in dev and preview, so the
server mode is testable locally without deploying anything:

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

## Security

Threat model researched against real dApp incidents (BadgerDAO injected-script
approval drain, Curve/CoW DNS hijacks, Ledger Connect Kit npm supply chain) and
the OWASP Web3 attack-vector list. Architecture principle: **static SPA + thin
stateless reverse proxy = minimal attack surface** — no accounts or application
database; server-side credentials are limited to upstream RPC access.

**Wallet-interaction safety (the money paths)**
- browser-wallet signing only in the standard frontend; no key material in the
  app, server, or browser storage. The separately enabled local executor keeps
  its hot-wallet key only in an AES-256-GCM encrypted local vault.
- exact-amount approvals by default; the explicitly enabled executor low-tx
  mode instead retains maximum token allowances and gauge operator approval.
  Selected router, route, assets, recipient and net minimum remain gated before
  signing; writes are chainId-pinned with deadlines
- terminal fees execute atomically with the swap; native-route minimums come from
  fresh on-chain quotes
- token picker rows always show the contract address (anti symbol-spoofing);
  contract directory lists full addresses linked to the explorer

**XSS / injected-drainer defenses**
- CSP `script-src 'self'`: no inline scripts, no eval, no third-party or CDN
  scripts — everything self-hosted and content-hashed. React escaping only
  (no `dangerouslySetInnerHTML`), `noreferrer` on external links
- recommended headers when self-hosting: `X-Frame-Options DENY` +
  `frame-ancestors 'none'` (clickjacking), `nosniff`, `Referrer-Policy`,
  `Permissions-Policy` (all sensors off), `Cross-Origin-Opener-Policy:
  same-origin-allow-popups` (wallet popups still work), `frame-src` limited to
  WalletConnect verify, HSTS at the edge
- `connect-src` stays `https:/wss:` by design: the footer bring-your-own-RPC
  feature and wallet relays need it; the script-src wall is the real defense

**Supply chain**
- dependencies exact-pinned (`.npmrc save-exact`) + lockfile — a compromised
  patch release can't slip in via re-install (Ledger-style attack)
- `npm audit` on every dependency change. Known open advisory: `ws` DoS via
  wagmi's WalletConnect chain — server-side-only issue, browsers use native
  WebSocket; the fix is a wagmi v2→v3 major migration, deferred deliberately
- zero analytics/trackers/third-party runtime scripts

**If you self-host publicly**, the frontend-integrity risk worth planning for is
DNS/CDN hijack: fetch your own live site the way users do and byte-compare
against your local build. A CSP with no inline scripts blocks injection at the
browser level even if HTML were tampered in transit.

## Known v1 limits

- MARKET and ZAP consider direct single-pool Uniswap v2/v3 and UP33 CL routes only;
  they do not split orders or use aggregator multi-hop routing.
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
- Uniswap v4 is live on the chain but not integrated (addresses noted in
  `src/config/addresses.ts`; the indexer's catalog model extends to v4's
  `Initialize` events if/when wanted).

## Disclaimer

This software is provided as-is under the MIT license, with **no warranty of any
kind**. It is an unaudited interface to third-party smart contracts that this
project does not control, on a chain whose protocol parameters are Safe-controlled
and can change at any time. Interacting with DeFi protocols can result in total
loss of funds. You are solely responsible for reviewing the code, verifying every
contract address, and for any transaction your wallet signs. Nothing here is
financial advice.
