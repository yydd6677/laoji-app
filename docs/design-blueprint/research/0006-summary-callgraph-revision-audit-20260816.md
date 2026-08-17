# 会议整理端到端调用图与版本血缘审计 2026-08-16

## 状态与边界

- status: `observed; static-audit + isolated-tests; not adopted`
- observed: 2026-08-16 Asia/Shanghai
- source worktrees:
  - Android/client: `/home/yydd/LaoJi-worktrees/feishu-source-driven`
  - service: `/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend`
- 本报告只读取源码、测试和隔离临时 SQLite；没有修改生产代码、服务、设备、数据库、模型、部署或公网路由。
- 没有做当前生产服务器、发布 APK 或真机实时验证；源码观察不能代替部署行为。

## 结论摘要

当前“会议整理”不是一条统一链路，而是三个入口、三组结果存储和多级恢复提示的组合：

1. Android 游客优先走 device API 的 `summary-v3`（能力不具备时退回 device v2）；
2. Android 已登录用户走 account 的旧 `/summaries/generate`/task/detail 合同；
3. 非 Android 兼容页面仍调用同一个生成函数，但保留旧页面状态和旧读取路径。

服务端又同时维护 `summary_tasks_v2`、`summary_v3_documents`、账号 `MeetingSummaryVersionV1/CurrentV1`；客户端还维护 AsyncStorage pending hint、本地 processing stage、canonical transcript/summary、`summary_fact_documents` 和 v3 upgrade task。它们各自有合理的局部职责，但目前没有一个跨边界的单一提交事务。

最重要的静态问题有四个：

- **版本血缘在 v3 投影处断开。** 服务端和本地 `summary_fact_documents` 都有实际 `transcript_revision`，但 `projectMeetingFactsV3()` 写入的 `MeetingSummaryDocument.transcriptRevisionId` 是 `null`；Android 再投影时沿用旧本地 document revision，mirror 最后又强制改成当前本地 transcript revision。结果可以显示正确，但不能从当前 summary document 反推出服务端事实使用的精确 transcript revision。[S]
- **v3 task 404 恢复没有做请求身份匹配。** 轮询 404 后客户端直接读取该会议的 latest v3 document，并接受它作为本次结果；没有比较请求 fingerprint、服务端 source fingerprint、transcript revision、笔记/附件 revision 或模板。force/并发重跑后，旧 task 的恢复可能拿到另一个 active 结果。[S][I]
- **结果提交和 task success 是两个事务。** worker 先提交/切换 `summary_v3_documents.active`，外层随后才把 `summary_tasks_v2` 标为 success；中间崩溃会留下“结果已经可读但任务仍可恢复”的半提交状态。入队时 encrypted payload 保存和 task insert 也分属两个事务。[S]
- **相同时间戳不是当前的重复判定条件。** 服务端、v3 source normalization 和本地 transcript repository 都用 line/segment identity、ordinal、内容和 speaker 区分行；相同 `start_ms` 可以保留为两个独立来源。已有测试没有覆盖这一不变量。[S][P][U]

因此下一步应是一个窄的 lineage/commit 集成切片，而不是把 account v2、device v3 和本地 mirror 再包一层通用 facade。任何候选仍保持 `candidate; not adopted`。

## 实际调用图

