import assert from 'node:assert/strict'
import test from 'node:test'
import {
  shouldAutoRefreshUniPoolCatalog,
  shouldInvalidateAfterTransaction,
  shouldUseInitialPoolCatalogFallback,
  HEADER_BLOCK_QUERY_POLICY,
  PUBLIC_POOL_QUERY_POLICY,
  UNI_POOL_CATALOG_QUERY_META,
  UNI_POOL_CATALOG_QUERY_POLICY,
  V4_INDEXER_WARMING_MAX_RETRIES,
  V4_INDEXER_WARMING_RETRY_DELAY_MS,
  V4_POOL_CATALOG_QUERY_META,
  V4_POOL_CATALOG_QUERY_POLICY,
} from '../config/query'

test('v4 catalog refreshes stale data on focus without transaction invalidation', () => {
  assert.equal(V4_POOL_CATALOG_QUERY_POLICY.refetchOnWindowFocus, true)
  assert.equal(V4_POOL_CATALOG_QUERY_POLICY.refetchOnReconnect, true)
  assert.equal(V4_POOL_CATALOG_QUERY_POLICY.refetchInterval, false)
  assert.equal(V4_POOL_CATALOG_QUERY_POLICY.staleTime, 5 * 60_000)
  assert.equal(V4_POOL_CATALOG_QUERY_POLICY.gcTime, 30 * 60_000)
  assert.equal(V4_INDEXER_WARMING_RETRY_DELAY_MS, 30_000)
  assert.equal(V4_INDEXER_WARMING_MAX_RETRIES, 60)
  assert.equal(shouldInvalidateAfterTransaction(V4_POOL_CATALOG_QUERY_META), false)
  assert.equal(shouldInvalidateAfterTransaction({}), true)
  assert.equal(shouldInvalidateAfterTransaction(undefined), true)
})

test('public pool catalogs are stale-on-focus snapshots without an idle timer', () => {
  assert.equal(PUBLIC_POOL_QUERY_POLICY.staleTime, 5 * 60_000)
  assert.equal(PUBLIC_POOL_QUERY_POLICY.gcTime, 30 * 60_000)
  assert.equal(PUBLIC_POOL_QUERY_POLICY.refetchInterval, false)
  assert.equal(PUBLIC_POOL_QUERY_POLICY.refetchOnWindowFocus, true)
  assert.equal(PUBLIC_POOL_QUERY_POLICY.refetchOnReconnect, true)
  assert.equal(PUBLIC_POOL_QUERY_POLICY.retry, false)
  assert.equal(UNI_POOL_CATALOG_QUERY_POLICY, PUBLIC_POOL_QUERY_POLICY)
  assert.equal(shouldInvalidateAfterTransaction(UNI_POOL_CATALOG_QUERY_META), false)
  assert.equal(shouldAutoRefreshUniPoolCatalog(undefined), true)
  assert.equal(shouldAutoRefreshUniPoolCatalog({ pages: [{}] }), true)
  assert.equal(shouldAutoRefreshUniPoolCatalog({ pages: [{}, {}] }), false)
})

test('header block query is lightweight and never polls', () => {
  assert.equal(HEADER_BLOCK_QUERY_POLICY.staleTime, 60_000)
  assert.equal(HEADER_BLOCK_QUERY_POLICY.refetchInterval, false)
  assert.equal(HEADER_BLOCK_QUERY_POLICY.retry, false)
})

test('browser catalog fallback is allowed only on a true first load', () => {
  assert.equal(shouldUseInitialPoolCatalogFallback(undefined, null), true)
  assert.equal(shouldUseInitialPoolCatalogFallback({ pages: [{}] }, null), false)
  assert.equal(shouldUseInitialPoolCatalogFallback(undefined, { after: '0x1' }), false)
})
