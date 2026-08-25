import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  keccak256,
  multicall3Abi,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { clFactoryAbi, clGaugeAbi, clPmAbi, clPoolAbi, clSwapRouterAbi, quoterAbi, uniSwapRouterAbi, uniV3FactoryAbi, uniV3PmAbi, uniV3PoolAbi, uniV3QuoterAbi, voterAbi } from '../src/abi'
import { ADDR, UNI } from '../src/config/addresses'
import { getSqrtRatioAtTick } from '../src/lib/clmath'
import { originalStrategyDraft } from '../shared/strategy/schema'

const router = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as Address
const pool = '0x0000000000000000000000000000000000001000' as Address
const up33Pool = '0x0000000000000000000000000000000000001001' as Address
const token0 = '0x0000000000000000000000000000000000002000' as Address
const token1 = ADDR.WETH
const gauge = '0x0000000000000000000000000000000000003000' as Address
const privateKey = `0x${'11'.repeat(32)}` as Hex
const owner = privateKeyToAccount(privateKey).address
const swapAbi = parseAbi(['function swap(address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,address recipient)'])
const zeroAddress = '0x0000000000000000000000000000000000000000' as Address
const multicall3 = '0xca11bde05977b3631167028862be2a173976ca11' as Address
const low = (value: string) => value.toLowerCase()
const hex = (value: bigint | number) => `0x${BigInt(value).toString(16)}`
const bloom = `0x${'0'.repeat(512)}`

type Position = { owner?: Address; protocol: 'up33' | 'univ3'; liquidity: bigint; owed0: bigint; owed1: bigint; tickLower: number; tickUpper: number }
type MockTx = { hash: Hex; from: Address; to: Address; input: Hex; nonce: bigint; blockNumber: bigint; blockHash: Hex; receipt: any }
const positions = new Map<bigint, Position>()
const balances = new Map<string, bigint>()
const allowances = new Map<string, bigint>()
const transactions = new Map<string, MockTx>()
const nftApprovals = new Map<bigint, Address>()
const nftOperatorApprovals = new Set<string>()
const stakedIds = new Set<bigint>()
const stakingRewards = new Map<bigint, bigint>()
let chainNonce = 0n
let blockNumber = 10_000n
let poolTick = 101
let gasPriceWei = 1n
let failOnce: 'decrease_before' | 'collect_before' | 'approve_before' | 'swap_before' | 'mint_before' | 'revoke_before' | 'collect_after' | 'multicall_after' | 'unstake_before' | 'stake_before' | undefined
let afterNextAcceptedTransaction: (() => void) | undefined
let afterAcceptedCall: ((functionName: string) => void) | undefined
let lastEthCallError: string | undefined
let kyberUnavailable = false
let rpcReadFailOnce = false
let earnedUnavailable = false
const rpcMethodCounts = new Map<string, number>()

const balanceKey = (token: Address, address: Address) => `${low(token)}:${low(address)}`
const allowanceKey = (token: Address, holder: Address, spender: Address) => `${low(token)}:${low(holder)}:${low(spender)}`
const balance = (token: Address, address: Address) => balances.get(balanceKey(token, address)) ?? 0n
const addBalance = (token: Address, address: Address, delta: bigint) => balances.set(balanceKey(token, address), balance(token, address) + delta)
const allowance = (token: Address, holder: Address, spender: Address) => allowances.get(allowanceKey(token, holder, spender)) ?? 0n

function eventLog(address: Address, topics: Hex[], data: Hex, txHash: Hex, blockHash: Hex, block: bigint, index: number) {
  return { address, topics, data, blockHash, blockNumber: hex(block), transactionHash: txHash, transactionIndex: '0x0', logIndex: hex(index), removed: false }
}

function transferLog(token: Address, from: Address, to: Address, value: bigint, txHash: Hex, blockHash: Hex, block: bigint, index: number) {
  return eventLog(
    token,
    encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }) as Hex[],
    encodeAbiParameters([{ type: 'uint256' }], [value]),
    txHash,
    blockHash,
    block,
    index,
  )
}

function classify(to: Address, data: Hex) {
  try {
    if (low(to) === low(UNI.V3_NPM)) return decodeFunctionData({ abi: uniV3PmAbi, data })
    if (low(to) === low(ADDR.CL_PM)) return decodeFunctionData({ abi: clPmAbi, data })
    if (low(to) === low(gauge)) return decodeFunctionData({ abi: clGaugeAbi, data })
    if (low(to) === low(token0) || low(to) === low(token1) || low(to) === low(ADDR.UP) || low(to) === low(ADDR.USDG)) return decodeFunctionData({ abi: erc20Abi, data })
    if (low(to) === low(router)) return decodeFunctionData({ abi: swapAbi, data })
    if (low(to) === low(ADDR.CL_SWAP_ROUTER)) return decodeFunctionData({ abi: clSwapRouterAbi, data })
    if (low(to) === low(UNI.V3_SWAP_ROUTER)) return decodeFunctionData({ abi: uniSwapRouterAbi, data })
  } catch { /* malformed calls fail below */ }
  throw new Error('unknown mock transaction')
}

