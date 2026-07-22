// Canonical Arbitrum bridge ("portal") provider: native ETH deposits
// Ethereum → Robinhood via Inbox.depositEth(). Lossless 1:1 — no solver, no
// bridge fee, only L1 gas — but slow (real deposits measured 484–689s on
// 2026-07-18, so it quotes PORTAL_ETA_SEC). Scope is deliberately narrow:
//   - ETH only. ERC-20s canonically bridge into the gateway's OWN wrapped
//     tokens: verified on-chain that calculateL2TokenAddress(mainnet USDG)
//     != the real Robinhood USDG (which is LayerZero-OFT-issued instead).
//   - deposits only. Canonical withdrawals sit out the rollup challenge
//     period (days) — the external portal link stays the escape hatch.
// Fill tracking needs no status API at all: an EthDeposit's child tx hash is
// derivable from the deposit receipt, so "did it arrive" is one receipt read
// on our own Robinhood RPC. Formula validated against 3 real deposit pairs.
import {
  concatHex,
  decodeAbiParameters,
  getAddress,
  keccak256,
  pad,
  toHex,
  toRlp,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import {
  NATIVE_SENTINEL,
  PORTAL_ETA_SEC,
  PORTAL_INBOX,
  PORTAL_PARENT_CHAIN_ID,
  type ResolvedIntent,
} from '../../config/bridge'
import { CHAIN_ID } from '../../config/addresses'
import { BridgeQuoteError, type BridgeQuote } from './types'

/** Inbox.depositEth() — credits msg.sender (its alias for contract wallets) on the child chain */
export const DEPOSIT_ETH_CALLDATA = '0x439370b1' as Hex

/** topic0 of Inbox's InboxMessageDelivered(uint256 indexed messageNum, bytes data) */
const INBOX_MSG_TOPIC = '0xff64905f73a67fb594e0f940a8075a860db489ad991e032f48c81123eb52d60b'

export function quotePortal(leg: ResolvedIntent, amount: bigint): BridgeQuote {
  if (
    leg.originChainId !== PORTAL_PARENT_CHAIN_ID ||
    leg.destChainId !== CHAIN_ID ||
    leg.inputToken.toLowerCase() !== NATIVE_SENTINEL.toLowerCase()
  ) {
    throw new BridgeQuoteError('canonical bridge only deposits native ETH from Ethereum')
  }
  return {
    provider: 'portal',
    outputAmount: amount,
    minOutput: amount,
    etaSec: PORTAL_ETA_SEC,
    steps: [
      {
        kind: 'deposit',
        chainId: PORTAL_PARENT_CHAIN_ID,
        to: PORTAL_INBOX,
        data: DEPOSIT_ETH_CALLDATA,
        value: amount,
      },
    ],
    tracker: { provider: 'portal' },
    expiresAt: null,
  }
}

/** L1→L2 sender aliasing (AddressAliasHelper) — the Inbox applies it to every
 *  delayed message's sender, and the child EthDeposit tx carries the alias */
export function aliasL1Address(addr: Address): Address {
  const OFFSET = 0x1111000000000000000000000000000000001111n
  return getAddress(toHex((BigInt(addr) + OFFSET) & ((1n << 160n) - 1n), { size: 20 }))
}

const rlpNum = (x: bigint): Hex => (x === 0n ? '0x' : toHex(x))

/** child-chain tx hash of an EthDeposit message: keccak256(0x64 ‖ rlp([chainId,
 *  msgNum₃₂, aliasedSender, dest, value])) — 0x64 = ArbitrumDepositTx type.
 *  Validated 3/3 against real Ethereum→Robinhood deposits (2026-07-18). */
export function childEthDepositTxHash(
  chainId: bigint,
  messageNum: bigint,
  aliasedSender: Address,
  dest: Address,
  value: bigint,
): Hex {
  return keccak256(
    concatHex(['0x64', toRlp([rlpNum(chainId), pad(toHex(messageNum), { size: 32 }), aliasedSender, dest, rlpNum(value)])]),
  )
}

/** derive the child tx hash from a confirmed depositEth receipt: messageNum +
 *  packed (dest ‖ value) come from the Inbox's InboxMessageDelivered log, the
 *  sender is the alias of the tx sender (the Inbox aliases unconditionally) */
export function parseEthDepositReceipt(receipt: TransactionReceipt): Hex | null {
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === PORTAL_INBOX.toLowerCase() && l.topics[0] === INBOX_MSG_TOPIC,
  )
  if (!log || !log.topics[1] || !receipt.from) return null
  const [packed] = decodeAbiParameters([{ type: 'bytes' }], log.data)
  if (packed.length < 2 + 40) return null
  const dest = getAddress(`0x${packed.slice(2, 42)}`)
  const value = BigInt(`0x${packed.slice(42) || '0'}`)
  return childEthDepositTxHash(BigInt(CHAIN_ID), BigInt(log.topics[1]), aliasL1Address(receipt.from), dest, value)
}
