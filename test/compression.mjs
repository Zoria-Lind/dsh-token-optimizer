// TO-02：虚构会话/服务，验证可观察行为；不调用真实模型。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { resolveConfig, resolveCompressionConfig } from '../src/config.js'
import { createStats } from '../src/stats.js'
import { apply } from '../src/index.js'
import { createLayeredCompactModule } from '../src/modules/layeredCompact.js'
import { createCompactionDriverModule, computePressure } from '../src/modules/compactionDriver.js'
import { buildConfigSchema } from '../src/configSchema.js'

const tick = () => new Promise((r) => setImmediate(r))
const agent = (id = 'a') => ({ id, session: { id: 's-' + id, events: [
  ...Array.from({ length: 6 }, () => ({ type: 'turn/start' })),
  { type: 'request/context', data: { contextWindow: 100000 } },
] } })
function context(services = {}) {
  const handlers = new Map()
  const ctx = {
    fiber: {}, services, commands: [],
    on(key, fn) { const a = handlers.get(key) ?? []; a.push(fn); handlers.set(key, a); return () => ctx.off(key, fn) },
    off(key, fn) { const a = handlers.get(key) ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) },
    get(key) { return services[key] },
    inject(keys, callback) {
      if (keys.includes('commands')) callback({ commands: { register(def) { ctx.commands.push(def); return () => ctx.commands.splice(ctx.commands.indexOf(def), 1) } } })
      else callback(Object.fromEntries(keys.map((k) => [k, services[k]])))
      return () => {}
    },
    async emit(key, data) { for (const fn of [...(handlers.get(key) ?? [])]) await fn(data) },
    validate(raw) {
      const list = handlers.get('internal/config') ?? []
      const run = (i) => i >= list.length ? raw : list[i].call(ctx.fiber, raw, () => run(i + 1))
      return run(0)
    },
    status(a) { return ctx.commands.find((c) => c.name === 'token-status').handler({ agent: a }) },
  }
  return ctx
}
const idle = async (ctx, a) => { await ctx.emit('agent/status', { agent: a, status: 'idle' }); await tick() }
const samples = (stats, a) => stats.snapshotSession(a.id).samples.filter((s) => s.module === 'compression')
const quiet = { text2img: { enabled: false }, outputLadder: { enabled: false }, monitor: { enabled: false }, toolTrim: { enabled: false } }

