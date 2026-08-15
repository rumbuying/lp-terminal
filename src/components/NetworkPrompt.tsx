import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount, useSwitchChain } from 'wagmi'
import { CHAIN_ID } from '../config/addresses'
import { CHAIN } from '../config/chains'
import { wagmiConfig } from '../config/wagmi'
import { Modal } from './Modal'
import { Btn } from './ui'

/**
 * Everything this app has to say about the wallet being on another chain: a
 * dialog that asks, and a bar that keeps asking once the dialog is put away.
 *
 * The ask is a BUTTON, never automatic. Fired from an effect on load, the
 * request went out and did not come back: the dialog sat on "waiting for your
 * wallet" with no wallet prompt anywhere behind it. A click lands after the
 * page has settled, and it is a user gesture — which is what a wallet will
 * raise a window for.
 *
 * Nothing here is an alarm either. Reads all work — the pools, the prices,
 * somebody else's positions — and only signing needs the two sides to agree,
 * so the dialog wears the terminal's accent and the bar is amber. Red would be
 * claiming something is broken; this is something left undone.
 *
 * `enabled` is off for the BRIDGE tab, which is the one place that WANTS the
 * wallet elsewhere (it sends from the origin chain). Rendered even then, so
 * visiting the bridge and coming back does not reopen a dialog already
 * answered.
 */
export function NetworkPrompt({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation()
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending: switching, error } = useSwitchChain()
  const [dismissed, setDismissed] = useState<number | null>(null)

  const wrong = enabled && isConnected && chainId !== undefined && chainId !== CHAIN_ID
  if (!wrong) return null

  // named where wagmi knows the chain (both home chains and the four bridge
  // counterparties), a bare number anywhere else — the wallet may be on a
  // network this build has never heard of
  const walletChain = wagmiConfig.chains.find((c) => c.id === chainId)
  const from = walletChain?.name ?? t('net.unknown', { id: chainId })

  // Deliberately NOT disabled while a request is in flight. A wallet that never
  // raises its prompt leaves isPending true for good, and pressing again is the
  // one thing that can fix that — a busy button would make the dead state
  // permanent. The line beside it says what is happening instead.
  const ask = <Btn onClick={() => switchChain({ chainId: CHAIN_ID })}>{t('net.go')}</Btn>
  const put = () => setDismissed(chainId)

  // put away, still true: the same question, out of the way
  if (dismissed === chainId)
    return (
      <div className="netbar">
        <span>{switching ? t('net.confirm') : t('net.bar', { from, to: CHAIN.name })}</span>
        {ask}
      </div>
    )

  return (
    <Modal
      title={t('net.title')}
      onClose={put}
      foot={
        <>
          <Btn tone="ghost" onClick={put}>
            {t('net.later')}
          </Btn>
          {ask}
        </>
      }
    >
      <div className="net-row">
        <span className="net-k">{t('net.wallet')}</span>
        <b>{from}</b>
        <span className="net-id">#{chainId}</span>
      </div>
      <div className="net-row to">
        <span className="net-k">{t('net.page')}</span>
        <b>{CHAIN.name}</b>
        <span className="net-id">#{CHAIN_ID}</span>
      </div>
      <div className="dim">{t('net.reads')}</div>
      {switching ? (
        <div className="amber">{t('net.confirm')}</div>
      ) : (
        error && <div className="dim">{t('net.failed')}</div>
      )}
    </Modal>
  )
}
