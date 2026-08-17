# 持久运行时候选 0001 独立审阅

审阅日期：2026-08-16（Asia/Shanghai）
审阅对象：`/home/yydd/LaoJi-candidates/cognitive-runtime-0001`，commit `92d27de`
审阅边界：源码、隔离原型、官方资料与服务器只读观测；未修改生产源码、服务、设备、模型、DNS、数据或 `CURRENT.md`
结论状态：**否决当前实现作为生产架构；保留部分原则；下一版需重写运行时核心，而不是在本原型上继续包装。**

## 1. 证据等级

- `[S]` 源码确认：直接读取当前工作树或服务端工作树源码。
- `[P]` 原型实验：在隔离候选仓库执行测试、replay 或探针所得。
- `[L]` 实时观测：2026-08-16 对当前服务器进行只读检查所得，只代表观测时刻。
- `[I]` 推断：由已确认事实推导出的架构判断，仍需实验反证。
- `[U]` 未验证：现有材料声称或目标要求，但本轮没有相应运行证据。

## 2. 决策摘要

1. **不采用 commit `92d27de`。** 它验证了若干数据合同，但没有实现 durable runtime：图不执行节点，结果、trace、registry 和 dedupe 均只存在于进程内存；不存在真正的 `EvidenceBundle`、`InferenceGateway`、持久恢复、取消、资源准入或事务级 compare-and-set。`[S][P]`
2. **保留四项设计要求，而不是保留当前类结构：**稳定任务身份、不可变来源血缘、单一持久任务所有者、提交时校验 active source revision/hash。`[I]`
3. **移动端不引入 Python durable runtime。** Android 继续让 WorkManager 负责操作系统级持久唤醒、网络约束、重试与取消，本地 SQLite/资产负责离线可读；运行时统一不能破坏这条边界。`[S][I]`
4. **服务端先做一个 `meeting.summary` / summary-v3 隔离切片。** 以现有 SQLite ledger 为基线，同时评估 DBOS；只有 DBOS 能在不形成第二套 ledger、并能删除旧 owner 时才可继续。Restate 与 Temporal 暂列保留方案，不进入生产。`[I]`
5. **任何框架都不能把外部 LLM/ASR 调用变成天然 exactly-once。** worker/step/activity 可能重试；目标应是“调用可重复、结果唯一提交、来源版本不串线”，而不是宣称模型只调用一次。`[I]`

## 3. 当前系统不是一张白纸

### 3.1 移动端已经有持久边界

| 已有能力 | 源码证据 | 审阅判断 |
|---|---|---|
| 五阶段处理模型 | `src/domain/meeting/processing.ts:1-55` 定义 `capture/upload/transcript/summary/speaker` 及各自状态；`:65-97` 已包含 attempt、progress、job ID、input fingerprint、retry 信息 | 新 runtime 若再维护一套 `queued/running/...` 且不替换旧阶段，就会产生第二套状态真相源。`[S][I]` |
| 阶段写入约束 | 同文件 `:191-230` 只校验同 stage、值域、时间和 progress，没有声明每阶段合法状态边 | 候选的通用状态机没有接管这套模型，不能算已修复。`[S]` |
| 整理任务提示表 | `src/services/meetingSummaryTasks.ts:14-35,126-201` 在 app storage 保存 pending summary task；`:46-123` 另算客户端 input fingerprint | 与服务端 task ledger、v3 source fingerprint 并存；迁移必须明确谁退出。`[S]` |
| 转写完成任务表 | `src/services/meetingTranscriptCompletionTasks.ts:3-19,42-172` 维护 pending/retry/attempt；`src/services/deviceTranscriptTasks.ts:76-110,120-191` 又维护 device task registry | 通用任务图若只新增 facade，不会减少 owner。`[S][I]` |
| 本机 durable upload | `LaojiTransferModule.kt:42-103` 使用 unique WorkManager work、网络约束、指数退避和取消；`MeetingUploadWorker.kt:3,25-86` 明确处理进程死亡恢复与 retry | 这是 Android 平台职责，不应由服务端 Python runtime 取代。`[S]` |
| 本地 outbox | `src/data/db/migrations/0001MeetingMemorySchema.ts:238-255` 建立 `sync_outbox`，后续 migration/repository 扩展 claim、retry、blocked 等状态 | 是否每类 outbox 都有真实消费者仍需运行证据，不能把 registry 的内存检查当闭环证明。`[S][U]` |

