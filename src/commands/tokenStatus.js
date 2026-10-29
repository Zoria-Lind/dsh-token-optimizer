// /token-status 是会话观测入口；所有读数与驱动读取同一组活配置。
import { compressionMode } from '../config.js'
import { computePressure, compressionServices } from '../modules/compactionDriver.js'

const labels = {
  running: '摘要请求处理中（是否已调用模型尚未确认）',
  success: '成功', noop: '无可清理/无安全有效摘要区段',
  observed: '仅观测，未压缩', below: '未达到触发条件',
  unavailable: '所需服务不可用', noPressure: '无法取得可靠读数',
  noHistory: '无法读取轮数', minTurns: '轮数不足', limit: '达到成功次数上限',
  busy: '内核忙（手动压缩、队列或其他维护占用）', backedOff: '检测到占用，本会话已停止自动摘要',
  backoff: '同一历史短暂退避，尚未重试', cancelled: '已取消',
  timeout: '超时', failed: '失败', unknown: '失败（原因未分类）',
  result: '失败（内核返回无效结果）',
}
const modeLabel = { legacy: '旧驱动', layered: '分层', off: '插件自动压缩关闭' }
const pct = (v) => (v * 100).toFixed(1) + '%'
const tokens = (p) => p ? String(p.totalTokens) : '不可用'

export function registerTokenStatusCommand(ctx, config, stats, archive) {
  const read = typeof config === 'function' ? config : () => config
  const meter = compressionServices(ctx, ['tokenMeter'])
  const disposers = []
  let active = true
  const injection = ctx.inject?.(['commands'], (svc) => {
    if (!active) return
    try {
      disposers.push(svc.commands.register({
        name: 'token-status',
        description: '查看生效的压缩控制器、阈值、尝试/成功次数与最近读数',
        handler(invocation) {
          try {
            const current = read()
            const mode = compressionMode(current)
            const cfg = mode === 'legacy' ? current.compactionDriver : current.layeredCompact
            const agent = invocation?.agent
            const snapshot = stats.snapshotSession(agent?.id ?? agent?.session?.id)
            const c = snapshot.counters
            const p = agent?.session ? computePressure(
              { get: () => meter.get('tokenMeter') }, agent.session,
              mode === 'legacy' ? cfg.contextWindow : cfg.sessionWindowFallback,
            ) : null
            const lines = [
              '当前控制器：' + modeLabel[mode] + '（内核安全压缩仍由宿主控制）',
              mode === 'legacy'
                ? '旧驱动阈值：' + pct(cfg.pressureRatio) + '；至少 ' + cfg.minTurns + ' 轮、' + cfg.minTokens + ' 估算 token'
                : '分层阈值：观测 ' + pct(current.layeredCompact.lowRatio) + ' / 工具历史清理 ' + pct(current.layeredCompact.midRatio) + ' / 模型摘要 ' + pct(current.layeredCompact.highRatio) + (mode === 'off' ? '（当前未启用）' : ''),
              '设置生效：保存后下一次检查采用新值；已经开始的操作使用原配置快照。',
              p ? '压力比 ' + pct(p.ratio) + '（估算已用 ' + p.totalTokens + ' / 窗口 ' + p.window + '；窗口来源:' + (p.windowSource === 'event' ? 'request/context 声明，非容量实测' : '回落值，实际占用率不确定') + '）'
                : '压力比:不可用（缺少会话或有效计量）',
              '以下为本插件在当前 agent 的记录；内核自动/手动/其他插件触发不计入。',
              '观测层触发 ' + (c['layeredCompact.observed'] ?? 0) + ' 次（不降压力）',
              '工具历史清理：' + (c['layeredCompact.lossless'] ?? 0) + ' 次生效 / ' + (c['layeredCompact.pruneNoop'] ?? 0) + ' 次无变化 / ' + (c['layeredCompact.pruneUnavailable'] ?? 0) + ' 次服务缺失',
              '清理累计减少上下文估算量 ' + (c['layeredCompact.pruneSavedTokens'] ?? 0) + ' token（不等于账单净节省）',
              '分层模型摘要：尝试 ' + (c['layeredCompact.attempts'] ?? 0) + ' / 成功 ' + (c['layeredCompact.lossy'] ?? 0) + ' / 无有效区段 ' + (c['layeredCompact.noop'] ?? 0),
              '旧驱动模型摘要：尝试 ' + (c['compactionDriver.triggers'] ?? 0) + ' / 成功 ' + (c['compactionDriver.completed'] ?? 0) + ' / 无有效区段 ' + (c['compactionDriver.code.noop'] ?? 0),
            ]
            const issues = Object.entries(c).filter(([key]) => /(?:failed\.|code\.(?:busy|cancelled)$|backedOff$)/.test(key))
            if (issues.length) lines.push('异常/退避计数：' + issues.map(([k, v]) => k + '=' + v).join('，'))
            const recent = snapshot.samples.filter((s) => s.module === 'compression').slice(-6)
            for (const s of recent) {
              lines.push(s.at + ' ' + modeLabel[s.controller] + '/' + ({ check: '检查', prune: '工具历史清理', summary: '模型摘要' }[s.stage] ?? s.stage)
                + '：' + (labels[s.status] ?? ('失败（' + s.status + '）'))
                + '；估算 token ' + tokens(s.before) + ' → ' + tokens(s.after)
                + (s.before && s.after ? '（本次变化 ' + (s.before.totalTokens - s.after.totalTokens) + '）' : '')
                + (s.durationMs !== undefined ? '；耗时 ' + s.durationMs + 'ms' : '')
                + '；模型调用 ' + (s.modelCall === true ? '是' : s.modelCall === false ? '否' : '未确认'))
            }
            lines.push('摘要模型本身的 token 消耗/API 费用：宿主未提供逐次 usage，本插件不推算账单净节省。')
            lines.push('runtime 原文归档：' + (archive ? JSON.stringify(archive.status(agent?.session)) : '未挂载'))
            return { kind: 'success', text: lines.join('\n') }
          } catch (err) {
            return { kind: 'error', text: 'token-status 失败：' + (err?.message ?? err) }
          }
        },
      }))
    } catch (err) { ctx.logger?.warn?.('token-status 注册失败：%s', err?.message ?? err) }
  })
  return () => {
    active = false
    if (typeof injection === 'function') injection()
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    meter.dispose()
  }
}
