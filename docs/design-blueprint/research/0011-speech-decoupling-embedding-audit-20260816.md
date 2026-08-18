# 老记语音流水线解耦嵌入边界与 Provider 一手资料审计

状态：`research`，隔离审计，**未采用、未批准 G1**。

观察日期：2026-08-16（Asia/Shanghai）
移动端工作树：`$MOBILE_REPO`
服务工作树：`$SERVICE_REPO`

本记录只回答两个问题：

1. 当前实时和导入转写在哪一层被 ASR、speaker、持久化或轮询门控，最小的 Provider/Speaker 解耦边界应放在哪里；
2. 当前 Qwen3-ASR Transformers 与最多三个替换候选，在 `partial/stable/final`、revision、时间戳、说话人、中文、许可和 Linux/Windows/Android 部署上，官方资料实际证明了什么。

它不修改生产服务、数据库、APK、`CURRENT` 或 revision，不是选型批准，也不是质量/性能报告。

## 最小结论

1. **G1 仍应拒绝。** 当前现场唯一运行的老记 Provider 是 Qwen3-ASR Transformers；Qwen vLLM streaming、FunASR/Paraformer 和 sherpa-onnx 均没有在同一老记样本、硬件、并发和 Windows/Android 边界上通过对照。
2. **先解耦再换模型。** 当前会议实时路径在 ASR 完成后，串行完成 speaker clustering 和身份识别，才发送 `transcript.completed`；有注册说话人时，同一音频还会走两次 CAM++ embedding。文字首个可见事件和 stop drain 都被 speaker 阻塞。
3. **导入路径已部分解耦，但不是完全解耦。** 每个 segment 的 speaker future 在 ASR 前提交，ASR batch 完成并保存 checkpoint 后先调用 `partial`，再结算 speaker；因此当前批次文字不等待 speaker 结果。不过 callback 会同步等待 draft 数据库提交最多 15 秒，speaker backlog 会在阈值处阻塞后续批次，而最终 transcript 必须等待全部 speaker future 和全局聚类。
4. **导入可见性受轮询门控，不是推理受轮询阻塞。** 设备端通过 transcript API 拉 draft；存在 active provisional task 时约 750 ms 轮询一次。轮询不会挡住 ASR 计算，但会决定已持久化 draft 何时进入 UI。
5. **原研究 0008 有一个需要纠正的前提。** Android parser 接受 `transcript.completed`、`transcript.partial`、`transcript.delta`，**不接受 `transcript.stable`**。因此若 M1 使用独立 `transcript.stable` 类型，不能声称无需修改 native parser。
6. 三个候选都没有直接提供老记所需的统一 stable watermark/revision 合同。`stable`、单调 revision、source lineage 和 speaker patch 必须由老记 adapter 定义，不能由 Provider 名称代替。

## 证据分层

- `[S]`：本轮本地源码直接观察。
- `[L]`：同日只读现场审计；只证明运行状态和资源快照。
- `[E]`：供应商官方仓库、官方文档、官方模型卡或官方运行时源码。
- `[I]`：由已列事实推出的工程判断。
- `[U]`：尚未在老记样本、硬件或目标 OS 上验证。

## 先纠正四个容易混淆的前提

### 1. partial、stable、final 不是同一个能力

- Provider 每个 chunk 返回当前文本，只证明有 incremental/partial 输出。
- `stable` 必须有可审计的含义，例如“同一 `segment_id` 的 `[0, stable_prefix_chars)` 后续 revision 不得改写”。
- endpoint 或 `is_final` 只封闭当前 utterance/segment，不证明此前的 partial 有稳定前缀。
- Qwen streaming 会显式回滚末尾 token；FunASR 2pass 会在句尾用 offline 结果纠正 online 结果；sherpa-onnx 返回“截至当前累计文本”。三者都需要 adapter 自己发 revision 和 stable watermark。[E][I]

### 2. 时间戳支持必须绑定运行模式和模型

- Qwen3-ASR offline 可配独立 ForcedAligner；官方 streaming 明确不返回 timestamps。
- FunASR WebSocket 协议只在所选 AM 为时间戳模型时返回 `timestamp`/`stamp_sents`；不能从 toolkit 支持时间戳推出 Paraformer online partial 必然带时间戳。
- sherpa-onnx API 暴露可选 token timestamps；官方头文件明确允许该字段为空。

因此老记的 `source_start_ms/source_end_ms` 必须先由采集时钟和 VAD/segment owner 提供，模型时间戳只能作为可选增强。[E][I]

