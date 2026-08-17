# 蓝图修订 0007：语音身份、revision owner 与物理调度边界

## 状态

- revision: `0007-speech-identity-revision-owner-boundary-20260816`
- status: `candidate`; **not adopted**
- parent: `0006-schedule-mention-graph-boundary-20260816`
- observed: `2026-08-16 Asia/Shanghai`
- source commit observed: `48e3b36`
- production mutation: none

## 触发原因

[proposal 0004](../proposals/0004-speech-artifact-flow-m1.md) 和
[candidate 0017](../evidence/candidate-0017-speech-artifact-flow-20260816.md) 选对了第一条方向：
文字不应等待讲话人，讲话人应是迟到 patch，同一次 speaker attempt 中的
cluster/identify 应复用一次 CAM++ 结果。但独立反事实审计确认，其当前 Python
`27/27` 包含 21 项合成 artifact/reducer 合同、4 项使用 fake opener 的脱敏
C0 回放客户端测试和 2 项 Unicode fixture 测试；同一 fixture 在 Node/Kotlin 各
通过 7 个样例。它们证明已给定事件后的内存不变量、工具输出边界与跨语言 codepoint
语义，
不证明：

1. 实时录音、导入文件与离线重跑会产生同一片段身份；
2. revision 和投影 cursor 已有唯一持久 owner；
3. 两条逻辑队列已隔离 ASR/CAM++ 的共享 GPU 竞争；
4. long poll 不会再引入一个事件真相源；
5. legacy projector 已满足删除条件。

因此 0007 不接受“合同测试通过 -> 可直接嵌入生产”的跳跃。本修订先冻结
identity/revision owner 边界，再允许建立最小集成切片。完整源码反证见
[research 0011](../research/0011-speech-decoupling-embedding-audit-20260816.md) 和
[research 0012](../research/0012-speech-text-first-watermark-decision-20260816.md)。

## 保留的决策

- C0 仍是唯一生产基线；不切 provider，不改生产服务、数据库、Native 或 APK。
- M1-T `Transcript Lane + Speaker Lane + one reducer` 仍是语音第一隔离候选。
- 第一切片保留当前 Qwen completed provider；VAD 闭段后 ASR 返回就发文字，
  speaker 后补，不用截断音频重复整段转写伪装 streaming。
- 离线/导入路径优先演进现有 `MeetingRecordingTranscriptionJobV2` 任务 owner；
  不先加通用 `Artifact + Operation + Projection` ledger。
- 实时 account/guest 当前不受该 job owner 管理。它们必须先被一个 durable live-run
  owner 收编，并在同一阶段删除随机 UUID 直写和 guest 进程内文字 owner。
- Qwen vLLM/FunASR/sherpa-onnx 只能在当前 provider + M1-T 先证明删除等待边后，
  作为同合同 G1 adapter 参加 A/B。
- 0006 的日程 Mention Graph、单 validator/executor 和人工 gold 门保持不变。

## 身份边界：同一源不等于同一分段

候选 0002 的 identity factory 只证明“已给定相同 source/range 时输出稳定”。实时
与离线 VAD 参数不同，同一 WAV 不保证重现相同 boundary/ordinal；proposal 0004 用
16 kHz sample range，候选代码使用 millisecond range，也尚未证明往返一致。

服务端离线路径已有 `_stable_segment_id()`：它从 source hash、ordinal 和毫秒范围
产生 `seg_ + 32 hex`，长度 36 且与 job 无关。这证明它的形状可直接作
final `TranscriptLine.id`，无需再用 `uuid5(job + segment)` 包一层；当前 draft API
包 job ID 和 final 再包 job ID 才是已知身份漂移点。但该函数的毫秒材料仍须与
权威 sample 坐标合同对齐；“可容纳的 ID 形状”不等于跨路径身份已证明。

0007 把身份合同收窄为：

1. 第一 M1-T 只处理已闭段 segment。源坐标以锁定的 16 kHz mono PCM 内容身份和
   integer sample range 为权威；毫秒只是投影。
2. 同一 durable run 的 retry/replay 必须复用 segment manifest 和 segment ID。任务 ID、
   文字、讲话人或 model revision 不得进入 segment ID。
