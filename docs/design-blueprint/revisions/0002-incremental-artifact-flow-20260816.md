# 蓝图修订 0002：增量证据流与概念预算

## 状态与边界

- status: `candidate + prototype-selected`; **not adopted**
- parent: `0001-baseline-20260816`
- observed at: `2026-08-16 Asia/Shanghai`
- source worktree: `/home/yydd/LaoJi-worktrees/feishu-source-driven`
- source commit observed: `48e3b36dff2cfc6b9b89c9a2f870ed88c802ebdf`
- evidence mode: source/document inspection and public research only; no production, server, device, data, deployment, GPU or API mutation

本修订是一次独立复核。`0001` 中的方案、原型和结论在本文件中都只作为待证伪输入，不作为已验证事实。源码工作树在观察时仍有大量 modified、deleted 和 untracked 项；因此“源码观察到”不等于“当前发布包、公网服务或真机正在运行”。

## 1. 对第一版的判断

### 1.1 已经做到的部分

第一版确实抓住了用户要求的两个方向：

1. 能力矩阵把日程、录音、导入、转写、讲话人、笔记、整理、问答、搜索、标签、删除、主题和更新作为用户结果底线，而不是把当前实现当成不可变合同。
2. `0001` 明确允许替换规则、模型、API、任务表和页面状态，并要求保留来源、隐私和恢复能力。
3. 它提出了维护、统一内核、本机记忆和证据图等不同方向，没有直接把某个当前模型或端口宣布为目标答案。

这些是**设计意图**，不是架构已被证明的证据。

### 1.2 最关键的缺口

结论：第一版**部分满足，但还没有真正体现“重做原始链路”**。最关键缺口不是少一张架构图，而是没有给出可反驳的“概念减少 + 等待减少”合同。

1. **概念预算缺失。** 文档声称围绕五个概念组织，但实际候选同时要求 `EvidenceAsset`、`EvidenceBundle`、`ProcessingGraph`、任务账本、`InferenceGateway`、Provider、`VerifiedResult`、`ProjectionEnvelope`、capability registry、CAS 和多种 adapter。没有列出会删除的现有对象、状态和接口，也没有规定新概念数量必须低于旧概念数量；这可能只是把复杂度换了名字。
2. **统一验证阶段可能重造串行闸门。** `queued -> admitted -> running -> verifying -> committed` 适合需要完整提交的单个结果，却没有定义“可读初稿、稳定稿、完整稿”各自何时发布。若所有结果都要等待完整 Bundle、统一验证和 CAS，ASR、讲话人、整理和问答仍会互相等待，违背“减少串行等待”。
3. **单一网关可能成为新的巨型单体。** 日程解析、ASR、整理和问答的资源、取消和质量边界不同；把它们都送进一个 Gateway/ledger 并不自动形成一个状态所有者，反而可能增加跨能力耦合和全局排队。
4. **本机权威的代价没有闭合。** “手机是权威”是候选假设，不是事实。设备丢失、换机、导出恢复、多设备读取、远端任务续跑、永久删除和隐私擦除的合同未给出；不能把 account/guest 直接删掉而不证明这些结果仍可获得。
5. **UI 候选只压低了乱序风险，没有解决数据源复杂度。** `dataEpoch + entityRevision + viewEpoch + surfaceInstanceId` 比现状更明确，但仍是四个时钟；如果上游没有一个本地投影 reducer，它可能成为新的 envelope 适配层。通过中文文案判断阶段的缺陷被指出了，却没有定义哪个数据结构替代它。
6. **日程链路仍按“先本机判断、再远端路由”思考。** 没有比较本机和远端并发推测、可取消的澄清和结果合并；因此最频繁的短交互仍承担网络往返。
7. **没有产品级验收不变量。** “保留能力”没有落实为首屏可用、首个可读文字、首个可核对事实、删除可恢复、引用不跨会、用户编辑不被覆盖等可测量旅程和阈值。
8. **外部研究为空。** 第一版没有说明为何选择自建 DAG、durable workflow、流式 ASR 或本地优先数据模型，也没有记录它们会引入的概念和限制。

## 2. 只读源码证据

