// 轻量统计:记录各模块的节省/处理次数,会话结束时输出报告。
// T2 新增:按会话分桶(bucket/snapshotSession)与 token/金额估算(estimateTokens/estimateCost)。
// snapshot()/formatReport() 的返回形状是既有调用点契约(monitor 在用)→ 只加方法不改形状。

const CHARS_PER_TOKEN = 1.6 // 粗估:DeepSeek 中文约 1.6 字符/token(估算值,实际以 usage 为准)

export function createStats() {
  const counters = new Map()
  const samples = []
  const buckets = new Map() // sessionId -> { counters: Map, samples: [] }(T2 按会话分桶)

  function bump(key, delta = 1) {
    counters.set(key, (counters.get(key) ?? 0) + delta)
  }

  function addSample(entry) {
    samples.push(entry)
    if (samples.length > 1000) samples.shift()
  }

  function snapshot() {
    return {
      counters: Object.fromEntries(counters),
      samples: [...samples],
    }
  }

  // 会话分桶:返回与本对象同形状的 bump/addSample 门面,写入该会话的桶;
  // 全局计数(bump)不受影响——分层模块两边都记(全局供 monitor 报告,分桶供 /token-status)
  function bucket(sessionId) {
    const key = String(sessionId ?? 'default')
    let b = buckets.get(key)
    if (!b) {
      b = { counters: new Map(), samples: [] }
      buckets.set(key, b)
    }
    return {
      bump(k, delta = 1) {
        b.counters.set(k, (b.counters.get(k) ?? 0) + delta)
      },
      addSample(entry) {
        b.samples.push(entry)
        if (b.samples.length > 1000) b.samples.shift()
      },
    }
  }

  // 与 snapshot() 同构:{ counters, samples }(只含该会话桶,与全局计数互不干扰)
  function snapshotSession(sessionId) {
    const b = buckets.get(String(sessionId ?? 'default'))
    return {
      counters: Object.fromEntries(b?.counters ?? []),
      samples: [...(b?.samples ?? [])],
    }
  }

  // 字符节省 → token 粗估(保守口径:按 CHARS_PER_TOKEN 换算)
  function estimateTokens(savedChars) {
    const n = Number(savedChars)
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.round(n / CHARS_PER_TOKEN)
  }

  // 人民币估算:各 token 量按"元/百万"计价求和
  function estimateCost({ inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 } = {}, pricing) {
    const p = pricing ?? { inputPerMillion: 0.8, cacheHitPerMillion: 0.23, outputPerMillion: 2.8 }
    const cost = (Number(inputTokens) || 0) * (p.inputPerMillion ?? 0)
      + (Number(cacheReadTokens) || 0) * (p.cacheHitPerMillion ?? 0)
      + (Number(outputTokens) || 0) * (p.outputPerMillion ?? 0)
    return cost / 1e6
  }

  function formatReport() {
    const c = Object.fromEntries(counters)
    const lines = []
    lines.push('── dsh-token-optimizer 会话统计 ──')
    for (const [key, value] of Object.entries(c)) {
      lines.push(`  ${key}: ${value}`)
    }
    const totalChars = samples.reduce((sum, s) => sum + (s.savedChars ?? 0), 0)
    if (totalChars > 0) lines.push(`  共节省约 ${totalChars.toLocaleString()} 字符(压缩/去重)`)
    return lines.join('\n')
  }

  return {
    bump,
    addSample,
    snapshot,
    bucket,
    snapshotSession,
    estimateTokens,
    estimateCost,
    formatReport,
    dispose() {
      counters.clear()
      samples.length = 0
      buckets.clear()
    },
  }
}