Android 源码还说明 WorkManager input 不保存 bearer token，credential lease 与 generation 分离（`src/native/nativeTransferCoordinator.ts:54-135`；`LaojiTransferModule.kt:31-40`）。统一运行时不得以“统一”为由把 token、原始音频或本机可读性搬进新的远端任务表。`[S][I]`

### 3.2 服务端已存在接近 durable ledger 的实现

本节源码根目录为 `/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend`。`[S]`

| 已有能力 | 源码证据 | 审阅判断 |
|---|---|---|
| SQLite task ledger | `app/services/summary_task_store.py:34-97` 建立 WAL、foreign keys、busy timeout 与 `summary_tasks_v2` | 当前至少有真实持久记录，不应再并列一张候选 task 表。`[S]` |
| 事务 dedupe 与 claim | 同文件 `:132-199` 用 `BEGIN IMMEDIATE` 创建/复用任务；`:214-241` 用有条件 UPDATE claim queued 或过期 running task | 比候选的 dict dedupe 更接近跨线程/跨进程语义。`[S]` |
| lease、heartbeat、checkpoint、恢复 | 同文件 `:244-356,369-384,401-444`；`app/workers/summary_tasks.py:124-133,615-689,1135-1211` | 已有恢复骨架，但仍是 summary 专用，且没有完整取消与通用 graph revision。`[S]` |
| 进程内重复 owner | `app/workers/summary_tasks.py:73-109,472-523` 同时维护 executor、Future maps、dedupe maps、serialization futures | 新 runtime 必须删除这些 owner 中至少一套；不能在其上再叠 `RuntimeCoordinator._results`。`[S][I]` |
| 加密 source payload | `app/services/summary_v3_store.py:58-70,103-211` 使用临时 AES-GCM payload；worker `:526-582` 只在 task request 保存 opaque payload ID | summary-v3 切片应复用而非重新复制用户文本。`[S]` |
| v3 result identity | `summary_v3_store.py:72-96,260-284,300-408` 已保存 source fingerprint、transcript/model/prompt revision，并用唯一约束及事务切换 active document | 新 runtime 应补齐事务级 active-source CAS，而不是另造不兼容的 `VerifiedResult` 存储。`[S][I]` |
| provider queue | `app/services/llm_provider.py:131-224` 已有 priority queue、单 active worker 与 telemetry；`:464-563` 统一 generation/embedding 调用和 timeout | 候选不存在比它更完整的 gateway；重写应把现有边界收窄并接入 task owner。`[S]` |

因此，“Durable Processing Graph + EvidenceBundle + InferenceGateway”不是从零新增三个模块的问题，而是要让一个 owner 真正替换上述分散 owner。没有删除计划的收敛方案，实际效果是概念增殖。`[I]`

### 3.3 服务器实时约束

- `[L]` 2026-08-16 约 04:40，老记 API 监听 `127.0.0.1:18020`，cwd 为 `/home/zhong/laoji-service-platform/compact-production/backend`，Python `3.12.13`，单 worker，`CUDA_VISIBLE_DEVICES=0`。
- `[L]` ASR `8030` 为 Qwen3-ASR 1.7B，`/api/ready` 返回 ready；老记 Ollama `21434` 当前 `qwen3.5:9b` 约占 9.2 GB VRAM。
- `[L]` 同机还有 `11434` 的 `qwen3:32b`（约 22.6 GB VRAM）、Smart Meeting `8020` 及其他 GPU/Python 进程；两张 RTX 5090 各 32,607 MiB，不能据此盲目加载第二个常驻模型或提升并发。
- `[L]` API `/api/ready` 的 summary task 累计为 `success=51`、`failure=16`、active=0；最近日志中 `summary.facts.v3` 约 20.7 秒，问答 embedding 约 6.5 秒。ready 不是质量或恢复验收。
- `[L]` main/schedule/speaker SQLite 当时均处于 WAL 且 integrity check 正常；主机约 62 GiB RAM，磁盘剩余约 82 GiB。这支持小规模隔离实验，不支持无边界地增加 journal、数据库和常驻服务。