3. 实时 capture 在 stop 后必须把 `capture_id + PCM identity + segment manifest` 与
   RecordingAsset 原子绑定，不能只靠 meeting ID。
4. 离线路径只有在复用已持久 manifest 时才能宣称与实时路径是同一 segment。
   重跑 VAD 而边界变化时，必须建新 segmentation run 并记录 lineage，不得伪造同 ID。
5. provider 在 VAD 闭段前输出的 streaming hypothesis 是 G1 的独立 identity 问题；未冻结
   open-window identity 前，不得套用“immutable closed segment”证明。

## Revision owner 先决条件

现有真实状态已经不是一张空白表：

- 服务端离线/导入有 `meeting_recording_transcription_jobs_v2`、运行期 draft rows、
  final `transcript_lines` 和 `result_revision_id`。final handoff 在一个 DB 事务中删除旧行/
  draft、整批插入 final 并更新 job，但没有 segment CAS 或 event sequence。
- 实时 account 路径每段直接用随机 UUID 写 `TranscriptLine` 并独立 commit；guest
  实时文字是进程内字典。因此现有 transcription job 并不是全路径 run owner。
- 手机 SQLite 已有 `transcript_revisions`/`transcript_segments`、active revision 和
  `source_segment_id`。该字段可作 canonical provider identity 的载体，但当前只在
  document revision 内约束唯一；表中没有 segment revision/seq/watermark 或 expected-revision CAS。
- 手机 `meeting_scope_write_state.canonical_revision` 是 scope-wide 本地写入时钟，会因非
  transcript 写入前进，不得复用为 remote transcript cursor。
- device API 的 draft/final `revision_id` 分别由 job + timestamp + count 和
  `meeting.updated_at + count` 组成，`processed_duration_ms=max(end_ms)` 不是 sealed watermark。

目前没有任何对象拥有 per-segment text revision，也没有任何持久、严格单调的
transcript event/projection cursor。

下一隔离切片必须先交付 owner map 和可执行的事务证明：

| 概念 | 必须的权威 owner | 不得混同 |
|---|---|---|
| run event sequence | 离线 job 或 live-run owner 的同一 DB 事务 | HTTP poll 到达顺序 |
| segment text revision | 同 run 内该 segment 的文字 writer | speaker revision |
| speaker patch revision | speaker lane 的幂等 writer | text revision/final text hash |
| projection revision | 生成 API snapshot/delta 的同一事务 | segment revision |
| final text revision ID | source/model/timing/text 的 content identity | `meeting.updated_at`、speaker |

离线路径允许以 `job.id` 作 `run_id`，在现有 draft/final 事务中同步提交
projection revision 和唯一 `(job_id, seq)` history。该 history 只能是无独立 worker/claim/
current pointer 的事务日志；当前 draft 原地覆盖且 final 时删除，单独扩展 draft 无法
支持断线后 `events_after(cursor)` 完整 replay。

实时路径必须选择“统一进同一 job/run 模型”或“一个单独但同合同的 durable
live-run owner”，并在同一阶段删除 `qwen_ws` 直写和 guest 内存 writer。若新 ledger
有自己的 claim/retry/current pointer 或可独立改文字，而旧 writer 继续存在，它就是
第二 owner。手机 `transcript_revisions` 仍只是本地投影/文档 owner，不得反向铸造
服务端 event sequence。

`stable_prefix_chars` 在合同冻结前改名为 `stable_prefix_codepoints`：它表示 JSON
解码后精确 text 中的 Unicode scalar value 数，reducer 不做隐式 normalization，非法孤立
surrogate fail closed。Python/Kotlin/TypeScript 必须用同一份包含中文、emoji、结合字符的
fixture 证明前缀判定一致；不得直接对比 Python `len` 和 Kotlin `String.length`。

## 逻辑分支不等于物理解耦

两个有界 queue 只能防止 speaker 队列占用 ASR 队列容量。当前 8030 ASR 与 CAM++
位于不同进程但共享 GPU 资源，所以 segment N 的 CAM++ 仍可能推高 segment N+1 的
ASR queue/inference 延迟。第一切片可以只宣称“当前 segment 的文字先发”，不得
宣称端到端已与 speaker 解耦。

