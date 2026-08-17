# 研究 0024：会议问答 attempt 应独立建表还是泛化现有任务内核

## 状态与边界

- observed: `2026-08-16 Asia/Shanghai`
- status: `architecture comparison`; **not adopted**
- production/service/database/App/device/GPU mutation: `none`
- source snapshots:
  - mobile worktree HEAD observed: `48e3b36`
  - service source: `/home/yydd/LaoJi-service-worktrees/compact-production-v3`
- question: Q2-C 应继续同步请求、新建问答专用 attempt，还是把已有
  `summary_tasks_v2` 收敛为可同时承担整理和问答的 generation task kernel？

本研究只决定执行所有权和恢复合同，不评价 Q0 的 5,803 行问答语义链，也不授权接入
生产模型。Q2-E2 未闭合仍阻止真实 reader 跑分，但不阻止这里用 deterministic fake
provider 验证取消、撤权、恢复和唯一发布。

## 1. 真实现状

### 1.1 当前同步问答并没有 durable attempt

账号接口在模型调用前检查 thread、request ID 和 ordinal，但直到模型返回后才写
`MeetingQuestionTurn`。两个相同并发请求因此可以重复执行模型，最后仅靠 turn unique
constraint 阻止双写。设备接口也在 HTTP 请求内同步调用生成器。

移动端 `askMeetingQuestion()` 在远端结果返回并通过本地引用校验后才调用 repository 保存
turn；`MeetingQuestionSheet` 的 pending 状态只存在 React 内存。关闭页面、进程死亡或网络
断开后，手机不知道服务端是否仍在推理，也没有稳定 task ID 可恢复。

当前 `LlmProvider` 的内存优先队列同样没有取消所有权：调用方等待超时只返回
`llm_queue_timeout`，排队或正在执行的 job 仍会继续，`requests.Session.post()` 也没有持久
cancel fence。由此不能把“客户端取消等待”写成“模型执行已取消”。

### 1.2 `summary_tasks_v2` 是真实 baseline，不是空壳

`summary_task_store.py` 已有 SQLite/WAL、`BEGIN IMMEDIATE` create/claim、lease、heartbeat、
checkpoint、stage、dedupe、result retention 和 startup recovery。`summary_tasks.py` 有实际
worker consumer 和恢复分派。它比新建一张只有状态列的问答表更接近 durable owner。

但它不能原样承担问答：

- 状态只允许 `queued/running/success/failure`，没有 cancel、revoked、stale、policy fence；
- `attempt` 只是可变计数，没有每次 provider 调用的不可变 identity、output digest 和结果；
- request/worker registry、错误名、ContextVar、环境变量和 telemetry 都是 summary 专用；
- task-kind 到 worker 的 dispatch 是硬编码 map，升级后旧 handler revision 没有恢复合同；
- `_submitted_tasks`、`_task_metadata`、dedupe map 和 serialization future 仍是第二层内存协调；
- per-kind serialization key 不能保证同一问答 ordinal 的顺序所有权；
- 没有来源 snapshot/policy revision，也没有提交前的 delete/revoke/epoch CAS；
- success 只检查 lease owner，不检查 cancel generation、snapshot 或 publication eligibility。

因此“在 `task_kind` 增加 `device-question`”只是把同步缺陷藏进整理命名，不是泛化。

## 2. 三种路线

| 路线 | 收益 | 新问题 | 结论 |
|---|---|---|---|
| Q2-C0 保持同步请求 | 改动最少；没有迁移 | 重复推理、页面退出丢 pending、进程重启不可恢复、取消只是 UI、迟到结果无 fence | 只保留整链 rollback |
| Q2-C1 新建 `question_attempts` | 问答字段清楚；可快速加轮询 | 复制 summary 的 claim/lease/retry/checkpoint/retention/worker registry；两套错误和监控继续漂移 | 不作为生产目标 |
| Q2-C2 泛化任务内核 | 复用已经运行的 WAL/lease/recovery；整理和问答共享取消、优先级、保留和故障语义；能删除内存 maps 与专用 registry | 必须先重构并迁移 summary，不能把旧表原样换名；迁移和 handler versioning 有真实风险 | 首选隔离候选 |

Q2-C2 的采用理由不是“复用代码较方便”，而是它有明确删除集。若候选最终不能删除
summary 专用执行 owner，或必须再保留一张问答 claim/retry 表，则退回 Q2-C1 的诚实命名，
不得宣称已收敛。

## 3. 首选目标：一个 generation kernel，两个领域 projection

```text
mobile durable request intent
  -> server GenerationTask(meeting.question)
     -> immutable GenerationAttempt
        -> provider call
        -> protocol/citation/policy verification
        -> exact attempt + snapshot + policy publication CAS
  -> mobile validates result and atomically inserts final turn
```

整理使用同一个 kernel，但把最终 `MeetingFactsDocumentV3` 提交到服务端 summary document
owner。问答不复制这套结果所有权：设备版最终 question/answer/citations 仍只写现有手机
`meeting_question_turns`，服务端成功结果只是可恢复、可过期的 delivery artifact。