async function acceptRawTransaction(raw: Hex): Promise<{ hash?: Hex; error?: string }> {
  const parsed = parseTransaction(raw)
  const from = await recoverTransactionAddress({ serializedTransaction: raw as any })
  const to = parsed.to as Address
  const input = (parsed.data ?? '0x') as Hex
  const call = classify(to, input)
  const shouldFail =
    (failOnce === 'decrease_before' && call.functionName === 'decreaseLiquidity') ||
    (failOnce === 'collect_before' && call.functionName === 'collect') ||
    (failOnce === 'approve_before' && call.functionName === 'approve' && (call.args as readonly unknown[])[1] !== 0n) ||
    (failOnce === 'swap_before' && (call.functionName === 'swap' || call.functionName === 'exactInputSingle')) ||
    (failOnce === 'mint_before' && call.functionName === 'mint') ||
    (failOnce === 'unstake_before' && call.functionName === 'withdraw' && low(to) === low(gauge)) ||
    (failOnce === 'stake_before' && call.functionName === 'deposit' && low(to) === low(gauge)) ||
    (failOnce === 'revoke_before' && call.functionName === 'approve' && (call.args as readonly unknown[])[1] === 0n) ||
    (failOnce === 'collect_after' && call.functionName === 'collect') ||
    (failOnce === 'multicall_after' && call.functionName === 'multicall')
  const failAfter = (failOnce === 'collect_after' || failOnce === 'multicall_after') && shouldFail
  if (shouldFail && !failAfter) {
    failOnce = undefined
    return { error: 'injected transport failure before broadcast' }
  }

  const hash = keccak256(raw)
  blockNumber += 1n
  const blockHash = keccak256(`0x${blockNumber.toString(16).padStart(64, '0')}` as Hex)
  const logs: any[] = []
  if (call.functionName === 'multicall' && (low(to) === low(ADDR.CL_PM) || low(to) === low(UNI.V3_NPM))) {
    const abi = low(to) === low(ADDR.CL_PM) ? clPmAbi : uniV3PmAbi
    const calls = (call.args as readonly [readonly Hex[]])[0]
    for (const data of calls) {
      const inner = decodeFunctionData({ abi, data })
      if (inner.functionName === 'decreaseLiquidity') {
        const params = (inner.args as readonly any[])[0]
        const position = positions.get(params.tokenId)!
        assert.ok(position && position.liquidity > 0n)
        position.liquidity = 0n
        position.owed1 += 1_000n
        logs.push(eventLog(to, encodeEventTopics({ abi: clPmAbi, eventName: 'DecreaseLiquidity', args: { tokenId: params.tokenId } }) as Hex[], encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [params.liquidity, 0n, 1_000n]), hash, blockHash, blockNumber, logs.length))
      } else if (inner.functionName === 'collect') {
        const params = (inner.args as readonly any[])[0]
        const position = positions.get(params.tokenId)!
        const amount0 = position.owed0
        const amount1 = position.owed1
        position.owed0 = 0n
        position.owed1 = 0n
        addBalance(token0, owner, amount0)
        addBalance(token1, owner, amount1)
        logs.push(eventLog(to, encodeEventTopics({ abi: clPmAbi, eventName: 'Collect', args: { tokenId: params.tokenId } }) as Hex[], encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [owner, amount0, amount1]), hash, blockHash, blockNumber, logs.length))
        if (amount0) logs.push(transferLog(token0, to, owner, amount0, hash, blockHash, blockNumber, logs.length))
        if (amount1) logs.push(transferLog(token1, to, owner, amount1, hash, blockHash, blockNumber, logs.length))
      } else throw new Error(`unsupported position multicall ${inner.functionName}`)
    }
  } else if (call.functionName === 'decreaseLiquidity') {
    const params = (call.args as readonly any[])[0]
    const position = positions.get(params.tokenId)!
    assert.ok(position && position.liquidity > 0n)
    position.liquidity = 0n
    position.owed1 += 1_000n
    logs.push(eventLog(to, encodeEventTopics({ abi: clPmAbi, eventName: 'DecreaseLiquidity', args: { tokenId: params.tokenId } }) as Hex[], encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [params.liquidity, 0n, 1_000n]), hash, blockHash, blockNumber, logs.length))
  } else if (call.functionName === 'collect') {
    const params = (call.args as readonly any[])[0]
    const position = positions.get(params.tokenId)!
    const amount0 = position.owed0
    const amount1 = position.owed1
    position.owed0 = 0n
    position.owed1 = 0n
    addBalance(token0, owner, amount0)
    addBalance(token1, owner, amount1)
    logs.push(eventLog(to, encodeEventTopics({ abi: clPmAbi, eventName: 'Collect', args: { tokenId: params.tokenId } }) as Hex[], encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [owner, amount0, amount1]), hash, blockHash, blockNumber, logs.length))
    if (amount0) logs.push(transferLog(token0, to, owner, amount0, hash, blockHash, blockNumber, logs.length))
    if (amount1) logs.push(transferLog(token1, to, owner, amount1, hash, blockHash, blockNumber, logs.length))
  } else if (call.functionName === 'burn') {
    const tokenId = (call.args as readonly bigint[])[0]
    positions.get(tokenId)!.owner = undefined
  } else if (call.functionName === 'withdraw' && low(to) === low(gauge)) {
    const tokenId = (call.args as readonly bigint[])[0]
    const position = positions.get(tokenId)!
    assert.ok(stakedIds.has(tokenId) && low(position.owner!) === low(gauge))
    stakedIds.delete(tokenId)
    position.owner = owner
    const reward = stakingRewards.get(tokenId) ?? 0n
    stakingRewards.set(tokenId, 0n)
    addBalance(ADDR.UP, owner, reward)
    if (reward) logs.push(transferLog(ADDR.UP, gauge, owner, reward, hash, blockHash, blockNumber, logs.length))
  } else if (call.functionName === 'deposit' && low(to) === low(gauge)) {
    const tokenId = (call.args as readonly bigint[])[0]
    const position = positions.get(tokenId)!
    assert.equal(low(position.owner!), low(owner))
    assert.ok(low(nftApprovals.get(tokenId) ?? zeroAddress) === low(gauge) || nftOperatorApprovals.has(`${low(owner)}:${low(gauge)}`))
    position.owner = gauge
    stakedIds.add(tokenId)
    nftApprovals.delete(tokenId)
  } else if (call.functionName === 'setApprovalForAll' && low(to) === low(ADDR.CL_PM)) {
    const [operator, approved] = call.args as readonly [Address, boolean]
    const key = `${low(owner)}:${low(operator)}`
    if (approved) nftOperatorApprovals.add(key)
    else nftOperatorApprovals.delete(key)
  } else if (call.functionName === 'approve' && low(to) === low(ADDR.CL_PM)) {
    const [spender, tokenId] = call.args as readonly [Address, bigint]
    nftApprovals.set(tokenId, spender)
  } else if (call.functionName === 'approve') {
    const [spender, amount] = call.args as readonly [Address, bigint]
    allowances.set(allowanceKey(to, owner, spender), amount)
  } else if (call.functionName === 'swap' || call.functionName === 'exactInputSingle') {
    const swapParts: readonly [Address, Address, bigint, bigint, Address] = call.functionName === 'swap'
      ? call.args as readonly [Address, Address, bigint, bigint, Address]
      : (() => {
          const params = (call.args as readonly any[])[0]
          return [params.tokenIn, params.tokenOut, BigInt(params.amountIn), BigInt(params.amountIn), params.recipient]
        })()
    const [inToken, outToken, amountIn, amountOut, recipient] = swapParts
    assert.equal(low(recipient), low(owner))
    assert.ok(balance(inToken, owner) >= amountIn)
    addBalance(inToken, owner, -amountIn)
    addBalance(outToken, owner, amountOut)
    allowances.set(allowanceKey(inToken, owner, to), allowance(inToken, owner, to) - amountIn)
    logs.push(transferLog(inToken, owner, to, amountIn, hash, blockHash, blockNumber, logs.length))
    logs.push(transferLog(outToken, to, owner, amountOut, hash, blockHash, blockNumber, logs.length))
  } else if (call.functionName === 'mint') {
    const params = (call.args as readonly any[])[0]
    const desired0 = BigInt(params.amount0Desired)
    const desired1 = BigInt(params.amount1Desired)
    const used0 = desired0 > 1n ? desired0 - 1n : desired0
    const used1 = desired1 > 1n ? desired1 - 1n : desired1
    assert.ok(balance(token0, owner) >= used0 && balance(token1, owner) >= used1)
    addBalance(token0, owner, -used0)
    addBalance(token1, owner, -used1)
    allowances.set(allowanceKey(token0, owner, to), allowance(token0, owner, to) - used0)
    allowances.set(allowanceKey(token1, owner, to), allowance(token1, owner, to) - used1)
    const newTokenId = BigInt(100 + positions.size)
    const protocol = low(to) === low(ADDR.CL_PM) ? 'up33' : 'univ3'
    const destinationPool = protocol === 'up33' ? up33Pool : pool
    positions.set(newTokenId, { owner, protocol, liquidity: 999n, owed0: 0n, owed1: 0n, tickLower: params.tickLower, tickUpper: params.tickUpper })
    logs.push(eventLog(to, encodeEventTopics({ abi: clPmAbi, eventName: 'IncreaseLiquidity', args: { tokenId: newTokenId } }) as Hex[], encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [999n, used0, used1]), hash, blockHash, blockNumber, logs.length))
    if (used0) logs.push(transferLog(token0, owner, destinationPool, used0, hash, blockHash, blockNumber, logs.length))
    if (used1) logs.push(transferLog(token1, owner, destinationPool, used1, hash, blockHash, blockNumber, logs.length))
  }

  const receipt = {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash,
    blockNumber: hex(blockNumber),
    from,
    to,
    cumulativeGasUsed: '0x186a0',
    gasUsed: '0x186a0',
    contractAddress: null,
    logs,
    logsBloom: bloom,
    status: '0x1',
    effectiveGasPrice: '0x1',
    type: '0x0',
  }
  transactions.set(low(hash), { hash, from, to, input, nonce: BigInt(parsed.nonce ?? 0), blockNumber, blockHash, receipt })
  chainNonce = BigInt(parsed.nonce ?? 0) + 1n
  const acceptedHook = afterNextAcceptedTransaction
  afterNextAcceptedTransaction = undefined
  acceptedHook?.()
  afterAcceptedCall?.(call.functionName)
  if (failAfter) {
    failOnce = undefined
    return { error: 'injected lost response after broadcast' }
  }
  return { hash }
}

