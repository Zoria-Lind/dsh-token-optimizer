// Scoped tool availability and bounded MCP discovery; verified against DSH 0.2.1-rc.2.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
}

// 解析核心的 defineTool(不声明为依赖,运行时经 createRequire 借道)。
// 多锚点:插件自身位置(link 挂载时走不到 profile 依赖桥)→ DSH_ROOT →
// DSH_HOME/.dsh 的 profiles/node_modules(CLI 安装器生成的符号链接桥,
// 指回全局 CLI 树,dsh-undo-savepoint 同款依赖)→ 全局 npm 目录。
// 全部失败返回 undefined,mcpLazy 降级禁用,静态裁剪不受影响。
export function resolveDefineTool() {
  const anchors = []
  anchors.push(import.meta.url) // 插件自身位置
  if (process.env.DSH_ROOT) anchors.push(join(process.env.DSH_ROOT, 'package.json'))
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  anchors.push(join(dshHome, 'profiles', 'node_modules', 'noop.js'))
  if (process.env.APPDATA) anchors.push(join(process.env.APPDATA, 'npm', 'node_modules', 'noop.js'))
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      req.resolve('@deepseek-ai/dsh-tools')
      const mod = req('@deepseek-ai/dsh-tools')
      if (mod && typeof mod.defineTool === 'function') return mod.defineTool
    } catch { /* 下一锚点 */ }
  }
  return undefined
}

function getView(tools, agent) {
  try {
    const view = tools?.view?.(agent)
    return view?.restrictableNames instanceof Set && view.visible instanceof Map ? view : null
  } catch { return null }
}

const PAGE_SIZE = 10
const MAX_PAGE = 20
const MAX_LOAD = 20
const label = name => name.length > 200 ? name.slice(0, 200) + '…' : name
const warn = message => console.warn('[dsh-token-optimizer] toolTrim: ' + message)

