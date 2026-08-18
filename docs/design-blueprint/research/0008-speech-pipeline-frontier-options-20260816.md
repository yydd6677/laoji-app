# 老记语音/ASR 流水线前沿方案比较

状态：`research`，隔离研究，**未采用**。

观察日期：2026-08-16（Asia/Shanghai）
源码工作树：`$MOBILE_REPO`（移动端）
服务工作树：`$SERVICE_REPO`（后端/ASR）

本记录回答一个窄问题：在不先增加新的生产任务 owner 或常驻模型的前提下，老记的实时与导入语音应继续维护当前 Qwen3-ASR 路径、做最小重构，还是替换为 Qwen3-ASR 原生流式或 FunASR/Paraformer 流水线。它不是质量报告，也不是部署批准。所有性能和质量门槛都必须用老记的脱敏真实样本和同一硬件实测，README 数字、合成回放时间和服务健康检查不能代替实测。

## 结论先行

1. 当前不能宣称已有“首 token 流式 ASR”。移动端已经能解析 `transcript.partial`/`transcript.delta`，但当前 Qwen WebSocket 服务只发 `transcript.completed`；每段音频先经过 VAD 闭段，再等待一次 HTTP 推理返回。实时首 token 指标因此是 `N/A`，只能测首个 completed 片段。
2. 短期建议是 **M1 最小重构**：保留现有 Android/native 录音、鉴权、WebSocket URL 和停止握手，把 8030 变成可交换 Provider；先把 `partial -> stable -> final`、序号、水位和音频源区间补进隔离协议，再以同一录音回放对照 Qwen3-ASR streaming 与 Paraformer streaming。不要现在宣布 G1 全量替换。
3. 维护路线仍是默认生产路线，直到 M1 同时证明首 token、稳定文字、最终准确率、资源和 Windows/许可门槛。只调 VAD 阈值不能证明架构收益；不受约束地并行 CAM++ 和 ASR 可能在同一 GPU 上放大队列和 OOM。
4. 讲话人是可撤销增强层：文字达到 `stable` 即可展示，讲话人后到时以同一 segment identity 发 patch。任何实现都不能让讲话人识别失败隐藏或回滚已稳定文字。

## 证据分层

- `[S]`：本地源码/测试直接观察到。
- `[L]`：已有同日只读运行记录，证明现场进程/端口，不证明质量。
- `[E]`：外部官方仓库、模型卡或文档。
- `[U]`：尚未在老记输入、硬件或 Windows 上验证的假设。

### 当前事实

| 观察 | 证据 | 不能推出的结论 |
|---|---|---|
| 实时 WebSocket 只在 VAD 产生 segment 后发起一次 `_qwen_transcribe`，随后发 `transcript.completed` | `$SERVICE_REPO/backend/app/api/qwen_ws.py:407-525` `[S]` | 不能称为 token/partial streaming；未测真实延迟 |
| 会议 VAD 配置为 `max_speech_ms=4500`、`silence_ms=650`；日程为 `12000`、`900` | `$SERVICE_REPO/backend/app/api/qwen_ws.py:92-110` `[S]` | 这是闭段配置，不是首 token 实测；未包含队列和推理时间 |
| 8030 的推理协调器是一个优先级队列和一个 worker；请求阻塞到 `finished`，只在调用结束后返回整段文字 | `$SERVICE_REPO/backend/qwen_asr_service/server.py:8-10,217-259,320-420` `[S]` | `realtime` 优先只改善排队顺序，不能中断已执行的 GPU 调用或产生 token |
| 8030 当前配置模型为 `Qwen/Qwen3-ASR-1.7B`；现场记录为 `127.0.0.1:8030` 的 Qwen3-ASR 服务 | `$SERVICE_REPO/backend/qwen_asr_service/server.py:38-76`、`docs/design-blueprint/evidence/live-server-20260816.md:9-16` `[S][L]` | `/api/ready` 为 ready 不等于质量或延迟达标 |
| Native parser 已接受 `transcript.completed`、`transcript.partial`、`transcript.delta`，并保留 `isFinal`、时间区间和 speaker 字段 | `modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/AudioProtocol.kt:254-291` `[S]` | 服务端尚未提供稳定水位、segment revision 或 partial 的去重合同 |
| 离线路径按 VAD segment 批量（最多 8 项）调用 8030；ASR 文字可通过 `partial` callback 发布，讲话人 embedding 在单线程池中补齐，最终 speaker 分配仍在全部记录收集后进行 | `$SERVICE_REPO/backend/app/services/compact_transcription_service.py:344-402,716-834,891-915` `[S]` | 已有有限重叠不等于独立、可取消的两个流水线；未测重叠收益 |
| CAM++ inference 有进程级锁；离线 speaker executor `max_workers=1` | `$SERVICE_REPO/backend/app/asr/model_manager.py:24,414-420`、`$SERVICE_REPO/backend/app/services/compact_transcription_service.py:762-775` `[S]` | 任意增加线程不会自动增加吞吐，可能只增加等待 |
| 当前资源有竞争风险：GPU0/GPU1 同时被老记、其他 ASR/Ollama/服务占用 | `docs/design-blueprint/evidence/live-server-20260816.md:18-31` `[L]` | 不能据此批准第二个常驻 ASR 或提高并行度 |

