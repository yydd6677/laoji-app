# 日程语义流水线三路比较：维护、最小共享契约与 Recognizers/SCATE 替换

## 状态、范围与证据边界

- observed at: `2026-08-16 Asia/Shanghai`
- status: `research / candidate`; **not adopted**
- source worktree: `/home/yydd/LaoJi-worktrees/feishu-source-driven`
- service source inspected read-only: `/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend`
- 本文只新增研究文档；没有修改生产代码，没有启动或重启服务，没有操作服务器、设备、数据库或公网接口。
- 源码行号来自观察时的 dirty worktree；发布 APK、公网进程和真机行为不由本文件静态读取自动推出。

本文专门回答蓝图当前的日程问题：移动端规则、设备服务 `/schedule/parse`、`/schedule/parse-audio`、`/schedule/clarify` 和日程 WebSocket 是否需要统一，以及是否应以 Recognizers-Text/SCATE 加小模型替换现有链路。比较对象是三条路线：

1. **C0 维护现状**：保留两套规则、Ollama 模型回退、语音双路径和当前确认 UI，只做缺陷修补。
2. **M1 最小共享语义契约**：不先换模型；把解析结果、来源证据、上下文、意图、澄清和完成状态收敛为一个无副作用合同，现有手机规则、服务端规则和模型都作为适配器。
3. **R2 Recognizers/SCATE 组合替换**：用 Recognizers-Text 做中文时间/数字识别，SCATE/normit 做可组合时间语义，再由小模型或 LLM 编排标题、意图、重复和澄清。

“共享契约”不是“所有端运行相同的解析器”。它首先是同一字段、证据和不确定性合同；引擎仍可按端和资源独立替换。

## 当前源码调用图（observed）

### 文本日程

```text
VoiceInputModal(手动文本)
  -> src/services/api.ts:426-459 parseText
     -> parseLocalScheduleText(text, reference, timezone)
     -> classifyScheduleParseRoute(text, local, ...)
        -> local_safe / clarify: normalizedParseResult -> 确认草稿
        -> server_required: deviceApi.parseScheduleRemotely
           -> POST /api/device/v1/schedule/parse
              -> app/api/device_v1.py:624-649 parse_device_schedule
                 -> parse_schedule_text(..., model_only=client_rule_miss && intent=create)
                    -> quick rules (除非 force/skip)
                    -> Ollama SCHEDULE_OLLAMA_MODEL (默认 qwen3.5:9b)
                    -> JSON 解析/一次 repair retry/确定性 fallback
```

手机规则不只是日期 validator。`src/services/localScheduleParser.ts:1272-1403,1435-1647` 同时归一化繁简字、相对日期、时间段、时间范围、重复、操作意图、标题和澄清；`classifyScheduleParseRoute` 还负责把查询、删除、控制语句和复杂句送进服务端。服务端 `app/services/schedule_parser_service.py:684-795,828-910` 另有一套 quick parser、模型 prompt、JSON repair 和 fallback。两套规则当前有同步意图，但不是一个执行实现。

`/schedule/parse` 的 `model_only` 分支是一个重要边界：设备端规则标记 `unresolved` 且意图为 `create` 时，服务端跳过 quick parser，让模型决定缺失日期、时间、重复和澄清；服务端仍对模型输出做 schema、安全和原文 evidence phrase 校验（`schedule_parser_service.py:1120-1325`）。因此“模型回退”不是简单地把原文再跑一次服务端规则。

### 澄清/确认

```text
VoiceInputModal.confirm
  -> 用户补充日期/时间/地点/标题
  -> api.ts:463-479 clarifyText
     -> POST /api/device/v1/schedule/clarify
        -> app/api/device_v1.py:669-687
           -> apply_schedule_clarification (asyncio.to_thread)
              -> 继承原 draft + 只应用补充信息 -> 新 ParseResult
  -> 用户再次确认后才进入保存事件路径
```

澄清响应不是自动写入日程的授权；确认 UI 才是副作用边界。M1 必须保留 `draftRevision`/原文和用户补充的可追溯关系，不能把“有模型结果”当成“已确认”。

### 语音日程

实时路径：

```text
VoiceInputModal.startRecording
  -> startRealtimeAsr({ purpose: 'schedule' })
  -> wss://.../ws/laoji/schedule/{session}/{provider}
     -> app/api/qwen_ws.py:307-315
        -> Qwen3-ASR + schedule VAD（无讲话人识别、无 transcript 持久化）
        -> 仅发送 transcript.completed（qwen_ws.py:409-438,504-530）
  -> stop -> 将 transcript 送 parseText -> 本地/服务端文本链
```

