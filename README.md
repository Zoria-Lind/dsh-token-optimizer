# dsh-token-optimizer

> **v3.0.0 变更摘要（2026-10-29）**：重写 MCP 工具发现/懒加载（按名称与描述搜索、分页、真实可见性确认、重连恢复）；暂停缺少可靠失效证明的 cache 与 fileDiff；通用设置新增“Token 优化与压缩”（旧驱动/分层/关闭、阈值、状态记录）；新增 runtime 原文归档与 `conversation_archive` 回查工具；修复预设级摘要/清理服务的作用域读取。**升级前请先读下面的“升级到 3.0”。**
>
> v2.2：分层压缩编排 layeredCompact（L0 观测 / L1 清理历史工具结果 / L2 模型摘要，默认关）、`/token-status`、outputLadder 基线重建、按会话分桶统计。

> DeepSeek Harness 分层 Token 优化管道。**在 DSH 已内置能力之外做真实增量**：
> 把进入模型的文本压缩/裁剪/采样，降低上下文开销；摘要和采样可能丢失细节，任务质量与实际费用需要分别验证。

基于真实 DSH 插件 API（`agent/pre-step`、`tools/execute`、`tools/post-execute`、`agent/status` 等）实现，
与社区方案文档中虚构的事件(如 `message:before` / `context:building`)无关。

## 它做什么（30 秒版）

| 模块 | 钩子 | 作用 |
| :--- | :--- | :--- |
| text2img | `agent/pre-step` | 长文本（≥1000 字符）→ **弹窗询问**（转图摘要 / 直接阅读原文，推荐项与超时默认按内容类型定）→ 渲染成图 → vision 读图 → 摘要替换进上下文。动态分辨率分档（800×450 / 1440×810 / 1920×1080），摘要磁盘缓存跨会话 0 API 调用。单次样本曾省 ~72%；真正价值是**长会话越省**（后续轮次不再携带原文） |
| outputLadder | `tools/post-execute` | 工具输出出生点**单次遍历分流**：错误结果→300 字符摘要；JSON 数组/CSV（≥10k 字符）→结构感知压缩；shell 输出（≥8k 字符）→头尾+等距采样；≥50k 字节交核心 spill；read 类豁免。原文落盘可逆 |
| cache（暂停） | `tools/execute` | 默认关闭；glob/grep 每次都重新执行，不复用可能过期的结果 |
| fileDiff（暂停） | `tools/post-execute` | 当前始终保留原文；不能确认模型请求仍持有基线时不生成 diff |
| toolTrim | `agent/created` | 工具可见性管理：静态裁剪 + **MCP 懒加载**——不用的 `mcp__*` 工具 schema **不进原生工具定义列表**；目录按名称/描述搜索与分页，加载后确认真实可见 |
| compactionDriver / layeredCompact | `agent/status` | 旧驱动或分层互斥调度核心压缩；阈值可配置，准确区分尝试、成功和跳过原因 |
| monitor | `session/disposed` | 会话结束输出节省统计 + **真实 usage 聚合与缓存命中率**(长会话常态 97%–99.3%) |
## 与 DSH 核心的边界

DSH 已内置 `token-meter`、`compaction-basic`、`tool-result-pruner`、`spill`、`llm-retry`、`repeat-tool-reminder`——
**本插件一律不重复实现**，只做上面这些内置之外的增量。

## 安装

```bash
dsh plugin --profile web add @zoria-lind/dsh-token-optimizer
```

本地开发目录也可以直接挂载：`dsh plugin --profile web add ./dsh-token-optimizer`。

卸载：

```bash
dsh plugin --profile web remove @zoria-lind/dsh-token-optimizer
```

## 升级到 3.0

这是带破坏性配置语义的主版本升级。升级前请检查 profile 的 `cordis.patch.yml`：

