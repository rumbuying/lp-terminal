export const OWNED_NFT_ENUMERATION_BATCH_SIZE = 100;

/**
 * Enumerate every ERC-721 Enumerable token owned at the preceding balanceOf
 * snapshot. Calls stay bounded to one small batch at a time; any missing index
 * fails the refresh instead of publishing a silently truncated position list.
 */
export async function enumerateOwnedNftIds(
  count: bigint,
  readBatch: (
    indices: readonly bigint[],
  ) => Promise<readonly (bigint | undefined)[]>,
  batchSize = OWNED_NFT_ENUMERATION_BATCH_SIZE,
): Promise<bigint[]> {
  if (count < 0n) throw new Error("NFT balance cannot be negative");
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
    throw new Error("NFT enumeration batch size must be a positive integer");

  const ids: bigint[] = [];
  const batch = BigInt(batchSize);
  for (let start = 0n; start < count; start += batch) {
    const remaining = count - start;
    const length = Number(remaining < batch ? remaining : batch);
    const indices = Array.from({ length }, (_, offset) => start + BigInt(offset));
    const rows = await readBatch(indices);
    if (rows.length !== indices.length)
      throw new Error(
        `NFT enumeration returned ${rows.length}/${indices.length} rows at index ${start}`,
      );
    rows.forEach((id, offset) => {
      if (id === undefined)
        throw new Error(
          `NFT enumeration failed at owner index ${indices[offset]}`,
        );
      ids.push(id);
    });
  }
  return ids;
}
