// dsh-token-optimizer: 分层 Token 优化管道(v2)
//
// 真实 DSH 插件 API 说明(与原始方案文档的虚构事件不同):
//   - 插件是 Cordis 插件,入口 export function apply(ctx, config = {})
//   - ctx.on('agent/pre-step', (payload, next) => ...)  改写进入模型的消息(inbox 批次)
//   - ctx.on('tools/execute') / ctx.on('tools/post-execute')  工具执行/结果替换(出生点)
//   - ctx.on('session/disposed')  会话结束
//   - ctx.on('agent/status' | 'agent/created' | 'agent/disposed' | 'session/event' | 'tools/change')
//   - ctx.compaction(compactNow)/ctx.tokenMeter(measure)  经 ctx.get 访问(未声明 inject)
//
// 本插件不重复实现 DSH 已内置的能力:
//   - token-meter(计量/投影)、compaction-basic(LLM 摘要压缩,可逆)、
//     tool-result-pruner(8192 字符,仅压缩触发)、spill(>50k 字节落盘可检索)
//
// v3 模块清单:
//   1. text2img  长文本→图片→vision 摘要(超长自然语言文本;单次样本曾省 ~72%,真正的价值是"会话越长越省")
//   2. outputLadder 工具输出出生点分流:错误摘要 / JSON-CSV 结构压缩 / shell 采样,原文落盘可逆
//   3. cache     已暂停(默认关闭;缺少可靠文件失效证明,旧配置也只透传)
//   4. monitor   会话结束统计报告(真实 usage 聚合与缓存命中率)
//   5. fileDiff  已暂停(默认关闭;无法证明当前请求仍持有完整基线)
//   6. toolTrim  工具可见性管理:静态 allow/deny 裁剪 + MCP 懒加载
//      (mcp_load_tools 元工具按名称/描述搜索与分页,无 MCP 部署自动 no-op)
//   7. compactionDriver / layeredCompact  压缩调度:agent idle 时按配置阈值驱动核心压缩
//   8. archive   runtime 原文归档:输入先落盘再进上下文,输出在后续请求/摘要前确认写入
//   9. client    通用设置中的“Token 优化与压缩”面板
//
// v1 的 compress/sample/pruning/dedup 已退役(dedup 作用面趋零;其余合并进
// outputLadder;旧配置节会被静默忽略并提示,不会炸插件树)。

import { DEFAULT_CONFIG, resolveConfig, resolveCompressionConfig, compressionMode } from './config.js'
import { createText2imgModule } from './modules/text2img.js'
import { createOutputLadderModule } from './modules/outputLadder.js'
import { createCacheModule } from './modules/cache.js'
import { createMonitorModule } from './modules/monitor.js'
import { createFileDiffModule } from './modules/fileDiff.js'
import { createToolTrimModule } from './modules/toolTrim.js'
import { createCompactionDriverModule } from './modules/compactionDriver.js'
import { createLayeredCompactModule } from './modules/layeredCompact.js'
import { registerTokenStatusCommand } from './commands/tokenStatus.js'
import { createArchiveModule } from './modules/archive.js'
import { createStats } from './stats.js'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 调试日志:默认关闭,需要排查时设 DSH_TOKEN_OPTIMIZER_DEBUG=1 才写盘
const DEBUG_LOG = !!process.env.DSH_TOKEN_OPTIMIZER_DEBUG
const DEBUG_LOG_PATH = process.env.DSH_TOKEN_OPTIMIZER_DEBUG_LOG || join(homedir(), '.dsh', 'token-optimizer-debug.log')
function debugLog(msg) {
  if (!DEBUG_LOG) return
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
  } catch { /* 忽略日志失败 */ }
}

debugLog('module loaded, apply defined: ' + typeof apply)

export function apply(ctx, config = {}) {
  debugLog('apply() CALLED with config keys: ' + (Object.keys(config ?? {}).join(',') || '(empty)'))
  const resolved = resolveConfig(config)
  const stats = createStats()

  const modules = []
  // 最早注册并 prepend，原始输入写盘后才进入其它改写/压缩中间件。
  const archive = createArchiveModule(ctx, () => config)
  modules.push(() => archive.dispose())
  if (resolved.text2img.enabled) modules.push(createText2imgModule(ctx, resolved.text2img, stats))
  if (resolved.outputLadder.enabled) modules.push(createOutputLadderModule(ctx, resolved.outputLadder, stats))
  if (resolved.cache.enabled) modules.push(createCacheModule(ctx, resolved.cache, stats))
  if (resolved.monitor.enabled) modules.push(createMonitorModule(ctx, resolved.monitor, stats))
  if (resolved.fileDiff.enabled) modules.push(createFileDiffModule(ctx, resolved.fileDiff, stats))
  if (resolved.toolTrim.enabled) modules.push(createToolTrimModule(ctx, resolved.toolTrim, stats))
  // 保存前校验整组阈值。宿主 configEditor 在写盘前调用 internal/config；
  // 限定到本插件 fiber，避免对子插件的配置施加本插件的校验。
  function validateConfig(value, next) {
    const candidate = next()
    if (!ctx.fiber || this === ctx.fiber) resolveConfig(candidate)
    return candidate
  }
  ctx.on('internal/config', validateConfig)
  modules.push(() => ctx.off?.('internal/config', validateConfig))
  const readCompression = () => resolveCompressionConfig(config)
  // 两套监听常驻，按活配置互斥；配额和统计不因切换控制器而清空。
  modules.push(createCompactionDriverModule(ctx, () => {
    const current = readCompression()
    return { ...current.compactionDriver, enabled: compressionMode(current) === 'legacy' }
  }, stats))
  modules.push(createLayeredCompactModule(ctx, () => {
    const current = readCompression()
    return { ...current.layeredCompact, enabled: compressionMode(current) === 'layered' }
  }, stats))
  modules.push(registerTokenStatusCommand(ctx, readCompression, stats, archive))
  // 插件卸载时清理所有注册的钩子
  return () => {
    for (const cleanup of modules) cleanup()
    stats.dispose()
  }
}

export { DEFAULT_CONFIG, resolveConfig }

export { Config } from './configSchema.js'
