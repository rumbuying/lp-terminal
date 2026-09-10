import { getAddress, parseAbi, type Address, type Hex } from 'viem'

/** Canonical cross-chain 0x Settler registry. Feature 2 is the
 * taker-submitted Settler used by executable swap quotes. */
export const ZERO_EX_SETTLER_REGISTRY = '0x00000000000004533Fe15556B1E086BB1A72cEae' as Address
const TAKER_SUBMITTED_FEATURE = 2n
const registryAbi = parseAbi([
  'function ownerOf(uint256 featureId) view returns (address)',
  'function prev(uint128 featureId) view returns (address)',
])

type SolverTransaction = {
  requiredFrom?: Address
  to: Address
  data: Hex
  value: bigint
}

type SolverPreflightClient = {
  estimateGas(request: Omit<SolverTransaction, 'requiredFrom'> & { account: Address }): Promise<bigint>
  readContract(request: Record<string, unknown>): Promise<unknown>
}

/** The registry may expose the immediately previous deployment while the API
 * dwells on it. A reverting ownerOf means the feature is paused and fails
 * closed; never substitute a server-provided list. */
export async function assertGenuineSolverSettler(client: Pick<SolverPreflightClient, 'readContract'>, alleged: Address): Promise<void> {
  let current: Address
  try {
    current = getAddress(await client.readContract({ address: ZERO_EX_SETTLER_REGISTRY, abi: registryAbi,
      functionName: 'ownerOf', args: [TAKER_SUBMITTED_FEATURE] }) as Address)
  } catch {
    throw new Error('solver Settler registry is unavailable or paused')
  }
  if (current === getAddress(alleged)) return
  let previous: Address
  try {
    previous = getAddress(await client.readContract({ address: ZERO_EX_SETTLER_REGISTRY, abi: registryAbi,
      functionName: 'prev', args: [TAKER_SUBMITTED_FEATURE] }) as Address)
  } catch {
    throw new Error('solver Settler registry is unavailable or paused')
  }
  if (previous !== getAddress(alleged)) throw new Error('solver transaction targets a counterfeit Settler')
}

/** Authenticate the target Settler, execute the final calldata as an estimate,
 *  then return a bounded gas limit for the identical transaction. A revert is
 *  deliberately not caught: preflight failure must stop broadcast. */
export async function preflightSolverTransaction(
  client: SolverPreflightClient,
  account: Address,
  tx: SolverTransaction,
  settler: Address,
): Promise<bigint> {
  // Production tx payloads predate `requiredFrom`; enforce the binding as soon
  // as the upgraded solver supplies it, without rejecting today's valid tx.
  if (tx.requiredFrom && account.toLowerCase() !== tx.requiredFrom.toLowerCase()) {
    throw new Error('solver transaction is bound to a different submitting account')
  }
  await assertGenuineSolverSettler(client, settler)
  const estimated = await client.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value })
  return (estimated * 6n + 4n) / 5n
}