当前没有可发布的老记 ASR 首 token p50/p95、稳定文字回滚率、最终 CER/WER、讲话人 DER、Windows 运行结果或同输入 provider 对照。以下所有门槛都是待执行的验收合同。

## 三条路线

| 路线 | 保留/新增 | 维护与迁移 | 首 token/稳定文字潜力 | 主要风险 | 决策状态 |
|---|---|---|---|---|---|
| C0 继续维护 | 保留 8030 Qwen Transformers、现有 VAD、CAM++、WebSocket 和离线 checkpoint；只补 telemetry、队列告警、异常和阈值回放 | 最低；不增加生产 owner | 首 token 无法改善；可降低闭段或排队尾延迟，但需回归准确率 | 继续只有 completed 事件；partial/stable 语义缺失；GPU 竞争只能观察不能解释 | 继续作为当前基线 |
| M1 最小重构 | 保留客户端外壳和存储；新增一个 ASR Provider 接口、稳定输出协议和有界 scheduler；Qwen streaming 与 Paraformer 作为隔离 adapter | 中；可 shadow/replay，旧 provider 可回滚；必须删除重复的 provider 分支和第二任务真相源 | 高；600ms 级 chunk 或 Qwen vLLM stream 可先发稳定文字，讲话人可后补 | 双写/双模型常驻、revision/去重不严、GPU 争用、旧 completed 语义兼容 | **首选隔离原型** |
| G1 全量替换 | 以 FunASR end-to-end 或 Qwen vLLM + 新 VAD/speaker runtime 替代 8030/qwen_ws/旧 pipeline；重做服务部署和 Windows 包 | 最高；需迁移 API、运行时、模型缓存、日志、恢复和许可清单 | 理论最高，但未经 M1 对照不能归因 | 质量回归、资源峰值、停止/断线/恢复退化；迁移期间产生双状态 owner | 只做回放候选，未批准 |

### C0 维护的最小工作

C0 不把配置改动伪装成架构升级，允许做以下只读或低风险准备：

1. 在 `capture_frame`、`vad_emit`、`provider_enqueue`、`provider_start`、`provider_end`、`emit`、`speaker_patch` 记录单调时钟和 `segment_id`，分别报告 warm/cold、队列等待和推理时间。
2. 保持当前 `transcript.completed` 兼容；把 VAD 闭段时间、8030 queue/infer 时间和网络/序列化时间拆开，先得到真实基线。
3. 在同一脱敏音频回放中调 `silence_ms`、`max_speech_ms`、batch limit，不把合成时间当用户体验证据。

若 C0 只靠缩短闭段让首个事件更早，却使中文句子被切碎、CER 或 schedule 字段准确率下降，C0 失败而不是“优化成功”。

### M1 的最小边界

M1 只在隔离服务或 replay runner 里新增以下合同：

