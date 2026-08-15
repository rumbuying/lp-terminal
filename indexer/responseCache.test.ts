import assert from 'node:assert/strict';
import test from 'node:test';
import { SerializedResponseCache } from './responseCache';

test('serialized response cache is bounded, LRU ordered and keeps a finite stale fallback', () => {
  const cache = new SerializedResponseCache(2, 100, 500);
  cache.set('a', 'A', 'etag-a', 1_000);
  cache.set('b', 'B', 'etag-b', 1_000);

  assert.equal(cache.get('a', 1_050)?.freshness, 'fresh');
  cache.set('c', 'C', 'etag-c', 1_050);
  assert.equal(cache.get('b', 1_050), null, 'least-recently-used entry is evicted');
  assert.equal(cache.get('a', 1_150)?.freshness, 'stale');
  assert.equal(cache.get('a', 1_500), null, 'stale fallback expires at its hard deadline');
  assert.deepEqual(cache.stats(), {
    entries: 1,
    maxEntries: 2,
    hits: 1,
    misses: 2,
    staleHits: 1,
    evictions: 1,
  });
});