已有现场摘要见 `docs/design-blueprint/evidence/live-server-20260816.md:3-35`。实时事实会漂移，采用前必须重新观测。`[L]`

## 4. 对候选 commit `92d27de` 的复核

本节源码根目录为 `/home/yydd/LaoJi-candidates/cognitive-runtime-0001`。`[S]`

### 4.1 已证明的部分

- `[P]` 本机 `python3` 为 `3.13.5`，运行 `python3 -m unittest discover -s tests -v`，11/11 通过。
- `[P]` 四条 fixture 分别覆盖 `schedule.parse`、`asr.transcribe`、`meeting.summary`、`meeting.question`，确定性 replay 可输出 JSON。
- `[S]` `TaskSpec.identity()` 对 evidence 排序稳定，revision/hash 参与身份（`runtime_contracts.py:108-141`）。
- `[S]` `ProcessingGraph.layers()` 能拒绝缺失依赖和环（`:144-184`）。
- `[S]` `TaskTrace` 能拒绝声明外的状态边（`:187-229`）。
- `[S]` `VerifiedResult` 保留 source pointer、provider revision、output digest（`:276-285,320-329`）。

这些是合同单元测试，不是持久执行、故障恢复、并行、取消、真实 provider 或生产迁移证据。

### 4.2 阻断性缺口

| 缺口 | 直接证据 | 后果 |
|---|---|---|
| Graph 不执行 | `RuntimeCoordinator.run()` 仅把 `graph.layers()` 写入 trace，随后只调用一次 `provider.invoke(task)`（`runtime_contracts.py:292-309`）；`GraphNode` 没有 executable、input/output 或 checkpoint | ASR 的 `recognize` / `speakers` 只是同层字符串，不存在并行、节点重试或恢复。`[S][P]` |
| 没有真正的 `EvidenceBundle` | 模块只有 `EvidenceAsset` 与 `TaskSpec.evidence`；`evidence_bundle_digest()` 只 hash evidence 列表（`:108-141`），不包含目标架构要求的 bundle contract revision/created identity | bundle revision 无法 pin；同一 evidence 在不同 bundle 合同下可能得到相同 bundle digest。`[S]` |
| 没有 `InferenceGateway` | 只有同步 `InferenceProvider.invoke()` Protocol（`:231-249`）和 fake provider（`:348-362`） | 没有 queue、priority admission、timeout、cancel、provider health、fallback 隔离或真实 telemetry。`[S][P]` |
| 所谓 durability 全在内存 | `RuntimeRegistry._bindings` 是 dict（`:255-273`）；`RuntimeCoordinator._results` 是 dict（`:288-302`）；`TaskTrace._events` 是 list（`:196-210`） | 进程退出后 dedupe、结果、事件和注册状态全部丢失；新建 coordinator 会再次调用 provider。`[S][P]` |
| README 的 CAS 表述不成立 | `active_evidence` 是调用者传入的普通 sequence，代码只比较两个 set（`:310-330`），既不读取 authoritative store，也不在同一数据库事务内提交结果 | 检查与提交之间仍可发生 revision 变化；这不是 compare-and-set。`[S]` |
| registry 不能证明 outbox 有消费者 | `assert_complete()` 只检查当前进程内四个 enum 是否注册（`:255-273`）；replay 启动时自行把四个 capability 全部注册到同一 fake provider（`runtime_replay.py:45-56`） | 它没有枚举数据库 durable operations，也没有证明 worker 存活或可 claim；“缺消费者时 fail closed”仅是内存集合测试。`[S]` |
| 无取消或超时 | `run()` 无 cancellation token、deadline 或 timeout 参数；状态表虽列 `CANCELLED`，但 coordinator 没有 cancel API，且 verifying 不能转 cancelled（`:40-59,292-345`） | 用户取消只可能成为状态文案，不能中止 provider/ASR。`[S]` |
| 无版本 pinning | `CapabilityBinding` 没有 graph revision；`provider_revision` 在调用完成后由 provider response 自报；`verification_revision` 硬编码为 `runtime-contract-r1`（`:243-253,320-329`） | 部署升级后无法说明旧任务应以哪版 graph/provider/verification 恢复。`[S]` |
| 无 output verification | verification 仅检查 source refs 是否是 declared subset 且非空（`:309-319`），任意 mapping output 都可 committed | “VerifiedResult”名称强于实现；schema、事实支持、引用完整性和业务 invariant 均未校验。`[S]` |
| 失败 trace 不可恢复 | exception 分支先向内存 trace 写 failed，再重新抛出（`:333-336`），调用方拿不到返回 trace，也无持久写 | 故障调查和 retry decision 无 durable evidence。`[S]` |
| 平台声明未验证 | README `:44-52` 声称 Python 3.12 standard library 且 Linux/Windows safe；本机没有 `python3.12`，本轮只在 Linux Python 3.13.5 运行 | Python 3.12 和 Windows 均为 `[U]`，不能写成已验证。 |