### 3. speaker 是独立流水线，不是 ASR 文本字段

Qwen streaming result 只有 language/text state；FunASR 的 speaker 能力来自组合的 VAD/CAM++ pipeline，legacy Paraformer WebSocket 协议没有 speaker 字段；sherpa-onnx 的 speaker identification/diarization 也是单独 API。Provider 选择不能取消 `speaker.patch` 边界。[E][I]

### 4. “有 Windows/Android 示例”不等于同一 Provider 在本地运行

- vLLM 官方要求 Linux，Windows 原生不支持，只列 WSL/社区 fork；Android 无官方路径。
- FunASR Android 示例明确是 WebSocket **客户端**，不是在 Android 内部署 FunASR；Windows C# 示例同样连接远端 WebSocket。Windows 的 llama.cpp 包目前也不是 Paraformer streaming 2pass 的等价运行时。
- sherpa-onnx 才明确把 Linux、Windows、Android 和 Kotlin/JNI streaming 放在同一官方运行时矩阵中；但模型质量和老记集成仍未验证。

## 当前实时链路审计

### 实际调用顺序

```text
WebSocket PCM
  -> StreamingVAD
  -> bounded segment_queue(max 16)
  -> single segment_worker
       -> 8030 /asr (整段 HTTP，等待完成)
       -> CAM++ extract for anonymous cluster
       -> EnhancedRecognitionEngine.identify(audio)
            -> CAM++ extract again when enrolled speakers exist
       -> build transcript.completed
       -> WebSocket send
       -> async canonical persistence (non-guest)
```

代码证据：

- `qwen_ws.py:407-422` 建立一个有界 queue 和一个 worker；每个 segment 等待 `_qwen_transcribe` 的完整 HTTP 响应。[S]
- `qwen_ws.py:434-457` 在取得 text 后先执行 `extractor.extract(audio)`，再调用 `_identify(speaker_engine, audio)`。[S]
- `enhanced_engine.py:352-368` 的 `identify()` 在有注册说话人时再次执行 `self.extractor.extract(audio_sample)`；这不是纯余弦匹配，而是第二次 embedding forward。[S]
- `qwen_ws.py:504-529` 只有 speaker 处理完成后才构造和发送 `transcript.completed`。[S]
- `qwen_ws.py:532-543` 非 guest 的 canonical persistence 在发送后以 background task 执行，不阻塞已发送文字；guest cache 在发送前同步执行。[S]

### 明确阻塞关系

| 边界 | 当前行为 | 对文字可见性的影响 |
|---|---|---|
| VAD 闭段 | 会议 `silence_ms=650` 或 `max_speech_ms=4500` 后才有 segment | 没有 token streaming，首个事件至少等待闭段 |
| 8030 ASR | 单 worker 对一个 segment 等完整 HTTP 结果 | 阻塞该 segment 文字；后续 segment 在 queue 排队 |
| speaker cluster | text 已有后同步抽 embedding | 阻塞 WebSocket send |
| 注册身份识别 | 有 profile 时再次抽 embedding 并评分 | 继续阻塞 WebSocket send |
| non-guest persistence | send 后 background task | 不阻塞已发送文字 |
| stop | tail 入队，随后等待 worker 清空才发 `ready_to_stop` | ASR 和 speaker 都进入 stop drain 时延 |

`segment_queue.put()` 在 queue 满时会对接收循环施加背压，这是必要的有界行为；但当前没有 queue depth、enqueue/start/end 或 speaker latency 的协议级 telemetry，无法区分 VAD、排队、ASR 和 speaker 尾延迟。[S][I]

### 当前实时协议缺口

当前消息有 `text/start_ms/end_ms/model/speaker`，但没有：

- server-owned `segment_id`；
- 单调 `revision` 或 session sequence；
- `stable_prefix_chars` 或 `transcript.stable`；
- `model_revision`（只有 model 名称）；
- provider audio source revision；
- 独立 `speaker.patch` / `speaker_revision`；
- token timestamps。

因此当前 final-only 路径可工作，但不能安全承载会回滚的 streaming Provider。[S][I]

## 当前导入链路审计

### 实际调用顺序

