// 分层压缩编排(layeredCompact,T4 · 0C 修正版):压力分三级,各层动作真实、无损性如实。
//
// 层定义(0C §4;原"无损层 = 调低 fileDiff.minSize"的杠杆已被推翻——那只影响未来结果、
// 降不了当前压力,且 resolveConfig 深冻结,就地改配置永久静默无效):
//   L0 观测层 ratio ≥ lowRatio(0.4)  → 无副作用,只记账(此层不降压力,禁止包装成"无损压缩")
//   L1 无损层 ratio ≥ midRatio(0.5)  → ctx.toolResultPruner.pruneSession(session):
//       同步、无需 agent 空闲、不需要 LLM;改会话 surface(原文可回放、被遮蔽节点已 cite),
//       之后用 tokenMeter.measure 复测,savedTokens = before - after 真实记账
//   L2 有损层 ratio ≥ highRatio(0.65) 且 L1 复测后仍超阈 → compaction.compactNow
//       (AbortSignal.timeout + 按 err.code 分类记账);照抄内核 compaction-basic:900-905
//       的"测阈 → prune → 复测 → 仍超阈才有损"两段式
//
// 与 compactionDriver 的关系:启用本模块必须同时关闭旧驱动(0.45 命中即有损,
// 会把 L1 的机会整个吃掉)——src/index.js 里已做旁路。
// 两层轴的口径:本插件的 fileDiff/outputLadder 是"投影级"(只影响未来结果);
// L1 的 pruneSession 是"surface 级"(改写已发送历史)——这正是它真降压力的原因。
// pruner 获取:单独 ctx.inject(['toolResultPruner']) 可选声明——写进主 inject 数组会让
// 整个模块在 pruner 缺席时永久 pending;缺席时 L1 记 pruneUnavailable 跳过,L0/L2 照常。
import { computePressure } from './compactionDriver.js'

