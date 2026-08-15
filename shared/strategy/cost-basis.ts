/** Binary-search the first block for a state that remains true through upperBlock. */
export async function firstExistingBlock(
  upperBlock: bigint,
  existsAt: (blockNumber: bigint) => Promise<boolean>,
): Promise<bigint> {
  if (!(await existsAt(upperBlock))) throw new Error('position did not exist at the accounting snapshot')
  let lower = 0n
  let upper = upperBlock
  while (lower < upper) {
    const middle = (lower + upper) / 2n
    if (await existsAt(middle)) upper = middle
    else lower = middle + 1n
  }
  return lower
}
