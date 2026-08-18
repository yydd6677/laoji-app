# 老记语音文字优先、revision 与 watermark 独立复核

状态：`research + candidate recommendation`，**未采用**，生产冻结。

观察时间：2026-08-16（Asia/Shanghai）
移动端工作树：`$MOBILE_REPO`，观察 commit `48e3b36dff2cfc6b9b89c9a2f870ed88c802ebdf`
服务端工作树：`$SERVICE_REPO`

本记录只研究一个问题：实时和导入语音的文字为什么仍会被讲话人处理、任务状态或轮询边拖住，以及最小改动能否建立稳定 revision/watermark。未改生产源码、服务、数据库、模型、APK 或部署。

## 1. 结论

1. “实时/导入文字都完全被讲话人阻塞”不是精确事实。**实时路径确实在发文字前等待讲话人；导入路径已经会先持久化无讲话人的 ASR draft，但最终 transcript revision、任务完成和 canonical 替换仍等待全部讲话人 future。** `[S]`
2. 当前 `Incremental Artifact Flow` 对这项首刀是**概念过宽、关键语义又不足**：它引入通用 Artifact/Operation/Projection，却没有约束 stable 前缀不可回写、watermark 必须表示连续封口，也没有 provider run/事件序列。候选 0003 甚至允许 `stable="旧转写" -> final="新转写"`，其测试只证明数值 watermark 不回退，不证明文字稳定。`[S]`
3. 0008 中“Native parser 已能接受 M1 三类 transcript，首个实验无需改 Android parser”的判断应废弃。真实 parser 不接受 `transcript.stable`，也不读取 server `segment_id`、revision、watermark；它用“session + speaker + 时间 + text”哈希临时造 ID。文字或讲话人变化会变成新行，无法完成同 segment 修订或 speaker patch。`[S]`
4. 当前应选择 **M1-T：Text-first Transcript/Speaker Lane** 做隔离回放。它复用现有 `MeetingRecordingTranscriptionJobV2` task owner，只新增窄事件合同和 reducer，不先新增通用 Artifact ledger，不替换 provider。
5. G1 provider 替换必须排在 M1-T 之后。Qwen vLLM streaming 和 FunASR/Paraformer 能提供更早输出的候选，但它们都不会自动删除当前讲话人闸门、轮询闸门或客户端身份错误；Qwen streaming 自身还会回滚 token suffix，FunASR 示例的 `is_final` 也不等同于 LaoJi 的 stable-prefix 合同。`[E][C]`

因此当前决策是：**C0 保持生产基线；M1-T 进入隔离合同/回放；G1 只在同一 M1-T 合同后做 provider A/B，不进入生产。**

## 2. 证据标记

- `[S]`：本地真实源码或既有隔离候选直接观察。
- `[L]`：2026-08-16 只读运行证据，只证明现场进程/资源。
- `[E]`：官方仓库或云厂商官方协议文档。
- `[H]`：由事实推导、尚待回放证伪的假设。
- `[C]`：本记录提出的候选合同。
- `[U]`：尚未在老记真实输入、硬件或 Windows 上验证。

## 3. 真实等待图

### 3.1 实时会议：文字被讲话人直接挡住

当前 `qwen_ws.py` 的单 segment 路径是：

```text
VAD 闭段
  -> 8030 整段 ASR
  -> CAM++ embedding / 在线聚类
  -> 已注册讲话人 identify
  -> transcript.completed
  -> 异步持久化
```

直接证据：

