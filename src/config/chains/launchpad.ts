import type { Address, Hex } from 'viem'

/**
 * A token launchpad whose tokens the chain itself can identify.
 *
 * The problem is the same one stockIssuers.ts exists for, from the other end: a
 * pool is only worth calling "a pools.trade market" if the token in it really
 * did come from pools.trade, and a launchpad token is exactly the kind of asset
 * an impersonator has a reason to copy — same name, same picture, same story,
 * different contract.
 *
 * What makes the question answerable here is CREATE2. The factory derives every
 * token's address from the token's own identity — `getUERC20Address(name,
 * symbol, decimals, creator, graffiti)` — and only the factory can deploy at the
 * address that derivation names. So a token that reports those five fields and
 * hashes back to its own address was deployed by this factory, and one that does
 * not, was not. Nothing here is a list, and there is nothing to keep up to date:
 * a token minted a minute ago proves itself the same way as the first one.
 *
 * The proof is DISPLAY and BROWSING only — a market filter and a mark, exactly
 * like the issuer proof. It never reaches routing, quoting or execution. A token
 * coming from a launchpad says nothing about whether its pool is worth trading
 * through, and the moment provenance earns a token special handling in the
 * solver we have started predicting instead of measuring.
 */
export type LaunchpadId = 'poolsTrade'

/**
 * A generation of the launchpad's liquidity contract.
 *
 * There is more than one, live at the same time, and that is the normal state
 * rather than a migration to wait out: the factory is shared and permissionless,
 * so a new LiquidityLauncher is just another caller of it. Old sales keep
 * running through the old one and new sales arrive on the new one, and a token
 * from either is equally the launchpad's.
 *
 * The releases are ORDERED oldest-first. Nothing reads that order to decide what
 * a token is — the launcher address does that — but the filter row and the mark
 * both present them in it, so a reader sees the same sequence the chain does.
 */
export type LaunchpadReleaseId = 'v1' | 'v2'

/**
 * One deployed LiquidityLauncher, with the receipt that makes it the
 * launchpad's rather than a lookalike.
 *
 * `deployTx` is not provenance decoration — it is the proof, and it is why
 * adding a launcher can be fast without being careless. Together with the
 * config's `deployer` and `create2Factory` it settles the question from RPC
 * alone and forever: that transaction was sent by the launchpad's own deployer,
 * its calldata is a salt and an initcode, and CREATE2 sends that pair to
 * exactly this address and no other. Nothing here is trusted on assertion.
 *
 * The failure it exists to stop is live on Robinhood Chain, not hypothetical:
 * 0xe050309b… runs launcher-shaped code, was minting 132 tokens a day when this
 * was written, and belongs to a stranger. Code can be copied and a name can be
 * claimed; the deployer's signature over the salt cannot.
 */
export type LaunchpadLauncher = {
  address: Address
  /** the CREATE2 call that produced it — see scripts/launcher-add.ts */
  deployTx: Hex
}

export type LaunchpadRelease = {
  id: LaunchpadReleaseId
  /** the sub-filter's text and the mark's suffix — two characters in a dense row */
  short: string
  /**
   * Every launcher running this release's code.
   *
   * A list, because a release is not one address: a launcher gets deployed,
   * used, and then redeployed to a vanity address hours later, and the first one
   * keeps taking sales. Both are the same code and the same generation, so both
   * belong to the same entry — the alternative is a "v3" that is a lie about
   * what changed.
   */
  launchers: readonly LaunchpadLauncher[]
}

export type LaunchpadConfig = {
  id: LaunchpadId
  /** the chip's text — short enough for a dense filter row */
  label: string
  /** the launchpad's own site, linked from the mark */
  url: string
  /**
   * The token factory. Both the deployer of every launchpad token and the
   * oracle that proves one: `getUERC20Address` recomputes the CREATE2 address
   * from a candidate's self-reported identity.
   */
  tokenFactory: Address
  /**
   * The EOA that deploys this launchpad's contracts.
   *
   * The anchor everything else hangs from. A launcher's bytecode is free for
   * anyone to redeploy and its name is free for anyone to claim, so neither
   * identifies the launchpad; a signature from this account over the salt that
   * produced the address does. Never read in the browser — the interface proves
   * a TOKEN through the factory's own derivation. This is what proves the
   * config, at the moment a human edits it.
   */
  deployer: Address
  /** the deterministic deployer those launchers are created through */
  create2Factory: Address
  /**
   * The contracts that run a launch and migrate it into a plain v4 pool, by
   * generation. Not read for the proof — a launchpad token can also be created
   * straight from the factory — but a launcher is the `creator()` of every token
   * whose sale it ran, so this is what tells a sale from a self-served mint, and
   * which generation of the launchpad ran it.
   */
  releases: readonly LaunchpadRelease[]
}

/**
 * Which generation ran this token's sale, or null for a token minted straight
 * off the factory.
 *
 * Matched by ADDRESS, not by code. The launcher's constructor takes only
 * Permit2, so anyone can deploy the same bytecode and be the `creator()` of
 * their own tokens — measured on Robinhood Chain, where two unrelated
 * launchpads already mint through the same factory. Only the addresses this
 * config vouches for are the launchpad's, and a codehash comparison would hand
 * the mark to whoever copied the source.
 */
export function launcherRelease(
  creator: string,
  launchpad: LaunchpadConfig,
): LaunchpadReleaseId | null {
  const who = creator.toLowerCase()
  for (const release of launchpad.releases)
    if (release.launchers.some((l) => l.address.toLowerCase() === who)) return release.id
  return null
}

/** every configured launcher, flattened with the release it belongs to */
export function launchpadLaunchers(
  launchpad: LaunchpadConfig,
): { release: LaunchpadRelease; launcher: LaunchpadLauncher }[] {
  return launchpad.releases.flatMap((release) =>
    release.launchers.map((launcher) => ({ release, launcher })),
  )
}