```mermaid
flowchart LR
  A[Android TranscriptionScreen] --> B{access mode}
  B -->|guest + capability v3| C[generateDeviceMeetingSummaryV3]
  B -->|guest + no v3| D[generateDeviceMeetingSummaryV2]
  B -->|authenticated| E[generateMeetingSummary account v2]
  F[non-Android TranscriptionScreen] --> E

  C --> G[POST /device/meetings/{id}/summary-v3]
  D --> H[POST /device/meetings/{id}/summary]
  E --> I[POST /api/laoji/meetings/{id}/summaries/generate]
  G --> J[summary_tasks_v2 task_kind=device-summary-v3]
  H --> K[summary_tasks_v2 task_kind=device-final]
  I --> L[summary_tasks_v2 task_kind=final]

  J --> M[_do_device_summary_v3]
  M --> N[load server transcript]
  N --> O[normalize_sources + evidence]
  O --> P[model + verify]
  P --> Q[summary_v3_documents]
  Q --> R[GET latest active v3 document]

  E --> S[account FinalSummary]
  S --> T[MeetingSummaryVersionV1/CurrentV1 materialization]

  C --> U[client parser + local facts result]
  U --> V[canonical local summary mirror]
  V --> W[local current pointer / projection]
  X[AsyncStorage pending hint] -. recovery hint .-> A
  Y[SQLite processing stage] -. durable UI task state .-> A
```

这张图表示源码路径，不表示某个当前部署已经运行过每一条边。

## 入口和身份合同

| 入口 | 代码证据 | 任务/结果 owner | 身份材料 | 备注 |
|---|---|---|---|---|
| Android guest v3 | `src/services/meetingSummary.ts:451-535,688-715`；`src/services/deviceApi.ts:898-930` | server `device-summary-v3` + `summary_v3_documents`；本地 facts/mirror | 客户端 `inputFingerprint`、服务端 `source_fingerprint`、实际 `transcript_revision` | 客户端声明 revision 不是服务端权威 |
| Android guest v2 | `src/services/meetingSummary.ts:369-444`；`src/services/deviceApi.ts:884-896` | server `device-final` + retained result | task request/template/fingerprint；GET durable v2 summary | 与 v3 store 分开 |
| Android account | `src/services/meetingSummary.ts:717-805`；`app/api/app_meetings.py:1679-1760` | server `final` + `FinalSummary` | account payload fingerprint、template、carry-forward/attachments | 没有 account v3 endpoint |
| 非 Android兼容页 | `src/screens/TranscriptionScreen.tsx:453-791` | 同 account/device generator，旧页面状态 | 同上 | 不能用 Android 路径的状态结论替代它 |
| guest v3 upgrade | `src/components/MeetingSummaryV3UpgradeProvider.tsx:50-220`；`src/data/repositories/meetingSummaryV3Repository.ts:288-491` | 本地 `summary_v3_upgrade_tasks` + server task | 本地 transcript projection + client fingerprint | 这是额外的本地后台任务 owner，不是 server task 的别名 |

## 分阶段 owner、revision、重试和错误边界

| 阶段 | 权威 owner | revision/fingerprint | 状态/重试 | 证据等级 |
|---|---|---|---|---|
| transcript API 读取 | device/account endpoint + DB rows | account: `meeting-transcript:<hash>`；device: meeting/draft updated marker | HTTP 读取由客户端分页和 reconnect 处理 | `[S]` |
| v3 submit | `device_v1.create_device_summary_v3` | `normalize_sources()` 计算 source/transcript revision；payload 的 `declared_transcript_revision` 仅保存声明 | header/body idempotency key；identity hit 直接复用 | `[S]` |
| task create/claim | `summary_task_store` | `task_scope + meeting + task_kind + dedupe_key`；`force` 跳过 dedupe | queued/running/success/failure、lease、heartbeat、checkpoint、startup recovery | `[S]` |
| evidence/model/verify | `_do_device_summary_v3` | 执行前比较 expected source/model revision | stage `preparing -> generating -> verifying -> persisting`；lease loss 保留 payload | `[S]` |
| v3 document commit | `summary_v3_store.persist_document` | unique identity 为 scope/meeting/source/model/prompt；document id UUID5 | `BEGIN IMMEDIATE`；同 identity 重新激活旧 document | `[S]` |
| task terminal ack | `_run_after_previous_summary` 外层 | 不再重算 source | 独立 `mark_success`/`mark_failure`；迟到 lease owner 被拒 | `[S]` |
| Android foreground recovery | `TranscriptionScreen.android.tsx` | AsyncStorage fingerprint + SQLite stage jobId | AbortController、pending hint、canonical stage；页面离开不取消 server task | `[S]` |
| local v3 projection | `meetingSummaryV3Repository` + `meetingContentMirror` | facts row 保存 actual transcript revision；summary document 使用 local revision | local transaction 分段写入 facts/version/current pointer | `[S]` |

