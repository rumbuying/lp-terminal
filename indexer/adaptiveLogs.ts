export type LogWindow<T> = {
  fromBlock: number
  toBlock: number
  rows: T
}

export type AdaptiveLogScanOptions<T> = {
  fromBlock: number
  toBlock: number
  maxWindowBlocks: number
  /** Maximum in-flight windows after one serial capability probe succeeds. */
  concurrency?: number
  fetchWindow: (fromBlock: number, toBlock: number) => Promise<T>
  commitWindow: (window: LogWindow<T>) => void | Promise<void>
  onShrink?: (windowBlocks: number) => void
  singleBlockError: string
}

const LOG_RANGE_ERROR = /limit|block range|range limit|too many|response size|query returned/i

export function isLogRangeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return LOG_RANGE_ERROR.test(message)
}

/**
 * Traverse an inclusive block range without gaps. A provider-specific range
 * rejection halves the window and retries the same starting block. The caller
 * commits each successful window (rows + durable cursor) atomically, so a
 * later transient error resumes after the last commit rather than at genesis.
 */
export async function scanAdaptiveLogWindows<T>(options: AdaptiveLogScanOptions<T>): Promise<void> {
  if (options.fromBlock > options.toBlock) return
  let windowBlocks = Math.max(1, Math.floor(options.maxWindowBlocks))
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))
  let lo = options.fromBlock
  let probed = false
  while (lo <= options.toBlock) {
    // Probe one window serially first. This discovers a provider's range cap
    // without firing a whole batch of requests we already know it will reject.
    const batchSize = probed ? concurrency : 1
    const windows: Array<{ fromBlock: number; toBlock: number }> = []
    for (let i = 0; i < batchSize && lo + i * windowBlocks <= options.toBlock; i++) {
      const fromBlock = lo + i * windowBlocks
      windows.push({
        fromBlock,
        toBlock: Math.min(fromBlock + windowBlocks - 1, options.toBlock),
      })
    }

    const settled = await Promise.allSettled(
      windows.map(async (window) => ({
        ...window,
        rows: await options.fetchWindow(window.fromBlock, window.toBlock),
      })),
    )
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (rejected) {
      if (!isLogRangeError(rejected.reason)) throw rejected.reason
      if (windowBlocks === 1) throw new Error(options.singleBlockError)
      windowBlocks = Math.max(1, Math.floor(windowBlocks / 2))
      probed = false
      options.onShrink?.(windowBlocks)
      continue
    }

    // Promise completion order is irrelevant: cursor commits remain strictly
    // ascending, so interruption always resumes from a contiguous prefix.
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue
      await options.commitWindow(result.value)
      lo = result.value.toBlock + 1
    }
    probed = true
  }
}
