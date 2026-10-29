// Compatibility entry for retired cross-call file diffs. A remembered file
// is not proof that its complete baseline remains in the model's request.
// Session compaction events alone cannot prove all context projections.
// Keep the final downstream decision intact, including content and metadata.
export function createFileDiffModule(ctx, config, _stats) {
  if (typeof ctx?.on !== 'function') return () => {}
  if (config?.enabled) console.warn('[dsh-token-optimizer] fileDiff 已暂停：无法确认当前请求仍持有完整基线，保留原文')
  const handler = (_exec, _result, next) => next()
  ctx.on('tools/post-execute', handler)
  return () => ctx.off('tools/post-execute', handler)
}