- `backend/app/api/qwen_ws.py:407-553` 每个会话只有一个 `segment_worker`，逐段 `await process_segment`。`[S]`
- 同文件 `:417-422` 先等待整段 `_qwen_transcribe`；`:445-503` 再等待 embedding、cluster 和 identify；直到 `:506-529` 才发送 `transcript.completed`。`[S]`
- 有注册 profile 时，`:445-448` 先调用一次 `extractor.extract`，随后 `_identify` 又进入 `EnhancedRecognitionEngine.identify`；`backend/app/asr/enhanced_engine.py:352-368` 会再次调用同一 extractor。即同一 segment 可能在发文字前做两次 CAM++ forward。`[S]`
- `backend/app/asr/model_manager.py:414-419` 用进程级锁串行所有 CAM++ forward。增加协程或线程不会消除该等待。`[S]`
- `qwen_ws.py:587-592` 在 stop 时先排入 sentinel、等待 worker 清空，之后才发 `ready_to_stop`。因此 stop drain 也等待队列中每段的讲话人处理。`[S]`

还有一个更早的隐藏闸门：

- `model_manager.py:143-197` 初始化按 VAD 后 CAM++ 串行加载，`:194-195` 任一失败都会使整个 manager 初始化失败。
- `qwen_ws.py:363-387` 无论 schedule 是否启用 speaker，都先 `await model_manager.initialize()`；因此 speaker 模型并非真正可选，CAM++ 失败可以阻止日程/会议 ASR 会话就绪。`[S]`

实时事件还缺少可修订身份：

- `qwen_ws.py:506-525` 不发送 provider `segment_id`、segment revision、stream revision、watermark 或 `model_revision`；只有时间、文字和讲话人。
- 8030 本身会返回 `model_revision`，见 `backend/qwen_asr_service/server.py:356-383,530-541`，但 WebSocket adapter 丢弃了它。`[S]`

### 3.2 8030：优先级不是流式，也不能中断

- `backend/qwen_asr_service/server.py:217-259` 把请求放入优先级队列后同步等待 `job.finished`。
- `:320-419` 只有一个 inference worker；`model.transcribe()` 完整返回后才一次性填充 response。
- realtime priority 只能影响尚未开始的排队顺序，不能抢占正在执行的 offline batch，也不能产生 token/partial。`[S]`

这与现场证据一致：2026-08-16 只运行 Qwen Transformers provider，未安装 vLLM/FunASR；587ms 只是一次历史 inference，不是端到端或 p95。见 [live ASR provider audit](../evidence/live-asr-provider-audit-20260816.md)。`[L]`

### 3.3 导入转写：已有文字先行雏形，但 final 仍被 speaker 挡住

导入路径不能笼统描述为“ASR 完成后才有任何文字”：

- `backend/app/services/compact_transcription_service.py:790-830` 每个 ASR batch 完成后先构造无 speaker 的 `published` rows 并调用 `partial`。
- `backend/app/services/meeting_recording_asset_service.py:825-861` 把这些 rows 写入 `meeting_recording_transcript_drafts_v1`；设备 transcript endpoint 会读取它们。`[S]`

但仍存在四个串行问题：

1. `compact_transcription_service.py:831-833,881-890` 会在 speaker pending 超限时等待，并在返回前等待全部 speaker future、关闭 executor；`:894` 做全局 speaker assignment。只有之后调用方才生成 final revision。
2. `meeting_recording_asset_service.py:863-876` 的 final revision material 包含 `speaker_id`；讲话人变化因此改变“transcript revision”，文字和讲话人没有独立版本域。
3. `meeting_recording_asset_service.py:832-846` 从转写线程同步等待 draft DB commit，单次最长 15 秒。draft 写失败不会丢 final，但会直接暂停下一批 ASR 工作。
4. `meeting_recording_asset_service.py:661-680` 只有一个无界 app worker queue，transcription 与 media clip 共用同一 worker。8030 的单 worker 之外还有第二层串行队列。`[S]`

最终事务 `meeting_recording_asset_service.py:887-932` 删除 draft、整批替换 canonical lines，并只在此时将 job 标为 completed。因此“文字已全部识别”与“讲话人已完成”仍无法分别表达。`[S]`

### 3.4 设备 API 有 revision 字符串，但不是稳定 text revision/watermark

`backend/app/api/device_v1.py:1784-1938` 确实会在任务运行时返回 draft；这纠正了“客户端一定等 completed 才拿文字”的错误前提。但返回合同仍不够：