```json
{
  "type": "transcript.partial | transcript.stable | transcript.completed",
  "segment_id": "asset-or-session-segment-id",
  "revision": 3,
  "text": "当前可见文字",
  "stable_prefix_chars": 8,
  "source_start_ms": 1200,
  "source_end_ms": 2400,
  "emitted_at_ms": 2400,
  "model_revision": "provider-model-revision",
  "is_final": false
}
```

- `segment_id`、`revision` 和 `source_*` 是去重/血缘字段，不是显示字段。
- `partial` 可以回滚；`stable` 的前缀不能被后续同一 segment 静默改写；`completed` 封闭 segment。
- 水位只能前进；旧 revision、重复事件、跨会议事件全部丢弃并计数。
- 讲话人结果使用同一个 `segment_id` 的独立 `speaker.patch` 或 `speaker_revision`，不覆盖文字正文。
- Provider 名称、模型端口和内部队列不进入业务事实；当前 8030 仅是 adapter。

Native parser 已能接受上述三类 transcript type，因此 M1 首个实验不必改 Android socket parser；JS 收敛和列表 reducer 仍需独立验证，不能把“能解析事件”当成 UI 已正确处理。

## Provider 与组件比较

### 1. 当前 Qwen3-ASR Transformers（C0）

- 现状：服务端在 `8030` 载入 Qwen3-ASR-1.7B，使用 `model.transcribe()`，一个优先级协调器串行执行。[S]
- 优点：当前已接入、模型 revision/queue telemetry 已有接口、离线和实时共用模型，回滚成本最低。
- 限制：每个 VAD segment 是一次完整 HTTP 推理；无 token/partial，无法在模型生成中途取消；模型质量和显存占用必须以本机数据为准。
- 适合：C0 基线和 M1 的第一对照，不适合直接声称“流式”。

### 2. Qwen3-ASR 原生 streaming（候选）