```text
immutable media
  -> ffmpeg PCM stream
  -> VAD
  -> stable segment_id(source_sha256, ordinal, start_ms, end_ms)
       +-> submit CAM++ future (single worker)
       +-> batch ASR (<=8 items / <=12 s audio)
             -> verify model_revision + source range
             -> atomic segment checkpoint
             -> partial callback with text, no speaker
                  -> wait for draft DB commit (caller timeout 15 s)
       -> settle/bound speaker backlog
  -> wait all speaker futures
  -> overlap text deduplication
  -> global speaker cluster/identity assignment
  -> final turns
  -> atomic final checkpoint
```

代码证据：

- `compact_transcription_service.py:443-445` 从 source hash、ordinal、start/end 生成稳定 segment id。[S]
- `compact_transcription_service.py:330-401` ready/batch 合同固定 model revision，并校验每个 result 的 id 和 source range。[S]
- `compact_transcription_service.py:762-775` speaker executor 只有一个 worker，embedding 作为 future 提交。[S]
- `compact_transcription_service.py:790-830` ASR、checkpoint 和 text callback 在 speaker settle 之前发生；published row 包含 `segment_id/model_revision/start_ms/end_ms`，speaker 仍为未知。[S]
- `compact_transcription_service.py:831-833,881-890` backlog 超过上限会等待 speaker；最终一定等待全部 speaker future 并 shutdown executor。[S]
- `compact_transcription_service.py:891-914` 先做 overlap deduplication，再做 speaker assignment，二者都在最终 turns 前；final checkpoint 因而晚于 speaker。[S]
- `meeting_recording_asset_service.py:825-851` callback 跨线程提交 draft DB coroutine，并同步 `future.result(timeout=15)`；失败只记录并继续最终转写。[S]
- `device_v1.py:1820-1937` transcript GET 在 active job 时返回 provisional draft、revision id 和 processed duration。[S]
- `DeviceMeetingCompletionProvider.tsx:18-20,115-200` active provisional task 约每 750 ms 拉取；空闲时为 8 秒，错误后退避。[S]

### 明确阻塞关系

| 问题 | 结论 |
|---|---|
| 首批导入文字是否等待 speaker | **不直接等待**。callback 位于 speaker settle 之前 |
| 后续批次是否可能被 speaker 阻塞 | **会**。pending speaker 超过上限后等待至少一个 future |
| 最终稿是否等待 speaker | **会**。全部 future、speaker clustering 和 assignment 完成后才形成 final |
| ASR 是否等待客户端 poll | **不会**。poll 是读侧可见性机制 |
| 用户看到 draft 是否受 poll 影响 | **会**。已提交 draft 最迟要等下一次成功拉取；active 正常间隔约 750 ms |
| draft 持久化是否阻塞 ASR worker | **会**。每批 callback 同步等 event-loop DB commit，最多 15 秒 |

### 已有 lineage 与仍缺的 watermark

已有的强边界：

- source SHA-256、稳定 `segment_id`、source start/end；
- ready 时锁定 `model_revision`，响应变化立即失败；
- pipeline fingerprint 和每 segment atomic checkpoint；
- draft/full transcript 各有整体 revision id。

仍缺：

- 每个 segment 的单调 revision；
- “截至哪个 ordinal/source_end 已稳定”的 watermark；
- draft text 到 final deduplicated text 的显式 replacement revision；
- `speaker.patch`，当前从 `unknown` 到最终 speaker 依靠整份 provisional -> final 替换；
- checkpoint resume 时对已存在 checkpoint 但缺失 draft row 的重放合同；
- draft callback 超时与真实 DB commit 后到达之间的 acknowledgement/idempotency telemetry。

## Android 协议审计

### 已支持

`AudioProtocol.kt:254-293` 可以解析：

- `config`、stop acknowledgement 和 `ready_to_stop`；
- `transcript.completed`、`transcript.partial`、`transcript.delta`；
- text、`isFinal`、speaker id/name/confidence、segment start/end、source、purpose；
- 结构化 error code/retryable。

### 关键缺口

1. **`transcript.stable` 会被忽略。** 这直接反驳 0008 中“M1 三类 transcript type 已被 native parser 接受”的表述。[S]
2. parser 把 `partial` 和 `delta` 都折叠为同一个 `Transcript`，下游只能看到 `isFinal`，原始事件语义丢失。[S]
3. parser 不读取 server `segment_id`、revision、sequence、stable prefix、model revision 或 token timestamps。[S]
4. `transcriptIdentity()` 以 `sessionId + speakerId + startMs + endMs + text` 做 hash。partial 文本变化或 speaker 后补都会改变 identity，无法自然替换同一个 segment。[S]
5. parser 不接受 `speaker.patch`；speaker 只能绑在 transcript frame 内。[S]
6. `start_ms/end_ms` 是可选数值，当前 parser 没有在此层验证非负、`end >= start` 或 source watermark 单调。[S]

