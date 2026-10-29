import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createArchiveModule } from '../src/modules/archive.js'
import { restrictSessionService } from './host-service-guard.mjs'
import { resolveArchiveConfig, resolveConfig } from '../src/config.js'
import { fixture as availabilityFixture } from './availability.mjs'

const root = process.env.DSH_TO03_STATE
assert.ok(root, 'Use isolated test runner with DSH_TO03_STATE')
const fixture = join(root, '..', '..', '..', 'host')
const host = {}
for (const manifest of ['host-fixtures.json', 'checkpoint-fixtures.json']) {
  const rows = JSON.parse(await fs.readFile(join(root, '..', '..', '..', '..', '_evidence', 'TO-03', manifest), 'utf8'))
  for (const row of rows) {
    const bytes = await fs.readFile(row.copy)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256)
    host[row.inside.split('/')[3]] = bytes.toString('utf8')
  }
}
function clip(text, start, end) {
  const i = text.indexOf(start), j = text.indexOf(end, i + start.length)
  assert.ok(i >= 0 && j > i, start)
  return text.slice(i, j)
}
const loop = host['dsh-agent-loop']
const Inbox = vm.runInNewContext(clip(loop, 'var ReactLoopInbox = class {', '//#endregion') + '\nReactLoopInbox')
const preStep = vm.runInNewContext('({' + clip(loop, '\tasync preStep(target, position) {', '\t/** Whether the assembled tool schemas differ') + '})', {
  assembleContextFor: () => ({}), renderContextSections: () => [], joinContextSections: () => '',
}).preStep
const policy = vm.runInNewContext(host['dsh-session-checkpoint-policy'].replace(/^import .*\n/, '').replace(/export \{[^]*$/, '') + '\napply', { TOOL_ABORTED_BEFORE_DISPATCH: 'stub' })
const flush = vm.runInNewContext('({' + clip(host['dsh-session'], '\tasync flush(session) {', '\t/** Return the exact live entry') + '})', {
  collectSessionCallbacks: (ctx, args) => ctx.handlers.get(args[1]) ?? [],
}).flush
const streamWithRegistration = vm.runInNewContext('({' + clip(host['dsh-llm'], '\t\tstreamWithRegistration(options, prepared) {', '\n\t};') + '})').streamWithRegistration
const defineTool = vm.runInNewContext(clip(host['dsh-tools'], '//#region lib/types/json-schema.js', '//#region lib/types/ptc-calls.js') + '\ndefineTool', {
  HarnessError: Error,
  assertNever(value) { throw new Error('unexpected value: ' + value) },
  isJsonValue(value) { try { return JSON.stringify(value) !== undefined } catch { return false } },
})
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const original = { id: 'u-1', source: { kind: 'user' }, content: [{ type: 'text', text: '虚构原文\n  a  b  \n预算318元；截止周五17:23。😀' }] }
const deadline = async predicate => {
  const until = Date.now() + 3000
  while (!predicate()) { assert.ok(Date.now() < until, 'condition timeout'); await new Promise(r => setTimeout(r, 10)) }
}
function harness(name, { enabled = true, fault, checkpoint = true } = {}) {
  const cfg = { archive: { enabled, directory: join(root, name), previousDirectories: [], retryGeneration: 0 } }
  const handlers = new Map(), commands = new Map(), definitions = new Map(), trace = []
  const events = [], pending = { 'next-step': [], 'next-turn': [] }
  const session = {
    id: 'synthetic-' + name,
    get seq() { return events.length },
    snapshotEvents(from = 0) { return events.slice(from) },
    append(type, data) {
      const event = { seq: events.length, time: new Date().toISOString(), type, data: structuredClone(data) }
      events.push(event)
      if (type === 'agent/inbox/spliced') {
        const splice = event.data
        pending[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      }
      ctx.emit('session/event', session, event)
      return event
    },
  }
  const ctx = {
    handlers,
    on(name, fn, opts) { const list = handlers.get(name) ?? []; opts?.prepend ? list.unshift(fn) : list.push(fn); handlers.set(name, list); return () => this.off(name, fn) },
    off(name, fn) { const a = handlers.get(name); if (a?.includes(fn)) a.splice(a.indexOf(fn), 1) },
    emit(name, ...args) { for (const fn of [...handlers.get(name) ?? []]) fn(...args) },
    waterfall(_this, name, payload, end) {
      const list = [...handlers.get(name) ?? []]
      const run = index => index === list.length ? end() : list[index](payload, () => run(index + 1))
      return run(0)
    },
    sessions: { get: id => id === session.id ? session : undefined, flush, liveEntryFor: () => ({ carrier: {} }) },
    inject(names, callback) {
      const cleanups=[]
      callback({ sessions: ctx.sessions, effect(fn) { const cleanup=fn(); if(typeof cleanup==='function') cleanups.push(cleanup) },
        commands: { register(command) { commands.set(command.name, command); return () => commands.delete(command.name) } } })
      return { dispose() { for(const cleanup of cleanups.splice(0)) cleanup() } }
    },
  }
  ctx.sessions.ctx = ctx
  const agent = { id: 'agent-' + name, session, ctx: { tools: {
    register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name) },
    restrict() { return () => {} },
    view() { return { restrictableNames: new Set(['read', 'mcp__x__y']), visible: definitions } },
  } }, phase: { kind: 'running', abort: new AbortController() },
    loopCtx: { systemPrompt: { async assemble() { return {} } } }, runtimeContext: { project() {} },
    dispatch: { emit(name, p) { ctx.emit(name, { ...p, agent }) }, waterfall(name, p, next) { return ctx.waterfall(agent, name, { ...p, agent }, next) } },
    preStep,
  }
  agent.inbox = new Inbox({ stateOf: () => pending }, session, agent.dispatch)
  const io = { ...fs, async open(path, flags) {
    const h = await fs.open(path, flags)
    if (!['r+', 'wx+'].includes(flags)) return h
    return new Proxy(h, { get(target, prop) {
      if (prop === 'sync') return async () => { await fault?.('sync', target); await target.sync(); trace.push('durable-ack') }
      if (prop === 'write') return async (...args) => { await fault?.('write', target, args); return target.write(...args) }
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
  if (checkpoint) policy(ctx)
  const archive = createArchiveModule(restrictSessionService(ctx), () => cfg, { fs: io, defineTool })
  ctx.emit('agent/created', { agent })
  const send = (message = original) => agent.inbox.append('next-turn', structuredClone(message))
  const step = async () => {
    const decision = await agent.preStep('next-turn', { turn: 1, step: 1 })
    agent.phase.abort.signal.throwIfAborted()
    if (decision.kind === 'enter') for (const m of decision.messages) { trace.push('admit'); session.append('user/message', m) }
    return decision
  }
  let modelCalls = 0
  const model = async (purpose = 'agent-loop') => {
    const stream = streamWithRegistration.call({ ctx, adapterStream() { modelCalls++; trace.push('dispatch:' + purpose); return (async function* () { yield { type: 'finish' } })() } },
      { sessionId: session.id, purpose, signal: agent.phase.abort.signal })
    for await (const _ of stream) {}
  }
  return { cfg, ctx, session, agent, archive, commands, definitions, trace, events, pending, send, step, model, calls: () => modelCalls }
}

// This composes exact installed preStep/Inbox/flush/checkpoint/LLM dispatch methods.
// Session persistence, context assembly, projections and provider remain explicit test collaborators.
test('raw fsync precedes transformations and admission; exact Unicode/raw blocks survive', { timeout: 8000 }, async () => {
  const gate = deferred(), entered = deferred()
  let held = true
  const h = harness('before-input', { fault: async type => { if (type === 'sync' && held) { entered.resolve(); await gate.promise } } })
  h.ctx.on('agent/pre-step', async (_payload, next) => {
    const result = await next(); h.trace.push('transform')
    return { ...result, messages: result.messages.map(m => ({ ...m, content: [{ type: 'text', text: '摘要' }] })) }
  })
  try {
    h.send(); let done = false; const task = h.step().then(r => { done = true; return r })
    await entered.promise
    assert.equal(done, false); assert.equal(h.trace.includes('transform'), false); assert.equal(h.events.some(e => e.type === 'user/message'), false)
    held = false; gate.resolve(); await task; await h.archive.ensure(h.session)
    assert.ok(h.trace.indexOf('durable-ack') < h.trace.indexOf('transform'))
    assert.ok(h.trace.indexOf('transform') < h.trace.indexOf('admit'))
    const result = await h.archive.query(h.session, { action: 'search', query: '预算318元' })
    const meta = result.records.find(r => r.role === 'user-original')
    assert.ok(meta)
    const raw = await h.archive.query(h.session, { action: 'read', key: meta.key })
    assert.equal(raw.text, original.content[0].text)
    const files = await fs.readdir(h.cfg.archive.directory)
    const records = (await Promise.all(files.map(f => fs.readFile(join(h.cfg.archive.directory, f), 'utf8')))).join('').trim().split('\n').map(JSON.parse)
    assert.deepEqual(records.find(r => r.kind === 'input').message, original)
    assert.equal(records.filter(r => r.kind === 'input').length, 1)
  } finally { gate.resolve(); await h.archive.dispose() }
})

test('failure pauses claimed input; explicit retry commits it once before dispatch', { timeout: 8000 }, async () => {
  let fail = true, writes = 0
  const h = harness('retry', { fault(type) { if (type === 'write') { writes++; if (fail) throw Object.assign(new Error('fake no disk'), { code: 'ENOSPC' }) } } })
  try {
    h.send(); let done = false; const task = h.step().then(() => { done = true })
    await deadline(() => !!h.archive.status(h.session).error)
    assert.equal(done, false); assert.equal(h.calls(), 0); assert.equal(h.events.some(e => e.type === 'user/message'), false)
    const attempts = writes
    await new Promise(r => setTimeout(r, 130)); assert.equal(writes, attempts)
    fail = false
    const reply = await h.commands.get('token-archive-retry').handler({ agent: h.agent })
    assert.equal(reply.kind, 'success')
    await task; await h.model(); assert.equal(h.calls(), 1)
    const result = await h.archive.query(h.session, { action: 'search' })
    assert.equal(result.records.filter(r => r.role === 'user-original').length, 1)
  } finally { fail = false; h.cfg.archive.enabled = false; await h.archive.dispose() }
})

test('cancellation restores unadmitted input and does not automatically execute it', { timeout: 8000 }, async () => {
  const h = harness('cancel', { fault(type) { if (type === 'write') throw Object.assign(new Error('fake access'), { code: 'EACCES' }) } })
  try {
    h.send(); const task = h.step()
    const rejected = assert.rejects(task)
    await deadline(() => !!h.archive.status(h.session).error)
    h.agent.phase.abort.abort({ kind: 'user' }); await rejected
    assert.deepEqual(JSON.parse(JSON.stringify(h.agent.inbox.nextStep)), [original])
    assert.equal(h.calls(), 0)
    h.session.append('turn/end', { reason: { kind: 'aborted' } })
    assert.equal(h.agent.inbox.nextStep.length, 1)
  } finally { h.cfg.archive.enabled = false; await h.archive.dispose() }
})

for (const recovery of ['path', 'off']) test('paused input can recover by ' + recovery, { timeout: 8000 }, async () => {
  let fail = true
  const h = harness('recovery-' + recovery, { fault(type) { if (type === 'write' && fail) throw Object.assign(new Error('fake disk'), { code: 'EIO' }) } })
  try {
    h.send(); const task = h.step()
    await deadline(() => !!h.archive.status(h.session).error)
    if (recovery === 'path') { h.cfg.archive.directory = join(root, 'changed-path'); fail = false }
    else h.cfg.archive.enabled = false
    await task
    assert.equal(h.events.filter(e => e.type === 'user/message').length, 1)
    if (recovery === 'path') assert.equal(h.archive.status(h.session).error, null)
    else assert.match(h.archive.status(h.session).state, /关闭/)
  } finally { fail = false; h.cfg.archive.enabled = false; await h.archive.dispose() }
})

for (const purpose of ['agent-loop', 'compaction']) test('output durability gates ' + purpose + ' stream including checkpoint policy', { timeout: 8000 }, async () => {
  let held = true
  const gate = deferred(), entered = deferred()
  const h = harness('output-' + purpose, { fault: async type => { if (type === 'sync' && held) { entered.resolve(); await gate.promise } } })
  try {
    h.session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '虚构回答需要保留细节' }] }, interrupted: true })
    const task = h.model(purpose)
    await entered.promise; assert.equal(h.calls(), 0)
    held = false; gate.resolve(); await task
    assert.equal(h.calls(), 1)
    assert.ok(h.trace.indexOf('durable-ack') < h.trace.indexOf('dispatch:' + purpose))
    const page = await h.archive.query(h.session, { query: '保留细节' })
    assert.equal(page.records[0].role, 'assistant/message')
  } finally { held = false; gate.resolve(); await h.archive.dispose() }
})

