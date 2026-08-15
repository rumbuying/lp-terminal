import type { Address, Hex } from 'viem'
import type { KnownToken } from './knownTokens'
import type { LaunchpadConfig } from './launchpad'
import type { StockIssuerAnchor } from './stockIssuers'

/**
 * Every chain the terminal can be built for.
 *
 * A literal union, not `number`: wagmi narrows `usePublicClient({ chainId })`
 * against the ids in its config, and widening this to `number` makes every
 * client possibly-undefined at ~40 call sites.
 */
export type SupportedChainId = 4663 | 56

/**
 * ve(3,3) governance. Robinhood Chain runs UP33; a chain without an emissions
 * protocol sets `gov: null` and every surface that reads it is gated behind
 * FEATURES.emissions (see config/features.ts).
 */
export type GovAddresses = {
  UP: Address
  VE_UP: Address
  VOTER: Address
  MINTER: Address
}

/**
 * The chain's home DEX: a univ3-family concentrated-liquidity protocol plus its
 * v2 sibling. UP33 on Robinhood, PancakeSwap on BSC. The CL_* write entrypoints
 * are signature-identical to Uniswap v3's NonfungiblePositionManager on both
 * (Slipstream and Pancake v3 are each a v3 fork), which is why one set of ABI
 * fragments drives both slots.
 */
export type HomeDexAddresses = {
  V2_FACTORY: Address
  V2_ROUTER: Address
  CL_FACTORY: Address
  CL_PM: Address
  CL_SWAP_ROUTER: Address
  CL_QUOTER: Address
  /** the ERC-20 wrapper for the chain's native coin: WETH here, WBNB there */
  WNATIVE: Address
  /** the USD unit every mark is quoted in: USDG here, USDT there */
  STABLE: Address
}

/** Official Uniswap deployment on the chain. */
export type UniAddresses = {
  V3_FACTORY: Address
  V3_NPM: Address
  V3_QUOTER: Address
  V3_SWAP_ROUTER: Address
  V2_FACTORY: Address
  V2_ROUTER: Address
}

