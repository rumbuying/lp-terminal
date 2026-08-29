import { zeroAddress, type Address } from 'viem';
import { clFactoryAbi, clPoolAbi, voterAbi } from '../src/abi';
import { ADDR, CHAIN, log } from './config';
import { mc, ok, pc } from './rpc';
import { insertPool, poolRow, updateUp33PoolStatic } from './store';

const indexes = (length: number) => Array.from({ length }, (_, index) => index);

/**
 * Enumerate the small official UP33 Slipstream registry for recommendation
 * analytics. These rows intentionally retain protocol `up33cl`; the public
 * `/api/pools` protocol allowlist does not expose them as Uniswap/Pancake rows.
 */
export async function syncUp33Cl(): Promise<string[]> {
  if (!CHAIN.gov) return [];
  const rawLength = await pc.readContract({
    address: ADDR.CL_FACTORY,
    abi: clFactoryAbi,
    functionName: 'allPoolsLength',
  });
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 0)
    throw new Error('UP33 factory pool count exceeds the safe catalog range');
  // Enumerate the authoritative registry in full. In particular, never turn an
  // RPC budget into a silent tail cut: newly-created pools are exactly the rows
  // most likely to contain a newly popular Robinhood token.
  const addresses = (await mc(indexes(length).map((index) => ({
    abi: clFactoryAbi,
    address: ADDR.CL_FACTORY,
    functionName: 'allPools',
    args: [BigInt(index)],
  }))))
    .map((result) => ok<Address>(result))
    .filter((address): address is Address => Boolean(address && address !== zeroAddress));

  const details = await mc(addresses.flatMap((address) => [
    { abi: clPoolAbi, address, functionName: 'fee' },
    { abi: clPoolAbi, address, functionName: 'unstakedFee' },
    { abi: clPoolAbi, address, functionName: 'tickSpacing' },
    { abi: clPoolAbi, address, functionName: 'token0' },
    { abi: clPoolAbi, address, functionName: 'token1' },
    { abi: voterAbi, address: CHAIN.gov!.VOTER, functionName: 'gauges', args: [address] },
  ]));
  const fresh: string[] = [];
  addresses.forEach((address, index) => {
    const base = index * 6;
    const feePpm = ok<number>(details[base]);
    const unstakedFeePpm = ok<number>(details[base + 1]);
    const tickSpacing = ok<number>(details[base + 2]);
    const token0 = ok<Address>(details[base + 3]);
    const token1 = ok<Address>(details[base + 4]);
    const rawGauge = ok<Address>(details[base + 5]);
    if (
      feePpm === undefined || unstakedFeePpm === undefined ||
      tickSpacing === undefined || !token0 || !token1
    ) return;
    const gauge = rawGauge && rawGauge !== zeroAddress ? rawGauge : undefined;
    const known = Boolean(poolRow(address));
    insertPool({
      address,
      proto: 'up33cl',
      token0,
      token1,
      feePpm,
      unstakedFeePpm,
      tickSpacing,
      gauge,
      pairIndex: index,
    });
    updateUp33PoolStatic(address, feePpm, unstakedFeePpm, tickSpacing, gauge);
    if (!known) fresh.push(address.toLowerCase());
  });
  if (fresh.length) log(`[catalog] UP33 CL recommendation catalog: +${fresh.length} pools`);
  return fresh;
}
