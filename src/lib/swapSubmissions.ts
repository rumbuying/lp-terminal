import type { Address } from 'viem'

const active = new Set<string>()
const subscribers = new Set<() => void>()

export function swapSubmissionKey(
  account: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): string {
  return `${account.toLowerCase()}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}:${amountIn}`
}

function notify() {
  for (const subscriber of subscribers) {
    try {
      subscriber()
    } catch {
      // A render observer must never release the submission lock early.
    }
  }
}

export const swapSubmissions = {
  has(key: string): boolean {
    return active.has(key)
  },

  async run(key: string, task: () => Promise<unknown>): Promise<boolean> {
    if (active.has(key)) return false
    active.add(key)
    notify()
    try {
      await task()
      return true
    } finally {
      active.delete(key)
      notify()
    }
  },

  subscribe(subscriber: () => void): () => void {
    subscribers.add(subscriber)
    return () => subscribers.delete(subscriber)
  },
}