export type ChainConfig = {
  /** build selector value — `CHAIN=<key>` picks this module */
  key: string
  id: SupportedChainId
  /** full name, as shown to wallets in a wallet_addEthereumChain suggestion */
  name: string
  /** the uppercase chip the tabs render */
  shortName: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  /** the ERC-20 wrapper's symbol: WETH here, WBNB there */
  wrappedSymbol: string
  /** display metadata for addr.STABLE — BSC-USDT is 18 decimals, not 6 */
  stable: { symbol: string; decimals: number }
  /** key-free public RPC — wallet-safe chain metadata and last-resort transport */
  publicRpc: string
  explorer: {
    name: string
    url: string
    /**
     * Which REST shape the explorer speaks. This is load-bearing: v2 LP
     * discovery enumerates a holder's ERC-20 balances, and Blockscout's
     * /api/v2/addresses/{a}/tokens has no Etherscan equivalent.
     */
    api: 'blockscout' | 'etherscan'
    /** how a token id under an NFT contract is linked (the two differ) */
    nft: (token: Address, id: string | bigint) => string
  }
  addr: HomeDexAddresses
  uni: UniAddresses
  gov: GovAddresses | null
  /**
   * How the home CL protocol identifies a pool — the one structural difference
   * between the two chains. UP33's Slipstream fork keys pools by tick spacing;
   * PancakeSwap v3, like Uniswap v3, keys them by fee tier (with a 2500 rung
   * Uniswap does not have). Route validation and pool discovery branch on this.
   */
  homeCl: { keyedBy: 'tickSpacing' } | { keyedBy: 'fee'; fees: readonly number[] }
  /**
   * A farm that takes CUSTODY of home-CL position NFTs, or null where staking
   * works some other way.
   *
   * Both chains move the NFT when a position is staked; they differ in who
   * holds it and how you ask. Robinhood stakes into a PER-POOL gauge, and the
   * pool registry already carries `gauge`, so `stakedValues(user)` finds those.
   * PancakeSwap stakes into ONE MasterChefV3 with no per-pool handle at all —
   * without this field a farmed position is simply invisible, because
   * `npm.balanceOf(user)` reports the farm as the owner and not the user.
   */
  homeClFarm: {
    address: Address
    /** the reward token, so the UI can name it — it is NOT the emissions token */
    reward: { symbol: string; decimals: number }
  } | null
  /**
   * How a swap through the home DEX's v2 leg is quoted and executed, or `null`
   * where it cannot be.
   *
   * Null on Robinhood: UP33's v2 is a Solidly fork whose router takes an array
   * of `(from, to, stable)` route structs rather than a plain address path, so
   * the direct-swap layer has no encoder for it and quotes Uniswap's v2 alone —
   * exactly as it did before this field existed.
   */
  homeV2: {
    /**
     * The pair's LP fee. Measured from the router rather than assumed:
     * `getAmountOut(1e18, 1e30, 1e30)` returns 997499999999004993 on Pancake
     * (2500 ppm) against Uniswap's 996999999999005991 (3000 ppm), so the two
     * v2 venues on one chain do NOT share a fee. chain-check re-measures it.
     */
    feePpm: number
    /**
     * A SwapRouter02-shaped router that can execute a v2 leg AND settle the
     * terminal fee in the same multicall. This is NOT `addr.V2_ROUTER`: the
     * plain v2 router has no sweep/unwrap fragments, so a swap through it could
     * not pay the terminal fee in one transaction. PancakeSwap's SmartRouter
     * carries the whole SwapRouter02 surface (verified by selector against the
     * deployed bytecode), which is why `uniSwapRouterAbi` drives both venues.
     */
    SWAP_ROUTER: Address
  } | null
  /**
   * A farm that takes CUSTODY of home-DEX v2 LP tokens, or null where none
   * exists — PancakeSwap's MasterChefV2.
   *
   * The v2 sibling of `homeClFarm`, and invisible for the same reason: staking
   * TRANSFERS the LP token, so `pair.balanceOf(user)` returns zero and every
   * discovery path that reads a wallet balance — the sweep, an explorer, a
   * subgraph — reports the position as gone. Only the farm still records the
   * depositor, under a pid rather than a pool address.
   *
   * Worth reading even where the farm no longer pays: measured 2026-08-02, all
   * 187 MasterChefV2 pids have allocPoint 0 while 144 pairs still custody LP
   * (Cake/WBNB alone holds 52% of its own supply). That LP keeps earning its
   * share of trading fees, so it is live money the wallet cannot see.
   */
  homeV2Farm: {
    address: Address
    /** the reward token, so the UI can name it — it is NOT the emissions token */
    reward: { symbol: string; decimals: number }
  } | null
  /**
   * v2 venues whose LP the positions tab finds by SWEEPING candidate pairs,
   * used where the chain has no holder-balance API to ask instead.
   *
   * v2 LP is a plain ERC-20, so there is nothing to enumerate from the wallet
   * side without an indexer — and BSC has none that is free: it has no
   * Blockscout instance, Etherscan's v2 API refuses chain 56 on the free tier,
   * and PancakeSwap's hosted subgraph is retired. What IS free is the pair
   * address itself: v2 factories deploy by CREATE2, so
   * `keccak256(0xff, factory, keccak256(t0,t1), initCodeHash)` names the pair
   * offline, with no RPC and no index. That turns candidate verification from
   * a `factory.getPair` round trip into pure arithmetic a spoofed pair cannot
   * pass.
   *
   * Empty on a chain that has a holder-balance API — enumerating what the
   * wallet actually holds is strictly better than guessing which pairs to ask
   * about, and the sweep's coverage is bounded by its candidate list.
   */
  v2Sweep: readonly {
    protocol: 'univ2' | 'home'
    factory: Address
    /** the pair's creation-code hash, as the factory's CREATE2 uses it */
    initCodeHash: Hex
    /** DexScreener's dexId for this venue, used to source candidates */
    dexId: string
  }[]
  /** the Uniswap v3 fee ladder probed during discovery */
  uniV3Fees: readonly number[]
  /**
   * Uniswap v4, or null where none is deployed.
   *
   * v4 has no factory and no pool contract — one singleton holds every pool,
   * and a pool is named by `keccak256(abi.encode(poolKey))`. That identity is
   * computable off-chain, so discovery stays a probe: compute the id, ask
   * `StateView.getSlot0` whether it is initialised. Same shape as
   * `factory.getPool`, no subgraph required.
   */
  uniV4: {
    /** the singleton; only cross-checked, never called directly for routing */
    POOL_MANAGER: Address
    /** the read lens over the singleton's storage — where discovery asks */
    STATE_VIEW: Address
    QUOTER: Address
    /** v4 executes through the UniversalRouter, which pulls ERC-20 input
     *  through Permit2 rather than through a plain allowance */
    UNIVERSAL_ROUTER: Address
    PERMIT2: Address
    /**
     * Where LP positions live. It mints ERC-721s but implements NO enumeration
     * — verified on BSC: `totalSupply` and `tokenOfOwnerByIndex` both revert —
     * so unlike the v3 NPM it cannot answer "which ids does this wallet own".
     * That is the entire reason `positionSubgraph` exists.
     */
    POSITION_MANAGER: Address
    /**
     * A subgraph deployment (IPFS hash) that indexes position OWNERSHIP, or
     * null where none is available — v4 LP positions are then undiscoverable
     * and the reader finds nothing.
     *
     * It is asked one question and trusted with nothing: which token ids might
     * belong to this wallet. Ownership is re-read from the chain, so a stale
     * index can waste a call or miss a position, never show someone else's.
     */
    positionSubgraph: string | null
    /**
     * Published The Graph subgraph id used by the POOLS catalog, or null when
     * this deployment has no browseable v4 index. Kept separate from the
     * pinned ownership deployment above: the catalog should follow compatible
     * published upgrades, while position enumeration needs a schema-stable
     * deployment whose ownership results were checked against ownerOf().
     */
    poolSubgraph: string | null
    /**
     * Where the pool directory comes from when `poolSubgraph` is null: an RPC
     * scan of the PoolManager's own Initialize logs, SCOPED to the tokens one
     * launchpad factory minted.
     *
     * The scope is what makes an RPC directory tractable. Robinhood Chain has
     * 257k initialised pools and most of them are unreachable anyway — the
     * probe is hookless-only, and tens of thousands are keyed on 87%-99.99%
     * fees that cannot return a fill worth routing. Indexing what one factory
     * launched keeps the directory in the low thousands and keeps every row in
     * it a pool someone might actually want.
     *
     * It is a SCOPE, not a filter on discovery: pools outside it are still
     * probed by rung for any token already in the list, exactly as before.
     */
    rpcDirectory: {
      /**
       * That factory's own deployment — no LAUNCH can precede it.
       *
       * The factory itself is NOT restated here: it is `launchpad.tokenFactory`
       * on this same config. Writing the address twice would let the scope the
       * indexer builds drift away from the provenance the interface proves —
       * silently, and in the direction where rows exist but carry no mark.
       */
      tokenGenesisBlock: number
      /**
       * The PoolManager's own deployment, and where the POOL scan starts.
       *
       * Deliberately not the token genesis: the connector pools that form the
       * other half of the scope were created long before any launchpad existed,
       * so starting both scans together silently drops them.
       */
      poolGenesisBlock: number
    } | null
    /**
     * Whether the DEPLOYED UniversalRouter decodes the swap struct carrying
     * `minHopPriceX36`.
     *
     * v4-periphery added that field BETWEEN `amountOutMinimum` and `hookData`,
     * so encoding the wrong shape does not fail loudly — it shifts `hookData`
     * and hands the router a garbage tail. Which shape is right is a property
     * of when the deployment shipped, not of the chain, so it is declared here
     * and asserted against the router's own bytecode by chain-check on every
     * run (the per-hop error selectors are present exactly when the field is).
     */
    perHopSlippage: boolean
    /**
     * The (fee, tickSpacing) rungs discovery probes.
     *
     * In v4 the pairing is a CONVENTION, not something a factory enforces, so
     * this is a shortlist rather than an exhaustive set — the canonical rungs
     * are where the liquidity is. A pool on an unconventional pairing is
     * simply not found, the same way an off-ladder v3 fee tier is not.
     */
    rungs: readonly { fee: number; tickSpacing: number }[]
  } | null
  /** intermediate hops tried when no direct pool exists */
  connectors: Address[]
  /** the buy side the swap tab opens on */
  defaultBuy: Address
  /** third-party data-source slugs — every one of these is baked into a URL */
  slugs: {
    dexscreener: string
    /**
     * DexScreener's dexId per venue slot, which is how pool discovery decides
     * which factory must vouch for a candidate and which protocol to tag it.
     *
     * `home: null` means this chain's home CL is NOT discovered this way — on
     * Robinhood, UP33's pools are enumerated on-chain instead. A non-null home
     * requires `homeCl.keyedBy: 'fee'`, because discovery hydrates and verifies
     * every candidate through the Uniswap-v3-shaped ABIs.
     */
    dexIds: { uni: string; home: string | null }
    kyber: string
    /** GeckoTerminal network + dex ids used for bounded indexer enrichment. */
    gecko: {
      network: string
      v2Dex: string | null
      v3Dex: string | null
      extraDexes?: readonly { id: string; label: string }[]
    } | null
  }
  /** UP33 v2 subgraph; null on chains we have no subgraph for */
  goldskySubgraph: string | null
  /** native units withheld from a MAX so the next tx can still pay gas */
  gasBuffer: bigint
  /** protocol display names — the home-DEX slot is a different protocol per chain */
  labels: { home: string; homeCl: string; homeV2: string }
  /** ve(3,3) epoch length in seconds; 0 when the chain has no emissions */
  week: number
  /**
   * Whether the BRIDGE tab has a route model for this chain. The bridge maps
   * one home token to one remote token per asset and settles withdrawals
   * through the home chain's own canonical inbox (config/bridge.ts) — both are
   * written for Robinhood, so another chain gets no bridge until it has its
   * own.
   */
  hasBridge: boolean
  /**
   * Solver base URL, or null when no solver is deployed for this chain — the
   * swap tab then quotes direct routes only.
   */
  solverUrl: string | null
  /** Fixed AllowanceHolder trust anchor for executable ERC-20 solver quotes. */
  solverAllowanceTarget: Address | null
  /**
   * Tokenized-equity issuers deployed on this chain, and the on-chain anchors
   * that identify their tokens (config/chains/stockIssuers.ts).
   *
   * Empty on a chain with no such issuer, which costs nothing: the reader skips
   * every RPC call when there is no anchor to match against, so the whole
   * feature is inert rather than gated by a flag.
   *
   * This is a DISPLAY credential and nothing else. Nothing here may reach
   * routing, quoting or execution — a token being an authentic Apple share
   * says nothing about whether its pool is worth trading through, and the
   * moment an issuer's identity earns a token special handling in the solver
   * we have started predicting instead of measuring.
   */
  stockIssuers: readonly StockIssuerAnchor[]
  /**
   * The token launchpad this chain's newest markets come out of, or null where
   * there is none (config/chains/launchpad.ts).
   *
   * Present on Robinhood Chain, where pools.trade migrates a finished sale into
   * an ordinary hookless v4 pool — the deepest rung on the chain by both pool
   * count and median liquidity (see `uniV4.rungs`). Null on BSC, whose v4
   * markets come from no single origin.
   *
   * Display and browsing only, on the same terms as `stockIssuers`: it decides
   * which market filter chips exist and what a row is allowed to claim about
   * where it came from — never what routes, never what a quote may touch.
   */
  launchpad: LaunchpadConfig | null
  /**
   * Symbols with one right answer on this chain, so a token wearing one it does
   * not own can be named as such (config/chains/knownTokens.ts).
   *
   * Like `stockIssuers`, this is display only. It decides what a POOLS landing
   * page shows first and what warning a symbol carries — never what routes,
   * never what a quote is allowed to touch. A user who searches for a squatting
   * token by address still reaches it and can still trade it.
   */
  knownTokens: readonly KnownToken[]
}
