// UP33 LP-terminal pool indexer — catalog (factory events/enumeration) +
// on-chain state sweeps + GT enrichment, served over a tiny read-only API.
// Run: `npm run indexer` (tsx). Data lives in indexer/data/index.db (SQLite).
//
// Boot: backfill → token meta → full state sweep → GT cycle → reprice → ready.
// Loops: logtail 12s (reread only pools that emitted events) · frontpage 15s
//        (on-screen top-N by TVL, gated on API demand) · tail 30min · hot 10min
//        · active 4h · census 24h · GT stats 5min (off the RPC queue).
// The API starts listening immediately; `ready:false` in responses tells the
// frontend to keep using its client-side fallback until the first pass lands.
import { log, now, PORT, sleep, TUNE } from './config'
import { safeError, usingPrivateRpc } from './rpc'
import { backfillV3, syncV2, tailV3 } from './catalog'
import { computeTvlFor, ensureTokenMeta, reprice, sweepState } from './state'
import { statsCycle } from './stats'
import { logtail } from './logtail'
import { activeAddrs, allPoolAddrs, analyticsAddrs, captureTickSamples, db, frontpageAddrs, hotAddrs, kvGet, kvSet, poolCounts, poolsHitAgeMs, protocolPoolAddrs, pruneAnalytics } from './store'
import { startApi } from './api'
import { syncUp33Cl } from './up33'
import { pc } from './rpc'

let refreshQueue = Promise.resolve()

function enqueueRefresh(fn: () => Promise<void>): Promise<void> {
  const run = refreshQueue.then(fn, fn)
  refreshQueue = run
  return run
}

/**
 * setTimeout-chained loop. `queued` (default) routes the tick through the shared
 * RPC queue so state sweeps neither overlap nor get dropped. Stats runs
 * off-queue: it hits GeckoTerminal over HTTP (not the RPC) with ~30 calls paced
 * ≥2.6s apart, so enqueuing it would pin the queue for over a minute and starve
 * the 15s frontpage sweep. It touches the DB only in synchronous transactions,
 * which JS's single thread already serializes against the sweeps' writes.
 */
function loop(name: string, ms: number, fn: () => Promise<void>, queued = true): void {
  const tick = async () => {
    try {
      await (queued ? enqueueRefresh(fn) : fn())
    } catch (e) {
      log(`[${name}] error:`, safeError(e))
    }
    setTimeout(tick, ms)
  }
  setTimeout(tick, ms)
}

const timed = async <T,>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = Date.now()
  const r = await fn()
  return [r, Date.now() - t0]
}

async function initialRefresh(): Promise<void> {
  const warmRestart = kvGet('ready') === '1'
  const [addedV3, msV3] = await timed(backfillV3)
  if (addedV3 > 0 || !kvGet('v3_boot_logged')) {
    log(`[catalog] univ3 backfill done: +${addedV3} pools (${(msV3 / 1000).toFixed(0)}s)`)
    kvSet('v3_boot_logged', '1')
  }
  const [freshV2, msV2] = await timed(syncV2)
  if (freshV2.length) log(`[catalog] univ2 sync: +${freshV2.length} pairs (${(msV2 / 1000).toFixed(0)}s)`)
  const freshUp33 = await syncUp33Cl()
  log('[catalog]', poolCounts().map((c) => `${c.proto}=${c.n}`).join(' '))

  const [metaN, msMeta] = await timed(ensureTokenMeta)
  if (metaN) log(`[tokens] metadata fetched for ${metaN} tokens (${(msMeta / 1000).toFixed(0)}s)`)

  // A populated production database already has last-good state for the full
  // catalog. Re-reading 400k+ pools after every process restart delays the API
  // for many minutes and adds no safety; refresh every UP33 CL pool plus the
  // bounded front-page/recommendation set. Long-tail active pools keep their
  // regular scheduled sweep after boot.
  // A genuinely cold database still performs the one required full census.
  const sweepTargets = warmRestart
    ? [...new Set([
        ...protocolPoolAddrs('up33cl'),
        ...frontpageAddrs(TUNE.frontpageN),
        ...analyticsAddrs(TUNE.analyticsN),
        ...freshUp33,
      ])]
    : allPoolAddrs()
  const [swept, msSweep] = await timed(() => sweepState(sweepTargets))
  log(`[sweep] ${warmRestart ? 'warm' : 'full'} ${swept}/${sweepTargets.length} pools (${(msSweep / 1000).toFixed(0)}s)`)
  if (sweepTargets.length && !swept) throw new Error('initial state sweep updated no pools')

  await statsCycle().catch((e) => log('[stats] initial cycle failed:', safeError(e)))
  if (warmRestart) {
    computeTvlFor(sweepTargets)
    log(`[price] warm TVL refreshed for ${sweepTargets.length} pools`)
  } else {
    const pr = reprice()
    log(`[price] ${pr.priced} tokens priced · tvl on ${pr.tvlPools} pools`)
  }

  kvSet('ready', '1')
  kvSet('snapshot_asof', String(now()))
  kvSet('boot_error', '')
  log(`READY — http://localhost:${PORT}/api/health`)
}