- draft `revision_id` 是 `job_id + max(updated_at) + row_count`，final `revision_id` 是 `meeting.updated_at + total`（`:1910-1928`），都不是独立、可排序的 text revision。
- final endpoint 没有使用已存在的 `job.result_revision_id`。其他逻辑更新 `meeting.updated_at` 时，文字未变也可能产生新 final revision identity。`[H]`
- `processed_duration_ms` 只是所有行 `end_ms` 的最大值（`:1931-1935`）。它没有声明“该时间之前不会再出现或修改 segment”，所以不是连续 sealed watermark。
- `source_duration_ms` 固定为 `null`；draft 保存了 `model_revision`，但 endpoint item 没返回它。
- account transcript endpoint `backend/app/api/app_meetings.py:1609-1676` 只读 canonical `TranscriptLine`，没有读取 draft table；当前增量可见性不是所有身份模式的共同合同。`[S]`

### 3.5 客户端仍有轮询与 identity 闸门

设备完成 provider 已经每 750ms 拉一次 provisional transcript，但仍存在冗余等待：

- `src/components/DeviceMeetingCompletionProvider.tsx:91-115` 对每个 meeting 先请求 task status，再请求 transcript；除 task 404 的特殊分支外，task 请求失败会阻止独立可读的 transcript 拉取。
- 候选最多四个且 `for ... of` 串行（`:78-115`），前面的 task/transcript 网络等待会推迟后面会议。
- `:152-159` 的“内容相同”判断忽略 speaker id/label/confidence。未来迟到 `speaker.patch` 若保持文字和 ID 不变，会被当作无变化。
- `:167-171` 保存了 remote revision id，但忽略 server 的 `processed_duration_ms`，客户端没有可消费 watermark。`[S]`

Android 不能按当前 M1 文档直接接流式事件：

- `AudioProtocol.kt:270-285` 只接受 `transcript.completed|partial|delta`，不接受 `transcript.stable`；只保留 `isFinal`，丢弃 provider segment/revision/watermark。
- `AudioProtocol.kt:295-307` 用 speaker、时间和 text 参与 hash 生成 segment identity。
- `RecorderEngine.kt:259-294` 把这个 hash 当 `segmentId` 传给 JS。
- `nativeMinutesSnapshots.ts:205-236` 只在 `segmentId` 相同才替换。partial 文本变化或 speaker 后补会生成新 ID，从而追加新行而不是修订原行。
- `modules/laoji-native-platform/src/audio.ts:113-127` 的 TS 合同同样只有 `partial|final`，没有 revision、stable prefix 或 watermark。`[S]`

## 4. 对 Incremental Artifact Flow 的反证

### 4.1 过度抽象

对“文字先显示、speaker 后补”这项窄问题，0002 要求通用：

```text
Artifact + ArtifactRef + maturity + availability + sourceRefs + contentHash
+ Operation + requestedMaturity + cancelToken
+ Projection
```

生产中已经有 `MeetingRecordingTranscriptionJobV2`、draft rows、canonical transcript revisions 和本地 reducer。若 M1 再加入通用 `Operation` 表，就先制造第二 task owner；候选 0003 的证据也已承认尚未证明可删除现有 owner。`[S]`

`availability = local|remote|verified` 还把“存放位置”和“验证状态”塞进一个互斥枚举；这不是本次解耦所需概念。speaker patch、text stability 和来源连续性不需要先统一为所有 meeting intelligence 产物的通用本体。`[H]`

### 4.2 关键稳定语义不足

候选 0003 的真实合同只保证标签/数值不回退：

