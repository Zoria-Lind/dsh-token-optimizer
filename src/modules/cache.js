// Compatibility entry for retired result caching. Read-only filesystem tools
// depend on cwd and mutable external state; TTL does not prove validity.
// Even legacy enabled:true must execute the tool rather than reuse stale data.
export function createCacheModule(ctx, config, _stats) {
  if (typeof ctx?.on !== 'function') return () => {}
  if (config?.enabled) console.warn('[dsh-token-optimizer] cache 已暂停：缺少可靠失效机制，工具结果始终重新执行')
  const handler = (_exec, next) => next()
  ctx.on('tools/execute', handler)
  return () => ctx.off('tools/execute', handler)
}
