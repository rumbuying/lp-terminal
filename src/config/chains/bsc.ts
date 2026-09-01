import type { Address, Hex } from 'viem'
import { CG, NATIVE_SENTINEL } from './knownTokens'
import { ERC1967_ADMIN_SLOT, ERC1967_BEACON_SLOT } from './stockIssuers'
import type { ChainConfig } from './types'

const EXPLORER = 'https://bscscan.com'

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address
const USDT = '0x55d398326f99059fF775485246999027B3197955' as Address
const USD1 = '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d' as Address

/**
 * BNB Smart Chain.
 *
 * Every address below was verified against a BSC node on 2026-08-02 by calling
 * the deployment's own accessors — each router's and quoter's `factory()`
 * returns the factory listed beside it, and both position managers report
 * `WETH9() == WBNB`. `getPool(NVDAB, USDT, 500)` on the Uniswap factory returns
 * 0xDD9d…6177, which is the pool DexScreener shows as NVDAB's deepest.
 *
 * The home-DEX slot is PancakeSwap. Unlike Robinhood's Slipstream-based UP33
 * CL, Pancake v3 keys pools by FEE TIER — and its ladder carries a 2500 rung
 * that Uniswap's does not (the live NVDAB and TSLAB pools sit on it).
 *
 * Token decimals are NOT the mainnet defaults: BSC-USDT is 18 decimals, not 6.
 * Nothing here assumes otherwise — decimals are always read from the token.
 */