- **`toolTrim.allow: []` 的含义反转**：2.x 里空数组表示“不限”，3.0 起表示“禁止所有可裁剪的继承工具”（与内核 `restrict` 的空 allow 语义一致）。想要“不限”请删除该键或写 `allow: null`。
- **过时的内置工具白名单已移除**：bundle 不再硬编码旧工具名。你自己配置的长白名单仍会生效，但会让名单外的新工具不可见，建议人工审阅。
- **cache / fileDiff 默认停用**：两者都缺少可靠的失效/基线证明，3.0 不再复用缓存或只发 diff 原文片段，即使旧配置写了 `enabled: true` 也只透传原结果。相关参数保留仅为配置兼容。
- 新增通用设置“Token 优化与压缩”和 runtime 原文归档，默认都不改变你现有的压缩策略。

## 工具发现与 MCP 懒加载

工具目录不再塞进工具 description 后截断。固定大小的发现工具支持按名称/描述搜索与分页，隐藏后仍可搜索描述，目录末尾也可找到。先成功注册并确认发现工具在当前作用域可见，再隐藏 MCP；注册失败、接口缺失或名字冲突时保留原可见性。以下行为按 DSH 0.2.1-rc.2 的 tools 服务源码核对；真实 API token 节省需要你自己测量。

- 显式 allow/deny 与父作用域限制继续执行；不接管别人注册的同名工具。后续 tools/change 可重试。
- 加载后检查当前作用域的真实 view；失败、用户限制或父作用域拦截会返回原因，不记为成功。重复加载不重复计数；同名重连刷新目录，断开最后一个 MCP 不撤销静态限制。
- cache 和 fileDiff 已暂停，默认关闭；旧配置即使 enabled:true 也只透传。glob/grep 每次重新执行；fileDiff 保留内层决定中的全文、非文本内容及 additionalContexts，不再写其旧原文目录或记录虚假节省。3.0 未建立可靠的文件失效机制，也未证明某份完整文件基线仍在当前模型请求中；仅监听压缩事件不能替代这一证明。
- bundle 移除旧内置工具白名单，避免新工具因名单过期而消失。显式用户策略仍保留，不自动扩大权限。

配置迁移：

- toolTrim.allow 省略或为 null：不设置静态白名单，未来新增内置工具保留可见。
- toolTrim.allow: []：禁止所有可裁剪的继承工具。allow 非空只允许列出的精确名称；deny 优先。未知/已断开的白名单名被移除后，即使名单为空，也不会变成无限制。
- 旧版把 allow: [] 当作“不限”，3.0 起必须改为省略 allow 或 null。旧 bundle 生成的长白名单也需要人工审阅；保留它就会继续禁止名单外 MCP，加载器不能扩大该名单。
- 核心对作用域自注册工具豁免 restrict；本插件的发现工具属于此类。显式 deny 发现工具名会停用该作用域懒加载。父层限制同样作用于继承能力，子代理不能靠本加载器越权；父层白名单若需要让子代理使用继承的发现工具，也应包含该名称。
- cache.ttl 与 fileDiff 的旧参数保留配置兼容性，暂不生效。后续实现可靠失效与当前请求基线证明后，再另行评审是否恢复。

模型调用发现工具的例子（均为 mcp_load_tools）：

~~~json
{"query":"database","offset":0,"limit":10}
{"offset":10,"limit":10}
{"names":["mcp__server__exact_tool_name"]}
~~~

query 默认空字符串，支持名称和完整缓存描述的大小写不敏感子串匹配，最多取前 200 字符；offset 默认 0；limit 默认 10、上限 20；names 每次处理前 20 个并报告忽略数量。结果含 matched/nextOffset/items，加载后仍受限制会列在 failed 中。只在成功确认可见时增加加载计数。目录使用全局公开 view 中的定义作为元数据补充，实际加载始终按 agent 的 view 和过滤权限验证。

验证命令：

~~~powershell
node test/smoke.mjs
node test/modules.test.js
node test/availability.mjs
~~~

smoke 已包含 availability 用例；3.0 发布前 smoke 245 项、modules 4 项、归档专项 19 项通过。测试覆盖 1000 个工具目录、父子作用域、失败恢复、断开重连、立即销毁、真实文件新增/修改，以及跨 cwd/会话/上下文重置时原文保留。定义规模只是测试夹具的 JSON 字节数，不能换算成真实 API token 节省或桌面体验结论。