### 4.3 独立探针结果

- `[P]` 对多节点 graph 注入计数 provider，provider 仍只调用 1 次；trace 的 processing event 只记录 layers。
- `[P]` 同一 coordinator 内第二次运行会复用结果；新建 coordinator 后同一 task 再次调用 provider，证明 dedupe 不持久。
- `[P]` 模块反射检查不存在 `InferenceGateway` 类和 `EvidenceBundle` 类。
- `[P]` `RuntimeCoordinator.run` 没有 cancellation/timeout 参数，`TaskTrace` 没有 save/load/persist 方法。

### 4.4 为什么结论是“需重写”而非“补几个方法”

真正的 durable runtime 需要以持久记录和事务为中心：先写 task/step identity，再 claim，执行可重放 step，记录 attempt/checkpoint，最后以 authoritative source revision 做有条件提交。当前原型以同步函数调用和内存对象为中心；在其上补 SQLite adapter、cancel flag 和 queue 会保留两套对象生命周期，并继续与现有 `summary_tasks_v2` 竞争所有权。`[I]`

可复用的是字段与不变量，不是 `RuntimeCoordinator` 的执行结构。`[I]`

## 5. 平台与 durable workflow 方案研究

所有外部资料访问日期均为 2026-08-16。下表只记录官方文档能支持的能力；框架是否适配老记仍需隔离原型。

| 方案 | 官方能力边界 | 对老记的主要代价 | 本轮判断 |
|---|---|---|---|
| Android WorkManager | Android 官方将其定位为需要在 app 退出、设备重启后仍可靠运行的 persistent work；支持 constraints、unique work、查询与取消 | 只适用于 Android 背景任务，不执行服务端 Python graph；running HTTP/模型调用仍需 cooperative cancellation | **移动端保留**，继续负责 upload/同步唤醒。`[S][I]` |
| 自维护 SQLite ledger | SQLite 提供 ACID transaction 与 WAL；现有代码已有 `BEGIN IMMEDIATE`、lease、heartbeat、checkpoint | cancel、workflow version、step retry、observability、备份/WAL 运维均由团队维护；不适合误称通用 graph runtime | **作为单机基线**，可完成最小切片，但必须补齐缺口。`[S][I]` |
| DBOS Python | 官方教程提供 workflow/step recovery；step 为 at-least-once，datasource transaction 可获得 exactly-once transaction semantics；示例可用 SQLite，分布式生产建议 PostgreSQL；取消在下一 step 或可抢占边界生效 | 可能引入独立 system DB/ledger；与现有 raw SQLite + SQLAlchemy 的事务边界必须实测；不能自动取消阻塞的 Ollama/ASR 请求 | **第一隔离候选，不是 adopted**。只与现有 ledger 做同输入对比。`[I][U]` |
| Restate | 官方 workflow 文档提供 durable steps、replay/recovery、parallel、retry、cancellation 与 observability；需独立 Restate Server | 新常驻服务、journal、部署/备份/升级与故障域；当前单机低并发的收益尚未证明 | **暂不引入生产**；若未来跨服务 durable RPC 成为主问题再复核。`[I]` |
| Temporal | 官方生产部署包含 Temporal Service 与 workers；event history 支持 durable replay；activity 通常 at-least-once，需要 idempotency；提供 retry、cancellation、workflow versioning/patching | 基础设施和 deterministic workflow 约束最重；现有同步大函数需明显拆分；当前规模缺少收益证据 | **当前不推荐**；保留为多服务、多租户或长周期工作流规模化后的方案。`[I]` |