export function createLayeredCompactModule(ctx, config, stats) {
  if (!config?.enabled) return () => {}
  if (!ctx || typeof ctx.inject !== 'function' || typeof ctx.on !== 'function') return () => {}

  let compaction
  let tokenMeter
  let pruner

  try {
    ctx.inject(['compaction', 'tokenMeter'], (svc) => {
      if (!compaction) compaction = svc.compaction
      if (!tokenMeter) tokenMeter = svc.tokenMeter
    })
  } catch { /* inject 不可用:模块降级 */ }
  try {
    ctx.inject?.(['toolResultPruner'], (svc) => {
      pruner = svc.toolResultPruner
    })
  } catch { /* 可选服务:缺席走 pruneUnavailable */ }

  const states = new Map() // agentId -> { observed, lossless, pruneNoop, lossy, busy, backedOff }

  function stateOf(agent) {
    let st = states.get(agent.id)
    if (!st) {
      st = { observed: 0, lossless: 0, pruneNoop: 0, lossy: 0, busy: false, backedOff: false }
      states.set(agent.id, st)
    }
    return st
  }

  const onStatus = async (payload) => {
    const agent = payload?.agent // 载荷形状是 {agent, status}(agentEvents() 融合),不是 agent 本身
    if (!agent || payload?.status !== 'idle') return
    const session = agent.session
    if (!session) return
    if (!compaction || typeof compaction.compactNow !== 'function' || !tokenMeter || typeof tokenMeter.measure !== 'function') return

    const st = stateOf(agent)
    if (st.busy) return
    // computePressure 第一参只要 ctx 形状(内部 ctx.get('tokenMeter')),传注入取得的服务门面
    const p = computePressure({ get: (k) => (k === 'tokenMeter' ? tokenMeter : undefined) }, session, config.sessionWindowFallback)
    if (p === null) {
      stats?.bump('layeredCompact.noPressure', 1)
      return
    }
    const bucket = stats.bucket(agent.id) // T2 会话分桶

    // ── L0 观测层:只记账,绝不假装压缩 ──
    if (p.ratio >= config.lowRatio) {
      st.observed += 1
      stats?.bump('layeredCompact.observed', 1)
      bucket.bump('layeredCompact.observed', 1)
    }

    if (p.ratio < config.midRatio) return // 未达 L1:无任何动作

    st.busy = true
    try {
      // ── L1 无损层:真降分子(surface 级、同步、无需 LLM)──
      let current = p
      if (!pruner || typeof pruner.pruneSession !== 'function') {
        stats?.bump('layeredCompact.pruneUnavailable', 1)
        bucket.bump('layeredCompact.pruneUnavailable', 1)
      } else {
        try {
          const before = p.totalTokens
          pruner.pruneSession(session) // 会 session.append 改写 surface,写错当场抛 → 必须 try/catch
          const after = tokenMeter.measure(session)?.totalTokens
          if (typeof after === 'number') {
            const saved = Math.max(0, before - after)
            current = { ...p, totalTokens: after, ratio: p.window > 0 ? after / p.window : p.ratio } // 复测回写
            if (saved > 0) {
              st.lossless += 1
              stats?.bump('layeredCompact.lossless', 1)
              stats?.bump('layeredCompact.pruneSavedTokens', saved)
              bucket.bump('layeredCompact.lossless', 1)
              bucket.bump('layeredCompact.pruneSavedTokens', saved)
            } else {
              // 0 效果必须如实记 pruneNoop,不许算成 lossless(可观测性铁律)
              st.pruneNoop += 1
              stats?.bump('layeredCompact.pruneNoop', 1)
              bucket.bump('layeredCompact.pruneNoop', 1)
            }
          }
        } catch (err) {
          stats?.bump('layeredCompact.pruneFailed', 1)
          bucket.bump('layeredCompact.pruneFailed', 1)
          ctx.logger?.warn?.('layeredCompact prune failed: %s', err?.message ?? err)
        }
      }

      // ── L2 有损层:必须用【L1 复测后】的 ratio 判定(内核两段式)──
      if (current.ratio >= config.highRatio && st.lossy < config.highTierMaxPerSession && !st.backedOff) {
        // 与 compactionDriver 同款:setImmediate 让 idle 派发栈先退栈再进 runMaintenance
        await new Promise((resolve) => setImmediate(resolve))
        try {
          await compaction.compactNow(agent, AbortSignal.timeout(config.highTierTimeoutMs))
          st.lossy += 1
          stats?.bump('layeredCompact.lossy', 1)
          bucket.bump('layeredCompact.lossy', 1)
        } catch (err) {
          const code = err?.code
          stats?.bump(`layeredCompact.failed.${code ?? 'unknown'}`, 1)
          bucket.bump(`layeredCompact.failed.${code ?? 'unknown'}`, 1)
          if (code === 'busy') {
            // busy = 手动 /compact 或其他压缩正在进行 → 本会话退避,不再自动有损压缩
            // (T6#8 新增语义,实现位置:本模块 state.backedOff;L0/L1 不受影响)
            st.backedOff = true
            stats?.bump('layeredCompact.backedOff', 1)
          }
          // 注意:AbortSignal.timeout 的超时是普通 abort,不是 cancelled——按 code 如实记
        }
      }
    } catch (err) {
      stats?.bump(`layeredCompact.failed.${err?.code ?? 'unknown'}`, 1)
      ctx.logger?.warn?.('layeredCompact idle 处理失败: %s', err?.message ?? err)
    } finally {
      st.busy = false
    }
  }

  const onDisposed = (payload) => {
    const agent = payload?.agent // 同样是 {agent} 载荷,写成 (agent) => agent.id 会 delete undefined
    if (agent?.id !== undefined) states.delete(agent.id)
  }

  ctx.on('agent/status', onStatus)
  ctx.on('agent/disposed', onDisposed)
  return () => {
    states.clear()
    try { ctx.off('agent/status', onStatus) } catch { /* noop */ }
    try { ctx.off('agent/disposed', onDisposed) } catch { /* noop */ }
  }
}
