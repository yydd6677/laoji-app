# 提案 0004：Speech Artifact Flow M1 嵌入方案

## 状态

- status: `candidate; architecture-only; not adopted`
- parent revision: `0006-schedule-mention-graph-boundary-20260816`
- observed: 2026-08-16 Asia/Shanghai
- 隔离合同：`/home/yydd/LaoJi-candidates/speech-artifact-flow-0002`
- 目标：先删除文字等待讲话人、重复 CAM++ 和片段身份漂移，再用同一合同比较
  Qwen completed、Qwen streaming 与 Paraformer；不预设新 provider 胜出。

## 需要重做的不是一个 VAD 参数

当前实时链有四个相互放大的问题：

1. 一个 WebSocket 只有一个 `segment_worker`，Qwen 完成后依次做匿名聚类、登记声纹
   匹配，最后才发送 `transcript.completed`。
2. 聚类先调用 `extractor.extract(audio)`，`EnhancedRecognitionEngine.identify(audio)`
   又提取一次相同 CAM++ embedding。
3. Native `transcriptIdentity()`、游客缓存和非 Android `MeetingLiveScreen` 都把文字
   正文或讲话人放进 ID；partial 修订、讲话人补丁或简繁转换会产生新行，而不是推进
   同一片段。
4. 导入路径虽已每批发布 draft，客户端仍以 750 ms 轮询整份数组；draft ID 含 job，
   final ID 又由 `job + segment` 生成，终态激活会整批换身份。

因此不能只把 650 ms 改小或只在服务端提前 `send_json()`。目标必须同时收敛身份、
分支、投影和恢复边界。

## 唯一内部合同

### SegmentArtifact

每个 VAD 闭段先产生不可变 artifact：

```json
{
  "source_id": "capture or recording asset identity",
  "segment_id": "stable UUID",
  "artifact_revision": 1,
  "ordinal": 12,
  "source_start_sample": 480000,
  "source_end_sample": 544000,
  "audio_sha256": "..."
}
```

- source range 以 16 kHz sample 为权威，毫秒只作投影，避免浮点 round-trip。
- `segment_id` 不包含文字、讲话人、model revision 或 task/job ID。
- 实时 capture 必须有独立 `capture_id`，不能把可重复使用的 meeting ID 当录音尝试
  身份。客户端通过鉴权 header 同时发送 capture ID；URL 仍只含 meeting binding。
- 导入 source 使用 recording asset 的内容身份；重试 job 不得改变 segment ID。

### TranscriptRevision

```json
{
  "type": "transcript.revision",
  "source_id": "...",
  "segment_id": "...",
  "artifact_revision": 1,
  "revision": 3,
  "maturity": "partial|stable|final",
  "text": "...",
  "stable_prefix_codepoints": 8,
  "source_start_sample": 480000,
  "source_end_sample": 544000,
  "model_revision": "..."
}
```

revision 和 maturity 只能前进；stable prefix 以 Unicode scalar value/code point 计数，
不可重写且不做隐式 normalization；final 关闭后不能换 ID 再覆盖。
当前 Transformers provider 第一阶段只能为每个 VAD segment 产生一次 `final`，但仍应
立即发送，不等待讲话人。真正 partial/stable 必须由 provider 对照证明后再启用，不能
用截短音频反复整段转写伪装流式。

### EmbeddingArtifact 与 SpeakerPatch

同一 segment 只运行一次 CAM++：

```text
audio -> SpeakerEmbeddingExtractor.extract() -> immutable embedding
       -> OnlineSpeakerCluster.assign_embedding()
       -> EnhancedRecognitionEngine.identify_embedding()
       -> speaker.patch
```

`EnhancedRecognitionEngine` 新增只评分 embedding 的纯路径；旧 `identify(audio)` 只作
兼容 wrapper，内部先提取再调用该路径。`speaker.patch` 有独立 revision，可迟到、失败、
重放或标记 unavailable；任何情况都不能更改 transcript text/revision。

## 逻辑并行不等于无约束 GPU 并发

目标有两条独立有界队列，但物理 scheduler 需按实测选择：

- ASR queue 满时显式 backpressure；speaker queue 满时延后或省略讲话人增强，不能
  阻塞文字。
- 第一隔离切片可在 ASR 返回后先发文字，再串行算一次 CAM++。这消除当前片段的可见
  等待，但尚未消除 speaker 对下一片段的资源等待，报告中必须如实区分。
- 若 CAM++ 与 8030 同 GPU 并行导致 ASR p95 或显存退化，候选依次比较：CAM++ CPU、
  ASR 空闲窗、统一 GPU admission。不得直接开启无界线程，也不得默认把模型搬到 GPU1。
- 只有统一 admission 能删除一个调度 owner 时才值得引入；否则宁可保留物理串行、
  先发送文字，也不要增加第二套跨进程锁。Linux 文件锁不能成为目标方案，因为还需
  支持 Windows。

