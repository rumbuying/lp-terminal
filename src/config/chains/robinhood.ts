import type { Address, Hex } from 'viem'
import { CG, NATIVE_SENTINEL } from './knownTokens'
import { ERC1967_BEACON_SLOT } from './stockIssuers'
import type { ChainConfig } from './types'

const EXPLORER = 'https://robinhoodchain.blockscout.com'

/**
 * Robinhood Chain — the terminal's original home.
 *
 * Every address here was verified on Blockscout; see docs/up33-contract-map.md
 * at the repo root. The home-DEX slot is UP33, a ve(3,3) protocol whose
 * concentrated-liquidity leg is a Slipstream fork — so it is keyed by TICK
 * SPACING, not by a fee tier (`homeCl.keyedBy`).
 */
export const robinhoodConfig: ChainConfig = {
  key: 'robinhood',
  id: 4663,
  name: 'Robinhood Chain',
  shortName: 'ROBINHOOD',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  wrappedSymbol: 'WETH',
  stable: { symbol: 'USDG', decimals: 6 },
  publicRpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: {
    name: 'Blockscout',
    url: EXPLORER,
    api: 'blockscout',
    nft: (token, id) => `${EXPLORER}/token/${token}/instance/${id}`,
  },
  addr: {
    V2_FACTORY: '0xFA5429AEBa338BEa2BFcc1b9a889862Ee395bc28' as Address,
    V2_ROUTER: '0xf5198743240fAC98db71868F34c70139b1eb0474' as Address,
    CL_FACTORY: '0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3' as Address,
    CL_PM: '0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf' as Address,
    CL_SWAP_ROUTER: '0xC062b870E813fcA720f1e002c234369Ab3aB9415' as Address,
    CL_QUOTER: '0x03983AB2C057a2eac211ff01738a1e49ff325B49' as Address,
    WNATIVE: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
    STABLE: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  },
  // Official Uniswap v2 + v3 on Robinhood Chain (developers.uniswap.org
  // deployments; chain-verified 2026-07-16: NPM.factory() == V3_FACTORY,
  // NPM.WETH9() == addr.WNATIVE, Router02.factory() == V2_FACTORY,
  // Router02.WETH() == addr.WNATIVE — beware, Blockscout also lists several
  // unofficial same-name forks). v4 is live too and is wired up below.
  uni: {
    V3_FACTORY: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as Address,
    V3_NPM: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3' as Address,
    V3_QUOTER: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7' as Address,
    V3_SWAP_ROUTER: '0xCaf681a66D020601342297493863E78C959E5cb2' as Address,
    V2_FACTORY: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f' as Address,
    V2_ROUTER: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba' as Address,
  },
  gov: {
    UP: '0x57C0E45cB534413D1C20A4240955d6bB250BB4F1' as Address,
    VE_UP: '0x5d321dE36F0bf98D92b291280514F3878582B7B6' as Address,
    VOTER: '0x7F749fDD351C1Ceed82d76d7699CB631Eb8332a7' as Address,
    MINTER: '0x912EC7A90e8C9829eE0e0f6a4Db5270776Fc3Da5' as Address,
  },
  homeCl: { keyedBy: 'tickSpacing' },
  // UP33 stakes into per-pool gauges, which the pool registry already carries —
  // fetchPositions finds those through gauge.stakedValues(user). There is no
  // single farm to enumerate, so this stays null.
  homeClFarm: null,
  // UP33's v2 is a Solidly fork: its router routes on `(from, to, stable)`
  // structs, not a plain address path, and the pair carries a stable flag that
  // picks a different invariant. The direct-swap layer encodes neither, so it
  // quotes Uniswap's v2 alone here — unchanged from before this field existed.
  homeV2: null,
  // Staked v2 LP moves into a per-pool gauge here, and the pool registry carries
  // `gauge` — pass 1 of fetchPositions already reads balanceOf/earned on it. No
  // pid-keyed farm to enumerate, so this stays null for the same reason
  // homeClFarm does.
  homeV2Farm: null,
  // Blockscout lists this wallet's ERC-20 holdings directly, which finds ANY
  // pair the user holds rather than only the ones a candidate list guessed —
  // strictly better than a sweep, so there is nothing to sweep here.
  v2Sweep: [],
  uniV3Fees: [100, 500, 3000, 10000],
  // Uniswap v4. Every address read off a Robinhood node on 2026-08-05:
  // StateView, Quoter, PositionManager and the UniversalRouter all return
  // POOL_MANAGER from poolManager(), and Permit2 has code at the canonical
  // address. The pool id derivation is stock v4 — keccak256(abi.encode(poolKey))
  // reproduced the id carried by the chain's own Initialize log exactly — so no
  // Robinhood-specific path is needed anywhere the BSC v4 leg already works.
  uniV4: {
    POOL_MANAGER: '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address,
    STATE_VIEW: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b' as Address,
    QUOTER: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94' as Address,
    // 5.26M transactions as of 2026-08-05 — the router this chain actually
    // trades through. Its PERMIT2 and WETH9 immutables expose no public getter,
    // so poolManager() is what binds it to the deployment above.
    UNIVERSAL_ROUTER: '0x8876789976dEcBfCbBbe364623C63652db8C0904' as Address,
    PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
    // nextTokenId() is 474,835, while totalSupply() and tokenOfOwnerByIndex()
    // both REVERT — the same shape as BSC, so enumeration needs an index.
    POSITION_MANAGER: '0x58daec3116aae6D93017bAAea7749052E8a04fA7' as Address,
    // No v4 subgraph is published for this chain. Position ownership is
    // therefore unanswerable and FEATURES.v4Positions gates that half off; the
    // POOLS catalog falls back to the indexer's own directory. Swapping and
    // pool discovery depend on neither index — they probe the rungs below.
    positionSubgraph: null,
    poolSubgraph: null,
    // Scoped to `launchpad.tokenFactory` below — Uniswap's shared UERC20
    // factory, which every launchpad frontend on this chain mints through,
    // pools.trade included. That is why the scope is drawn at the factory
    // rather than at one launchpad's own LiquidityLauncher: measured over
    // 142,884 hookless v4 swaps on 2026-08-05, the factory covers 35.9% of
    // them across 661 active pools against 28.0% and 576 for the launcher
    // alone — the same single getLogs either way. It was deployed at block
    // 4,516,017, and no launch precedes it.
    //
    // The launched tokens are only half the directory's scope; pools between
    // this chain's own connectors are the other half, and they are what reach
    // the off-ladder keys the rungs above cannot. See indexer/v4Scope.ts.
    rpcDirectory: {
      tokenGenesisBlock: 4_516_017,
      // v4 predates the launchpad here by four and a half million blocks — the
      // first pool was initialised at 9,505. Scanning pools from the token
      // genesis instead cost 166 of the chain's 514 connector pools.
      poolGenesisBlock: 9_070,
    },
    // This router POSTdates `minHopPriceX36` — unlike BSC's. Its verified
    // source carries the field between amountOutMinimum and hookData, and its
    // bytecode carries V4TooLittleReceivedPerHopSingle. Read off the deployed
    // contract 2026-08-05; chain-check asserts it against the bytecode.
    perHopSlippage: true,
    // Measured 2026-08-05 across all 257,283 Initialize logs on this chain,
    // restricted to the hookless keys v4PoolKey() can actually probe, then
    // sampled 60 pools per rung for live liquidity:
    //
    //   fee/spacing    pools   alive   median liquidity
    //   2500/60        1,246   98.3%   5.01e22   <- pools.trade's default
    //   10000/200     35,952    1.7%   3.68e22
    //   3000/60        1,259   25.0%   1.00e20
    //   500/10            78   23.3%   2.29e17
    //   100/1            278   25.0%   1.00e14
    //
    // 2500/60 leads on BOTH measures and is not a canonical Uniswap rung: it is
    // what the pools.trade launchpad migrates into, so a ladder copied from BSC
    // would miss the deepest market on the chain. The ~30k pools keyed on
    // 87%-99.99% fees are left out on purpose — they sample 68-100% "alive",
    // but their median liquidity runs five to nine orders of magnitude below
    // the rungs above and a fee that size cannot return a fill worth routing.
    rungs: [
      { fee: 2500, tickSpacing: 60 },
      { fee: 10000, tickSpacing: 200 },
      { fee: 3000, tickSpacing: 60 },
      { fee: 500, tickSpacing: 10 },
      { fee: 100, tickSpacing: 1 },
    ],
  },
  // WNATIVE, STABLE, VIRTUAL
  connectors: [
    '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
    '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
    '0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31' as Address,
  ],
  /**
   * The buy side the swap tab opens on.
   *
   * Pinned by ADDRESS, never by symbol: the index carries 20+ tokens calling
   * themselves CASHCAT and the picker cannot tell them apart by name. This is
   * the one with real liquidity — 51 pools and a live price, verified
   * 2026-07-23 by routing 0.5 WETH through it — while every impersonator has
   * one or two pools and no price at all. Resolving a default by symbol would
   * eventually open the terminal on a honeypot.
   */
  defaultBuy: '0x020bfC650A365f8BB26819deAAbF3E21291018b4' as Address,
  slugs: {
    dexscreener: 'robinhood',
    // UP33's CL pools come from on-chain Solidly enumeration (usePools), and
    // its Slipstream shape could not ride the fee-keyed discovery path anyway.
    dexIds: { uni: 'uniswap', home: null },
    kyber: 'robinhood',
    gecko: { network: 'robinhood', v2Dex: 'uniswap-v2-robinhood', v3Dex: 'uniswap-v3-robinhood' },
  },
  goldskySubgraph:
    '/api/public/project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-v2-mainnet/0.1.0/gn',
  gasBuffer: 1_000_000_000_000_000n, // 0.001 ETH
  labels: { home: 'UP33', homeCl: 'UP33 CL', homeV2: 'UP33 v2' },
  week: 604800,
  hasBridge: true,
  solverUrl: 'https://lp-terminal.xyz/_chain/robinhood/solver',
  solverAllowanceTarget: '0x0000000000001fF3684f28c67538d4D072C22734' as Address,
  // Robinhood's own tokenized stocks — the assets this chain exists to carry.
  // Read off the chain 2026-08-04: TSLA, AAPL, NVDA, SPY, MSTR, GOOGL, AMZN and
  // COIN all share this beacon and this codehash, and the beacon is a PUSH32
  // immutable inside the proxy so the codehash alone already pins it. Every
  // impersonator sharing those symbols is a plain contract that matches
  // neither, and USDG, WETH and VIRTUAL correctly match nothing — this must
  // stay true, or the mark would be claiming the stablecoin is an equity.
  //
  // The tokens carry Robinhood's own terms URL in `terms()`, and a
  // `uiMultiplier()` that a stock split moves away from 1e18 — a rebase the
  // POSITIONS math would have to respect if it ever fires. Currently 1e18 on
  // every token sampled.
  stockIssuers: [
    {
      issuer: 'robinhood',
      slot: ERC1967_BEACON_SLOT,
      anchor: '0xe10b6f6B275de231345c20D14Ab812db62151b00' as Address,
      proxyCodehash: '0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630' as Hex,
      witness: { symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address },
    },
  ],
  // pools.trade — Uniswap's launchpad on this chain, and where the 2500/60 rung
  // above comes from. A sale runs behind the LBP strategy and its initializer
  // hook, then migrates into a plain hookless v4 pool, which is why those pools
  // are quotable by the ordinary v4 path and carry no hook of their own.
  //
  // Addresses read off a Robinhood node 2026-08-05: all of them have code, and
  // the factory answers `getUERC20Address` for the tokens it deployed — FRONG,
  // JEFF and UNIDUCK each hash back to their own address from their
  // self-reported (name, symbol, decimals, creator, graffiti), while USDG
  // reverts on `creator()` and so cannot even be a candidate.
  //
  // THREE launchers, TWO generations, all live. Every one was deployed by the
  // same EOA that deployed the factory (0x32f4b2e6…107ad, through the CREATE2
  // deployer), which is what makes them the launchpad's rather than a copy:
  //
  //   v1  0x00004c4c…D4e9  2026-07-06  codehash 0x672007315147b920…
  //   v2  0x7A6C474b…768e  2026-08-04  codehash 0x4a586d925c9d59ec…
  //   v2  0x0000FffF…19C0  2026-08-05  codehash 0x4a586d925c9d59ec…
  //
  // The two v2 addresses run byte-identical code — the second is the vanity
  // address, deployed 14 hours after the first, and both keep taking sales. v2
  // adds `distributeWithNative` (INativeStrategy) and is otherwise the v1
  // source. Over the 1,265 tokens minted in the 24h to 2026-08-05T14:30Z the
  // split was v1 897, v2 205, straight-off-the-factory mints 163.
  //
  // The factory is unchanged across both, and it is SHARED: 138 of those 1,265
  // came from two unrelated launchers (one verified as "MemeLaunchV2"). They
  // are genuine UERC20 tokens and the mark says exactly that much — the release
  // suffix is what separates a pools.trade sale from everything else minted
  // through the same factory.
  launchpad: {
    id: 'poolsTrade',
    label: 'POOLS.TRADE',
    url: 'https://pools.trade/',
    tokenFactory: '0x000000e200088D55C39a11F609E5F667729ad49b' as Address,
    deployer: '0x32f4B2e69EbD7746596AF8699DAC1908F43107aD' as Address,
    create2Factory: '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Address,
    releases: [
      {
        id: 'v1',
        short: 'V1',
        launchers: [
          {
            address: '0x00004c4ccc709Ef590F7C81102C0689F0263D4e9' as Address,
            deployTx: '0x6d11634b0bad842d13b2c400c0432987c5b48071c58e97130a26e01b908f3f95' as Hex,
          },
        ],
      },
      {
        id: 'v2',
        short: 'V2',
        launchers: [
          {
            address: '0x7A6C474b4DcD35b72203D2B569EAfE4C9b5C768e' as Address,
            deployTx: '0x47a46a8038c6cff41c88d4bf29c199de3efa1973ee3afef96056eb1a3c94e880' as Hex,
          },
          {
            address: '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0' as Address,
            deployTx: '0xbf68c51ed936a2a33fa3450ccf245bad1df199a15392bfd754935ba4d6728ccc' as Hex,
          },
        ],
      },
    ],
  },
  // Read from the tokens themselves 2026-08-04. Short on purpose: this chain
  // has exactly three symbols with an unambiguous owner, and they are the three
  // the config already routes through.
  //
  // USDC and USDT are NOT here, and that is the finding rather than an
  // omission — neither has a canonical deployment on this chain. Every token
  // claiming either has one or two pools and no price, so there is no real one
  // to measure them against, and flagging them would be asserting a canonical
  // that does not exist. USDG is this chain's dollar.
  //
  // The logos are the ones this chain's own explorer serves for these four
  // addresses (Blockscout's `icon_url`, read 2026-08-05), so they are the same
  // picture a user sees when they look the token up there.
  knownTokens: [
    { symbol: 'ETH', address: NATIVE_SENTINEL, decimals: 18, logo: CG('279/small/ethereum.png?1696501628') },
    {
      symbol: 'WETH',
      address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
      decimals: 18,
      logo: CG('2518/small/weth.png?1696503332'),
    },
    {
      symbol: 'USDG',
      address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
      decimals: 6,
      logo: CG('51281/small/GDN_USDG_Token_200x200.png?1730484111'),
    },
    {
      symbol: 'VIRTUAL',
      address: '0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31' as Address,
      decimals: 18,
      logo: CG('34057/small/LOGOMARK.png?1708356054'),
    },
  ],
}