### 3.1 kernel 只拥有执行事实

`GenerationTask` 最少绑定：

```text
task_id
capability                 # meeting.summary.v3 / meeting.question.v1
scope + data_epoch
subject_id                 # meeting id
logical_request_key
snapshot_digest
policy_revision + policy_digest
handler_revision
priority
state + stage
current_attempt
cancel_revision + cancel_requested_at
result_payload_ref + result_digest + result_expiry
created_at + updated_at
```

`GenerationAttempt` 是 append-only 子记录，最少绑定：

```text
attempt_id + task_id + attempt_number
lease_owner + lease_generation + lease/heartbeat times
provider/runtime/model/config/request identity
started_at + completed_at
execution_outcome
protocol_outcome
citation_integrity_outcome
policy_outcome
output_digest
```

task row 是 logical owner；attempt row 只是该 owner 的不可变执行历史。retry 创建更高
attempt，不覆盖旧 provider identity。不得再用一个可变 `attempt += 1` 冒充实际调用审计。

`content outcome`、`execution`、`protocol`、`citation integrity`、`policy` 和
`publication eligibility` 必须分字段保存。provider 超时、JSON 错误、引用越界、来源被撤权
和会议内确实没有答案不能投影成同一个 `insufficient`。

### 3.2 snapshot 与 policy

问答 snapshot 必须绑定：

- device principal、data epoch、meeting binding；
- transcript revision 和 ordered segment content hashes；
-被选中的 summary version/section hashes；
- `include_manual_note`、note revision/content hash；
- previous-turn IDs、ordinals 和 content hashes；
- query、expected ordinal 和 client request ID。

服务端已有转写时只保存 immutable ref；本次上传的笔记正文进入现有 AES-GCM 临时 payload，
task row只存 payload ID/digest，成功、永久失败、撤权或 TTL 到期后删除。日志不得记录问题、
正文、引用、文件名或人名。

policy revision 至少覆盖 meeting tombstone、device epoch、note authorization、summary source
authorization 和 thread ordinal。编辑、删除、撤权或 epoch 变化不修改旧 snapshot；它们生成
新 policy revision，并让旧 task 进入 `stale` 或 `revoked`。worker 在 provider 前、provider
返回后和 publication 前都检查 exact revision。

### 3.3 唯一发布

publication CAS 必须同时匹配：

```text
task_id
current_attempt_id
lease_generation
snapshot_digest
policy_revision
cancel_revision
state == running
```

只有一次 CAS 能把验证后的 output 变为 retrievable result。迟到 provider 返回、旧 lease、
旧 note、已删除 meeting、已关闭 epoch 或已取消 request 只留下 attempt 审计，不能恢复成
success。

设备客户端在发送网络请求前，先在本地事务写一个 request intent。结果返回后，在同一事务：

1. 重新校验 thread、ordinal、snapshot 和引用；
2. 幂等插入现有 `meeting_question_turns/citations`；
3. 删除或终结 request intent。

若 App 在 202 后、结果返回前或本地提交前退出，重进后按 request ID 找回同一 task。最终
turn 不在服务端和本地各拥有一份。账号旧接口的服务端 turn 仅作为发布周期兼容投影，不能
成为设备版新 owner。

### 3.4 取消的真实含义

- queued：持久 cancel revision 先写入；dispatcher claim 前检查，因此不得进入 provider；
- provider queue 内：job identity 必须可按 cancel revision 跳过，不能只让 HTTP waiter 返回；
- transport running：在同步 `requests`/Ollama 合同未替换前，只能承诺“禁止迟到结果发布”，
  不能承诺 GPU 计算已立即中止；
- future async transport：只有实际关闭 transport 且观测后端停止后，才升级为 compute cancel；
- client cancel：终结本地 intent 并发送同一 cancel revision，旧响应永不插入 turn。

这是首个候选必须暴露的限制，不能用 `Future.cancel()` 或页面 `AbortController` 掩盖。

## 4. 迁移顺序

1. 在隔离 SQLite 建 generic schema、fake provider 和 fault fixtures；不读生产数据。
2. 把现有 summary store/worker API 抽成 capability-neutral adapter，但物理上仍由原
   `summary_tasks_v2` 负责；此步不新增第二表。
3. 通过数据库重建迁移到 `generation_tasks_v1 + generation_attempts_v1`，把旧 task row
   映射为 task + synthetic legacy attempt；原 task ID、结果和 retention 不变。
4. summary routes 只经 generic adapter 运行一个候选发布周期；旧
   `summary_task_store.py` 变为只读兼容 facade，随后删除。
5. 删除 `_submitted_tasks`、`_task_metadata`、`_task_ids_by_dedupe_key` 和
   `_serialized_task_futures` 的业务所有权，dispatcher 从 DB claim；内存只可持有可丢的 wakeup。