export const bscConfig: ChainConfig = {
  key: 'bsc',
  id: 56,
  name: 'BNB Smart Chain',
  shortName: 'BSC',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  wrappedSymbol: 'WBNB',
  stable: { symbol: 'USDT', decimals: 18 },
  // Current-state browser reads (including the 30-pool verification batch)
  // time out on the generic dataseed under load. PublicNode answered the same
  // Multicall3 probe in ~1.2s; historical indexer logs use a separate endpoint.
  publicRpc: 'https://bsc-rpc.publicnode.com',
  explorer: {
    name: 'BscScan',
    url: EXPLORER,
    api: 'etherscan',
    // Etherscan-family deep link for one token id under an NFT contract —
    // a different shape from Blockscout's /instance/ path.
    nft: (token, id) => `${EXPLORER}/token/${token}?a=${id}`,
  },
  // PancakeSwap. CL_SWAP_ROUTER is the v3 SwapRouter (a SwapRouter02 fork),
  // not the SmartRouter aggregator — the terminal builds its own routes and
  // needs the plain exactInput/exactInputSingle surface.
  addr: {
    V2_FACTORY: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' as Address,
    V2_ROUTER: '0x10ED43C718714eb63d5aA57B78B54704E256024E' as Address,
    CL_FACTORY: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as Address,
    CL_PM: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' as Address,
    CL_SWAP_ROUTER: '0x1b81D678ffb9C0263b24A97847620C99d213eB14' as Address,
    CL_QUOTER: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' as Address,
    WNATIVE: WBNB,
    STABLE: USDT,
  },
  // Official Uniswap v2 + v3 on BSC (developers.uniswap.org deployments).
  uni: {
    V3_FACTORY: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7' as Address,
    V3_NPM: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613' as Address,
    V3_QUOTER: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077' as Address,
    V3_SWAP_ROUTER: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2' as Address,
    V2_FACTORY: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6' as Address,
    V2_ROUTER: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' as Address,
  },
  // BSC has no ve(3,3) protocol behind this terminal — every emissions surface
  // is gated off (see config/features.ts).
  gov: null,
  homeCl: { keyedBy: 'fee', fees: [100, 500, 2500, 10000] },
  // MasterChefV3 — and it takes custody. Verified live 2026-08-02: it holds
  // 81,515 Pancake v3 NFTs, its nonfungiblePositionManager() is addr.CL_PM,
  // and NPM.ownerOf(402354) returns the FARM while
  // MasterChefV3.userPositionInfos(402354).user returns the depositor. Without
  // this entry every farmed position on the chain reads as nonexistent.
  homeClFarm: {
    address: '0x556B9306565093C855AEA9AE92A594704c2Cd59e' as Address,
    reward: { symbol: 'CAKE', decimals: 18 },
  },
  // Pancake v2 — the chain's deepest venue by TVL ($1.68B). Its bStock pools
  // are memecoins QUOTED IN a bStock (GPU/NVDAB, Tesla Cat/TSLAB), not a way in
  // from money: there is no bStock/stable or bStock/WBNB v2 pair, so Pancake v3
  // still wins every bStock route. Quoted on V2_ROUTER.getAmountsOut, executed on the
  // SmartRouter, which is the SwapRouter02 shape: verified 2026-08-02 by
  // selector against the deployed bytecode (swapExactTokensForTokens 0x472b43f3
  // and multicall(uint256,bytes[]) 0x5ae401dc are both present, and it embeds
  // no Permit2 address, so a plain ERC-20 approval is enough). Its own
  // accessors agree with every neighbouring entry here: factoryV2() returns
  // V2_FACTORY, factory() returns CL_FACTORY, positionManager() returns CL_PM.
  homeV2: {
    feePpm: 2500,
    SWAP_ROUTER: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4' as Address,
  },
  // MasterChefV2 — the v2 farm, and it takes custody the way MasterChefV3 does.
  // Verified live 2026-08-02: poolLength() is 187, and deriving each pid's
  // lpToken() by CREATE2 identifies 147 of them as genuine Pancake v2 pairs with
  // ZERO wrong-factory matches; the other 40 are dummy tokens (dCAKEPOOL,
  // dLOTTO) and StableSwap LPs, which have no token0()/token1() and drop out on
  // their own. Every pid now has allocPoint 0 — CAKE farming here is finished —
  // yet 144 of those pairs still hold staked LP, so this reads abandoned
  // positions their owners' wallets no longer show.
  homeV2Farm: {
    address: '0xa5f8C5Dbd5F286960b9d90548680aE5ebFf07652' as Address,
    reward: { symbol: 'CAKE', decimals: 18 },
  },
  // BSC has no free holder-balance API, so v2 LP is found by sweeping candidate
  // pairs instead. Both init-code hashes were verified against the live
  // factories on 2026-08-02 — the derived address matched factory.getPair
  // exactly for WBNB/USDT and CAKE/WBNB on both venues.
  v2Sweep: [
    {
      protocol: 'home',
      factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' as Address,
      initCodeHash: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5' as Hex,
      dexId: 'pancakeswap',
    },
    {
      protocol: 'univ2',
      factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6' as Address,
      initCodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f' as Hex,
      dexId: 'uniswap',
    },
  ],
  uniV3Fees: [100, 500, 3000, 10000],
  // Uniswap v4. Every address verified live 2026-08-02 — all have code, and
  // StateView.poolManager() returns POOL_MANAGER. The probe finds real pools:
  // native BNB/USDT exists on all four rungs, and its 0.05% pool carries about
  // twelve times the liquidity of the WBNB-keyed one, which is why v4Currency
  // deliberately does NOT fold the native coin onto its wrapper.
  uniV4: {
    POOL_MANAGER: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF' as Address,
    STATE_VIEW: '0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4' as Address,
    QUOTER: '0x9F75dD27D6664c475B90e105573E550ff69437B0' as Address,
    UNIVERSAL_ROUTER: '0x1906c1d672b88cD1B9aC7593301cA990F94Eae07' as Address,
    PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
    // Verified live 2026-08-02: 23,877B of code, poolManager() returns
    // POOL_MANAGER above, nextTokenId() is 985,536 — and both totalSupply()
    // and tokenOfOwnerByIndex() REVERT, which is why the subgraph below is not
    // optional for discovery.
    POSITION_MANAGER: '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b' as Address,
    // `uniswap-v4-bnb` on The Graph. Measured 2026-08-02: synced to the chain
    // head with hasIndexingErrors false, and its owner field agreed with
    // on-chain ownerOf on 200 of 200 sampled positions. Reached through the
    // same-origin /thegraph proxy so the gateway key stays server-side.
    positionSubgraph: 'QmbQBjZ1VUK42k1V6sn6PnP3BZ1vLZhUmzfDpyF9Eiwfgt',
    // BSC's position ownership is served by the pinned subgraph above, not by
    // an RPC replay of Transfer logs.
    positionRpcIndex: null,
    // Published `uniswap-v4-bnb` id. As of 2026-08-02 it resolves to the
    // deployment above, is synced without indexing errors, and exposes the
    // complete Pool catalog. Discovery still verifies every PoolKey against
    // StateView before a row is allowed to reach a write path.
    poolSubgraph: 'EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX',
    // The subgraph above IS the directory here, so there is nothing to scan.
    rpcDirectory: null,
    // This router predates `minHopPriceX36`: its bytecode carries
    // V4TooLittleReceived but none of the per-hop error selectors that shipped
    // with the field. Asserted on every chain-check run.
    perHopSlippage: false,
    rungs: [
      { fee: 100, tickSpacing: 1 },
      { fee: 500, tickSpacing: 10 },
      { fee: 3000, tickSpacing: 60 },
      { fee: 10000, tickSpacing: 200 },
    ],
  },
  connectors: [WBNB, USDT, USD1],
  // NVDAB — the tokenized-NVIDIA bStock. Pinned by address: its deepest pool
  // ($514k, Uniswap v3 0.05%) is the most liquid bStock market on the chain.
  defaultBuy: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436' as Address,
  slugs: {
    dexscreener: 'bsc',
    dexIds: { uni: 'uniswap', home: 'pancakeswap' },
    kyber: 'bsc',
    // GeckoTerminal ids are independent of the frontend/DexScreener ids. Keep
    // one list per indexed venue; stats.ts shares the 30-call budget fairly.
    gecko: {
      network: 'bsc',
      v2Dex: 'uniswap-v2-bsc',
      v3Dex: 'uniswap-bsc',
      extraDexes: [
        { id: 'pancakeswap_v2', label: 'pancake-v2' },
        { id: 'pancakeswap-v3-bsc', label: 'pancake-v3' },
      ],
    },
  },
  // No UP33 subgraph here; v2 pool stats come from DexScreener alone.
  goldskySubgraph: null,
  // BSC gas is ~0.1 gwei and a swap is ~150k gas, so 0.002 BNB covers many
  // transactions over — the buffer only has to keep a MAX from stranding a
  // wallet with no gas at all.
  gasBuffer: 2_000_000_000_000_000n, // 0.002 BNB
  labels: { home: 'PancakeSwap', homeCl: 'Pancake v3', homeV2: 'Pancake v2' },
  week: 0,
  hasBridge: false,
  solverUrl: 'https://lp-terminal.xyz/_chain/bsc/solver',
  solverAllowanceTarget: '0x0000000000001fF3684f28c67538d4D072C22734' as Address,
  // Three issuers of tokenized equities trade here. Every anchor and codehash
  // below was read off a BSC node on 2026-08-04, cross-checked across at least
  // three of each issuer's tokens, and checked NEGATIVE against the live
  // impersonators sharing their symbols — "NVDIA Tokenized bStocks"
  // (0x01d6c860…) and "NVIDIA Tokenized Stock (Ondo)" (0x021333de…) are plain
  // contracts with no proxy at all, and the fake AAPLx (0x0138c7af…) is an
  // ERC-1967 proxy whose admin is its own. WBNB, USDT and USD1 match nothing.
  stockIssuers: [
    // Binance. Beacon 0x156d…93a3 is a PUSH32 immutable inside the proxy, so
    // this codehash alone already pins it — confirmed identical across NVDAB,
    // TSLAB and AAPLB. Each token also carries its own real ISIN in
    // `identifier()` (NVDAB is AE000A4AVAZ9, a UAE issue).
    {
      issuer: 'bstock',
      slot: ERC1967_BEACON_SLOT,
      anchor: '0x156D6dce9a4f6139a3406F1f021F1A4880De93a3' as Address,
      proxyCodehash: '0xdf946913977a2ed76735b4b2e66f2272d1a76af911c4e520655888c9e32269f9' as Hex,
      witness: { symbol: 'NVDAB', address: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436' as Address },
    },
    // Ondo. Stock OpenZeppelin BeaconProxy, so this codehash is NOT exclusive
    // to Ondo and the beacon read is what actually identifies the issuer —
    // the one entry here where the two-part check is doing real work.
    {
      issuer: 'ondo',
      slot: ERC1967_BEACON_SLOT,
      anchor: '0xc046b05A920e4B412815934DD8E58904dDA73315' as Address,
      proxyCodehash: '0x439923c85f956f038ae77871736f789e6d08d22257b6e5fdccfdc83924ecb4d0' as Hex,
      witness: { symbol: 'NVDAon', address: '0xA9eE28C80f960B889dFbd1902055218cBa016F75' as Address },
    },
    // Backed. A transparent proxy with no beacon, anchored on its ProxyAdmin:
    // its implementation (0x65c40d62… as of this reading) is upgradeable and
    // would go stale, while the admin is the durable identity. Verified across
    // TSLAx, COINx, CRCLx and SPYx, all four sharing both admin and codehash.
    {
      issuer: 'backed',
      slot: ERC1967_ADMIN_SLOT,
      anchor: '0x696C685a02A1Fc6E2AaCbe26CD6695F4f4a6a085' as Address,
      proxyCodehash: '0xe7cbfea5a664672738dd729f7774677b0fa82dbdda74320df20eec49d2211b4c' as Hex,
      witness: { symbol: 'TSLAx', address: '0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0' as Address },
    },
  ],
  // Every symbol and decimals below was read from the token itself on
  // 2026-08-04, and each address is the one the catalog shows carrying the
  // liquidity — the runners-up sharing these symbols have double-digit pool
  // counts and no price at all. chain-check re-reads both fields.
  //
  // No launchpad. BSC's v4 pools come from no single origin, and there is no
  // factory here whose CREATE2 derivation could prove one — so the browsing
  // filter that would need it is absent rather than present-and-inert.
  launchpad: null,
  // Note `Cake`, not `CAKE`: PancakeSwap's token spells it in mixed case, which
  // is exactly why the comparison is case-insensitive. `Cake-LP` is a different
  // string and correctly matches nothing.
  //
  // Two absences are deliberate. WETH is NOT here: 0x4db5a66e is a genuine
  // "Wrapped Ether" on this chain with 105 pools and a live price, separate
  // from Binance-pegged ETH, so there is no single right answer to reserve.
  // And no equity ticker is here — those are proven from their issuer instead.
  //
  // Logos come from a CoinGecko lookup of each CONTRACT ADDRESS (2026-08-05), so
  // the picture is bound to the same address the entry reserves rather than to
  // the ticker. FDUSD has none here because that lookup was rate-limited rather
  // than answered — an absent logo is a monogram, which is the honest state.
  knownTokens: [
    { symbol: 'BNB', address: NATIVE_SENTINEL, decimals: 18, logo: CG('825/small/bnb-icon2_2x.png?1696501970') },
    { symbol: 'WBNB', address: WBNB, decimals: 18, logo: CG('12591/small/binance-coin-logo.png?1696512401') },
    { symbol: 'USDT', address: USDT, decimals: 18, logo: CG('35021/small/USDT.png?1707233575') },
    {
      symbol: 'USD1',
      address: USD1,
      decimals: 18,
      logo: CG('54977/small/USD1_1000x1000_transparent.png?1749297002'),
    },
    {
      symbol: 'USDC',
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' as Address,
      decimals: 18,
      logo: CG('35220/small/USDC.jpg?1707919050'),
    },
    {
      symbol: 'BUSD',
      address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' as Address,
      decimals: 18,
      logo: CG('31273/small/new_binance-peg-busd.png?1696530096'),
    },
    { symbol: 'FDUSD', address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409' as Address, decimals: 18 },
    {
      symbol: 'DAI',
      address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3' as Address,
      decimals: 18,
      logo: CG('39784/small/dai.png?1724109857'),
    },
    {
      symbol: 'BTCB',
      address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c' as Address,
      decimals: 18,
      logo: CG('14108/small/Binance-bitcoin.png?1696513829'),
    },
    {
      symbol: 'ETH',
      address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8' as Address,
      decimals: 18,
      logo: CG('39580/small/weth.png?1723006716'),
    },
    {
      symbol: 'Cake',
      address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' as Address,
      decimals: 18,
      logo: CG('12632/small/pancakeswap-cake-logo_%281%29.png?1696512440'),
    },
  ],
}