因此 M1 必须修改 native contract，或把 stable 编码为 `transcript.partial` 的附加字段；不能仅让新 Provider 发送现有 parser 不认识的类型。[I]

## Provider 一手资料比较

### 比较表

| 路径 | incremental / stable / final | revision / 时间戳 | speaker | 中文 | 许可 | Linux / Windows / Android | G1 判断 |
|---|---|---|---|---|---|---|---|
| 当前 Qwen3-ASR Transformers | 老记当前只有 VAD 后 `completed`；无 partial/stable | 老记有 VAD segment time，无 provider revision/token time；官方 offline 可另配 ForcedAligner | 老记 CAM++，当前 send 前串行 | 官方 30 语言 + 22 中文方言 | Qwen repo/model Apache-2.0；现场模型 revision 已锁定 | Linux 现场已运行；Windows native/Android 未验证 | 继续作为 C0 基线 |
| 候选 1：Qwen3-ASR vLLM streaming | 每个 full chunk 更新累计 text；末尾 K token 可回滚；finish flush final；无显式 stable 事件 | 官方明确 streaming 无 timestamps、无 batch、single stream；API 无业务 revision | 官方 streaming state 无 speaker 字段 | 同 Qwen 52 语言/方言范围 | `qwen-asr` 和 1.7B model card Apache-2.0；vLLM 依赖另列 SBOM | vLLM 官方 OS=Linux；Windows native 不支持，WSL only；无 Android 官方路径 | 适合 Linux server M1 A/B，不满足跨平台 G1 |
| 候选 2：FunASR Paraformer streaming/2pass | chunk text + `2pass-online`，句尾 `2pass-offline` 修正，有 `is_final`；无显式 stable/revision | WebSocket 可选 timestamp 仅限所选 timestamp AM；streaming model card 不保证 online partial timestamp | toolkit 可组合 CAM++，但 legacy WebSocket 协议没有 speaker patch 字段 | streaming model card：zh/en | toolkit MIT；特定 `apache-2.0-20260804` model tag 声明 Apache-2.0，但与 generic model license 的适用层级仍需审查 | Linux online Docker/SDK 明确；Windows Python install/remote C# client 存在但完整 native streaming server 未证实；Android 示例明确只是 remote client | 最值得做 Linux server M1 对照，不能从客户端示例推出 native G1 |
| 候选 3：sherpa-onnx + streaming Zipformer zh-en | `GetResult()` 返回累计 text，`IsEndpoint/Reset` 封闭 segment；无 stable watermark/revision | API 暴露可选 token timestamps，可能为空；C++ websocket result 有 segment/start/is_final，Kotlin API 需 adapter 补齐 | 独立 speaker ID/offline diarization API，不与 online ASR 自动合并 | 官方提供 bilingual zh/en Zipformer 和 Android 示例 | runtime Apache-2.0；维护者发布的 HF model card 标为 Apache-2.0，仍需 pin/hash/provenance | 官方矩阵明确 Linux/Windows/Android，含 Kotlin/JNI 与 APK | 部署可移植性最强；质量、模型大小、热词和老记 CER 未验证，只作第三 replay candidate |

### 候选 1：Qwen3-ASR vLLM streaming

官方源码比 README 更能说明 revision 行为：

- `init_streaming_state()` 默认 chunk 为 2.0 秒；可以配置，但不是 token 到达即发。
- 每个 full chunk 会重新送入从起点累计的全部音频。
- 前若干 chunk 不固定前缀；之后会从上次输出回滚末尾 K token，再作为 prefix 重新解码。
- state 只有当前 `language/text/chunk_id`，没有 segment revision、stable prefix 或 `is_final` 字段；final 由调用 `finish_streaming_transcribe()` 的控制流表达。
- streaming 仅支持 vLLM，官方明确不支持 timestamps 和 batch。

这证明它能提供可回滚 partial，不证明 stable 水位；默认 2 秒 chunk 也不能直接满足 0008 的首 token 门，必须在老记样本上调 chunk 并测质量/显存。[E][U]

### 候选 2：FunASR Paraformer streaming/2pass

官方 `AutoModel` 示例用 `chunk_size=[0,10,5]`，每 600 ms 输入一块，保留 cache，并在末块设置 `is_final`。官方 WebSocket 2pass 协议把结果分为 `2pass-online` 和句尾纠正的 `2pass-offline`。这非常适合映射为 partial -> final，但文档没有：