- `$CANDIDATE_ROOT/incremental-artifact-flow-0003/artifact_flow.py:577-592` 检查 maturity rank 和单个 `watermark_ms` 非递减，但不比较 stable prefix。
- `tests/test_artifact_flow.py:100-110` 明确接受 `stable="旧转写"` 后由 `final="新转写"` 完全替换；这与 0008 声称的“stable 前缀不能静默改写”冲突。
- `tests/test_artifact_flow.py:255-273` 只测 `1000 -> 999` 被拒绝；没有证明 1000ms 之前的所有 segment 已封口，也没有阻止同 watermark 的迟到不同文本成为新 current revision。
- revision 由 ledger 按**到达顺序**自动 `current.revision + 1`；没有 provider run id 或 provider event sequence。断线后迟到事件可能被本地赋予更大 revision。`[S]`

### 4.3 仍可能保留串行闸门

候选以一个 `logical_key="transcript:0"` 表示整份当前 transcript。任何新 transcript artifact 都使旧 source ref 过期；正在基于 stable 版本生成的 fact 会被作废并重跑。候选测试将此称为 invalidation，但在连续 ASR 中它可能形成：

```text
stable snapshot -> summary/fact 开始
new transcript revision -> 旧 operation/result 拒绝
重启 summary/fact -> 下一 revision 再拒绝
最终只能等 transcript 停止变化
```

这不是全局 `verifying -> committed`，却可能演化为“持续 CAS 失败直到 final”的隐式闸门。要真正增量整理，来源必须绑定已 sealed 的 segment/window，而不是整份 transcript current pointer。`[H]`

此外，0002 的图仍从 `MediaAsset -> segment artifacts -> ASR` 开始。若 segment 只在 VAD 闭段后产生，C0 的 650ms silence/4500ms max-speech 前置等待仍在；替换名称不会产生首 token。`[S]`

## 5. C0、M1-T、G1 比较

| 路线 | 真实改动边界 | 能删除的等待边 | 新概念/迁移 | 主要风险 | 决策 |
|---|---|---|---|---|---|
| C0 | 保持 Qwen Transformers、VAD、CAM++、现有 draft/poll；只做同输入 telemetry/replay | 0；只能量化 VAD、ASR、speaker、DB 和 poll | 最低 | 继续只有 completed；speaker 启动/emit/stop/final 闸门保留 | 当前生产基线 |
| M1-T 窄解耦 | 复用现有 job owner；定义 Transcript Lane、Speaker Lane 和单 reducer；先用当前 provider | 至少删除 CAM++->session ready、speaker->text emit、speaker->text final、task status->transcript fetch 四条边；stop 只等 text lane | 中低；需改 server adapter、device API、Android/TS reducer，但不新建通用 ledger | revision/run 设计错误、无界 speaker backlog、兼容事件双写 | **首选隔离候选** |
| G1 provider 替换 | Qwen vLLM streaming 或 FunASR/Paraformer 接入同一 M1-T adapter | 可能再删除 VAD 闭段->首文字；不能自动删除上述四条业务边 | 高；新 runtime、模型、显存、许可、Windows 路线 | 最终 CER/术语回归、stable 假设错误、双模型常驻、GPU OOM | M1-T 通过后才 A/B |

关键归因规则：必须先用**当前 Qwen provider + M1-T**测一次，再换 provider。否则首字延迟改善无法区分来自“speaker 解耦”还是“模型替换”。

## 6. M1-T 最小合同

M1-T 不要求先有通用 Artifact/Operation/Projection。它只要求一个 durable run 内的事件有稳定身份和顺序。

### 6.1 Transcript Lane

```json
{
  "type": "transcript.segment",
  "schema_version": 1,
  "meeting_id": "meeting-id",
  "asset_id": "asset-id-or-live-session",
  "run_id": "durable-job-or-live-run-id",
  "seq": 17,
  "segment_id": "provider-independent-segment-id",
  "segment_revision": 3,
  "maturity": "provisional | stable | final",
  "text": "当前文字",
  "stable_prefix_chars": 4,
  "source_start_ms": 1200,
  "source_end_ms": 2400,
  "model_revision": "locked-model-revision"
}
```

不变量：

