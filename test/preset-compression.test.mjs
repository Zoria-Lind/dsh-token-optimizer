import test from 'node:test'
import assert from 'node:assert/strict'
import { compressionServices, createCompactionDriverModule } from '../src/modules/compactionDriver.js'
import { createLayeredCompactModule } from '../src/modules/layeredCompact.js'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'

function fixture() {
  const handlers = new Map(), presets = new Map()
  const global = { tokenMeter: { measure: () => ({ totalTokens: 70000 }) } }
  global.agentPresets = {
    serviceFor: (a, name) => presets.get(a.ctx)?.[name],
    composedPreset: ctx => presets.has(ctx) ? 'bound' : undefined,
  }
  const ctx = {
    get: name => global[name],
    on: (key, fn) => handlers.set(key, fn),
    off: key => handlers.delete(key),
    async idle(a) { await handlers.get('agent/status')?.({ agent: a, status: 'idle' }); await new Promise(setImmediate) },
  }
  const agent = id => ({ id, ctx: {}, session: { events: [
    ...Array.from({ length: 6 }, () => ({ type: 'turn/start' })),
    { type: 'request/context', data: { contextWindow: 100000 } },
  ] } })
  return { ctx, global, presets, agent }
}

test('isolated services follow each agent, rebind, and removal without global fallback', () => {
  const f = fixture(), a = f.agent('a'), b = f.agent('b')
  const one = {}, two = {}, replacement = {}
  f.global.compaction = { wrong: true }
  f.presets.set(a.ctx, { compaction: one }); f.presets.set(b.ctx, { compaction: two })
  const reader = compressionServices(f.ctx, ['compaction'])
  assert.equal(reader.get('compaction', a), one)
  assert.equal(reader.get('compaction', b), two)
  f.presets.set(a.ctx, { compaction: replacement })
  assert.equal(reader.get('compaction', a), replacement)
  f.presets.set(a.ctx, {})
  assert.equal(reader.get('compaction', a), undefined)
  reader.dispose()
  assert.equal(reader.get('compaction', b), undefined)
})

test('legacy and preset-free hosts keep global services; meter remains global', () => {
  const f = fixture(), a = f.agent('a'), compaction = {}
  f.global.compaction = compaction
  const reader = compressionServices(f.ctx, ['compaction', 'tokenMeter'])
  assert.equal(reader.get('compaction', a), compaction)
  f.presets.set(a.ctx, {})
  assert.equal(reader.get('tokenMeter', a), f.global.tokenMeter)
  delete f.global.agentPresets
  assert.equal(reader.get('compaction', a), compaction)
  reader.dispose()
})

test('preset lookup error fails closed instead of using global compaction', () => {
  const f = fixture(), a = f.agent('a')
  f.global.compaction = {}
  f.global.agentPresets.serviceFor = () => { throw Error('unavailable') }
  const reader = compressionServices(f.ctx, ['compaction'])
  assert.equal(reader.get('compaction', a), undefined)
  reader.dispose()
})

for (const mode of ['legacy', 'layered']) {
  test(mode + ' reaches only each agent preset through the actual controller', async () => {
    const f = fixture(), a = f.agent('a'), b = f.agent('b'), calls = []
    for (const agent of [a, b]) f.presets.set(agent.ctx, {
      compaction: { compactNow: async actual => { assert.equal(actual, agent); calls.push('summary:' + agent.id); return {} } },
      toolResultPruner: { pruneSession: actual => { assert.equal(actual, agent.session); calls.push('prune:' + agent.id) } },
    })
    f.global.compaction = { compactNow: () => assert.fail('global summary used') }
    f.global.toolResultPruner = { pruneSession: () => assert.fail('global pruner used') }
    const cfg = resolveConfig({}), stats = createStats()
    const dispose = mode === 'legacy'
      ? createCompactionDriverModule(f.ctx, { ...cfg.compactionDriver, minTokens: 0 }, stats)
      : createLayeredCompactModule(f.ctx, { ...cfg.layeredCompact, enabled: true }, stats)
    try {
      await f.ctx.idle(a); await f.ctx.idle(b)
      assert.deepEqual(calls, mode === 'legacy' ? ['summary:a', 'summary:b'] : ['prune:a', 'summary:a', 'prune:b', 'summary:b'])
      assert.equal(stats.snapshot().counters[mode === 'legacy' ? 'compactionDriver.completed' : 'layeredCompact.lossy'], 2)
    } finally { dispose() }
  })
  test(mode + ' missing preset service reports unavailable and never borrows global', async () => {
    const f = fixture(), a = f.agent('a'), stats = createStats(), cfg = resolveConfig({})
    f.presets.set(a.ctx, {})
    f.global.compaction = { compactNow: () => assert.fail('wrong global summary') }
    f.global.toolResultPruner = { pruneSession: () => assert.fail('wrong global pruner') }
    const dispose = mode === 'legacy'
      ? createCompactionDriverModule(f.ctx, { ...cfg.compactionDriver, minTokens: 0 }, stats)
      : createLayeredCompactModule(f.ctx, { ...cfg.layeredCompact, enabled: true }, stats)
    try {
      await f.ctx.idle(a)
      const samples = stats.snapshotSession(a.id).samples
      assert.ok(samples.some(s => s.status === 'unavailable'))
      assert.ok(!samples.some(s => s.status === 'success'))
    } finally { dispose() }
  })
}