test('checkpoint flush rejection blocks dispatch even if policy is registered outside archiver', { timeout: 8000 }, async () => {
  const h = harness('outer-policy', { checkpoint: false, fault(type) { if (type === 'write') throw Object.assign(new Error('fake full'), { code: 'ENOSPC' }) } })
  try {
    // Install a prepended real policy listener outside optimizer's listener.
    const other = { ...h.ctx, on(name, fn) { h.ctx.on(name, fn, { prepend: true }) } }; policy(other)
    h.session.append('assistant/message', { message: { content: '虚构输出' } })
    await assert.rejects(h.model('compaction'))
    assert.equal(h.calls(), 0)
  } finally { h.cfg.archive.enabled = false; await h.archive.dispose() }
})

test('path change/restart deduplicate native events and keep old segments searchable; Unicode paging', { timeout: 8000 }, async () => {
  const h = harness('restart')
  let archive = h.archive
  try {
    const text = '保留😀中文\n  原句  '.repeat(700) + '末尾独特标记739'
    const message = { ...original, content: [{ type: 'text', text }] }
    h.send(message); await h.step(); await archive.ensure(h.session)
    const old = h.cfg.archive.directory
    h.cfg.archive.previousDirectories = [old]; h.cfg.archive.directory = join(root, 'restart-new')
    h.session.append('assistant/message', { message: { content: '新目录中的回复' } })
    await archive.ensure(h.session); await archive.dispose()
    archive = createArchiveModule(h.ctx, () => h.cfg, { defineTool })
    h.ctx.emit('agent/created', { agent: h.agent })
    await archive.ensure(h.session)
    let found = await archive.query(h.session, { query: '末尾独特标记739', limit: 1 })
    const key = found.records[0].key
    assert.equal(found.records[0].role, 'user-original')
    let offset = 0, joined = ''
    do { const part = await archive.query(h.session, { action: 'read', key, offset, limit: 97 }); joined += part.text; offset = part.nextOffset } while (offset !== null)
    assert.equal(joined, text)
    found = await archive.query(h.session, { query: '新目录中的回复' }); assert.equal(found.records.length, 1)
    const first = await archive.query(h.session, { limit: 1 }); assert.ok(first.nextOffset !== null)
    const list = await archive.query(h.session); assert.equal(list.records.filter(r => r.role === 'user-original').length, 1)
  } finally { await archive.dispose() }
})