## 关键发现

### 1. v3 transcript revision 没有进入最终 summary document

服务端 `normalize_sources()` 返回两个不同概念：全量 source fingerprint 和 transcript-only revision（`app/services/summary_v3_evidence.py:253-282`）。API 读取 transcript 后计算它（`app/api/device_v1.py:2090-2121`），worker 重新计算并在 `persist_document()` 中保存实际 revision（`app/workers/summary_tasks.py:4143-4158,4180-4189`）。本地 facts 表也保存了该字段（`src/data/repositories/meetingSummaryV3Repository.ts:93-107`）。

但客户端的事实投影明确写入：

```ts
transcriptRevisionId: null
```

见 `src/services/meetingSummaryV3.ts:598-607`。Android 后续构造 document 时沿用 `current.document.transcriptRevisionId`（`src/screens/TranscriptionScreen.android.tsx:884-892`），而 mirror 最终把写入值替换为 active local transcript revision（`src/services/meetingContentMirror.ts:454-470`）。

这不等于 facts 数据库完全丢失 revision；它说明“服务端事实 revision -> 面向 summary/current pointer 的 document revision”没有闭合。需要区分：

- `[S]` actual revision 在 server document 和 local facts row 存在；
- `[S]` projected summary document 不携带它；
- `[U]` 当前发布 APK 是否还有其他运行时补偿，本轮未验证。

影响是 stale 检查、分享、问答和审计只能看到本地映射 revision，无法仅凭 summary document 证明模型使用的 server transcript snapshot。候选修复应保留 actual revision，并显式记录 local-to-remote mapping；不能把客户端 fingerprint 当权威 revision。

### 2. v3 404 恢复接受 latest，而不是 matching result

`generateDeviceMeetingSummaryV3()` 在 task polling 得到 404 后执行：

- `src/services/meetingSummary.ts:517-525` 调 `getDeviceSummaryV3()`；
- 只要 parser 成功，就立即 `meetingFactsV3ToSummary()` 返回；
- 没有把返回的 `sourceFingerprint` 与本次请求的 fingerprint、manual note/attachment revision、transcript revision 或 task identity 比较。

服务端 GET 只按 device scope + meeting 读取 active latest（`app/api/device_v1.py:2193-2209`；`app/services/summary_v3_store.py:287-297`）。因此在以下静态可行窗口中，恢复结果可能不是原 task 的结果：

1. force 或新 source 已经发表了新的 active document；
2. 旧 task row 不可读，但 meeting 的 latest document 仍存在；
3. 轮询的 task 属于旧 fingerprint，而 GET 返回 newer fingerprint。

这是一项 `[S][I]` 高优先级合同缺口，不是本轮已经在生产复现的用户故障。恢复必须带 matching identity；若只想恢复“该会议任意最新结果”，则 API/客户端应明确把它标为 latest reconciliation，而不能当作原 task completion。

此外，v3 正常和 404 恢复路径都把结果投影为 `DEFAULT_MEETING_TEMPLATE`（`meetingSummary.ts:523,535`），没有使用传入的 `options.template`。v3 facts 本身是模板中立的，Android 随后的本地重投影可能掩盖这一点；非 Android 或 local mirror 失败路径仍可能暴露默认模板。这是 `[S][I]` 中优先级较低的模板边界问题。

### 3. 入队与终态提交都有崩溃窗口

v3 submit 先保存 AES-GCM payload，再创建 persistent task（`app/api/device_v1.py:2151-2179`；`app/services/summary_v3_store.py:135-177`；`app/services/summary_task_store.py:132-199`）。如果 payload commit 后进程退出、task insert 尚未发生，会留下 TTL 内孤儿 payload；task 成功创建后若在恢复前经过 TTL 清理，则 task 仍会引用一个不可解密的 payload，最终由 recovery 标为失败。这是两个事务的窗口，不是原子入队。

