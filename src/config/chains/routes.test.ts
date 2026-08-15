import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAINS } from './index'
import {
  activeRpcUrls,
  bridgeRpcPath,
  chainApiPath,
  chainGatewayEnabled,
  chainRpcPath,
  chainServedHere,
  indexerPoolGroupsPath,
  indexerPoolsPath,
} from './routes'

// A deployment that cannot serve a chain used to say so only by handing back a
// null pool path, which the UI turned into "indexer offline" — an outage
// message for a routing fact. This is the same rule, askable in advance.
test('a deployment serves exactly the chains it has a catalog for', () => {
  for (const chain of Object.values(CHAINS)) {
    assert.equal(
      chainServedHere(chain.key, true, 'robinhood'),
      true,
      'the canonical gateway serves every chain namespace',
    )
  }
  assert.equal(chainServedHere('robinhood', false, 'robinhood'), true, 'its own build chain')
  assert.equal(
    chainServedHere('bsc', false, 'robinhood'),
    false,
    'a single-chain deployment has no catalog for any other chain',
  )
})

test('the served-here rule agrees with the pool path it guards', () => {
  for (const chain of Object.values(CHAINS)) {
    for (const gateway of [true, false]) {
      for (const build of Object.keys(CHAINS)) {
        const served = chainServedHere(chain.key, gateway, build)
        const path = indexerPoolsPath(chain.key, gateway, chain.key === build)
        assert.equal(
          served,
          path !== null,
          `${chain.key} gateway=${gateway} build=${build}: a served chain must have a pool path`,
        )
        // Grouping is the same catalog asked a different question, so a
        // deployment that cannot serve one cannot serve the other either.
        assert.equal(
          indexerPoolGroupsPath(chain.key, gateway, chain.key === build) !== null,
          served,
        )
      }
    }
  }
})

test('the grouped catalog is namespaced exactly like the flat one', () => {
  for (const chain of Object.values(CHAINS)) {
    assert.equal(
      indexerPoolGroupsPath(chain.key, true, false),
      `/_chain/${chain.key}/api/pool-groups`,
    )
    assert.equal(indexerPoolGroupsPath(chain.key, false, true), '/api/pool-groups')
  }
})

test('canonical gateway services are namespaced by the selected chain on one origin', () => {
  for (const chain of Object.values(CHAINS)) {
    assert.equal(chainRpcPath(chain.key), `/_chain/${chain.key}/rpc`)
    assert.equal(chainRpcPath(chain.key, '/eth'), `/_chain/${chain.key}/rpc/eth`)
    assert.equal(chainApiPath(chain.key, '/pools'), `/_chain/${chain.key}/api/pools`)
    assert.equal(indexerPoolsPath(chain.key, true, false), `/_chain/${chain.key}/api/pools`)
    assert.equal(bridgeRpcPath(chain.key, 'eth', true), `/_chain/${chain.key}/rpc/eth`)
  }
})

test('solver exposure uses the canonical chain namespaces and fixed AllowanceHolder', () => {
  const allowanceHolder = '0x0000000000001fF3684f28c67538d4D072C22734'
  assert.equal(
    CHAINS.robinhood.solverUrl,
    'https://lp-terminal.xyz/_chain/robinhood/solver',
  )
  assert.equal(CHAINS.bsc.solverUrl, 'https://lp-terminal.xyz/_chain/bsc/solver')
  assert.equal(CHAINS.robinhood.solverAllowanceTarget, allowanceHolder)
  assert.equal(CHAINS.bsc.solverAllowanceTarget, allowanceHolder)
})

test('the chain gateway capability is bound to its exact runtime host', () => {
  assert.equal(chainGatewayEnabled('lp-terminal.xyz', 'lp-terminal.xyz'), true)
  assert.equal(chainGatewayEnabled(' LP-TERMINAL.XYZ. ', 'lp-terminal.xyz'), true)
  assert.equal(chainGatewayEnabled('lp-terminal.xyz', 'bsc.lp-terminal.xyz'), false)
  assert.equal(chainGatewayEnabled('lp-terminal.xyz', 'up33-terminal.xyz'), false)
  for (const invalid of ['', 'https://lp-terminal.xyz', 'user@lp-terminal.xyz', 'lp-terminal.xyz:443'])
    assert.equal(chainGatewayEnabled(invalid, 'lp-terminal.xyz'), false)
})

test('production RPC uses the selected namespace even when it differs from the build', () => {
  assert.deepEqual(
    activeRpcUrls({
      chainKey: 'robinhood',
      publicRpc: 'https://public.example',
      customRpc: null,
      envRpc: '',
      production: true,
      gatewayEnabled: true,
      activeIsBuild: false,
    }),
    ['/_chain/robinhood/rpc', 'https://public.example'],
  )
})

test('custom RPC remains chain-scoped and has highest priority', () => {
  assert.deepEqual(
    activeRpcUrls({
      chainKey: 'bsc',
      publicRpc: 'https://public.example',
      customRpc: 'https://custom.example',
      envRpc: 'https://build.example',
      production: true,
      gatewayEnabled: true,
      activeIsBuild: false,
    }),
    ['https://custom.example'],
  )
})

test('local build RPC cannot be reused for another selected chain', () => {
  assert.deepEqual(
    activeRpcUrls({
      chainKey: 'robinhood',
      publicRpc: 'https://robinhood-public.example',
      customRpc: null,
      envRpc: 'https://bsc-private.example',
      production: false,
      gatewayEnabled: false,
      activeIsBuild: false,
    }),
    ['https://robinhood-public.example'],
  )
  assert.equal(indexerPoolsPath('robinhood', false, false), null)
  assert.equal(indexerPoolsPath('bsc', false, true), '/api/pools')
})

test('ordinary production aliases keep only their build-chain legacy proxies', () => {
  const base = {
    chainKey: 'robinhood',
    publicRpc: 'https://public.example',
    customRpc: null,
    envRpc: '',
    production: true,
    gatewayEnabled: false,
  }
  assert.deepEqual(activeRpcUrls({ ...base, activeIsBuild: true }), [
    '/rpc',
    'https://public.example',
  ])
  assert.deepEqual(activeRpcUrls({ ...base, activeIsBuild: false }), ['https://public.example'])
  assert.equal(indexerPoolsPath('robinhood', false, true), '/api/pools')
  assert.equal(indexerPoolsPath('bsc', false, false), null)
  assert.equal(bridgeRpcPath('robinhood', 'arb', false), '/rpc/arb')
})
