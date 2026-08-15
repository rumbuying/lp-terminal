import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'lp-terminal-indexer-'));
process.env.INDEXER_DB = join(dir, 'test.db');

const { clPoolStateCount, db, insertPool, missingClMetaTokenCount, upsertState } = await import('./store');
const { pc } = await import('./rpc');
const { ensureClTokenMetaPage, ensureTokenMetaPage, sweepAllState, sweepClStatePage, sweepState, sweepStatePage } =
  await import('./state');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('partial pool reads preserve the last-good state', async () => {
  const v2 = '0x0000000000000000000000000000000000000001';
  const v3 = '0x0000000000000000000000000000000000000002';
  const complete = '0x0000000000000000000000000000000000000003';
  const v3Token0 = '0x0000000000000000000000000000000000000020';
  const v3Token1 = '0x0000000000000000000000000000000000000021';
  insertPool({
    address: v2,
    proto: 'univ2',
    token0: '0x0000000000000000000000000000000000000010',
    token1: '0x0000000000000000000000000000000000000011',
    feePpm: 3_000,
  });
  insertPool({
    address: v3,
    proto: 'univ3',
    token0: v3Token0,
    token1: v3Token1,
    feePpm: 500,
    tickSpacing: 10,
  });
  insertPool({
    address: complete,
    proto: 'univ2',
    token0: '0x0000000000000000000000000000000000000030',
    token1: '0x0000000000000000000000000000000000000031',
    feePpm: 3_000,
  });
  upsertState(v2, { reserve0: 11n, reserve1: 12n, totalSupply: 13n });
  upsertState(v3, {
    sqrtPrice: 14n,
    tick: 15,
    liquidity: 16n,
    reserve0: 17n,
    reserve1: 18n,
  });
  upsertState(complete, { reserve0: 31n, reserve1: 32n, totalSupply: 33n });

  const read = (address: string) =>
    db
      .prepare(
        'SELECT sqrt_price, tick, liquidity, reserve0, reserve1, total_supply, updated FROM pool_state WHERE address = ?',
      )
      .get(address);
  const v2Before = read(v2);
  const v3Before = read(v3);

  const original = pc.multicall;
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
      contracts.map((call) => {
        if (call.address === v2 && call.functionName === 'getReserves')
          return { status: 'success', result: [21n, 22n, 0] };
        if (call.address === v2 && call.functionName === 'totalSupply') return { status: 'failure' };
        if (call.address === v3 && call.functionName === 'slot0') return { status: 'success', result: [24n, 25] };
        if (call.address === v3 && call.functionName === 'liquidity') return { status: 'success', result: 26n };
        if (call.address === v3Token0) return { status: 'success', result: 27n };
        if (call.address === v3Token1) return { status: 'failure' };
        if (call.address === complete && call.functionName === 'getReserves')
          return { status: 'success', result: [41n, 42n, 0] };
        if (call.address === complete && call.functionName === 'totalSupply') return { status: 'success', result: 43n };
        throw new Error(`unexpected call: ${call.address} ${call.functionName}`);
      }),
  });
  try {
    assert.equal(await sweepState([v2, v3, complete]), 1);
    assert.deepEqual(read(v2), v2Before);
    assert.deepEqual(read(v3), v3Before);
    const { updated: _updated, ...completeAfter } = read(complete) as Record<string, unknown>;
    assert.deepEqual(completeAfter, {
      sqrt_price: null,
      tick: null,
      liquidity: null,
      reserve0: '41',
      reserve1: '42',
      total_supply: '43',
    });
  } finally {
    Object.defineProperty(pc, 'multicall', {
      configurable: true,
      value: original,
    });
  }
});

test('full-catalog sweep crosses the address-keyset page boundary', async () => {
  const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
  const count = 1_002;
  for (let i = 0; i < count; i++) {
    insertPool({
      address: A(0x1_000 + i),
      proto: 'univ2',
      token0: A(0x10_000),
      token1: A(0x10_001),
      feePpm: 3_000,
    });
  }

  const original = pc.multicall;
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((call) => {
        if (call.functionName === 'getReserves') return { status: 'success', result: [1n, 2n, 0] };
        if (call.functionName === 'totalSupply') return { status: 'success', result: 3n };
        if (call.functionName === 'slot0') return { status: 'success', result: [4n, 0] };
        if (call.functionName === 'liquidity') return { status: 'success', result: 5n };
        if (call.functionName === 'balanceOf') return { status: 'success', result: 6n };
        throw new Error(`unexpected call: ${call.functionName}`);
      }),
  });
  try {
    const result = await sweepAllState();
    assert.deepEqual(result, { done: count + 3, total: count + 3 });
  } finally {
    Object.defineProperty(pc, 'multicall', {
      configurable: true,
      value: original,
    });
  }
});