- 必须在 1/2/4 会话、speaker backlog/故障和 ASR 持续输入下比较 text p50/p95/p99、
  queue time、峰值显存和 OOM/丢弃数。
- “一个 EmbeddingArtifact”只能表示单次 speaker attempt 内复用一次物理 forward；
  重启/重试可以重算，但不得并发重复，输出 patch 必须幂等。
- M1-T 默认不持久原始 embedding。若为跨重启 exactly-once 改为持久化，必须先通过
  声纹/生物特征的加密、权限、保留、删除和账号清除边界；否则不进入实现。
- 统一 GPU admission 只有在它能取代现有调度 owner，且 Linux/Windows 有同等恢复
  语义时才可候选；不得用平台专有文件锁补第三个 owner。

## 传输与 legacy 边界

long poll 不是删除 `speaker -> text` 等待边的必要条件，从第一 M1-T 切片移出。
第一切片可继续轮询 snapshot，但 transcript fetch 不再以 task-status 请求成功为前置。
只有当权威事务能同时提交 projection revision 和可见状态时，才可定义
`after_revision`/delta/long poll；不允许为此新增独立 event log、Redis 或 WebSocket owner。

legacy projector 只能是新 owner 的纯投影：不执行第二次 ASR/CAM++，不持有可写
segment/revision 状态。“保留一个发布周期即删除”不再是有效条件；删除前必须同时
证明：

1. 受支持客户端版本和实际使用量 telemetry 已覆盖；
2. device/account/guest 及所有录音/导入路径已迁移；
3. 最长离线/保留时间窗已过，不再有旧读者或后台 consumer；
4. rollback 已在真实版本组合上验证，新数据不需要旧 owner 才能读取；
5. 旧客户端在 speaker 迟到、失败或永久不可用时的有界行为已冻结并通过故障注入。

## 本修订否决的前提

以下是候选设计的禁止性结论，不表示生产迁移已完成，也不将任何对象标记为
`deprecated`：

- 否决“Android/TS 已支持 stable/revision/watermark，首刀无需改 parser”。
- 否决 `max(end_ms)` 或单调数字本身等于连续 sealed watermark。
- 否决文字/讲话人内容哈希充当 segment identity，以及 speaker 进入 final text revision。
- 否决实时重分段与离线 VAD 只因输入同一 WAV 就必然产生同 ID。
- 否决独立 queue 或一个 embedding 对象已证明物理 GPU 解耦/exactly-once。
- 否决 long poll 是 M1-T 首刀的前置，或可以拥有独立 cursor/event owner。
- 否决通用 Artifact/Operation ledger 是语音解耦的先决条件。
- 否决“一个发布周期”足以删除 legacy projector。

## 下一隔离切片

1. 用真实 server/mobile schema 画出唯一 owner map：离线选择“演进现有 job +
   draft/canonical”或“原子替换”；实时冻结 durable live-run 与 offline job 的
   统一/分离边界，不建第三套 ledger。
2. 用同一脱敏 PCM 记录实时/离线 segment manifest；边界不同时验证 new-run lineage，
   不强行对齐 ID。
3. 为 offline job/live run/draft/segment/projection 事务注入 duplicate、乱序、同 seq
   异 payload、DB 中断、API 重启、final 后迟到 text 和 speaker 永久失败；
   重启后 digest 必须一致。
4. Python/Kotlin/TypeScript 共用 identity/revision/Unicode fixture，证明一行修订、speaker patch
   不新增行，本地不铸造 remote revision。
5. 保留当前 provider，在 speaker overload 下完成 C0/M1-T 物理调度对照；未达到
   text latency/资源门前不进入 provider A/B。
6. 只有上述 owner/identity 切片通过后，才允许建立隔离 protocol-2 集成；仍不部署
   生产，不更新 APK。

## 当前结论

M1-T 文字优先/讲话人 patch 方向保留，候选 0002 保留为合同 fixture 和故障用例。
它不是跨路径身份、持久 revision owner、物理 GPU 解耦、long-poll owner 或 legacy
退场的证据。生产继续 C0；0007 仍为 `candidate; not adopted`。