function callResult(to: Address, data: Hex): { result?: Hex; error?: string } {
  try {
    if (low(to) === low(multicall3)) {
      const call = decodeFunctionData({ abi: multicall3Abi, data })
      if (call.functionName === 'aggregate3') {
        const calls = (call.args as readonly [readonly { target: Address; allowFailure: boolean; callData: Hex }[]])[0]
        const result = calls.map((item) => {
          const nested = callResult(item.target, item.callData)
          if (nested.error && !item.allowFailure) throw new Error(nested.error)
          return { success: !nested.error, returnData: nested.result ?? '0x' }
        })
        return { result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result }) }
      }
    }
    if (low(to) === low(UNI.V3_NPM) || low(to) === low(ADDR.CL_PM)) {
      const abi = low(to) === low(ADDR.CL_PM) ? clPmAbi : uniV3PmAbi
      const call = decodeFunctionData({ abi, data })
      if (call.functionName === 'ownerOf') {
        const id = (call.args as readonly bigint[])[0]
        const position = positions.get(id)
        if (!position?.owner) return { error: 'ERC721 nonexistent token' }
        return { result: encodeFunctionResult({ abi, functionName: 'ownerOf', result: position.owner } as never) }
      }
      if (call.functionName === 'getApproved') {
        const id = (call.args as readonly bigint[])[0]
        return { result: encodeFunctionResult({ abi, functionName: 'getApproved', result: nftApprovals.get(id) ?? zeroAddress } as never) }
      }
      if (call.functionName === 'isApprovedForAll') {
        const [holder, operator] = call.args as readonly [Address, Address]
        return { result: encodeFunctionResult({ abi, functionName: 'isApprovedForAll', result: nftOperatorApprovals.has(`${low(holder)}:${low(operator)}`) } as never) }
      }
      if (call.functionName === 'positions') {
        const id = (call.args as readonly bigint[])[0]
        const position = positions.get(id)
        if (!position) return { error: 'position missing' }
        const poolKey = position.protocol === 'up33' ? 10 : 3000
        return { result: encodeFunctionResult({ abi, functionName: 'positions', result: [0n, zeroAddress, token0, token1, poolKey, position.tickLower, position.tickUpper, position.liquidity, 0n, 0n, position.owed0, position.owed1] } as never) }
      }
      if (call.functionName === 'collect') {
        const params = (call.args as readonly any[])[0]
        const position = positions.get(params.tokenId)
        if (!position) return { error: 'position missing' }
        return { result: encodeFunctionResult({ abi, functionName: 'collect', result: [position.owed0, position.owed1] } as never) }
      }
    }
    if (low(to) === low(pool) || low(to) === low(up33Pool)) {
      const abi = low(to) === low(up33Pool) ? clPoolAbi : uniV3PoolAbi
      const call = decodeFunctionData({ abi, data })
      if (call.functionName === 'slot0') {
        const result = low(to) === low(up33Pool)
          ? [getSqrtRatioAtTick(poolTick), poolTick, 0, 0, 0, true]
          : [getSqrtRatioAtTick(poolTick), poolTick, 0, 0, 0, 0, true]
        return { result: encodeFunctionResult({ abi, functionName: 'slot0', result } as never) }
      }
      if (call.functionName === 'tickSpacing') return { result: encodeFunctionResult({ abi, functionName: 'tickSpacing', result: 10 } as never) }
      if (call.functionName === 'fee') return { result: encodeFunctionResult({ abi, functionName: 'fee', result: 3000 } as never) }
      if (call.functionName === 'unstakedFee') return { result: encodeFunctionResult({ abi, functionName: 'unstakedFee', result: 0 } as never) }
      if (call.functionName === 'token0') return { result: encodeFunctionResult({ abi, functionName: 'token0', result: token0 } as never) }
      if (call.functionName === 'token1') return { result: encodeFunctionResult({ abi, functionName: 'token1', result: token1 } as never) }
      if (call.functionName === 'gauge') return { result: encodeFunctionResult({ abi, functionName: 'gauge', result: gauge } as never) }
    }
    if (low(to) === low(gauge)) {
      const call = decodeFunctionData({ abi: clGaugeAbi, data })
      if (call.functionName === 'stakedValues') return { result: encodeFunctionResult({ abi: clGaugeAbi, functionName: 'stakedValues', result: [...stakedIds] }) }
      if (call.functionName === 'earned') {
        if (earnedUnavailable) return { error: 'execution reverted: NA' }
        return { result: encodeFunctionResult({ abi: clGaugeAbi, functionName: 'earned', result: stakingRewards.get((call.args as readonly [Address, bigint])[1]) ?? 0n }) }
      }
    }
    if (low(to) === low(ADDR.VOTER)) {
      const call = decodeFunctionData({ abi: voterAbi, data })
      if (call.functionName === 'isAlive') return { result: encodeFunctionResult({ abi: voterAbi, functionName: 'isAlive', result: true }) }
    }
    if (low(to) === low(UNI.V3_FACTORY)) {
      const call = decodeFunctionData({ abi: uniV3FactoryAbi, data })
      if (call.functionName === 'getPool') return { result: encodeFunctionResult({ abi: uniV3FactoryAbi, functionName: 'getPool', result: pool }) }
    }
    if (low(to) === low(ADDR.CL_FACTORY)) {
      const call = decodeFunctionData({ abi: clFactoryAbi, data })
      if (call.functionName === 'tickSpacings') return { result: encodeFunctionResult({ abi: clFactoryAbi, functionName: 'tickSpacings', result: [10] }) }
      if (call.functionName === 'getPool') return { result: encodeFunctionResult({ abi: clFactoryAbi, functionName: 'getPool', result: up33Pool }) }
    }
    if (low(to) === low(ADDR.CL_QUOTER)) {
      const call = decodeFunctionData({ abi: quoterAbi, data })
      if (call.functionName === 'quoteExactInputSingle') {
        const params = (call.args as readonly any[])[0]
        return { result: encodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInputSingle', result: [params.amountIn, getSqrtRatioAtTick(poolTick), 0, 100_000n] }) }
      }
    }
    if (low(to) === low(UNI.V3_QUOTER)) {
      const call = decodeFunctionData({ abi: uniV3QuoterAbi, data })
      if (call.functionName === 'quoteExactInputSingle') {
        const params = (call.args as readonly any[])[0]
        return { result: encodeFunctionResult({ abi: uniV3QuoterAbi, functionName: 'quoteExactInputSingle', result: [params.amountIn, getSqrtRatioAtTick(poolTick), 0, 100_000n] }) }
      }
    }
    if (low(to) === low(token0) || low(to) === low(token1) || low(to) === low(ADDR.UP) || low(to) === low(ADDR.USDG)) {
      const call = decodeFunctionData({ abi: erc20Abi, data })
      if (call.functionName === 'decimals') return { result: encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: low(to) === low(ADDR.USDG) ? 6 : 18 }) }
      if (call.functionName === 'balanceOf') return { result: encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: balance(to, (call.args as readonly Address[])[0]) }) }
      if (call.functionName === 'allowance') {
        const [holder, spender] = call.args as readonly [Address, Address]
        return { result: encodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', result: allowance(to, holder, spender) }) }
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'eth_call failed' }
  }
  return { error: `unsupported eth_call ${to} ${data.slice(0, 10)}` }
}

const rpcServer = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const handle = async (request: any) => {
    rpcMethodCounts.set(request.method, (rpcMethodCounts.get(request.method) ?? 0) + 1)
    let result: any
    let error: string | undefined
    const params = request.params ?? []
    if (request.method === 'eth_chainId') result = hex(4663)
    else if (request.method === 'eth_blockNumber') result = hex(blockNumber)
    else if (request.method === 'eth_gasPrice') result = hex(gasPriceWei)
    else if (request.method === 'eth_getBalance') result = hex(10n ** 20n)
    else if (request.method === 'eth_getTransactionCount') result = hex(chainNonce)
    else if (request.method === 'eth_estimateGas') result = '0x7a120'
    else if (request.method === 'eth_fillTransaction') result = { ...params[0], gas: '0x7a120', gasPrice: '0x1', nonce: hex(chainNonce) }
    else if (request.method === 'eth_getBlockByNumber') {
      const blockHash = keccak256(`0x${blockNumber.toString(16).padStart(64, '0')}` as Hex)
      result = { baseFeePerGas: '0x0', difficulty: '0x0', extraData: '0x', gasLimit: '0x1c9c380', gasUsed: '0x0', hash: blockHash, logsBloom: bloom, miner: zeroAddress, mixHash: `0x${'0'.repeat(64)}`, nonce: '0x0000000000000000', number: hex(blockNumber), parentHash: `0x${'0'.repeat(64)}`, receiptsRoot: `0x${'0'.repeat(64)}`, sha3Uncles: `0x${'0'.repeat(64)}`, size: '0x1', stateRoot: `0x${'0'.repeat(64)}`, timestamp: hex(Math.floor(Date.now() / 1000)), totalDifficulty: '0x0', transactions: [], transactionsRoot: `0x${'0'.repeat(64)}`, uncles: [] }
    }
    else if (request.method === 'eth_call') {
      if (rpcReadFailOnce) {
        rpcReadFailOnce = false
        error = 'RPC Request failed. injected transient provider error'
      } else ({ result, error } = callResult(params[0].to as Address, params[0].data as Hex))
      if (error) lastEthCallError = error
    }
    else if (request.method === 'eth_sendRawTransaction') ({ hash: result, error } = await acceptRawTransaction(params[0] as Hex))
    else if (request.method === 'eth_getTransactionReceipt') result = transactions.get(low(params[0]))?.receipt ?? null
    else if (request.method === 'eth_getTransactionByHash') {
      const tx = transactions.get(low(params[0]))
      result = tx ? { blockHash: tx.blockHash, blockNumber: hex(tx.blockNumber), from: tx.from, gas: '0x7a120', gasPrice: '0x1', hash: tx.hash, input: tx.input, nonce: hex(tx.nonce), to: tx.to, transactionIndex: '0x0', value: '0x0', type: '0x0', v: '0x25', r: `0x${'1'.padStart(64, '0')}`, s: `0x${'1'.padStart(64, '0')}` } : null
    } else error = `unsupported rpc method ${request.method}`
    return error ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error } } : { jsonrpc: '2.0', id: request.id, result }
  }
  const response = Array.isArray(body) ? await Promise.all(body.map(handle)) : await handle(body)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(response))
})

const kyberServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://kyber')
  let body: any
  if (req.method === 'GET' && url.pathname.endsWith('/routes')) {
    if (kyberUnavailable) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 1, message: 'injected aggregator outage' }))
      return
    }
    const amountIn = url.searchParams.get('amountIn')!
    const inToken = url.searchParams.get('tokenIn') as Address
    const outToken = url.searchParams.get('tokenOut') as Address
    body = { code: 0, data: { routerAddress: router, routeSummary: { tokenIn: inToken, tokenOut: outToken, amountIn, amountOut: amountIn, route: [[]] } } }
  } else if (req.method === 'POST' && url.pathname.endsWith('/route/build')) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const route = request.routeSummary
    body = { code: 0, data: { routerAddress: router, amountIn: route.amountIn, amountOut: route.amountOut, transactionValue: '0', data: encodeFunctionData({ abi: swapAbi, functionName: 'swap', args: [route.tokenIn, route.tokenOut, BigInt(route.amountIn), BigInt(route.amountOut), request.recipient] }) } }
  } else {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
})

const dataDir = mkdtempSync(join(tmpdir(), 'lp-executor-integration-'))
try {
  rpcServer.listen(0, '127.0.0.1')
  kyberServer.listen(0, '127.0.0.1')
  await Promise.all([once(rpcServer, 'listening'), once(kyberServer, 'listening')])
  const rpcAddress = rpcServer.address()
  const kyberAddress = kyberServer.address()
  assert.ok(rpcAddress && typeof rpcAddress === 'object' && kyberAddress && typeof kyberAddress === 'object')
  process.env.LP_EXECUTOR_DATA_DIR = dataDir
  process.env.LP_EXECUTOR_MASTER_KEY = 'integration-master-key-with-at-least-32-bytes'
  process.env.LP_EXECUTOR_API_TOKEN = 'integration-api-token-with-at-least-32-bytes'
  process.env.LP_EXECUTOR_RPC = `http://127.0.0.1:${rpcAddress.port}`
  process.env.LP_EXECUTOR_KYBER_BASE = `http://127.0.0.1:${kyberAddress.port}`
  process.env.LP_EXECUTOR_CONFIRMATIONS = '1'

  const store = await import('../executor/store')
  const vault = await import('../executor/vault')
  const { monitorOnce } = await import('../executor/monitor')
  const { readMonitorSnapshots } = await import('../executor/chain')
  const { runOnce } = await import('../executor/runner')
  const { startSimpleStrategy } = await import('../executor/simple')
  const { strategyPerformance } = await import('../executor/performance')
  const { inspectRecovery } = await import('../executor/recovery')
  const { executeRecovery, stopAndArchiveStrategy } = await import('../executor/recovery-runner')
  const imported = vault.importPrivateKey('wallet_integration', privateKey)
  const now = Math.floor(Date.now() / 1000)
  store.addWallet({ id: 'wallet_integration', label: 'Integration account', address: owner, vaultPath: imported.path, createdAt: now, updatedAt: now })

  const waitForState = async (strategyId: string, wanted: string) => {
    for (let i = 0; i < 300; i++) {
      const row = store.strategyById(strategyId)
      if (row?.state === wanted) return row
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const strategy = store.strategyById(strategyId)
    const jobs = store.db.prepare('SELECT id,state FROM jobs WHERE strategy_id=?').all(strategyId)
    const steps = jobs.length ? store.jobSteps(String((jobs[0] as any).id)) : []
    throw new Error(`timed out waiting for ${strategyId} -> ${wanted}: ${JSON.stringify({ state: strategy?.state, jobs, steps })}`)
  }

  const createStrategy = (suffix: string, tokenId: bigint, protocol: 'up33' | 'univ3' = 'univ3') => {
    positions.set(tokenId, { owner, protocol, liquidity: 1_000n, owed0: 0n, owed1: 0n, tickLower: -100, tickUpper: 100 })
    const base = originalStrategyDraft({ owner, protocol, pool: protocol === 'up33' ? up33Pool : pool, positionManager: protocol === 'up33' ? ADDR.CL_PM : UNI.V3_NPM, riskToken: token0, quoteToken: token1, activeTokenId: tokenId.toString(), name: `integration ${suffix}` })
    const config = { ...base, id: `strategy-integration-${suffix}`, enabled: true, execution: { ...base.execution, mode: 'executor_auto' as const, walletId: 'wallet_integration', signerAddress: owner, dryRun: false, maxGasPriceWei: '1000000000', maxDailyTurnoverQuote: '1000000' } }
    store.upsertStrategy(config)
    return config
  }

  const runScenario = async (suffix: string, tokenId: bigint, failure?: typeof failOnce, tick = 101, protocol: 'up33' | 'univ3' = 'univ3', repriceBeforeRecovery = false, disableAfter = true, initialOwed0 = 0n, baselineValueQuoteRaw?: string) => {
    poolTick = tick
    lastEthCallError = undefined
    const config = createStrategy(suffix, tokenId, protocol)
    positions.get(tokenId)!.owed0 = initialOwed0
    if (baselineValueQuoteRaw) store.setStrategyBaselineIfAbsent({
      strategyId: config.id,
      valueQuoteRaw: baselineValueQuoteRaw,
      quoteToken: config.quoteToken,
      observedAt: now,
      blockNumber: blockNumber.toString(),
      tokenId: tokenId.toString(),
      tick,
      source: 'strategy_start',
    })
    failOnce = failure
    await monitorOnce({ ignoreSchedule: true })
    const plannedState = store.strategyById(config.id)?.state
    assert.equal(plannedState, 'planned', JSON.stringify({ lastEthCallError, audit: store.db.prepare('SELECT action,detail_json FROM audit_events WHERE target_id=? ORDER BY id DESC LIMIT 3').all(config.id) }))
    await runOnce()
    const firstState = failure ? 'recovery' : 'monitoring'
    await waitForState(config.id, firstState)
    if (failure) {
      const recoveryRows = store.jobsForRecovery().filter((row) => row.strategy_id === config.id)
      assert.equal(recoveryRows.length, 1)
      const inspection = await inspectRecovery(recoveryRows[0].id)
      assert.notEqual(inspection.disposition, 'manual_review')
      const beforeSwapPlan = store.getJobContext<{ swaps: { txIndex: number; amountIn: string }[] }>(recoveryRows[0].id, 'swap_plan')
      if (repriceBeforeRecovery) {
        poolTick = tick + 30
        // A different strategy sharing this wallet may change the aggregate
        // balance while this job is waiting for recovery. It must neither
        // block recovery nor be attributed to this strategy.
        addBalance(token1, owner, 77n)
      }
      await executeRecovery(recoveryRows[0].id)
      await waitForState(config.id, 'monitoring')
      if (repriceBeforeRecovery) {
        const afterSwapPlan = store.getJobContext<{ swaps: { txIndex: number; amountIn: string }[] }>(recoveryRows[0].id, 'swap_plan')!
        assert.ok(beforeSwapPlan?.swaps.length)
        assert.equal(new Set(afterSwapPlan.swaps.map((record) => record.txIndex)).size, afterSwapPlan.swaps.length)
        assert.ok((store.strategyAllocations(config.id)[low(token1)] ?? 0n) < 77n)
      }
    }
    const completed = store.db.prepare(`SELECT id FROM jobs WHERE strategy_id=? AND state='completed' ORDER BY created_at DESC LIMIT 1`).get(config.id) as { id: string }
    const steps = store.jobSteps(completed.id)
    assert.equal(steps.filter((step) => step.state === 'confirmed').length, 12)
    const confirmedSwaps = store.jobTransactions(completed.id).filter((tx) => tx.state === 'confirmed' && Number(tx.step_index) === 5)
    if (confirmedSwaps.length) {
      const durablePlan = store.getJobContext<{ swaps: { txIndex: number; quotedOut: string; minOut?: string; route?: { minOut?: string } }[] }>(completed.id, 'swap_plan')!
      for (const tx of confirmedSwaps) {
        const record = durablePlan.swaps.find((item) => item.txIndex === Number(tx.tx_index))
        assert.ok(record?.minOut, `missing executable minOut for ${completed.id}:${String(tx.tx_index)}`)
        assert.equal(record?.route?.minOut, record?.minOut)
      }
    }
    const next = store.strategyById(config.id)!
    assert.notEqual(next.config.activeTokenId, tokenId.toString())
    assert.equal(allowance(token0, owner, config.positionManager), 0n)
    assert.equal(allowance(token1, owner, config.positionManager), 0n)
    if (protocol === 'up33') {
      assert.equal(allowance(token0, owner, ADDR.CL_SWAP_ROUTER), 0n)
      assert.equal(allowance(token1, owner, ADDR.CL_SWAP_ROUTER), 0n)
    } else {
      assert.equal(allowance(token0, owner, UNI.V3_SWAP_ROUTER), 0n)
      assert.equal(allowance(token1, owner, UNI.V3_SWAP_ROUTER), 0n)
    }
    const completedConfig = store.strategyById(config.id)!.config
    if (disableAfter) store.upsertStrategy({ ...completedConfig, enabled: false })
    return completedConfig
  }

  await runScenario('success', 1n)
  await runScenario('lower-success', 12n, undefined, -101)
  const carryConfig = await runScenario('principal-carry', 22n, undefined, 101, 'univ3', false, false, 100n, '1000000000')
  const firstCarry = store.strategyAllocationComponents(carryConfig.id)
  assert.equal(firstCarry[low(token0)].principal, 1n)
  assert.equal(firstCarry[low(token1)].principal, 1n)
  assert.equal(firstCarry[low(token0)].heldFee, 0n)
  assert.equal(firstCarry[low(token1)].heldFee, 100n)
  const losingCarryPerformance = await strategyPerformance(carryConfig, 'monitoring')
  const losingCarryCycle = losingCarryPerformance.cycles[0]
  assert.ok(BigInt(losingCarryPerformance.summary.pnlQuoteRaw!) < 0n)
  assert.ok(BigInt(losingCarryCycle.netFeesQuoteRaw) < BigInt(losingCarryCycle.gasCostQuoteRaw) + BigInt(losingCarryCycle.executionCostQuoteRaw))
  poolTick = -1_000
  await monitorOnce({ ignoreSchedule: true })
  assert.equal(store.strategyById(carryConfig.id)?.state, 'planned')
  await runOnce()
  await waitForState(carryConfig.id, 'monitoring')
  const secondCarry = store.strategyAllocationComponents(carryConfig.id)
  assert.equal(secondCarry[low(token0)].principal, 1n)
  assert.equal(secondCarry[low(token1)].principal, 1n)
  assert.equal(secondCarry[low(token0)].heldFee, 0n)
  assert.equal(secondCarry[low(token1)].heldFee, 100n)
  const widenedCycle = store.db.prepare(`SELECT range_scale FROM cycles WHERE strategy_id=? ORDER BY completed_at DESC,id DESC LIMIT 1`).get(carryConfig.id) as { range_scale: number }
  assert.equal(widenedCycle.range_scale, 4)
  store.upsertStrategy({ ...store.strategyById(carryConfig.id)!.config, enabled: false })
  poolTick = 101

  const profitBase = createStrategy('profit-harvest', 28n)
  const profitConfig = { ...profitBase, capitalProtection: { enabled: true, profitThresholdUsdg: '0.000001' } }
  store.upsertStrategy(profitConfig)
  store.setStrategyBaselineIfAbsent({
    strategyId: profitConfig.id,
    valueQuoteRaw: '4',
    quoteToken: profitConfig.quoteToken,
    observedAt: now,
    blockNumber: '10000',
    tokenId: '28',
    tick: poolTick,
    source: 'strategy_start',
  })
  await monitorOnce({ ignoreSchedule: true })
  assert.equal(store.strategyById(profitConfig.id)?.state, 'planned')
  await runOnce()
  await waitForState(profitConfig.id, 'monitoring')
  const profitParts = store.strategyAllocationComponents(profitConfig.id)
  assert.ok((profitParts[low(token0)]?.heldProfit ?? 0n) + (profitParts[low(token1)]?.heldProfit ?? 0n) > 0n)
  assert.equal((store.db.prepare(`SELECT COUNT(*) AS n FROM ledger_entries WHERE strategy_id=? AND kind='profit_harvest'`).get(profitConfig.id) as { n: number }).n, 2)
  store.upsertStrategy({ ...store.strategyById(profitConfig.id)!.config, enabled: false })

  const runStakedScenario = async (suffix: string, tokenId: bigint, failure?: typeof failOnce | 'pause_after_multicall', expectedRecovery = 'resume_staking_exit', lowTransactionMode = false, rewardAmount = 500n) => {
    const base = createStrategy(suffix, tokenId, 'up33')
    const config = { ...base, execution: { ...base.execution, lowTransactionMode }, staking: { enabled: true, gauge, rewardToken: ADDR.UP, rewardQuoteToken: ADDR.WETH, rewardHandling: 'convert_to_quote_hold' as const } }
    positions.get(tokenId)!.owner = gauge
    stakedIds.add(tokenId)
    stakingRewards.set(tokenId, rewardAmount)
    store.upsertStrategy(config)
    if (failure === 'pause_after_multicall') {
      afterAcceptedCall = (functionName) => {
        if (functionName !== 'multicall') return
        afterAcceptedCall = undefined
        store.setExecutorPaused(true)
      }
    } else failOnce = failure
    await monitorOnce({ ignoreSchedule: true })
    assert.equal(store.strategyById(config.id)?.state, 'planned')
    await runOnce()
    const needsRecovery = Boolean(failure && expectedRecovery !== 'self_reconciled')
    await waitForState(config.id, needsRecovery ? 'recovery' : 'monitoring')
    if (needsRecovery) {
      store.setExecutorPaused(false)
      const recovery = store.jobsForRecovery().find((row) => row.strategy_id === config.id)!
      assert.equal((await inspectRecovery(recovery.id)).disposition, expectedRecovery)
      await executeRecovery(recovery.id)
      await waitForState(config.id, 'monitoring')
    }
    const completedConfig = store.strategyById(config.id)!.config
    const newTokenId = BigInt(completedConfig.activeTokenId!)
    assert.equal(low(positions.get(newTokenId)!.owner!), low(gauge))
    assert.ok(stakedIds.has(newTokenId))
    assert.ok(!stakedIds.has(tokenId))
    const components = store.strategyAllocationComponents(config.id)
    const expectedTax = rewardAmount > 1_000_000n ? (rewardAmount * 1_000n) / 10_000n : 0n
    assert.equal(components[low(token1)].heldFee, rewardAmount - expectedTax)
    const completed = store.db.prepare(`SELECT id FROM jobs WHERE strategy_id=? AND state='completed'`).get(config.id) as { id: string }
    const stakingSteps = store.jobSteps(completed.id)
    assert.equal(stakingSteps.filter((step) => step.state === 'confirmed').length, 17, JSON.stringify(stakingSteps))
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS n FROM ledger_entries WHERE strategy_id=? AND kind='staking_reward'`).get(config.id) as { n: number }).n, 1)
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS n FROM ledger_entries WHERE strategy_id=? AND kind='swap_out' AND json_extract(meta_json,'$.source')='staking_reward'`).get(config.id) as { n: number }).n, 1)
    const incomeTax = store.db.prepare(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)),0) AS amount FROM ledger_entries WHERE strategy_id=? AND kind='swap_in' AND json_extract(meta_json,'$.purpose')='fee_tax'`).get(config.id) as { amount: number }
    assert.equal(BigInt(incomeTax.amount), expectedTax)
    if (lowTransactionMode) {
      assert.equal(low(positions.get(tokenId)!.owner!), low(owner))
      assert.ok(allowance(token0, owner, config.positionManager) > 0n)
      assert.ok(allowance(token1, owner, config.positionManager) > 0n)
      assert.ok(allowance(ADDR.UP, owner, router) > 0n)
      assert.ok(nftOperatorApprovals.has(`${low(owner)}:${low(gauge)}`))
      assert.ok(store.latestJobSummary(config.id)!.transactionCount <= 11)
    }
    const performance = await strategyPerformance(completedConfig, 'monitoring')
    assert.equal(performance.summary.grossFeesQuoteRaw, rewardAmount.toString())
    assert.equal(performance.summary.incomeTaxQuoteRaw, expectedTax.toString())
    assert.equal(performance.summary.netFeesQuoteRaw, (rewardAmount - expectedTax).toString())
    assert.equal(performance.warnings.includes('live_valuation_unavailable'), false)
    store.upsertStrategy({ ...completedConfig, enabled: false })
  }

  await runStakedScenario('staked-success', 23n)
  await runStakedScenario('staked-reward-recovery', 24n, 'swap_before')
  await runStakedScenario('staked-deposit-recovery', 25n, 'stake_before', 'commit_ready')
  await runStakedScenario('staked-low-transaction', 28n, undefined, 'resume_staking_exit', true)
  await runStakedScenario('staked-low-transaction-lost-response', 29n, 'multicall_after', 'self_reconciled', true)
  await runStakedScenario('staked-low-transaction-recovery', 30n, 'pause_after_multicall', 'resume_collect', true)
  await runStakedScenario('staked-reward-income-tax', 35n, undefined, 'resume_staking_exit', false, 2_000_000n)
  await runStakedScenario('staked-reward-tax-recovery', 36n, 'swap_before', 'resume_staking_exit', false, 2_000_000n)

  const rejectedStakeBase = createStrategy('staked-withdraw-rejected', 26n, 'up33')
  const rejectedStake = { ...rejectedStakeBase, staking: { enabled: true, gauge, rewardToken: ADDR.UP, rewardQuoteToken: ADDR.WETH, rewardHandling: 'convert_to_quote_hold' as const } }
  positions.get(26n)!.owner = gauge
  stakedIds.add(26n)
  stakingRewards.set(26n, 500n)
  store.upsertStrategy(rejectedStake)
  failOnce = 'unstake_before'
  await monitorOnce({ ignoreSchedule: true })
  await runOnce()
  await waitForState(rejectedStake.id, 'recovery')
  const rejectedJob = store.jobsForRecovery().find((row) => row.strategy_id === rejectedStake.id)!
  assert.equal((await inspectRecovery(rejectedJob.id)).disposition, 'restart_safe')
  await executeRecovery(rejectedJob.id)
  assert.equal(store.strategyById(rejectedStake.id)?.state, 'monitoring')
  assert.equal(low(positions.get(26n)!.owner!), low(gauge))
  assert.ok(stakedIds.has(26n))
  store.upsertStrategy({ ...store.strategyById(rejectedStake.id)!.config, enabled: false })

  const transientMonitor = createStrategy('transient-monitor-retry', 19n)
  rpcReadFailOnce = true
  await monitorOnce({ ignoreSchedule: true })
  assert.equal(store.strategyById(transientMonitor.id)?.state, 'monitoring')
  assert.equal((store.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE strategy_id=?`).get(transientMonitor.id) as { n: number }).n, 0)
  assert.equal((store.db.prepare(`SELECT action FROM audit_events WHERE target_id=? ORDER BY id DESC LIMIT 1`).get(transientMonitor.id) as { action: string }).action, 'monitor_retry')
  store.upsertStrategy({ ...store.strategyById(transientMonitor.id)!.config, enabled: false })

  // Starting an already in-range staked position is monitoring-only. An
  // unavailable aggregator uses a read-only native route to include accrued
  // UP in the immutable start baseline without forcing a future transaction.
  poolTick = 0
  positions.set(27n, { owner: gauge, protocol: 'up33', liquidity: 1_000_000_000n, owed0: 0n, owed1: 0n, tickLower: -100, tickUpper: 100 })
  stakedIds.add(27n)
  stakingRewards.set(27n, 500n)
  const inRangeStakedBase = originalStrategyDraft({
    owner,
    protocol: 'up33',
    pool: up33Pool,
    positionManager: ADDR.CL_PM,
    riskToken: token0,
    quoteToken: token1,
    activeTokenId: '27',
    name: 'integration in-range staked start',
    staking: { enabled: true, gauge },
  })
  kyberUnavailable = true
  const txCountBeforeInRangeStart = transactions.size
  const inRangeStaked = await startSimpleStrategy(
    { ...inRangeStakedBase, range: { mode: 'symmetric' as const, lowerPct: 2, upperPct: 2 } },
    'wallet_integration',
  )
  assert.equal(inRangeStaked.job, null)
  assert.equal(inRangeStaked.preflight.position.observedSide, 'in')
  assert.equal(inRangeStaked.preflight.routes.length, 0)
  assert.equal(store.strategyById(inRangeStakedBase.id)?.state, 'monitoring')
  assert.equal(transactions.size, txCountBeforeInRangeStart)
  const inRangeStakedBaseline = store.strategyBaseline(inRangeStakedBase.id)
  assert.ok(inRangeStakedBaseline)
  kyberUnavailable = false
  const inRangeStakedPerformance = await strategyPerformance(store.strategyById(inRangeStakedBase.id)!.config, 'monitoring')
  assert.equal(inRangeStakedPerformance.unclaimedReward?.raw, '500')
  assert.equal(inRangeStakedPerformance.unclaimedReward?.quoteRaw, '500')
  assert.equal(inRangeStakedPerformance.summary.currentUncollectedFeesQuoteRaw, '0')
  assert.equal(inRangeStakedPerformance.summary.currentUnclaimedRewardsQuoteRaw, '500')
  assert.equal(inRangeStakedPerformance.summary.currentUnclaimedTotalQuoteRaw, '500')
  assert.equal(inRangeStakedPerformance.summary.pnlQuoteRaw, '0')
  earnedUnavailable = true
  const rewardReadDegraded = await strategyPerformance(store.strategyById(inRangeStakedBase.id)!.config, 'monitoring')
  earnedUnavailable = false
  assert.equal(rewardReadDegraded.error, undefined)
  assert.match(rewardReadDegraded.rewardValuationError!, /NA/)
  assert.notEqual(rewardReadDegraded.summary.currentValueQuoteRaw, null)
  assert.equal(rewardReadDegraded.summary.currentUncollectedFeesQuoteRaw, '0')
  assert.equal(rewardReadDegraded.summary.currentUnclaimedRewardsQuoteRaw, null)
  assert.equal(rewardReadDegraded.unclaimedReward, null)
  store.upsertStrategy({ ...store.strategyById(inRangeStakedBase.id)!.config, enabled: false })
  poolTick = 101

  // The mock collect receipt contributes 1,000 raw units regardless of
  // liquidity, so use a realistic-sized position for the auto-limit test.
  positions.set(18n, { owner, protocol: 'univ3', liquidity: 1_000_000_000n, owed0: 0n, owed1: 0n, tickLower: -100, tickUpper: 100 })
  const simpleBase = originalStrategyDraft({ owner, protocol: 'univ3', pool, positionManager: UNI.V3_NPM, riskToken: token0, quoteToken: token1, activeTokenId: '18', name: 'integration simple start' })
  const simpleDraft = { ...simpleBase, range: { mode: 'symmetric' as const, lowerPct: 2, upperPct: 2 } }
  const simple = await startSimpleStrategy(simpleDraft, 'wallet_integration')
  assert.ok(simple.job && simple.job.dryRun === false)
  assert.equal(store.strategyById(simpleDraft.id)?.state, 'planned')
  assert.equal(store.strategyById(simpleDraft.id)?.config.execution.dryRun, false)
  assert.equal(store.strategyById(simpleDraft.id)?.config.range.mode, 'symmetric')
  assert.equal(store.strategyById(simpleDraft.id)?.config.range.lowerPct, 2)
  assert.equal(store.strategyById(simpleDraft.id)?.config.range.upperPct, 2)
  assert.ok(BigInt(store.strategyById(simpleDraft.id)?.config.execution.maxGasPriceWei ?? '0') >= 100_000_000n)
  assert.ok(Number(store.strategyById(simpleDraft.id)?.config.execution.maxDailyTurnoverQuote) > 0)
  const simpleBaseline = store.strategyBaseline(simpleDraft.id)
  assert.ok(simpleBaseline)
  assert.equal(simpleBaseline?.source, 'strategy_start')
  assert.equal(simpleBaseline?.tokenId, '18')
  await runOnce()
  await waitForState(simpleDraft.id, 'monitoring')
  const simpleSummary = store.latestJobSummary(simpleDraft.id)!
  assert.equal(simpleSummary.state, 'completed')
  assert.equal(simpleSummary.dryRun, false)
  assert.ok(simpleSummary.transactionCount > 0)
  assert.ok(simpleSummary.result?.newTokenId)
  assert.deepEqual(store.strategyBaseline(simpleDraft.id), simpleBaseline)
  const simplePerformance = await strategyPerformance(store.strategyById(simpleDraft.id)!.config, 'monitoring')
  assert.notEqual(simplePerformance.summary.pnlQuoteRaw, null)
  assert.equal(simplePerformance.baseline?.kind, 'strategy_start')
  store.upsertStrategy({ ...store.strategyById(simpleDraft.id)!.config, enabled: false })

  const pausedBeforePlan = createStrategy('pause-before-plan', 13n)
  store.setExecutorPaused(true)
  const txCountBeforePause = transactions.size
  await monitorOnce({ ignoreSchedule: true })
  assert.equal(store.strategyById(pausedBeforePlan.id)?.state, 'monitoring')
  assert.equal(transactions.size, txCountBeforePause)
  store.setExecutorPaused(false)
  await monitorOnce({ ignoreSchedule: true })
  assert.equal(store.strategyById(pausedBeforePlan.id)?.state, 'planned')
  store.setExecutorPaused(true)
  await runOnce()
  assert.equal(store.strategyById(pausedBeforePlan.id)?.state, 'planned')
  assert.equal(transactions.size, txCountBeforePause)
  store.setExecutorPaused(false)
  await runOnce()
  await waitForState(pausedBeforePlan.id, 'monitoring')
  store.upsertStrategy({ ...store.strategyById(pausedBeforePlan.id)!.config, enabled: false })

  const pausedBetweenSteps = createStrategy('pause-between-steps', 14n)
  await monitorOnce({ ignoreSchedule: true })
  afterNextAcceptedTransaction = () => store.setExecutorPaused(true)
  const txCountBeforeStepPause = transactions.size
  await runOnce()
  await waitForState(pausedBetweenSteps.id, 'recovery')
  assert.equal(transactions.size, txCountBeforeStepPause + 1)
  const pausedRecovery = store.jobsForRecovery().find((row) => row.strategy_id === pausedBetweenSteps.id)!
  assert.equal((await inspectRecovery(pausedRecovery.id)).disposition, 'resume_collect')
  store.setExecutorPaused(false)
  await executeRecovery(pausedRecovery.id)
  await waitForState(pausedBetweenSteps.id, 'monitoring')
  store.upsertStrategy({ ...store.strategyById(pausedBetweenSteps.id)!.config, enabled: false })

  const dailyBase = createStrategy('daily-limit-before-sign', 15n)
  store.upsertStrategy({ ...dailyBase, execution: { ...dailyBase.execution, maxDailyTurnoverQuote: '0.000000000000000001' } })
  await monitorOnce({ ignoreSchedule: true })
  const txCountBeforeDailyLimit = transactions.size
  await runOnce()
  await waitForState(dailyBase.id, 'recovery')
  assert.equal(transactions.size, txCountBeforeDailyLimit)
  const dailyRecovery = store.jobsForRecovery().find((row) => row.strategy_id === dailyBase.id)!
  assert.equal((await inspectRecovery(dailyRecovery.id)).disposition, 'restart_safe')
  await executeRecovery(dailyRecovery.id)
  assert.equal(store.strategyById(dailyBase.id)?.state, 'monitoring')
  assert.ok(BigInt(store.strategyById(dailyBase.id)!.config.execution.maxDailyTurnoverQuote!.replace('.', '')) > 1n)
  store.upsertStrategy({ ...store.strategyById(dailyBase.id)!.config, enabled: false })

  const gasBase = createStrategy('gas-limit-before-sign', 16n)
  store.upsertStrategy({ ...gasBase, execution: { ...gasBase.execution, maxGasPriceWei: '1' } })
  gasPriceWei = 2n
  await monitorOnce({ ignoreSchedule: true })
  const txCountBeforeGasLimit = transactions.size
  await runOnce()
  await waitForState(gasBase.id, 'recovery')
  assert.equal(transactions.size, txCountBeforeGasLimit)
  gasPriceWei = 1n
  const gasRecovery = store.jobsForRecovery().find((row) => row.strategy_id === gasBase.id)!
  assert.equal((await inspectRecovery(gasRecovery.id)).disposition, 'restart_safe')
  store.abandonRecoveryJob(gasRecovery.id)
  store.upsertStrategy({ ...store.strategyById(gasBase.id)!.config, enabled: false })

  const dryBase = createStrategy('dry-run', 11n)
  const dry = { ...dryBase, execution: { ...dryBase.execution, dryRun: true } }
  store.upsertStrategy(dry)
  const txCountBeforeDry = transactions.size
  await monitorOnce({ ignoreSchedule: true })
  assert.equal(store.strategyById(dry.id)?.state, 'planned')
  await runOnce()
  await waitForState(dry.id, 'dry_run_ready')
  assert.equal(transactions.size, txCountBeforeDry)
  assert.equal(positions.get(11n)?.liquidity, 1_000n)
  await runScenario('collect-recovery', 2n, 'collect_before')
  await runScenario('swap-recovery', 3n, 'swap_before', 101, 'univ3', true)
  await runScenario('mint-recovery', 4n, 'mint_before')
  await runScenario('revoke-recovery', 5n, 'revoke_before')

  const usdgBeforeTax = balance(ADDR.USDG, owner)
  const taxConfig = await runScenario('fee-tax', 34n, undefined, 101, 'univ3', false, true, 2_000_000n)
  assert.equal(balance(ADDR.USDG, owner) - usdgBeforeTax, 200_000n)
  const taxLedger = store.db.prepare(`SELECT amount,meta_json FROM ledger_entries WHERE strategy_id=? AND kind='swap_out' AND lower(token)=? ORDER BY ts DESC LIMIT 1`).get(
    'strategy-integration-fee-tax', low(ADDR.USDG),
  ) as { amount: string; meta_json: string }
  assert.equal(taxLedger.amount, '200000')
  assert.equal(JSON.parse(taxLedger.meta_json).purpose, 'fee_tax')
  const taxPerformance = await strategyPerformance(taxConfig, 'monitoring')
  assert.equal(taxPerformance.error, undefined)
  assert.notEqual(taxPerformance.summary.currentValueQuoteRaw, null)
  assert.equal(taxPerformance.warnings.includes('live_valuation_unavailable'), false)

  const stopped = createStrategy('stop-and-delete', 21n)
  failOnce = 'approve_before'
  await monitorOnce({ ignoreSchedule: true })
  await runOnce()
  await waitForState(stopped.id, 'recovery')
  const stoppedJob = store.jobsForRecovery().find((row) => row.strategy_id === stopped.id)!
  assert.equal((await inspectRecovery(stoppedJob.id)).disposition, 'resume_from_wallet')
  const nonceBeforeStop = chainNonce
  const stoppedResult = await stopAndArchiveStrategy(stopped.id)
  assert.deepEqual(stoppedResult, { archived: true, chainTransactions: 0, assetLocation: 'wallet' })
  assert.equal(chainNonce, nonceBeforeStop)
  assert.equal(store.strategyById(stopped.id), undefined)
  assert.equal((store.db.prepare('SELECT state FROM strategies WHERE id=?').get(stopped.id) as { state: string }).state, 'archived')
  assert.equal((store.db.prepare('SELECT state FROM jobs WHERE id=?').get(stoppedJob.id) as { state: string }).state, 'cancelled')
  assert.equal(store.strategyAllocations(stopped.id)[low(token1)], 1_000n)

  const stoppedAfterSwap = createStrategy('stop-after-swap', 38n)
  failOnce = 'mint_before'
  await monitorOnce({ ignoreSchedule: true })
  await runOnce()
  await waitForState(stoppedAfterSwap.id, 'recovery')
  const stoppedAfterSwapJob = store.jobsForRecovery().find((row) => row.strategy_id === stoppedAfterSwap.id)!
  assert.equal((await inspectRecovery(stoppedAfterSwapJob.id)).disposition, 'resume_from_wallet')
  const nonceBeforeInterruptedStop = chainNonce
  assert.deepEqual(await stopAndArchiveStrategy(stoppedAfterSwap.id), {
    archived: true, chainTransactions: 0, assetLocation: 'recovery_interrupted',
  })
  assert.equal(chainNonce, nonceBeforeInterruptedStop)
  assert.equal(store.strategyById(stoppedAfterSwap.id), undefined)

  const wrongRolesBase = createStrategy('wrong-weth-roles-recovery', 20n)
  const wrongRoles = { ...wrongRolesBase, riskToken: token1, quoteToken: token0 }
  store.upsertStrategy(wrongRoles)
  failOnce = 'approve_before'
  await monitorOnce({ ignoreSchedule: true })
  await runOnce()
  await waitForState(wrongRoles.id, 'recovery')
  const wrongRolesJob = store.jobsForRecovery().find((row) => row.strategy_id === wrongRoles.id)!
  assert.equal((await inspectRecovery(wrongRolesJob.id)).disposition, 'resume_from_wallet')
  await executeRecovery(wrongRolesJob.id)
  await waitForState(wrongRoles.id, 'monitoring')
  assert.equal(low(store.strategyById(wrongRoles.id)!.config.quoteToken), low(token1))
  assert.equal(low(store.strategyById(wrongRoles.id)!.config.riskToken), low(token0))
  store.upsertStrategy({ ...store.strategyById(wrongRoles.id)!.config, enabled: false })

  const holdBase = createStrategy('hold-quote', 8n)
  const hold = {
    ...holdBase,
    boundary: { ...holdBase.boundary, upper: { ...holdBase.boundary.upper, action: 'hold_quote' as const } },
  }
  store.upsertStrategy(hold)
  await monitorOnce({ ignoreSchedule: true })
  assert.equal(store.strategyById(hold.id)?.state, 'planned')
  await runOnce()
  await waitForState(hold.id, 'paused_hold_quote')
  const holdJob = store.db.prepare(`SELECT id FROM jobs WHERE strategy_id=? AND state='completed' ORDER BY created_at DESC LIMIT 1`).get(hold.id) as { id: string }
  assert.equal(store.jobSteps(holdJob.id).filter((step) => step.state === 'confirmed').length, 12)
  assert.equal(store.strategyById(hold.id)?.config.activeTokenId, null)
  assert.equal(store.strategyById(hold.id)?.config.enabled, false)
  assert.equal(store.strategyAllocations(hold.id)[low(token0)], 0n)
  assert.equal(allowance(token0, owner, router), 0n)

  const holdTaxBase = createStrategy('hold-quote-income-tax', 37n)
  positions.get(37n)!.owed0 = 2_000_000n
  const holdTax = {
    ...holdTaxBase,
    boundary: { ...holdTaxBase.boundary, upper: { ...holdTaxBase.boundary.upper, action: 'hold_quote' as const } },
  }
  const usdgBeforeHoldTax = balance(ADDR.USDG, owner)
  store.upsertStrategy(holdTax)
  await monitorOnce({ ignoreSchedule: true })
  await runOnce()
  await waitForState(holdTax.id, 'paused_hold_quote')
  assert.equal(balance(ADDR.USDG, owner) - usdgBeforeHoldTax, 200_000n)
  assert.equal((store.db.prepare(`SELECT COUNT(*) AS n FROM ledger_entries WHERE strategy_id=? AND kind='swap_in' AND json_extract(meta_json,'$.purpose')='fee_tax'`).get(holdTax.id) as { n: number }).n, 1)

  const holdRecoveryBase = createStrategy('hold-quote-recovery', 9n)
  const holdRecovery = {
    ...holdRecoveryBase,
    riskToken: token1,
    quoteToken: token0,
    boundary: { ...holdRecoveryBase.boundary, upper: { ...holdRecoveryBase.boundary.upper, action: 'hold_quote' as const } },
  }
  store.upsertStrategy(holdRecovery)
  failOnce = 'swap_before'
  await monitorOnce({ ignoreSchedule: true })
  await runOnce()
  await waitForState(holdRecovery.id, 'recovery')
  const holdRecoveryJob = store.jobsForRecovery().find((row) => row.strategy_id === holdRecovery.id)!
  assert.equal((await inspectRecovery(holdRecoveryJob.id)).disposition, 'resume_from_wallet')
  await executeRecovery(holdRecoveryJob.id)
  await waitForState(holdRecovery.id, 'paused_hold_quote')
  assert.equal(store.strategyAllocations(holdRecovery.id)[low(token1)], 0n)
  assert.equal(allowance(token1, owner, router), 0n)

  const feeBase = createStrategy('fee-interval', 10n)
  const feePosition = positions.get(10n)!
  feePosition.tickLower = 0
  feePosition.tickUpper = 200
  feePosition.owed0 = 500n
  const feeConfig = { ...feeBase, updatedAt: now - 120, fees: { handling: 'convert_to_quote' as const, timing: 'interval' as const, intervalMinutes: 1 } }
  store.upsertStrategy(feeConfig)
  await monitorOnce({ ignoreSchedule: true })
  assert.equal(store.strategyById(feeConfig.id)?.state, 'planned')
  const feePlanned = store.db.prepare(`SELECT plan_json FROM jobs WHERE strategy_id=? AND state='planned'`).get(feeConfig.id) as { plan_json: string }
  assert.equal(JSON.parse(feePlanned.plan_json).action, 'collect_fees')
  await runOnce()
  await waitForState(feeConfig.id, 'monitoring')
  const feeCompleted = store.db.prepare(`SELECT id FROM jobs WHERE strategy_id=? AND state='completed'`).get(feeConfig.id) as { id: string }
  assert.equal(store.jobSteps(feeCompleted.id).filter((step) => step.state === 'confirmed').length, 12)
  assert.equal(store.strategyById(feeConfig.id)?.config.activeTokenId, '10')
  assert.equal(positions.get(10n)?.liquidity, 1_000n)
  assert.equal(store.strategyAllocations(feeConfig.id)[low(token0)], 0n)
  const feeComponents = store.strategyAllocationComponents(feeConfig.id)
  assert.equal(feeComponents[low(token0)].principal, 0n)
  assert.equal(feeComponents[low(token0)].heldFee, 0n)
  assert.equal(feeComponents[low(token1)].principal, 0n)
  assert.equal(feeComponents[low(token1)].heldFee, 500n)
  assert.ok((store.db.prepare(`SELECT COUNT(*) AS n FROM ledger_entries WHERE strategy_id=? AND kind='fee_gross'`).get(feeConfig.id) as { n: number }).n > 0)
  assert.equal(allowance(token0, owner, router), 0n)

  const restart = createStrategy('restart-safe', 6n)
  failOnce = 'decrease_before'
  await monitorOnce({ ignoreSchedule: true })
  await runOnce()
  await waitForState(restart.id, 'recovery')
  const restartJob = store.jobsForRecovery().find((row) => row.strategy_id === restart.id)!
  // Reconcile the rejected durable hash before another strategy may reuse the
  // wallet nonce. An uncertain sending/sent row is the only wallet-wide gate.
  assert.equal((await inspectRecovery(restartJob.id, { reconcile: true })).disposition, 'restart_safe')
  await runScenario('known-nonce-replacement', 20n)
  assert.equal((await inspectRecovery(restartJob.id)).disposition, 'restart_safe')
  await executeRecovery(restartJob.id)
  assert.equal(store.strategyById(restart.id)?.state, 'monitoring')
  assert.equal(positions.get(6n)?.liquidity, 1_000n)
  // Keep this deliberately out-of-range restart fixture from immediately
  // enqueueing again and occupying the shared-wallet serial slot below.
  store.setStrategyState(restart.id, 'paused_test_fixture')

  // A provider can accept a raw transaction and lose the HTTP response. The
  // executor now persists the locally-derived hash before broadcast, finds the
  // accepted transaction by that hash, and continues without manual review.
  const ambiguous = createStrategy('lost-broadcast-response', 7n)
  failOnce = 'collect_after'
  await monitorOnce({ ignoreSchedule: true })
  await runOnce()
  await waitForState(ambiguous.id, 'monitoring')
  assert.ok(store.latestJobSummary(ambiguous.id)?.transactionCount)
  kyberUnavailable = true
  await runScenario('univ3-native-fallback', 32n, undefined, 101, 'univ3')
  await runScenario('up33-native-fallback', 17n, undefined, 101, 'up33')

  // A normal monitor pass reads all due positions and pool prices through one
  // Multicall3 eth_call while retaining a separate result per strategy.
  poolTick = 0
  const bulkA = createStrategy('bulk-monitor-a', 23n)
  const bulkB = createStrategy('bulk-monitor-b', 24n)
  const firstBulk = await readMonitorSnapshots([bulkA, bulkB], blockNumber)
  assert.equal((firstBulk.get(bulkA.id) as any)?.tick, 0)
  assert.equal((firstBulk.get(bulkB.id) as any)?.tick, 0)
  poolTick = 101
  const ethCallsBeforeBulk = rpcMethodCounts.get('eth_call') ?? 0
  const secondBulk = await readMonitorSnapshots([bulkA, bulkB], blockNumber)
  assert.equal((secondBulk.get(bulkA.id) as any)?.tick, 101)
  assert.equal((secondBulk.get(bulkB.id) as any)?.tick, 101)
  assert.equal((rpcMethodCounts.get('eth_call') ?? 0) - ethCallsBeforeBulk, 1)
  console.log('executor integration smoke: ok')
} finally {
  rpcServer.close()
  kyberServer.close()
  rmSync(dataDir, { recursive: true, force: true })
}
