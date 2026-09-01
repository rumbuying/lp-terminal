/**
 * A confirmed transaction from the same wallet can legitimately consume a
 * nonce while an executor transaction is being prepared or broadcast. Once
 * `latest` has advanced past the tracked nonce and the tracked hash is absent,
 * that exact signed transaction cannot still land: account nonces admit only
 * one confirmed transaction. Treat it as superseded and rebuild from fresh
 * chain state. A pending-only displacement remains ambiguous because either
 * transaction may still be replaced or mined.
 */
export function classifyMissingTransactionNonce(args: {
  nonce: bigint
  latest: bigint
  pending: bigint
  hasConfirmedLocalReplacement?: boolean
}): 'absent' | 'ambiguous' {
  if (args.latest > args.nonce) return 'absent'
  if (args.pending <= args.nonce) return 'absent'
  return args.hasConfirmedLocalReplacement ? 'absent' : 'ambiguous'
}
