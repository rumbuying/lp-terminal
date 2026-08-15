import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

test('all main-thread full reprices use the single-flight worker scheduler', () => {
  assert.match(source, /const fullRepriceScheduler = new CoalescingScheduler\(runFullReprice\)/);

  for (const trigger of ['boot', 'active', 'census', 'periodic', 'stats'])
    assert.match(source, new RegExp(`requestFullReprice\\('${trigger}'\\)`));

  const directCalls = source.match(/\breprice\s*\(\s*\)/g) ?? [];
  assert.equal(directCalls.length, 1);
  assert.match(
    source,
    /async function workerEntry\(\): Promise<void> \{[\s\S]*?const result = reprice\(\)/,
  );
});

test('the connector ranking rebuilds only off the serving thread, and only when asked', () => {
  // A multi-second scan plus a write transaction on the main thread would stop
  // the indexer answering, so the single call site must stay inside the worker.
  const rebuildCalls = source.match(/\brebuildSolverConnectorRank\s*\(\s*\)/g) ?? [];
  assert.equal(rebuildCalls.length, 1);
  assert.match(
    source,
    /function rebuildConnectorRankInWorker\(\)[\s\S]*?rebuildSolverConnectorRank\(\)/,
  );
  assert.match(
    source,
    /async function workerEntry\(\): Promise<void> \{[\s\S]*?rebuildConnectorRankInWorker\(\)/,
  );

  // Opt-in: an indexer that was never asked for the projection pays nothing.
  assert.match(
    source,
    /const CONNECTOR_RANK_ENABLED = process\.env\.INDEXER_CONNECTOR_RANK === '1'/,
  );
  assert.match(
    source,
    /function rebuildConnectorRankInWorker\(\)[^{]*\{\s*if \(!CONNECTOR_RANK_ENABLED\) return null;/,
  );
});

test('a failed connector ranking never discards the prices the reprice committed', () => {
  // The rebuild runs after reprice() has already written tvl_usd. Rethrowing
  // would turn a stale pre-filter into a lost repricing pass.
  const body = source.match(
    /function rebuildConnectorRankInWorker\(\)[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(body);
  assert.match(body, /catch \(error\) \{\s*return \{ ok: false, error: safeError\(error\) \};/);
  assert.doesNotMatch(body, /\bthrow\b/);
});