test('assistant stream captures abandoned frames and does not collide across agent lifecycles', { timeout: 8000 }, async () => {
  const h = harness('stream-lifecycle')
  try {
    const frames = [
      { type: 'start', attemptId: 'same:1', revision: 1, turn: 1, step: 1 },
      { type: 'chunk', attemptId: 'same:1', revision: 2, index: 0, chunk: { type: 'text', text: '部分内容' } },
      { type: 'end', attemptId: 'same:1', revision: 3, index: 1, outcome: { kind: 'abandoned' } },
    ]
    for (let i = 0; i < 2; i++) {
      for (const frame of frames) h.ctx.emit('agent/assistant-stream', { agent: h.agent, frame })
      await h.archive.ensure(h.session)
      h.ctx.emit('agent/disposed', { agent: h.agent }); h.ctx.emit('agent/created', { agent: h.agent })
    }
    const results = await h.archive.query(h.session, { role: 'assistant-stream', query: 'abandoned' })
    assert.equal(results.records.length, 2); assert.notEqual(results.records[0].key, results.records[1].key)
    assert.equal(h.definitions.has('conversation_archive'), true)
    const toolResult = JSON.parse(await h.definitions.get('conversation_archive').execute({ action: 'status' }))
    assert.equal(toolResult.enabled, true)
  } finally { await h.archive.dispose() }
})

