import assert from 'node:assert/strict'
import test from 'node:test'
import { toEventSelector, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { receiptV4TokenFlows } from './receipts'

const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
const OWNER = '0x00000000000000000000000000000000000000a1' as Address
const TOKEN = '0x00000000000000000000000000000000000000b1' as Address
const TOKEN2 = '0x00000000000000000000000000000000000000c1' as Address
const PM = '0x00000000000000000000000000000000000000d1' as Address
const STRANGER = '0x00000000000000000000000000000000000000ff' as Address

const word = (value: string | bigint) => BigInt(value).toString(16).padStart(64, '0')
const transferLog = (token: Address, from: Address, to: Address, value: bigint) => ({
  address: token.toLowerCase(),
  topics: [TRANSFER, `0x${word(from)}`, `0x${word(to)}`],
  data: `0x${word(value)}`,
})
const receipt = (logs: unknown[]): TransactionReceipt =>
  ({ logs, status: 'success', gasUsed: 0n, effectiveGasPrice: 0n, transactionHash: '0xabc' }) as unknown as TransactionReceipt

test('an ERC-20 v4 exit reads the owner inflow exactly', () => {
  const flows = receiptV4TokenFlows(receipt([transferLog(TOKEN, PM, OWNER, 500n)]), OWNER, TOKEN, TOKEN2)
  assert.equal(flows.flow0, 500n)
})

test('an ERC-20 v4 mint reads the owner outflow as negative', () => {
  const flows = receiptV4TokenFlows(receipt([transferLog(TOKEN, OWNER, PM, 300n)]), OWNER, TOKEN, TOKEN2)
  assert.equal(flows.flow0, -300n)
})

test('both ERC-20 sides net independently across multiple legs', () => {
  const flows = receiptV4TokenFlows(
    receipt([
      transferLog(TOKEN, PM, OWNER, 500n),
      transferLog(TOKEN, OWNER, PM, 100n), // a refund leg nets back down
      transferLog(TOKEN2, PM, OWNER, 42n),
    ]),
    OWNER,
    TOKEN,
    TOKEN2,
  )
  assert.equal(flows.flow0, 400n)
  assert.equal(flows.flow1, 42n)
})

test('a native side is reported null, never a guessed zero', () => {
  const flows = receiptV4TokenFlows(receipt([]), OWNER, zeroAddress, TOKEN)
  assert.equal(flows.flow0, null)
  assert.equal(flows.flow1, 0n)
})

test('foreign token transfers are ignored', () => {
  const flows = receiptV4TokenFlows(receipt([transferLog(STRANGER, PM, OWNER, 999n)]), OWNER, TOKEN, TOKEN2)
  assert.equal(flows.flow0, 0n)
  assert.equal(flows.flow1, 0n)
})