export function createToolTrimModule(ctx, config, stats, deps = {}) {
  if (!config?.enabled || typeof ctx?.on !== 'function') return () => {}
  // null/omitted means unrestricted; [] intentionally allows no inherited tools.
  const allow = Array.isArray(config.allow) ? new Set(config.allow) : null
  const deny = new Set(config.deny ?? [])
  const defineTool = config.mcpLazy ? (deps.defineTool ?? resolveDefineTool()) : undefined
  const gates = new Map()
  const ownedDefinitions = new WeakSet()
  let closed = false
  let warnedCompatibility = false
  const allowed = name => (allow === null || allow.has(name)) && !deny.has(name)
  const live = gate => !closed && !gate.dead && gates.get(gate.agent.id) === gate
  function dispose(effect) {
    try { effect?.(); return true } catch (err) { warn('撤销失败: ' + (err?.message ?? err)); return false }
  }
  function dropMeta(gate) {
    const effect = gate.metaDisposer
    gate.metaDisposer = undefined
    gate.definition = undefined
    dispose(effect)
  }
  function destroy(gate) {
    gate.dead = true
    gates.delete(gate.agent.id) // invalidate callbacks before effects emit tools/change
    dropMeta(gate)
    dispose(gate.disposer)
    gate.disposer = undefined
    gate.catalog.clear()
    gate.released.clear()
  }

  function mount(gate, view, released, lazyReady) {
    const valid = name => name !== 'run_code' && (!view || view.restrictableNames.has(name))
    const filter = {}
    if (allow !== null) filter.allow = [...allow].filter(valid).sort()
    const hidden = lazyReady ? [...gate.catalog.keys()].filter(name => !released.has(name)) : []
    const blocked = [...new Set([...deny, ...hidden])].filter(valid).sort()
    if (blocked.length) filter.deny = blocked
    const key = JSON.stringify(filter)
    if (gate.filterKey === key) return true
    let effect
    try {
      if (filter.allow !== undefined || filter.deny !== undefined) {
        effect = gate.tools.restrict(filter)
        if (typeof effect !== 'function') throw Error('restrict 未返回可撤销句柄，无法保证过滤替换')
      }
    } catch (err) { warn('过滤未生效: ' + (err?.message ?? err)); return false }
    if (!live(gate)) { dispose(effect); return false }
    const old = gate.disposer
    gate.disposer = effect
    gate.filterKey = key // own mutation events must not remount this filter
    if (!dispose(old)) {
      gate.disposer = () => { effect?.(); old?.() }
      gate.filterKey = undefined
      return false
    }
    if (effect) {
      stats?.bump('tooltrim.applied', 1)
      stats?.addSample({ module: 'tooltrim', allow: filter.allow?.length, deny: blocked.length, mcpReleased: released.size })
    }
    return true
  }

  function registerMeta(gate, view) {
    if (deny.has(config.mcpLoadToolName)) { dropMeta(gate); return false }
    if (gate.metaDisposer && view.visible.get(config.mcpLoadToolName) === gate.definition) return true
    dropMeta(gate)
    const existing = view.visible.get(config.mcpLoadToolName)
    if (view.knownNames?.has(config.mcpLoadToolName) && !ownedDefinitions.has(existing)) {
      warn('发现同名 ' + config.mcpLoadToolName + '，保留原工具并停用该作用域的懒加载')
      return false
    }
    if (typeof gate.tools.register !== 'function') return false
    try {
      const definition = defineTool({
        name: config.mcpLoadToolName,
        description: '搜索和按需加载 MCP 工具。先用 query 搜索名称或描述（空查询浏览目录），用 offset/limit 分页，再用 names 加载精确工具名。只返回有界目录；成功加载的工具出现在后续请求中。遵守用户及父作用域限制；加载失败会说明原因。',
        parameters: {
          query: { type: 'string', description: '可选：工具名、服务器名或描述的关键词；最长 200 字符' },
          offset: { type: 'integer', description: '可选：从第几个匹配结果开始，默认 0' },
          limit: { type: 'integer', description: '可选：每页 1–20 条，默认 10' },
          names: { type: 'array', items: { type: 'string' }, description: '可选：要加载的精确工具名，每次最多 20 个；省略则只搜索' },
        },
        output: TEXT_OUTPUT,
        isConcurrencySafe: () => false,
        execute: (args, exec) => execute(args, exec),
      })
      gate.definition = definition
      ownedDefinitions.add(definition)
      const effect = gate.tools.register(definition)
      if (typeof effect !== 'function') throw Error('register 未返回可撤销句柄')
      if (!live(gate)) { dispose(effect); return false }
      gate.metaDisposer = effect
      return getView(gate.tools, gate.agent)?.visible.get(config.mcpLoadToolName) === definition
    } catch (err) {
      gate.definition = undefined
      warn('发现工具注册失败，MCP 保持原可见性: ' + (err?.message ?? err))
      return false
    }
  }

  // Registry and restriction APIs are synchronous in the verified core.
  // Guard reentrancy because both register/restrict/dispose emit tools/change.
  function refresh(gate, proposed) {
    if (!live(gate) || gate.refreshing) return false
    gate.refreshing = true
    try {
      const view = getView(gate.tools, gate.agent)
      const catalog = new Map()
      if (config.mcpLazy && (!view || typeof defineTool !== 'function') && !warnedCompatibility) {
        warnedCompatibility = true
        warn('缺少可靠 tools.view 或 defineTool，停用懒加载并保留显式静态限制')
      }
      if (config.mcpLazy && typeof defineTool === 'function' && view) {
        // Read global definitions for metadata only: a hidden name stays known.
        // This never registers or force-allows a global tool.
        const global = getView(gate.tools, undefined)
        for (const name of [...view.restrictableNames].sort()) {
          if (!name.startsWith(config.mcpPrefix) || name === config.mcpLoadToolName) continue
          const prev = gate.catalog.get(name)
          const definition = view.visible.get(name) ?? global?.visible.get(name) ?? prev?.definition
          const globalDefinition = global?.visible.get(name)
          if (prev && globalDefinition && prev.globalDefinition !== globalDefinition) gate.released.delete(name)
          catalog.set(name, {
            definition, globalDefinition,
            description: definition ? String(definition.description ?? '') : (prev?.description ?? ''),
          })
        }
      }
      if (!gate.detected && catalog.size) { gate.detected = true; stats?.bump('toolgate.mcpDetected', 1) }
      gate.catalog = catalog
      for (const name of gate.released) if (!catalog.has(name) || !allowed(name)) gate.released.delete(name)
      const nextReleased = new Set([...(proposed ?? gate.released)].filter(name => catalog.has(name) && allowed(name)))
      let lazyReady = false
      if (catalog.size && view) lazyReady = registerMeta(gate, view)
      else dropMeta(gate)
      if (!live(gate)) return false
      const ok = mount(gate, view, nextReleased, lazyReady)
      if (ok) gate.released = nextReleased
      return ok && lazyReady
    } finally { gate.refreshing = false }
  }

  function execute(args, exec) {
    const gate = gates.get(exec?.agent?.id)
    if (!gate || gate.agent !== exec.agent || !live(gate)) return '未找到本会话的 MCP 门控状态，加载未生效'
    refresh(gate)
    const input = Array.isArray(args?.names) ? args.names : []
    const names = [...new Set(input.slice(0, MAX_LOAD).filter(name => typeof name === 'string'))]
    const before = new Set(gate.released)
    const proposed = new Set(before)
    const failed = [], loaded = []
    for (const name of names) {
      if (!gate.catalog.has(name)) failed.push({ name: label(name), reason: '未知或已断开' })
      else if (!allowed(name)) failed.push({ name: label(name), reason: '用户 allow/deny 限制' })
      else proposed.add(name)
    }
    const attempted = names.filter(name => gate.catalog.has(name) && allowed(name))
    const applied = attempted.length ? refresh(gate, proposed) : false
    const visible = getView(gate.tools, gate.agent)?.visible
    const rollback = new Set(gate.released)
    for (const name of attempted) {
      if (applied && visible?.has(name)) loaded.push(name)
      else {
        failed.push({ name: label(name), reason: applied ? '仍受其他作用域限制，尚不可调用' : '加载过滤未生效，请重试' })
        if (!before.has(name)) rollback.delete(name)
      }
    }
    if ([...gate.released].some(name => !rollback.has(name))) refresh(gate, rollback)
    const newlyLoaded = loaded.filter(name => !before.has(name)).length
    if (newlyLoaded) { stats?.bump('toolgate.mcpReleased', newlyLoaded); stats?.bump('toolgate.remounts', 1) }
    const query = typeof args?.query === 'string' ? args.query.slice(0, 200).toLowerCase() : ''
    const offset = Number.isSafeInteger(args?.offset) && args.offset > 0 ? args.offset : 0
    const limit = Number.isSafeInteger(args?.limit) ? Math.max(1, Math.min(MAX_PAGE, args.limit)) : PAGE_SIZE
    const matches = [...gate.catalog].filter(([name, entry]) => allowed(name) && (name.toLowerCase().includes(query) || entry.description.toLowerCase().includes(query)))
    const finalView = getView(gate.tools, gate.agent)
    const items = matches.slice(offset, offset + limit).map(([name, entry]) => ({
      name: label(name), description: entry.description.replace(/\s+/g, ' ').slice(0, 120),
      state: finalView?.visible.has(name) ? 'available' : 'unloaded_or_restricted',
    }))
    return '已放行: ' + (loaded.map(label).join(', ') || '(无)') + '\n' + JSON.stringify({
      failed, ignoredNames: Math.max(0, input.length - MAX_LOAD),
      total: [...gate.catalog.keys()].filter(allowed).length, matched: matches.length, offset, limit,
      nextOffset: offset + items.length < matches.length && items.length ? offset + items.length : null,
      items,
    })
  }

  const onCreated = payload => {
    const agent = payload?.agent
    if (closed || agent?.id === undefined || typeof agent.ctx?.tools?.restrict !== 'function') return
    const previous = gates.get(agent.id)
    if (previous?.agent === agent) return
    if (previous) destroy(previous)
    const gate = { agent, tools: agent.ctx.tools, catalog: new Map(), released: new Set(), dead: false, refreshing: false }
    gates.set(agent.id, gate)
    try { refresh(gate) } catch (err) { warn('初始化失败: ' + (err?.message ?? err)) }
  }
  const onChange = () => {
    if (closed) return
    for (const gate of [...gates.values()]) {
      try { refresh(gate) } catch (err) { warn('刷新失败: ' + (err?.message ?? err)) }
    }
  }
  const onDisposed = payload => {
    const gate = gates.get(payload?.agent?.id)
    if (gate && gate.agent === payload.agent) destroy(gate)
  }
  ctx.on('agent/created', onCreated)
  ctx.on('tools/change', onChange)
  ctx.on('agent/disposed', onDisposed)
  return () => {
    if (closed) return
    closed = true
    ctx.off('agent/created', onCreated)
    ctx.off('tools/change', onChange)
    ctx.off('agent/disposed', onDisposed)
    for (const gate of [...gates.values()]) destroy(gate)
  }
}