- server segment id；
- revision number；
- stable prefix；
- old/duplicate/out-of-order rule；
- speaker patch。

许可还必须按精确模型 revision 处理：FunASR 源码是 MIT；`funasr/paraformer-zh-streaming` 的 immutable `apache-2.0-20260804` tag 明确覆盖列出的权重和配置，而历史 commit `45df...` 没有模型卡引用的 LICENSE。与此同时，FunASR 主仓库的 generic `MODEL_LICENSE` 自称覆盖模型权重并包含独立限制。两份声明的适用层级不能由工程审计擅自裁定；G1 前必须锁定精确 tag/hash 并完成来源/法律审查，不能把 toolkit MIT 或任一 generic 声明自动扩展到其他 revision。[E][U]

### 候选 3：sherpa-onnx + streaming Zipformer zh-en

官方 C/C++ API 提供：

- 累计 text、tokens、可选 token timestamps；
- stream ready/decode；
- endpoint detection/reset；
- 多 stream decode；
- 独立 speaker identification/diarization；
- Linux、Windows、Android 和 Kotlin/JNI。

它最接近真正的跨平台 provider runtime，但 Android Kotlin `OnlineRecognizerResult` 只直接暴露 text/tokens/timestamps，endpoint 由单独方法判断；revision、stable、source range 和 speaker patch 仍由老记 adapter 负责。官方存在中文/英文模型和 APK 只能证明可运行性方向，不证明老记会议/日程质量。[E][U]

## 最小解耦嵌入边界

### 1. Provider 只拥有音频到文字候选

建议的隔离 SPI：

```text
ProviderSession.accept(audio_chunk, capture_sequence, source_range)
ProviderSession.finish()
  -> ProviderTextEvent {
       segment_id,
       revision,
       kind: partial | stable | final,
       text,
       stable_prefix_chars,
       source_start_ms,
       source_end_ms,
       token_timestamps?,
       provider_model,
       provider_model_revision
     }
```

Provider 不拥有 meeting persistence、speaker、UI id、业务 job status 或 stop 文案。

### 2. segment owner 位于 Provider 之外

- realtime：采集 session + monotonic capture sequence + VAD/source range 生成 segment id；Provider 可建议 endpoint，但不能重写既有 segment identity。
- import：复用现有 `source_sha256 + ordinal + start_ms + end_ms` 稳定 id。
- Provider 重试、切换或 shadow replay 复用同一 source identity，另开 provider/model revision。

### 3. speaker 只发可撤销 patch

```text
SpeakerEvent {
  segment_id,
  speaker_revision,
  speaker_id,
  label,
  confidence,
  status: provisional | final | failed
}
```

text stable/final 不等待 speaker。speaker queue 有界；超限时保留文字、丢弃或延迟 speaker，不允许反向阻塞 Provider queue。

### 4. Android 以 server identity 收敛

Native parser 至少要保留：

- raw transcript kind（包括 stable）；
- server `segment_id`；
- revision/sequence/stable prefix；
- source range 和 model revision；
- speaker patch。

Reducer 只接受更高 revision，stable watermark 只能前进；identity 不再包含可变 text/speaker。旧 final-only server 可适配成 `revision=1, kind=final`，保持回滚路径。

## 推荐执行顺序

1. 在 replay runner 中先把当前 C0 包成 Provider adapter；输出仍只有 `final revision=1`，验证不改文字、时段、停止和持久化结果。
2. 先消除实时 `ASR -> speaker -> send` 串行：ASR 文本立即发，CAM++ 进入独立有界 queue；复用一次 embedding 同时做 cluster 与 identity scoring。
3. 为导入 draft 增加 per-segment revision/watermark 和 speaker patch；不要把 750 ms poll 当作 revision 合同。
4. 用同一 PCM 串行回放 Qwen vLLM、Paraformer、sherpa-onnx，记录 first/stable/final、rollback、CER、GPU/CPU/RSS 和 stop/reconnect。
5. 只有实际发布矩阵需要 native Windows/Android 时，才把 sherpa-onnx 提升为强候选；若产品架构明确是 Linux server + Android client，Android on-device 不是 G1 硬门，但必须在发布矩阵中明示。

## G1 最小进入条件

以下任一未完成，G1 都是 `NO-GO`：