test('Pancake v2 uses reserve calls while Pancake v3 uses concentrated-liquidity calls', async () => {
  const pancakeV2 = '0xf100000000000000000000000000000000000001';
  const pancakeV3 = '0xf100000000000000000000000000000000000002';
  const token0 = '0xf200000000000000000000000000000000000001';
  const token1 = '0xf200000000000000000000000000000000000002';
  insertPool({
    address: pancakeV2,
    proto: 'pancakev2',
    token0,
    token1,
    feePpm: 2_500,
  });
  insertPool({
    address: pancakeV3,
    proto: 'pancakev3',
    token0,
    token1,
    feePpm: 500,
    tickSpacing: 10,
  });

  const seen: Array<{ address: string; functionName: string }> = [];
  const original = pc.multicall;
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: Array<{ address: string; functionName: string }> }) =>
      contracts.map((call) => {
        seen.push(call);
        if (call.functionName === 'getReserves') return { status: 'success', result: [101n, 102n, 0] };
        if (call.functionName === 'totalSupply') return { status: 'success', result: 103n };
        if (call.functionName === 'slot0') return { status: 'success', result: [201n, 202] };
        if (call.functionName === 'liquidity') return { status: 'success', result: 203n };
        if (call.functionName === 'balanceOf') return { status: 'success', result: 204n };
        throw new Error(`unexpected call: ${call.functionName}`);
      }),
  });
  try {
    assert.equal(await sweepState([pancakeV2, pancakeV3]), 2);
    assert.deepEqual(
      seen.filter((call) => call.address === pancakeV2).map((call) => call.functionName),
      ['getReserves', 'totalSupply'],
    );
    assert.deepEqual(
      seen.filter((call) => call.address === pancakeV3).map((call) => call.functionName),
      ['slot0', 'liquidity'],
    );
    assert.deepEqual(
      {
        ...db
          .prepare(
            'SELECT sqrt_price, tick, liquidity, reserve0, reserve1, total_supply FROM pool_state WHERE address = ?',
          )
          .get(pancakeV2),
      },
      {
        sqrt_price: null,
        tick: null,
        liquidity: null,
        reserve0: '101',
        reserve1: '102',
        total_supply: '103',
      },
    );
    assert.deepEqual(
      {
        ...db
          .prepare(
            'SELECT sqrt_price, tick, liquidity, reserve0, reserve1, total_supply FROM pool_state WHERE address = ?',
          )
          .get(pancakeV3),
      },
      {
        sqrt_price: '201',
        tick: 202,
        liquidity: '203',
        reserve0: '204',
        reserve1: '204',
        total_supply: null,
      },
    );
  } finally {
    Object.defineProperty(pc, 'multicall', {
      configurable: true,
      value: original,
    });
  }
});

test('bounded state census page returns a durable address cursor', async () => {
  const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
  const addresses = [1, 2, 3].map((n) => `0xff${n.toString(16).padStart(38, '0')}`);
  for (const address of addresses)
    insertPool({
      address,
      proto: 'pancakev2',
      token0: A(0x77_001),
      token1: A(0x77_002),
      feePpm: 2_500,
    });

  const original = pc.multicall;
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((call) =>
        call.functionName === 'getReserves'
          ? { status: 'success', result: [1n, 2n, 0] }
          : { status: 'success', result: 3n },
      ),
  });
  try {
    const first = await sweepStatePage('0xfeffffffffffffffffffffffffffffffffffffff', 2);
    assert.deepEqual(first, {
      done: 2,
      total: 2,
      nextCursor: addresses[1],
      complete: false,
      addresses: addresses.slice(0, 2),
    });
    const second = await sweepStatePage(first.nextCursor, 2);
    assert.deepEqual(second, {
      done: 1,
      total: 1,
      nextCursor: '',
      complete: true,
      addresses: addresses.slice(2),
    });
  } finally {
    Object.defineProperty(pc, 'multicall', {
      configurable: true,
      value: original,
    });
  }
});

