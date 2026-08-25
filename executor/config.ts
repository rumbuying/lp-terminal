import { accessSync, constants, mkdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'

const env = (key: string) => process.env[key]?.trim() || undefined

function boundedInteger(key: string, fallback: number, min: number, max: number): number {
  const value = Number(env(key) ?? fallback)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`)
  return value
}

function addressList(key: string) {
  return (env(key)?.split(',').map((value) => getAddress(value.trim())).filter(Boolean) ?? [])
}

function readSecretFile(path: string, label: string): Buffer {
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`)
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0600 or stricter`)
  accessSync(path, constants.R_OK)
  const value = readFileSync(path)
  if (value.length < 32) throw new Error(`${label} must contain at least 32 bytes`)
  return value
}

function readLockedTextFile(path: string, label: string): string {
  const value = readSecretFile(path, label).toString('utf8').trim()
  if (!value) throw new Error(`${label} must not be empty`)
  return value
}

function exclusiveTextSource(literalKey: string, fileKey: string): { value?: string; source: 'env' | 'file' | 'default' } {
  const literal = env(literalKey)
  const file = env(fileKey)
  if (literal && file) throw new Error(`set exactly one of ${literalKey} or ${fileKey}`)
  if (file) return { value: readLockedTextFile(file, fileKey), source: 'file' }
  if (literal) return { value: literal, source: 'env' }
  return { source: 'default' }
}

function masterSecret(): Buffer | undefined {
  const file = env('LP_EXECUTOR_MASTER_KEY_FILE')
  const literal = env('LP_EXECUTOR_MASTER_KEY')
  if (file && literal) throw new Error('set exactly one master-key source, never both')
  if (file) return readSecretFile(file, 'LP_EXECUTOR_MASTER_KEY_FILE')
  if (literal) {
    const value = Buffer.from(literal, 'utf8')
    if (value.length < 32) throw new Error('LP_EXECUTOR_MASTER_KEY must contain at least 32 bytes')
    return value
  }
  return undefined
}

function apiToken(): Buffer | undefined {
  const file = env('LP_EXECUTOR_API_TOKEN_FILE')
  const literal = env('LP_EXECUTOR_API_TOKEN')
  if (file && literal) throw new Error('set exactly one API-token source, never both')
  if (file) {
    // Tokens are commonly generated with a trailing newline (openssl, pwgen).
    // Treat that newline as file formatting, not as bearer-token material.
    const value = readSecretFile(file, 'LP_EXECUTOR_API_TOKEN_FILE').toString('utf8').trimEnd()
    if (Buffer.byteLength(value) < 32) throw new Error('LP_EXECUTOR_API_TOKEN_FILE must contain at least 32 bytes')
    return Buffer.from(value, 'utf8')
  }
  return literal ? Buffer.from(literal, 'utf8') : undefined
}

const dataDir = env('LP_EXECUTOR_DATA_DIR') ?? fileURLToPath(new URL('./data', import.meta.url))
mkdirSync(dataDir, { recursive: true, mode: 0o700 })

const rpc = exclusiveTextSource('LP_EXECUTOR_RPC', 'LP_EXECUTOR_RPC_FILE')
const rpcUrl = rpc.value ?? 'https://rpc.mainnet.chain.robinhood.com'
const parsedRpc = new URL(rpcUrl)
if (!['http:', 'https:'].includes(parsedRpc.protocol)) throw new Error('executor RPC must be an http(s) URL')

const privateKeyFile = env('LP_EXECUTOR_PRIVATE_KEY_FILE')
const privateKeyWalletId = env('LP_EXECUTOR_PRIVATE_KEY_WALLET_ID')
if (Boolean(privateKeyFile) !== Boolean(privateKeyWalletId))
  throw new Error('LP_EXECUTOR_PRIVATE_KEY_FILE and LP_EXECUTOR_PRIVATE_KEY_WALLET_ID must be set together')
if (privateKeyWalletId && !/^[a-zA-Z0-9_-]{8,128}$/.test(privateKeyWalletId))
  throw new Error('LP_EXECUTOR_PRIVATE_KEY_WALLET_ID must be 8-128 URL-safe characters')
if (privateKeyFile) readLockedTextFile(privateKeyFile, 'LP_EXECUTOR_PRIVATE_KEY_FILE')

const host = env('LP_EXECUTOR_HOST') ?? '127.0.0.1'
if (!['127.0.0.1', '::1'].includes(host)) throw new Error('executor may only bind loopback; expose it through a TLS reverse proxy')

export const EXECUTOR = {
  host,
  port: Number(env('LP_EXECUTOR_PORT') ?? 8790),
  dataDir,
  vaultDir: `${dataDir}/vaults`,
  dbPath: env('LP_EXECUTOR_DB') ?? `${dataDir}/state.db`,
  rpcUrl,
  rpcSource: rpc.source,
  rpcRetryCount: boundedInteger('LP_EXECUTOR_RPC_RETRY_COUNT', 5, 0, 12),
  rpcRetryDelayMs: boundedInteger('LP_EXECUTOR_RPC_RETRY_DELAY_MS', 400, 50, 10_000),
  rpcTimeoutMs: boundedInteger('LP_EXECUTOR_RPC_TIMEOUT_MS', 15_000, 1_000, 120_000),
  privateKeyFile,
  privateKeyWalletId,
  kyberBase: (env('LP_EXECUTOR_KYBER_BASE') ?? 'https://aggregator-api.kyberswap.com').replace(/\/+$/, ''),
  kyberChain: env('LP_EXECUTOR_KYBER_CHAIN') ?? 'robinhood',
  kyberRouter: getAddress(env('LP_EXECUTOR_KYBER_ROUTER') ?? '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'),
  solverBase: (env('LP_EXECUTOR_SOLVER_BASE') ?? 'https://solver.lp-terminal.xyz').replace(/\/+$/, ''),
  indexerBase: (env('LP_EXECUTOR_INDEXER_BASE') ?? 'http://127.0.0.1:8787').replace(/\/+$/, ''),
  // Solver calldata is opaque. It is never executable unless both returned
  // addresses are explicitly allowlisted by the operator.
  solverSettlers: addressList('LP_EXECUTOR_SOLVER_SETTLERS'),
  solverAllowanceTargets: addressList('LP_EXECUTOR_SOLVER_ALLOWANCE_TARGETS'),
  masterSecret: masterSecret(),
  apiToken: apiToken(),
  allowedOrigins: (env('LP_EXECUTOR_ALLOWED_ORIGIN')?.split(',').map((value) => value.trim()).filter(Boolean) ?? [
    'http://127.0.0.1:4173',
    'http://localhost:4173',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]),
  pollMs: Number(env('LP_EXECUTOR_POLL_MS') ?? 4_000),
  // The main loop stays responsive for jobs/recovery, while ordinary price
  // monitoring is independently rate-limited below. Existing strategies that
  // persisted the old 4-second default automatically inherit this floor.
  monitorMinSeconds: boundedInteger('LP_EXECUTOR_MONITOR_MIN_SECONDS', 10, 2, 300),
  monitorIdentityTtlSeconds: boundedInteger('LP_EXECUTOR_MONITOR_IDENTITY_TTL_SECONDS', 300, 30, 3600),
  confirmations: boundedInteger('LP_EXECUTOR_CONFIRMATIONS', 2, 1, 12),
  maxBodyBytes: 16 * 1024,
} as const

export function readConfiguredPrivateKey(): string | undefined {
  return EXECUTOR.privateKeyFile ? readLockedTextFile(EXECUTOR.privateKeyFile, 'LP_EXECUTOR_PRIVATE_KEY_FILE') : undefined
}