1. `(meeting_id, asset_id, run_id)` 定义一个 replay domain；重处理产生新 `run_id`，进程重启恢复同一 job 时不能偷偷换 run。
2. `seq` 是该 run 的严格单调 event cursor；重复 `(run_id, seq)` 必须字节等价，否则 fail closed。
3. 同一 `segment_id` 的 `segment_revision` 只能递增；旧 revision/重复事件不改变 projection。
4. `stable_prefix_chars` 只能递增，后续同 run revision 必须逐字符保留已声明 stable prefix；`final` 封闭该 segment。
5. text lane 不携带 speaker identity。最终 `text_revision_id` 只由 source/model/text/timing 决定，不能因 speaker 后补改变。

### 6.2 连续 watermark

```json
{
  "type": "transcript.watermark",
  "schema_version": 1,
  "run_id": "durable-job-or-live-run-id",
  "seq": 18,
  "sealed_before_ms": 2400,
  "text_closed": false,
  "text_revision_id": null
}
```

`sealed_before_ms = X` 的语义不是“目前看见的最大 end_ms”，而是：**同一 run 后续不得新增或修改 `source_start_ms < X` 的 transcript segment。** 它必须单调；只有 `text_closed=true` 时才发布 content-addressed final `text_revision_id`。新 reprocess run 可以产生新版本，但不能在旧 run 内改写已封口区间。

### 6.3 Speaker Lane

```json
{
  "type": "speaker.patch",
  "schema_version": 1,
  "run_id": "durable-job-or-live-run-id",
  "seq": 19,
  "segment_id": "same-segment-id",
  "speaker_id": "profile-id-or-anonymous-id",
  "speaker_name": "讲话人显示名",
  "confidence": 0.92,
  "speaker_model_revision": "campplus-revision"
}
```

speaker patch 可失败、重试、迟到或缺失；它只更新 speaker projection，不改变 text、text segment revision、watermark 或 text revision id。客户端的“相同可见行”判断必须包含 speaker lane revision，不能只比较 text/end/isFinal。

### 6.4 轮询最小化

在保留 HTTP polling 的 M1-T 中，transcript endpoint 本身返回：

```text
run_id + latest_seq + events_after(cursor) + text_status + speaker_status
```

客户端直接按 cursor 拉 transcript lane；task status 只用于错误/重试详情，不能成为拉取可读文字的前置请求。若暂时仍返回全量 snapshot，snapshot 也必须携带单调 `latest_seq`，客户端拒绝旧 snapshot。

## 7. 具体等待边与废弃清单

### 7.1 M1-T 必须删除的等待边

1. `CAM++ ready -> VAD/ASR session ready`：VAD/ASR 可用即开始；speaker scheduler 独立降级。
2. `speaker embedding/identify -> realtime transcript emit`：ASR 结果先以 unknown speaker 发出。
3. `all speaker futures -> imported text_closed/final text revision`：text lane 结束即封口；speaker lane继续补丁。
4. `all segment speaker work -> ready_to_stop`：stop 成功条件只等本地音频保存与 text drain；speaker 有独立 deadline/后台恢复。
5. `task status request success -> transcript request`：直接拉 transcript cursor；task metadata 后取。

资源准入仍必须保留：同一 CAM++ 模型的 bounded queue/进程锁可以继续存在，但其拥塞只能延迟 speaker patch，不能反压 text lane。若内存达到上限，应丢弃/延后 speaker enhancement，而不是阻塞 ASR 或 UI。

### 7.2 应废弃或降级为历史参考