worker 生成成功后先调用 `persist_document()`（`app/workers/summary_tasks.py:4179-4190`）。该函数在自己的 `BEGIN IMMEDIATE` 中切换 active document 并提交（`app/services/summary_v3_store.py:340-398`）；外层 `_run_after_previous_summary()` 随后才调用 `mark_persistent_summary_success()`（`app/workers/summary_tasks.py:660-667`；`app/services/summary_task_store.py:286-302`）。两者之间崩溃会产生：

- active v3 document 已存在；
- task 仍为 running/可恢复或最终被标为 failure；
- 重启 worker 可能再次执行模型，虽然 document identity 最终会去重。

现有幂等 identity 降低了重复 document 风险，但没有消除重复 provider 调用、状态短暂分叉和恢复语义不确定性。候选集成应把 artifact/document pointer、task success 和 payload cleanup 放进同一个 owner 事务，或明确并测试可读结果优先的 reconciliation 协议。

### 4. 相同 `start_ms` 是合法的独立行

证据链：

- device transcript final rows 按 `(start_time, id)`，draft rows 按 `(start_ms, ordinal, segment_id)` 排序（`app/api/device_v1.py:1792-1803,1820-1900`）；
- 服务端 `TranscriptLine` 没有 start-time unique constraint（`app/models/transcript.py:10-35`）；
- v3 source identity 包含 source id、content hash、start/end、speaker（`app/services/summary_v3_evidence.py:264-282`）；
- 本地 transcript repository 只拒绝 duplicate segment id/source id/ordinal，不拒绝 duplicate start_ms（`src/data/repositories/sqliteMeetingNoteRepository.ts:4106-4168`）；
- citation projection 的 `seen` 集合按 source id，不按时间（`src/services/meetingSummaryV3.ts:315-330`）。

隔离探针用两条相同 `start_ms=1000`、不同 id 的行调用 `normalize_sources()`，得到两个 source（`transcript:a`、`transcript:b`）；这是 `[P]` 合同探针，不是生产数据验证。当前未找到 duplicate-start 的正式回归测试，因此该不变量仍标为 `[U]` 的发布覆盖缺口，而不是实现已错误去重。

### 5. 启动恢复顺序是分层的，不能当成一个全局恢复器

`app/main.py:66-96` 先建 schema、清理 device 数据和 v3 source payload；`100-146` 清理残留 meeting processing 并恢复转写任务；`148-164` 预热 ASR 支持模型；`167-175` 最后调用 `recover_persistent_summary_jobs()`。整理 recovery 读取 queued/expired-running task、原 task id 和 encrypted payload（`app/workers/summary_tasks.py:1135-1210`）。

这说明：

- payload TTL purge 可能先于 task recovery；过期 payload 会在 recovery 时变成明确失败，而不是继续运行；
- ASR warmup 或前置初始化很慢时，整理 task recovery 会延迟；
- Android 本地 recovery（AsyncStorage hint、SQLite stage、v3 upgrade task）与 server startup recovery 互不替代。

这是 `[S]` 调用顺序和 `[U]` 实际启动时延的组合；没有实时服务日志，不应报告“启动后已恢复所有任务”。

### 6. account current pointer 是另一套兼容镜像

account 生成入口 `app/api/app_meetings.py:1679-1760` 只提交旧 `final` task；它不写 v3 store。account summary 读取会调用 `get_effective_current_summary_document()`，该函数每次先执行 `materialize_meeting_summary_versions()`（`app/services/meeting_summary_sync_service.py:256-380,651-708`）：

- 从 `FinalSummary` 创建 `MeetingSummaryVersionV1`；
- 把旧 ready versions 标记 stale；
- 没有用户保护编辑时推进 `MeetingSummaryCurrentV1`；
- 有用户 section/action 编辑时保持 current 不被新候选覆盖。

