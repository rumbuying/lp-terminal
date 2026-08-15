export type SerializedResponse = {
  body: string;
  etag: string;
  createdAt: number;
  freshUntil: number;
  staleUntil: number;
};

export type CachedResponse = {
  response: SerializedResponse;
  freshness: 'fresh' | 'stale';
};

/**
 * Tiny process-local LRU for already-serialized public responses.
 *
 * The indexer is intentionally single-process. This removes repeated SQLite
 * and JSON work for common keys without introducing Redis or cross-process
 * consistency. Expired last-good entries remain available for bounded origin
 * failure fallback, but are never returned as fresh.
 */
export class SerializedResponseCache {
  readonly maxEntries: number;
  readonly freshMs: number;
  readonly staleMs: number;
  readonly #entries = new Map<string, SerializedResponse>();
  #hits = 0;
  #misses = 0;
  #staleHits = 0;
  #evictions = 0;

  constructor(maxEntries: number, freshMs: number, staleMs: number) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    this.freshMs = Math.max(1, Math.floor(freshMs));
    this.staleMs = Math.max(this.freshMs, Math.floor(staleMs));
  }

  get(key: string, at = Date.now()): CachedResponse | null {
    const response = this.#entries.get(key);
    if (!response) {
      this.#misses++;
      return null;
    }
    if (at >= response.staleUntil) {
      this.#entries.delete(key);
      this.#misses++;
      return null;
    }
    // Map insertion order is the LRU order. Refresh it on every usable hit.
    this.#entries.delete(key);
    this.#entries.set(key, response);
    if (at < response.freshUntil) {
      this.#hits++;
      return { response, freshness: 'fresh' };
    }
    this.#staleHits++;
    return { response, freshness: 'stale' };
  }

  set(key: string, body: string, etag: string, at = Date.now()): SerializedResponse {
    const response = {
      body,
      etag,
      createdAt: at,
      freshUntil: at + this.freshMs,
      staleUntil: at + this.staleMs,
    };
    this.#entries.delete(key);
    this.#entries.set(key, response);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
      this.#evictions++;
    }
    return response;
  }

  clear(): void {
    this.#entries.clear();
    this.#hits = 0;
    this.#misses = 0;
    this.#staleHits = 0;
    this.#evictions = 0;
  }

  stats(): {
    entries: number;
    maxEntries: number;
    hits: number;
    misses: number;
    staleHits: number;
    evictions: number;
  } {
    return {
      entries: this.#entries.size,
      maxEntries: this.maxEntries,
      hits: this.#hits,
      misses: this.#misses,
      staleHits: this.#staleHits,
      evictions: this.#evictions,
    };
  }
}