## 压缩设置与状态

通用设置新增“Token 优化与压缩”：可选旧驱动、分层或关闭插件自动压缩；工具历史清理和模型摘要阈值支持百分比输入、滑块，观测线及旧驱动阈值在高级设置中。当前默认仍是旧驱动开启、分层关闭，不自动迁移策略。

分层默认值为：40% 仅观测，50% 清理历史工具结果；清理后复测仍达到 65% 才尝试模型摘要。清理会遮蔽部分历史工具结果；摘要可能丢失任务细节。“可以回查”并不保证摘要无损。旧驱动默认 45%，还受至少 6 轮、100000 估算 token 等条件限制。

保存时客户端和后端都校验 `0 < 观测线 ≤ 清理线 < 摘要线 < 100%`，旧驱动阈值也须在 0% 与 100% 之间。两套开关和阈值一次提交；保存后下一次 idle 检查读取新配置，已经执行的操作使用原配置快照。切换控制器保留各自成功配额和统计；两者不会并发压缩同一 agent。关闭插件自动压缩不关闭宿主自身的安全压缩。

在当前对话运行 `/token-status` 可查看生效控制器、阈值、估算压力、窗口来源，以及本插件在当前 agent 的最近六条检查/清理/摘要记录。记录区分尝试、成功、无安全有效区段、忙、超时、失败，包含时间、前后估算量、耗时和模型调用是否确认。空结果不记成功、不占成功配额；同一历史上的无效摘要短暂退避。分层在内核报忙后沿用原来的本会话停止自动摘要策略。

窗口来自最近有效 `request/context` 声明，缺失时采用配置回落值并标明不确定；它不是模型容量的实测结果。上下文估算量减少不等于账单净节省，宿主未提供逐次摘要 usage 时不推算摘要费用。内核自动/手动/其他插件发起的压缩不计入本插件记录。

设置依赖宿主 React、slots、configForms 和可解析的 `@deepseek-ai/schemastery`。复用宿主模块，不安装新依赖；schema 解析失败不阻断插件。设置未 served、未就绪或只读时，页面显示默认参考/不可编辑提示，仍可用命令检查状态。

设置投影、volatile 配置与 UI 逻辑由自动测试覆盖；真实桌面面板展示与保存仍需实机确认。3.0 未调整宿主摘要保留范围，也未证明模型摘要能保留所有用户原话和约束。

测试：`node test/smoke.mjs` 包含压缩和 UI 逻辑回归；单独可运行 `node test/compression.mjs`。设置投影/volatile 契约检查需将 `DSH_OPTIMIZER_HOST_FIXTURE` 指向隔离宿主夹具目录，缺失时明确跳过这些用例。

## runtime 原文归档

在通用设置“Token 优化与压缩”中的“runtime 原文归档”，填写绝对目录、勾选并单独保存；默认关闭，不指定默认写盘路径。当前提供可编辑路径及前后端校验。切换目录不搬迁旧文件，旧目录自动保留为回查来源。开关不影响宿主原生会话日志，关闭或卸载不删除归档。

原始用户消息先经 `agent/pre-step` 捕获，等待 JSONL 写入和 `fsync` 成功，再交给文字摘要等改写及上下文接纳。模型输出先生成，再保存流片段、最终消息或中断/失败终态；普通请求和默认摘要请求通过 `llm/stream`、`session/flush` 等待归档。复用 DSH 0.2.1-rc.2 的公开接口及原生 checkpoint policy，不修改内核/ASAR；不同加载顺序下，失败可能表现为等待恢复或请求直接失败，两种都不会静默继续调用模型。直接失败后需重新发起请求。

