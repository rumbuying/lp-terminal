import { erc20Abi, type Address, type PublicClient } from 'viem'
import type { TokenInfo } from '../types'
import { shortAddr } from './format'

/** Resolve the ERC-20 fields required by the swap UI. `symbol()` is optional
 * in ERC-20 metadata; decimals remain mandatory because amount encoding cannot
 * be correct without them. */
export async function readTokenInfo(
  client: Pick<PublicClient, 'readContract'>,
  address: Address,
): Promise<TokenInfo> {
  const [decimals, symbol] = await Promise.all([
    client.readContract({ abi: erc20Abi, address, functionName: 'decimals' }),
    client
      .readContract({ abi: erc20Abi, address, functionName: 'symbol' })
      .catch(() => null),
  ])

  return {
    address,
    decimals,
    symbol: typeof symbol === 'string' && symbol.trim() ? symbol.trim() : shortAddr(address),
  }
}
