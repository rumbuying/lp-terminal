import type { Address, Hex } from 'viem'

type SolverTransaction = {
  to: Address
  data: Hex
  value: bigint
}

type GasEstimator = {
  estimateGas(request: SolverTransaction & { account: Address }): Promise<bigint>
}

/** Execute the final solver calldata as an estimate, then return a bounded
 *  gas limit for the identical transaction. A revert is deliberately not
 *  caught: preflight failure must stop broadcast. */
export async function preflightSolverTransaction(
  client: GasEstimator,
  account: Address,
  tx: SolverTransaction,
): Promise<bigint> {
  const estimated = await client.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value })
  return (estimated * 6n + 4n) / 5n
}
