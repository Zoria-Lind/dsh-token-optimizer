import { mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolveConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { createToolTrimModule } from '../src/modules/toolTrim.js'
import { createCacheModule } from '../src/modules/cache.js'
import { createFileDiffModule } from '../src/modules/fileDiff.js'

// Model the verified 0.2.1-rc.2 contract: inherited restrictions intersect;
// own registrations are exempt; mutations can synchronously emit tools/change.
export function fixture(names, overrides = {}) {
  const handlers = new Map(), globals = new Map(), scopes = new Map()
  for (const name of names) globals.set(name, { name, description: 'description ' + name, parameters: { type: 'object' } })
  const emit = (event, ...args) => [...(handlers.get(event) ?? [])].map(fn => fn(...args))
  const ctx = {
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn) },
    off(event, fn) { handlers.get(event)?.delete(fn) },
  }
  const counts = { register: 0, restrict: 0 }, faults = { register: false, restrict: false }
  const chain = agent => { const out = []; for (let a = agent; a; a = a.parent) out.unshift(scopes.get(a.id)); return out.filter(Boolean) }
  function view(agent) {
    const layers = chain(agent), own = agent ? scopes.get(agent.id) : undefined
    const inherited = new Map(globals)
    for (const layer of layers) if (layer !== own) for (const [name, def] of layer.own) inherited.set(name, def)
    const visible = new Map()
    for (const [name, def] of inherited) if (layers.every(layer => [...layer.filters].every(f =>
      (f.allow === undefined || f.allow.includes(name)) && !(f.deny ?? []).includes(name)))) visible.set(name, def)
    if (own) for (const [name, def] of own.own) visible.set(name, def)
    return { visible, knownNames: new Set([...inherited.keys(), ...(own?.own.keys() ?? [])]), restrictableNames: new Set(inherited.keys()) }
  }
  function agent(id, parent) {
    const a = { id, parent }
    const state = { own: new Map(), filters: new Set() }
    scopes.set(id, state)
    a.ctx = { tools: {
      view,
      register(def) {
        counts.register++
        if (faults.register) throw Error('registration unavailable')
        if (state.own.has(def.name)) throw Error('already registered')
        state.own.set(def.name, def); emit('tools/change')
        return () => { if (state.own.get(def.name) === def) { state.own.delete(def.name); emit('tools/change') } }
      },
      restrict(filter) {
        counts.restrict++
        if (faults.restrict) throw Error('filter unavailable')
        if (filter.allow === undefined && filter.deny === undefined) throw Error('empty filter')
        for (const name of [...filter.allow ?? [], ...filter.deny ?? []]) if (!view(a).restrictableNames.has(name) || name === 'run_code') throw Error('unknown/reserved: ' + name)
        state.filters.add(filter); emit('tools/change')
        return () => { if (state.filters.delete(filter)) emit('tools/change') }
      },
    } }
    return a
  }
  const stats = createStats()
  const stop = createToolTrimModule(ctx, { ...resolveConfig({}).toolTrim, enabled: true, ...overrides }, stats, { defineTool: d => d })
  return {
    ctx, globals, scopes, faults, counts, stats, agent, view, stop,
    async emit(event, ...args) { await Promise.all(emit(event, ...args)) },
    start(a) { emit('agent/created', { agent: a }) },
    async create(a) { await Promise.all(emit('agent/created', { agent: a })); await Promise.resolve() },
    async call(a, args = {}) {
      const def = view(a).visible.get('mcp_load_tools')
      if (!def) return 'NO DISCOVERY TOOL'
      return def.execute(args, { agent: a })
    },
  }
}

function passContext() {
  const handlers = new Map()
  return {
    on(e, fn) { handlers.set(e, fn) }, off(e) { handlers.delete(e) },
    emit(e, ...args) { const fn = handlers.get(e); return fn ? fn(...args) : args.at(-1)() },
  }
}