- 当前 C0 adapter parity 和故障回归通过；
- `segment_id/revision/stable watermark/source range/model revision` 合同通过乱序、重复、断线、stop 测试；
- speaker failure 不影响文字，且不再有 send-before-speaker 的反向依赖；
- 同输入 paired CER/关键术语/日程字段不回归；
- 1/2/4 会话和 30 分钟长会资源门通过；
- 目标部署矩阵逐项实跑，不能用 WSL 代替 Windows native，也不能用 Android remote client 代替 on-device；
- toolkit、模型 tag/commit、依赖、NOTICE、hash 和再分发条件锁定。

因此本轮对 G1 的最小结论是：**不选 Provider、不迁生产；批准的下一步只有 M1 协议/解耦 replay。** Linux server 对照优先 Qwen vLLM 与 Paraformer；sherpa-onnx 作为跨平台第三候选保留，不因官方平台矩阵而提前晋级。

## 一手来源

### 本地源码/现场

- `$SERVICE_REPO/backend/app/api/qwen_ws.py`
- `$SERVICE_REPO/backend/app/asr/enhanced_engine.py`
- `$SERVICE_REPO/backend/app/services/compact_transcription_service.py`
- `$SERVICE_REPO/backend/app/services/meeting_recording_asset_service.py`
- `$SERVICE_REPO/backend/app/api/device_v1.py`
- `modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/AudioProtocol.kt`
- `modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/RecorderEngine.kt`
- `src/components/DeviceMeetingCompletionProvider.tsx`
- [同日 live provider audit](../evidence/live-asr-provider-audit-20260816.md)

### Qwen / vLLM

- [Qwen3-ASR 官方仓库与 streaming 说明](https://github.com/QwenLM/Qwen3-ASR)
- [Qwen streaming state/rollback 官方源码](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py)
- [Qwen3-ASR-1.7B 官方模型卡](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)
- [vLLM 官方 GPU 安装与 OS 要求](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/)

### FunASR / Paraformer

- [FunASR 官方仓库](https://github.com/modelscope/FunASR)
- [Paraformer streaming 官方示例](https://github.com/modelscope/FunASR#usage)
- [FunASR WebSocket/2pass 官方协议](https://github.com/modelscope/FunASR/blob/main/runtime/docs/websocket_protocol_zh.md)
- [FunASR online SDK 官方说明](https://github.com/modelscope/FunASR/blob/main/runtime/docs/SDK_tutorial_online_zh.md)
- [Paraformer-zh-streaming immutable Apache-2.0 模型卡](https://huggingface.co/funasr/paraformer-zh-streaming/tree/apache-2.0-20260804)
- [FunASR Android 官方说明：remote client，不是 on-device runtime](https://github.com/modelscope/FunASR/blob/main/runtime/android/readme.md)
- [FunASR toolkit MIT LICENSE](https://github.com/modelscope/FunASR/blob/main/LICENSE)
- [FunASR generic model license](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)

### sherpa-onnx

- [sherpa-onnx 官方平台矩阵](https://github.com/k2-fsa/sherpa-onnx)
- [sherpa-onnx streaming result C API](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/c-api/c-api.h)
- [sherpa-onnx endpoint/segment result 源码](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/online-recognizer.h)
- [sherpa-onnx Android Kotlin streaming API](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/kotlin-api/OnlineRecognizer.kt)
- [官方 Android zh/en streaming build 示例](https://k2-fsa.github.io/sherpa/onnx/android/build-sherpa-onnx.html)
- [zh/en streaming Zipformer 模型卡](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20)
- [sherpa-onnx Apache-2.0 LICENSE](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE)

## 未验证清单

- 三个候选在老记脱敏真实中文、多人重叠、数字/专名和日程字段上的 paired quality。[U]
- Qwen streaming 在小于 2 秒 chunk 时的 rollback、CER、显存和 4 会话 p95。[U]
- Paraformer online partial 是否在所选 runtime/model revision 下稳定提供可用 token timestamps。[U]
- FunASR Python/ONNX Paraformer streaming 的 Windows native server 安装、30 分钟长会和打包；Android on-device 无当前官方证明。[U]
- sherpa-onnx 所选 Zipformer 的老记 CER、模型包体、热词收益、token timestamp 完整性和 Android 功耗。[U]
- speaker/text 真正并行时与 8030 共 GPU 的 contention；解耦不等于允许无界并发。[U]
- draft checkpoint resume、DB timeout 和 poll 乱序下的最终 revision 收敛。[U]
