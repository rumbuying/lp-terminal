import { workerData } from 'node:worker_threads'
import { register } from 'tsx/esm/api'

const entry = workerData?.entry
if (typeof entry !== 'string' || !entry.startsWith('file:')) {
  throw new Error('tsx worker requires a file URL entry')
}

register()
await import(entry)
