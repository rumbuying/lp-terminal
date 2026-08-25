import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { parseStrategyConfig } from '../shared/strategy/schema'
import { EXECUTOR } from './config'
import { addWallet, audit, clearRecoverySchedule, compoundHeldAllocations, createPlannedJob, executorPaused, jobSteps, jobTransactions, jobsForRecovery, latestJobSummary, listArchivedStrategies, listStrategies, listWallets, reactivateRecoveryJob, scheduleRecoveryRetry, setExecutorPaused, setStrategyBaselineIfAbsent, setStrategyState, strategyById, updateWalletLabel, walletByAddress, walletById, upsertStrategy } from './store'
import { importPrivateKey, privateKeyAddress, tokenMatches, unlockPrivateKey } from './vault'
import { inspectRecovery } from './recovery'
import { executeRecovery, stopAndArchiveStrategy } from './recovery-runner'
import { publicClient, readStrategySnapshot } from './chain'
import { preflightStrategy } from './preflight'
import { startSimpleStrategy } from './simple'
import { archivedAccountingPerformance, cachedStrategyPerformance, observeStrategyBaseline } from './performance'
import { rpcMetrics } from './rpc-metrics'
import { calendarRows, captureDailyPerformance } from './calendar'
import { issueWalletChallenge, verifyWalletChallenge, walletSession, WalletAuthError } from './wallet-auth'
import { recommendations } from './recommendation'
import type { RecommendationMode, RecommendationRisk } from '../shared/recommendation/types'
import { isTransientRecoveryFailure } from './recovery-policy'
import { withdrawRetainedProfit } from './profit-withdrawal'

const JSONH = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const importAttempts = new Map<string, number[]>()
const accountLabel = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('account label is required')
  const label = value.trim()
  if (label.length < 1 || label.length > 48) throw new Error('account label must be 1-48 characters')
  if(/[\u0000-\u001f\u007f]/.test(label)) throw new Error('account label contains invalid characters')
  return label
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, JSONH)
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const part = Buffer.from(chunk)
    size += part.length
    if (size > EXECUTOR.maxBodyBytes) throw new Error('request body too large')
    chunks.push(part)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object')
  return parsed as Record<string, unknown>
}

type ApiAuth = { role: 'admin' } | { role: 'wallet'; address: string }

function requestOrigin(req: IncomingMessage, res: ServerResponse, required = false): string | undefined {
  const origin = req.headers.origin
  if ((!origin && required) || (origin && !EXECUTOR.allowedOrigins.includes(origin))) {
    json(res, 403, { error: 'origin rejected' })
    return undefined
  }
  return origin
}

function authorize(req: IncomingMessage, res: ServerResponse): ApiAuth | undefined {
  if (requestOrigin(req, res) === undefined && req.headers.origin) return undefined
  const value = req.headers.authorization
  const bearer = value?.startsWith('Bearer ') ? value.slice(7) : undefined
  if (tokenMatches(bearer)) return { role: 'admin' }
  const session = walletSession(bearer)
  if (session) return { role: 'wallet', address: session.address }
  json(res, 401, { error: 'authentication required' })
  return undefined
}

function requireAdmin(auth: ApiAuth, res: ServerResponse): boolean {
  if (auth.role === 'admin') return true
  json(res, 403, { error: 'administrator authorization required' })
  return false
}

const ownedBy = (auth: ApiAuth, owner: string) => auth.role === 'admin' || owner.toLowerCase() === auth.address.toLowerCase()

async function handleWalletAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'POST' || !['/auth/challenge', '/auth/verify'].includes(url.pathname)) return false
  const origin = requestOrigin(req, res, true)
  if (!origin) return true
  try {
    const body = await readJson(req)
    if (url.pathname === '/auth/challenge') {
      json(res, 200, issueWalletChallenge(body.address, origin))
    } else {
      json(res, 200, await verifyWalletChallenge(body.challengeId, body.address, body.signature, origin))
    }
  } catch (error) {
    if (error instanceof WalletAuthError) json(res, error.status, { error: error.message })
    else {
      const message = error instanceof Error ? error.message : 'wallet authentication failed'
      json(res, /too large|JSON/.test(message) ? 400 : 500, { error: message.slice(0, 180) })
    }
  }
  return true
}

