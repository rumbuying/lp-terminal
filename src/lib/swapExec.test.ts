// The execution path for every MARKET and ZAP swap: what it refuses to sign,
// and what it sends when it does sign. Everything below the module boundary is
// mocked, so each test states one invariant about the submission decision.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { Address, Hex, TransactionReceipt } from 'viem'

const SENDER = '0x0000000000000000000000000000000000000001' as Address
const OTHER = '0x0000000000000000000000000000000000000002' as Address
const TOKEN_IN = '0x0000000000000000000000000000000000000011' as Address
const TOKEN_OUT = '0x0000000000000000000000000000000000000022' as Address
const ROUTER = '0x0000000000000000000000000000000000000033' as Address
const SPENDER = '0x0000000000000000000000000000000000000044' as Address
const OTHER_SPENDER = '0x0000000000000000000000000000000000000045' as Address
const SETTLER = '0x0000000000000000000000000000000000000055' as Address
const FEE_RECEIVER = '0x00000000000000000000000000000000000000fe' as Address
const HASH = ('0x' + '11'.repeat(32)) as Hex
const GAS = 250_000n

type Prepared = {
  to: Address
  data: Hex
  value: bigint
  spender: Address | null
  inputToken: Address | null
  outputToken: Address | null
  permit2Operator: Address | null
}

type SolverQuote = {
  amountOutNet: bigint
  minAmountOutNet: bigint
  allowanceTarget: Address | null
  tx: { requiredFrom?: Address; to: Address; value: bigint; data: Hex } | null
}

const basePrepared: Prepared = {
  to: ROUTER,
  data: '0xdeadbeef',
  value: 0n,
  spender: SPENDER,
  inputToken: TOKEN_IN,
  outputToken: TOKEN_OUT,
  permit2Operator: null,
}

const baseQuote: SolverQuote = {
  amountOutNet: 1_000n,
  minAmountOutNet: 990n,
  allowanceTarget: SPENDER,
  tx: { to: SETTLER, value: 0n, data: '0xfeed' },
}

// --- knobs each test sets, all reset by begin() ---
let activeAccount: Address = SENDER
let allowance: 'sufficient' | 'approved' | null = 'sufficient'
let permit2Allowance: 'sufficient' | 'approved' | null = 'sufficient'
let directAmountOut: (call: number) => bigint = () => 1_000n
let preparedAt: (call: number) => Prepared = () => basePrepared
let quoteAt: (call: number) => SolverQuote = () => baseQuote
let delivered = 1_000n

// --- what the run did ---
let prepareCalls = 0
let solverCalls = 0
let steps: string[] = []
let sent: Record<string, unknown>[] = []
let preflighted: unknown[] = []
let submitted: Hex[] = []
let stepError: unknown = null

function begin() {
  activeAccount = SENDER
  allowance = 'sufficient'
  permit2Allowance = 'sufficient'
  directAmountOut = () => 1_000n
  preparedAt = () => basePrepared
  quoteAt = () => baseQuote
  delivered = 1_000n
  prepareCalls = 0
  solverCalls = 0
  steps = []
  sent = []
  preflighted = []
  submitted = []
  stepError = null
}

mock.module('../config/addresses', { namedExports: { CHAIN_ID: 56 } })
mock.module('../config/env', {
  namedExports: { swapFee: () => ({ bps: 30, receiver: FEE_RECEIVER }) },
})
mock.module('../config/wagmi', { namedExports: { wagmiConfig: {} } })
mock.module('../i18n', { namedExports: { t: (key: string) => key } })
mock.module('./homeClient', { namedExports: { homeClient: () => ({}) } })
mock.module('wagmi/actions', {
  namedExports: {
    sendTransaction: async (_config: unknown, request: Record<string, unknown>) => {
      sent.push(request)
      return HASH
    },
  },
})
mock.module('./directSwap', {
  namedExports: {
    erc20Of: (token: Address) => token,
    isNative: (token: Address) => token === TOKEN_OUT && basePrepared.outputToken === null,
    quoteDirectRoute: async () => {
      prepareCalls += 1
      return { amountOut: directAmountOut(prepareCalls) }
    },
    buildDirectTransaction: () => preparedAt(prepareCalls),
  },
})
mock.module('./solver', {
  namedExports: {
    fetchSolverQuote: async () => {
      solverCalls += 1
      return quoteAt(solverCalls)
    },
  },
})
mock.module('./solverPreflight', {
  namedExports: {
    preflightSolverTransaction: async (_client: unknown, _account: Address, tx: unknown) => {
      preflighted.push(tx)
      return GAS
    },
  },
})
mock.module('./tx', {
  namedExports: {
    accountChangedMessage: () => 'account changed',
    activeAccountMatches: (expected: Address) =>
      expected.toLowerCase() === activeAccount.toLowerCase(),
    deadline: () => 0n,
    ensureAllowance: async () => allowance,
    ensurePermit2Allowance: async () => permit2Allowance,
    receivedOf: () => delivered,
    // faithful to the real step: the send closure runs inside it, and a throw
    // there becomes a null return rather than escaping to the caller
    step: async (
      label: string,
      send: () => Promise<Hex>,
      opts?: { onSubmitted?: (hash: Hex) => void },
    ) => {
      steps.push(label)
      try {
        const hash = await send()
        submitted.push(hash)
        opts?.onSubmitted?.(hash)
        return { transactionHash: hash, status: 'success' } as unknown as TransactionReceipt
      } catch (error) {
        stepError = error
        return null
      }
    },
  },
})

const { executeSwap, executeSolverSwap, SlippageError } = await import('./swapExec')

