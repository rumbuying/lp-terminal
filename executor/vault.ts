import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import { EXECUTOR, readConfiguredPrivateKey } from './config'

type VaultFile = {
  version: 1
  walletId: string
  address: Address
  cipher: 'aes-256-gcm'
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  nonce: string
  ciphertext: string
  tag: string
}
const KDF = { N: 131_072, r: 8, p: 1 } as const
const privateKey = (v: string): Hex => {
  const value = v.trim()
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) throw new Error('private key must be exactly 64 hexadecimal characters, with or without 0x')
  return (value.startsWith('0x') ? value : `0x${value}`) as Hex
}
export function privateKeyAddress(raw: string): Address {
  return privateKeyToAccount(privateKey(raw)).address
}
const derive = (secret: Buffer, salt: Buffer) => scryptSync(secret, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * 1024 * 1024 })
const vaultPath = (walletId: string) => join(EXECUTOR.vaultDir, `${walletId}.json`)

function atomicWrite(path: string, data: string) {
  mkdirSync(EXECUTOR.vaultDir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const fd = openSync(tmp, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } finally {
    try { unlinkSync(tmp) } catch { /* renamed or absent */ }
  }
}

export function importPrivateKey(walletId: string, raw: string, master = EXECUTOR.masterSecret): { address: Address; path: string } {
  if (!master) throw new Error('executor master key is not configured')
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(walletId)) throw new Error('wallet id must be 8-128 URL-safe characters')
  const key = privateKey(raw)
  const account = privateKeyToAccount(key)
  const salt = randomBytes(32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derive(master, salt), nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(key.slice(2), 'hex')), cipher.final()])
  const data: VaultFile = {
    version: 1, walletId, address: account.address, cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') }, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
  }
  const path = vaultPath(walletId)
  atomicWrite(path, JSON.stringify(data))
  return { address: account.address, path }
}

export function unlockPrivateKey(walletId: string, master = EXECUTOR.masterSecret): { address: Address; privateKey: Hex } {
  if (EXECUTOR.privateKeyFile && walletId === EXECUTOR.privateKeyWalletId) {
    const raw = privateKey(readConfiguredPrivateKey() ?? '')
    const account = privateKeyToAccount(raw)
    return { address: account.address, privateKey: raw }
  }
  if (!master) throw new Error('executor master key is not configured')
  const path = vaultPath(walletId)
  const file = JSON.parse(readFileSync(path, 'utf8')) as VaultFile
  if (file.version !== 1 || file.walletId !== walletId || file.cipher !== 'aes-256-gcm' || file.kdf?.name !== 'scrypt') throw new Error('unsupported vault format')
  const salt = Buffer.from(file.kdf.salt, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', derive(master, salt), Buffer.from(file.nonce, 'base64'))
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
  const raw = `0x${Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'base64')), decipher.final()]).toString('hex')}` as Hex
  const account = privateKeyToAccount(raw)
  if (account.address.toLowerCase() !== file.address.toLowerCase()) throw new Error('vault address integrity check failed')
  return { address: account.address, privateKey: raw }
}

export function configuredFileSigner(): { walletId: string; address: Address; path: string } | undefined {
  if (!EXECUTOR.privateKeyFile || !EXECUTOR.privateKeyWalletId) return undefined
  const raw = privateKey(readConfiguredPrivateKey() ?? '')
  return {
    walletId: EXECUTOR.privateKeyWalletId,
    address: privateKeyToAccount(raw).address,
    path: EXECUTOR.privateKeyFile,
  }
}

/** Constant-time token comparison; neither token nor body is ever logged. */
export function tokenMatches(given: string | undefined, expected = EXECUTOR.apiToken): boolean {
  if (!given || !expected) return false
  const a = Buffer.from(given)
  return a.length === expected.length && timingSafeEqual(a, expected)
}
