import { useTranslation } from 'react-i18next'
import { CHAIN } from '../config/chains'
import { safeWebsite, type LaunchpadToken } from '../lib/launchpadToken'

/**
 * Where a token came from, when the launchpad's own factory can prove it.
 *
 * The claim is narrow and it is the factory's, not ours: this contract lives at
 * the CREATE2 address that factory derives for a token calling itself this, so
 * that factory deployed it. It says nothing about the token being good, and
 * nothing about the twenty tokens on this chain wearing the same name — which
 * is exactly why the mark is worth having. A copy of a launchpad token is not a
 * launchpad token, and until now the two looked identical in a pair label.
 *
 * The RELEASE suffix separates a sale that ran through one of the launchpad's
 * own liquidity contracts from a token minted straight off the factory, and
 * names which generation ran it. All of them are genuine; only a sale had a
 * market built for it, and the factory is shared widely enough that "minted
 * through it" and "launched on it" are different sentences.
 *
 * The suffix carries the difference in style too — solid border and a lit
 * suffix for the generation running today, dashed and dim for the one it
 * replaced. Same cyan throughout, because it is the same launchpad: the border
 * says which contract, never which is worth trading.
 *
 * Which one is "today" is read off the config's order rather than spelled into
 * the stylesheet, so the day a v3 lands it inherits the current look and v2
 * fades to the older one without a CSS edit to remember.
 */
export function LaunchpadBadge(props: { token: LaunchpadToken; compact?: boolean }) {
  const { t } = useTranslation()
  const pad = CHAIN.launchpad
  if (!pad || props.token.launchpad !== pad.id) return null
  const release = pad.releases.find((r) => r.id === props.token.release) ?? null
  const current = !!release && pad.releases[pad.releases.length - 1]?.id === release.id
  const title = release
    ? t('launchpad.launchedTip', { pad: pad.label, release: release.short })
    : t('launchpad.mintedTip', { pad: pad.label })
  if (props.compact)
    return (
      <span
        className="proto-mini launchpad"
        data-release={release ? (current ? 'current' : 'past') : undefined}
        title={title}
        aria-hidden="true"
      >
        ◈
      </span>
    )
  return (
    <a
      className="badge launchpad"
      // the styling hook is the generation's STANDING, not its name, so a row
      // that shows no suffix (a bare mint) cannot pick up a generation's look
      data-release={release ? (current ? 'current' : 'past') : undefined}
      // the token's own site where it survives the scheme check, the
      // launchpad's where it does not — never an unvetted string
      href={safeWebsite(props.token.website) ?? pad.url}
      target="_blank"
      rel="noreferrer"
      title={title}
    >
      <span aria-hidden="true">◈</span>
      {pad.label}
      {release && <span className="release"> · {release.short}</span>}
      <span aria-hidden="true">↗</span>
    </a>
  )
}
