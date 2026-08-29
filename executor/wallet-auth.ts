import { randomBytes } from 'node:crypto'
import { getAddress, verifyMessage, type Address, type Hex } from 'viem'

const CHALLENGE_TTL_MS = 5 * 60_000
const SESSION_TTL_MS = 8 * 60 * 60_000
const RATE_WINDOW_MS = 10 * 60_000
const MAX_CHALLENGES_PER_ADDRESS = 8
const MAX_LIVE_CHALLENGES = 2_000
const MAX_LIVE_SESSIONS = 5_000

type Challenge = {
  address: Address
  origin: string
  message: string
  expiresAt: number
}

export type WalletSession = {
  address: Address
  expiresAt: number
}

export class WalletAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const challenges = new Map<string, Challenge>()
const sessions = new Map<string, WalletSession>()
const attempts = new Map<string, number[]>()

const randomToken = () => randomBytes(32).toString('base64url')

function cleanup(now: number) {
  for (const [id, challenge] of challenges) if (challenge.expiresAt <= now) challenges.delete(id)
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token)
  for (const [address, values] of attempts) {
    const recent = values.filter((value) => now - value < RATE_WINDOW_MS)
    if (recent.length) attempts.set(address, recent)
    else attempts.delete(address)
  }
}

function normalizedAddress(value: unknown): Address {
  if (typeof value !== 'string') throw new WalletAuthError('wallet address is required', 400)
  try { return getAddress(value) } catch { throw new WalletAuthError('wallet address is invalid', 400) }
}

function normalizedSignature(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(value))
    throw new WalletAuthError('wallet signature is invalid', 400)
  return value as Hex
}

function loginMessage(address: Address, origin: string, nonce: string, issuedAt: number, expiresAt: number): string {
  const host = new URL(origin).host
  return [
    'LP Terminal 策略只读登录',
    '',
    `域名: ${host}`,
    `钱包: ${address}`,
    `Nonce: ${nonce}`,
    `签发时间: ${new Date(issuedAt).toISOString()}`,
    `过期时间: ${new Date(expiresAt).toISOString()}`,
    '',
    '此签名仅用于查看该钱包的策略、历史和盈亏，不会发起链上交易。',
  ].join('\n')
}

export function issueWalletChallenge(rawAddress: unknown, origin: string, now = Date.now()) {
  cleanup(now)
  const address = normalizedAddress(rawAddress)
  const key = address.toLowerCase()
  const recent = (attempts.get(key) ?? []).filter((value) => now - value < RATE_WINDOW_MS)
  if (recent.length >= MAX_CHALLENGES_PER_ADDRESS) throw new WalletAuthError('too many wallet login attempts; try again later', 429)
  if (challenges.size >= MAX_LIVE_CHALLENGES) throw new WalletAuthError('wallet login is temporarily busy', 503)
  recent.push(now)
  attempts.set(key, recent)

  const id = randomToken()
  const nonce = randomToken()
  const expiresAt = now + CHALLENGE_TTL_MS
  const message = loginMessage(address, origin, nonce, now, expiresAt)
  challenges.set(id, { address, origin, message, expiresAt })
  return { id, address, message, expiresAt: Math.floor(expiresAt / 1000) }
}

export async function verifyWalletChallenge(
  challengeId: unknown,
  rawAddress: unknown,
  rawSignature: unknown,
  origin: string,
  now = Date.now(),
) {
  cleanup(now)
  if (typeof challengeId !== 'string' || !challengeId) throw new WalletAuthError('wallet challenge is required', 400)
  const challenge = challenges.get(challengeId)
  // Consume before signature verification so a failed or replayed attempt cannot reuse it.
  challenges.delete(challengeId)
  if (!challenge || challenge.expiresAt <= now) throw new WalletAuthError('wallet challenge expired; request a new signature', 401)
  const address = normalizedAddress(rawAddress)
  if (challenge.origin !== origin || challenge.address.toLowerCase() !== address.toLowerCase())
    throw new WalletAuthError('wallet challenge does not match this request', 401)
  const signature = normalizedSignature(rawSignature)
  const valid = await verifyMessage({ address, message: challenge.message, signature })
  if (!valid) throw new WalletAuthError('wallet signature verification failed', 401)
  if (sessions.size >= MAX_LIVE_SESSIONS) throw new WalletAuthError('wallet login is temporarily busy', 503)

  const token = randomToken()
  const expiresAt = now + SESSION_TTL_MS
  sessions.set(token, { address, expiresAt })
  return { token, address, expiresAt: Math.floor(expiresAt / 1000) }
}

export function walletSession(token: string | undefined, now = Date.now()): WalletSession | undefined {
  if (!token) return undefined
  const session = sessions.get(token)
  if (!session) return undefined
  if (session.expiresAt <= now) {
    sessions.delete(token)
    return undefined
  }
  return session
}

export function resetWalletAuthForTests() {
  challenges.clear()
  sessions.clear()
  attempts.clear()
}
