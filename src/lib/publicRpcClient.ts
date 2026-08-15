import { createPublicClient, http, type PublicClient } from 'viem'
import { activeChain } from '../config/chain'
import { PUBLIC_RPC } from '../config/env'

/**
 * The position scanner's own client, pinned to the chain's OFFICIAL public RPC.
 *
 * Position discovery is the app's widest wallet read (NFT enumeration, per-pool
 * balances, fee simulations, farm walks) and it fires every thirty seconds —
 * on the terminal's own RPC quota that is the one bill every visitor runs up.
 * The official endpoint rate-limits by the CALLER's IP, which is exactly right
 * for a per-wallet scan: every user spends their own allowance, from their own
 * browser, and the terminal's quota is not involved.
 *
 * Pinned means pinned: not the user's custom RPC (footer), not the same-origin
 * gateway proxy, not the env override. A public-endpoint outage degrades the
 * venue readers, which the failed-sources warning on POSITIONS now names,
 * instead of silently rerouting onto paid quota.
 */
export const publicRpcClient = createPublicClient({
  chain: activeChain,
  transport: http(PUBLIC_RPC, { batch: true }),
}) as PublicClient