const directIntent = {
  route: { protocol: 'uniswap', kind: 'v2', feePpm: 3_000 } as never,
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountIn: 100n,
  minimumAmountOut: 990n,
  sender: SENDER,
  recipient: SENDER,
  inputSymbol: 'IN',
  label: 'swap',
}

const solverIntent = {
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountIn: 100n,
  slippageBps: 100,
  minimumAmountOut: 990n,
  sender: SENDER,
  recipient: SENDER,
  inputSymbol: 'IN',
  label: 'swap',
}

test('the direct swap signs the calldata it prepared, for the account it pinned', async () => {
  begin()
  const result = await executeSwap(directIntent)

  assert.equal(steps.length, 1)
  assert.deepEqual(sent, [
    { account: SENDER, to: ROUTER, data: '0xdeadbeef', value: 0n, chainId: 56 },
  ])
  assert.equal(result?.output.kind, 'erc20')
})

test('a wallet account switched before the prompt stops the direct swap', async () => {
  begin()
  activeAccount = OTHER

  await assert.rejects(executeSwap(directIntent), /account changed/)
  assert.equal(prepareCalls, 0, 'the quote is not even fetched for an account that left')
  assert.deepEqual(sent, [])
})

test('an account switched while the approval was signed stops the direct swap', async () => {
  begin()
  allowance = 'approved'
  // the approval prompt is exactly the window a wallet can switch accounts in
  preparedAt = (call) => {
    if (call === 1) activeAccount = OTHER
    return basePrepared
  }

  await assert.rejects(executeSwap(directIntent), /account changed/)
  assert.deepEqual(steps, [], 'the trade is never offered to the wallet')
  assert.deepEqual(sent, [])
})

test('an account switched after the allowance checks stops the direct swap', async () => {
  begin()
  // everything passes; the switch lands in the gap before the trade is signed
  preparedAt = () => {
    activeAccount = OTHER
    return basePrepared
  }

  await assert.rejects(executeSwap(directIntent), /account changed/)
  assert.deepEqual(sent, [])
})

test('a direct re-quote below the caller minimum halts before the wallet is asked', async () => {
  begin()
  directAmountOut = () => 900n

  await assert.rejects(executeSwap(directIntent), SlippageError)
  assert.deepEqual(steps, [])
  assert.deepEqual(sent, [])
})

test('an allowance target that moved after approval stops the direct swap', async () => {
  begin()
  allowance = 'approved'
  preparedAt = (call) => (call === 1 ? basePrepared : { ...basePrepared, spender: OTHER_SPENDER })

  await assert.rejects(executeSwap(directIntent), /allowance target changed/)
  assert.deepEqual(sent, [], 'the approval the user signed does not cover this spender')
})

test('a direct swap that delivered less than the minimum is reported, not accepted', async () => {
  begin()
  delivered = 500n

  await assert.rejects(executeSwap(directIntent), /receivedBelowMinimum/)
  assert.deepEqual(submitted, [HASH], 'the transaction did confirm — the delivery is what failed')
})

test('the solver transaction is sent exactly as quoted, with the preflight gas', async () => {
  begin()
  const result = await executeSolverSwap(solverIntent)

  assert.equal(preflighted.length, 1)
  assert.deepEqual(sent, [
    { account: SENDER, to: SETTLER, data: '0xfeed', value: 0n, gas: GAS, chainId: 56 },
  ])
  assert.equal(result?.output.kind, 'erc20')
})

test('a wallet account switched before the prompt stops the solver swap', async () => {
  begin()
  activeAccount = OTHER

  await assert.rejects(executeSolverSwap(solverIntent), /account changed/)
  assert.equal(solverCalls, 0, 'no quote is priced for an account that left')
  assert.deepEqual(sent, [])
})

test('an account switched while the solver approval was signed stops the swap', async () => {
  begin()
  allowance = 'approved'
  quoteAt = (call) => {
    if (call === 1) activeAccount = OTHER
    return baseQuote
  }

  await assert.rejects(executeSolverSwap(solverIntent), /account changed/)
  assert.equal(solverCalls, 1, 'the re-quote is never asked for')
  assert.deepEqual(sent, [])
})

test('a solver re-quote below the caller minimum halts after the approval', async () => {
  begin()
  allowance = 'approved'
  quoteAt = (call) => (call === 1 ? baseQuote : { ...baseQuote, amountOutNet: 900n })

  await assert.rejects(executeSolverSwap(solverIntent), SlippageError)
  assert.deepEqual(steps, [])
  assert.deepEqual(sent, [])
})

test('a solver allowance target that moved after approval stops the swap', async () => {
  begin()
  allowance = 'approved'
  quoteAt = (call) => (call === 1 ? baseQuote : { ...baseQuote, allowanceTarget: OTHER_SPENDER })

  await assert.rejects(executeSolverSwap(solverIntent), /allowance target changed/)
  assert.deepEqual(sent, [])
})

test('a solver transaction bound to another account is refused', async () => {
  begin()
  quoteAt = () => ({ ...baseQuote, tx: { ...baseQuote.tx!, requiredFrom: OTHER } })

  await assert.rejects(executeSolverSwap(solverIntent), /bound to a different submitting account/)
  assert.deepEqual(steps, [])
  assert.deepEqual(sent, [])
})

test('a solver quote with no transaction is refused', async () => {
  begin()
  quoteAt = () => ({ ...baseQuote, tx: null })

  await assert.rejects(executeSolverSwap(solverIntent), /carried no transaction/)
  assert.deepEqual(sent, [])
})

test('a solver swap that delivered less than the quoted floor is reported', async () => {
  begin()
  delivered = 500n

  await assert.rejects(executeSolverSwap(solverIntent), /receivedBelowMinimum/)
  assert.deepEqual(submitted, [HASH])
})