当前 WebSocket 代码在 VAD 分段结束并完成 `_qwen_transcribe` 后才发送 `transcript.completed`；不能把它描述为 token/partial streaming。首个可见文字应从录音开始、权限/认证、VAD 分段、网络和推理的总和测量，而不是直接等同模型 TTFT。

文件回退路径：

```text
实时连接失败或无最终文本
  -> 保留 WAV -> POST /schedule/parse-audio
文件录音停止
  -> POST /schedule/parse-audio
  -> app/api/device_v1.py:652-666
     -> decode/resample -> transcribe_schedule_audio (qwen_ws._qwen_transcribe)
     -> parse_schedule_text(transcript, reference, timezone)
```

服务端 `schedule_parser_service.py:4477-4564` 明确是“ASR 转写 -> 文本日程解析”，默认 ASR provider 标记为 `qwen3-asr`。因此音频解析当前至少有 ASR、VAD/分段、网络、文本解析四个时间边；不能把 `/parse-audio` 延迟与纯文本 `/parse` 混报。

### 已有运行证据（仅沿用历史文档，不新增线上操作）

`docs/meeting-real-sample-quality-followup-20260815.md` 记录了此前 8 条公网日程边界请求全部通过、窄样本模型请求中位数约 `1535 ms`、最大约 `2833 ms`，以及手机规则合同 `48/48`、服务端针对性 pytest `71 passed`。这些是窄样本和历史快照，不是当前 p95、长时并发或真机 release 门禁；本文不把它们外推为全链路质量。

### 语音增量流水线的独立比较

日程语义契约不能掩盖语音本身的等待边。当前实时 WebSocket 只在 VAD 分段完成、8030 返回并完成必要的 speaker 旁路后发送 `transcript.completed`；当前离线管线则按最多 8 段/约 12 秒批次 flush。两者都可以有检查点或草稿，但都没有一个可验证的 `partial -> stable -> final` 水位合同。

因此语音候选必须单独记录：

- 首个可读文本时间（录音开始到第一个稳定 segment，而不是模型内部 token 时间）；
- 稳定稿修订次数、重叠去重字符、过早标点率和最终文本；
- CAM++ 首次标签、后到标签和匿名回退时间；
- ASR 队列等待、VAD 分段时间、网络/服务往返、模型推理和持久化时间；
- 单路实时、实时加离线上传、四路并发时的 RSS、GPU 显存和队列深度。

语音有两种可比候选：

1. **M1 增量合同**：不换模型，给实时和离线统一 `AudioSegment`、稳定 segment id、源时间范围、`partial/stable/final` 和修订事件。ASR 先发布 stable 文本；CAM++ 旁路后到，失败时保留匿名文本；最终 canonical transcript 仍由唯一提交边界切换。
2. **R2 流式 ASR 对照**：以 FunASR `paraformer-zh-streaming` 的显式 chunk/look-ahead 或 Qwen3-ASR 官方 streaming runtime 做隔离 benchmark。不能用 README 的吞吐或流式示例直接替代老记的首字、中文质量、说话人和恢复实测；模型权重、运行时和 CUDA 许可证须单独审计。

语音候选的否决条件是：为了得到 stable 文本而阻塞 CAM++；partial 合并会产生不可追溯的重复/丢字；实时和离线各自增加 task/lease owner；或并发时 GPU 争用使实时 p95 明显恶化。只缩短 VAD 静音阈值或批次而不建立水位和恢复合同，不算架构改进。

## 外部资料与适用边界

### Recognizers-Text

