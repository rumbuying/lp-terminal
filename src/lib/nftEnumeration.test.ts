import assert from "node:assert/strict";
import test from "node:test";
import { enumerateOwnedNftIds } from "./nftEnumeration";

test("enumerates every owned NFT in bounded sequential batches", async () => {
  const batches: bigint[][] = [];
  let active = 0;
  let maxActive = 0;
  const ids = await enumerateOwnedNftIds(205n, async (indices) => {
    active++;
    maxActive = Math.max(maxActive, active);
    batches.push([...indices]);
    await Promise.resolve();
    active--;
    return indices.map((index) => 10_000n + index);
  });

  assert.equal(ids.length, 205);
  assert.equal(ids[0], 10_000n);
  assert.equal(ids.at(-1), 10_204n);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 5],
  );
  assert.equal(maxActive, 1);
});

test("fails instead of returning a partial NFT enumeration", async () => {
  await assert.rejects(
    enumerateOwnedNftIds(101n, async (indices) =>
      indices.map((index) => (index === 100n ? undefined : index)),
    ),
    /failed at owner index 100/,
  );
});