写失败保留待写内容并暂停相关请求。可点击“重试归档”、在当前会话执行 `/token-archive-retry`、修改保存目录，或明确关闭归档后继续；`/token-status` 显示归档状态、已确认事件序号、待写数量、错误代码和回查工具是否可用。设置保存或重试提交成功不表示内容已落盘。取消等待会恢复本批尚未接纳的输入至待处理队列，不自动再执行；仅保留在内存中的失败缓冲不能跨强制退出恢复，原生仍保存的事件可在重启后补录。

每个会话使用稳定 key 去重，各进程/插件生命周期分别写独占段；内存索引可从当前目录及历史目录的 JSONL 重建。只有写盘确认后才推进归档游标；写入部分失败尝试截回本批起点，完整损坏行报错而不覆盖。崩溃留下的无换行尾段仅在确认所属进程已退出时修复，可能仍在使用的段报忙。开启前的流片段无法补录；历史消息只按宿主仍保存的事件回填，摘要不冒充缺失原文。文件中的摘要前 checkpoint 表示归档覆盖检查，不能当作压缩成功记录。

模型在当前会话使用 `conversation_archive` 按需取回原文：

~~~json
{"action":"search","query":"截止时间","limit":10}
{"action":"read","key":"搜索返回的key","offset":0,"limit":2000}
{"action":"status"}
~~~

`search` 返回短摘录及 key；`nextOffset` 非空须继续翻页。默认查原始输入、接纳输入和模型终态；可用 `role: "assistant-stream"` 查流片段。每页最多检查2000条索引、读取约2MiB（允许完成一条最大16MiB的记录），匹配上限20条。超过16MiB的记录会明确列为未全文检索，单条读取也给出本地文件路径。`read` 按 Unicode 字符分页，默认2000、上限4000字；不把整个档案自动塞回上下文。回查工具注册在当前 agent 自有作用域，继承工具裁剪及 MCP 懒加载不会隐藏它。

归档专项验证直接抽取安装包中的 Inbox、preStep、flush、checkpoint policy、LLM 分发和压缩事务方法，使用虚构数据做真实文件写入、同步与故障注入；上下文组装、投影、会话校验器及模型提供者为夹具。它不能等同于整套桌面验收、断电实验、真实模型任务质量或净 token 节省。第三方绕开带 sessionId 的流入口不在当前保证范围；能回查原文也不保证模型主动找回每个细节。

`test/archive.mjs` 依赖本机抽取的宿主夹具（不走 npm 安装，因此不在发布包里），需要 `DSH_TO03_STATE` 指向隔离状态目录。

## 配置

下方是插件代码默认值；bundle 安装模板会启用 toolTrim。挂载后在 profile 的 `cordis.patch.yml` 中覆盖（示例，均为默认值）：

