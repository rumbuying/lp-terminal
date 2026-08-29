import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { customRpc } from './rpcPref'
import { activeChain } from '../config/chain'
import { ACTIVE_IS_BUILD, CHAIN } from '../config/chains'
import { activeRpcUrls } from '../config/chains/routes'
import { ENV, PUBLIC_RPC } from '../config/env'

/**
 * The position scanner's own chain-bound client.
 *
 * Position discovery is the app's widest wallet read (NFT enumeration, per-pool
 * balances, fee simulations, farm walks) and it fires every thirty seconds.
 *
 * It follows the same explicit transport policy as the rest of the terminal:
 * user RPC, local/private build RPC, same-origin proxy, then public fallback.
 * This matters when an official endpoint puts JSON-RPC behind a browser
 * challenge: a per-call multicall failure must not make one valid NFT index
 * look corrupt or blank every position. The client remains separate from
 * wagmi so wallet lifecycle changes cannot replace it mid-scan.
 */
const buildEnv = (import.meta as ImportMeta & { env?: { PROD?: boolean } }).env
const urls = activeRpcUrls({
  chainKey: CHAIN.key,
  publicRpc: PUBLIC_RPC,
  customRpc: customRpc() || null,
  envRpc: ENV.rpcUrl,
  production: buildEnv?.PROD === true,
  gatewayEnabled: ENV.chainGateway,
  activeIsBuild: ACTIVE_IS_BUILD,
})

export const publicRpcClient = createPublicClient({
  chain: activeChain,
  transport:
    urls.length === 1
      ? http(urls[0], { batch: true })
      : fallback(urls.map((url) => http(url, { batch: true }))),
}) as PublicClient
