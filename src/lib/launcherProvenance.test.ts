import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, Hex } from 'viem'
import { create2Deployed, provesLauncher } from './launcherProvenance'

const DEPLOYER = '0x32f4B2e69EbD7746596AF8699DAC1908F43107aD' as Address
const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Address
const V2_VANITY = '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0' as Address
/** the stranger's launcher — real, live, and minting when this was written */
const IMPOSTOR_DEPLOYER = '0x5638180327bD949eC0D27BB7EE5ff15A63D4824C' as Address

// Real calldata is a 32-byte salt followed by an initcode of a few thousand
// bytes. The derivation cares about neither length nor content, so the fixtures
// are short: what they pin is that the SPLIT is at 32 bytes and that each of
// the three inputs changes the answer.
const salt = (n: string) => n.repeat(64).slice(0, 64)
const call = (saltHex: string, initcode: string) => `0x${saltHex}${initcode}` as Hex

test('the deployed address is derived from the call, not read off it', () => {
  const a = create2Deployed(CREATE2, call(salt('a'), '60016000f3'))
  const b = create2Deployed(CREATE2, call(salt('b'), '60016000f3'))
  assert.match(a ?? '', /^0x[0-9a-fA-F]{40}$/)
  assert.notEqual(a, b) // the salt moves it
  assert.notEqual(a, create2Deployed(CREATE2, call(salt('a'), '60026000f3'))) // so does the code
})

test('a call with no room for both a salt and code deploys nothing', () => {
  assert.equal(create2Deployed(CREATE2, '0x'), null)
  assert.equal(create2Deployed(CREATE2, `0x${salt('a')}` as Hex), null) // salt, no code
  assert.equal(create2Deployed(CREATE2, `0x${'a'.repeat(63)}` as Hex), null) // half a byte
})

// The three rejections mean different things and the message has to say which:
// a wrong sender is somebody else's contract, a wrong target is a path this
// proof does not cover, and a wrong derivation means the transaction and the
// entry beside it are simply unrelated.
test('a launcher somebody else deployed is refused, by sender', () => {
  const result = provesLauncher({
    address: V2_VANITY,
    tx: { from: IMPOSTOR_DEPLOYER, to: CREATE2, input: call(salt('a'), '60016000f3') },
    deployer: DEPLOYER,
    create2Factory: CREATE2,
  })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /not the launchpad's deployer/)
})

test('a deployment through some other path is refused, by target', () => {
  const result = provesLauncher({
    address: V2_VANITY,
    tx: { from: DEPLOYER, to: null, input: call(salt('a'), '60016000f3') },
    deployer: DEPLOYER,
    create2Factory: CREATE2,
  })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /not the CREATE2 factory/)
})

// The load-bearing one. Sender and target both correct, and the entry still
// fails — because this transaction deploys somewhere else. A copy-paste that
// pairs a real launcher address with a real deployment of a DIFFERENT contract
// is the mistake most likely to be made, and looks entirely fine until here.
test('the right deployer deploying the wrong address proves nothing', () => {
  const result = provesLauncher({
    address: V2_VANITY,
    tx: { from: DEPLOYER, to: CREATE2, input: call(salt('a'), '60016000f3') },
    deployer: DEPLOYER,
    create2Factory: CREATE2,
  })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /^deploys 0x[0-9a-fA-F]{40}, not this address$/)
})

test('a proof accepts exactly the address its own calldata deploys', () => {
  const input = call(salt('c'), '60016000f3')
  const address = create2Deployed(CREATE2, input)!
  const result = provesLauncher({
    address,
    tx: { from: DEPLOYER, to: CREATE2, input },
    deployer: DEPLOYER,
    create2Factory: CREATE2,
  })
  assert.equal(result.ok, true)
  assert.equal(result.ok === true ? result.address.toLowerCase() : '', address.toLowerCase())
})

test('casing is not part of any of the three comparisons', () => {
  const input = call(salt('d'), '60016000f3')
  const address = create2Deployed(CREATE2, input)!
  const result = provesLauncher({
    address: address.toLowerCase() as Address,
    tx: { from: DEPLOYER.toLowerCase(), to: CREATE2.toLowerCase(), input },
    deployer: DEPLOYER,
    create2Factory: CREATE2,
  })
  assert.equal(result.ok, true)
})
