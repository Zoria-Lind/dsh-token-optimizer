// 宿主 React + 通用设置 slot；无需构建或新增前端依赖。
window.__ModuleLoader__.load({
  id: '@zoria-lind/dsh-token-optimizer',
  factory: (require) => {
    let React
    try { React = require('react') } catch { /* 仍可使用 /token-status */ }
    const defaults = { mode: 'legacy', low: '40', mid: '50', high: '65', legacy: '45' }
    const style = {
      wrap: { padding: '12px 0', lineHeight: 1.65 },
      row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginTop: '8px' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      input: { width: '76px', padding: '3px 6px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '5px' },
    }
    function values(value) {
      const c = value?.compactionDriver ?? {}
      const l = value?.layeredCompact ?? {}
      return {
        mode: l.enabled === true ? 'layered' : c.enabled === false ? 'off' : 'legacy',
        low: String((l.lowRatio ?? 0.4) * 100),
        mid: String((l.midRatio ?? 0.5) * 100),
        high: String((l.highRatio ?? 0.65) * 100),
        legacy: String((c.pressureRatio ?? 0.45) * 100),
      }
    }
    function apply(ctx) {
      if (!React || !ctx?.slots?.register) return
      let form
      try { form = ctx.configForms?.get?.('token-optimizer') } catch { /* 显示不可编辑提示 */ }
      const el = React.createElement
      function Settings() {
        const snapshot = React.useSyncExternalStore(
          (listener) => form?.subscribe(listener) ?? (() => {}),
          () => form?.getSnapshot() ?? null,
          () => form?.getSnapshot() ?? null,
        )
        const live = snapshot?.value ? values(snapshot.value) : defaults
        const archiveLive = snapshot?.value?.archive ?? { enabled: false, directory: '', previousDirectories: [], retryGeneration: 0 }
        const archiveKey = JSON.stringify(archiveLive)
        const [archiveDraft, setArchiveDraft] = React.useState(archiveLive)
        const [archiveMessage, setArchiveMessage] = React.useState('')
        React.useEffect(() => { setArchiveDraft(archiveLive) }, [archiveKey])
        const key = JSON.stringify(live)
        const [draft, setDraft] = React.useState(live)
        const [message, setMessage] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        React.useEffect(() => { setDraft(live) }, [key])
        const ready = snapshot?.status === 'ready' && !!snapshot.value
        const writable = ready && snapshot.writable === true && !saving
        const change = (field, value) => { setDraft((d) => ({ ...d, [field]: value })); setMessage('') }
        const save = async () => {
          if (!writable || !form?.mutate) return
          const fields = ['low', 'mid', 'high', 'legacy']
          const raw = fields.map((field) => String(draft[field]).trim())
          const [low, mid, high, legacy] = raw.map(Number)
          if (raw.some((v) => v === '') || ![low, mid, high, legacy].every(Number.isFinite)
            || !(0 < low && low <= mid && mid < high && high < 100)
            || !(0 < legacy && legacy < 100)) {
            setMessage('未保存：须满足 0 < 观测线 ≤ 清理线 < 摘要线 < 100%；旧驱动阈值也须在 0% 与 100% 之间。')
            return
          }
          setSaving(true)
          try {
            const result = await form.mutate([
              { op: 'set', path: ['layeredCompact', 'enabled'], value: draft.mode === 'layered' },
              { op: 'set', path: ['compactionDriver', 'enabled'], value: draft.mode === 'legacy' },
              { op: 'set', path: ['layeredCompact', 'lowRatio'], value: low / 100 },
              { op: 'set', path: ['layeredCompact', 'midRatio'], value: mid / 100 },
              { op: 'set', path: ['layeredCompact', 'highRatio'], value: high / 100 },
              { op: 'set', path: ['compactionDriver', 'pressureRatio'], value: legacy / 100 },
            ])
            setMessage(result === true ? '已保存；下一次压缩检查采用新配置，正在执行的操作沿用原配置。'
              : result === false ? '保存失败：宿主拒绝或未完成写入。' : '保存结果未确认，请核对生效值后重试。')
          } catch (err) { setMessage('保存失败：' + (err?.message ?? err)) }
          finally { setSaving(false) }
        }
        const saveArchive = async (retry = false) => {
          if (!writable || !form?.mutate) return
          const directory = archiveDraft.directory.trim()
          if (!retry && archiveDraft.enabled && !(/^[A-Za-z]:[\\/]/.test(directory) || directory.startsWith('\\\\') || directory.startsWith('/'))) {
            setArchiveMessage('未保存：启用归档必须填写绝对目录路径。'); return
          }
          setSaving(true)
          try {
            const old = archiveLive.directory
            const history = [...new Set([...(archiveLive.previousDirectories ?? []), ...(old && old !== directory ? [old] : [])])]
            const ops = retry
              ? [{ op: 'set', path: ['archive', 'retryGeneration'], value: (archiveLive.retryGeneration ?? 0) + 1 }]
              : [
                { op: 'set', path: ['archive', 'enabled'], value: !!archiveDraft.enabled },
                { op: 'set', path: ['archive', 'directory'], value: directory },
                { op: 'set', path: ['archive', 'previousDirectories'], value: history },
                { op: 'set', path: ['archive', 'retryGeneration'], value: archiveLive.retryGeneration ?? 0 },
              ]
            const result = await form.mutate(ops)
            setArchiveMessage(result === true
              ? retry ? '已提交重试；写盘是否成功请查看 /token-status。' : '已保存归档设置；后续输入按此配置检查，写盘状态请查看 /token-status。'
              : result === false ? '保存失败：宿主拒绝或未完成写入。' : '保存结果未确认，请核对后重试。')
          } catch (err) { setArchiveMessage('保存失败：' + (err?.message ?? err)) }
          finally { setSaving(false) }
        }
        function threshold(field, label) {
          return el('label', { style: style.row },
            el('span', null, label),
            el('input', { type: 'range', min: 0.1, max: 99.9, step: 0.1, value: draft[field], disabled: !writable, 'aria-label': label + '滑块', onChange: (e) => change(field, e.target.value) }),
            el('input', { type: 'number', min: 0.1, max: 99.9, step: 0.1, value: draft[field], disabled: !writable, style: style.input, 'aria-label': label, onChange: (e) => change(field, e.target.value) }),
            el('span', null, '%'))
        }
        return el('section', { style: style.wrap },
          el('div', { style: { fontWeight: 600 } }, 'Token 优化与压缩'),
          el('div', { style: style.hint }, ready
            ? '当前控制器：' + ({ legacy: '旧驱动', layered: '分层', off: '插件自动压缩关闭' }[live.mode])
            : '尚未取得当前配置；以下为默认参考值，不可编辑。'),
          el('label', { style: style.row }, '自动压缩策略',
            el('select', { value: draft.mode, disabled: !writable, 'aria-label': '自动压缩策略', onChange: (e) => change('mode', e.target.value) },
              el('option', { value: 'legacy' }, '旧驱动（保留现有策略）'),
              el('option', { value: 'layered' }, '分层（先清理工具历史，再尝试摘要）'),
              el('option', { value: 'off' }, '关闭插件自动压缩'))),
          threshold('mid', '工具历史清理阈值'),
          threshold('high', '模型摘要阈值'),
          el('details', null, el('summary', null, '高级阈值'),
            threshold('low', '观测线（仅观测，不压缩）'),
            threshold('legacy', '旧驱动阈值')),
          el('div', { style: style.hint }, '分层阈值仅在分层策略下生效；旧驱动还受最少轮数与 token 量限制。'),
          el('div', { style: style.hint }, '保留当前默认值，不自动启用分层。关闭此处的自动压缩后，宿主仍保留自身的安全压缩。'),
          el('div', { style: style.hint }, '工具历史清理会遮蔽部分历史结果；模型摘要可能丢失细节，能够回查原文也不等于无损。'),
          el('div', { style: style.hint }, '当前会话的触发原因、尝试/成功、前后估算量与异常原因：使用 /token-status。'),
          el('button', { disabled: !writable, onClick: save }, saving ? '保存中…' : '保存压缩设置'),
          el('div', { role: 'status', style: style.hint }, message || (ready ? snapshot.writable ? '修改后整组保存；下一次检查生效。' : '当前配置只读，无法保存。' : '设置服务未就绪；可用 /token-status 查看运行状态。')),
          el('div', { style: { fontWeight: 600, marginTop: '18px' } }, 'runtime 原文归档'),
          el('label', { style: style.row },
            el('input', { type: 'checkbox', checked: !!archiveDraft.enabled, disabled: !writable, 'aria-label': '启用原文归档', onChange: e => setArchiveDraft(d => ({ ...d, enabled: e.target.checked })) }), '保存用户原文与模型输出（默认关闭）'),
          el('label', { style: style.row }, '保存目录',
            el('input', { type: 'text', value: archiveDraft.directory, disabled: !writable, style: { ...style.input, width: 'min(100%, 460px)' }, 'aria-label': '原文归档目录', placeholder: '填写绝对目录路径', onChange: e => setArchiveDraft(d => ({ ...d, directory: e.target.value })) })),
          el('div', { style: style.hint }, '用户原文先写盘成功再放行；模型输出生成后保存，后续送模和摘要前确认。写盘失败会阻止相关请求，可重试、改目录，或明确关闭归档后继续。'),
          el('div', { style: style.hint }, '切换目录不搬迁旧文件；旧目录保留为回查来源。会话内使用 conversation_archive 按需搜索和分页读取；开启前丢失的流片段无法补录。'),
          el('div', { style: style.hint }, '历史归档目录：' + ((archiveLive.previousDirectories ?? []).join('；') || '无')),
          el('button', { disabled: !writable, onClick: () => saveArchive(false) }, '保存归档设置'),
          el('button', { disabled: !writable || !archiveLive.enabled, onClick: () => saveArchive(true) }, '重试归档'),
          el('div', { role: 'status', style: style.hint }, archiveMessage))
      }
      const disposers = []
      // 先挂载可读行，再订阅命名空间；未 served 时也能显示明确的不可编辑状态。
      const register = () => ctx.slots.register({ name: 'settings.general.item', id: 'token-optimizer.compression', order: 710 }, Settings)
      if (typeof ctx.slots.inject === 'function') disposers.push(ctx.slots.inject('settings.general.item', register))
      else disposers.push(register())
      try {
        if (ctx.configForms?.whileServed) disposers.push(ctx.configForms.whileServed(['token-optimizer'], () => () => {}))
      } catch { /* 行仍可读，保存按钮保持禁用 */ }
      let disposed = false
      const cleanup = () => {
        if (disposed) return
        disposed = true
        for (const dispose of disposers) if (typeof dispose === 'function') dispose()
      }
      if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
      return cleanup
    }
    return { inject: ['slots', 'configForms'], apply }
  },
})
