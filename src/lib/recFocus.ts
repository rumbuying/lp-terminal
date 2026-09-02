// One-shot handoff from the POOL RANK tab to the RECOMMENDATIONS tab: queue a
// pool address, switch tabs, and the recommender consumes it once its cards
// have loaded to scroll to and flash the matching card. Same lifecycle as
// lib/poolJump — the ranking knows which pool deserves a closer look; the
// recommender owns the projection the user should land on.

let pendingFocus: string | null = null;

export function queueRecFocus(address: string): void {
  pendingFocus = address.toLowerCase();
}

export function takeRecFocus(): string | null {
  const value = pendingFocus;
  pendingFocus = null;
  return value;
}