### 5.1 关键语义不能混淆

- step/activity/workflow 的“持久恢复”不等于外部 LLM/ASR 只执行一次。crash 发生在远端完成与本地 checkpoint 之间时，调用可能重复。`[I]`
- exactly-once transaction 只覆盖框架明确控制的数据库事务；不覆盖 HTTP、GPU 推理或文件写入。`[I]`
- cancellation 通常在 cooperative/preemptible boundary 生效。若现有 `requests.post(..., timeout=600)` 或同步 OkHttp call 没有 abort handle，框架只能记录取消，不能保证立刻停止计算。`[S][I]`
- durable replay 要求 workflow code 可确定重放或有 version/patch 策略；直接重放当前大段业务函数会把部署升级风险隐藏在框架里。`[I]`

## 6. 推荐边界

```text
Android / Local Memory
  SQLite + immutable local assets
  WorkManager: upload, network constraints, OS restart, user cancellation
            |
            v
Server task API
  stable task identity + immutable source references
            |
            v
Exactly one durable task owner
  existing SQLite ledger baseline  OR  isolated DBOS candidate
  persisted graph revision / step attempts / cancel request / checkpoint
            |
            v
Existing ASR and LLM provider adapters
  bounded queue + timeout + cooperative abort + resource admission
            |
            v
One transactional result commit
  source revision/hash CAS + output hash + citations + active projection
```

“Exactly one durable task owner”是架构约束，不代表执行 exactly-once。provider 可以被 at-least-once 调用，但只能有一份符合当前 source revision 的 committed result。`[I]`

### 6.1 移动端

1. 保留 WorkManager upload，不把 Python workflow engine 打进 APK。`[S][I]`
2. 保留当前 Expo SQLite/本地资产的离线读取；Room 是 Android 官方推荐的 SQLite abstraction，但没有证据说明此时迁移 Room 能减少老记现有跨 JS/native owner，因此不作为本切片前置条件。`[I]`
3. 服务端 task 状态只作为远端处理投影，不替代本机 capture/upload truth。删除、登出和 token generation 继续由本机 tombstone/credential lease 约束。`[S][I]`

### 6.2 服务端

1. 先把现有 `summary_tasks_v2` 视为 baseline owner，补测它真实能做什么，不能先宣布废弃。`[S]`
2. DBOS 只在隔离数据库和 shadow/replay route 中实现同一 summary-v3 切片。若它需要 system database，则该切片内 `summary_tasks_v2` 只能做只读对照或投影，不能同时作为 claim/retry 权威。`[I][U]`
3. 不新建 Restate/Temporal 生产服务，不加载新模型，不提高生产 worker concurrency。`[L][I]`
4. 现有 `llm_provider.py` 先作为 adapter 边界；把 queue wait、model time、timeout、provider revision 和 cancel outcome 纳入 task trace，而不是再包一层同名 gateway。`[S][I]`

## 7. 最小纵向切片：只做 `meeting.summary` / summary-v3

### 7.1 范围

只使用隔离 fixture、脱敏 replay 或明确的 shadow 路由；不改当前生产 API、模型、设备、数据和公网路由。旧链路继续作为基线，候选不得写 active production document。`[I]`

### 7.2 必须真实持久的身份

```text
task_id
logical_task_key
capability = meeting.summary
graph_revision
contract_revision
bundle_digest
source_refs[{asset_id, revision, sha256}]
source_fingerprint
transcript_revision
model_revision
prompt_revision
provider_revision
status + current_step + attempt
cancel_requested_at + cancel_acknowledged_at
checkpoint
output_hash
committed_at
```

复用当前 encrypted source payload、source fingerprint、transcript/model/prompt revision 和 v3 document schema；新增字段必须能指向将删除的旧字段/owner，不能只为候选另建平行表。`[S][I]`

### 7.3 必须执行的节点

```text
freeze_evidence
  -> generate_facts
  -> verify_schema_and_sources
  -> commit_if_sources_still_active
  -> project_shadow_result
```

每个节点必须有持久 attempt、输入/输出 digest、开始/结束时间和错误分类。`generate_facts` 可被重试；`commit_if_sources_still_active` 必须在一个数据库事务内完成 active revision/hash 检查、唯一结果写入和 active 切换。`[I]`

### 7.4 故障注入

