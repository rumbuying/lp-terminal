// Shared gauge-staking primitives — one implementation behind both the manual
// STAKE buttons (PositionsTab) and the auto-stake continuation after a Zap/Pair.
// Both stakers NEVER throw: staking always runs after value has already moved
// (position minted / LP received), so an error here must surface as a log line
// and a `false`, never as a rejection that makes the whole flow look failed.
import { readContract, writeContract } from 'wagmi/actions'
import { parseAbiItem, parseEventLogs, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { clGaugeAbi, clPmAbi, v2GaugeAbi } from '../abi'
import { CHAIN_ID } from '../config/addresses'
import { wagmiConfig } from '../config/wagmi'
import { t } from '../i18n'
import {
  accountChangedMessage,
  activeAccountMatches,
  ensureAllowance,
  shortErr,
  step,
} from './tx'
import { txlog } from './txlog'

const ERC721_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
)

function stakeAccountReady(user: Address, label: string): boolean {
  if (activeAccountMatches(user)) return true
  txlog.push('err', `${label} — ${accountChangedMessage()}`)
  return false
}

/** Stake a CL position NFT into its gauge: approve the id if needed, then deposit. */
export async function stakeClNft(
  gauge: Address,
  npm: Address,
  tokenId: bigint,
  user: Address,
): Promise<boolean> {
  const label = t('pos.stStake', { id: tokenId.toString() })
  try {
    if (!stakeAccountReady(user, label)) return false
    const approved = await readContract(wagmiConfig, {
      abi: clPmAbi,
      address: npm,
      functionName: 'getApproved',
      args: [tokenId],
      chainId: CHAIN_ID,
    })
    if (approved.toLowerCase() !== gauge.toLowerCase()) {
      const ok = await step(
        t('pos.stApproveNft', { id: tokenId.toString() }),
        () =>
          writeContract(wagmiConfig, {
            account: user,
            abi: clPmAbi,
            address: npm,
            functionName: 'approve',
            args: [gauge, tokenId],
            chainId: CHAIN_ID,
          }),
        { invalidate: 'none' },
      )
      if (!ok) return false
    }
    if (!stakeAccountReady(user, label)) return false
    const ok = await step(label, () =>
      writeContract(wagmiConfig, {
        account: user,
        abi: clGaugeAbi,
        address: gauge,
        functionName: 'deposit',
        args: [tokenId],
        chainId: CHAIN_ID,
      }),
    )
    return ok !== null
  } catch (e) {
    txlog.push('err', `${label} — ${shortErr(e)}`)
    return false
  }
}

/** Stake v2 LP tokens into their gauge: approve exact, then deposit. */
export async function stakeV2Lp(
  pool: Address,
  gauge: Address,
  lp: bigint,
  user: Address,
  pair: string,
): Promise<boolean> {
  if (lp === 0n) return false
  const label = t('pos.stStakeLp', { pair })
  try {
    if (!stakeAccountReady(user, label)) return false
    if (!(await ensureAllowance(pool, user, gauge, lp, 'LP'))) return false
    if (!stakeAccountReady(user, label)) return false
    const ok = await step(label, () =>
      writeContract(wagmiConfig, {
        account: user,
        abi: v2GaugeAbi,
        address: gauge,
        functionName: 'deposit',
        args: [lp],
        chainId: CHAIN_ID,
      }),
    )
    return ok !== null
  } catch (e) {
    txlog.push('err', `${label} — ${shortErr(e)}`)
    return false
  }
}

/** The tokenId minted to `user` in a CL mint receipt (NPM ERC-721 Transfer from 0x0). */
export function mintedTokenId(rcpt: TransactionReceipt, npm: Address, user: Address): bigint | null {
  const logs = parseEventLogs({ abi: [ERC721_TRANSFER], logs: rcpt.logs })
  for (const l of logs) {
    if (
      l.address.toLowerCase() === npm.toLowerCase() &&
      l.args.from.toLowerCase() === zeroAddress &&
      l.args.to.toLowerCase() === user.toLowerCase()
    ) {
      return l.args.tokenId
    }
  }
  return null
}