test('bounded metadata census page resumes from its durable token cursor', async () => {
  const pool = '0xfd00000000000000000000000000000000000001';
  const tokens = ['0xfd10000000000000000000000000000000000001', '0xfd10000000000000000000000000000000000002'];
  insertPool({
    address: pool,
    proto: 'pancakev2',
    token0: tokens[0],
    token1: tokens[1],
    feePpm: 2_500,
  });

  const original = pc.multicall;
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((call) =>
        call.functionName === 'symbol' ? { status: 'success', result: 'CAKE' } : { status: 'success', result: 18 },
      ),
  });
  try {
    const first = await ensureTokenMetaPage('0xfcffffffffffffffffffffffffffffffffffffff', 1);
    assert.deepEqual(first, {
      done: 1,
      total: 1,
      nextCursor: tokens[0],
      complete: false,
    });
    const second = await ensureTokenMetaPage(first.nextCursor, 1);
    assert.deepEqual(second, {
      done: 1,
      total: 1,
      nextCursor: tokens[1],
      complete: false,
    });
    assert.deepEqual(await ensureTokenMetaPage(second.nextCursor, 1), {
      done: 0,
      total: 0,
      nextCursor: '',
      complete: true,
    });
  } finally {
    Object.defineProperty(pc, 'multicall', {
      configurable: true,
      value: original,
    });
  }
});

test('CL census pages traverse Uni and Pancake V3 without touching V2', async () => {
  const renderableBefore = clPoolStateCount();
  const uniV3 = '0xfe00000000000000000000000000000000000001';
  const v2Between = '0xfe00000000000000000000000000000000000002';
  const pancakeV3 = '0xfe00000000000000000000000000000000000003';
  const tokens = [
    '0xfe10000000000000000000000000000000000001',
    '0xfe10000000000000000000000000000000000002',
    '0xfe10000000000000000000000000000000000003',
  ];
  insertPool({
    address: uniV3,
    proto: 'univ3',
    token0: tokens[0],
    token1: tokens[1],
    feePpm: 500,
    tickSpacing: 10,
  });
  insertPool({
    address: v2Between,
    proto: 'pancakev2',
    token0: '0xfe20000000000000000000000000000000000001',
    token1: '0xfe20000000000000000000000000000000000002',
    feePpm: 2_500,
  });
  insertPool({
    address: pancakeV3,
    proto: 'pancakev3',
    token0: tokens[1],
    token1: tokens[2],
    feePpm: 2_500,
    tickSpacing: 50,
  });

  const original = pc.multicall;
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((call) => {
        if (call.functionName === 'symbol') return { status: 'success', result: 'CL' };
        if (call.functionName === 'decimals') return { status: 'success', result: 18 };
        if (call.functionName === 'slot0') return { status: 'success', result: [101n, 2] };
        if (call.functionName === 'liquidity') return { status: 'success', result: 102n };
        if (call.functionName === 'balanceOf') return { status: 'success', result: 103n };
        throw new Error(`unexpected call: ${call.functionName}`);
      }),
  });
  try {
    const metaFirst = await ensureClTokenMetaPage('0xfe0fffffffffffffffffffffffffffffffffffff', 2);
    assert.deepEqual(metaFirst, {
      done: 2,
      total: 2,
      nextCursor: tokens[1],
      complete: false,
    });
    assert.deepEqual(await ensureClTokenMetaPage(metaFirst.nextCursor, 2), {
      done: 1,
      total: 1,
      nextCursor: '',
      complete: true,
    });

    const stateFirst = await sweepClStatePage('0xfdffffffffffffffffffffffffffffffffffffff', 2);
    assert.deepEqual(stateFirst, {
      done: 2,
      total: 2,
      nextCursor: pancakeV3,
      complete: false,
      addresses: [uniV3, pancakeV3],
    });
    assert.deepEqual(await sweepClStatePage(stateFirst.nextCursor, 2), {
      done: 0,
      total: 0,
      nextCursor: '',
      complete: true,
      addresses: [],
    });
    assert.equal(clPoolStateCount(), renderableBefore + 2);
  } finally {
    Object.defineProperty(pc, 'multicall', {
      configurable: true,
      value: original,
    });
  }
});