for (const failure of ['partial-write', 'fsync']) test(failure + ' rolls back, no premature durable cursor, retry has no duplicate', { timeout: 8000 }, async () => {
  let fail = true
  const h = harness(failure, { async fault(type, handle, args) {
    if (failure === 'fsync' && type === 'sync' && fail) { fail = false; throw Object.assign(new Error('sync fake'), { code: 'EIO' }) }
    if (failure === 'partial-write' && type === 'write' && fail) { await handle.write(args[0], 0, 21, args[3]); throw Object.assign(new Error('partial fake'), { code: 'EIO' }) }
  } })
  try {
    h.send(); await assert.rejects(h.archive.ensure(h.session))
    assert.equal(h.archive.status(h.session).durableEventSeq, -1)
    for (const file of await fs.readdir(h.cfg.archive.directory)) assert.equal((await fs.stat(join(h.cfg.archive.directory, file))).size, 0)
    fail = false; h.cfg.archive.retryGeneration++
    await h.archive.ensure(h.session)
    assert.equal((await h.archive.query(h.session)).records.length, 1)
  } finally { h.cfg.archive.enabled = false; await h.archive.dispose() }
})

test('defaults are off and do not touch directory; invalid enabled paths fail validation', { timeout: 8000 }, async () => {
  const h = harness('off', { enabled: false })
  try {
    assert.equal(resolveConfig({}).archive.enabled, false)
    assert.throws(() => resolveArchiveConfig({ archive: { enabled: true, directory: '' } }))
    assert.throws(() => resolveArchiveConfig({ archive: { enabled: true, directory: 'relative' } }))
    assert.throws(() => resolveArchiveConfig({ archive: { retryGeneration: 0.5 } }))
    h.send(); await h.step(); await h.model()
    await assert.rejects(fs.stat(h.cfg.archive.directory), { code: 'ENOENT' })
    assert.equal(h.definitions.has('conversation_archive'), false)
  } finally { await h.archive.dispose() }
})