至少覆盖以下 crash window：claim 前后、provider 调用前、provider 返回后但 checkpoint 前、verification 前后、commit 前、事务提交后但 worker ack 前、取消与 retry 竞态、部署切换时旧 graph revision 恢复。`[I]`

对每个外部调用保存 request identity；重复调用要么被 provider adapter 幂等复用，要么允许重复计算但结果只提交一次。不得把“数据库没有重复行”误报为“模型没有重复执行”。`[I]`

## 8. 采用门槛与反证条件

| 维度 | 硬门槛 | 失败后的动作 |
|---|---|---|
| 单一 owner | 迁移一个 capability 后至少删除一个旧 task/state owner；任一时刻只有一套 claim/retry/cancel 权威 | 否决候选，不以 adapter 掩盖双写 |
| crash recovery | 100 轮随机 crash/restart 注入全部恢复；无重复 committed result、无 running 永久悬挂、无旧 revision 绑定 | 修复持久语义后从 0 重跑，不豁免 |
| source CAS | 在 generate/verify/commit 各阶段切换 transcript revision，100% 拒绝旧 source 结果成为 active | 否决结果协议 |
| cancellation | queued task 取消后不进入 provider；running task 在已声明 provider/ASR 可观察边界停止并记录 ack；不能只改 UI/status | 补 cancellable transport 或明确 non-preemptible timeout，不宣称支持取消 |
| 版本恢复 | 旧 graph revision 的 in-flight task 在升级后可继续、明确迁移或 fail-closed；不得默默用新代码重放 | 未解决前不得滚动发布 |
| 资源 | 同 workload 的老记 runtime/全机 peak VRAM 相对基线增幅不超过约 5%，不新增常驻大模型 | 降低并行/移除常驻组件；不能占用 11434/Smart Meeting 资源 |
| 延迟 | 固定样本 summary/Q&A p95 不回退超过 10%；同时单列 queue、provider、verification、commit 时间 | 找到等待边，不用平均值掩盖尾延迟 |
| 质量与引用 | 独立 holdout 上结构质量不劣化；声明引用的结果 source refs 完整，旧 revision active commit 为 0 | fail closed，不能删除坏引用后保留无依据正文 |
| Android | 离线读写、进程死亡、重启、断网/恢复、登出、删除与 WorkManager 取消测试通过 | 不迁移移动端 owner |
| 平台 | Linux + Windows CI 均实际运行；服务器目标 Python 3.12 至少跑一轮完整测试 | 继续标 `[U]`，不写“跨平台已验证” |
| 运维 | backup/restore、WAL checkpoint、磁盘上限、任务保留、日志脱敏和 metrics 均有演练 | 不部署新 ledger/service |

若候选只提高局部 latency，却增加 task table、状态枚举、常驻进程或恢复路径，也应否决。复杂度下降是硬指标，不是文档措辞。`[I]`

## 9. 条件性 tombstone 清单

以下只是在对应 capability 通过第 8 节门槛后的删除候选，**本轮不得删除**：

| 旧概念/实现 | 删除前置证据 |
|---|---|
| `app/workers/summary_tasks.py` 的 `_submitted_tasks`、`_task_metadata`、`_task_ids_by_dedupe_key`、`_serialized_task_futures` | 新 owner 已覆盖查询、dedupe、同 meeting serialization、restart recovery，且 crash gate 通过 |
| 服务端 `summary_tasks_v2` | 仅当另一 durable owner 完整接管 claim/lease/checkpoint/cancel/result retention，完成数据迁移与 rollback 演练 |
| 客户端 `meetingSummaryTasks` pending registry | 本地 UI 可从一个持久投影恢复同等 task identity、template/revision/fingerprint 信息 |
| `meetingTranscriptCompletionTasks` 与 `deviceTranscriptTasks` 的重复 registry | transcript capability 已有唯一 device/server owner，离线与重启测试通过 |
| 客户端与服务端重复 summary fingerprint 计算 | 统一 canonical identity 已跨 Linux/Windows/JS/Python fixture 一致 |
| 业务代码 direct provider calls | 所有调用已通过一个有 timeout/cancel/priority/telemetry 的 adapter，调用图审计无旁路 |
| v2 summary task/API compatibility | 一个发布周期内无旧客户端依赖，rollback 与数据导出路径已验证 |
| `summary_v3_upgrade_tasks` | legacy-to-v3 迁移完成且安装基数/剩余任务有实际证据 |
| processing stage mirror/reconcile | 新 graph projection 已成为唯一状态来源，乱序、重启和旧事件回放测试通过 |
| 各类 `sync_outbox` trigger/专用 consumer | 统一 consumer 的生产运行证据完整，或确认功能已废弃；不能仅凭 registry 静态注册删除 |

