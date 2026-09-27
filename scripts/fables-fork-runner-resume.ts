/** Resume a disposable Fables executor job on the same loopback Anvil fork. */
import { createPublicClient, http } from 'viem'
import { FABLES_AUTO_POOL_IDS } from '../src/config/fables'

const rpc = process.env.FABLES_FORK_RPC
const directory = process.env.FABLES_TEST_DATA_DIR
if (!rpc || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(rpc) || !directory)
  throw new Error('set FABLES_FORK_RPC to loopback Anvil and FABLES_TEST_DATA_DIR to its test database')
const fork = createPublicClient({ transport: http(rpc) })

async function run() {
  if (!await fork.request({ method: 'anvil_nodeInfo', params: [] } as never) || await fork.getChainId() !== 4663)
    throw new Error('not a Robinhood Anvil fork')
  process.env.LP_EXECUTOR_DATA_DIR = directory
  process.env.LP_EXECUTOR_RPC = rpc
  process.env.LP_EXECUTOR_CHAIN_ID = '4663'
  process.env.LP_EXECUTOR_PRIVATE_KEY_FILE = `${directory}/signer.key`
  process.env.LP_EXECUTOR_PRIVATE_KEY_WALLET_ID = 'fables-fork-signer'
  process.env.LP_EXECUTOR_CONFIRMATIONS = '1'
  FABLES_AUTO_POOL_IDS.add('0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551')
  const [jobs, runner, store] = await Promise.all([
    import('../executor/fablesJobs'), import('../executor/fablesRunner'), import('../executor/fablesStore'),
  ])
  let previous = ''
  let unchanged = 0
  for (let i = 0; i < 30; i += 1) {
    await runner.runFablesOnce()
    const job = jobs.activeFablesJobs()[0]
    if (!job) {
      const rows = jobs.recentFablesJobs()
      const last = rows[0]
      if (last?.state === 'completed') {
        process.stdout.write(JSON.stringify({ state: last.state, stage: last.stage,
          oldRangeId: last.config.positionRef.rangeId,
          newRangeId: store.fablesStrategyById(last.strategyId)!.config.positionRef.rangeId,
          transactions: jobs.fablesJobTransactions(last.id).map(tx => ({ stage: tx.stage, hash: tx.hash, state: tx.state })),
          db: directory }) + '\n')
        return
      }
      throw new Error(`no active job; last=${last?.state}:${last?.errorCode}`)
    }
    const state = `${job.state}:${job.stage}:${jobs.fablesJobTransactions(job.id).length}:${job.errorCode ?? ''}`
    if (state !== previous) { process.stdout.write(`${state}\n`); unchanged = 0 }
    else unchanged += 1
    previous = state
    if (unchanged >= 3) break
  }
  const job = jobs.activeFablesJobs()[0]
  throw new Error(`Fables fork job did not complete: ${job?.stage} ${job?.errorCode}; db=${directory}`)
}

run().catch(error => { console.error(error); process.exitCode = 1 })