- 废弃“Native parser 已支持 M1 stable/revision/watermark，首个实验无需改 Android”的结论。
- 废弃 speech M1 必须先引入通用 `Artifact + Operation + Projection` ledger 的前提；现有 job owner 先复用。
- 废弃 `watermark_ms=max(end_ms)` 或“只要数字不回退就是稳定水位”的定义。
- 废弃用 speaker/text/content hash 在客户端临时生成 provider segment identity。
- 废弃 final transcript revision material 包含 `speaker_id` 的版本域混合。
- 废弃用 `meeting.updated_at + count` 作为 final text revision。
- 废弃 task status poll 作为 transcript fetch 的前置步骤。
- 废弃以整份 current transcript artifact 做所有增量 fact 的唯一 source ref；改为 sealed segment/window source refs，否则持续 revision 会造成重跑闸门。
- `transcript.delta` 只能作为旧 adapter alias，不能在没有 segment/revision/replace 语义时继续扩展。

保留但收窄：0002 的“结果按水位发布、speaker 不阻塞文字、来源 revision 不能回退”作为原则；候选 0003 只保留为通用 ledger 反事实和已有故障测试素材，不作为 speech M1 的直接实现。

## 8. Provider 事实与限制

### Qwen3-ASR streaming

Qwen 官方说明当前 streaming 只支持 vLLM backend，不支持 batch 或 timestamps；官方实现的 streaming state 默认 2 秒 chunk，并在后续 chunk 回滚一段 token suffix后重新解码累计音频。因此 `state.text` 是可修订 hypothesis，不是天然 stable prefix。时间定位仍需 LaoJi 的 source clock/VAD，稳定前缀需要 adapter 计算和回放验证，而非把每次 state.text 标为 stable。