## 服务端嵌入

### 1. 一个 pipeline，两个临时投影

`qwen_ws._serve_qwen()` 内部只保留一个 artifact pipeline。兼容不是复制业务逻辑：

- 新客户端在 WebSocket handshake 发送 `X-Laoji-ASR-Protocol: 2` 与
  `X-Laoji-Capture-Id`；现有 URL 校验继续禁止 query/fragment。
- 新服务在 `config` 中回报 `asr_protocol=2`、maturity、speaker patch 和 stop 能力。
- protocol 2 客户端接收 `transcript.revision` 与 `speaker.patch`。
- 旧客户端通过 legacy projector 等待 final transcript + 当前可用 speaker，再发
  `transcript.completed`。该 projector 只消费同一 artifact 状态，不再执行第二套
  ASR/CAM++。

新客户端 header 对旧服务无害；若 `config` 不声明 protocol 2，Native 自动使用旧
parser/reducer。旧客户端无需更新即可继续使用旧 projector。

### 2. 持久身份

- device 模式的 final transcript 以 stable segment UUID 作为 `TranscriptLine.id`；
  speaker patch 对同一行做 revision-checked update，而不是插入新 UUID。
- 游客暂存 `append_guest_transcript()` 增加 stable ID 输入并按 ID upsert；旧调用仍可
  使用正文派生兼容 ID，迁移期后删除该派生路径。
- 实时 stop/finalize 把 `capture_id + segment ranges + segment IDs` 作为录音资产元数据
  一并登记。后续离线重跑优先复用已观察边界；新增的尾部区域才由 VAD 产生新 artifact。
- 不给 `TranscriptLine` 再增加第二个“真实片段 ID”。当前离线
  `_stable_segment_id()` 已生成 `seg_ + 32 hex`，恰好 36 字符并包含 source hash；
  可直接成为 final `TranscriptLine.id`，不再用 `uuid5(job + segment)` 包一层。
- 允许 staging draft 表与 canonical `TranscriptLine` 两个物理表，但同一时刻只能有
  一个可写 owner：任务运行时 draft row 是 operation ledger；final 原子事务用同一
  segment ID 投影到 `TranscriptLine` 并删除 draft。两边不得同时继续更新正文。
- draft 增加单调 `text_revision/speaker_revision`，job 增加单调 projection revision；
  final 只需保留来源/model revision 和后续 speaker patch 的 revision。这样无需另建
  第三张 transcript ledger，也不让 summary/question 误读 partial。

### 3. 导入增量

现有 draft 表可演进为 revision ledger，但不能与新 ledger 并存：

- `segment_id` 从 source hash + source range/ordinal 派生，不含 job ID；job 重试复用。
- draft 到 final 只更新 maturity、speaker revision 和 canonical flag，不先删除 draft
  再批量插入另一组 ID。物理上仍可原子 delete+insert，但 API/UI identity 必须保持
  `draft.segment_id == TranscriptLine.id`。
- transcript GET 增加 `after_revision + wait_ms` 的 revision-aware long poll，返回 delta
  和单调 projection revision；旧 GET 继续投影整份 snapshot。
- 先复用 SQLite/SQLAlchemy 当前 owner 做有界 5 秒 long poll；不要为通知再引入 Redis、
  Celery 或第二个 WebSocket 状态 owner。移动后台限制下，long poll 比永久推送更容易
  恢复；前台活跃时再评估 20--25 秒等待。
- `DeviceMeetingCompletionProvider` 只合并 delta；模板页/详情页不得各自再建轮询 owner。

## Android / RN 投影

### Native parser

`AsrServerEvent.Transcript` 增加服务端 segment ID、artifact revision、text revision、
maturity、stable prefix 和 source sample range；另增 `SpeakerPatch`。legacy completed
由 adapter 转成 `revision=1, maturity=final`，但明确标记 legacy identity。

`RecorderEngine` 不再调用正文派生的 `transcriptIdentity()`。它把服务端 ID 原样发给
JS，并在 Native 内的单一 reducer 中拒绝跨 session/source、旧 revision、maturity
回退和 stable prefix 改写。speaker patch 使用独立事件或同一 snapshot patch，不能
伪造 transcript revision。

### 本地 projection

- `NativeRecorderTranscriptEvent.kind` 扩为 partial/stable/final，并携带 revision。
- `mergeNativeMinutesTranscript()` 按 `meeting + source + segment` 更新；只有 revision
  更高且水位合法才改变文字。speaker patch 只更新 speaker 字段。
- 手机 SQLite 现有 `transcript_segments.id` 仍可作为某一 document revision 内的本地
  外键；跨 draft/final 的 canonical identity 使用已有 `source_segment_id`。API 必须
  显式返回该字段，UI、引用协调和版本切换不得再把 revision-local 主键当来源身份。
