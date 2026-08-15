const tails = new Map<string, Promise<void>>()

export function walletBusy(walletId: string): boolean {
  return tails.has(walletId)
}

/** Serialize every signer operation for a wallet inside this executor process. */
export async function withWalletLock<T>(walletId: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(walletId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => current)
  tails.set(walletId, tail)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (tails.get(walletId) === tail) tails.delete(walletId)
  }
}