官方 Qwen3-ASR 文档称 0.6B/1.7B 支持统一 offline/streaming inference，并说明当前 streaming 仅支持 vLLM backend，且 streaming 不支持 batch inference 或 timestamps（[官方仓库](https://github.com/QwenLM/Qwen3-ASR)，`Streaming Inference` 小节）。模型卡标注 Apache-2.0（[Qwen3-ASR-1.7B model card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)）。

**可取之处**

- 保留 Qwen 家族，可把现有 8030 Provider 替换为 vLLM stream；理论上能按 chunk 发增量文本，而不是等 VAD 闭段。
- offline/streaming 使用同一模型家族，便于最终稿与实时稿的 revision 对齐。

**必须正视的边界**

- 官方 streaming 路径依赖 vLLM；当前 8030 是 Transformers `model.transcribe()`，不能只改 URL 或事件名就得到 stream。
- streaming 不提供 timestamps；老记的 segment 时间、播放定位和来源引用需要独立 VAD/segment clock 或后置 ForcedAligner，不能伪造模型时间戳。
- vLLM、FlashAttention、CUDA 和 Windows 原生兼容性未在老记环境验证。Qwen 文档推荐 Python 3.12 和隔离环境；本记录不把 Linux CUDA 结果外推为 Windows 支持。

**判断**：M1 的高价值对照，但只有在稳定文字、最终准确率和显存门槛同时通过后才可替换 C0。若 Windows 是发布目标，必须单独保留 Transformers/CPU 或 FunASR fallback，而不是默认假设 vLLM 可用。

### 3. FunASR/Paraformer streaming（候选）

FunASR 官方仓库把 `paraformer-zh-streaming` 列为 220M streaming ASR，并给出 `chunk_size=[0,10,5]`、约 600ms chunk、`cache` 和 `is_final` 的示例；同一生态提供 FSMN-VAD、ct-punc 和 CAM++ 组件（[FunASR README](https://github.com/modelscope/FunASR)）。FunASR 工具源码为 MIT，但官方明确说预训练权重按各模型卡单独许可；Paraformer 中文模型卡显示 Apache-2.0，CAM++ 中文模型卡也显示 Apache-2.0（[Paraformer model card](https://www.modelscope.cn/models/damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/summary)、[CAM++ model card](https://www.modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common)）。

**可取之处**

- streaming cache、`is_final` 和较小模型规模很适合 M1 的 `partial/stable/final` 协议；可先以 600ms 左右 chunk 做对照。
- VAD、标点、speaker diarization 组件可组合，便于把文字和讲话人拆成独立水位。
- 官方文档和 runtime 资料包含 Windows 方向；仓库当前还提供 Windows CPU/Vulkan/CUDA 的 llama.cpp 归档，但这些是特定 GGUF/runtime 的支持，不等于 Python `AutoModel` + Paraformer 全链路已经在老记 Windows 验证。

**必须正视的边界**

- toolkit、模型权重、VAD、punc、CAM++ 的许可和版本必须逐项记录；“FunASR 是 MIT”不能覆盖权重。
- Paraformer streaming 的 600ms 是示例 chunk，不是老记的首 token 或 CER 保证；会议噪声、多人重叠和中文专有名词必须用老记语料测。
- 若把 FunASR runtime、Python 服务和当前 qwen_ws 同时常驻，会增加显存、启动、更新和故障面；M1 只能在 shadow/replay 期间隔离加载。

**判断**：最值得与 Qwen stream 做同输入 A/B。若在相同硬件上达到首 token 和最终 CER 门槛，并且 Windows 包装更可控，才有 G1 替代价值。

### 4. VAD 与讲话人并行（组件策略，不是单独 ASR）

当前 Silero VAD 按 512-sample 窗口处理，实时段结束后才进入 ASR；CAM++ 提取与识别在 segment 处理路径中发生，进程级锁保护 CUDA forward。[S] Silero VAD 官方仓库标注 MIT，并说明支持 8/16 kHz、PyTorch/ONNX 等运行方式（[Silero VAD](https://github.com/snakers4/silero-vad)）。

推荐的 M1 形态：

```text
PCM frame
  -> bounded VAD state
  -> segment_id/source range
       +-> ASR provider queue -> partial -> stable -> final
       +-> bounded speaker queue -> speaker.patch (可失败)
```

- VAD 不占用 ASR GPU；它只发布不可变 segment。
- ASR 文字不等待 speaker；speaker 任务最多保留有限 pending，超限时丢弃/延后 speaker，不阻塞文字。
- 同 GPU 时由资源准入保证 ASR 与 CAM++ 不发生不可控并发；不同 GPU 或 CPU speaker 才允许提高 overlap。现有 CAM++ 锁不能删除，除非有独立稳定性测试。
- 离线路径可继续对 segment 做 embedding future，但最终 speaker assignment 必须变成可重放的 patch/revision，不能只在整场结束时改变历史行。

## 可测量验收门槛

### 统一测量定义

每次回放记录以下单调时钟（`perf_counter` 或设备 monotonic，不用 wall clock）：

```text
t_capture       首个包含真实 PCM 的 frame 被接收
t_vad_end       segment 闭段/commit
t_enqueue       provider 入队
t_first         首个非空 partial 文本事件
t_stable        首个 stable 前缀事件
t_final         completed/final 事件
t_speaker       speaker.patch 或最终 speaker revision
t_source_end    t_capture + 该 segment 的 source_end_ms（单调时钟上的音频末点）
```

必须分开报告：

- cold：进程启动/模型首次加载到 ready；
- warm：模型 ready 后的单会话；
- concurrency：1、2、4 个并发实时会话；
- clean stop、断线重连、长会（至少 30 分钟）和 queue-full/取消。

`t_first - t_capture` 不是当前 C0 的可用值，因为 C0 没有 partial；C0 应报告 `t_completed - t_capture` 作为基线，并明确标记 `first_token=N/A`。

### 门槛表

| 门 | 通过标准（warm，1 会话；并发门另列） | 失败含义 |
|---|---|---|
| 首 token | 候选 `t_first-t_capture` p50 ≤ 900 ms、p95 ≤ 1,500 ms；4 会话 p95 ≤ 2,500 ms。若 provider 只支持 completed，门为 `N/A`，不得冒充通过 | 没有可观察增量收益，保留 C0 |
| 首个稳定水位 | `t_stable-t_capture` p50 ≤ 1,500 ms、p95 ≤ 2,000 ms；stable watermark 单调，不能等待完整会议 | 稳定稿仍被全局串行闸门阻塞 |
| 稳定文字 | 同一 segment 的 stable 前缀后续改动字符率 p95 ≤ 1%；rollback 只允许发生在未声明 stable 的 suffix；重复/乱序/旧 revision 接受数为 0 | UI 会闪烁或覆盖用户可见稿，否决协议 |
| 最终文字 | 候选 CER 相对 C0 基线不劣化超过 0.5 个百分点（95% bootstrap CI）；clean 片段目标 CER ≤ 10%，噪声/多人片段目标 CER ≤ 15%；关键术语召回不低于 C0 - 1pp | 首 token 变快但最终稿退化，不能替换 |
| 日程语音 | 日期、时间、重复、地点和标题字段 exact-match 不低于 C0；任何安全澄清字段不得被候选静默写入 | 会议 ASR 改善不能牺牲高频日程体验 |
| 讲话人 | speaker DER/segment assignment 相对 C0 不劣化超过 2pp；自动命名 precision ≥ 95%，其余标为 unknown；speaker 失败不丢文字 | 并行 speaker 产生错误身份或阻塞文字 |
| 端到端实时余量 | `t_final - t_source_end` 的处理余量 p95 ≤ 500 ms（600ms chunk 对照）；实时因子 `processing_seconds/audio_seconds` p95 < 0.8；queue depth 不得持续增长 | 实时会话会追不上说话速度 |
| 资源 | 30 分钟、4 会话无 OOM/崩溃；峰值 GPU memory 不超过 C0 + 15%，CPU RSS 不超过 C0 + 25%；常驻 ASR 模型最多一份、speaker 模型最多一份；队列有界且可取消 | 以第二个常驻模型换来的局部加速不接受 |
| 恢复/取消 | stop 后最终稿在声明的 drain deadline 内到达；断线可恢复 segment；取消不再发送新 provider 请求；重复提交不产生重复 segment | 只改 UI 状态而未停止推理，否决 |
| Windows | Windows 11 x64 clean venv 完成安装、模型加载、实时 30 分钟、停止/重连和离线导入；不能用 WSL2 结果替代 native Windows。若仅 server Linux 支持，发布矩阵明确标为 server-only | 兼容性是假设而非证据 |
| 许可/供应链 | 锁定模型 revision、代码/模型卡许可、依赖 SBOM、NOTICE 和可再分发条件；FunASR 每个权重单独审查；未确认的模型禁止进入 release artifact | 许可证不清时不做替换 |

绝对 CER 目标只是产品目标，不能替代 paired baseline。若 C0 在某类真实样本已经优于目标，候选必须仍满足“相对不劣化”门槛；若 C0 很差，不能因“没有回归”就自动采用，必须补充提升幅度和置信区间。

## 隔离实验计划

1. **准备语料**：至少 60 段脱敏中文样本：短日程 15、单人会议 15、多人轮换 15、噪声/重叠 10、专有名词/数字 5；另取 30 分钟长会和 Windows 可携样本。每段有人工文本、segment 边界、speaker 标签和关键术语清单。
2. **C0 基线**：不改生产服务，用录音回放当前 8030/WS 和离线 API；记录上述时间、CER、字段 exact-match、DER、GPU/CPU/队列。重复 3 次 warm、1 次 cold，保存 provider/model revision。
3. **M1 adapter replay**：同一 PCM 送到 Qwen3-ASR streaming（vLLM 隔离实例）和 Paraformer streaming（隔离进程）。若不能在同一 GPU 同时加载，串行运行但使用相同硬件/功耗窗口；不要将两个模型同时常驻生产机。
4. **并行对照**：A 组 ASR 后 speaker，B 组 ASR 与 speaker 有界并行；比较首 token、稳定水位和资源峰值。禁止无限线程池；记录 speaker patch 延迟和文字是否受到影响。
5. **故障注入**：在 partial/stable/final、speaker patch、stop、断线、重复、乱序、source revision 变化处注入故障；验证最终 projection 只接受正确 segment/revision。
6. **Windows 验证**：对候选中实际要发布的运行时建立 clean Python 3.12/对应 Python 环境，分别执行 stream、offline、VAD、speaker、长会和停止；把 GPU 驱动、CUDA/Vulkan、模型下载方式和 hash 写入报告。
7. **决策**：只有候选在所有硬门通过，且至少两轮不同样本切分的 95% CI 不跨过回归阈值，才进入 G1 迁移设计；否则保留 C0 或仅采用 M1 协议，不替换 provider。

## 许可证、资源和 Windows 结论

- Qwen3-ASR 源码仓库和 1.7B 模型卡目前标注 Apache-2.0；具体模型 revision、ForcedAligner、vLLM、FlashAttention 和 CUDA 依赖仍要纳入 SBOM。Apache-2.0 不等于没有商标、专利诉讼或模型使用政策审查。
- FunASR toolkit 源码为 MIT，但官方明确预训练权重按模型卡分别授权。Paraformer 与 CAM++ 当前模型卡显示 Apache-2.0；版本升级必须重新检查模型卡和下载 hash。
- Silero VAD 仓库标注 MIT；实际使用的模型文件和 ONNX/PyTorch runtime 仍要记录精确版本。
- FunASR 官方资料已经给出 Windows SDK/运行时方向，近期 llama.cpp 归档包含 Windows CPU/Vulkan/CUDA 变体；这只能证明存在官方 Windows 路线，不能证明 LaoJi 的 Python streaming、数据库、ffmpeg、speaker 和 TLS/WebSocket 全链路兼容。
- Qwen3-ASR 官方文档推荐隔离 Python 3.12 环境，且 streaming 仅在 vLLM 后端；本记录没有把 vLLM Windows 原生支持当作已确认事实。若产品必须 Windows 原生，FunASR runtime 或 Transformers/CPU fallback 需要成为明确的 provider，而不是隐藏的安装失败路径。

## 反证与停止条件

出现任一条件时停止替换工作并回到 C0/M1：

- 候选首 token 达标但稳定文字 rollback、最终 CER、日程 exact-match 或 speaker DER 回归。
- 需要同时常驻 Qwen、Paraformer、CAM++ 或第二个 VAD 才能达到延迟；资源门因此失败。
- partial/stable/final 没有 segment identity、revision 和水位，导致乱序事件可覆盖用户编辑或跨会引用。
- 只能通过修改客户端展示文案、吞掉错误或扩大 stop timeout 来“通过”门槛。
- Windows 只能在 WSL2/手工开发环境运行，发布包无法重现；或模型/权重许可证未锁定。
- 两轮对照的收益只来自不同音频切段、不同 GPU、不同 warm 状态或不同后处理，无法归因于 provider。

## 参考

- [当前设计蓝图](../CURRENT.md) 与 [增量证据流修订 0002](../revisions/0002-incremental-artifact-flow-20260816.md)
- [现场服务器证据 2026-08-16](../evidence/live-server-20260816.md)
- [QwenLM/Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)
- [Qwen3-ASR-1.7B model card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)
- [modelscope/FunASR](https://github.com/modelscope/FunASR)
- [Paraformer 中文模型卡](https://www.modelscope.cn/models/damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/summary)
- [CAM++ 中文模型卡](https://www.modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common)
- [modelscope/3D-Speaker](https://github.com/modelscope/3D-Speaker)
- [snakers4/silero-vad](https://github.com/snakers4/silero-vad)

## 老记现场约束

截至 2026-08-16 06:42 的只读服务器审计见 [live ASR provider audit](../evidence/live-asr-provider-audit-20260816.md)：
当前老记只运行 Qwen3-ASR Transformers provider；`vllm` 和 `funasr` 不在老记
Qwen 环境，GPU0/GPU1 空闲约 2.2/6.1 GiB。因而本专题的 streaming provider
只能先在隔离环境或明确的外部资源上回放，不能把“服务器上存在历史 FunASR 文件”
误报成可用生产依赖。
