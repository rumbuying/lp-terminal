import type { Address } from 'viem'
import { CHAINS } from './chains'
import type { ChainConfig, SupportedChainId } from './chains/types'

/** Protocol identities persisted by the strategy service. */
export type StrategyLpProtocol = 'up33' | 'univ3' | 'pancakeswap-v3' | 'univ4'
export type StrategyChainId = SupportedChainId

export type V3Deployment = {
  factory: Address
  positionManager: Address
  quoter: Address
  swapRouter: Address
}

export type V4Deployment = NonNullable<ChainConfig['uniV4']>

export type StrategyNetwork = {
  chainId: StrategyChainId
  slug: string
  name: string
  publicRpc: string
  explorer: string
  wrappedNative: Address
  settlementToken: Address
  settlementSymbol: string
  settlementDecimals: number
}

const chainsById = new Map<StrategyChainId, ChainConfig>(
  Object.values(CHAINS).map((chain) => [chain.id, chain]),
)

export function isStrategyChainId(value: number): value is StrategyChainId {
  return chainsById.has(value as StrategyChainId)
}

export function strategyChain(chainId: number): ChainConfig {
  if (!isStrategyChainId(chainId)) throw new Error(`unsupported strategy chain ${chainId}`)
  return chainsById.get(chainId)!
}

export function strategyNetwork(chainId: number): StrategyNetwork {
  const chain = strategyChain(chainId)
  return {
    chainId: chain.id,
    slug: chain.key,
    name: chain.name,
    publicRpc: chain.publicRpc,
    explorer: chain.explorer.url,
    wrappedNative: chain.addr.WNATIVE,
    settlementToken: chain.addr.STABLE,
    settlementSymbol: chain.stable.symbol,
    settlementDecimals: chain.stable.decimals,
  }
}

/** Translate the terminal's chain-relative `home` venue into the stable
 * protocol identity persisted by executor strategy records. */
export function strategyProtocolFor(
  chainId: number,
  protocol: 'home' | 'univ3' | 'univ4',
): StrategyLpProtocol {
  if (protocol !== 'home') return protocol
  return strategyChain(chainId).key === 'bsc' ? 'pancakeswap-v3' : 'up33'
}

/** Translate a persisted strategy protocol back to the terminal badge model. */
export function terminalProtocolFor(
  protocol: StrategyLpProtocol,
): 'home' | 'univ3' | 'univ4' {
  return protocol === 'up33' || protocol === 'pancakeswap-v3' ? 'home' : protocol
}

export function v3Deployment(chainId: number, protocol: StrategyLpProtocol): V3Deployment {
  const chain = strategyChain(chainId)
  if (protocol === 'univ3') {
    return {
      factory: chain.uni.V3_FACTORY,
      positionManager: chain.uni.V3_NPM,
      quoter: chain.uni.V3_QUOTER,
      swapRouter: chain.uni.V3_SWAP_ROUTER,
    }
  }
  if (protocol === 'pancakeswap-v3' && chain.key === 'bsc') {
    return {
      factory: chain.addr.CL_FACTORY,
      positionManager: chain.addr.CL_PM,
      quoter: chain.addr.CL_QUOTER,
      swapRouter: chain.addr.CL_SWAP_ROUTER,
    }
  }
  throw new Error(`protocol ${protocol} is not a v3 deployment on chain ${chainId}`)
}

export function v4Deployment(chainId: number): V4Deployment {
  const deployment = strategyChain(chainId).uniV4
  if (!deployment) throw new Error(`Uniswap v4 is not configured on chain ${chainId}`)
  return deployment
}

export function positionManagerFor(chainId: number, protocol: StrategyLpProtocol): Address {
  const chain = strategyChain(chainId)
  if (protocol === 'up33' && chain.key === 'robinhood') return chain.addr.CL_PM
  if (protocol === 'univ4') return v4Deployment(chainId).POSITION_MANAGER
  return v3Deployment(chainId, protocol).positionManager
}

export function factoryFor(chainId: number, protocol: StrategyLpProtocol): Address {
  const chain = strategyChain(chainId)
  if (protocol === 'up33' && chain.key === 'robinhood') return chain.addr.CL_FACTORY
  return v3Deployment(chainId, protocol).factory
}
