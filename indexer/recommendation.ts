import { v4StateViewAbi } from '../src/lib/uniV4';
import { TUNE, V4 } from './config';
import { computeTvlFor, sweepState } from './state';
import { mc, ok, pc } from './rpc';
import {
  captureAddressTickSamples,
  pruneRecommendationHistory,
  recommendationAddressPoolAddrs,
  recommendationV4Targets,
  tx,
  upsertV4RecommendationState,
} from './store';

/** Refresh the bounded market cohort used by the executor's recommendation
 * model. V4 stays PoolId-keyed all the way through StateView. */
export async function refreshRecommendationSamples(): Promise<{
  addressPools: number;
  v4Pools: number;
}> {
  const addresses = recommendationAddressPoolAddrs(TUNE.analyticsN);
  if (addresses.length) {
    await sweepState(addresses);
    computeTvlFor(addresses);
  }

  const deployment = V4;
  const v4Targets = deployment ? recommendationV4Targets(TUNE.analyticsN) : [];
  const v4Results = deployment ? await mc(v4Targets.flatMap((target) => [
    { abi: v4StateViewAbi, address: deployment.STATE_VIEW, functionName: 'getSlot0', args: [target.pool_id] },
    { abi: v4StateViewAbi, address: deployment.STATE_VIEW, functionName: 'getLiquidity', args: [target.pool_id] },
  ])) : [];
  const blockNumber = String(await pc.getBlockNumber());
  const timestamp = Math.floor(Date.now() / 1_000);
  captureAddressTickSamples(addresses, blockNumber, timestamp);
  let v4Pools = 0;
  tx(() => {
    v4Targets.forEach((target, index) => {
      const slot0 = ok<readonly [bigint, number, number, number]>(v4Results[index * 2]);
      const liquidity = ok<bigint>(v4Results[index * 2 + 1]);
      if (!slot0 || liquidity === undefined || slot0[0] === 0n) return;
      const lpFee = Number(slot0[3] || target.key_fee_ppm || 0);
      if (!Number.isSafeInteger(lpFee) || lpFee <= 0) return;
      upsertV4RecommendationState(target.pool_id, {
        sqrtPrice: slot0[0], tick: Number(slot0[1]), liquidity, lpFee,
      }, blockNumber, timestamp);
      v4Pools++;
    });
  });
  pruneRecommendationHistory(timestamp);
  return { addressPools: addresses.length, v4Pools };
}
