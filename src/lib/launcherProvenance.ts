// Whether a configured LiquidityLauncher really is the launchpad's.
//
// The question this answers is NOT "does this address run launcher code" —
// bytecode is free to redeploy, and on Robinhood Chain a stranger's copy at
// 0xe050309b… was minting 132 tokens a day when this was written. It is "did
// the launchpad's own deployer put it there", which nobody else can arrange.
//
// The proof is entirely local once the transaction is in hand:
//
//   1. the launchpad's `deployer` sent it,
//   2. it was sent TO the CREATE2 factory, whose calldata is salt ‖ initcode,
//   3. CREATE2(factory, salt, keccak(initcode)) is the configured address.
//
// Step 3 is the load-bearing one. CREATE2 is a function of those three inputs
// and nothing else — no nonce, no ordering, no chain state — so a transaction
// that satisfies it could not have produced any other address, and no other
// transaction could have produced this one. There is nothing left to trust.
//
// Deliberately RPC-only. An explorer is how you FIND a deployment; it is never
// how you accept one, because "the explorer said so" is exactly the assurance
// a wrong entry would also come with.
import { getCreate2Address, keccak256, type Address, type Hex } from 'viem'

/** a deployment transaction, in the two fields the proof reads */
export type DeployTx = { from: string | null; to: string | null; input: Hex }

export type LauncherProof =
  | { ok: true; address: Address }
  | { ok: false; reason: string }

const same = (a: string | null | undefined, b: string) =>
  !!a && a.toLowerCase() === b.toLowerCase()

/**
 * The address a CREATE2-factory call deploys to, read off its own calldata.
 *
 * The deterministic deployer's convention is the whole ABI: the first 32 bytes
 * are the salt and the rest is the initcode. A call carrying less than a salt
 * plus one byte of code deploys nothing, so it is rejected rather than hashed
 * into a plausible-looking address.
 */
export function create2Deployed(factory: Address, input: Hex): Address | null {
  const body = input.startsWith('0x') ? input.slice(2) : input
  if (body.length <= 64 || body.length % 2 !== 0) return null
  return getCreate2Address({
    from: factory,
    salt: `0x${body.slice(0, 64)}`,
    bytecodeHash: keccak256(`0x${body.slice(64)}`),
  })
}

/**
 * Does this transaction prove this address belongs to this launchpad?
 *
 * Every rejection names which of the three steps failed, because the three mean
 * very different things: a wrong sender is somebody else's contract, a wrong
 * target is a deployment path this proof does not cover, and a wrong derived
 * address means the transaction and the entry beside it are unrelated.
 */
export function provesLauncher(args: {
  address: Address
  tx: DeployTx
  deployer: Address
  create2Factory: Address
}): LauncherProof {
  const { address, tx, deployer, create2Factory } = args
  if (!same(tx.from, deployer))
    return { ok: false, reason: `sent by ${tx.from ?? 'nobody'}, not the launchpad's deployer` }
  if (!same(tx.to, create2Factory))
    return { ok: false, reason: `sent to ${tx.to ?? 'a bare creation'}, not the CREATE2 factory` }
  const derived = create2Deployed(create2Factory, tx.input)
  if (!derived) return { ok: false, reason: 'calldata is not a salt followed by an initcode' }
  if (!same(derived, address))
    return { ok: false, reason: `deploys ${derived}, not this address` }
  return { ok: true, address: derived }
}