test('a failed first balance read does not hide an otherwise readable CL pool', async () => {
  const pool = '0xfc00000000000000000000000000000000000001';
  const token0 = '0xfc10000000000000000000000000000000000001';
  const token1 = '0xfc10000000000000000000000000000000000002';
  insertPool({
    address: pool,
    proto: 'pancakev3',
    token0,
    token1,
    feePpm: 500,
    tickSpacing: 10,
  });

  const original = pc.multicall;
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
      contracts.map((call) => {
        if (call.functionName === 'slot0') return { status: 'success', result: [7n, 8] };
        if (call.functionName === 'liquidity') return { status: 'success', result: 9n };
        if (call.functionName === 'balanceOf' && call.address === token0) return { status: 'success', result: 10n };
        if (call.functionName === 'balanceOf' && call.address === token1) return { status: 'failure' };
        throw new Error(`unexpected call: ${call.address} ${call.functionName}`);
      }),
  });
  try {
    assert.equal(await sweepState([pool]), 1);
    assert.deepEqual(
      {
        ...db
          .prepare('SELECT sqrt_price, tick, liquidity, reserve0, reserve1 FROM pool_state WHERE address = ?')
          .get(pool),
      },
      {
        sqrt_price: '7',
        tick: 8,
        liquidity: '9',
        reserve0: '10',
        reserve1: '0',
      },
    );
  } finally {
    Object.defineProperty(pc, 'multicall', {
      configurable: true,
      value: original,
    });
  }
});

test('failed CL token decimals remain pending without becoming a global readiness gate', async () => {
  const pool = '0xffff000000000000000000000000000000000001';
  const token0 = '0xffff100000000000000000000000000000000001';
  const token1 = '0xffff100000000000000000000000000000000002';
  const missingBefore = missingClMetaTokenCount();
  insertPool({
    address: pool,
    proto: 'pancakev3',
    token0,
    token1,
    feePpm: 500,
    tickSpacing: 10,
  });
  assert.equal(missingClMetaTokenCount(), missingBefore + 2);

  const original = pc.multicall;
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
      contracts.map((call) => {
        if (call.functionName === 'symbol') return { status: 'success', result: 'SAFE' };
        if (call.functionName === 'decimals' && call.address === token0) return { status: 'success', result: 18 };
        if (call.functionName === 'decimals' && call.address === token1) return { status: 'failure' };
        throw new Error(`unexpected call: ${call.address} ${call.functionName}`);
      }),
  });
  try {
    assert.deepEqual(await ensureClTokenMetaPage('0xffff0fffffffffffffffffffffffffffffffffff', 10), {
      done: 1,
      total: 2,
      nextCursor: '',
      complete: true,
    });
    assert.equal(missingClMetaTokenCount(), missingBefore + 1);
    assert.deepEqual(
      {
        ...db.prepare('SELECT decimals, meta_ok FROM tokens WHERE address = ?').get(token1),
      },
      { decimals: 18, meta_ok: 0 },
    );
  } finally {
    Object.defineProperty(pc, 'multicall', {
      configurable: true,
      value: original,
    });
  }
});

test('CL state pages isolate slot0 failures while advancing the bounded traversal', async () => {
  const pools = ['0xfffd000000000000000000000000000000000001', '0xfffd000000000000000000000000000000000002'];
  const token0 = '0xfffd100000000000000000000000000000000001';
  const token1 = '0xfffd100000000000000000000000000000000002';
  for (const address of pools)
    insertPool({
      address,
      proto: 'pancakev3',
      token0,
      token1,
      feePpm: 500,
      tickSpacing: 10,
    });

  const original = pc.multicall;
  Object.defineProperty(pc, 'multicall', {
    configurable: true,
    value: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
      contracts.map((call) => {
        if (call.functionName === 'slot0' && call.address === pools[1]) return { status: 'failure' };
        if (call.functionName === 'slot0') return { status: 'success', result: [11n, 12] };
        if (call.functionName === 'liquidity') return { status: 'success', result: 13n };
        if (call.functionName === 'balanceOf') return { status: 'success', result: 14n };
        throw new Error(`unexpected call: ${call.address} ${call.functionName}`);
      }),
  });
  try {
    const page = await sweepClStatePage('0xfffcffffffffffffffffffffffffffffffffffff', 2);
    assert.deepEqual(page, {
      done: 1,
      total: 2,
      nextCursor: pools[1],
      complete: false,
      addresses: pools,
    });
    assert.equal(page.done, 1);
  } finally {
    Object.defineProperty(pc, 'multicall', {
      configurable: true,
      value: original,
    });
  }
});