export async function runCompressionChecks(check) {
  console.log('== TO-02 配置/控制器/设置回归 ==')
  const expect = (name, action) => {
    try { action(); check('TO-02 ' + name, true) }
    catch (err) { check('TO-02 ' + name + ': ' + err.message, false) }
  }
  const defaults = resolveConfig({})
  expect('保持旧驱动默认、分层默认关闭与 40/50/65', () => {
    assert.equal(defaults.compactionDriver.enabled, true)
    assert.equal(defaults.layeredCompact.enabled, false)
    assert.deepEqual([defaults.layeredCompact.lowRatio, defaults.layeredCompact.midRatio, defaults.layeredCompact.highRatio], [0.4, 0.5, 0.65])
  })
  for (const value of [
    { lowRatio: 0 }, { lowRatio: 0.6 }, { midRatio: 0.65 }, { highRatio: 1 }, { highRatio: NaN },
    { highRatio: '' }, { highRatio: '0.8' }, { midRatio: 0.8, highRatio: 0.7 },
  ]) expect('后端拒绝非法阈值 ' + JSON.stringify(value), () => assert.throws(() => resolveConfig({ layeredCompact: value })))
  expect('允许观测线等于清理线', () => assert.doesNotThrow(() => resolveConfig({ layeredCompact: { lowRatio: 0.5 } })))
  expect('拒绝非法窗口/超时/小数成功配额', () => {
    for (const value of [{ sessionWindowFallback: 0 }, { highTierTimeoutMs: 0 }, { highTierMaxPerSession: 1.2 }])
      assert.throws(() => resolveConfig({ layeredCompact: value }))
  })
  expect('读数拒绝 NaN/Infinity/负数，回落值如实标注', () => {
    for (const value of [NaN, Infinity, -1]) assert.equal(computePressure({ get: () => ({ measure: () => ({ totalTokens: value }) }) }, agent().session), null)
    const p = computePressure({ get: () => ({ measure: () => ({ totalTokens: 55 }) }) }, { events: [] }, 100)
    assert.equal(p.windowSource, 'fallback')
    assert.equal(p.ratio, 0.55)
  })

  for (const mode of ['legacy', 'layered']) {
    let result = null
    let calls = 0
    const stats = createStats()
    const a = agent(mode)
    const ctx = context({ tokenMeter: { measure: () => ({ totalTokens: 70000 }) }, compaction: { compactNow: async () => { calls++; return result } } })
    const cfg = mode === 'legacy'
      ? { ...defaults.compactionDriver, minTokens: 0, maxCompactionsPerSession: 1 }
      : { ...defaults.layeredCompact, enabled: true, highTierMaxPerSession: 1 }
    const dispose = (mode === 'legacy' ? createCompactionDriverModule : createLayeredCompactModule)(ctx, cfg, stats)
    await idle(ctx, a)
    await idle(ctx, a)
    expect(mode + ' null 不记成功，短时间同一历史不重复提交', () => {
      assert.equal(calls, 1)
      assert.equal(stats.snapshot().counters[mode === 'legacy' ? 'compactionDriver.completed' : 'layeredCompact.lossy'], undefined)
      assert.ok(samples(stats, a).some((s) => s.status === 'noop' && s.modelCall === false))
    })
    a.session.events.push({ type: 'turn/start' })
    result = {}
    await idle(ctx, a)
    await idle(ctx, a)
    expect(mode + ' 历史变化后仍有成功配额，成功才封顶', () => {
      assert.equal(calls, 2)
      assert.equal(stats.snapshot().counters[mode === 'legacy' ? 'compactionDriver.completed' : 'layeredCompact.lossy'], 1)
    })
    dispose()
  }
  {
    let tokens = 70000, calls = 0
    const stats = createStats(), a = agent('prune')
    const ctx = context({ tokenMeter: { measure: () => ({ totalTokens: tokens }) }, toolResultPruner: { pruneSession() { tokens = 30000 } } })
    createLayeredCompactModule(ctx, { ...defaults.layeredCompact, enabled: true }, stats)
    await idle(ctx, a)
    expect('缺少摘要服务也能清理；前后量可复算', () => {
      const s = samples(stats, a).find((s) => s.stage === 'prune')
      assert.equal(s.savedTokens, 40000)
      assert.equal(s.before.totalTokens - s.after.totalTokens, 40000)
      assert.equal(s.after.windowSource, 'event')
      assert.equal(s.modelCall, false)
    })
    ctx.services.compaction = { compactNow: async () => { calls++; return {} } }
    tokens = 55000
    await idle(ctx, a)
    expect('清理后低于摘要阈值不调用摘要', () => assert.equal(calls, 0))
  }
  {
    let valid = true, calls = 0
    const stats = createStats(), a = agent('bad-meter')
    const ctx = context({
      tokenMeter: { measure: () => ({ totalTokens: valid ? 70000 : NaN }) },
      toolResultPruner: { pruneSession() { valid = false } },
      compaction: { compactNow: async () => { calls++; return {} } },
    })
    createLayeredCompactModule(ctx, { ...defaults.layeredCompact, enabled: true }, stats)
    await idle(ctx, a)
    expect('清理后复测失败不沿用旧压力请求摘要', () => {
      assert.equal(calls, 0)
      assert.ok(samples(stats, a).some((s) => s.status === 'noPressure'))
    })
  }
  for (const code of ['busy', 'summary', 'timeout']) {
    const stats = createStats(), a = agent(code)
    const ctx = context({
      tokenMeter: { measure: () => ({ totalTokens: 70000 }) },
      compaction: { compactNow: async (_, signal) => {
        if (code === 'timeout') return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        throw Object.assign(new Error(code), { code })
      } },
    })
    createLayeredCompactModule(ctx, { ...defaults.layeredCompact, enabled: true, highTierTimeoutMs: 5 }, stats)
    await Promise.all([idle(ctx, a), new Promise((r) => setTimeout(r, 15))])
    expect(code + ' 分类明确且不占成功次数', () => {
      assert.equal(stats.snapshot().counters['layeredCompact.failed.' + code], 1)
      assert.equal(stats.snapshot().counters['layeredCompact.lossy'], undefined)
      assert.ok(samples(stats, a).some((s) => s.status === code && s.modelCall === null))
    })
  }
  {
    let calls = 0, cfg = { ...defaults.layeredCompact, enabled: true }
    const stats = createStats(), a = agent('queued')
    const ctx = context({ tokenMeter: { measure: () => ({ totalTokens: 70000 }) }, compaction: { compactNow: async () => { calls++; return {} } } })
    const dispose = createLayeredCompactModule(ctx, () => cfg, stats)
    const pending = ctx.emit('agent/status', { agent: a, status: 'idle' })
    cfg = { ...cfg, enabled: false }
    await pending
    expect('尚未启动时关闭开关可取消排队动作', () => assert.equal(calls, 0))
    cfg = { ...cfg, enabled: true }
    const pending2 = ctx.emit('agent/status', { agent: a, status: 'idle' })
    dispose()
    await pending2
    expect('卸载后不执行排队摘要', () => assert.equal(calls, 0))
  }
  {
    let cfg = { ...defaults.layeredCompact, enabled: true }, finish, calls = 0
    const stats = createStats(), a = agent('snapshot')
    const ctx = context({ tokenMeter: { measure: () => ({ totalTokens: 70000 }) }, compaction: { compactNow: async () => { calls++; return new Promise((r) => { finish = r }) } } })
    const dispose = createLayeredCompactModule(ctx, () => cfg, stats)
    const pending = ctx.emit('agent/status', { agent: a, status: 'idle' })
    await tick()
    cfg = { ...cfg, highRatio: 0.9 }
    finish({})
    await pending
    await idle(ctx, a)
    expect('进行中的操作完成，下一次检查采用新阈值', () => {
      assert.equal(calls, 1)
      assert.equal(stats.snapshot().counters['layeredCompact.lossy'], 1)
    })
    dispose()
  }
  {
    let calls = 0, prunes = 0
    const current = { legacy: { ...defaults.compactionDriver, minTokens: 0 }, layered: { ...defaults.layeredCompact } }
    const raw = { ...quiet,
      compactionDriver: { get: () => current.legacy },
      layeredCompact: { get: () => current.layered },
    }
    const ctx = context({
      tokenMeter: { measure: () => ({ totalTokens: 70000 }) },
      toolResultPruner: { pruneSession() { prunes++ } },
      compaction: { compactNow: async () => { calls++; return {} } },
    })
    const dispose = apply(ctx, raw), a = agent('live')
    await idle(ctx, a)
    expect('初始控制器、触发与状态一致', () => {
      assert.equal(calls, 1)
      assert.match(ctx.status(a).text, /当前控制器：旧驱动/)
      assert.match(ctx.status(a).text, /旧驱动模型摘要：尝试 1 \/ 成功 1/)
    })
    current.layered = { ...current.layered, enabled: true, highRatio: 0.8 }
    await idle(ctx, a)
    expect('不用重挂插件切换分层，旧驱动互斥', () => {
      assert.equal(prunes, 1)
      assert.equal(calls, 1)
      assert.match(ctx.status(a).text, /当前控制器：分层/)
      assert.match(ctx.status(a).text, /模型摘要 80.0%/)
    })
    current.layered = { ...current.layered, highRatio: 0.6 }
    await idle(ctx, a)
    expect('降低摘要阈值后下一次检查采用活值', () => assert.equal(calls, 2))
    current.layered = { ...current.layered, enabled: false }
    current.legacy = { ...current.legacy, enabled: false }
    await idle(ctx, a)
    expect('关闭后不再动作；记录仍在且内核安全机制标明', () => {
      assert.equal(calls, 2)
      assert.equal(prunes, 2)
      assert.match(ctx.status(a).text, /当前控制器：插件自动压缩关闭/)
      assert.match(ctx.status(a).text, /内核安全压缩仍由宿主控制/)
      assert.match(ctx.status(a).text, /原文归档：.*"enabled":false/)
    })
    let writes = 0
    expect('宿主写盘前校验拒绝交叉阈值', () => {
      assert.throws(() => { ctx.validate({ ...quiet, layeredCompact: { highRatio: 0.4 } }); writes++ }, /阈值/)
      assert.equal(writes, 0)
    })
    const saved = { ...quiet, compactionDriver: current.legacy, layeredCompact: current.layered }
    dispose()
    const next = context({ tokenMeter: { measure: () => ({ totalTokens: 70000 }) } })
    const stop = apply(next, saved)
    expect('保存数据重启后控制器与阈值一致；无摘要服务不拖垮插件', () => {
      assert.match(next.status(a).text, /当前控制器：插件自动压缩关闭/)
      assert.match(next.status(a).text, /模型摘要 60.0%/)
    })
    stop()
  }

  // 精确复用当前宿主 schema 和设置投影函数，不加载桌面或真实 profile。
  if (process.env.DSH_OPTIMIZER_HOST_FIXTURE) {
    const folder = pathToFileURL(process.env.DSH_OPTIMIZER_HOST_FIXTURE.replace(/\\/g, '/') + '/')
    const S = (await import(new URL('node_modules/@deepseek-ai/schemastery/lib/index.mjs', folder))).default
    const { updateVolatile } = await import(new URL('node_modules/@deepseek-ai/cosmokit/lib/index.js', folder))
    const schema = buildConfigSchema(S)
    const source = readFileSync(new URL('settings-contract.js', folder), 'utf8')
    const get = (name) => {
      const start = source.indexOf('function ' + name + '(')
      assert.ok(start >= 0, 'missing host function ' + name)
      return source.slice(start, source.indexOf('\n}', start) + 2)
    }
    const sandbox = { z: S, isPlainObject: (v) => v !== null && typeof v === 'object' && !Array.isArray(v) }
    vm.createContext(sandbox)
    vm.runInContext(['isRecord', 'walk', 'redactSecrets', 'plainSchema', 'volatileForm', 'isExpression', 'projectForm'].map(get).join('\n'), sandbox)
    const raw = { ...quiet, compactionDriver: { minTurns: 9, minTokens: 12345, maxCompactionsPerSession: 7, contextWindow: 555555, timeoutMs: 54321 },
      layeredCompact: { highTierTimeoutMs: 45678, highTierMaxPerSession: 4, sessionWindowFallback: 888888, pricing: { inputPerMillion: 5, cacheHitPerMillion: 6, outputPerMillion: 7 } } }
    const projected = sandbox.projectForm(sandbox.volatileForm(schema), raw)
    const updated = { ...projected, layeredCompact: { ...projected.layeredCompact, enabled: true, lowRatio: 0.45, midRatio: 0.55, highRatio: 0.75 } }
    expect('宿主投影保留旧驱动限制、分层超时/次数/窗口/价格', () => {
      assert.deepEqual(JSON.parse(JSON.stringify(projected)), { compactionDriver: raw.compactionDriver, layeredCompact: raw.layeredCompact })
      const resolved = resolveConfig(schema(updated))
      assert.equal(resolved.compactionDriver.minTokens, 12345)
      assert.equal(resolved.layeredCompact.highTierMaxPerSession, 4)
      assert.equal(resolved.layeredCompact.pricing.inputPerMillion, 5)
    })
    expect('真实 volatile 引用更新后可读到新值，重启解析一致', () => {
      const active = schema(raw), next = schema(updated)
      updateVolatile(active.layeredCompact, next.layeredCompact)
      assert.equal(resolveCompressionConfig(active).layeredCompact.highRatio, 0.75)
      assert.equal(resolveCompressionConfig(schema(updated)).layeredCompact.highRatio, 0.75)
    })
    expect('schema JSON 往返支持设置投影，无函数序列化依赖', () => {
      const copy = new S(schema.toJSON())
      assert.equal(resolveCompressionConfig(copy(updated)).layeredCompact.highRatio, 0.75)
    })
  } else console.log('  host contract checks skipped (set DSH_OPTIMIZER_HOST_FIXTURE for installed-host fixtures)')

  // 逻辑层模拟 React/slot/configForms；不冒充真实桌面视觉验收。
  const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  function ui(initial, mutateResult = true) {
    let snapshot = initial, component, module, cursor = 0, renderedHooks, writes = [], disposed = 0
    const states = [], effects = []
    const react = {
      createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat() } } },
      useSyncExternalStore() { cursor++; return snapshot },
      useState(init) {
        const i = cursor++
        if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
        return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
      },
      useEffect(fn, deps) {
        const i = cursor++
        if (JSON.stringify(effects[i]) !== JSON.stringify(deps)) { effects[i] = deps; fn() }
      },
    }
    vm.runInNewContext(clientSource, { window: { __ModuleLoader__: { load(spec) { module = spec.factory(() => react) } } } })
    const form = {
      getSnapshot: () => snapshot, subscribe: () => () => {},
      async mutate(ops) { writes.push(ops); if (mutateResult instanceof Error) throw mutateResult; return mutateResult },
    }
    const cleanup = module.apply({
      slots: { register(meta, view) { assert.equal(meta.name, 'settings.general.item'); assert.equal(typeof view, 'function'); component = view; return () => { disposed++ } } },
      configForms: { get: () => form, whileServed: () => () => { disposed++ } },
    })
    const render = () => { cursor = 0; const tree = component(); renderedHooks = cursor; return tree }
    const all = (tree) => typeof tree !== 'object' || !tree ? [] : [tree, ...tree.props.children.flatMap(all)]
    const text = (tree) => typeof tree === 'string' ? tree : tree?.props ? tree.props.children.map(text).join(' ') : ''
    const input = (label) => all(render()).find((n) => n.props['aria-label'] === label)
    const click = (label) => all(render()).find((n) => n.type === 'button' && (!label || text(n) === label)).props.onClick()
    return { render, text, input, click, writes, hooks: () => renderedHooks, cleanup, disposed: () => disposed, setSnapshot(value) { snapshot = value } }
  }
  const ready = { status: 'ready', writable: true, value: resolveConfig({}) }
  {
    const view = ui(ready)
    expect('通用设置包含独立阈值、策略和仅观测说明', () => {
      assert.ok(view.input('工具历史清理阈值'))
      assert.ok(view.input('模型摘要阈值'))
      assert.match(view.text(view.render()), /仅观测，不压缩/)
      assert.equal(view.input('自动压缩策略').props.value, 'legacy')
    })
    view.input('模型摘要阈值').props.onChange({ target: { value: '' } })
    await view.click()
    expect('清空输入不写 0、不发保存请求', () => {
      assert.equal(view.writes.length, 0)
      assert.match(view.text(view.render()), /未保存/)
    })
    view.input('模型摘要阈值').props.onChange({ target: { value: '45' } })
    await view.click()
    expect('交叉阈值在客户端拒绝', () => assert.equal(view.writes.length, 0))
    view.input('模型摘要阈值').props.onChange({ target: { value: '75' } })
    view.input('自动压缩策略').props.onChange({ target: { value: 'layered' } })
    await view.click()
    expect('一次原子提交两个开关与全部阈值，明确生效时机', () => {
      assert.equal(view.writes.length, 1)
      assert.equal(view.writes[0].length, 6)
      const ops = JSON.parse(JSON.stringify(view.writes[0]))
      assert.deepEqual(ops.slice(0, 2).map((o) => o.value), [true, false])
      assert.equal(ops[4].value, 0.75)
      assert.match(view.text(view.render()), /下一次压缩检查采用新配置/)
    })
    view.cleanup()
    view.cleanup()
    expect('客户端卸载释放 slot 与订阅，清理可重复', () => assert.equal(view.disposed(), 2))
  }
  {
    const view = ui(ready)
    expect('归档UI默认关闭且提供目录、独立保存与重试', () => {
      assert.equal(view.input('启用原文归档').props.checked, false)
      assert.ok(view.input('原文归档目录'))
      assert.match(view.text(view.render()), /写盘失败会阻止相关请求/)
    })
    view.input('启用原文归档').props.onChange({ target: { checked: true } })
    await view.click('保存归档设置')
    expect('归档空路径拒绝保存', () => assert.equal(view.writes.length, 0))
    view.input('原文归档目录').props.onChange({ target: { value: 'D:\\synthetic\\archive' } })
    await view.click('保存归档设置')
    expect('归档单独原子保存且不改压缩阈值、不假报落盘', () => {
      assert.equal(view.writes.length, 1)
      assert.ok(view.writes[0].every(op => op.path[0] === 'archive'))
      assert.match(view.text(view.render()), /写盘状态请查看/)
    })
    view.setSnapshot({ ...ready, value: { ...ready.value, archive: { enabled: true, directory: 'D:\\old', previousDirectories: [], retryGeneration: 8 } } })
    view.render(); view.render()
    view.input('原文归档目录').props.onChange({ target: { value: 'E:\\new' } })
    await view.click('保存归档设置')
    expect('换目录保留旧目录索引，不自动搬文件', () => assert.deepEqual(JSON.parse(JSON.stringify(view.writes.at(-1)[2].value)), ['D:\\old']))
    await view.click('重试归档')
    expect('UI显式重试只更新计数且不把提交当成写盘成功', () => {
      assert.equal(view.writes.at(-1).length, 1)
      assert.equal(view.writes.at(-1)[0].value, 9)
      assert.match(view.text(view.render()), /已提交重试；写盘是否成功/)
    })
    view.cleanup()
  }
  for (const result of [false, null, new Error('disk rejected')]) {
    const view = ui(ready, result)
    await view.click()
    expect('保存拒绝/异常不假报成功 ' + String(result), () => {
      assert.doesNotMatch(view.text(view.render()), /已保存/)
      assert.match(view.text(view.render()), result === null ? /保存结果未确认/ : /保存失败/)
    })
    view.cleanup()
  }
  {
    const view = ui(null)
    const initialHooks = (view.render(), view.hooks())
    expect('未就绪显示默认参考值与不可编辑，不伪称活配置', () => {
      assert.equal(view.input('工具历史清理阈值').props.disabled, true)
      assert.match(view.text(view.render()), /默认参考值，不可编辑/)
    })
    view.setSnapshot(ready); view.render(); view.render()
    expect('服务从未就绪到就绪保持 hooks 数量，可编辑', () => {
      assert.equal(view.hooks(), initialHooks)
      assert.equal(view.input('工具历史清理阈值').props.disabled, false)
    })
    view.setSnapshot({ ...ready, writable: false })
    expect('只读配置明确禁用保存', () => {
      assert.equal(view.input('模型摘要阈值').props.disabled, true)
      assert.match(view.text(view.render()), /当前配置只读/)
    })
    view.cleanup()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0, passed = 0
  await runCompressionChecks((name, ok) => { if (ok) { passed++; console.log('  ok  ' + name) } else { failed++; console.error('FAIL  ' + name) } })
  console.log(passed + ' passed, ' + failed + ' failed')
  process.exitCode = failed ? 1 : 0
}
