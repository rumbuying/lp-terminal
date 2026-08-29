/**
 * Robinhood Chain currently accepts legacy transactions, but its public RPC
 * can briefly report an eth_gasPrice below the latest block's base fee.
 * Keep enough headroom for the next block and increase it again on a safe
 * pre-broadcast retry.
 */
export function bufferedLegacyGasPrice(suggested: bigint, baseFee: bigint | undefined, previous?: bigint): bigint {
  const reference = [suggested, baseFee ?? 0n, previous ?? 0n].reduce((highest, value) => value > highest ? value : highest, 0n)
  return (reference * 125n + 99n) / 100n
}

export function isRetryableFeeRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /max fee per gas less than block base fee|fee cap less than block base fee|transaction underpriced/i.test(message)
}
