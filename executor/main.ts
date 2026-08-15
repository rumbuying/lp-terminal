import { startApi } from './api'
import { EXECUTOR } from './config'
import { monitorOnce } from './monitor'
import { runOnce } from './runner'
import { addWallet, audit, quarantineInterruptedJobs, walletByAddress, walletById } from './store'
import { configuredFileSigner } from './vault'
import { superviseOnce } from './supervisor'
import { captureDailyPerformance } from './calendar'

const fileSigner = configuredFileSigner()
if (fileSigner) {
  const byId = walletById(fileSigner.walletId)
  const byAddress = walletByAddress(fileSigner.address)
  if (byId && byId.address.toLowerCase() !== fileSigner.address.toLowerCase())
    throw new Error('configured private-key wallet id belongs to a different address')
  if (byAddress && byAddress.id !== fileSigner.walletId)
    throw new Error(`configured private key address already belongs to wallet ${byAddress.id}`)
  if (!byId) {
    const now = Math.floor(Date.now() / 1000)
    addWallet({ id: fileSigner.walletId, label: 'Server signer', address: fileSigner.address, vaultPath: `private-key-file:${fileSigner.path}`, createdAt: now, updatedAt: now })
    audit('startup', 'private_key_file_wallet_registered', 'wallet', fileSigner.walletId, { address: fileSigner.address })
  }
}

const interrupted = quarantineInterruptedJobs()
if (interrupted) audit('startup', 'interrupted_jobs_quarantined', 'executor', undefined, { count: interrupted })
const server = startApi()
const stop = () => server.close(() => process.exit(0))
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
console.log(`[executor] RPC configured: ${new URL(EXECUTOR.rpcUrl).host} (${EXECUTOR.rpcSource}); signer: ${fileSigner ? 'private-key-file' : EXECUTOR.masterSecret ? 'encrypted-vault' : 'locked'}`)
void monitorOnce()
void runOnce()
void superviseOnce()
void captureDailyPerformance()
setInterval(() => void captureDailyPerformance(), 5 * 60_000)
setInterval(() => {
  void superviseOnce()
  void monitorOnce()
  void runOnce()
}, EXECUTOR.pollMs)
