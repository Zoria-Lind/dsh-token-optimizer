// 使用宿主提供的 schema；缺失时不阻断插件，只关闭设置表单。
// 整节 volatile 保证一次保存的阈值在运行端作为一组读取；其它模块保持普通配置。
let Schema
try {
  const mod = await import('@deepseek-ai/schemastery')
  Schema = mod.default ?? mod
} catch { /* 不安装新的依赖 */ }

export function buildConfigSchema(S) {
  return S.object({
    archive: S.object({
      enabled: S.boolean().default(false),
      directory: S.string().default(''),
      previousDirectories: S.array(S.string()).default([]),
      retryGeneration: S.number().min(0).default(0),
    }).volatile(),
    compactionDriver: S.object({
      enabled: S.boolean().default(true),
      pressureRatio: S.number().min(0).max(1).default(0.45),
      minTurns: S.number().min(0).default(6),
      minTokens: S.number().min(0).default(100000),
      maxCompactionsPerSession: S.number().min(0).default(3),
      contextWindow: S.number().min(1).default(1000000),
      timeoutMs: S.number().min(1).default(120000),
    }).volatile(),
    layeredCompact: S.object({
      enabled: S.boolean().default(false),
      lowRatio: S.number().min(0).max(1).default(0.4),
      midRatio: S.number().min(0).max(1).default(0.5),
      highRatio: S.number().min(0).max(1).default(0.65),
      highTierTimeoutMs: S.number().min(1).default(120000),
      highTierMaxPerSession: S.number().min(0).default(2),
      sessionWindowFallback: S.number().min(1).default(262144),
      pricing: S.object({
        inputPerMillion: S.number().min(0).default(0.8),
        cacheHitPerMillion: S.number().min(0).default(0.23),
        outputPerMillion: S.number().min(0).default(2.8),
      }),
    }).volatile(),
  })
}
let built
try { built = Schema ? buildConfigSchema(Schema) : undefined } catch { /* 服务不兼容时降级 */ }
export const Config = built