以下是本次独立检查所得事实；括号中的行号是观察时的源码位置，随 dirty worktree 变化时需要重新核对。

| 观察 | 证据 | 对蓝图的含义 |
|---|---|---|
| 文本日程解析先本机规则，再按路由决定远端请求 | `src/services/api.ts:426-459` 调用 `parseLocalScheduleText`、`classifyScheduleParseRoute`，只有非 `local_safe/clarify` 才 `await parseScheduleRemotely` | 当前存在明确的串行网络分支；“共享契约”还没有并发或合并语义 |
| 本机解析同时负责归一化、日期/时间/重复/澄清和路由信号 | `src/services/localScheduleParser.ts:1272-1403, 1435-1647` | 规则不是单一 validator，而是一个决策系统；替换时必须保留无副作用 Draft 合同 |
| 阶段类型有值域，但跃迁函数只校验同阶段、时间、进度和字段 | `src/domain/meeting/processing.ts:65-231` | “状态字段存在”不等于合法边或跨阶段因果已被约束 |
| 五个 stage 的显示状态按优先级折叠成一个 label | `src/domain/meeting/processing.ts:293-380` | 一个文案可能隐藏并行阶段；UI 不能把 label 当权威状态 |
| 整理 v3 的本地投影把转写 revision 设为 null | `src/services/meetingSummaryV3.ts:538-615`，尤其 `transcriptRevisionId: null` | 版本血缘风险是真实代码事实；不能只依赖摘要正文过滤坏引用 |
| 设备整理采用提交任务、轮询、取结果的串行调用 | `src/services/meetingSummary.ts:451-535`；任务接口在 `src/services/deviceApi.ts:884-945` | 当前可观察到长等待链；候选需量化首个可用结果而非只量化最终耗时 |
| 转写完成 provider 以持久提示、轮询和缓存 revision 维护后台状态 | `src/components/DeviceMeetingCompletionProvider.tsx:18-175` | 现状有恢复意图，但任务、缓存和页面投影仍是多方状态来源 |
| Native detail 为每个 tab 保存 generation，并逐字段合并快照 | `src/native/nativeMinutesSnapshots.ts:151-179, 758-832`；`modules/laoji-native-platform/src/minutes.ts:166-179` | per-tab generation 不是统一实体 revision；需要一个 reducer/投影边界 |
| Native 状态仍从 processing 文案推断摘要/讲话人范围 | `modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/MinutesState.kt:550-600`；渲染同类判断见 `MinutesDetailSurface.kt:589-610` | 文案泄漏为状态协议的事实仍存在，不能宣称 `0002` 候选已解决 |
| 多个 sync trigger 和 claim/complete/fail repository 定义并存 | `src/application/meeting/*SyncTrigger.ts`；`src/data/repositories/sqliteMeetingNoteRepository.ts:6023-11614` | 静态调用图可提示悬空 outbox，但不能仅凭 `rg` 证明运行时没有消费者；需独立 bundle/日志核验 |

## 3. 事实、假设、研究和候选的分层

### 事实（`observed`）

- 当前源码存在规则解析、远端解析、多个会议处理阶段、任务轮询、缓存/镜像、Native/JS 多层投影。
- 当前 dirty worktree 不能作为可回溯发布基线。
- v3 结果对象在本地投影处丢失 `transcriptRevisionId`，这是静态代码事实，不等于已证明的线上数据损坏。
- 当前没有在本修订中运行真实模型、真机、生产服务或 GPU 基准。

### 假设（`hypothesis`）

- 将 ASR、讲话人和整理拆成按水位推进的分支，能减少首个可读结果的等待。
- 一个带来源引用的 Artifact 单位可以同时承载初稿、稳定稿、事实和验证结果，减少 Bundle/Result 双重身份。
- 单一本地 reducer 能够替代 tab generation 拼接，并维持现有 LaoJi UI 的稳定骨架和状态诚实性。
- 单设备本机权威在加入导出/恢复/擦除协议后，仍能满足当前用户结果底线。

这些假设必须在隔离回放中证伪或确认，不能升级为 `adopted`。

### 外部研究（`researched`）