- [Qwen3-ASR 官方 README](https://github.com/QwenLM/Qwen3-ASR/blob/main/README.md)
- [Qwen3-ASR 官方 streaming implementation](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py)

### FunASR / Paraformer streaming

FunASR 官方示例给出 `paraformer-zh-streaming`、cache、`is_final` 和约 600ms chunk 输出。这证明存在低粒度增量 adapter 候选，不证明每次输出的前缀不可改变，也不证明 LaoJi 中文会议 CER/术语/多人表现。其 Python 包声明 Windows classifier，但官方便捷 runtime 部署文档仍以 Linux 为主；特定 Windows/SenseVoice runtime 不能外推为 Paraformer + CAM++ + LaoJi 全链路已验证。

- [FunASR 官方仓库](https://github.com/modelscope/FunASR)
- [FunASR runtime quick start](https://github.com/modelscope/FunASR/blob/main/runtime/quick_start.md)

### 协议参照，不是 provider 决策

AWS 官方 streaming 文档区分 result `IsPartial` 与逐 item `Stable`；Google 官方 `StreamingRecognitionResult` 区分 `isFinal`、`stability` 和 `resultEndOffset`。它们支持“partial/final 与稳定度、音频位置是不同字段”的协议判断，但不等同于采用云 ASR，也没有替 LaoJi 定义 revision、隐私或中文质量。

- [Amazon Transcribe partial-result stabilization](https://docs.aws.amazon.com/transcribe/latest/dg/streaming-partial-results.html)
- [Google StreamingRecognitionResult](https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/StreamingRecognitionResult)

## 9. 隔离验证顺序

### Phase A：C0 真实等待基线

同一批脱敏录音记录 monotonic 时间：

```text
capture -> vad_close -> asr_enqueue -> asr_end
        -> text_emit -> speaker_start -> speaker_end
        -> draft_commit -> client_fetch -> client_project
        -> text_closed -> ready_to_stop
```

必须分别报告实时/导入、cold/warm、无 profile/有 profile、speaker 故障、DB 慢写和 1/2/4 会话。当前 587ms 记录不能替代这些分解。

### Phase B：当前 provider + M1-T

只改隔离 adapter/reducer，保持相同 Qwen、VAD、音频和硬件：

- ASR 返回即发 text segment；speaker 在 bounded lane 后补。
- 导入 ASR 完成即 `text_closed`，不等 speaker。
- 客户端按 `(run_id, seq, segment_id, segment_revision)` reduce。
- 注入 duplicate、reorder、disconnect/replay、final 后 late partial、watermark regression、同 seq 不同 payload、迟到 speaker patch 和 speaker 永久失败。

硬门：

- 任何 speaker 延迟/失败下，`text_emit` 和 `text_closed` 延迟分布不变（允许测量噪声，不允许因果等待边）。
- stable prefix 被改写、旧 seq 被接受、watermark 回退、final 后 text mutation、重复 segment 数量全部为 0。
- speaker patch 不改变 text revision；迟到 patch 能更新 UI 且不新增 transcript 行。
- stop text drain 不等待 speaker backlog；断线重连按 cursor 恢复且 projection digest 一致。
- M1-T 不新增第二 task owner，至少删除上述四条生产调用图等待边后才可提 adoption。

### Phase C：G1 provider A/B

只有 Phase B 通过后，Qwen vLLM streaming 与 Paraformer 才能作为同合同 adapter 对照。除 0008 已列 CER、术语、DER、资源和 Windows/许可门外，再要求：

- provider hypothesis 到 M1-T stable 的转换规则可解释、可重放；
- 同一 provider 原始 event trace 在 Linux/Windows adapter（若声称支持）产生相同 reducer projection；
- 任何 latency 收益不能靠两个 ASR 常驻或把 speaker/aligner重新塞回 text critical path。

## 10. 事实、假设、候选、未验证

### 已确认事实

- 实时 text emit 和 ready_to_stop 位于 speaker 处理之后。
- CAM++ 当前是 ModelManager 初始化的硬依赖，并有全局 inference lock。
- 导入 batch draft 在 speaker 完成前可持久化和被 device endpoint读取。
- 导入 final job/revision 在 speaker futures 和全局 assignment 之后。
- device 客户端会拉 provisional，但先请求 task status；Android/TS 不保留稳定 revision/watermark。
- 候选 0003 没有 stable-prefix 不变量或 provider event ordering。

### 待证伪假设

- 当前 provider 不变，仅删除 speaker/text 等待边就能显著改善首个可读文字和 stop 延迟。
- 现有 draft/final 表可在不新增 task owner 的前提下承载 M1-T run/seq/watermark。
- sealed segment/window source refs 能让局部 facts 保留，而不会随整份 transcript revision 反复作废。

### 候选

- M1-T Transcript/Speaker Lane 合同。
- Qwen vLLM streaming 和 Paraformer streaming 作为 Phase C adapter。

### 未验证

- 真实延迟分位、CER/术语、DER、DB 慢写、长会、并发、GPU 余量变化。
- 当前发布 APK/真机是否与 dirty source 完全一致。
- vLLM/FunASR 在目标 Linux/Windows 运行时的安装、资源、许可证与可发布性。
- summary/fact 基于 sealed windows 的质量、合并和引用 UX。

## 11. 可直接合入 CURRENT 的精炼决策

> 语音首刀不采用通用 Artifact/Operation ledger。当前源码证明实时文字在发送前等待 CAM++，导入 final revision 等待全部 speaker future；device provisional 已存在，但 task-status 前置轮询、时间戳 revision 和 Android 内容哈希 identity 使稳定修订不可成立。下一隔离候选为 M1-T Transcript/Speaker Lane：复用现有 transcription job owner，以 run/seq/segment revision 和连续 sealed watermark 发布 text，speaker 只作独立迟到 patch。C0 保持生产基线；Qwen vLLM/FunASR provider 替换只有在当前 provider + M1-T 先证明删除等待边后才进入 A/B。0008 中“Android 已可无改动接 stable 合同”及候选 0003 的 scalar-watermark/stable 证明均废弃。

建议在 CURRENT 的废弃清单加入：

1. `speaker -> text emit/text final/ready_to_stop` 串行边。
2. `task status -> transcript fetch` 前置轮询边。
3. speaker 与 text 共用 final revision。
4. `meeting.updated_at + count`、客户端内容哈希充当 transcript revision/segment identity。
5. whole-transcript current pointer 作为增量 fact 唯一 source ref。
6. speech M1 必须新增通用 Operation/Artifact ledger 的前提。

