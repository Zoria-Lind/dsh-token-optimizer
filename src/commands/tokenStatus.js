// /token-status 命令(T5):一期可观测出口。注册姿势 P6;handler 只允许 success/error 两种 kind。
// invocation = {commandId, agent, rawInput, attachments, signal}——没有 session/cwd,会话走
// invocation.agent?.session。设置页(客户端半边)一期不做:P5——缺 bundle 基建,不是"暂缓"。
//
// ⚠ 宿主侧 ctx.get('tokenMeter') 在未声明 inject 时会抛(真实事故,见 compactionDriver
// 头注释)→ 本模块自己 ctx.inject(['tokenMeter']) 拿服务,再用合成 ctx 喂 computePressure。
// 分桶键:layeredCompact 以 agent.id 分桶(与它的 per-agent 状态一致),本命令读数用同一键,
// 否则"各层触发次数"永远是 0(会话 id 与 agent id 在内核里是两个不同的东西)。
//
// 输出口径(0C/T5):
//   - 压力比 + 窗口来源(实测/回落值必须可区分,computePressure 的 windowSource)
//   - 观测层触发次数(注明不降压力)
//   - 无损层省下 token(生效次数 / 无可裁剪次数分开显示,空转不许报成成功)
//   - 有损层次数
//   - 估算节省 token 与金额(粗估,实际以 usage 为准)
import { computePressure } from '../modules/compactionDriver.js'

export function registerTokenStatusCommand(ctx, config, stats) {
  const disposers = []
  let meter
  try {
    ctx.inject?.(['tokenMeter'], (svc) => {
      meter = svc.tokenMeter
    })
  } catch { /* inject 不可用:压力比将显示不可用 */ }

  ctx.inject?.(['commands'], (svc) => {
    try {
      disposers.push(svc.commands.register({
        name: 'token-status',
        description: '查看 token 优化状态(压力比/分层触发次数/估算节省)',
        handler: (invocation) => {
          try {
            const session = invocation?.agent?.session
            const snap = stats.snapshot()
            const counters = snap.counters
            // 分桶键必须与 layeredCompact 写入侧一致(agent.id)
            const sessionKey = invocation?.agent?.id ?? session?.id
            const sessionCounters = sessionKey !== undefined ? stats.snapshotSession(sessionKey).counters : {}

            // 字符节省:ladder 的计数 + filediff 的样本(两者口径不同,合并展示)
            const savedChars = (counters['ladder.savedChars'] ?? 0)
              + snap.samples.filter((s) => s?.module === 'filediff').reduce((sum, s) => sum + (s.savedChars ?? 0), 0)
            const savedTokens = stats.estimateTokens(savedChars)
            const cost = stats.estimateCost({ inputTokens: savedTokens }, config.pricing)

            const p = session
              ? computePressure({ get: (k) => (k === 'tokenMeter' ? meter : undefined) }, session, config.sessionWindowFallback)
              : null
            const lines = []
            lines.push(p === null
              ? '压力比:不可用(无 tokenMeter 或会话为空)'
              : `压力比 ${(p.ratio * 100).toFixed(1)}%(已用 ${p.totalTokens} / 窗口 ${p.window},窗口来源:${p.windowSource === 'event' ? '实测' : '回落值,仅兜底口径'})`)
            lines.push(`观测层触发 ${sessionCounters['layeredCompact.observed'] ?? 0} 次(不降压力,仅记账)`)
            lines.push(`无损层省下 ${sessionCounters['layeredCompact.pruneSavedTokens'] ?? 0} token(${sessionCounters['layeredCompact.lossless'] ?? 0} 次生效 / ${sessionCounters['layeredCompact.pruneNoop'] ?? 0} 次无可裁剪${sessionCounters['layeredCompact.pruneUnavailable'] ? `,${sessionCounters['layeredCompact.pruneUnavailable']} 次 pruner 缺席` : ''})`)
            lines.push(`有损层 ${sessionCounters['layeredCompact.lossy'] ?? 0} 次${sessionCounters['layeredCompact.backedOff'] ? '(本会话检测到手动/其他压缩,已退避)' : ''}`)
            lines.push(`投影级节省(未来生效):约 ${savedChars} 字符 ≈ ${savedTokens} token ≈ ${cost.toFixed(4)} 元(粗估,实际以 usage 为准)`)
            return { kind: 'success', text: lines.join('\n') }
          } catch (err) {
            return { kind: 'error', text: `token-status 失败:${err?.message ?? err}` }
          }
        },
      }))
    } catch (err) {
      console.warn(`[dsh-token-optimizer] /token-status 注册失败(${err?.message ?? err})`)
    }
  })
  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* noop */ }
    }
  }
}