删除记录应逐项写明 owner before/after、数据迁移、回滚窗口和调用图证据。没有 tombstone 的“统一运行时”不进入 adopted。`[I]`

## 10. 未决问题

1. `[U]` DBOS 是否能在老记现有 SQLite/SQLAlchemy 连接与事务边界内工作，还是必须维护独立 system DB；需要代码探针，不应从文档推断。
2. `[U]` DBOS、Restate Python SDK、Temporal Python SDK 在目标 Windows runner 和 Python 3.12 的实际兼容性与打包体积。
3. `[U]` 现有 Ollama、ASR transport 是否可真正 abort；若不能，取消的最小可观察边界和资源回收时间是多少。
4. `[U]` 当前各类移动端 outbox 是否都有运行中的 consumer；静态 listener/claim API 不能证明闭环。
5. `[U]` 当前 production SQLite backup 是否正确处理 WAL/SHM；不能复制单个主文件当一致备份。
6. `[U]` summary-v3 当前 active document 切换前是否总能在同一事务读到 authoritative transcript revision；现有 schema 保存 revision，但仍需端到端竞态测试。

## 11. 官方资料

访问日期均为 2026-08-16：

### Android

- WorkManager API：<https://developer.android.com/reference/androidx/work/WorkManager.html>
- Persistent background work：<https://developer.android.com/develop/background-work/background-tasks/persistent.html>
- Manage work / cancellation：<https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work>
- Room：<https://developer.android.com/training/data-storage/room/>
- SQLite on Android：<https://developer.android.com/training/data-storage/sqlite>

### Durable workflow

- Restate workflows：<https://docs.restate.dev/tour/workflows>
- Restate overview：<https://docs.restate.dev/>
- DBOS Python workflow tutorial：<https://docs.dbos.dev/python/tutorials/workflow-tutorial>
- DBOS database connections：<https://docs.dbos.dev/python/tutorials/database-connection>
- DBOS workflow recovery：<https://docs.dbos.dev/production/workflow-recovery>
- DBOS transaction tutorial：<https://docs.dbos.dev/python/tutorials/transaction-tutorial>
- Temporal production deployment：<https://docs.temporal.io/production-deployment>
- Temporal workflow definition：<https://docs.temporal.io/workflow-definition>
- Temporal event history：<https://docs.temporal.io/encyclopedia/event-history>
- Temporal Python versioning：<https://docs.temporal.io/develop/python/workflows/versioning>
- Temporal Python error/cancellation handling：<https://docs.temporal.io/develop/python/best-practices/error-handling>

### SQLite 与 Python

- SQLite overview：<https://sqlite.org/about.html>
- SQLite transactions：<https://sqlite.org/transactional.html>
- SQLite corruption risks：<https://sqlite.org/howtocorrupt.html>
- SQLite WAL：<https://sqlite.org/wal.html>
- Python 3.12 library：<https://docs.python.org/3.12/library/>
- Python 3.12 asyncio tasks / cancellation：<https://docs.python.org/3.12/library/asyncio-task.html>

## 12. 最终结论

候选 `92d27de` 是一份有用的合同草图，不是 durable runtime。它当前最危险的地方不是缺少功能，而是名称会让内存 set/dict、同步 fake provider 和普通 set equality 看起来已经实现了 registry、gateway、durability 与 CAS。`[S][P][I]`

本轮结论是：**否决当前实现进入生产或成为 adopted 架构；保留任务身份、来源血缘、单一 owner 和事务提交四项要求；先以 summary-v3 做现有 SQLite ledger 与 DBOS 的隔离对照，达到删除旧 owner、故障恢复、取消、资源、质量和跨平台门槛后再决策。**

本报告不改变 `CURRENT.md` 的当前选择，也不授权任何生产迁移。