test('archive remains visible with empty allow, explicit deny and MCP lazy filtering', async () => {
  const f = availabilityFixture(['read', 'mcp__srv__a'], { allow: [], deny: ['conversation_archive'] })
  const a = f.agent('archive-filter')
  a.session = { id: 'synthetic-filter', snapshotEvents: () => [] }
  const archive = createArchiveModule(f.ctx, { archive: { enabled: true, directory: join(root, 'filter') } }, { defineTool })
  try {
    await f.create(a)
    const visible = f.view(a).visible
    assert.equal(visible.has('read'), false); assert.equal(visible.has('mcp__srv__a'), false)
    assert.equal(visible.has('conversation_archive'), true)
    assert.equal(JSON.parse(await visible.get('conversation_archive').execute({ action: 'status' })).lookupAvailable, true)
  } finally { await archive.dispose(); f.stop() }
})

for (const fail of [false, true]) test('installed compaction transaction ' + (fail ? 'closes without summary/replacement on archive failure' : 'waits for archive before summary/replacement'), { timeout: 8000 }, async () => {
  let held = true
  const gate = deferred(), entered = deferred()
  const h = harness('transaction-' + fail, { fault: async type => { if (type === 'sync' && held) { entered.resolve(); await gate.promise; if (fail) throw Object.assign(new Error('synthetic sync failure'), { code: 'EIO' }) } } })
  class ManualCompactionError extends Error {}
  const compact = vm.runInNewContext(clip(host['dsh-compaction-basic'], 'async function compactSurfaceRegion(', '/** Classify one closed manual attempt') + '\ncompactSurfaceRegion', {
    validateSurfaceRegion: () => ({}), inspectCompactionEntryState: () => ({ openTurn: null }), assertCompactionInactive() {},
    CompactionId: x => x, randomUUID: () => 'synthetic-compact', assertWholeSurfaceUnchanged() {}, assertSelectedSpanStable() {},
    prepareCompaction: () => ({}), async summarizeCompaction() { await h.model('compaction'); return {} },
    commitCompactionBody() { h.trace.push('surface-replaced'); return {} }, completeCompaction: () => ({}),
    errorChain: String, ManualCompactionError, throwManualFailure(f) { throw f.error },
  })
  try {
    // Put real checkpoint policy outside optimizer so failure rejects and closes the native transaction.
    const other = { ...h.ctx, on(name, fn) { h.ctx.on(name, fn, { prepend: true }) } }; policy(other)
    h.session.append('assistant/attempt', { message: { content: '虚构中断的输出' }, outcome: 'interrupted' })
    let done = false
    const task = compact({}, h.session, 0, 1, h.agent, { owner: null, stability: 'whole-surface' }, h.agent.phase.abort.signal).then(v => { done = true; return v })
    const result = task.then(() => ({ ok: true }), () => ({ ok: false }))
    await entered.promise
    assert.equal(done, false); assert.equal(h.calls(), 0); assert.equal(h.trace.includes('surface-replaced'), false)
    held = false; gate.resolve()
    assert.equal((await result).ok, !fail)
    assert.equal(h.calls(), fail ? 0 : 1); assert.equal(h.trace.includes('surface-replaced'), !fail)
    assert.equal(h.events.filter(e => e.type === 'compaction/end').length, 1)
    if (!fail) {
      assert.ok(h.trace.indexOf('durable-ack') < h.trace.indexOf('dispatch:compaction'))
      const found = await h.archive.query(h.session, { query: '中断的输出' })
      assert.equal(found.records[0].role, 'assistant/attempt')
      // The coverage marker confirms an awaited archive checkpoint, not summary success.
      const checkpoints = await h.archive.query(h.session, { role: 'checkpoint' })
      assert.ok(checkpoints.records.length > 0)
    }
  } finally { held = false; gate.resolve(); h.cfg.archive.enabled = false; await h.archive.dispose() }
})


