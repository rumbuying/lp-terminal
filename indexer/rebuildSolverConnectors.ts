// Build the ranked connector projection explicitly, outside the reprice worker
// that normally keeps it current. Run with the same CHAIN and INDEXER_DB as the
// stopped indexer process:
//   CHAIN=bsc INDEXER_DB=/data/index.bsc-56.db npx tsx indexer/rebuildSolverConnectors.ts
//
// The rebuild holds the write lock for its whole duration, so a serving indexer
// left running can see its own writes fail on the busy timeout. SQLite keeps the
// database consistent either way; what is at risk is the indexer's progress, not
// its data.
//
// To size the scan against real data without touching a serving database at all,
// copy index.db together with its -wal and -shm sidecars and point INDEXER_DB at
// the copy.
//
// Set PROBE_A and PROBE_B to two token addresses to print the candidates the
// fresh projection offers for that pair — the cheapest way to confirm a build
// recovers the connectors it should.
//
// Do not import config/store until both selectors are explicit. Their normal
// defaults are useful for development, but are unsafe for a one-shot rebuild
// because a typo in deployment wiring could otherwise create and bless a new
// empty database.
const requestedChain = process.env.CHAIN?.trim();
const requestedDb = process.env.INDEXER_DB?.trim();
if (!requestedChain || !requestedDb)
  throw new Error('connector rebuild requires explicit CHAIN and INDEXER_DB');

const store = await import('./store');
const { CHAIN, DB_PATH } = await import('./config');

const HEX40 = /^0x[0-9a-f]{40}$/;
const probeA = process.env.PROBE_A?.trim().toLowerCase();
const probeB = process.env.PROBE_B?.trim().toLowerCase();
if ((probeA === undefined) !== (probeB === undefined))
  throw new Error('a connector probe needs both PROBE_A and PROBE_B');
if (probeA !== undefined && (!HEX40.test(probeA) || !HEX40.test(probeB as string)))
  throw new Error('connector probe tokens must be canonical lowercase addresses');

try {
  const started = Date.now();
  const meta = store.rebuildSolverConnectorRank();
  process.stdout.write(
    `solver connector ranking published ` +
      `chain=${CHAIN.key}:${CHAIN.id} db=${DB_PATH} ` +
      `edges=${meta.rows} tokens=${meta.tokens} perToken=${meta.k} ` +
      `v23Seq=${meta.v23Seq} ms=${Date.now() - started}\n`,
  );

  if (probeA !== undefined && probeB !== undefined) {
    const allProtocols = Object.values(store.SOLVER_PROTO_BIT).reduce(
      (mask, bit) => mask | (1 << bit),
      0,
    );
    const sideA = store.solverConnectorSide(probeA);
    const sideB = store.solverConnectorSide(probeB);
    process.stdout.write(
      `probe ${probeA} ranked=${sideA.ranked} truncated=${sideA.truncated} ` +
        `floorUsd=${sideA.floorUsd ?? 'none'}\n` +
        `probe ${probeB} ranked=${sideB.ranked} truncated=${sideB.truncated} ` +
        `floorUsd=${sideB.floorUsd ?? 'none'}\n`,
    );
    const candidates = store.solverConnectorCandidates(probeA, probeB, allProtocols, 24);
    if (candidates.length === 0) process.stdout.write('probe candidates: none\n');
    for (const [index, candidate] of candidates.entries())
      process.stdout.write(
        `  ${String(index + 1).padStart(2)} ${candidate.token} ` +
          `bottleneck=${Math.round(candidate.bottleneckUsd)} ` +
          `a=${Math.round(candidate.aTvlUsd)} b=${Math.round(candidate.bTvlUsd)}` +
          `${candidate.approx ? ' approx' : ''}\n`,
      );
  }
} finally {
  store.db.close();
}
