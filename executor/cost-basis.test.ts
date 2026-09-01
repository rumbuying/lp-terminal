import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { toEventSelector, zeroAddress, type Address } from 'viem'
import type { StrategyConfig, StrategyPositionSnapshot } from '../shared/strategy/types'

const PM = '0x58daec3116aae6d93017baaea7749052e8a04fa7' as Address
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address
const TOKEN = '0x0000000000000000000000000000000000000002' as Address
const OWNER = '0x0000000000000000000000000000000000000003' as Address
const POOL_ID = `0x${'11'.repeat(32)}`
const Q96 = 1n << 96n
const TRANSFER = toEventSelector('Transfer(address,address,uint256)')

const word = (value: string | bigint) => BigInt(value).toString(16).padStart(64, '0')
const erc20TransferLog = (token: Address, from: Address, to: Address, value: bigint) => ({
  address: token.toLowerCase(),
  topics: [TRANSFER, `0x${word(from)}`, `0x${word(to)}`],
  data: `0x${word(value)}`,
})

const config = {
  protocol: 'univ4',
  chainId: 4663,
  owner: OWNER,
  positionManager: PM,
  pool: POOL_MANAGER,
  poolId: POOL_ID,
  riskToken: TOKEN,
  quoteToken: zeroAddress,
} as unknown as StrategyConfig

const snapshot = {
  protocol: 'univ4',
  token0: zeroAddress,
  token1: TOKEN,
  token0Decimals: 18,
  token1Decimals: 18,
  tick: 0,
  sqrtPriceX96: Q96.toString(),
} as unknown as StrategyPositionSnapshot

mock.module('./chain', {
  namedExports: {
    publicClient: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'ownerOf') return OWNER
        if (functionName === 'getSlot0') return [Q96, 0, 0, 0]
        throw new Error(`unexpected readContract ${functionName}`)
      },
      getLogs: async () => [{ transactionHash: '0xabc' }],
      getTransactionReceipt: async () => ({
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n,
        logs: [erc20TransferLog(TOKEN, OWNER, PM, 500_000n)],
      }),
      getBlock: async () => ({ timestamp: 1_234_567_890 }),
      getTransaction: async () => ({ value: 1_000_000n }),
    },
  },
})

const { reconstructOriginalMintCostBasis } = await import('./cost-basis')

test('v4 original-mint cost basis derives native from tx value and ERC-20 from the wallet delta', async () => {
  const basis = await reconstructOriginalMintCostBasis(config, snapshot, '7', '1000')

  assert.equal(basis.kind, 'original_mint')
  assert.equal(basis.tokenId, '7')
  assert.equal(basis.amount0, '1000000') // native side = the mint tx's own value
  assert.equal(basis.amount1, '500000') // ERC-20 side = the owner's receipt outflow
  assert.equal(basis.sqrtPriceX96, Q96.toString())
  assert.equal(basis.tick, 0)
  // native is the quote token (1:1) and TOKEN converts 1:1 at sqrtPrice = 2^96
  assert.equal(basis.valueQuoteRaw, '1500000')
  assert.equal(basis.openingGasQuoteRaw, (21_000n * 1_000_000_000n).toString())
  assert.equal(basis.blockNumber, '0')
  assert.equal(basis.observedAt, 1_234_567_890)
})