- final transcript checkpoint 与 speaker checkpoint 分开触发但写入同一原子 projection；
  迟到 patch 不丢，失败 patch 不影响文字可用。
- `.android.tsx` 与通用 `MeetingLiveScreen.tsx` 共享 reducer。通用页当前按正文追加 ID
  的路径必须删除，不能成为 Linux/Windows 或测试环境里的第二套语义。
- 日程语音只在保存前读取 ordered final projection；partial/stable 可见但不得被保存
  或当成完整解析输入。

## 分阶段实现和回滚

### A. 仅观测

在隔离副本记录：

`capture -> vad_emit -> provider_enqueue -> provider_start -> provider_end -> transcript_emit`

以及独立 `embedding_start/end -> speaker_emit`。日志只含 session 后缀、segment ID、
时间、长度、revision 和错误码，不含音频、正文、姓名或 embedding。

### B. completed provider 解耦

保留当前 8030，不新增模型：创建 artifact，Qwen 返回后立即发 protocol 2 final，随后
复用一次 embedding 产生 speaker patch。legacy projector 保持旧客户端行为。先在
emulator-5562 和隔离 API 端口验证，不部署生产。

### C. 导入身份与 long poll

让 draft/final 共享 ID 和 revision；客户端消费 delta。注入 worker/API/客户端中断，
验证重复与乱序不换行、不丢 final、不覆盖用户编辑。

### D. provider 竞争

同一脱敏 PCM 串行回放 C0、Qwen vLLM streaming、Paraformer streaming。只有新
provider 同时通过首个 stable、稳定前缀、最终 CER/字段、资源、许可和 Windows 路线
才替换 C0。否则 M1 仍可使用 current completed provider。

每阶段由能力位关闭即可回滚读路径；artifact/revision 数据为追加式，旧 snapshot
projector 始终可读。任何回滚不得把旧 derived ID 重新设为 canonical。

## 进入实现前必须回答

1. 实时 capture ID 如何与本地 WAV/RecordingAsset 在 stop 后原子绑定，重复录制同一
   meeting 时不冲突。
2. 当前 draft -> `TranscriptLine` 原子交接如何保证单 owner；如果现有两表不能做到，
   才允许新 ledger，且必须在同阶段删除旧 draft owner。
3. CAM++ 单次提取在 GPU/CPU 的 p50/p95、与下一 ASR segment 的竞争和峰值显存。
4. VAD segment boundary 在在线 frame 与离线 WAV 上是否可重放；偏差时如何保留已显示
   segment，而不是全局重分段。
5. long poll 在前后台切换、断网、API 重启和 projection revision 过期时的恢复合同。

## 验收门

### 身份和恢复

- 同一音频的 partial/stable/final、speaker patch、离线 final 和任务重试保持同一
  segment ID；正文/讲话人变化导致的新增行数为 0。
- duplicate、乱序、旧 revision、跨 meeting/source 接受数为 0；API/Native/RN 各层
  用相同 fixture 通过。
- 在 VAD emit、ASR end、text emit、speaker patch、draft commit 和 final activate
  各点中断，恢复后只存在一份可见片段。

### 速度和质量

- 分别报告 VAD 等待、ASR queue/infer、text emit、speaker patch 和客户端 observe；
  不能只报 8030 infer。
- current completed M1 必须证明“先发文字”降低首个可读片段延迟；speaker 对下一
  ASR 的等待也必须单列，不能隐藏。
- streaming 候选 stable p50/p95、稳定前缀回滚率、最终 CER、日程关键字段、DER、
  峰值显存/CPU/RSS 均按 0008 门槛；公开模型示例不能替代真实中文会议样本。

### 复杂度

- 生产最终只保留一个 segment identity factory、一个 transcript revision ledger、
  一个 Native/RN reducer 和一个 provider interface。
- legacy projector 保留一个发布周期后删除；正文派生 ID、draft/final 两套 ID、重复
  CAM++、页面级轮询 owner 必须列入同一迁移的删除清单。
- 不增加 Redis、Celery、第二个常驻 ASR、GPU1 依赖或平台专用文件锁。

## 当前决策

隔离 Python 合同与脱敏回放器 `27/27` 通过，共享 Unicode fixture 也在 Node 与
Kotlin/JVM 各通过 7 个样例；三段非用户模型示例的 current 8030 暖态推理为
313--578 ms、SSH 内端到端为 419--692 ms。这只能说明短样本上的 8030 本身不是唯一
数秒等待源；没有经过 VAD、CAM++、WebSocket 和客户端，不能当作体验基线。

提案保持 `candidate; not adopted`。下一步先完成 capture/segment identity 与唯一
revision ledger 的反事实审计，再建立隔离 B 切片。未经该审计，不修改生产
`qwen_ws.py`、数据库、Native parser 或发布 APK。
