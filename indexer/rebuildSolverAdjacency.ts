// Explicit offline migration for legacy catalogs. Run with the same CHAIN and
// INDEXER_DB as the stopped indexer process:
//   CHAIN=bsc INDEXER_DB=/data/index.bsc-56.db npx tsx indexer/rebuildSolverAdjacency.ts
//
// Do not import config/store until both selectors are explicit. Their normal
// defaults are useful for development, but are unsafe for a one-shot migration
// because a typo in deployment wiring could otherwise create and bless a new
// empty database.
const requestedChain = process.env.CHAIN?.trim();
const requestedDb = process.env.INDEXER_DB?.trim();
if (!requestedChain || !requestedDb)
  throw new Error('adjacency rebuild requires explicit CHAIN and INDEXER_DB');

const store = await import('./store');
const { CHAIN, DB_PATH } = await import('./config');

try {
  const alreadyReady = store.solverAdjacencyProjectionReady();
  if (!alreadyReady) store.rebuildSolverAdjacencyProjection();
  if (!store.solverAdjacencyProjectionReady())
    throw new Error('solver adjacency projection did not publish its readiness marker');
  process.stdout.write(
    `solver adjacency projection ${alreadyReady ? 'already ready' : 'ready'} ` +
      `chain=${CHAIN.key}:${CHAIN.id} ` +
      `db=${DB_PATH} v23Pools=${store.poolCount()} v4Pools=${store.v4PoolCount()}\n`,
  );
} finally {
  store.db.close();
}