```yaml
- id: token-optimizer
  name: '@zoria-lind/dsh-token-optimizer'
  config:
    archive:
      enabled: false
      directory: ''            # 启用前在通用设置填写绝对路径
      previousDirectories: []   # UI 换路径时自动保留旧目录
      retryGeneration: 0
    text2img:
      enabled: true
      threshold: 1000
      askOnSkip: true        # false = 不弹窗，回退自动行为（自然语言自动转图/结构性强跳过）
      askTimeoutMs: 120000   # 询问超时，超时按内容类型默认执行
      maxAsksPerSession: 0   # 每会话弹窗上限（0=不限），嫌弹窗多可设 3~5，超限按内容类型默认静默执行
      summaryCache: true     # 内容 hash → 摘要磁盘缓存，跨会话命中 0 API（含原文落盘去重）
      dynamicResolution: true
      resolutionTiers:       # 按字数分档（尺寸经实测校准：YaHei 行高 ≈1.9×字号，
                             # 密度保持在已验证安全的 ~1千字/页 以内）
        - { maxChars: 2000, width: 800, height: 450, fontSize: 24 }
        - { maxChars: 6000, width: 1440, height: 810, fontSize: 24 }
        - { maxChars: Infinity, width: 1920, height: 1080, fontSize: 36 }
      renderWidth: 1200      # dynamicResolution=false 时的固定宽度
      pageFontSize: 24       # dynamicResolution=false 时用
      pageMaxHeight: 3000    # dynamicResolution=false 时用
      visionModel: 'deepseek-v4-flash-vision-exp'
      baseUrl: 'https://api.deepseek.com/v1'
      maxSummaryChars: 2000
      maxSummaryRatio: 0.4    # 摘要上限 = min(maxSummaryChars, 输入字数×0.4)，保证替换后比原文短
      pagesPerBatch: 4        # 分批摘要：每批最多 4 页送 vision（防"只读开头几页"），再纯文本合并
      saveOriginal: true
    outputLadder:
      enabled: true
      structureThreshold: 10000
      compressionRate: 0.5
      preserveHeadTail: 1000
      shellTools: ['pwsh', 'bash', 'sh', 'powershell', 'zsh', 'cmd']
      shellThreshold: 8000
      headLines: 10
      tailLines: 10
      sampleInterval: 20
      errorSummaryChars: 300
      spillBytes: 50000
      readTools: ['read', 'read_image']
      saveOriginal: true
    cache:
      enabled: false          # 暂停：缺少可靠文件失效机制；旧 true 也透传
      ttl: 3600
    fileDiff:
      enabled: false          # 暂停：不能证明当前请求仍有完整基线
      tools: ['read']
      minSize: 2048
      maxFileBytes: 200000
      contextLines: 3
      collapseUnchanged: true
    toolTrim:
      enabled: false          # 默认关闭；启用后对每个 agent 作用域生效
      allow: null             # 省略/null=不限；[]=禁止所有继承工具
      deny: []
      mcpLazy: true
      mcpPrefix: 'mcp__'
      mcpLoadToolName: 'mcp_load_tools'
    compactionDriver:
      enabled: true
      pressureRatio: 0.45     # totalTokens / contextWindow 超过该比才触发
      minTurns: 6
      minTokens: 100000
      maxCompactionsPerSession: 3
      contextWindow: 1000000
      timeoutMs: 120000
    memory_bridge:            # dsh-memory-bridge 联动占位节（阶段 3b 完成后开开关）
      enabled: false
      sync_dir: '~/.dsh-memory'
      compress_on_sync: true
      compression_strategy: 'time_decay'
      text2img_threshold: 1000
      dynamic_resolution: true
```

> v1 的 `compress` / `sample` / `pruning` / `dedup` 节已退役（合并进 outputLadder），旧配置节会被静默忽略并在日志提示，不会导致加载失败。

### web 部署必读：重新启用核心压缩后端

`dsh-web-app` 的 bundle patch 默认**禁用**了 `compaction-basic` 与 `command-compact`（配合 /compact 命令），
web 部署因此**没有 compaction 服务**，插件摘要调度无法运行，`/token-status` 会记录服务不可用。在 profile 的 `cordis.patch.yml` 顶层补：

```yaml
- id: compaction-basic
  disabled: false
- id: command-compact
  disabled: false
```

## 依赖

- **text2img 渲染**：Windows 需 PowerShell + .NET System.Drawing（`scripts/render-text.ps1`，免第三方依赖）；非 Windows 渲染降级为仅落盘原文。
- **text2img 摘要**：需 `DEEPSEEK_API_KEY` 环境变量（DSH 已配置）。
- **mcpLazy**：需 profile 挂载 `@deepseek-ai/dsh-mcp-client` 并配置至少一个 MCP 服务器；无 MCP 时自动 no-op。

## 开发

```bash
node test/smoke.mjs          # 单进程全量自检（无需 API），npm test 同
node test/modules.test.js
node test/text2img-e2e.mjs   # 真实端到端（需 API key + Windows 渲染）
```

## 路线图

- 自然语言配置工具（让模型改配置）
- 长文本→图片的跨平台渲染 fallback
- 与 [dsh-behavior-enhancer](https://github.com/Zoria-Lind/dsh-behavior-enhancer) 协同（内容压缩 × 行为管理，可独立安装）
- dsh-memory-bridge 联动（配置节已占位，扩展 + bridge 服务就绪后开开关）