截至 2026-08-16，研究了下列一手文档、论文和开源工程。研究结论只约束候选设计，不选择具体生产模型。

| 来源 | 直接可用的观察 | LaoJi 采用/拒绝状态 |
|---|---|---|
| [Kotlin structured concurrency](https://kotlinlang.org/docs/coroutines-basics.html) 与 [composing suspend functions](https://kotlinlang.org/docs/composing-suspending-functions.html) | `async` 可以并发兄弟工作，父 scope 取消会传播；但 scope 默认要等所有 child 完成 | **采用原则**：进程内用结构化取消；独立用户可见分支不能放进必须等全体完成的单一 await |
| [Android WorkManager getting started](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started) 与 [API reference](https://developer.android.com/reference/androidx/work/WorkManager.html) | 支持持久 WorkRequest、约束、重试和 unique work；依赖链失败会阻止后继 work | **限定采用**：只作为 Android 本地 durable executor；不把独立 ASR/讲话人/整理强行串成一条 unique chain |
| [Temporal workflow model](https://docs.temporal.io/workflows) 与 [async child workflows](https://docs.temporal.io/develop/java/workflows/child-workflows) | 事件历史提供恢复，child workflow 可并行；同时引入 workflow definition/type/execution、activity、history 和外部服务 | **拒绝作为默认目标**：恢复能力有价值，但概念和运维面不符合“先减少概念”的硬约束；只作对照 |
| [DBOS architecture](https://docs.dbos.dev/architecture) | 用 Postgres checkpoint workflow/step，不需独立 orchestration server；每步持久化并可用 durable queue 控制并发；要求 workflow deterministic、step idempotent | **保留为服务器隔离备选**：可做对照原型，但 Postgres、checkpoint、升级兼容和队列仍是新增面，不能先加入生产 |
| [Dagu open-source workflow engine](https://github.com/dagucloud/dagu) | 单二进制、文件状态、YAML DAG、并行和并发控制，跨 Linux/Mac/Windows | **拒绝嵌入**：通用运维编排、GPL-3.0 和 YAML/运行历史会增加产品边界；仅作为“单进程可简化”反例/参照 |
| [SimulStreaming](https://github.com/ufal/SimulStreaming) 与其 [IWSLT 2025 论文](https://aclanthology.org/2025.iwslt-1.41/) | 以 JSONL 增量输出 partial/final，支持 chunk、VAD、局部上下文；质量/延迟可显式测量 | **采用协议思想**：转写输出必须允许 partial、stable、final 和 emission time；不采纳其模型/硬件配置为默认 |
| [Qwen ASR streaming implementation](https://github.com/antirez/qwen-asr) | 2 秒 chunk、缓存完成窗口、rollback suffix、只发稳定文字、最终 chunk flush；滑动窗口限制长期内存 | **采用原型输入**：验证“稳定水位 + 有界上下文”是否减少等待；模型质量、许可证和中文会议表现仍待测 |
| [FunASR](https://github.com/modelscope/FunASR) | 提供 Paraformer streaming、VAD、标点和 CAM++ 讲话人流水线；示例用约 600ms chunk/cache | **候选适配器**：可作为隔离 ASR/讲话人对照；权重许可证、GPU/CPU 资源和真实样本质量必须独立审计 |
| [Algebraic Replicated Data Types](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2023.14) | 研究 coordination-free、隐私本地优先和最终一致的复制数据类型 | **暂缓**：老记当前主要是单设备个人工具；未证明多设备协作需要 CRDT，不能为“现代”而引入 |

研究共同指向：先把可见输出切成增量、有界、可取消的产物，再选择执行器；不能先部署一个更大的 workflow/gateway 来掩盖等待。

## 4. 三条路线比较

评分使用 `低/中/高` 表示成本或风险；不是性能实测。

| 路线 | 定义 | 概念与状态 | 首个可用结果 | 离线/恢复 | 迁移成本 | 主要失败模式 | 结论 |
|---|---|---|---|---|---|---|---|
| C0 当前方案 | 保留规则/远端解析、多个 Provider/API、stage mirror、轮询和 per-tab UI 状态，继续局部修补 | 高；状态来源至少跨规则、stage、task、cache、mirror、Native | 规则短句快；会议结果受上传/轮询/整理链影响 | 中；已有若干本地缓存和恢复指针，但闭环需核验 | 低 | 兼容层继续成为业务真相，局部 fallback 增长 | 仅作基线，不再扩展 |
| M1 最小重构 | 保留 SQLite、现有 API/Provider 作为 adapter；新增一个本地 Operation/Artifact 账本和一个 detail reducer；在边界内并发执行并渐进替换旧状态 | 中低；删除每 tab generation 拼接和 stage label 推断，保留适配层 | 高潜力；本机初稿立即投影，远端分支按水位回填 | 中高；WorkManager/SQLite 保留，旧 API 可回滚 | 中 | 适配层若无退出日期会永久存活；双写造成第二真相源 | **首选隔离原型** |
| G1 Greenfield 替代 | 全新本机 Artifact ledger + demand-driven workers + stateless inference adapters + 单 reducer；不保留旧 API、任务表和页面状态协议 | 理论最低，但需证明 Artifact/Operation/Projection 三个概念足够 | 最高潜力；ASR partial、speaker stable、summary watermark 可并行 | 高潜力，但换机/导出/同步/擦除必须重做 | 高 | 迁移遗漏能力、设备损坏、资源/隐私边界不成熟 | 仅做回放/合同原型，不进入当前产品 |

### 路线选择规则

- 任何路线必须把用户结果列成可执行验收：录音立即可读、文字可增量、整理可引用、用户编辑不被覆盖、删除可恢复/永久语义清楚、问答不跨会议、主题和导航不跳动。
- 任何路线若新增概念数不低于 C0，或仍把独立能力放在一个全体等待的 barrier 后，自动退回 `hypothesis`。
- M1 只有在同输入回放证明“少一个状态真相源、少一个串行等待边、无来源丢失”后，才可决定是否向 G1 迁移。

## 5. 候选目标：Incremental Artifact Flow

这不是 `0001` 的 Gateway/Graph 全量采用，而是一个更窄、可测量的目标候选。

### 5.1 最小概念

```text
Artifact {
  artifactId
  kind                 // audio-segment, transcript, speaker, fact, answer
  sourceRefs[]         // artifactId + revision + contentHash
  revision
  contentHash
  maturity              // provisional | stable | final | rejected
  availability          // local | remote | verified
  operationId
}

Operation {
  operationId
  capability
  inputRefs[]
  requestedMaturity
  state                  // pending | running | available | retryable | cancelled | superseded
  cancelToken
}

Projection = reduce(ordered Artifacts, user edits, local metadata)
```

`Artifact` 是唯一结果/中间产物身份；不再为同一输出另造 `EvidenceBundle` 和 `VerifiedResult` 两个身份。`Operation` 只记录执行生命周期，不能拥有业务事实。`Projection` 是可重建视图，不是第三种事实来源。字段名和存储形式仍是候选，不得直接写入生产表。

### 5.2 数据流和等待边

```text
MediaAsset -> segment artifacts
                   +-> ASR partial -> ASR stable -> transcript final
                   +-> speaker stable ------------------+
                   +-> facts from stable transcript -----+-> cited summary projection
                   +-> local note -----------------------+
```

- 录音落本机后即可产生 segment artifact；上传与本机播放/转写不互相阻塞。
- ASR partial 只允许在 UI 标为 provisional；稳定水位通过 segment/hash 发布，不能静默覆盖用户编辑。
- 讲话人处理已稳定的片段窗口，不等待完整会议；失败只使讲话人 artifact 降级，不隐藏文字。
- 整理在达到声明的 transcript watermark 后开始，可先发布带引用的局部事实；完整稿是后续 maturity，而非首个结果的前置条件。
- 问答要求 final/verified source refs；它可以拒绝不完整证据，但不应阻塞录音和文字。
- 验证是每个 artifact 的 source/hash/claim 检查，失败隔离该 artifact；没有全局 `verifying -> committed` 闸门。

### 5.3 本地和远端边界

- UI 架构可以重做，但当前已确认的 LaoJi 用户合同仍是覆盖底线：会议五个 detail tab、稳定的 tab/status/player 骨架、两套主题、录音即时状态、局部状态提示和不触发 touch-through 的手势；新 reducer 只能改变数据输入和状态所有权，不能偷偷删除这些结果。
- 本地 SQLite/文件只保存原始资产、Artifact 索引、用户编辑和可重建投影；设备离线时这些内容可读。
- Android WorkManager 或等价本地执行器只负责持久唤醒、约束和重试；Kotlin structured concurrency 负责一个进程内兄弟操作的取消。
- 远端只接收经过授权的 `inputRefs + operation`，返回不可变 Artifact；Provider 名称不进入用户事实或页面状态。
- 旧 API/Provider 在 M1 中只能是 adapter，必须有 `deprecated` 日期和双写退出证据；不得同时成为第二任务真相源。

## 6. 下一项架构决策/隔离原型

### 选定方向

`P-0002 Incremental Meeting Artifact Flow Replay`，状态 `candidate; prototype-selected; not adopted`。

选择会议而非先改 UI 或先改日程解析的理由：它同时暴露最大串行等待（上传、转写、轮询、整理）、最清晰的来源血缘需求（音频片段 -> 转写 -> 引用事实）和当前已存在的 partial/final/reprocessed 现实数据。该原型能在不改生产的情况下同时检验概念预算、并行边和 UI 投影输入。

### 原型范围

1. 只读加载已经批准的脱敏会议样本或合成回放输入；不访问生产 API、不写生产数据库、不操作真机或部署。
2. 实现 Artifact/Operation/Projection 的纯合同和 replay runner；保留一个 C0 适配器以产生基线事件序列。
3. 同一音频按 segment 产生 ASR partial/stable/final；讲话人和事实分支在 stable watermark 到达时启动；结果携带 sourceRefs/hash。
4. 提供 M1 运行模式和 G1 运行模式：M1 模拟旧 API adapter，G1 模拟无旧 API 的本机/远端边界。
5. 注入乱序、重复、取消、重启、源 revision 变化、讲话人失败、整理超时和 UI 重建；所有事件仍可重放出同一投影。

### 必测指标

- 首个可读 transcript artifact 的 p50/p95 延迟；
- 首个带有效 sourceRef 的 summary fact 的 p50/p95 延迟；
- 完整稿总时长、队列等待占比和各分支重叠时间；
- Artifact/Operation/Projection 的实际概念和状态数量，与 C0/M1 清单逐项对比；
- stale/跨 revision/跨会议引用被接受的数量（目标为 0）；
- 取消传播、重启恢复、重复提交幂等和用户编辑保留率；
- 峰值 CPU/GPU/内存、模型常驻数和长会内存是否有界；
- 投影 reducer 在前后台、tab 切换和 snapshot 乱序下的稳定性。

### 进入架构决策的门槛

原型只有同时满足以下条件，才进入 M1 实现决策：

- 首个文字和首个可引用事实不再等待完整 transcript/summary；
- 至少删除一类现有状态真相源和一条全局串行等待边；
- 来源 hash/revision、删除、隐私和恢复不退化；
- UI 只消费一个可重建 projection，stale 事件和文案误判为 0；
- 在同一资源预算下，延迟收益不是靠降低证据完整性或增加常驻模型换取。

若不满足，保留 C0 作为基线并否决 M1/G1；不得继续堆 Gateway、fallback 或状态字段。

## 7. 明确暂不采用

- 不把 `Local Memory + Verified Processing` 的五层图直接升级为目标架构；它仍是候选参考。
- 不在生产部署 Temporal、DBOS、Dagu、GraphRAG、递归摘要或第二个常驻大模型。
- 不把 CAS/全量 Bundle 验证设为所有能力的共同提交闸门；需要按 artifact maturity 设计。
- 不先做全量 RN/native envelope 改造；先证明本地 reducer 的单一投影输入。
- 不把 CRDT、多设备同步或账号模型删除当作默认前提；先完成设备恢复、导出、永久删除和隐私擦除合同。

## 8. 待独立复核

1. 用当前发布 APK、真机和实际服务器分别核对源码观察到的 parser、transcript、summary 和 UI 状态是否仍存在；本修订没有做运行时宣称。
2. 对 `sqliteMeetingNoteRepository` 的每种 outbox 做完整 bundle 调用图和启动日志检查，确认哪些 trigger 真有消费者。
3. 审计 v3 结果在所有入口的 transcript revision/hash 传递，验证 `null` 是否已经被其他路径补偿。
4. 用真实中文会议样本评估 FunASR、SimulStreaming、Qwen ASR 等候选的 partial 稳定性、讲话人准确率、长会内存和许可，不把 README 数字当 LaoJi 证据。
5. 评估 Android WorkManager、Windows/Linux 开发工具链和设备后台限制对本地持久执行的影响。
6. 由独立 reviewer 复算 C0/M1/G1 的概念清单、等待边和上述门槛；若清单不能复算，本修订退回 `hypothesis`。

## 9. 当前原型进展

候选 0003 已在隔离仓库实现最小 SQLite Artifact/Operation/Projection 合同：
`/home/yydd/LaoJi-candidates/incremental-artifact-flow-0003`，commit `3f6a633`。
15 项标准库测试通过，证明了 partial/stable/final 替换、来源失效、跨连接取消、重启去重、用户编辑保留、完整 operation 输入 CAS 和无来源结果拒绝等合同；这些仍是合成回放证据。它尚未接现有 summary ledger、真实 Provider、RN/Android 或 Windows，因此不改变本修订的 `candidate; not adopted` 状态。详见 [candidate 0003 evidence](../evidence/candidate-0003-artifact-flow-20260816.md)。

服务器只读对照确认 `summary_tasks_v2` 是当前更完整的持久 task owner，候选 0003 不得再增设第二套生产 claim/lease/retry 表。下一轮应在隔离复制数据库中测试“现有 task owner + Artifact/result 表”的单一事务切片；若无法删除至少一组旧 worker 内存 owner，则不进入 adopted。详见 [summary-v3 ledger comparison](../research/0002-summary-ledger-comparison-20260816.md)。

候选 0004 已完成该单一 owner 的缩减合同原型：`/home/yydd/LaoJi-candidates/summary-artifact-owner-0004`，commit `8faa61c`，9/9 测试通过。它只复刻核心 task schema，尚未证明真实 worker、加密载荷、checkpoint 或内存 owner 可以删除，因此仍不改变本修订的候选状态。详见 [candidate 0004 evidence](../evidence/candidate-0004-summary-artifact-owner-20260816.md)。

移动端独立审计确认候选 0002 尚未接入真实 RN/Android，且生产 serializer 仍允许 shared bearer route。下一 UI 原型应改为单详情 `projectionRevision + surfaceInstanceId`，不再增加 envelope 维度；审计和门禁见 [mobile projection audit](../research/0003-mobile-projection-review-20260816.md)。

候选 0005 已完成该窄合同原型：`/home/yydd/LaoJi-candidates/detail-projection-v2-0005`，commit `2a14696`，10/10 测试通过；它尚未接入 RN/Android，故不改变 `candidate; not adopted` 状态。详见 [candidate 0005 evidence](../evidence/candidate-0005-detail-projection-20260816.md)。

三候选比较后，下一项被限定为 `Summary Artifact Projection r1`：复用现有 `summary_tasks_v2` 唯一 task owner，先验证 final facts artifact 与 Detail Projection reducer 的事务/血缘闭环；不把 0003 的第二 operations owner 带入生产。比较与 100 次故障门禁见 [candidate comparison](../research/0004-candidate-comparison-20260816.md)。

候选 0006 已完成该隔离集成：`/home/yydd/LaoJi-candidates/summary-artifact-projection-r1-0006`，commit `6f2140a`，100 轮（50 轮注入回滚）通过。依赖 commit 已锁定，但尚未接生产 task store/worker 或真实页面，因此仍不改变 `candidate; not adopted` 状态。详见 [candidate 0006 evidence](../evidence/candidate-0006-summary-artifact-projection-20260816.md)。
