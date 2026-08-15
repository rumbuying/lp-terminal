/**
 * A tiny single-flight scheduler. Calls made while a task is running are
 * coalesced into exactly one follow-up pass; their promises resolve with that
 * follow-up rather than the stale pass that was already in flight.
 */
export class CoalescingScheduler<T> {
  private running = false;
  private currentWaiters: Array<{
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }> = [];
  private nextWaiters: Array<{
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }> = [];
  private nextTriggers = new Set<string>();

  constructor(private readonly task: (trigger: string) => Promise<T>) {}

  get busy(): boolean {
    return this.running;
  }

  request(trigger: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (this.running) {
        this.nextWaiters.push(waiter);
        this.nextTriggers.add(trigger);
        return;
      }

      this.running = true;
      this.currentWaiters.push(waiter);
      void this.pump(trigger);
    });
  }

  private async pump(initialTrigger: string): Promise<void> {
    let trigger = initialTrigger;
    for (;;) {
      try {
        const result = await this.task(trigger);
        for (const waiter of this.currentWaiters) waiter.resolve(result);
      } catch (error) {
        for (const waiter of this.currentWaiters) waiter.reject(error);
      }

      if (!this.nextWaiters.length) {
        this.currentWaiters = [];
        this.running = false;
        return;
      }

      this.currentWaiters = this.nextWaiters;
      this.nextWaiters = [];
      trigger = [...this.nextTriggers].sort().join(',');
      this.nextTriggers.clear();
    }
  }
}
