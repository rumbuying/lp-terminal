/**
 * Is this a WalletConnect project id that can actually work?
 *
 * A reown (WalletConnect Cloud) project id is exactly 32 hex characters. The
 * failure this guards against is unusually nasty because it is SILENT: hand
 * WalletConnect anything else and the relay 403s, no pairing uri is ever
 * produced, and the wallet entry in the modal simply does nothing when tapped
 * — no error, no spinner, nothing for the user to report but "the button is
 * dead". Rainbow and MetaMask go with it, since both reach non-extension
 * users over the same relay.
 *
 * That shipped to production once (the build carried the local placeholder,
 * fixed 2026-07-23), which is why the check lives here with tests rather than
 * inline: the caller uses it to decide whether to OFFER those wallets at all.
 */
const PROJECT_ID = /^[0-9a-f]{32}$/i

export function isWalletConnectProjectId(id: string): boolean {
  return PROJECT_ID.test(id)
}