export async function runAvailabilityChecks(check) {
  console.log('== TO-01 availability regression ==')
  {
    const f = fixture(['read', 'brand_new_builtin'])
    const a = f.agent('zero'); await f.create(a)
    check('TO01 zero MCP leaves new builtins visible without discovery', f.view(a).visible.has('brand_new_builtin') && f.counts.register === 0)
    f.stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a', 'mcp__srv__b'])
    f.globals.get('mcp__srv__b').description = 'unique_description_keyword'
    const a = f.agent('small'); await f.create(a)
    check('TO01 MCP hidden only after helper is visible', !f.view(a).visible.has('mcp__srv__a') && f.view(a).visible.has('mcp_load_tools'))
    const out = await f.call(a, { query: 'unique_description_keyword' })
    check('TO01 search retains descriptions after filtering', /mcp__srv__b/.test(out) && /unique_description_keyword/.test(out))
    await f.call(a, { names: ['mcp__srv__a'] })
    check('TO01 successful load actually exposes requested tool only', f.view(a).visible.has('mcp__srv__a') && !f.view(a).visible.has('mcp__srv__b'))
    const n = f.stats.snapshot().counters['toolgate.mcpReleased']
    await f.call(a, { names: ['mcp__srv__a'] })
    check('TO01 repeated load does not inflate success count', f.stats.snapshot().counters['toolgate.mcpReleased'] === n)
    const before = f.counts.restrict
    for (let i = 0; i < 20; i++) await f.emit('tools/change')
    check('TO01 own changes do not recurse or remount unchanged filters', f.counts.restrict === before)
    f.stop()
  }
  {
    const f = fixture(Array.from({ length: 1000 }, (_, i) => 'mcp__bulk__tool_' + String(i).padStart(4, '0')))
    const a = f.agent('many'); await f.create(a)
    const def = f.view(a).visible.get('mcp_load_tools')
    const first = await f.call(a, { limit: 5 })
    const tail = await f.call(a, { offset: 995, limit: 5 })
    const search = await f.call(a, { query: 'tool_0999' })
    check('TO01 last MCP can be found through search and pagination', /tool_0999/.test(search) && /tool_0999/.test(tail))
    check('TO01 discovery reply stays bounded with 1000 tools', first.length < 6000 && !/tool_0999/.test(first))
    check('TO01 helper definition does not contain a growing inline catalogue', JSON.stringify(def).length < 3000)
    const oversized = await f.call(a, { limit: 10000, names: Array.from({ length: 1000 }, (_, i) => 'unknown_' + i) })
    check('TO01 oversized discovery/load arguments produce bounded feedback', oversized.length < 12000)
    console.log('TO01 definition bytes: ' + JSON.stringify({ tools: 1000, visibleSchemaBytes: Buffer.byteLength(JSON.stringify([...f.view(a).visible.values()])), catalogueSchemaBytes: Buffer.byteLength(JSON.stringify([...f.globals.values()])) }))
    f.stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a'])
    f.faults.register = true
    const a = f.agent('registration'); await f.create(a)
    check('TO01 helper registration failure leaves MCP available', f.view(a).visible.has('mcp__srv__a'))
    f.faults.register = false; await f.emit('tools/change')
    check('TO01 failed registration retries even when names are unchanged', f.view(a).visible.has('mcp_load_tools') && !f.view(a).visible.has('mcp__srv__a'))
    f.stop()
  }
  {
    const f = fixture(['mcp__srv__a', 'mcp_load_tools'])
    const a = f.agent('collision'); await f.create(a)
    check('TO01 helper name collision neither shadows owner nor hides MCP', f.view(a).visible.get('mcp_load_tools') === f.globals.get('mcp_load_tools') && f.view(a).visible.has('mcp__srv__a'))
    f.stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a', 'mcp__srv__b'])
    const a = f.agent('filter'); await f.create(a)
    f.faults.restrict = true
    const out = await f.call(a, { names: ['mcp__srv__a'] })
    check('TO01 failed filter never reports successful loading', !f.view(a).visible.has('mcp__srv__a') && !/已放行: mcp__srv__a/.test(out) && !f.stats.snapshot().counters['toolgate.mcpReleased'])
    f.faults.restrict = false
    await f.call(a, { names: ['mcp__srv__a'] })
    check('TO01 failed loading can retry without a false checkpoint', f.view(a).visible.has('mcp__srv__a'))
    f.stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a'], { deny: ['mcp__srv__a'] })
    const a = f.agent('deny'); await f.create(a); await f.call(a, { names: ['mcp__srv__a'] })
    check('TO01 explicit deny survives loading', !f.view(a).visible.has('mcp__srv__a'))
    f.stop()
    const e = fixture(['read', 'mcp__srv__a'], { allow: [] })
    const b = e.agent('empty'); await e.create(b)
    check('TO01 explicit empty allow is not confused with omitted allow', !e.view(b).visible.has('read') && !e.view(b).visible.has('mcp__srv__a'))
    e.stop()
    const w = fixture(['read', 'mcp__srv__a', 'mcp__srv__b'], { allow: ['read', 'mcp__srv__a'] })
    const c = w.agent('whitelist'); await w.create(c)
    await w.call(c, { names: ['mcp__srv__a', 'mcp__srv__b'] })
    check('TO01 loading cannot expand an explicit whitelist', w.view(c).visible.has('read') && w.view(c).visible.has('mcp__srv__a') && !w.view(c).visible.has('mcp__srv__b'))
    w.stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a'], { deny: ['read'] })
    const a = f.agent('reconnect'); await f.create(a)
    const meta = f.view(a).visible.get('mcp_load_tools')
    f.globals.delete('mcp__srv__a'); await f.emit('tools/change')
    check('TO01 disconnect preserves static restrictions', !f.view(a).visible.has('read'))
    f.globals.set('mcp__srv__a', { name: 'mcp__srv__a', description: 'new_generation' }); await f.emit('tools/change')
    check('TO01 same-name reconnect restores discovery and lazy gate', f.view(a).visible.has('mcp_load_tools') && !f.view(a).visible.has('mcp__srv__a'))
    check('TO01 reconnect refreshes searchable descriptions', /new_generation/.test(await f.call(a, { query: 'new_generation' })))
    await f.call(a, { names: ['mcp__srv__a'] })
    f.globals.set('mcp__srv__a', { name: 'mcp__srv__a', description: 'atomic_replacement' }); await f.emit('tools/change')
    check('TO01 atomic same-name replacement refreshes catalogue', /atomic_replacement/.test(await f.call(a, { query: 'atomic_replacement' })))
    await f.emit('agent/disposed', { agent: a })
    const n = f.counts.restrict
    await meta.execute({ names: ['mcp__srv__a'] }, { agent: a }); await f.emit('tools/change'); await Promise.resolve()
    check('TO01 stale callbacks cannot remount a disposed agent', f.counts.restrict === n && f.scopes.get(a.id).filters.size === 0 && f.scopes.get(a.id).own.size === 0)
    f.stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a'])
    const parent = f.agent('parent'); await f.create(parent)
    const child = f.agent('child', parent); await f.create(child)
    const out = await f.call(child, { names: ['mcp__srv__a'] })
    check('TO01 child does not bypass parent gate or report false success', !f.view(child).visible.has('mcp__srv__a') && !/已放行: mcp__srv__a/.test(out))
    await f.call(parent, { names: ['mcp__srv__a'] }); await f.call(child, { names: ['mcp__srv__a'] })
    check('TO01 child can load after parent admits capability', f.view(child).visible.has('mcp__srv__a'))
    f.stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a'])
    const a = f.agent('cleanup'); await f.create(a)
    const stale = f.view(a).visible.get('mcp_load_tools')
    f.stop()
    const n = f.counts.restrict
    await stale.execute({ names: ['mcp__srv__a'] }, { agent: a }); await f.emit('tools/change'); await Promise.resolve()
    check('TO01 plugin disposal cancels callbacks and removes owned effects', f.counts.restrict === n && f.scopes.get(a.id).filters.size === 0 && f.scopes.get(a.id).own.size === 0)
  }
  {
    const ctx = passContext(), stats = createStats()
    const stop = createCacheModule(ctx, { ...resolveConfig({}).cache, enabled: true }, stats)
    let calls = 0
    for (const agent of [{ id: 'one', cwd: 'D:/one' }, { id: 'two', cwd: 'D:/two' }]) {
      for (const name of ['glob', 'grep']) {
        const exec = { name, arguments: { pattern: '*' }, agent }
        const first = await ctx.emit('tools/execute', exec, async () => ({ value: ++calls }))
        const second = await ctx.emit('tools/execute', exec, async () => ({ value: ++calls }))
        check('TO01 legacy cache executes fresh ' + name + ' in ' + agent.id, second.value !== first.value)
      }
    }
    check('TO01 suspended cache makes no hit/saving claims', !stats.snapshot().counters['cache.hits'])
    stop()
  }
  {
    const ctx = passContext(), stats = createStats()
    const stop = createFileDiffModule(ctx, { ...resolveConfig({}).fileDiff, enabled: true }, stats)
    const a = { id: 'one', session: { id: 's1' }, cwd: 'D:/one' }
    const full = 'line\n'.repeat(1000)
    const decision = { kind: 'accept', content: [{ type: 'text', text: full }], additionalContexts: [{ content: 'keep' }] }
    let exact = true
    for (const update of [() => {}, () => { a.cwd = 'D:/two' }, () => { a.session = { id: 's2' } }, () => { decision.content[0].text += 'changed' }, () => { a.session.contextReset = true }]) {
      update()
      for (let i = 0; i < 2; i++) {
        const out = await ctx.emit('tools/post-execute', { name: 'read', arguments: { file_path: 'a.txt' }, agent: a }, { content: decision.content }, async () => decision)
        exact &&= out === decision && out.content === decision.content && out.additionalContexts === decision.additionalContexts
      }
    }
    check('TO01 uncertain context baseline preserves full content across cwd/session/change/reset', exact)
    check('TO01 suspended fileDiff makes no diff/saving claims', !stats.snapshot().counters['filediff.unchanged'] && !stats.snapshot().counters['filediff.changed'])
    stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a'])
    f.faults.restrict = true
    const a = f.agent('initial-filter'); await f.create(a)
    check('TO01 initial filter failure does not hide tools', f.view(a).visible.has('mcp__srv__a'))
    f.faults.restrict = false; await f.emit('tools/change')
    check('TO01 unchanged names retry a failed initial filter', !f.view(a).visible.has('mcp__srv__a'))
    f.stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a'], { deny: ['read'] })
    f.faults.register = true
    const a = f.agent('static-on-register-error'); await f.create(a)
    check('TO01 registration failure preserves explicit static deny', !f.view(a).visible.has('read') && f.view(a).visible.has('mcp__srv__a'))
    f.stop()
    const d = fixture(['read', 'mcp__srv__a'], { deny: ['mcp_load_tools'] })
    const b = d.agent('deny-discovery'); await d.create(b)
    check('TO01 explicitly denied discovery helper is never self-registered', !d.view(b).visible.has('mcp_load_tools') && d.view(b).visible.has('mcp__srv__a'))
    d.stop()
  }
  {
    const f = fixture(['read', 'mcp__srv__a'])
    const a = f.agent('immediate-stop')
    f.start(a); f.stop()
    const n = f.counts.restrict
    await Promise.resolve(); await Promise.resolve()
    check('TO01 disposal before creation microtasks prevents late mounts', f.counts.restrict === n && f.scopes.get(a.id).filters.size === 0 && f.scopes.get(a.id).own.size === 0)
  }
  {
    const ctx = passContext(), stats = createStats()
    createCacheModule(ctx, { ...resolveConfig({}).cache, enabled: true }, stats)
    const dir = mkdtempSync(join(tmpdir(), 'to01-files-'))
    const exec = { name: 'glob', arguments: { pattern: '*' }, agent: { id: 'filesystem', cwd: dir } }
    const runGlob = () => ctx.emit('tools/execute', exec, async () => ({ value: readdirSync(dir) }))
    const first = await runGlob()
    writeFileSync(join(dir, 'new.txt'), 'old')
    const second = await runGlob()
    check('TO01 actual new file appears in repeated glob', first.value.length === 0 && second.value.includes('new.txt'))
    const grep = { ...exec, name: 'grep' }
    const runGrep = () => ctx.emit('tools/execute', grep, async () => ({ value: readFileSync(join(dir, 'new.txt'), 'utf8') }))
    const old = await runGrep()
    writeFileSync(join(dir, 'new.txt'), 'new')
    const fresh = await runGrep()
    check('TO01 actual file edit changes repeated grep result', old.value === 'old' && fresh.value === 'new')
    // Keep isolated fixtures with evidence; no cleanup touches external paths.
  }
  {
    const config = resolveConfig({})
    check('TO01 defaults suspend unsafe optimizations and omit whitelist', config.cache.enabled === false && config.fileDiff.enabled === false && config.toolTrim.allow === null)
    check('TO01 explicit empty whitelist survives config resolution', resolveConfig({ toolTrim: { allow: [] } }).toolTrim.allow.length === 0)
  }

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0, failed = 0
  await runAvailabilityChecks((name, ok) => { if (ok) { passed++; console.log('  ok  ' + name) } else { failed++; console.error('FAIL ' + name) } })
  console.log(JSON.stringify({ passed, failed }))
  process.exitCode = failed ? 1 : 0
}
