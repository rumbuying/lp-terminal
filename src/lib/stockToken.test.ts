import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address, Hex, PublicClient } from 'viem'
import {
  ERC1967_ADMIN_SLOT,
  ERC1967_BEACON_SLOT,
  type StockIssuerAnchor,
} from '../config/chains/stockIssuers'
import {
  addressInSlot,
  matchStockIssuer,
  probeStockToken,
  readStockIssuer,
  slotsToRead,
} from './stockToken'

// Every constant below was read off a live node on 2026-08-04, impostors
// included — these are the actual contracts, not invented fixtures.
const BSTOCK_BEACON = '0x156D6dce9a4f6139a3406F1f021F1A4880De93a3'
const BSTOCK_CODEHASH = '0xdf946913977a2ed76735b4b2e66f2272d1a76af911c4e520655888c9e32269f9' as Hex
const ONDO_BEACON = '0xc046b05A920e4B412815934DD8E58904dDA73315'
const ONDO_CODEHASH = '0x439923c85f956f038ae77871736f789e6d08d22257b6e5fdccfdc83924ecb4d0' as Hex
const BACKED_ADMIN = '0x696C685a02A1Fc6E2AaCbe26CD6695F4f4a6a085'
const BACKED_CODEHASH = '0xe7cbfea5a664672738dd729f7774677b0fa82dbdda74320df20eec49d2211b4c' as Hex

