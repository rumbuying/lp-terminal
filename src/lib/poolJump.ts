// One-shot handoff from the POOL RANK tab to the POOLS tab: queue a pool
// address, switch tabs, and POOLS consumes it on mount to seed its search and
// point the trade panel at that pool. Same lifecycle as
// lib/recommendationPrefill, minus the strategy payload — the ranking knows
// which pool is worth funding, not what range to run.

let pendingJump: string | null = null;

export function queuePoolJump(address: string): void {
  pendingJump = address.toLowerCase();
}

export function takePoolJump(): string | null {
  const value = pendingJump;
  pendingJump = null;
  return value;
}