function startLoops(): void {
  // primary freshness: reread pools the instant a trade touches them.
  loop('logtail', TUNE.logtailMs, logtail)
  // keep the pools users are looking at fresh even absent a trade, but only
  // while they're looking (demand gate) so an idle site spends no RPC.
  loop('frontpage', TUNE.frontpageMs, async () => {
    if (poolsHitAgeMs() > TUNE.frontpageGateMs) return
    const top = frontpageAddrs(TUNE.frontpageN)
    if (!top.length) return
    await sweepState(top)
    computeTvlFor(top)
  })
  loop('tail', TUNE.tailMs, async () => {
    const fresh = [...(await tailV3()), ...(await syncV2()), ...(await syncUp33Cl())]
    if (fresh.length) {
      log(`[tail] ${fresh.length} new pools`)
      await ensureTokenMeta()
      await sweepState(fresh)
      computeTvlFor(fresh)
    }
  })
  loop('hot', TUNE.hotSweepMs, async () => {
    const hot = hotAddrs()
    await sweepState(hot)
    computeTvlFor(hot)
  })
  loop('analytics', TUNE.analyticsMs, async () => {
    const addrs = analyticsAddrs(TUNE.analyticsN)
    if (!addrs.length) return
    await sweepState(addrs)
    computeTvlFor(addrs)
    captureTickSamples(addrs, String(await pc.getBlockNumber()))
    pruneAnalytics()
  })
  loop('active', TUNE.fullSweepMs, async () => {
    const addrs = activeAddrs()
    const [swept, ms] = await timed(() => sweepState(addrs))
    computeTvlFor(addrs)
    log(`[sweep] active ${swept}/${addrs.length} pools (${(ms / 1000).toFixed(0)}s)`)
  })
  loop('census', TUNE.censusMs, async () => {
    const addrs = allPoolAddrs()
    const [swept, ms] = await timed(() => sweepState(addrs))
    computeTvlFor(addrs)
    log(`[sweep] census ${swept}/${addrs.length} pools (${(ms / 1000).toFixed(0)}s)`)
    if (addrs.length && !swept) throw new Error('census state sweep updated no pools')
    kvSet('snapshot_asof', String(now()))
  })
  loop(
    'stats',
    TUNE.statsMs,
    async () => {
      await statsCycle()
      computeTvlFor([...new Set([
        ...protocolPoolAddrs('up33cl'),
        ...frontpageAddrs(TUNE.frontpageN),
        ...analyticsAddrs(TUNE.analyticsN),
      ])])
    },
    false, // off the RPC queue — paced GT HTTP must not block the frontpage sweep
  )
}

async function boot(): Promise<void> {
  log('up33 lp-indexer starting —', usingPrivateRpc ? 'rpc: private (.env)' : 'rpc: public')
  startApi()
  startLoops()

  for (;;) {
    try {
      await enqueueRefresh(initialRefresh)
      return
    } catch (e) {
      const error = safeError(e)
      kvSet('boot_error', error)
      const retryMs = 60_000 // fixed short retry — independent of the (slow) hot cadence
      log(`[boot] error; retrying in ${retryMs / 1_000}s:`, error)
      await sleep(retryMs)
    }
  }
}

process.on('SIGINT', () => {
  log('shutting down')
  db.close()
  process.exit(0)
})
process.on('SIGTERM', () => {
  db.close()
  process.exit(0)
})

boot().catch((e) => {
  log('FATAL boot:', safeError(e))
  process.exit(1)
})