const ANCHORS: StockIssuerAnchor[] = [
  {
    issuer: 'bstock',
    slot: ERC1967_BEACON_SLOT,
    anchor: BSTOCK_BEACON as Address,
    proxyCodehash: BSTOCK_CODEHASH,
    witness: { symbol: 'NVDAB', address: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436' as Address },
  },
  {
    issuer: 'ondo',
    slot: ERC1967_BEACON_SLOT,
    anchor: ONDO_BEACON as Address,
    proxyCodehash: ONDO_CODEHASH,
    witness: { symbol: 'NVDAon', address: '0xA9eE28C80f960B889dFbd1902055218cBa016F75' as Address },
  },
  {
    issuer: 'backed',
    slot: ERC1967_ADMIN_SLOT,
    anchor: BACKED_ADMIN as Address,
    proxyCodehash: BACKED_CODEHASH,
    witness: { symbol: 'TSLAx', address: '0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0' as Address },
  },
]

/** a 32-byte storage word holding an address, the way the EVM left-pads one */
const word = (addr: string): Hex => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}` as Hex
const beaconSlots = (addr: string) => ({ [ERC1967_BEACON_SLOT.toLowerCase()]: word(addr) })

test('an address slot is read out of the low 20 bytes of the word', () => {
  assert.equal(addressInSlot(word(BSTOCK_BEACON)), BSTOCK_BEACON.toLowerCase())
  assert.equal(addressInSlot(`0x${'0'.repeat(64)}` as Hex), null, 'an empty slot names nobody')
  assert.equal(addressInSlot(null), null)
  assert.equal(addressInSlot('0xdeadbeef' as Hex), null, 'a short word is not an address')
})

test('a genuine bStock is proved by its codehash and its beacon together', () => {
  assert.equal(
    matchStockIssuer(ANCHORS, { codehash: BSTOCK_CODEHASH, slots: beaconSlots(BSTOCK_BEACON) }),
    'bstock',
  )
})

test('issuers sharing a slot are told apart by codehash', () => {
  // Ondo and Binance both anchor on the beacon slot; only the codehash
  // separates one issuer's proxy from the other's.
  assert.equal(
    matchStockIssuer(ANCHORS, { codehash: ONDO_CODEHASH, slots: beaconSlots(ONDO_BEACON) }),
    'ondo',
  )
})

test('Backed is anchored on its proxy admin rather than a beacon', () => {
  assert.equal(
    matchStockIssuer(ANCHORS, {
      codehash: BACKED_CODEHASH,
      slots: { [ERC1967_ADMIN_SLOT.toLowerCase()]: word(BACKED_ADMIN) },
    }),
    'backed',
  )
})

test("the issuer's own proxy pointed at someone else's beacon proves nothing", () => {
  // Ondo ships stock OpenZeppelin BeaconProxy, so anyone can deploy bytecode
  // with this exact codehash. What they cannot do is make it delegate to Ondo.
  assert.equal(
    matchStockIssuer(ANCHORS, {
      codehash: ONDO_CODEHASH,
      slots: beaconSlots('0x00000000000000000000000000000000deadbeef'),
    }),
    null,
  )
})

test("the issuer's beacon in a contract running its own code proves nothing", () => {
  // The mirror image: storage is writable by whatever code the contract runs,
  // so an impostor can seed the real beacon and still behave however it likes.
  assert.equal(
    matchStockIssuer(ANCHORS, {
      codehash: '0x18449a1624d9c5270bd1526d891e72a37319e8a08eb3fe687b5ad707e1c487bc' as Hex,
      slots: beaconSlots(BSTOCK_BEACON),
    }),
    null,
  )
})

test('the live impersonators on BSC match nothing', () => {
  // "NVIDIA Tokenized bStocks" (0x01d6c860…), "NVIDIA Tokenized Stock (Ondo)"
  // (0x021333de…) and the fake AAPLx (0x0138c7af…) as measured — the first two
  // have no proxy slot at all, the third is a proxy administered by its own.
  const impostors: { codehash: Hex; slots: Record<string, Hex | null> }[] = [
    {
      codehash: '0x18449a1624d9c5270bd1526d891e72a37319e8a08eb3fe687b5ad707e1c487bc' as Hex,
      slots: { [ERC1967_BEACON_SLOT.toLowerCase()]: `0x${'0'.repeat(64)}` as Hex },
    },
    {
      codehash: '0xf9fdb482efb4683dd2f97770bb92f93e1916a9734251c3449b0304d768d660ca' as Hex,
      slots: { [ERC1967_BEACON_SLOT.toLowerCase()]: `0x${'0'.repeat(64)}` as Hex },
    },
    {
      codehash: '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6' as Hex,
      slots: {
        [ERC1967_ADMIN_SLOT.toLowerCase()]: word('0xfb858ceb0f432179c8c2aee559fff4649da4c9a6'),
      },
    },
  ]
  for (const probe of impostors) assert.equal(matchStockIssuer(ANCHORS, probe), null)
})

test('an unreadable probe leaves a token unmarked rather than trusted', () => {
  assert.equal(matchStockIssuer(ANCHORS, { codehash: null, slots: beaconSlots(BSTOCK_BEACON) }), null)
  assert.equal(
    matchStockIssuer(ANCHORS, {
      codehash: BSTOCK_CODEHASH,
      slots: { [ERC1967_BEACON_SLOT.toLowerCase()]: null },
    }),
    null,
    'a failed slot read must not be taken as agreement',
  )
})

test('a chain with no issuers matches nothing and asks the chain nothing', async () => {
  let calls = 0
  const client = {
    getCode: async () => {
      calls++
      return '0x60' as Hex
    },
    getStorageAt: async () => {
      calls++
      return null
    },
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  assert.equal(
    await readStockIssuer(client, '0x1111111111111111111111111111111111111111' as Address, []),
    null,
  )
  assert.equal(calls, 0, 'no anchors to match means no RPC worth spending')
})

test('an ordinary token is rejected on its slots alone, without shipping its code', async () => {
  // The affordability claim, asserted: this is the shape of nearly every row in
  // a pools table, and it must cost the cheap read and nothing else.
  let codeReads = 0
  const client = {
    getCode: async () => {
      codeReads++
      return '0x6080' as Hex
    },
    getStorageAt: async () => `0x${'0'.repeat(64)}` as Hex,
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  assert.equal(
    await readStockIssuer(client, '0x5555555555555555555555555555555555555555' as Address, ANCHORS),
    null,
  )
  assert.equal(codeReads, 0)
})

test('a contract already pointed at an anchor is confirmed against its bytecode', async () => {
  // A real bStock: the beacon read makes it a candidate, and the code read is
  // what actually settles it.
  const bstockProxy =
    '0x6080604052600a600c565b005b60186014601a565b609d565b565b5f7f000000000000000000000000156d6dce9a4f6139a3406f1f021f1a4880de93a36001600160a01b0316635c60da1b6040518163ffffffff1660e01b8152600401602060405180830381865afa1580156076573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906098919060ba565b905090565b365f80375f80365f845af43d5f803e80801560b6573d5ff35b3d5ffd5b5f6020828403121560c9575f80fd5b81516001600160a01b038116811460de575f80fd5b939250505056fea2646970667358221220255da89e8497bca4e4da0f4979d55893884dbaf62103ce58efbe6ff2ffee247764736f6c63430008180033' as Hex

  const client = {
    getCode: async () => bstockProxy,
    getStorageAt: async ({ slot }: { slot: Hex }) =>
      slot === ERC1967_BEACON_SLOT.toLowerCase()
        ? word(BSTOCK_BEACON)
        : (`0x${'0'.repeat(64)}` as Hex),
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  assert.equal(
    await readStockIssuer(client, '0x6666666666666666666666666666666666666666' as Address, ANCHORS),
    'bstock',
  )
})

test('a failed slot read rejects instead of reporting "no issuer"', async () => {
  // The caller caches with no expiry, so resolving null here would freeze a
  // genuine share as unmarked for the rest of the session on one dropped
  // packet. Rejecting is what lets the query retry.
  const client = {
    getCode: async () => '0x6080' as Hex,
    getStorageAt: async () => {
      throw new Error('rpc down')
    },
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  await assert.rejects(
    readStockIssuer(client, '0x8888888888888888888888888888888888888888' as Address, ANCHORS),
    /anchor slot read failed/,
  )
})

test('a slot that answered wins over one that errored', async () => {
  // BSC reads two slots and a token is anchored on exactly one of them, so the
  // admin slot being unreachable must not discard a confirmed beacon match.
  const bstockProxy =
    '0x6080604052600a600c565b005b60186014601a565b609d565b565b5f7f000000000000000000000000156d6dce9a4f6139a3406f1f021f1a4880de93a36001600160a01b0316635c60da1b6040518163ffffffff1660e01b8152600401602060405180830381865afa1580156076573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906098919060ba565b905090565b365f80375f80365f845af43d5f803e80801560b6573d5ff35b3d5ffd5b5f6020828403121560c9575f80fd5b81516001600160a01b038116811460de575f80fd5b939250505056fea2646970667358221220255da89e8497bca4e4da0f4979d55893884dbaf62103ce58efbe6ff2ffee247764736f6c63430008180033' as Hex
  const client = {
    getCode: async () => bstockProxy,
    getStorageAt: async ({ slot }: { slot: Hex }) => {
      if (slot === ERC1967_ADMIN_SLOT.toLowerCase()) throw new Error('rpc down')
      return word(BSTOCK_BEACON)
    },
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  assert.equal(
    await readStockIssuer(client, '0x9999999999999999999999999999999999999999' as Address, ANCHORS),
    'bstock',
  )
})

test('a failed code read on an anchored address rejects rather than dropping it', async () => {
  // This address is already pointed at a real beacon, so it is very likely
  // genuine — the one place where giving up quietly is most expensive.
  const client = {
    getCode: async () => {
      throw new Error('rpc down')
    },
    getStorageAt: async ({ slot }: { slot: Hex }) =>
      slot === ERC1967_BEACON_SLOT.toLowerCase()
        ? word(BSTOCK_BEACON)
        : (`0x${'0'.repeat(64)}` as Hex),
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  await assert.rejects(
    readStockIssuer(client, '0xaaaa111111111111111111111111111111111111' as Address, ANCHORS),
    /rpc down/,
  )
})

test('a token that simply is not an equity resolves null, and stays cacheable', async () => {
  // The contrast with the three above: reads SUCCEEDED and matched nobody.
  // Only this is a durable answer.
  const client = {
    getCode: async () => '0x6080' as Hex,
    getStorageAt: async () => `0x${'0'.repeat(64)}` as Hex,
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  assert.equal(
    await readStockIssuer(client, '0xbbbb111111111111111111111111111111111111' as Address, ANCHORS),
    null,
  )
})

test('an impostor holding the real beacon is still refused once its code is read', async () => {
  const client = {
    getCode: async () => '0xdeadbeef' as Hex, // anything but the issuer's proxy
    getStorageAt: async ({ slot }: { slot: Hex }) =>
      slot === ERC1967_BEACON_SLOT.toLowerCase()
        ? word(BSTOCK_BEACON)
        : (`0x${'0'.repeat(64)}` as Hex),
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  assert.equal(
    await readStockIssuer(client, '0x7777777777777777777777777777777777777777' as Address, ANCHORS),
    null,
  )
})

test('each distinct slot is read exactly once however many issuers share it', () => {
  // Three issuers, two slots — the beacon read is shared by Binance and Ondo.
  assert.deepEqual(slotsToRead(ANCHORS), [
    ERC1967_BEACON_SLOT.toLowerCase(),
    ERC1967_ADMIN_SLOT.toLowerCase(),
  ])
})

test('a probe reads the code and every anchored slot, and hashes the code', async () => {
  const asked: string[] = []
  const client = {
    getCode: async () => {
      asked.push('code')
      // minimal runtime: the hash only has to be stable, not meaningful
      return '0x6080' as Hex
    },
    getStorageAt: async ({ slot }: { slot: Hex }) => {
      asked.push(slot)
      return word(BSTOCK_BEACON)
    },
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  const probe = await probeStockToken(
    client,
    '0x2222222222222222222222222222222222222222' as Address,
    ANCHORS,
  )
  assert.deepEqual(asked, ['code', ERC1967_BEACON_SLOT.toLowerCase(), ERC1967_ADMIN_SLOT.toLowerCase()])
  // keccak256(0x6080), independently confirmed with `cast keccak 0x6080` — a
  // literal rather than a recomputation, so a swapped hash function is caught
  assert.equal(probe.codehash, '0x1a578b7a4b0b5755db6d121b4118d4bc68fe170dca840c59bc922f14175a76b0')
  assert.equal(probe.slots[ERC1967_BEACON_SLOT.toLowerCase()], word(BSTOCK_BEACON))
})

test('an address with no code is unproven, not crashed on', async () => {
  const client = {
    getCode: async () => undefined,
    getStorageAt: async () => null,
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  const probe = await probeStockToken(
    client,
    '0x3333333333333333333333333333333333333333' as Address,
    ANCHORS,
  )
  assert.equal(probe.codehash, null)
  assert.equal(matchStockIssuer(ANCHORS, probe), null)
})

test('a failing code read does not discard the slots that did resolve', async () => {
  const client = {
    getCode: async () => {
      throw new Error('rpc down')
    },
    getStorageAt: async () => word(BSTOCK_BEACON),
  } as unknown as Pick<PublicClient, 'getCode' | 'getStorageAt'>

  const probe = await probeStockToken(
    client,
    '0x4444444444444444444444444444444444444444' as Address,
    ANCHORS,
  )
  assert.equal(probe.codehash, null)
  assert.equal(probe.slots[ERC1967_BEACON_SLOT.toLowerCase()], word(BSTOCK_BEACON))
  assert.equal(matchStockIssuer(ANCHORS, probe), null, 'half a proof is not a proof')
})