test('disabled archive does not resolve sessions or interfere with a normal request', async () => {
  const handlers=new Map();let calls=0
  const base={on:(n,fn)=>handlers.set(n,fn),off:()=>{},inject:()=>undefined}
  const ctx=restrictSessionService(base)
  assert.throws(()=>ctx.sessions,/without inject/)
  const archive=createArchiveModule(ctx,{archive:{enabled:false}},{defineTool})
  try{
    const stream=handlers.get('llm/stream')({sessionId:'synthetic-disabled'},()=>{calls++;return(async function*(){yield {type:'finish'}})()})
    for await(const frame of stream)assert.equal(frame.type,'finish')
    assert.equal(calls,1)
  }finally{await archive.dispose()}
})

test('enabled archive blocks request when injected sessions are not available', async () => {
  const handlers=new Map();let calls=0
  const ctx=restrictSessionService({on:(n,fn)=>handlers.set(n,fn),off:()=>{},inject:()=>undefined})
  const archive=createArchiveModule(ctx,{archive:{enabled:true,directory:join(root,'unavailable')}},{defineTool})
  try{
    await assert.rejects(async()=>{for await(const frame of handlers.get('llm/stream')({sessionId:'synthetic-missing'},()=>{calls++;return(async function*(){})()})){}},/会话服务.*未就绪/)
    assert.equal(calls,0)
  }finally{await archive.dispose()}
})

test('archive request follows injected sessions lifecycle without stale service use', async () => {
  const handlers=new Map();let injectSessions,release,calls=0,lookups=0
  const ctx=restrictSessionService({on:(n,fn)=>handlers.set(n,fn),off:()=>{},inject:(names,fn)=>{if(names.includes('sessions'))injectSessions=fn}})
  const archive=createArchiveModule(ctx,{archive:{enabled:true,directory:join(root,'lifecycle-request')}},{defineTool})
  const dispatch=async()=>{for await(const frame of handlers.get('llm/stream')({sessionId:'synthetic-lifecycle'},()=>{calls++;return(async function*(){})()})){}}
  const service=()=>({sessions:{get(){lookups++;return undefined}},effect(fn){release=fn()}})
  try{
    injectSessions(service());await dispatch();assert.equal(calls,1);assert.equal(lookups,1)
    release();await assert.rejects(dispatch,/会话服务.*未就绪/);assert.equal(calls,1);assert.equal(lookups,1)
    injectSessions(service());await dispatch();assert.equal(calls,2);assert.equal(lookups,2)
  }finally{await archive.dispose()}
})