[Microsoft Recognizers-Text](https://github.com/microsoft/Recognizers-Text) 的 README 声明 ZH-CN 对 DateTime、数字、范围等实体有支持，包覆盖 .NET、JavaScript/TypeScript 和 Python（Python 标为 alpha），.NET 是主版本，仓库为 MIT。其 release notes 仍持续修复 ZH DateTime 规则，例如 `DateTimePeriod` 和中文 temporal modifier。

可用价值：把“识别日期/时间/数字/范围”从老记自有规则中抽成可替换的时间候选器；MIT 适合服务端或 TS 隔离依赖，且不必引入模型显存。

不能推出的结论：README 的“full support”不是老记口语合同的准确率证明；它不负责日程标题、创建/查询/删除意图、地点不确定、ASR 同音词、确认问题、重复日程业务语义或老记 `ParseResult`。Python alpha 与 .NET/TS 的版本和行为也不能未经回放假定一致。

### SCATE、timenorm 与 normit

[SCATE 的 TACL 研究](https://aclanthology.org/Q18-1025/) 将时间表示为可组合的时间实体和区间，能表达跨日历单位、多跨度和事件相对语义；其论文同时指出，SCATE 比 ISO-TimeML 表达更广，但需要更复杂的组合和评估。

[clulab/timenorm](https://github.com/clulab/timenorm) 提供基于 SCATE 的字符级神经解析器，项目 README 说明需要 anchor time，并以 Scala/Java time API 运行；仓库为 Apache-2.0。[clulab/normit](https://github.com/clulab/normit) 是较新的 Python 时间/地理归一化库，README 展示 `Next`、`RepeatingIntersection` 等 SCATE 风格可执行算子，仓库同为 Apache-2.0。

2025 NeurIPS 论文 [A Semantic Parsing Framework for End-to-End Time Normalization](https://proceedings.neurips.cc/paper_files/paper/2025/file/e722a7be34788c81b53b744e7c7e675c-Paper-Conference.pdf) 报告了可执行 PySCATE、LLM 生成代码、自动验证和 `<=1B` 小模型路线；论文训练/评估使用 SCATE 语料和英文新闻增广，并在单张 80GB A100 上训练 Qwen2.5-0.5B。它证明“可执行语义 + 小模型”值得做隔离研究，但没有证明普通话口语、中文语音转写或老记的重复/提醒合同。

中文相关研究也支持“显式 anchor + 规则/学习混合”而不是盲目端到端替换。例如 [TNorm 中文相对/不完整时间归一化研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC7418025/) 使用 anchor-point、anchor-relation 与规则 span parser，并以 TimeML/ISO-8601 表示结果；其临床语料不是老记日程语料，不能直接作为质量数字。

### ASR 资料

[Qwen3-ASR 官方仓库](https://github.com/QwenLM/Qwen3-ASR) 提供 0.6B/1.7B、中文及方言支持、离线和 streaming；README 明确 streaming 目前走 vLLM backend。仓库代码为 Apache-2.0，但模型权重、Ollama 打包和第三方 runtime 仍需单独核对。

[FunASR 官方仓库](https://github.com/modelscope/FunASR) 提供 `paraformer-zh-streaming`、VAD、标点和 CAM++，代码仓库 MIT，但模型受单独 Model License Agreement/第三方组件许可证约束。它可以作为中文 ASR/流式对照，不应因为代码 MIT 就跳过权重审计。

## 三条路线比较

成本和质量等级是架构判断，不是实测分数；当前唯一可引用的窄样本延迟见上节。

| 维度 | C0 维护现状 | M1 最小共享语义契约（推荐首个隔离候选） | R2 Recognizers + SCATE + 小模型/LLM |
|---|---|---|---|
| 中文质量 | 已有 `48/48` 手机合同、服务端 `71` 个针对性测试和 8 条边界实测；质量由两套规则和 qwen3.5:9b 共同决定，口语新例会继续漂移 | 短期不改变引擎质量；先暴露两端不一致、证据缺失和澄清丢失，便于按字段修复 | Recognizers 对常见中文 DateTime 有基础；SCATE/normit 主要证据来自英文/通用语料，中文口语和 ASR 同音词无直接证据，风险最高 |
| 复杂相对时间 | 当前规则覆盖 `明早/明晚`、周末、范围和重复，但两端同步成本高；模型可处理更复杂句，结果需验证 | 契约可表达 anchor、range、period、timezone 和 unresolved，不强迫当前引擎一次解决全部复杂句 | SCATE 的组合区间理论上最强，能表达“过去三周每周一”等；但中文词法、口语省略、业务重复映射仍需自建 adapter/训练 |
| 首字/首个可见结果延迟 | 本地安全文本近似同步；远端文本历史窄样本中位数约 1.535s；WebSocket 只有分段完成事件，文件音频还要 decode+ASR+parse | 可并行收集本地 draft 与远端候选，并定义 `partial/stable/final`，但要先测取消/合并；不新增常驻模型 | Recognizers 规则 CPU 快；SCATE 小模型仍有模型加载/推理，LLM 编排会增加首字等待。若保留“先 ASR 完成再解析”，替换时间语义不会改善语音首字 |
| 最终准确率/安全 | 规则可能漏掉自然表达，模型可能产生日期/标题泄漏；当前已有 evidence phrase 校验和确认 UI | 以 `source spans + context + needs_clarification` 为统一不变量，能拒绝不安全的跨端结果；质量提升需回放证明 | 可执行 SCATE 让日期计算确定，但生成器错误仍会产生合法而错误的代码；Recognizers/SCATE 都不负责标题、意图和确认安全 |
| CPU/GPU/RAM | 手机规则只占 CPU；服务器已有 Qwen3-ASR 与 qwen3.5:9b，可能竞争 GPU/服务队列 | 0 个新模型、0 个新常驻 worker；主要增加 JSON envelope 和回放工具 | 规则层增加少量 CPU；若部署 <=1B 生成器，仍需额外模型内存/调度；若继续用 9B LLM 编排则没有资源收益 |
| 离线/跨平台 | 手机规则可离线，服务端/模型不可用时复杂输入失败或 fallback；两端规则需同步 | 合同用纯 JSON/TS/Python 回放，手机仍可本地 draft；适配器可渐进替换且不要求 Scala/Java runtime | Recognizers TS/Python 可选；timenorm 偏 Scala，normit Python；Android bundle、Windows CI、Python/Scala 运行时和时区库均增加迁移面 |
| 许可证/供应链 | 当前 qwen3.5:9b Ollama 模型许可未在本工作树闭合；ASR、依赖和模型需持续审计 | 不引入新第三方许可证；只定义内部合同，先以现有模型/规则作为黑盒 | Recognizers MIT、timenorm/normit Apache-2.0；模型权重、SCATE 语料和小模型训练数据/权重仍要逐项确认，不能只看代码许可证 |
| 迁移代价 | 最低；代价是继续维护双规则、多个路由和不可比指标 | 中低；新增一个 canonical draft/adapter 和回放，生产 API 可保持不变；可删除重复字段或旧路由后才算收益 | 高；要定义 SCATE/ISO 到 `ParseResult` 的损失映射，迁移中文训练/回放、时区/重复/提醒、确认和音频链；失败时仍需保留 C0 回退 |
| 主要风险 | “局部修补”使兼容层成为业务真相，跨端漂移和网络等待继续累积 | 契约如果只加 envelope 不删 owner/字段，会成为第四套状态；必须列出删除项 | 误把英语/新闻论文结果当中文口语证据；合法 SCATE 代码不等于正确日程；新增运行时和模型反而加重资源/恢复复杂度 |
| 当前决策 | 只保留为可比较基线，不再扩展新的 parser 分支 | **先做隔离原型**；通过后再决定是否替换某一时间引擎 | **不作为当前目标架构**；先做离线 adapter 对照，未通过中文门禁不得进入生产 |

## 推荐的第一个隔离纵向候选：M1 `ScheduleSemanticDraft v1`

### 合同边界

只做一个纯函数/回放协议，不接生产路由：

```json
{
  "schema_version": 1,
  "source": {"text": "原始中文", "mode": "text|audio_transcript", "raw_text_hash": "..."},
  "context": {"reference_datetime": "ISO-8601", "timezone": "Asia/Shanghai"},
  "intent": "create|query|delete|clarify|reject",
  "spans": {
    "title": [{"text": "...", "start": 0, "end": 2}],
    "date": [], "time": [], "recurrence": [], "location": []
  },
  "slots": {
    "start_date": null, "end_date": null, "start_time": null, "end_time": null,
    "time_period": null, "event_type": "once", "location": null
  },
  "state": "complete|needs_clarification|reject",
  "clarification": {"question": null, "missing": []},
  "provenance": {"engine": "local_rules|server_rules|llm|recognizers|scate", "revision": "..."}
}
```

这是研究合同，不是建议立即改生产 schema。必须满足：解析无副作用；所有日期/时间/重复值能回指原文 span 或明确 `derived_from`；保留 reference datetime/timezone；查询/删除/控制语句不能变成可保存 create；不确定地点、日期、时段必须是 `needs_clarification`；确认动作在合同之外。

### 回放实现（隔离目录）

1. 读取现有手机规则的固定输入/输出 fixture、服务端 `test_schedule_parser_quality.py` 用例和已经脱敏的真实边界样本；把 natural holdout 与 authored/template 扩展分开，不将模板扩展冒充自然证据。
2. 写两个只读 adapter：`mobile-local -> Draft`、`server-parse/clarify -> Draft`。若测试 Recognizers/SCATE，只增加第三个 `recognizers-scate -> Draft` adapter；不改 `src/`、服务端 parser 或 API。
3. 以相同 `reference_datetime`、timezone、原文和回答重放 text、clarify、audio-transcript 三条路径；输出字段级差异、来源 span、route、耗时、异常和内存/显存采样。
4. 对实时语音只回放已有 `transcript.completed` 事件序列和 WAV 元数据，不伪造 token streaming；真实 WebSocket 首个完成事件另列为后续 live gate。

### 必须先测出的基线

- `local_safe`、`clarify`、`server_required`、`reject` 各路 p50/p95；历史 `1.535s` 只作为 server model 窄样本参考，不是阈值。
- `/schedule/parse`、`/schedule/clarify`、`/schedule/parse-audio` 分开统计；audio 再拆 decode、ASR、文本解析。
- WebSocket 从录音开始到首个 `transcript.completed`，以及停止到确认草稿的时间；不要称为首 token。
- 单请求和 4 路并发下 CPU、RSS、GPU 显存、模型加载等待、取消后残留任务；M1 不得引入第二个常驻模型。

## 回放验收门禁

### 语义和安全门禁

- 每条输入必须同时比较 `intent`、标题、日期/日期范围、起止时间、模糊时段、重复、地点、`state` 和澄清缺口；不得只比较最终显示标题。
- 绝对日期、`今天/明天/后天/大后天`、`明早/明晚`、星期/周末、连续相对范围、月份末、跨年和 DST 边界各有固定 reference/timezone 用例。
- 复杂相对时间至少包含“十五分钟后”“下周一”“下个周末”“今明两天”“每周工作日”“每月最后一天”“一周前的周二”以及带地点/参与者/纠正尾句的自然表达；无法安全落地时必须澄清而非猜测。
- 查询、删除、否定、控制句、纯聊天和 ASR 同音歧义必须 `reject` 或服务端操作意图，不能生成可保存 create。
- 同一输入在手机/服务端/候选 adapter 上若字段冲突，回放报告必须显示冲突来源；不能静默选择“看起来完整”的结果。
- 澄清回放要求原 draft 不被覆盖、回答只改变声明字段、二次确认之前不产生保存副作用；旧回答或 stale run 不得覆盖新 draft。

### 质量门槛

- 先以当前 48 条手机合同、服务端 71 条测试和 8 条已记录边界样本作为回归集合；这些通过只能证明不退化，不能证明 natural quality。
- 另建独立中文自然 holdout，按说话人/日期/场景去重并保留原文；至少覆盖短命令、口语省略、纠正、复合范围、地点不确定和 ASR 噪声。holdout 的标注由第二人复核， authored/template 数据单独报告。
- 候选不得降低现有回归集合的字段级 exact-match；对无法判定的自然样本，使用人工语义支持率和澄清正确率，不用模型自评替代人工。
- Recognizers/SCATE 若在中文 holdout 上没有相对 C0 的显著收益，或新增错误会把不确定输入变成可保存事件，则否决替换，不因英文 SCATE 分数继续推进。

### 延迟、资源和迁移门槛

- 候选的 p50/p95 分路延迟不得比 C0 基线恶化超过 10%；若只改善最终耗时却增加首个可见结果等待，视为失败。
- WebSocket 首个完成事件、文件音频最终草稿和澄清完成分别设指标；任何一个阶段超时都必须产生可解释错误/可重试状态，不能卡在“解析中”。
- 单请求及 4 路并发的峰值 RSS/GPU 显存、模型常驻数和 queue wait 必须有记录；M1 目标为新增常驻模型数 `0`。R2 若增加模型，必须证明净资源和质量收益。
- 通过 Linux + Windows CI 的纯 JSON adapter/replay；若使用 Scala/Java timenorm，必须另测 Windows 构建、Android 不打包该 runtime，以及服务端升级/回滚路径。
- 依赖和模型逐项记录许可证、版本、来源、权重条款和可删除方案；代码许可证通过不等于模型/数据可商用。

### 故障和确定性门槛

- 对 HTTP 超时、WebSocket 断开、空 ASR、模型返回 null/坏 JSON、repair retry 失败、进程重启和取消做 deterministic replay；结果只能是可读草稿、明确澄清或明确错误。
- 同一输入/context/revision 的结构化结果应语义等价；模型文本可以不同，但日期、时区、重复和安全状态不得漂移。
- 任何候选都不能绕过“用户确认后保存”、本机原文保留、可删除和隐私边界。无法证明这些合同时，回退到 C0，不接入生产。

## 明确不应采用的假设/方案

1. **“Recognizers 支持 ZH-CN，所以可以删除老记规则。”** 它只覆盖通用实体识别/解析；标题、意图、地点不确定、重复/提醒、ASR 同音词和确认安全仍是老记业务。
2. **“SCATE 论文的英文/新闻或临床结果可外推到中文口语日程。”** 目前没有本项目中文自然 holdout 证据；复杂语义表达能力不等于中文识别率。
3. **“可执行 SCATE 代码天然安全。”** 代码执行确定只保证计算可重复，不保证生成器选中的时间实体正确；必须限制算子、验证原文 span、anchor、timezone 和输出范围。
4. **“把 Recognizers、SCATE、LLM 和旧 parser 全接上就是共享语义。”** 这会增加多个 owner、表示和回退边；没有删除字段、路由或模型，就不满足蓝图的概念预算。
5. **“WebSocket 已经提供首字流式结果。”** 当前服务器只发送分段完成事件；首字指标必须测录音到首个 `transcript.completed`，不能引用模型报告 TTFT 代替。
6. **“模型 0 temperature、JSON repair 就等于确定性。”** 网络、模型版本、上下文、repair 分支和 fallback 仍可能改变结果；回放必须保存 engine/model/prompt revision 和原文 evidence。
7. **“8/8 公网样本、48/48 规则合同或 71 条 pytest 足以宣称全链路质量。”** 它们是窄边界证据，未覆盖长尾中文、并发、设备冷启动、网络断开、音频质量和跨版本迁移。
8. **“代码仓库 MIT/Apache-2.0 就完成许可证审计。”** Qwen/FunASR 权重、SCATE 数据、训练增广语料、Ollama 包和 transitive dependencies 必须独立确认。
9. **“先替换时间引擎再处理确认/副作用。”** 解析、澄清和确认边界是同一用户合同；先替换引擎会把合法但错误的草稿更快地写入日历。

## 决策

- C0 继续作为可回滚基线，但不再扩展第三套规则或新的模型回退分支。
- **最值得做的首个隔离纵向候选是 M1 `ScheduleSemanticDraft v1` 的双适配器回放**：复用现有手机规则、服务端 quick/model/clarify 和音频转写结果，只统一证据、context、intent、slots、澄清和 provenance；先证明能减少跨端语义差异和不诚实状态，再讨论并发/partial 输出。
- R2 只保留为第二阶段离线对照：优先测试 Recognizers-Text 作为时间候选器、normit/PySCATE 作为受限区间 evaluator，不直接用英文 SCATE 小模型或新的 LLM 编排替换生产。只有中文自然 holdout、延迟、资源、许可证和迁移门禁全部通过，才可形成下一份候选蓝图。
- 若 M1 不能删除至少一组重复路由/字段/状态 owner，或回放显示统一 envelope 只增加复杂度，则停止重构，维持 C0；不要以“共享”名义继续堆叠抽象。

## 外部资料

- [Microsoft Recognizers-Text README（多语言、ZH-CN、平台与 MIT）](https://github.com/microsoft/Recognizers-Text)
- [Recognizers-Text releases（含 ZH DateTime 修复记录）](https://github.com/microsoft/Recognizers-Text/releases)
- [From Characters to Time Intervals（SCATE 与时间区间评估）](https://aclanthology.org/Q18-1025/)
- [clulab/timenorm（SCATE 神经解析器，Apache-2.0）](https://github.com/clulab/timenorm)
- [clulab/normit（Python SCATE 风格可执行算子，Apache-2.0）](https://github.com/clulab/normit)
- [A Semantic Parsing Framework for End-to-End Time Normalization（NeurIPS 2025）](https://proceedings.neurips.cc/paper_files/paper/2025/file/e722a7be34788c81b53b744e7c7e675c-Paper-Conference.pdf)
- [TNorm：中文相对/不完整时间表达式归一化](https://pmc.ncbi.nlm.nih.gov/articles/PMC7418025/)
- [Qwen3-ASR 官方仓库（中文、streaming、Apache-2.0 代码）](https://github.com/QwenLM/Qwen3-ASR)
- [FunASR 官方仓库（Paraformer streaming、VAD、CAM++、模型许可证提示）](https://github.com/modelscope/FunASR)

## 隔离证据

- [候选 0009：日程草稿与语音水位合同证据](../evidence/candidate-0009-schedule-draft-watermark-20260816.md)
- [语音专题 0008](0008-speech-pipeline-frontier-options-20260816.md)
