import type { Address, Hex } from 'viem'

type SolverTransaction = {
  requiredFrom?: Address
  to: Address
  data: Hex
  value: bigint
}

type GasEstimator = {
  estimateGas(request: Omit<SolverTransaction, 'requiredFrom'> & { account: Address }): Promise<bigint>
}

/** Execute the final solver calldata as an estimate, then return a bounded
 *  gas limit for the identical transaction. A revert is deliberately not
 *  caught: preflight failure must stop broadcast. */
export async function preflightSolverTransaction(
  client: GasEstimator,
  account: Address,
  tx: SolverTransaction,
): Promise<bigint> {
  // Production tx payloads predate `requiredFrom`; enforce the binding as soon
  // as the upgraded solver supplies it, without rejecting today's valid tx.
  if (tx.requiredFrom && account.toLowerCase() !== tx.requiredFrom.toLowerCase()) {
    throw new Error('solver transaction is bound to a different submitting account')
  }
  const estimated = await client.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value })
  return (estimated * 6n + 4n) / 5n
}