6. 只有 summary recovery 通过后才注册 `meeting.question.v1` handler；不让两种 capability
   同时承担首次 schema 风险。
7. 新增设备 question task submit/status/cancel API；旧同步 endpoint 保留一个发布周期并
   通过 capability flag 切换，不能双写。
8. 移动端增加 durable request intent 和恢复 coordinator；确认新包不再调用同步 route 后
   删除旧设备同步实现。账号兼容路线另行废弃，不与设备 owner 混在同一迁移。

SQLite 表重建、旧 task 映射、回滚副本、foreign-key check 和 WAL checkpoint 都必须在候选
迁移演练中证明。这里不授权对当前数据库直接 rename/copy。

## 5. 调度与延迟边界

问答是 interactive，整理是 background。dispatcher 必须按持久 priority + FIFO claim，且
同一 thread/ordinal 只能有一个 active task。多个 thread 可准备证据，但当前本地生成模型仍
是单并发；priority 只能阻止新 background call 抢在问答前面，不能抢占已经开始的长整理。

因此 Q2-C2 的首轮收益是恢复、去重和状态一致性，不应伪报为模型延迟下降。若真实数据证明
长整理经常阻塞问答，解决对象是 provider 可中断性、批次边界或模型资源，不是在 task kernel
里再增加一条隐式 fallback。

## 6. 隔离候选门禁

### 6.1 必须覆盖的故障窗口

- 两个相同 submit 并发；两个不同问题争用同一 ordinal；
- create 前后、claim 前后、provider 前、provider 返回后、verify 前后、publication CAS
  前后和 client local commit 前后 crash；
- lease 过期后旧 worker 返回，新 worker 已重试；
- queued cancel、running cancel、timeout 后 late result；
- transcript edit、summary update、note edit/撤权、meeting delete/restore、epoch close；
- App 在本地 intent 后未 POST、POST 后未记 task ID、结果后未写 turn、写 turn 后未 ack；
- payload TTL、永久失败、result TTL 和清理进程 crash；
-旧 handler revision 在升级后恢复、明确迁移或 fail closed。

### 6.2 硬判定

| 维度 | 门槛 |
|---|---|
| 单一 owner | 每个 capability 恰有一套 claim/lease/retry/cancel 权威；设备最终 answer 只在本地 turn |
| 重复调用 | 同一 request 正常并发只触发一次 provider；crash 后允许有据可查的重复计算，但只发布一次 |
| publication | stale/revoked/cancelled/old-lease output 成为可取结果为 0 |
| 恢复 | 100 轮随机 crash 后无永久 running、无 ordinal 双写、无丢失的可恢复 intent |
| 隐私 | task/event/log 不含正文；加密 payload 和 result 均按 terminal/TTL 清理 |
| 状态归因 | execution/protocol/citation/policy/content outcome 不互相改名 |
| 调度 | queued interactive 永远先于未 claim 的 background；不谎报 running preemption |
| 迁移 | 全部旧 summary task/result 可读；失败可回滚；`foreign_key_check` 和 integrity check 通过 |
| 删除 | 至少删除 summary 专用 store 命名层和四个内存 owner；否则 generic kernel 不采用 |
| 平台 | Linux 与 Windows 的 Python 3.12 真实测试都通过，不能只做 path/static 检查 |

## 7. 概念与删除预算

允许新增且必须保留语义边界的概念只有：

- `GenerationTask`：logical execution owner；
- `GenerationAttempt`：append-only actual invocation history；
- `MeetingEvidenceSnapshotRef`：不可变来源合同；
- mobile request intent：网络前的本地恢复锚点；
- publication fence：不是第二结果表，只是 task 上的 exact CAS 条件。

采用后应删除：

- summary 专用 claim/lease/checkpoint API 和硬编码 recovery registry；
- `_submitted_tasks`、`_task_metadata`、`_task_ids_by_dedupe_key`、
  `_serialized_task_futures` 的权威语义；
- 设备问答的同步-only route 和 React-only pending；
- 新建独立 `question_attempts` 的需要；
- “HTTP timeout 即任务失败”“客户端退出即服务端取消”的错误假设。

不能删除 existing mobile thread/turn/citation tables；它们继续是用户历史 owner。也不能为了
收敛把 summary document 和 question turn 合成一个生成结果表，两者是不同领域事实。

## 8. 结论与下一候选

Q2-C2 是当前首选，但尚未采用。下一隔离候选不应从新问答 API 开始，而应先建立：

1. generic task/attempt schema；
2. summary legacy-row migration fixture；
3. fake `meeting.question` handler；
4. cancel/late-result/policy-revision/publication-CAS fault matrix；
5. 一个证明 final turn 仍由本地 repository 唯一持有的 mobile contract fixture。

若这一候选必须保留现有 summary 内存 maps 才能工作，或无法在一个 DB owner 中表达
summary 和 question 的不同 publication policy，则否决泛化，采用明确的专用问答 task，而
不是继续扩张一个名义上的通用内核。