因此当前至少有三种“当前整理”概念：server v3 active document、account v2 current pointer、local canonical current summary. 兼容目录测试证明 account pointer 的保护/ETag/idempotency 合同，但不能证明它与 v3 active document 是同一个事实源。

## 测试与验证证据

### 本轮执行

在 service worktree 使用项目虚拟环境和临时 SQLite（不触碰默认数据库）运行：

```text
DATABASE_URL='sqlite+aiosqlite:////tmp/laoji-audit-test.db' \
  ../.venv/bin/python -m pytest -q \
  tests/test_summary_v3.py \
  tests/test_persistent_summary_tasks.py \
  tests/test_summary_versions_v1.py \
  tests/test_guest_transcript_api.py
```

结果：`53 passed, 13 warnings in 1.97s`。警告主要是 Python 3.13 下 `datetime.utcnow()` 弃用提示；没有把它当作功能失败。

### 已覆盖

- v3 evidence/parser/model verification、source fingerprint、speaker correction 影响 fingerprint；
- encrypted payload 不保存明文、document identity 幂等、device epoch 清理；
- task dedupe、force、lease、防迟到 worker 覆盖、checkpoint/recovery；
- account summary version materialization、section override replay/conflict、protected current pointer；
- guest transcript token isolation。

### 未覆盖的关键门禁

- v3 task 404 后 latest result 与请求 fingerprint 不匹配；
- `persist_document()` 成功和 `mark_success()` 之间的进程崩溃/回滚；
- payload insert 与 task insert 之间的崩溃；
- duplicate `start_ms` 的 API 分页、local mirror、citation 和正式回归测试；
- client `projectMeetingFactsV3()` 是否保留 actual transcript revision；
- Android、发布 APK、当前服务部署和真实设备行为。

## 建议的最小门禁（仍不授权生产改动）

1. **404 matching-result 测试。** 构造旧 task、同会议新 active document、task 404，要求客户端拒绝不匹配结果并重新提交/显示 reconciliation；匹配 `source_fingerprint + model_revision + prompt_revision + transcript_revision`，并覆盖 note/attachment revision。
2. **单 owner commit 测试。** 在隔离复制数据库中把 artifact/document active、task success pointer、payload delete 放进一个事务，注入每个语句后的异常；重开 WAL 后不能出现 active result 与 queued/running task 的矛盾组合。
3. **revision lineage 测试。** 输入 server revision `R1`、本地 revision `L1`，断言 facts row、summary document、citation/version pointer 都保存可查询的 `R1 <-> L1` 映射；transcript 修改为 `R2` 时旧 summary 必须可判 stale。
4. **duplicate-time 测试。** 两条相同时间、不同 id/text/speaker 的行必须在 API、分页、source normalization、local mirror、citation 中保持两条；同 id 重复才应被拒绝。
5. **模式隔离测试。** account v2、device v2、device v3 的 task/result/current pointer 需分别列出 owner 和删除/迁移日期；不能以“都调用 `generateSummaryForMeeting`”作为统一合同证据。
6. **实时证据补齐。** 重新检查当前服务进程/cwd/config/log、发布 APK metadata、真机 guest/account 两条路径和 task 404/重启行为；在得到这些证据前，所有部署结论保持 `[U]`。

隔离的 404 identity 判定合同见 [candidate 0008 evidence](../evidence/candidate-0008-summary-v3-recovery-20260816.md)；它没有改变本报告的 `not adopted` 状态。

## 证据等级

- `[S]`：直接由当前工作树源码读取确认；
- `[P]`：隔离临时数据库或纯函数探针所得；
- `[L]`：实时服务器/设备观察（本报告没有新增 `[L]`）；
- `[I]`：由源码事实推导出的风险，需要故障注入或运行验证；
- `[U]`：本轮没有验证，不能写成当前线上事实。