function allowPrivateKeyImport(req: IncomingMessage): boolean {
  const key = req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const recent = (importAttempts.get(key) ?? []).filter((value) => now - value < 10 * 60_000)
  if (recent.length >= 5) return false
  recent.push(now)
  importAttempts.set(key, recent)
  return true
}

export function startApi() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://executor')
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        service: 'lp-executor',
        vaultReady: Boolean(EXECUTOR.masterSecret),
        signerReady: Boolean(EXECUTOR.masterSecret || EXECUTOR.privateKeyFile),
        rpcSource: EXECUTOR.rpcSource,
        apiAuthReady: Boolean(EXECUTOR.apiToken),
        paused: executorPaused(),
      })
      return
    }
    if (await handleWalletAuth(req, res, url)) return
    const auth = authorize(req, res)
    if (!auth) return
    try {
      if (req.method === 'POST' && url.pathname === '/v1/pause-all') {
        if (!requireAdmin(auth, res)) return
        const body = await readJson(req)
        if (typeof body.paused !== 'boolean') return json(res, 400, { error: 'paused boolean is required' })
        setExecutorPaused(body.paused)
        json(res, 200, { paused: executorPaused() })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/wallets') {
        json(res, 200, { wallets: listWallets().filter((wallet) => ownedBy(auth, wallet.address)) })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/rpc-metrics') {
        if (!requireAdmin(auth, res)) return
        json(res, 200, rpcMetrics())
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/recommendations') {
        const capitalUsd = Number(url.searchParams.get('capitalUsd') ?? 1_000)
        const mode = (url.searchParams.get('mode') ?? 'fees') as RecommendationMode
        const risk = (url.searchParams.get('risk') ?? 'balanced') as RecommendationRisk
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 3, 1), 10)
        if (!Number.isFinite(capitalUsd) || capitalUsd < 10 || capitalUsd > 1_000_000)
          return json(res, 400, { error: 'capitalUsd must be between 10 and 1000000' })
        if (!['fees', 'rewards'].includes(mode)) return json(res, 400, { error: 'invalid recommendation mode' })
        if (!['conservative', 'balanced', 'aggressive'].includes(risk)) return json(res, 400, { error: 'invalid recommendation risk' })
        json(res, 200, await recommendations({ capitalUsd, mode, risk, limit }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/wallets/import') {
        if (!requireAdmin(auth, res)) return
        if (!allowPrivateKeyImport(req)) return json(res, 429, { error: 'wallet import rate limit exceeded' })
        const body = await readJson(req)
        const walletId = typeof body.walletId === 'string' && body.walletId ? body.walletId : randomUUID()
        if (walletById(walletId)) return json(res, 409, { error: 'wallet id already exists' })
        if (typeof body.privateKey !== 'string') return json(res, 400, { error: 'privateKey is required' })
        const label = accountLabel(body.label)
        const address = privateKeyAddress(body.privateKey)
        if (body.expectedAddress !== undefined) {
          if (typeof body.expectedAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.expectedAddress))
            return json(res, 400, { error: 'expectedAddress is invalid' })
          if (address.toLowerCase() !== body.expectedAddress.toLowerCase())
            return json(res, 400, { error: 'private key does not match the connected wallet' })
        }
        if (walletByAddress(address)) return json(res, 409, { error: 'an account for this wallet already exists' })
        const imported = importPrivateKey(walletId, body.privateKey)
        const now = Math.floor(Date.now() / 1000)
        addWallet({ id: walletId, label, address: imported.address, vaultPath: imported.path, createdAt: now, updatedAt: now })
        audit('api', 'wallet_imported', 'wallet', walletId, { label, address: imported.address })
        json(res, 201, { wallet: { id: walletId, label, address: imported.address, createdAt: now, updatedAt: now } })
        return
      }
      if (req.method === 'PATCH' && /^\/v1\/wallets\/[^/]+$/.test(url.pathname)) {
        if (!requireAdmin(auth, res)) return
        const walletId = decodeURIComponent(url.pathname.slice('/v1/wallets/'.length))
        if (!walletById(walletId)) return json(res, 404, { error: 'account not found' })
        const body = await readJson(req)
        const label = accountLabel(body.label)
        updateWalletLabel(walletId, label)
        audit('api', 'wallet_label_updated', 'wallet', walletId, { label })
        json(res, 200, { wallet: listWallets().find((wallet) => wallet.id === walletId) })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/strategies') {
        const strategies = listStrategies().filter((row) => ownedBy(auth, row.config.owner))
        const archivedStrategyIds = listArchivedStrategies()
          .filter((row) => ownedBy(auth, row.config.owner))
          .map((row) => row.config.id)
        json(res, 200, {
          strategies: strategies.map((row) => ({ ...row, latestJob: latestJobSummary(row.config.id) })),
          archivedStrategyIds,
        })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/performance') {
        const strategies = await Promise.all(listStrategies().filter((row) => ownedBy(auth, row.config.owner)).map(async (row) => {
          try {
            return await cachedStrategyPerformance(row.config, row.state)
          } catch (error) {
            return { strategyId: row.config.id, state: row.state, error: error instanceof Error ? error.message.slice(0, 160) : 'performance unavailable' }
          }
        }))
        json(res, 200, { strategies })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/history') {
        const strategies = await Promise.all(listArchivedStrategies().filter((row) => ownedBy(auth, row.config.owner)).map(async (row) => {
          try {
            return { config: row.config, archivedAt: row.archivedAt, assetLocation: row.assetLocation,
              performance: row.performance ?? await archivedAccountingPerformance(row.config, row.archivedAt) }
          } catch (error) {
            return { config: row.config, archivedAt: row.archivedAt, assetLocation: row.assetLocation,
              performance: { strategyId: row.config.id, state: 'archived', error: error instanceof Error ? error.message.slice(0, 160) : 'history unavailable' } }
          }
        }))
        json(res, 200, { strategies })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/pnl-calendar') {
        const from = url.searchParams.get('from'), to = url.searchParams.get('to')
        const fromDay = from && /^\d+$/.test(from) ? Number(from) : undefined
        const toDay = to && /^\d+$/.test(to) ? Number(to) : undefined
        await captureDailyPerformance()
        const ownedStrategyIds = new Set([
          ...listStrategies().filter((row) => ownedBy(auth, row.config.owner)).map((row) => row.config.id),
          ...listArchivedStrategies().filter((row) => ownedBy(auth, row.config.owner)).map((row) => row.config.id),
        ])
        json(res, 200, { timezone: 'Asia/Shanghai', rows: calendarRows(fromDay, toDay).filter((row) => ownedStrategyIds.has(row.strategyId)) })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/recovery') {
        const ownedStrategyIds = new Set(listStrategies().filter((row) => ownedBy(auth, row.config.owner)).map((row) => row.config.id))
        const jobs = jobsForRecovery().filter((job) => ownedStrategyIds.has(job.strategy_id)).map((job) => ({
          id: job.id,
          strategyId: job.strategy_id,
          state: job.state,
          createdAt: job.created_at,
          updatedAt: job.updated_at,
          recoveryAttempts: job.recovery_attempts,
          recoveryErrorStreak: job.recovery_error_streak,
          recoveryLastError: job.recovery_last_error ?? undefined,
          recoveryNextAt: job.recovery_next_at ?? undefined,
          recoveryQuarantinedAt: job.recovery_quarantined_at ?? undefined,
          plan: JSON.parse(job.plan_json),
          steps: jobSteps(job.id),
          transactions: jobTransactions(job.id),
        }))
        json(res, 200, { jobs })
        return
      }
      if (req.method === 'POST' && /^\/v1\/jobs\/[^/]+\/recover$/.test(url.pathname)) {
        if (!requireAdmin(auth, res)) return
        const id = decodeURIComponent(url.pathname.slice('/v1/jobs/'.length, -'/recover'.length))
        const inspection = await inspectRecovery(id, { reconcile: true })
        audit('api', 'recovery_inspected', 'job', id, { disposition: inspection.disposition })
        json(res, 200, { recovery: inspection })
        return
      }
      if (req.method === 'POST' && /^\/v1\/jobs\/[^/]+\/resume$/.test(url.pathname)) {
        if (!requireAdmin(auth, res)) return
        const id = decodeURIComponent(url.pathname.slice('/v1/jobs/'.length, -'/resume'.length))
        reactivateRecoveryJob(id)
        try {
          const result = await executeRecovery(id)
          clearRecoverySchedule(id)
          json(res, 200, { recovery: result })
        } catch (error) {
          const code = error instanceof Error ? error.message.slice(0, 120) : 'E_RECOVERY'
          const retry = scheduleRecoveryRetry(id, code, !isTransientRecoveryFailure(error))
          audit('api', retry.quarantined ? 'manual_recovery_quarantined' : 'manual_recovery_failed', 'job', id, {
            code, attempts: retry.attempts, streak: retry.streak, delayMs: retry.delayMs,
          })
          throw error
        }
        return
      }
      if (req.method === 'POST' && /^\/v1\/strategies\/[^/]+\/plan$/.test(url.pathname)) {
        if (!requireAdmin(auth, res)) return
        const id = decodeURIComponent(url.pathname.slice('/v1/strategies/'.length, -'/plan'.length))
        const row = strategyById(id)
        if (!row) return json(res, 404, { error: 'strategy not found' })
        if (['planned', 'executing', 'recovery', 'recovery_quarantined'].includes(row.state)) return json(res, 409, { error: 'strategy has an open execution job' })
        const preflight = await preflightStrategy(row.config)
        json(res, 200, { plan: preflight.plan, preflight })
        return
      }
      if (req.method === 'POST' && /^\/v1\/strategies\/[^/]+\/execute$/.test(url.pathname)) {
        if (!requireAdmin(auth, res)) return
        const id = decodeURIComponent(url.pathname.slice('/v1/strategies/'.length, -'/execute'.length))
        const row = strategyById(id)
        if (!row) return json(res, 404, { error: 'strategy not found' })
        if (!row.config.enabled || row.config.execution.mode !== 'executor_auto') return json(res, 400, { error: 'strategy is not enabled for executor automation' })
        if (!['monitoring', 'dry_run_ready', 'awaiting_manual'].includes(row.state)) return json(res, 409, { error: 'strategy is not ready to execute' })
        const preflight = await preflightStrategy(row.config)
        const plan = preflight.plan
        if (!createPlannedJob(plan)) return json(res, 409, { error: 'strategy already has an open job' })
        setStrategyState(id, 'planned')
        audit('api', 'manual_job_created', 'strategy', id, { planId: plan.id, dryRun: row.config.execution.dryRun })
        json(res, 201, { job: { id: plan.id, dryRun: row.config.execution.dryRun } })
        return
      }
      if (req.method === 'POST' && /^\/v1\/strategies\/[^/]+\/resume-monitoring$/.test(url.pathname)) {
        if (!requireAdmin(auth, res)) return
        const id = decodeURIComponent(url.pathname.slice('/v1/strategies/'.length, -'/resume-monitoring'.length))
        const row = strategyById(id)
        if (!row) return json(res, 404, { error: 'strategy not found' })
        if (row.state !== 'paused_guard') return json(res, 409, { error: 'strategy is not safety-paused' })
        if (!row.config.enabled || row.config.execution.mode !== 'executor_auto' || row.config.execution.dryRun)
          return json(res, 400, { error: 'strategy is not enabled for live automation' })
        const preflight = await preflightStrategy(row.config)
        setStrategyState(id, 'monitoring')
        audit('api', 'strategy_monitoring_resumed', 'strategy', id, { blockNumber: preflight.blockNumber, observedSide: preflight.position.observedSide })
        json(res, 200, { state: 'monitoring', preflight })
        return
      }
      if (req.method === 'POST' && /^\/v1\/strategies\/[^/]+\/withdraw-profit$/.test(url.pathname)) {
        if (!requireAdmin(auth, res)) return
        const id = decodeURIComponent(url.pathname.slice('/v1/strategies/'.length, -'/withdraw-profit'.length))
        const row = strategyById(id)
        if (!row) return json(res, 404, { error: 'strategy not found' })
        const body = await readJson(req)
        if (body.target !== 'USDG' && body.target !== 'WETH' && body.target !== 'ETH') return json(res, 400, { error: 'target must be USDG, WETH, or ETH' })
        json(res, 200, { withdrawal: await withdrawRetainedProfit(id, body.target) })
        return
      }
      if (req.method === 'DELETE' && /^\/v1\/strategies\/[^/]+$/.test(url.pathname)) {
        if (!requireAdmin(auth, res)) return
        const id = decodeURIComponent(url.pathname.slice('/v1/strategies/'.length))
        const result = await stopAndArchiveStrategy(id)
        json(res, 200, result)
        return
      }
      if (req.method === 'POST' && /^\/v1\/simple\/strategies\/[^/]+\/start$/.test(url.pathname)) {
        if (!requireAdmin(auth, res)) return
        const id = decodeURIComponent(url.pathname.slice('/v1/simple/strategies/'.length, -'/start'.length))
        const body = await readJson(req)
        if (typeof body.walletId !== 'string' || !body.walletId) return json(res, 400, { error: 'walletId is required' })
        if (!body.config || typeof body.config !== 'object') return json(res, 400, { error: 'config is required' })
        const config = body.config as Record<string, unknown>
        if (config.id !== id) return json(res, 400, { error: 'strategy id mismatch' })
        const result = await startSimpleStrategy(config, body.walletId)
        json(res, 201, result)
        return
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/v1/strategies/')) {
        if (!requireAdmin(auth, res)) return
        const id = decodeURIComponent(url.pathname.slice('/v1/strategies/'.length))
        const body = await readJson(req)
        const config = parseStrategyConfig(body)
        if (config.id !== id) return json(res, 400, { error: 'strategy id mismatch' })
        const current = listStrategies().find((row) => row.config.id === id)
        if (current && ['planned', 'executing', 'recovery', 'recovery_quarantined'].includes(current.state)) return json(res, 409, { error: 'strategy has an open execution job' })
        if (current && config.revision !== current.config.revision + 1) return json(res, 409, { error: 'strategy revision conflict' })
        if (config.execution.walletId) {
          const wallet = walletById(config.execution.walletId)
          if (!wallet) return json(res, 400, { error: 'unknown wallet id' })
          if (wallet.address.toLowerCase() !== config.owner.toLowerCase() || wallet.address.toLowerCase() !== config.execution.signerAddress?.toLowerCase())
            return json(res, 400, { error: 'wallet, signer and owner mismatch' })
        }
        if (config.enabled && config.execution.mode === 'executor_auto') {
          const unlocked = unlockPrivateKey(config.execution.walletId!)
          if (unlocked.address.toLowerCase() !== config.owner.toLowerCase()) return json(res, 400, { error: 'vault signer and owner mismatch' })
          await readStrategySnapshot(config)
          const [gasPrice, nativeBalance] = await Promise.all([
            publicClient.getGasPrice(),
            publicClient.getBalance({ address: config.owner }),
          ])
          const reserve = (gasPrice * 5_000_000n * BigInt(Math.ceil(config.execution.gasReserveMultiplier * 100))) / 100n
          if (nativeBalance < reserve) return json(res, 400, { error: 'insufficient native gas reserve' })
          if (!config.execution.dryRun && !config.execution.maxDailyTurnoverQuote)
            return json(res, 400, { error: 'live automation requires maxDailyTurnoverQuote' })
        }
        const enableCompounding = current?.config.fees.handling !== 'reinvest' && config.fees.handling === 'reinvest'
        // Saving a disabled draft is not the start of performance tracking.
        // Capture the immutable mark only when a live strategy first enters
        // executor automation (the simple-start path does the same).
        const baseline = !current && config.enabled && config.execution.mode === 'executor_auto' && config.activeTokenId
          ? await observeStrategyBaseline(config)
          : undefined
        upsertStrategy(config)
        if (baseline) setStrategyBaselineIfAbsent(baseline)
        if (enableCompounding) compoundHeldAllocations(config.id)
        audit('api', 'strategy_upserted', 'strategy', config.id, { revision: config.revision, mode: config.execution.mode })
        json(res, 200, { strategy: { id: config.id, revision: config.revision } })
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (error) {
      // Never include request body or an exception object: either can contain a private key.
      const message = error instanceof Error ? error.message : 'request rejected'
      const expected = /^E_/.test(message) || /too large|JSON|require|mismatch|unknown|must|invalid|unsupported/.test(message)
      json(res, expected ? 400 : 500, { error: message.slice(0, 180) })
    }
  })
  server.listen(EXECUTOR.port, EXECUTOR.host, () => console.log(`[executor] listening on ${EXECUTOR.host}:${EXECUTOR.port}`))
  return server
}
