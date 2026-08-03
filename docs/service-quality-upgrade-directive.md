# 老记智能与后台服务质量升级工程指示

> 本文是后续服务升级的工程目标，不是当前版本已经达到的完成声明。当前稳定候选保持冻结；服务改进必须独立分支、独立开关、独立回滚。真机未连接时只允许完成源码、离线评测、隔离服务和线上只读基线，不补写任何真机结论。

## 0. 执行摘要

当前需要继续升级的不是单个“日程解析模型”，而是十个互相影响的服务族：

1. 推理调度与资源隔离；
2. 日程文本解析与多轮澄清；
3. 日程短语音转写；
4. 会议实时转写；
5. 会议离线音视频转写；
6. 讲话人分离、识别与资料闭环；
7. 结构化整理、模板和待办提取；
8. 会议问答、引用与检索；
9. 当前位置与地址解析；
10. 上传、处理作业、同步和恢复编排。

跨会议搜索/组织归入检索服务；照片附件理解仍保持关闭，只有通过第 15 节的多模态门槛才允许开放。

优先级不是按代码文件数量决定，而按用户可见损害排序：

| 优先级 | 服务 | 原因 |
|---|---|---|
| P0 | 推理调度、问答、整理、实时/离线转写、处理编排 | 已观察到 90 秒级问答、92 秒级整理、ASR 关键语义漏识别和任务失败；这些会直接表现为“不能用” |
| P1 | 讲话人、日程文本/短语音、位置解析 | 主链可用但质量覆盖不足；讲话人和位置已有真实用户缺陷，日程解析仍有静默丢字段样本 |
| P2 | 跨会议检索深化、照片附件理解 | 价值明确，但不得挤占 P0/P1 的正确性和速度 |

所有服务统一遵循：先固定基线，再改算法；先按风险分层评分，再看总分；先隔离运行，再小流量；任何数据丢失、跨账号泄漏或关键事实伪造都不能由平均准确率抵消。

## 1. 当前事实基线

### 1.1 运行拓扑

当前线上目标仍是：

- 日程/账号服务：`18035`，源码 `/home/zhong/laoji-service-platform/smart-meeting-ai/backend`；
- 会议服务：`18020`，同一目标工作区；
- 9B 推理：`127.0.0.1:21434`，`qwen3.5:9b`、8192 context；
- 问答嵌入：`127.0.0.1:21436`，`laoji-meeting-embedding:0.6b`；
- 移动端：`/home/yydd/LaoJi-worktrees/feishu-source-driven`。

当前 `18020` 和 `18035` 共用 `21434`，且 `OLLAMA_NUM_PARALLEL=1`。因此长整理、会议问答和复杂日程解析存在队头阻塞。GPU 1 当前几乎被无关 VLLM 工作占满，未经其所有者明确授权不得占用；GPU 0 的空闲显存只能作为候选实验容量，不能直接推导“再复制一个 9B 实例一定安全”。

### 1.2 已有证据与不足

| 服务 | 已有证据 | 仍不能证明的部分 |
|---|---|---|
| 日程文本解析 | 历史 1000 条诊断、100 条分层回归；当前线上源码含 50 个聚焦测试；规则路径本机约 4 ms，暖模型约 1.3–1.4 s | 真实输入占比低；没有冻结盲测集、置信度校准、稳定 p99、混合负载和完整多轮澄清评分；已复现不确定地点被静默丢弃但未追问 |
| 日程短语音 | 既有 WAV/MP3/AAC 小样本与合成语音检查 | 真实说话人、手机麦克风、口音、噪声、数字/日期/否定词的端到端槽位准确率不足 |
| 会议实时转写 | 已重跑 28 条语义债务、并发 4、双轮共 56 会话；stop acknowledgement 时序通过，ready p95 12 ms；Android 模拟器到隔离 ASGI 候选的真实 PCM 纵向握手已通过 | 原始门禁 37/56；并列语义审计在不改原文和原始 CER 的前提下为 50/56，但 11 条仍超尾延迟门槛，联合门禁为 39/56。M003/M008/M018 仍有未解决词项，M025/M027 属于数字/技术词表记差异，不应当作语义丢失；生产 `18020` 所依赖的 `127.0.0.1:8030` 当前未监听，因此旧结果也不能代表当前生产可用性；物理真机握手、真人长会议和 soak 仍不足 |
| 离线转写 | RecordingAsset、视频音轨、任务恢复和真实 GPU 主链已接通 | 格式、时长、真人噪声、截断保护、服务重启和长音频质量矩阵不足 |
| 讲话人 | 资料采集、修正、未来改善和旧会议重匹配合同已接通；窄样本曾 8/8 | 不能证明跨设备、多人、相似声线、噪声、未知人拒识和真实录制后的改善；用户已观察到录制资料后仍未识别 |
| 整理结果 | schema v2、四模板、版本、引用、待办、长文 Map-Reduce 和 durable task 已实现 | 合成/规则样本多；近期真实任务可达约 92 s；没有大规模盲测的事实精确率、漏项率、引用召回和人工可用性 |
| 会议问答 | 350 条、6 份夹具；检索 110/110 等分组通过 | 最后一次完整集为 347/350，修复后只跑了受影响组；冷请求曾约 90 s、暖请求约 26.6 s；真实 ASR 长会议与开放式多轮不足 |
| 位置解析 | Expo + Android 原生定位竞速、5 分钟缓存、系统反向地理编码、可选 HTTP 地址适配器、坐标兜底 | HTTP 适配器尚未连接真实地址服务；没有真实 ROM/室内外矩阵；拿到坐标但地址为空时仍只能展示经纬度 |
| 处理编排 | 多阶段状态、幂等、恢复、冲突和资产级任务已实现 | 尚缺系统化的阶段中断、磁盘不足、GPU OOM、长离线、重复响应、乱序响应和混合任务公平性测试 |

### 1.3 必须纠正的评测误区

- “pytest 全绿”只证明合同代码没有回归，不证明模型质量。
- “1000 条都没有 hard flag”不等于字段全对；旧诊断大量依赖启发式 review flag。
- 单次平均延迟不能代表交互速度；必须分别测 server compute、队列等待、模型加载和公网 RTT，并报告 p50/p95/p99。
- 只重跑失败类别不能声称完整回归通过；候选发布前必须重跑冻结全集。
- LLM-as-judge 只能做辅助筛查，不能独立裁定事实正确、引用真实或讲话人身份。
- 更换更大模型不是默认答案。规则、状态机、索引、调度、数据质量和结果校验往往比参数量更能改善体验。

### 1.4 本轮升级进度账本

本表是继续开发时的唯一进度入口。`实现存在`、`候选验证`和`生产启用`是三个不同状态；没有列出权威证据的事项一律不得口头升级为“已完成”。

本轮最新切片：SVC-01 已补齐显式范围年份推断、qwen35 cutover 纵向运行和无日期不造日期合同；qwen35 共享 Ollama 客户端同时补齐 `priority`/操作标签参数，避免模型路径因参数不兼容直接返回空结果。SVC-05 已补齐稳定资料 ID 与展示姓名分离的源级、候选回归和隔离 FastAPI/WebSocket smoke，SVC-06 聚焦回归已通过，SVC-09 真实 Qwen 到候选录音 worker/持久化已通过 `13/13`，以及 SVC-03 当前源码的 GPU0 全量并发复核已完成。本轮又完成一次性 28 条真实 WebSocket/VAD context-off 冻结集诊断，并修复候选切段边界标点导致的短文本重复；同时修正评测器的逐字中文数字归一化；随后完成同一冻结集的受控 context-on 对照和两个候选源的目的专用 VAD 策略合同。结果仍保持 `promotion_eligible=false`：9 秒会议切段可作为候选策略保留，但全局词表存在回退，不能默认启用。以上仍为候选证据，详见文末 `svc01-range-year-contract-r2.json`、`svc05-stable-speaker-id-contract-r1.json`、`svc05-stable-speaker-id-asgi-smoke-r1.json`、`svc09-real-qwen-worker-persistence-r1.json`、`svc03-qwen-full-concurrency-r6-current.json`、`svc03-full-candidate-qwen-websocket-quality-r5-max-speech-digit-normalization-current.json`、`svc03-full-candidate-qwen-websocket-quality-context-on-r1.json`、`svc03-qwen-vad-policy-contract-full-candidate-r1.json`、`svc03-qwen-vad-policy-contract-summary-backend-r1.json`、`svc03-qwen-overlap-reconciliation-contract-r2.json` 与 `svc03-quality-normalization-contract-r1.json`，不可视为生产启用。

本轮 SVC-04 内容准入复核先暴露了环境问题而非业务问题：默认 `/tmp` 几乎满载时，合法 WAV/MP4 被存储准入以 `507` 拒绝，旧报告的 `0/10` 不能作为代码失败证据。两个合同 runner 现支持显式 `--tmp-root` 并把实际临时根写入报告；在 `/home/yydd/.cache/laoji-svc04-tmp` 上重跑后，合法 WAV/MP4 均 `200` 且无残片，视频无音轨、损坏容器和截断容器均 `422` 且无残片，内容栅栏为 `10/10`；十种声明格式及 30/300 秒 WAV/MP4 矩阵为 `28/28`。对应证据为 `tools/service-quality-evidence/svc04/svc04-media-content-fence-contract-r5-current.json` 与 `tools/service-quality-evidence/svc04/svc04-format-duration-matrix-r4-current.json`。这些仍是候选合同，不解除 80 小时矩阵、真实 ASR/CER、GPU RTF、生产数据库、多 worker、重启和 soak 门禁。

随后刷新 SVC-03 当前完整候选的无上下文 WebSocket/VAD 冻结集：一次性 GPU0 Qwen3-ASR-0.6B、FastAPI/SQLite loopback 运行 `28/28` 完成，`28/28` 有非空转写且生命周期、缓存、删除、健康回读和 `quality_profile=full` 全通过；无上下文规范化 exact `21/28`、关键术语 `80/84`、CER 均值 `1.259%`、p95 `6.007%`，provider 分段 p95 `527.25 ms`，无协议或 provider 错误。证据为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-r7-current.json`，绑定当前候选文件哈希并在结束时释放 Qwen/ASGI/显存。该结果仍是候选诊断，7 条语义失败、真实多人噪声/声纹、物理真机、OOM、生产多 worker、重启和长期 soak 仍未通过，`promotion_eligible=false` 不变。

表格中 SVC-03 较早的 r5 指标仍保留作历史对照；当前完整 WebSocket/VAD 质量口径以 r7 报告和上段结果为准，不能将受控 context-on 或旧快照覆盖当前无上下文回退结论。

同一当前候选又完成真实 `1/2/4/8` 路 WebSocket 并发阶梯，证据为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-matrix-r4-current.json`。四个档位均为会话完成、非空转写、停止排空、缓存和删除清理通过，队列错误与非队列错误均为 `0`；8 路客户端 p95 `4.482 s`、provider p95 `820.54 ms`。该结果支持保留有界准入和当前候选资源清理，但尾延迟仍高于实时发布目标，且只覆盖同一短音频、GPU0 隔离 Qwen、SQLite/单 ASGI 进程，不能外推生产吞吐、长会话、OOM 或多 worker。

本轮对本机现有监听端口做了只读归属审计：`8001 /health` 明确返回 `RuralBrain Algorithm Service`，`8081 /health` 仅返回通用健康状态，二者均不是老记会议服务；`8030`、`18020`、`18035` 当前没有监听。两个 root 进程已运行超过十天，未读取或修改其配置，也未停止、重启或覆盖它们。因而当前没有可直接承载老记候选的本机生产入口，任何发布结论仍必须绑定隔离候选或经批准的独立部署，不能把这两个端口的 liveness 当作老记 readiness。

为验证自适应档位而非只看 CPU 预览，本轮将 `run_whisper_quality_probe.py` 的设备和计算类型改为显式参数，CPU 默认行为保持不变；在 GPU0 的 CUDA/float16、同一 96 条日程+会议冻结集上，`faster-whisper-small` 完成 `96/96`，规范化 exact `58/96`、CER 均值 `6.423%`、p95 `27.833%`、RTF p50/p95 `0.0509/0.0894`，会议子集 `13/28` exact、日程子集 `45/68` exact；`medium` 完成 `96/96`，exact `44/96`、CER 均值 `10.654%`、p95 `35.780%`、RTF p50/p95 `0.0932/0.1441`，会议子集 `6/28`、日程子集 `38/68`。证据为 `tools/service-quality-evidence/svc03/svc03-whisper-gpu-quality-small-r2-current.json` 与 `tools/service-quality-evidence/svc03/svc03-whisper-gpu-quality-medium-r1-current.json`。当前候选决策：GPU0 预览优先 small，medium 不因显存足够就升档；两档均不具备生产放行资格，仍缺真实手机噪声、端到端字段质量、并发/显存碎片、Qwen 对照和生产部署验证。

进度表中较早的 CPU small/medium 数字保留为 CPU 对照；涉及 GPU 自适应选择时，以本段两份 CUDA 报告为当前口径。

同时修复了 `svc09-r7` 候选的 Whisper 入口漂移：r7 原本的 `app/api/whisper_ws.py` 和 `app/main.py` 会直接读取 `WHISPER_MODEL_SIZE`，预热路径绕过容量选择器，且 r7 缺少 `whisper_resource_profile.py`。已先备份到 `/home/yydd/.codex/tmp/svc09-r7-verify-src/backups/adaptive-whisper-20260802/`，再同步容量选择器、懒加载和预热入口；当前 r7 源码编译和 5 条选择策略测试通过，新增报告 `tools/service-quality-evidence/svc03/svc03-r7-whisper-resource-profile-contract-r1-current.json` 为 `8/8`。这只解除候选源码漂移，不代表 r7 已部署或 Whisper 生产质量通过。

| 服务/切片 | 最高已证实阶段 | 当前证据 | 尚未证实与下一步 |
|---|---|---|---|
| SVC-00 推理调度 | G3 共享 9B 候选诊断；SVC-00B 4B 候选质量拒绝 | 既有五波混合负载基线仍显示问答 p95 33.574 s、模型日程 p95 39.698 s、整理 p95 124.709 s，55 个交互请求有 15 个排队超过 2 s；本轮服务器候选保留槽实测 3 请求全成功，但模型日程/问答 queue_wait 分别约 14.932/16.181 s，均越过 2 s。随后独立 GPU0 `qwen3.5:4b` 32 条日程冻结集仅 `18/32` 通过、14 个 C1 失败，单路 p95 1.557 s；4B 速度可行但质量拒绝。broker、隔离 runner 和资源注册表合同分别 `17/17`、22 请求自测、`20/20` 通过；证据：`tools/service-quality-evidence/svc00/svc00-reserved-slot-real-candidate-r1.json`、`svc00-4b-schedule-quality-r1.json`、`tools/service-mix-runner/runner.py` | 9B 服务器实测仍共用 `21434`，不证明资源隔离；4B 不能替代 9B。仍需独立 9B 容量或明确资源窗口、完整五波真实混合负载、9B 完整质量/冷暖/并发/OOM/恢复 Gate；在此之前不得部署调度候选 |
| SVC-01 日程文本解析 | G1 确定性移动端合同 + 隔离服务端候选合同 + 冻结集安全扫描 | v5 语料 3200 条、1000 组 metamorphic pair 的生成/泄漏/评分器自测通过；移动端 C0/C1 合同 `23/23` 通过；隔离 staging 服务端候选修复显式非法日期截断、解释/假设/取消/提示词注入、不确定地点静默保存和同日范围否定；新增 request-scoped `reference_datetime/timezone`，相对日期、跨午夜、澄清和 DST 缺口/重复时间均使用同一上下文；上下文合同 14/14，服务端边界合同 17/17；冻结 v5 安全相关样本 819 条、违规 0；`event-commands-20260715` 的请求/响应模型和路由上下文透传合同 12/12，日程命令回归 27/27；新增组装检查确认 event API 复用 qwen35 parser，且 event checkout 无解析器副本；当前 qwen35 parser 已修复不支持的“每隔一周/每两周/隔周”规则误保存为一次性事件，以及模型更正语句覆盖最终标题的问题，候选合同 `17/17`、冻结扫描 `3200/3200`（819 条安全相关、0 违规）（证据：`tools/schedule-quality-v3/svc01-local-parser-contract-r6.json`、`tools/schedule-quality-v3/svc01-local-parser-frozen-scan-r6.json`、`tools/schedule-quality-v3/svc01-server-candidate-contract-r3.json`、`tools/schedule-quality-v3/svc01-server-candidate-frozen-safety-r3.json`、`tools/schedule-quality-v3/schedule-context-router-contract-r1.json`、`tools/schedule-quality-v3/event-commands-assembly-contract-r1.json`） | staging 候选未部署、未接真实模型；event-commands 仍缺完整 parser/runtime/auth 依赖，组装检查不等于独立部署或 HTTP 运行；仍非正式模型盲测，v5 主要为合成数据，尚缺真实匿名输入、独立 holdout 服务运行、完整字段 exact、置信校准和混合负载延迟 |
| SVC-02 日程短语音 | G1 客户端 + 隔离服务端输入/文本边界合同 + 真实 CPU 预览质量基线 | `src/services/api.ts` 已在 HTTP 前拒绝空音频、空 ASR 文本和不完整解析响应，并在路由不可用时有限降级到同一音频的转写→文本解析；错误上下文已统一为中文；语音解析请求已透传 `reference_datetime/timezone`；staging 服务端增加严格 base64/data URI/大小边界；qwen35/qwen-asr-default 两套候选对缺失、空值、对象、数组、数字和非对象 ASR 返回统一 fail-closed，服务端文本边界合同 `20/20`，音频输入一致性合同 `26/26`（每套 `13/13`），两套源码 `py_compile` 通过；代理和本地路径均先解码并复用 canonical Base64/字节；当前证据绑定 qwen35 `f8bf11e3309f70e14245f927ec264e550841802a7fb6060cb0d72e11f3be0458` 与 qwen-asr-default `d9b800b277171e566c5956434b17f48105f9be9890d3898f0ce60258d1665d4b`；真实 `faster-whisper-small/int8` 在 68 条冻结日程语音上完成 `68/68`，规范化 exact `43/68`、CER mean `7.85%`、p95 `30%`；新增移动端短音频两条 JSON 路径的响应体独立 5 秒截止，避免代理返回响应头后卡住页面，响应体合同 `4/4`，且与既有客户端边界 `7/7`、有限降级 `8/8`、服务端音频一致性 `26/26` 同步通过；证据：`tools/service-quality-evidence/svc02/svc02-audio-boundary-contract-r1.json`、`tools/service-quality-evidence/svc02/svc02-audio-boundary-contract-r2.json`、`tools/service-quality-evidence/svc02/svc02-audio-response-body-contract-r1.json`、`tools/service-quality-evidence/svc02/svc02-parse-audio-fallback-contract-r1.json`、`tools/service-quality-evidence/svc02/svc02-server-asr-text-boundary-contract-r1.json`、`tools/service-quality-evidence/svc02/svc02-server-audio-consistency-contract-r1.json`、`tools/schedule-quality-v3/svc02-server-audio-boundary-contract-r1.json`、`tools/service-quality-evidence/svc03/svc03-whisper-cpu-quality-schedule-r1.json`；当前 Preview `versionCode=106` APK 已重建，SHA-256 `9c089e75f4fd53e7feff1446c502a3466b30337b56df4fa9b83594695a8bba5d` | CPU 结果只属于预览诊断，未达到日程字段质量放行；两套 staging 服务端未部署；qwen35 完整 pytest 缺 `meetingsummary.ollama_client`、默认候选代理测试缺 `httpx`；响应体截止只证明客户端不会无限等待，不证明真实手机录音、说话人、噪声、编码和关键日期/否定槽位语料，以及服务端路由和端到端质量/速度证据 |
| SVC-03 实时转写 | G2 隔离真实 Qwen/ASGI 候选；9 秒会议 VAD 为候选策略，词表默认仍 fail-closed，生产质量与部署未通过 | 历史基线 `svc03-semantic-debt-56-r3.json` 原始 37/56；context r4 曾出现 18 条原通过样本回退，故不推广。当前 qwen3-asr-test 的 WebSocket→上下文→推理静态组装、请求微批、取消/排空和结果边界候选合同已更新为 `27/27`，源码语法 `12/12`，补丁结构检查通过（证据：`svc03-context-assembly-contract-r2.json`、`svc03-isolated-contract-r4.json`）。真实 GPU0 Qwen3-ASR-0.6B 56 请求无错误，串行 `17.918 s`、2 路 `16.328 s`、4 路 `6.963 s`，规范化语义与串行 `100%` 一致；真实 HTTP 4 路 `4/4`，timing 字段透传且 SIGTERM 排空通过（证据：`svc03-qwen-microbatch-real-benchmark-r1.json`、`svc03-qwen-microbatch-http-smoke-r1.json`）。Silero VAD 与 CAM++ 中文权重已放入隔离 staging，Torch `2.2.2+cu121` 配套 `torchaudio 2.2.2+cu121`，实际完成一次 VAD 分段和 192 维 CAM++ embedding 前向，`required_models_ready=true`（证据：`svc03-support-models-real-smoke-r2.json`、`svc03-asgi-dependency-provenance-r2.json`）。启动预热开启的完整 FastAPI/SQLite/Qwen WebSocket smoke r8 通过游客创建、真实 PCM、缓存和删除，首个 `/api/ready=200`，`config → stop_acknowledged → transcript.completed×2 → ready_to_stop` 均通过；config 明确 `readiness=ready`、`quality_profile=full`、VAD 和声纹能力均为真（证据：`svc03-qwen-asgi-real-smoke-r8.json`、`svc03-real-model-stop-realtime-r3.json`、`svc03-authenticated-runtime-r1.json`、`svc03-authz-isolation-runtime-r1.json`）。关闭启动预热的对照明确记录首个 readiness `503`，首个 WebSocket 触发支持模型加载后才恢复 `200`，因此部署必须使用预热模式（证据：`svc03-qwen-asr-lazy-readiness-r1.json`）。同一端口运行时合同另证明默认开关关闭时首事件为 `support_models_not_ready`、关闭码 1013，不发送 config；显式预览才允许降级并标注 `degraded_preview`（证据：`svc03-degraded-readiness-contract-r1.json`、`svc03-degraded-readiness-runtime-r1.json`）。模型管理器现在把 CAM++ 特征运行时探针纳入 readiness，权重/依赖半初始化不会假绿；CAM++ 失败时清理对象合同仍通过（证据：`svc03-model-manager-readiness-contract-r2.json`）。Whisper-small/medium CPU 对照仍只作 preview，small `10/28` exact、CER mean `9.61%`，medium `7/28`、`16.41%`，medium 不升档。最新目的专用 VAD 合同在 full candidate 和 summary backend 均 `2/2`：meeting `max_speech_ms=9000`，schedule `max_speech_ms=6000`，其余阈值一致。相同 28 条冻结集的 context-off r5 为 `21/28` exact、CER mean `1.26%`、p95 `6.01%`、关键术语 `80/84=95.24%`、provider 尾延迟 p95 `413.9 ms`；显式全局词表 context-on 为 `25/28` exact、CER mean `0.39%`、p95 `3.53%`、关键术语 `82/84=97.62%`、provider 尾延迟 p95 `317.25 ms`，但 M018/M022 从原本正确回退，M017 仍未解决。因此词表只证明受控诊断收益，不能作为全局默认配置。证据：`svc03-qwen-vad-policy-contract-full-candidate-r1.json`、`svc03-qwen-vad-policy-contract-summary-backend-r1.json`、`svc03-full-candidate-qwen-websocket-quality-r5-max-speech-digit-normalization-current.json`、`svc03-full-candidate-qwen-websocket-quality-context-on-r1.json` | 微批默认 `QWEN_ASR_REQUEST_BATCH_SIZE=1` 且未部署；不得把当前隔离 smoke、CPU preview、受控词表结果或降级 ASGI 当生产 ready。仍需 context=off/on 独立 holdout 零 C1 回退（词表应按会议/用户上下文受控注入而非全局静态词表）、真实多人/噪声/注册声纹 DER/JER 与 FAR/FRR、物理真机录音、OOM、soak、生产部署以及 systemd/服务器重启后的完整服务恢复；还需真实 Qwen candidate 的 p95/队列/切段尾延迟门槛。候选端到端 stop/取消已通过，但不能外推为生产恢复。`18020/api/health` 和 Qwen `/health` 任一单独接口都不能证明完整录音就绪。
| SVC-04 离线音视频转写 | G1 post-audit CPU 候选；真实 GPU provider 未通过 | SVC-04A 使会议网关路径不再为计算时长整段物化 PCM；默认关闭的 v2 候选提供 10 分钟 core/15 秒 overlap、稳定块 ID、块 checkpoint、进程 kill 恢复、结果 checksum 和单进程推理串行；实际 Whisper checkpoint SHA/device/dtype 身份覆盖层已加入。47/47 gateway 合并回归、51 条 summary 合同、SVC-04A 工具回归 35 条通过；完整音视频和分块路径新增结构化 `text`、非法时间戳和非法总时长 fail-closed 边界合同 `11/11`；带视频轨和 AAC 音轨的临时 MP4 已通过容器→ffprobe→有界 WAV 切分 smoke `4/4`；候选内容准入在显式临时根上通过 `10/10`，候选格式/时长矩阵通过 `28/28`（证据：`tools/service-quality-evidence/svc04/svc04-transcript-text-boundary-contract-r1.json`、`tools/service-quality-evidence/svc04/svc04-video-container-smoke-r1.json`、`tools/service-quality-evidence/svc04/svc04-media-content-fence-contract-r5-current.json`、`tools/service-quality-evidence/svc04/svc04-format-duration-matrix-r4-current.json`）。r2 容量窗口在启动前有 9989 MiB，但 large-v3 加载到约 9.72 GiB 后仍以仅余 27.25 MiB OOM；旧 `/health=OK` 和 PID/cgroup/监听身份因此被证明是假绿，候选 unit 已单次 verified stop，生产目录未改动 | 控制器现要求启动前至少 12288 MiB、加载后至少保留 2048 MiB，并在上传前通过带临时凭据的 `provider-readiness`，精确核验 `runtime_model_ready`、model revision 和 runtime fingerprint。修复后同一 9989 MiB 现场被 preflight 明确拒绝且未启动 GPU。仍未证明真实 provider smoke、CER、边界消歧、GPU RTF、80 小时矩阵、重启和 soak。不得停止或卸载共享 21434/其他 GPU 服务，分块开关不得在生产开启 |
| SVC-05 讲话人闭环 | G2 身份候选 + 资料修订/旧会议重匹配纵向 | 实时身份映射现在要求当前片段同时满足有效音频质量、cosine/gap 门禁；低置信片段不会继承历史 cluster 投票；单一登记资料不再使用“第二名为 0”制造虚假 gap，而是要求更高的绝对分数和两个独立合格片段共识；qwen3-asr-test 的 AST/行为合同 `13/13`，qwen-asr-default 与 qwen3-asr-test 已同步候选逻辑；隔离候选真实 Python/SQLite 的归属、迁移、同意和异声拒绝运行合同 `7/7`。真实 GPU0 CAM++/Silero 支持模型对 28 条、3 个 TTS 声音完成 192 维诊断：同声 `117` 对 mean `0.910639`、min `0.853976`；异声 `261` 对 mean `0.424884`、max `0.632046`，旧绝对阈值 `0.5` 的异声误接受 `57/261=21.839%`；两条注册样本、22 条留出样本分类 `100%`，固定噪声 20/10/0 dB 下 clean/noisy 接受率均为 `100%`。新增无泄漏闭集诊断：三折留一音色 unknown、每个已登记音色两条 clean enrollment，`168` 个 embedding；候选 `0.70/0.08` 下 clean `44/44` 正确、unknown `0/28` 误接受，20/10/0 dB FRR 分别 `4.55%/0%/68.18%`，`1.2/0.8 s` 片段 FRR `4.55%/50%`，证据：`tools/service-quality-evidence/svc05/svc05-camplus-closed-set-eval-r1.json`。新增候选 `meeting_speaker_service` 纵向使用真实 ffmpeg/SQLite/任务状态：3 场旧会议全部计入进度，人工锁定片段 `2` 个均跳过，匹配结果只写入未锁定片段；同一幂等键重放返回原任务 `200`；资料修订先 fail-closed 后重试刷新 `profile_revision`；撤销发生在模型处理期间不会提交旧归属；模型不可用可重试恢复；Transcript 正文与时间轴保持不变。证据：`tools/service-quality-evidence/svc05/svc05-speaker-reprocess-runtime-r1.json`。既有接线/合同证据：`tools/service-quality-evidence/svc05/svc05-speaker-identity-contract-r3.json`、`tools/service-quality-evidence/svc05/svc05-speaker-runtime-contract-r2.json`、`tools/service-quality-evidence/svc03/svc03-camplus-speaker-noise-diagnostic-r1.json`、`tools/service-quality-evidence/svc03/svc03-qwen-ws-candidate-runtime-r1.json` | TTS 和本轮确定性提取器只证明接线、状态和拒识策略方向，不能替代真人质量 Gate；本轮 DER/JER 明确未运行，仍需真人、多说话人、相似声线、跨设备/跨天、真实 unknown cohort、DER/JER、FAR/FRR、Android 真握手和生产部署。重匹配候选仍是单进程 SQLite 运行，未证明 PostgreSQL 锁、多 worker 竞态、正式声纹共享存储/备份迁移或服务端完整 ASGI；候选未发布，`promotion_eligible=false`，阈值仍需真实 cohort 校准 |
| SVC-06 结构化整理 | G1 脚手架 + 合同回归 + 隔离结果边界候选 | 160 条 synthetic/dev、1020 个 fact unit 的评分脚手架；真实模型 3 条合成烟测通过；结构合同回归覆盖明确待办、纯讨论、待办更正、引用篡改和失败任务拒绝；staging 紧凑整理结果增加原文支持门禁，扩展到 `6/6` 边界合同通过：无法由转写支持、明确否定或取消的待办不会进入结果，后续重新确认的正向待办仍可保留；服务端与客户端新增模型 JSON 外壳边界归一化，`12/12` focused cases 通过，未知对象和损坏 JSON fail-closed，旧接口也不再暴露 `raw_json`（证据：`tools/service-quality-evidence/svc06/svc06-structured-summary-contract-r1.json`、`tools/schedule-quality-v3/svc06-server-summary-boundary-contract-r1.json`、`tools/service-quality-evidence/svc06/svc06-summary-text-boundary-r1.json`） | staging 候选未部署；未完成正式质量 Gate、长会事实图、引用 precision/recall 和并发速度验证；真实烟测目标报告的 `/api/health` 为 `models_ready=false`，不能外推为模型或生产完成 |
| SVC-07 会议问答 | G3 9B 质量候选已通过；候选运行合同补齐；性能候选未收口 | `qwen3.5:9b` r24 原始 1911 条全通过；使用当前严格 v3 评测器离线重评分仍为 `1911 PASS / 0 FAIL`，覆盖 1911 个唯一 case，响应无 verdict/text 变化。严格证据见 `tools/service-quality-evidence/svc07/svc07-question-endpoint-v3-9b-1911-r24-strict-r1.json`，当前 evaluator SHA-256 为 `e9613d0172f25839ea4fa36892362d6090182c589cc653308216be106b2a939b`；旧 4B 完整报告严格重评分为 `1787/1908`，保留 121 条真实失败。r25 workers=4 并发样本质量通过但延迟门槛失败。登录接口新增服务端文字记录版本/片段正文与时间校验、整理结果和我的笔记归属校验、历史问答线程逐轮校验、模型引用白名单；源级合同 `7/7` 通过，证据为 `tools/service-quality-evidence/svc07/svc07-question-boundary-contract-r1.json`。问答模型、embedding 和 single-flight 等待者现在共享每轮截止时间，默认为 30 秒并将剩余预算透传到每次模型、恢复和语义检索请求，超时 fail-closed；源级合同 `6/6` 通过，证据为 `tools/service-quality-evidence/svc07/svc07-question-deadline-contract-r1.json`；隔离速度/检索合同 `42 + 56` 全部通过，证据为 `tools/service-quality-evidence/svc07/svc07-question-speed-candidate-r2.json`；远端隔离候选真实解释器/依赖下问答速度、检索、混合检索 `73/73`，会议上下文与 WebSocket 授权 `9/9`，合计 `82/82`，证据为 `tools/service-quality-evidence/svc07/svc07-candidate-runtime-contract-r1.json` | 尚未有独立 GPU/9B 实例上的 workers 1/2/4/8 性能 Gate、冷启动/逐出/混合负载和 90 秒问题收口；上述 `82/82` 是一次性 SQLite 和候选运行合同，不代表生产 PostgreSQL 数据、ASGI 进程、真实 Ollama 模型延迟或资源隔离；共享 21434 只作信息性性能证据，候选 28120/28121 与 21434 共用模型，不能据此证明资源隔离 |
| SVC-08 位置解析 | G2 模拟器纵向与隔离代理候选 | SVC-08A 已保留 provider/精度/年龄/时间戳/粒度/置信等级，增加 single-flight、晚到抑制、geocoder adapter 和可取消 request ID；修复原生模块同步异常降级、重复 request ID 和读取缓存期间的取消竞态；本轮增加一次性 Expo current-position provider，避免部分 ROM 只返回一次性 fix、不触发 watch 回调；权限 API 异常统一转为中文 `CurrentAddressError`；新增可选 HTTP reverse-geocoder adapter（主动点击才请求、5 秒总请求/响应体 deadline、响应上限、无凭据 URL、坐标/精度/时间戳 POST、兼容自定义 `address_parts`、嵌套 `display_name/address` 和 `result.addressComponent`、失败坐标兜底），且显式配置的 HTTP provider 优先于系统粗粒度结果；代理候选新增同坐标单飞、不同坐标并行、上游起始限速和 `/ready` fail-closed；`369/369` provider matrix、`24/24` 取消/一次性 provider 静态合同、`12/12` HTTP adapter 合同、代理 `8/8`、TypeScript 与 `:laoji-native-platform:compileReleaseKotlin` 均通过；包含 SVC-07 客户端预算修复的当前源码 Preview `versionCode=106` 在 `emulator-5560` API 30 上重新完成日历→新建日程→获取当前位置，GPS last-known fix 和坐标兜底均成功，UI 显示 `22.543095, 114.057865`，系统反向地理编码仍未返回可读地址且未配置 HTTP provider（证据：`tools/service-quality-evidence/svc08/svc08-location-provider-policy-r3.json`、`tools/service-quality-evidence/svc08/svc08-native-cancellation-contract-r4.json`、`tools/service-quality-evidence/svc08/svc08-reverse-geocoder-contract-r2.json`、`tools/service-quality-evidence/svc08/svc08-emulator-location-evidence-r3.json`、`tools/service-quality-evidence/svc08/svc08-proxy-runtime-candidate-r1.json`） | 仍未证明地址提供器成功率、Expo/native 底层物理取消、3 类真实 ROM 室内外采样、真机速度与地址成功率；模拟器坐标兜底不能替代真实地址解析；当前公共 Nominatim 探针被出口策略/提供方 403 阻断；尚未接入获批或自托管地址服务、生产网关和回滚；不得标记为 SVC-08 完成 |
| SVC-09A 转写任务租约 | G2 隔离部署演练通过，不可部署 | r7 修复“失败任务显式重试仍复用旧网关任务”：租约接管保持 generation，显式重试递增 generation。50 条 summary/SQLite 聚焦合同、11 条 gateway 合同通过；11 步 CPU-only 演练通过 SQLite 备份/迁移/回滚、PostgreSQL 次级兼容、旧 12 位任务恢复与新旧 worker 不混跑 | 两侧均未部署；真实 HTTP gateway、长 ASR、服务器重启、GPU 压力和 soak 未完成；网关仍为单机单进程身份库 |
| SVC-09 其余编排 | G2 CPU 故障注入候选，不可部署 | r8 已覆盖 ACK fencing、多资产部分失败、删除/恢复交错、FIFO/恢复公平性、ENOSPC、只读目录、结果重建和真实 Uvicorn SIGTERM。r9 新增跨进程 admission sentinel，创建/重试返回中文 503，submit/claim/recovery 均受控，`/api/ready` 在停接时返回 503；58 条通过、3 条仅 PostgreSQL 跳过，cooperative/timeout 两类真 Uvicorn 演练均无竞态 claim。r10 又修复资产登记/媒体片段并发唯一冲突暴露 500、媒体片段重复 worker 领取、过期 worker 覆盖新结果及共享输出文件竞态；媒体片段创建、重试、恢复、提交和 worker 二次检查 admission，静态合同 `6/6`。r11 补齐媒体片段重试的 `Idempotency-Key` 透传、源资产锁、操作表持久化、同键重放和 `IntegrityError` 后胜者重放；源级合同 `10/10`。随后在合并当前候选源码与完整验证骨架的隔离运行树中通过真实 SQLite/aiosqlite 媒体片段回归 `9/9`、完整录音/转写租约/恢复回归 `45/45`，并在一次性 PostgreSQL 16 loopback 容器中通过媒体片段重试并发回归 `1/1`；本轮又以同一 r7 源码在一次性 PostgreSQL 16 loopback 上完成 stale recovery `9/9`，覆盖同键重放、跨任务复用冲突、并发重试只推进一次 revision、上传/租约/恢复/迟到 worker 和过期媒体 attempt 文件清理（证据：`tools/service-quality-evidence/svc09/uvicorn-sigterm-admission-r9.json`、`tools/service-quality-evidence/svc09/media-clip-atomicity-r10.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-admission-contract-r1.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-retry-idempotency-contract-r1.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-retry-runtime-r1.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-retry-postgresql-r1.json`、`tools/service-quality-evidence/svc09/svc09-transcription-atomicity-runtime-r11.json`、`tools/service-quality-evidence/svc09/svc09-transcription-postgresql-spawn-r2.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-ffmpeg-runtime-r1.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-ffmpeg-runtime-postgresql-r1.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-stale-recovery-runtime-r1.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-stale-recovery-postgresql-r1.json`） | 已覆盖一次性 loopback PostgreSQL 的真实多进程租约竞争，以及合成 45 秒媒体的真实 ffmpeg 导出/清理和 stale recovery；仍未跑生产 PostgreSQL 配置、完整生产 ASGI 应用、真实长视频/转写、生产 systemd 停机流程或 2 小时 soak；新门禁、租约和网关侧候选均未部署 |
| SVC-10 跨会议检索 | G2 SQLite 规模与隔离候选 + 真实 embedding 诊断 + 本机搜索页接入 | 现有 SQLite FTS 已按 scope/lifecycle 过滤并保留来源类型、来源 ID 和时间位置；generation fence 源级合同 `12/12` 通过；隔离数据库完成 10000 场、20000 条索引行和 1500 次查询：exact Recall@10 `1005/1005`（100%）、跨作用域/已删除负向泄漏 `0`、query p50/p95/p99 `6.3865/6.7785/7.2779 ms`、提交后新 revision 可见，SQLite 构建 `0.1467 s`；服务器真实 `laoji-meeting-embedding:0.6b` 对 20 条合成事实/改写问题 `Recall@1=20/20`、`Recall@3=20/20`，1024 维单批 40 项约 `5.37 s`；会议搜索页现在优先读取本机全文索引并显示来源/摘要，索引异常回退标题与元数据（证据：`tools/service-quality-evidence/svc10/svc10-search-index-generation-contract-r1.json`、`tools/service-quality-evidence/svc10/svc10-search-scale-benchmark-r1.json`、`tools/service-quality-evidence/svc10/svc10-semantic-embedding-probe-r1.json`） | 所有结果仍为候选诊断，`promotion_eligible=false`；真实 app 数据库查询、真实匿名会议 semantic Recall@10/NDCG、人物/日期/标签过滤、索引重建期间 fallback 的实机行为、跨设备/生产和真实 freshness p95 仍未验证 |

SVC-04 本轮增量：canonical 新建导入会议现在在本机投影确认后，与“向已有会议追加录音”共用 `requestImportedMeetingTranscriptDiscovery`；账号作用域会请求 `discoverRecordingAssets=true`，访客作用域明确不触发云端转写。上传完成后的既有收敛路径保持发现信号；远端录音资产发现使用稳定 task/client request/idempotency identity，重复发现由 SQLite 以远端资产或任务 ID 幂等跳过。导入触发合同 `9/9`、视频轨+AAC 音轨容器 smoke `4/4`、TypeScript 编译通过。证据：`tools/service-quality-evidence/svc04/svc04-import-transcript-trigger-contract-r1.json`、`tools/service-quality-evidence/svc04/svc04-video-container-smoke-r1.json`。这修复了“文件已导入但没有启动转写发现”的客户端接线缺陷，不代表真实上传、ASR 质量、GPU RTF 或生产部署已完成。

SVC-01 本轮增量（2026-07-31，覆盖表格中的移动端 r1 计数和证据）：移动端解析器合同由 `7/7` 扩展为 `10/10`，修复“工作日更正句后紧接小时”的 token 边界、时间范围误判为日期范围、最终说法标题保留、`下午茶三点` 的下午语境，以及 `下个月底/下个月末` 被误解析为本月月底。3200 条冻结扫描仍为 `0` 个 C0/C1 静默保存风险，路由计数未变化；TypeScript 编译和 `git diff --check` 通过。证据：`tools/schedule-quality-v3/svc01-local-parser-contract-r2.json`、`tools/schedule-quality-v3/svc01-local-parser-frozen-scan-r2.json`。这仍只证明移动端确定性边界，不代表远端模型质量、真实用户质量或生产部署完成。

SVC-01 上下文测试重写：旧私有 parser 套件的 `50` 个测试函数和 `8` 个参数化样本（共 `58` 个单元）不再用 `date.today()` monkeypatch 冒充请求时钟；新增 `tools/service-quality-evidence/svc01/run_schedule_context_holdout.py`，将相对日期、跨午夜、DST/范围、更正、澄清和模型归一化统一绑定 `reference_datetime/timezone`。隔离 qwen35 parser 的确定性 holdout 展开为 `65/65` checks，通过最终更正标题、`开发票` 词汇保留、日期范围和地点不确定性等边界；证据为 `tools/service-quality-evidence/svc01/svc01-schedule-context-holdout-r1.json`。该报告使用 stubbed Ollama，只证明上下文和确定性合同，仍不证明真实模型质量、GPU/队列性能、HTTP 部署或真机行为。

同一修复已同步到隔离 staging 的 qwen35 parser：服务端候选合同扩展到 `17/17`，覆盖模型结果归一化的最终更正槽位、下午茶语境和下月月底，并重跑 `3200/3200` 冻结安全扫描、`819` 条安全相关样本零违规；候选仍是 `model_quality_status=not_evaluated_stubbed_llm`，未部署、未接真实模型。证据：`tools/schedule-quality-v3/svc01-server-candidate-contract-r3.json`、`tools/schedule-quality-v3/svc01-server-candidate-frozen-safety-r3.json`。

SVC-02 本轮增量：移动端短音频现在在发起 HTTP 前校验 Base64 标准字母表、补位和长度，拒绝缺少 `;base64,` 的 data URI，并按服务端同一 `25 MB` 上限估算解码后大小；异常文件名编码也回退到安全文件名。静态客户端边界合同 `7/7`、TypeScript 编译通过。证据：`tools/service-quality-evidence/svc02/svc02-audio-boundary-contract-r2.json`。这仍不代表真实手机录音、ASR 质量、编码矩阵或端到端延迟完成。

SVC-02 本轮增量：文件录音调用 `parse-audio` 遇到明确的路由不可用（404/405/501/502/503）或网络不可达时，最多降级一次到同一 Base64 的 `asr/transcribe → parseText`，复用实时语音使用的文本解析器和 `reference_datetime/timezone`；超时、取消、语义 4xx 和空/非法结果不自动重试，避免重复 ASR、重复计费或把失败结果保存为日程。静态降级契约 `8/8`、Base64 边界 `7/7`、TypeScript 编译通过。证据：`tools/service-quality-evidence/svc02/svc02-parse-audio-fallback-contract-r1.json`、`tools/service-quality-evidence/svc02/svc02-audio-boundary-contract-r2.json`。这只证明客户端故障边界和接线，不证明两个服务端链路在真实音频上的质量等价、真实手机行为或生产延迟。

SVC-02 响应体边界增量：短音频的 `/asr/transcribe` 与 `/parse-audio` 路径均通过共享 `readJsonWithTimeout` 在响应头返回后再给 JSON body 5 秒截止；直接 `response.json()` 不再让代理半响应无限占用页面。合同 `4/4`，并与客户端音频边界 `7/7`、有限降级 `8/8`、服务端音频一致性 `26/26`、TypeScript 编译、`git diff --check` 一并通过。证据：`tools/service-quality-evidence/svc02/svc02-audio-response-body-contract-r1.json`。这只是 app-owned 响应边界，不证明真实 ASR/provider、真机或生产性能。

共性 HTTP 错误响应边界增量：`readResponseData` 的文本和 JSON 错误体统一通过共享 body deadline（默认 10 秒），停滞代理不会阻塞同步、回收站、问答等页面的错误展示；正常文本/JSON 解析行为保持不变。合同 `3/3`，证据：`tools/service-quality-evidence/common/error-response-body-contract-r1.json`。这只证明客户端错误呈现会收敛，不证明服务端已恢复或生产链路可用。

共性 HTTP 成功响应体边界增量：会议、日程、讲话人和能力接口不再直接调用 `Response.json()`，统一在拿到响应头后使用 10 秒 body deadline；日程解析/澄清仍使用 5 秒小响应截止，转写分页和可取消的会议请求继续透传外部取消信号；body 超时或取消时主动取消可用的 `ReadableStream`，释放底层响应资源。源级合同 `9/9`，问答响应体合同同时覆盖超时/取消后的 body cancel，证据：`tools/service-quality-evidence/common/api-body-deadline-contract-r1.json`、`tools/service-quality-evidence/svc07/svc07-question-response-body-contract-r1.json`。这只证明客户端不会因成功响应体停滞而无限等待，不证明代理、服务端或真机网络已通过。

本轮共性边界修复后的 Preview `versionCode=106` 已再次重建，最新 APK SHA-256 为 `1ca4f7d12b6f21814e9423a01e7397ec5221a2cf3c6614861b7599783c87f142`；表格中较早的 Preview 哈希仅作为历史证据，不代表当前产物。

SVC-02 音频 body 合同刷新：远程 URI 的 `Response.blob()` 也纳入共享 5 秒 body deadline，短音频 JSON 与二进制响应合同现为 `6/6`；真实手机、编码矩阵和 provider 质量边界仍未改变。证据：`tools/service-quality-evidence/svc02/svc02-audio-response-body-contract-r1.json`。

上述 blob 与错误响应体修复后的 Preview `versionCode=106` 已重建，最新 APK SHA-256 为 `4d9184ef7e6962409754544952439802548d135aebbde58e57139f1b33b478d6`，bundle SHA-256 为 `97062672ec00ff06aadf9ca342f4cd6bc4caab7ceb42ed3074873a73e1e53964`。

SVC-01/SVC-02 本轮增量：移动端日程解析入口新增保守繁体字形归一化（只做明确的一对一字形替换，原始转写不改写），使 Whisper 返回的“下週一上午十點週會”等文本仍能进入既有日期/时间规则；新增合同 `14/14`，3200 条冻结安全扫描仍为 `0` 个 C0/C1 静默保存风险，TypeScript 检查通过。证据：`tools/schedule-quality-v3/svc01-local-parser-contract-r4.json`、`tools/schedule-quality-v3/svc01-local-parser-frozen-scan-r4.json`。

同一候选把 68 条真实 `faster-whisper-small` 日程输出接到当前移动端解析器：字段命中 `148/153`（96.73%），有字段样本中完整匹配 `61/66`（92.42%），新增映射修复了“兩点”时间和“參加培訓/預算報告”分类；针对标题只剩“提前/提醒”等低信息结果新增安全路由，桥接中的 `local_safe` 从 58 条降为 56 条，转入服务端处理的结果从 4 条增为 6 条。剩余字段错误来自模型漏词、同音替换或分类口径差异。证据：`tools/service-quality-evidence/svc02/run_whisper_schedule_parser_bridge.js`、`tools/service-quality-evidence/svc02/svc02-whisper-schedule-parser-bridge-r3.json`。这仍低于日程字段放行门槛，不能启用 CPU Whisper fallback 作为默认解析器。

SVC-01/SVC-02 本轮窄修复：移动端解析器合同刷新为 `23/23`，3200 条 v5 冻结扫描仍为 `0` 个 C0/C1 静默保存风险；直接本地安全样本的日期、时间、重复和提醒关键字段保持 `1214/1214` exact。修复了时间限定“之前，”残留在标题前导致“还信用卡”被截成“之前”的确定性错误，并收紧上下文编辑正则，避免普通“在截止时间之前……”被误判为修改旧日程；同时对冻结 ASR 中高风险的“还新用卡”只保留原文并强制 `server_required`，不做全局同音替换。68 条 CPU ASR 桥接字段指标保持 `148/153`、`61/66`，但 `local_safe=56`、`server_required=6` 的路由结果已刷新；“喝水”归入“健康”是当前分类词典策略，不以该单条标注差异冒充 ASR 修复。证据：`tools/schedule-quality-v3/svc01-local-parser-contract-r6.json`、`tools/schedule-quality-v3/svc01-local-parser-frozen-scan-r6.json`、`tools/service-quality-evidence/svc02/svc02-whisper-schedule-parser-bridge-r4.json`。候选仍 `promotion_eligible=false`：没有提升 CPU 模型的同音/漏词能力，也没有证明真实手机录音、服务端模型质量、端到端延迟或生产部署。

SVC-02 本轮服务端边界增量：qwen35 与 qwen-asr-default 两套隔离日程解析候选新增 `_schedule_asr_text()`，入口、共享 ASR 代理和本地 Qwen 路径只接受字典中的非空字符串 `text`；缺失、空值、对象、数组、数字和非对象响应统一 fail-closed，不再用 `str(...)` 把结构化错误伪装成语音文本。两套源码均通过 `py_compile`，服务端边界合同 `20/20`（每套 `10/10`）；备份位于 `tools/service-quality-evidence/svc02/source-backups/`，证据：`tools/service-quality-evidence/svc02/svc02-server-asr-text-boundary-contract-r1.json`。qwen35 完整 pytest 仍受候选目录缺失 `meetingsummary.ollama_client` 阻断，qwen-asr-default 代理测试仍受环境缺少 `httpx` 阻断；这不改变合同结果，也不等于真实 ASR/路由/手机或生产质量通过。两套候选均未部署，`production_enabled=false`。

SVC-01 本轮时区与关键槽位收口：移动端解析、路由和结果归一化现在透传请求级 IANA `timezone`，用时区墙上时间计算相对日期/分钟，旧调用和非法时区仍回退到原有行为；音频直连解析也复用同一上下文。冻结语料暴露的 `傍晚`、有限“每天”范围、月/年重复事件滚动等确定性错误一并修复。合同扩展为 `20/20`；v5 全量 `3200` 条路由计数保持 `local_safe=1368/server_required=953/clarify=232/reject=647`，静默保存风险为 `0`，排除多轮上下文后 `1214/1214` 个直接本地安全样本的日期、时间、重复和提醒关键字段 exact，C0/C1 关键字段不匹配为 `0`。字段级报告仍保留非关键标题、地点和分类差异，作为后续语义质量项，不能解读为远端模型或全字段发布门禁已通过。证据：`tools/schedule-quality-v3/svc01-local-parser-contract-r5.json`、`tools/schedule-quality-v3/svc01-local-parser-frozen-scan-r5.json`、`tools/service-quality-evidence/svc01/svc01-mobile-timezone-wiring-contract-r1.json`。

SVC-02 本轮再次收口服务端音频输入一致性：qwen35 与 qwen-asr-default 都在代理和本地路径前先执行严格 Base64/data URI/25 MB 解码门禁，data URI 必须显式包含 `;base64`，规范化后的 bytes 用于本地解码并以 canonical Base64 发送代理；双候选合同 `26/26`（每套 `13/13`），证据：`tools/service-quality-evidence/svc02/svc02-server-audio-consistency-contract-r1.json`。该修复只解决输入边界不一致，不提升 CPU Whisper 质量基线，也不证明服务端路由、真实手机或生产 readiness。

候选运行依赖收口（历史 r1）：补齐 qwen35 日程候选缺失的 `meetingsummary` 配置、JSON 解析和 Ollama 客户端源文件后，目标解释器下 `58` 条 qwen35 日程服务测试通过；当时 qwen-asr 与 SVC-07 使用的是不完整 staging 切片，分别因缺少共享 `app.api.whisper_ws`、`app.service_telemetry` 等组件阻断。历史结果保留在 `tools/service-quality-evidence/svc02/svc02-svc07-local-candidate-runtime-r1.json`，不再作为当前源码状态；这只说明旧切片不可运行，不等于 ASR/问答真实模型质量、生产 ASGI、PostgreSQL 或部署完成。

候选运行入口已改为按同一完整源码根目录进行 attestation，不再把旧 staging 的零散文件拼接为伪完整服务：qwen-asr 使用 `/home/yydd/.codex/tmp/svc09-r6-verify-src`，SVC-07 使用 `/home/yydd/.codex/tmp/svc07-r9-verify-src`，两者所需的 WebSocket、遥测、问答、检索和测试文件均在各自根目录内。固定临时解释器的 NumPy ABI 后，qwen35 日程 `58/58`、qwen-asr 日程代理 `4/4`、当前问答契约 `2/2`；SVC-07 历史速度测试 `20/21`，唯一差异是旧测试要求独立“你好”调用模型，而当前实现明确走中文确定性问候短路。该差异已由 `tools/service-quality-evidence/svc07/test_question_current_contract.py` 固定为当前契约，并在报告中保留旧测试失败，不得以新测试覆盖它。证据：`tools/service-quality-evidence/svc02/svc02-svc07-local-candidate-runtime-r2.json`。当前仍 `promotion_eligible=false`，下一步是隔离 ASGI/SQLite 与真实模型/性能验证，不是部署候选。

同源候选随后以真实 FastAPI lifespan + `httpx.ASGITransport` 做了进程内 SQLite smoke：SVC-07 健康、`/api/ready=503` 的未就绪门禁、`X-Trace-ID`/`Server-Timing` 和游客问候路由均通过，问候响应 `200`、中文 `你好！`、`transient=true`；qwen-asr 根目录只验证职责范围内的健康/生命周期，四个健康端点与遥测头通过，未把其附带的旧问答实现纳入 qwen-asr 结论。临时数据库、音频目录和拒绝连接的 loopback 健康地址均在退出后清理，GPU0 只发生候选进程级初始化，未启动监听端口。证据：`tools/service-quality-evidence/svc07/svc07-question-local-asgi-sqlite-smoke-r1.json`、`tools/service-quality-evidence/svc07/svc07-qwen-asr-local-asgi-sqlite-smoke-r1.json`。这仍不覆盖真实 Ollama/ASR、PostgreSQL、多进程、生产 ingress、真机或发布部署。

SVC-07 又在一次性 PostgreSQL 16 loopback 容器中执行 Alembic 到 `20260801_svc07_retention`，再用真实 SQLAlchemy/ASGI 用户问答路由写入并读取线程、turn 和引用：HTTP `200`、中文问候、`transient=false`，持久化 `thread=1/turn=1/citation=0` 全部通过。该探针先暴露了会议保留清理服务的 SQLite 专用 `BEGIN IMMEDIATE`、`INSERT OR IGNORE` 和 PostgreSQL 缺失清理表，已同步增加 dialect-aware 事务、`ON CONFLICT DO NOTHING` 以及 `20260801_svc07_retention` 迁移；重跑无新 SQL 错误，临时容器已删除。证据：`tools/service-quality-evidence/svc07/svc07-question-postgresql-smoke-r1.json`、`tools/service-quality-evidence/svc07/run_postgresql_candidate_smoke.py`。这只提升数据库方言和候选持久化证据，仍不等于生产数据库/迁移状态、真实模型质量、并发性能或发布资格。

SVC-01 本轮收口两个 C1 解析风险：不支持的“每隔一周/每两周/隔周”表达现在在快速规则和模型归一化路径中清空可保存日期，并要求中文澄清，不再误保存成一次性跨日期事件；模型更正句只有在模型标题本身是“不是/最后定”等更正元话语时才允许覆盖标题，正常最终事件标题不再被更正说明污染；复杂日程模型调用现在显式带 `interactive` 优先级和操作名，避免混合负载中被当成普通生成请求。当前 qwen35 staging parser `parser_sha256=f8bf11e3309f70e14245f927ec264e550841802a7fb6060cb0d72e11f3be0458`，服务端候选合同 `17/17`、冻结安全扫描 `3200/3200`（819 条安全相关、0 违规）；证据：`tools/schedule-quality-v3/svc01-server-candidate-contract-r3.json`、`tools/schedule-quality-v3/svc01-server-candidate-frozen-safety-r3.json`。候选仍未部署、未接真实模型。

SVC-00 日程后处理候选审计 r6 已绑定上述 qwen35 parser，固定参考时钟下 `32/32` 通过；结果只证明确定性归一化、日期/标题/澄清边界，不证明 4B/9B 真实模型质量、GPU 速度或混合负载。证据：`tools/service-quality-evidence/svc00/schedule-model-fallback-postprocess-candidate-r6.json`。

SVC-02 服务端边界证据已在 parser 更新后重生成：qwen35 `source_sha256=f8bf11e3309f70e14245f927ec264e550841802a7fb6060cb0d72e11f3be0458`、qwen-asr-default `source_sha256=d9b800b277171e566c5956434b17f48105f9be9890d3898f0ce60258d1665d4b`；ASR 文本类型边界 `20/20`、音频输入一致性 `26/26`，两套候选仍 `production_enabled=false`。证据：`tools/service-quality-evidence/svc02/svc02-server-asr-text-boundary-contract-r1.json`、`tools/service-quality-evidence/svc02/svc02-server-audio-consistency-contract-r1.json`。

SVC-00 本轮增量：共享 `meetingsummary.ollama_client` 现在接受经过校验的 `priority` 和 `telemetry_operation`，向 Ollama/OpenAI-compatible 请求传递安全 header；会议问答调用显式标记为 `interactive`，整理、Map-Reduce 和命令行整理显式标记为 `background`；候选 qwen35/qwen-asr-default 日程模型调用也显式标记为 `interactive`；broker 同时转发操作标签。默认未传优先级时仍不增加 header；非法值在发 HTTP 前拒绝。本轮另将同一接线同步到 qwen35 cutover 与 qwen-asr-default 两个 staging 客户端，隔离脚本 `svc00-staging-priority-contract-r1.json` 对两套客户端共 `4/4` 通过；qwen35 日程与客户端回归分别为 `58/58`、`14/14`，qwen-asr-default 依赖不足的 pytest 仍未运行。Focused client/broker/call-site contract `17/17`、broker 集成回归 `21/21`、相关 Python 源码编译通过。证据：`tools/service-quality-evidence/svc00/svc00-priority-header-contract-r1.json`、`tools/service-quality-evidence/svc00/svc00-staging-priority-contract-r1.json`。这只证明接线，不证明上游 broker/模型实际执行优先级、混合负载延迟、OOM 或生产部署。

SVC-00 排队截止候选：broker 新增可选 `X-Laoji-Queue-Deadline-Ms`，只约束进入上游前的排队时间，默认不启用；独立过期扫描不会因所有 worker 被长任务占用而延迟，过期请求以 HTTP `408 queue_deadline_exceeded` 返回且不接触上游，非法/越界值在入队前以 `400 invalid_queue_deadline` 拒绝。broker 回归由 `17/17` 扩展为 `21/21`，回环行为合同 `8/8`，一次过期观测约 `30.9 ms`；证据：`tools/service-quality-evidence/svc00/run_broker_queue_deadline_contract.py`、`tools/service-quality-evidence/svc00/svc00-broker-queue-deadline-contract-r1.json`。这仍只证明候选 admission 行为，不证明 Ollama 容量、模型延迟或生产客户端已启用；下一步应在独立 9B/4B 资源窗口中由客户端显式配置截止值，随后再测完整混合负载。

SVC-00 本轮首次在服务器现存候选端口做受控真实候选测量：只运行 `manifest-reserved-slot-r1.json` 的 1 个整理、1 个问答和 1 个模型日程请求，三者均成功；模型路由有正向 `inference` timing。实际加载模型为 `qwen3.5:9b`，digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`，Q4_K_M、8192 context，模型显存约 8.88 GiB。模型日程 client p95 `16.268 s`、其中 `queue_wait=14.932 s`；问答 client p95 `17.664 s`、`queue_wait=16.181 s`；整理 `36.948 s`；两个交互请求均超过 2 s 排队门槛。候选经 `28434/28435` 仍共用生产 `21434`，因此这是服务器真实 timing/队列诊断，不是独立 4B 资源隔离或发布 Gate；完整混合负载、4B 质量和 OOM 仍未通过。原始报告与身份快照：`tools/service-quality-evidence/svc00/svc00-reserved-slot-real-candidate-r1.json`、`tools/service-quality-evidence/svc00/svc00-reserved-slot-real-candidate-r1-runtime.json`。

SVC-00B 随后使用 GPU0 独立临时 Ollama `28433` 与日程候选 `28135`，只加载服务器现有 `qwen3.5:4b`（digest `2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd`，Q4_K_M、8192 context）。32 条 C1 日程冻结集通过 `18/32`、失败 `14/32`，通过率 `56.25%`；质量 Gate 失败，但单路延迟 p95 `1.557 s`、p99 `1.604 s`，说明 4B 速度可行而质量不足，不能替代 9B。临时进程已停止，GPU0 恢复至空闲 `9,989 MiB`，GPU1 未触碰，生产 `21434/21436` 未修改。证据：`tools/service-quality-evidence/svc00/svc00-4b-schedule-quality-r1.json`、`tools/service-quality-evidence/svc00/svc00-4b-schedule-quality-r1-runtime.json`；`promotion_eligible=false`。

本轮继续推进记录：

- 新增 `tools/service-quality-evidence/common/resource_profiles.py`，按实际显存、compute PID、共享状态和显式依赖结果选择 `cpu_contract`、`gpu0_preview`、`gpu0_candidate` 或 `release`；早期单设备合同为 `22/22`，不把共享 GPU 或未验证依赖误判为安静候选。
- 资源选择器已补齐可审计模型注册表合同：候选选择结果携带模型 digest（若已登记）、量化、dtype、目标设备、最大并发、上下文上限、预期延迟、数据集版本、回滚模型和依赖锁字段；注册了服务器当前实际存在的 Qwen 4B/9B digest，并验证 9B 在 9,989 MiB 空闲窗口拒绝、4B 可候选选择；`release` 档位缺少不可变依赖锁 SHA-256 时仍 fail-closed。注册表与容量合同现为 `20/20`，只可用于候选选择，不能产生发布 ready。证据：`tools/service-quality-evidence/common/resource_profiles.py`、`tools/service-quality-evidence/common/test_resource_profiles.py`、当次 `run_capacity_audit.py` 输出。
- 新增 `tools/service-quality-evidence/common/dependency_probe.py`：使用目标 Python 解释器执行真实 import、发行版/模块版本和最低版本检查，记录解释器、平台、每项 required/optional 状态和 runner 错误；不使用 shell、不安装包、不把 `pip check` 当作就绪。缺依赖、解释器退出、输出损坏或版本不足均 fail-closed，`required_dependency_state()` 可直接投影到资源选择器；配套测试 `6/6` 通过。该探针是资源选择后的前置合同，后续自动配置器必须先调用它，再执行锁文件安装、CUDA tensor/model smoke 和 provenance 写入。
- 资源选择器依赖门禁刷新：`candidate`/`release` 不再允许省略依赖探针或传入空/失败状态；未检查返回 `dependencies_not_checked`，任一必需依赖失败返回 `dependencies_not_ready`，运行时 ABI/CUDA smoke 未检查或失败分别返回 `runtime_smoke_not_checked`/`runtime_smoke_not_ready`，只有显式全通过才可进入显存选择结果。预览档仍可在未提供依赖结果时作为纵向容量候选，但 `model_ready` 仍为假；选择结果中的依赖和 runtime smoke 状态会自动进入 provenance。资源选择器与依赖探针合计 `31/31` 测试通过，证据为 `tools/service-quality-evidence/common/resource-adaptive-contract-r2.json`；这仍不等于模型已加载、真实 provider ready 或生产发布。
- 资源选择器新增 `choose_profile_from_snapshots()` 多 GPU 只读适配层：逐卡校验显存/UUID/compute PID，candidate/release 只选无占用且满足依赖、运行时 smoke 和模型显存门槛的 GPU，preview 可在共享 GPU 上运行；失败卡的原因全部保留，选择结果会把实际 `cuda:<index>` 写入顶层与模型注册表，避免 profile 默认设备覆盖真实选择。旧单卡限制已移除，r3 合同 `32/32` 通过；当前机器实时快照仍只有共享的 GPU0（空闲 `7541 MiB`），自动 preview 选择 `whisper-small`、`model_ready=false`，未启动模型。证据：`tools/service-quality-evidence/common/run_resource_multi_gpu_contract.py`、`tools/service-quality-evidence/common/resource-adaptive-contract-r3.json`；这仍是只读准入证据，不代表 provider ready、模型质量或生产发布。
- 运行时 ABI/CUDA smoke 已补入自适应前置：目标解释器的 Torch import 即使返回成功，只要出现 `_ARRAY_API`/NumPy ABI 警告就 fail-closed；干净解释器还必须完成最小 CUDA tensor。当前 `svc09-r4-verify` 解释器因 NumPy `2.4.6` 与 Torch `2.2.2+cu121` ABI 警告被拒绝，`laoji-qwen-asr` 与 `katacr` 解释器完成 CUDA smoke；证据为 `tools/service-quality-evidence/common/runtime-smoke-svc09-r4.json`、`runtime-smoke-qwen-asr.json`、`runtime-smoke-katacr.json`，这只证明解释器运行时身份，不等于模型质量或生产 ready。
- SVC-04 严格 Gate 工具回归 `35/35`、CPU dry-run 和远端候选源码 `py_compile` 通过；`large-v3` 仍按 12 GiB 启动余量规则拒绝当前 GPU0，不启动真实 GPU Gate。
- SVC-04 staging 证据已从旧 r3 刷新为 r4：候选源码哈希重新绑定，身份/分块轻量合同 `20/20`、完整候选 SQLite/故障注入回归 `48/48` 通过；FastAPI、python-multipart、httpx2 只安装到一次性 `/tmp` 目录，未污染全局。SVC-04 工具/staging 回归保持 `35/35`。r4 仍明确 `real_provider/gpu=not_run`，不代表真实模型或生产部署完成。证据：`tools/service-quality-evidence/svc04/offline-chunk-checkpoint-postaudit-r4.json`。
- SVC-04 候选本轮修复完整音频与分块音频的结果边界：ASR 返回对象/数组不再被 `str()` 化写入转写记录，非法时间戳和总时长拒绝持久化；分块合同 `18/18` 通过，边界合同 `11/11`，证据为 `tools/service-quality-evidence/svc04/svc04-transcript-text-boundary-contract-r1.json`。这不替代真实视频编码、模型质量和 GPU Gate。
- SVC-04 候选补充容器 smoke：临时 MP4（视频轨 + AAC 音轨）经 `ffprobe` 识别并切出 32 KB 有界 WAV，`4/4` 通过；证据为 `tools/service-quality-evidence/svc04/svc04-video-container-smoke-r1.json`。这不代表用户设备上的完整 codec 矩阵或 ASR 质量已通过。
- SVC-03 隔离候选新增 `LAOJI_ASR_PROVIDER=qwen|whisper|auto`：默认保持 Qwen，`auto` 只有在 Qwen 不就绪且 loopback Whisper gateway 返回真实 `ready=true` 时才回退；每个 WebSocket 使用独立 session，停止、配置失败和支持模型初始化失败都会关闭回退 session。Whisper 网关单元/loopback 集成合同 `10/10`、源码 `py_compile` 通过；证据：`tools/service-quality-evidence/svc03/svc03-adaptive-provider-contract-r1.json`。
- 针对“ready 不等于质量可发布”的缺口，`auto` 回退现在默认还会拒绝质量未证明的 Whisper-small；只有显式设置 `LAOJI_ASR_AUTO_ALLOW_PREVIEW_FALLBACK=1` 才允许候选预览回退，显式 `LAOJI_ASR_PROVIDER=whisper` 仍保留为人工候选实验入口，WebSocket config/转写事件和 `/api/health` 选中 provider 快照均标记 `quality_profile=degraded_preview`（Qwen 为 `full`）。当前源码函数合同 `9/9` 通过，证据：`tools/service-quality-evidence/svc03/svc03-adaptive-provider-preview-gate-r1.json`。该证据使用 AST 提取执行，完整 pytest 仍受 sparse overlay 缺少 `app.database` 阻断；不代表 Whisper 质量或生产发布。
- SVC-03 已完成 68 条日程语音的真实 CPU Whisper-small 质量基线：`canonical_exact=43/68`、canonical CER 均值约 7.85%、p95 30%，RTF p50 0.596、p95 1.059；模型可运行但未达到日程/实时转写质量门槛。证据：`tools/service-quality-evidence/svc03/svc03-whisper-schedule-quality-r1.json`；该报告为诊断基线，`promotion_eligible=false`。
- SVC-03 本轮修复 fallback session 清理递归缺陷：关闭 helper 现在捕获并清空当前 session 引用，幂等调用一次 `session.close()`，配置发送失败、模型初始化失败和 finalizer 共用同一路径；源级清理合同 `5/5`、`py_compile` 通过。证据：`tools/service-quality-evidence/svc03/svc03-whisper-cleanup-contract-r1.json`。这仍不证明真实 Whisper 模型、远端认证协议或 GPU 质量。
- SVC-03 本轮继续收紧 Whisper fallback 网关：`_request_pcm` 在构造 HTTP 请求前拒绝非 bytes、空 payload 和奇数字节 payload，避免网关以错误的 S16LE 样本流解析；无模型边界合同 `4/4`，网关 provider/loopback 合同回归 `14/14`，证据：`tools/service-quality-evidence/svc03/svc03-whisper-pcm-boundary-contract-r1.json`。这仍不证明真实 Whisper 模型、远端认证协议或 GPU 质量。
- 同一 PCM 门禁已加到 Qwen 直连函数 `_qwen_transcribe`，停止用的 WebSocket 空帧仍只在上层解释为停止，不会进入该函数；无 GPU AST/行为合同 `6/6`，证据：`tools/service-quality-evidence/svc03/svc03-qwen-pcm-boundary-contract-r1.json`。当前本机缺少 NumPy，完整 `test_qwen_realtime_ws.py` 未收集运行；该合同不替代真实 ASR/设备验证。
- SVC-06 整理后处理现在在长转写或带稳定 `[seg:...]` 片段标记时过滤所有无原文支持的待办和决定，不再只过滤“无负责人”占位项；无依赖源码/行为合同 `9/9`，stub 探针确认短 canonical transcript 会丢弃虚构负责人/决定、保留有依据待办/决定。证据：`tools/service-quality-evidence/svc06/svc06-summary-action-grounding-contract-r1.json`。现有 `tests/test_summary_task_parsing.py` 依赖的完整 `app.workers` 包在当前 sparse 候选目录不可导入，完整服务器行为回归仍待服务器环境执行。
- 候选健康语义已分开：`/health` 只表示存活，`/api/health` 暴露实际 provider 快照，新增 `/api/ready`，未满足支持模型、选中 provider 和任务接纳条件时返回 HTTP 503；就绪源级合同与网关合同合计 `12/12`。
- SVC-03 候选启动缺口已补齐：新增 GPU-free `app/runtime_policy.py`，WhisperLiveKit 预热默认关闭，只有显式环境变量才开启；未知布尔值回退到调用方默认值。运行策略合同 `6/6`、纯标准库 `py_compile` 通过，证据：`tools/service-quality-evidence/svc03/svc03-runtime-policy-contract-r1.json`。该修复只保证候选能解析启动策略，不代表框架依赖、模型 ready 或 GPU 质量已满足。
- SVC-03 本轮继续收紧 Qwen 候选 ready：runtime guard 的健康校验必须声明 `context_supported=true`，启动后的静音 ASR smoke 会发送一个有界词表并要求返回 `context_applied=true` 与非空 `context_term_count`；systemd 候选先执行 `wait-ready` 再执行 `smoke-asr`。隔离 guard 回归 `18/18`，静态 wiring 检查 `8/8`，证据：`tools/service-quality-evidence/svc03/runtime-candidate/svc03-runtime-readiness-contract-r1.json`。该报告为 model-free 隔离证据，未启动 Qwen、未检查真实 GPU、未改动生产 8030/18020，仍不能证明 ASR 质量、真机握手或部署完成。
- 同一 SVC-03 隔离 Qwen 源码已在备份后应用健康身份补丁：`/home/yydd/LaoJi/server-staging/qwen3-asr-test/qwen_asr_service/server.py` 的 `/health` 现在额外返回自身 `server_sha256` 与模型配置 `model_config_sha256`，保留既有 `context_supported` 字段；补丁工具兼容已有上下文健康字段并通过幂等检查。随后又修复模型路径门禁：模型 ID 必须解析为本地目录且含 `config.json`，模块导入不再无条件读取远端模型 ID 路径；`load_model()` 前刷新配置哈希并写回全局身份。当前候选源码哈希为 `82089507eb10eaf2282b61f868deb8cbdded5222f3510ca03e4c1e50a304d1ff`，备份依次为 `tools/service-quality-evidence/svc03/source-backups/qwen3-asr-test-server.before-health-identity-r1.py`、`qwen3-asr-test-server.before-local-model-path-r1.py`、`qwen3-asr-test-server.before-config-refresh-r1.py`、`qwen3-asr-test-server.before-text-boundary-r1.py`、`qwen3-asr-test-server.before-timing-r1.py`；runtime guard/patcher 回归 `23/23`，readiness 静态检查 `12/12`，上下文候选合同 `26/26`，pin 一致性 `13/13`，语法通过。该修改仍只在隔离 staging 源码，`8030` 未启动，不能当作生产 ready 或模型质量证据。
- SVC-03 候选启动器已移除隐含的 `GPU1` 默认值：`start-qwen-asr.sh` 现在要求显式非负整数 GPU，并在空值或 `CHOOSE_AFTER_READ_ONLY_AUDIT` 时于依赖/模型检查前 fail-closed；启动器哈希已同步到 `qwen-asr.env.example`，并由 pin 合同行为检查覆盖“空值/占位符拒绝、显式 GPU 进入后续检查”。证据：`tools/service-quality-evidence/svc03/runtime-candidate/svc03-candidate-pin-contract-r1.json`、`tools/service-quality-evidence/svc03/source-backups/start-qwen-asr.before-gpu-default-r1.sh`。这只收紧候选启动安全边界，不代表 GPU 所有权、模型 ready 或生产部署。
- SVC-03 Qwen 微服务本轮补齐模型结果边界：`_normalized_model_text()` 只接受模型对象/映射中的字符串 `text`，对象、数组或其他结构化值不再由 `getattr(..., "")` 静默写入 JSON；结构化结果以稳定 `asr_text_invalid`/`asr_result_not_object` 返回 HTTP 502，空文本仍按空结果处理。输出边界合同 `9/9`、`py_compile` 通过，证据：`tools/service-quality-evidence/svc03/svc03-qwen-server-text-boundary-contract-r1.json`。这只修复微服务输出边界，不代表 Qwen 模型 ready、GPU 性能、冻结集质量或生产部署。
- SVC-03 本轮完成隔离 GPU0 的 Qwen3-ASR-0.6B 真实模型诊断：复用 `katacr` 的 Torch `2.2.2+cu121`，独立环境导入 `qwen-asr==0.0.6` 及其推理依赖，模型配置哈希为 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`，权重文件 SHA-256 为 `79d6cbd4c98c7bbffe9db2edac07f56cd6637d0d5944b27f6c2b8353840323ea`。随机回环 `28130` 只读启动成功，加载约 `1.52 s`，进程显存约 `1.9 GiB`，服务端源码哈希为 `fad560d1426e467f3f9f00454fc93a5e6b5ab0b3157bc73a52dbd37bd6a1697c`；未触碰 `8030/18020` 或 GPU1。冻结的 28 条会议语音成对运行：无上下文 `24/28` 规范化 exact、CER mean `1.365%`、关键术语 `82/84`，受限词表模式 `28/28`、CER `0`、关键术语 `84/84`，上下文模式推理 p50/p95 约 `297/391 ms`。可复现脚本与报告：`tools/service-quality-evidence/svc03/run_qwen_gpu_quality_probe.py`、`tools/service-quality-evidence/svc03/svc03-qwen-gpu-quality-context-r1.json`。词表模式使用每条夹具标注的关键术语，属于受控/近似 oracle 诊断，不能直接外推到无词表用户输入；报告仍为 `promotion_eligible=false`，尚未覆盖真实词表来源、词表误导/跨会话隔离、WebSocket/VAD、并发、重启、长会议、Android 或生产部署。
- SVC-02 同一 Qwen3-ASR-0.6B 隔离 GPU 候选在无词表条件下完成 68 条冻结日程语音：`68/68` 完成、规范化 exact `68/68`、CER mean/p95 均为 `0`，推理 p50/p95 为约 `136/216 ms`，最大客户端往返约 `632 ms`。证据：`tools/service-quality-evidence/svc03/svc03-qwen-gpu-quality-schedule-r1.json`。该集合为合成/固定语料，不能替代真实手机录音、口音噪声、编码、端到端日程字段 exact、路由鉴权、并发和生产部署；仍保持 `promotion_eligible=false`。
- SVC-03 隔离 GPU 并发诊断使用 4 路并发、4 个互不相同的受限词表样本、3 轮共 12 请求；全部完成，规范化 exact `12/12`，词表隔离失败 `0`，每个响应的 `context_term_count` 与请求一致。新增 timing 分段后，客户端 RTT p50/p95 约 `1816/2351 ms`，真实锁等待 p50/p95 约 `1403/1798 ms`，模型推理 p50/p95 约 `464/543 ms`，provider 总耗时 p50/p95 约 `1813/2331 ms`；这组结果确认当前 `INFERENCE_LOCK` 是实时多会话尾延迟的主要瓶颈，尚不满足性能 Gate。证据：`tools/service-quality-evidence/svc03/run_qwen_gpu_concurrency_probe.py`、`tools/service-quality-evidence/svc03/svc03-qwen-gpu-concurrency-r1.json`；仍为隔离诊断，未接生产 ASGI、真机或长时 soak。
- SVC-03 Qwen provider 新增 `queue_wait_ms`、`model_infer_ms`、`provider_total_ms` 三段 timing，保留旧 `infer_ms` 的 provider 总耗时兼容语义，并由候选 WebSocket `transcript.completed` 透传；服务源码新哈希为 `82089507eb10eaf2282b61f868deb8cbdded5222f3510ca03e4c1e50a304d1ff`，文本边界 `9/9`、runtime readiness `23/23`、pin `13/13`、上下文静态组装 `12/12` 均通过。该改动只改善可观测性，不改变全局串行推理的性能结论。
- Qwen 隔离环境的解释器、依赖版本、Torch/CUDA、GPU 快照和模型权重/配置哈希已固化在 `tools/service-quality-evidence/svc03/svc03-qwen-runtime-provenance-r1.json`；环境位于 `/home/yydd/.cache/laoji-qwen-asr`，未写入工作树，也未安装第二份 Torch/CUDA。该 provenance 只用于复现候选诊断，不能代替服务 ready 或发布凭证。
- SVC-03 本轮用真实 Qwen3-ASR-0.6B HTTP 模型纵向执行 `server-work/summary/backend/app/api/qwen_ws.py` 候选适配器和候选 `StreamingVAD`：日程 1 段、7.3 秒会议按 6 秒上限得到 2 段，两个路由均通过 `config → stop_acknowledged → transcript.completed* → ready_to_stop`，聚合文本规范化 `2/2`，Qwen 上下文透传 `2/2`，日程持久化增量 `0`、会议逐段持久化增量 `2`，无错误。证据：`tools/service-quality-evidence/svc03/run_qwen_websocket_real_smoke.py`、`tools/service-quality-evidence/svc03/svc03-qwen-websocket-real-smoke-r1.json`；Qwen 模型、HTTP 服务和候选 VAD 状态机是真实的，FastAPI、支持模型、鉴权、数据库和声纹依赖是隔离桩，因此仍为 `promotion_eligible=false`，不能替代真实 ASGI/训练 VAD/Android/生产验证。
- SVC-03 微批候选已按当前 timing 版本重新生成补丁：每个请求现在取得真实 `queue_wait_ms/model_infer_ms`，健康接口报告有效批大小和开关状态，SIGTERM/SIGINT 先停止接收并在退出前关闭调度器；默认 `QWEN_ASR_REQUEST_BATCH_SIZE=1` 仍保持关闭。候选调度器合同由 `26/26` 增至 `27/27`，补丁对当前 staging server `patch --dry-run`、候选 `py_compile` 均通过。证据：`tools/service-quality-evidence/svc03/semantic-candidate/qwen_microbatch.py`、`qwen_microbatch_service.patch`、`test_qwen_microbatch.py`。
- SVC-03 在 GPU0 隔离环境对同一 Qwen3-ASR-0.6B 做真实请求微批 A/B：28 条会议语音各运行 2 次共 56 请求；串行总耗时 `17.918 s`，2 路微批 `16.328 s`，4 路微批 `6.963 s`，三种模式均无超时/错配，规范化语义与串行 `100%` 一致，4 路只有 `2/56` 条标点差异。证据：`tools/service-quality-evidence/svc03/run_qwen_microbatch_real_benchmark.py`、`svc03-qwen-microbatch-real-benchmark-r1.json`；这是本地权重/单 GPU 诊断，不替代 ASGI、VAD、Android、OOM、重启或生产并发 Gate。
- SVC-03 又将修订后的微批接线应用到一次性 HTTP 副本，4 路并发真实请求 `4/4` 完成、规范化语义 `4/4`，每条响应均透传非零模型 timing 和独立词表计数；候选收到 SIGTERM 后进程状态 `0`，未触碰 `8030`/生产 GPU1。证据：`tools/service-quality-evidence/svc03/run_qwen_microbatch_http_smoke.py`、`svc03-qwen-microbatch-http-smoke-r1.json`；仍保持 `promotion_eligible=false`。
- SVC-03 在补齐 FastAPI/SQLAlchemy/aiosqlite/WebSocket 依赖后，用完整候选后端、一次性 SQLite 和真实 Qwen HTTP 做 ASGI WebSocket smoke：游客会话创建、真实 PCM 分帧、`config → stop_acknowledged → transcript.completed×2 → ready_to_stop`、缓存读取和删除均通过；Qwen `/health=ready`，但支持模型没有本地权重，`/api/health` 前后均为 `models_ready=false`、`/api/ready=503`，实时路径明确落在能量 VAD 降级且说话人为 `speaker_1`，不计入声纹通过。证据：`tools/service-quality-evidence/svc03/run_qwen_asgi_real_smoke.py`、`svc03-qwen-asgi-real-smoke-r1.json`；仍不覆盖 CAM++/Silero 真权重、登录用户数据库转写、Android、生产部署和 soak。
- SVC-03 模型管理器 readiness 候选已扩展：CAM++ 只有在权重加载、设备迁移、`eval()` 和一次真实 192 维特征/embedding 前向都通过后才满足 `speaker_features_ready`；缺失权重或 `torchaudio`/fbank 运行时不会假绿，异常会清空半初始化引用。缺失权重合同和特征运行时合同均通过，真实 Silero/CAM++ smoke 也通过；该候选仍未部署生产。证据：`tools/service-quality-evidence/svc03/model_manager_readiness.patch`、`svc03-model-manager-readiness-contract-r2.json`、`svc03-support-models-real-smoke-r2.json`。
- SVC-03 候选环境模板的源码 pin 已同步到最终隔离候选：`QWEN_ASR_EXPECTED_SERVER_SHA256=82089507eb10eaf2282b61f868deb8cbdded5222f3510ca03e4c1e50a304d1ff`，并删除旧 pin/未评估词表候选哈希。pin 合同 `13/13` 确认隔离 server/launcher 哈希匹配、启动器不隐式选择 GPU、空值/占位符先拒绝、模型配置 pin 为有效 SHA-256、GPU 选择仍是占位拒绝、共享 GPU 默认关闭、恢复候选词表为空。模型配置文件不在本机 staging，故只验证 pin 格式，未声称远端权重一致或生产 ready。
- SVC-03 本轮收口 WebSocket 就绪顺序：overlay 与 qwen3-asr 隔离候选均在本地 VAD/声纹支持初始化完成后才发送 `config`，初始化失败不会先向客户端宣称可录音；双源码静态合同 `2/2`，证据：`tools/service-quality-evidence/svc03/svc03-ready-config-contract-r1.json`。这只证明协议顺序，不代表模型质量、GPU 性能或真机握手。
- SVC-03 本轮完成一次只读自适应资源审计：该次快照中 GPU0 被 Android 模拟器共享，空闲约 7.5 GiB；资源层只能通过 `gpu0_preview/whisper-small` 的容量门槛，`model_ready=false`，Qwen candidate/release 和所有当前 ASR/Whisper 监听均未就绪。审计脚本不启动服务、不改变 GPU 或端口，证据：`tools/service-quality-evidence/svc03/svc03-runtime-capacity-audit-r1.json`。
- 资源选择器与 SVC-03 容量审计已统一区分 `admission_ready`、`capacity_ready` 和 provider 的 `model_ready`，并将 GPU index、compute PID、显存和档位写入 provenance；早期单设备合同为 `22/22`，当前多 GPU r3 合同为 `32/32`、common 合同总计 `41/41`，候选/发布档还要求显式依赖探针结果。该证据仍不是模型质量、runtime readiness 或生产部署结论。
- SVC-03 本轮补齐 ASR 结果文本边界：`text` 缺失、`null` 或空白按空结果处理，结构化对象、数组和数字拒绝进入界面或持久化；summary 候选、`qwen-asr-default` staging、`qwen3-asr-test` staging 三套适配器均接入归一化，源码合同 `3/3`（每个源码 `8/8`）；证据：`tools/service-quality-evidence/svc03/svc03-asr-text-boundary-contract-r2.json`。这只证明输入输出边界，不代表 CER、关键槽位召回或真实模型质量。
- SVC-02/SVC-03 本轮用真实 `faster-whisper-small` CPU `int8` 对冻结音频做质量探针：日程语音 `68/68` 完成，规范化 exact `43/68`，canonical CER mean `7.85%`、p95 `30%`，RTF p50 `0.608`、p95 `0.876`；会议语音 `28/28` 完成，规范化 exact `10/28`，canonical CER mean `9.61%`、p95 `31.18%`，关键术语召回 `62/84 = 73.81%`，RTF p50 `0.303`、p95 `0.422`。这直接证明当前轻量 CPU provider 不满足日程/会议 C1 质量门槛；只达到 `cpu_preview_quality_observed_not_release_gate`，未接手机、WebSocket、GPU 或生产。探针自身 `6/6` 通过；证据：`tools/service-quality-evidence/svc03/svc03-whisper-cpu-quality-schedule-r1.json`、`tools/service-quality-evidence/svc03/svc03-whisper-cpu-quality-meeting-r1.json`、`tools/service-quality-evidence/svc03/test_whisper_quality_probe.py`。
- 同一 28 条会议集对 `faster-whisper-medium/int8` 做了独立 CPU 对比：模型加载约 `86.9 s`，规范化 exact 仅 `7/28`，canonical CER mean `16.41%`、p95 `38.33%`，关键术语召回 `47/84 = 55.95%`，RTF p95 `2.286`；中型模型在当前 CPU/线程和语料上质量、速度都劣于 small，不能因为参数更大就提升注册档位。对照报告：`tools/service-quality-evidence/svc03/svc03-whisper-cpu-quality-meeting-small-medium-compare-r1.json`；探针服务标签已改为按请求模型尺寸生成，回归 `7/7` 通过。
- 同一 28 条会议集对 `faster-whisper-medium/int8` 做了独立 CPU 对比：模型加载约 `86.9 s`，规范化 exact 仅 `7/28`，canonical CER mean `16.41%`、p95 `38.33%`，关键术语召回 `47/84 = 55.95%`，RTF p95 `2.286`；中型模型在当前 CPU/线程和语料上质量、速度都劣于 small，不能因为参数更大就提升注册档位。证据：`tools/service-quality-evidence/svc03/svc03-whisper-cpu-quality-meeting-medium-r1.json`；仍为诊断证据，未接生产。
- SVC-03 本轮在隔离 CPU 环境完成真实 `faster-whisper-small` provider smoke：`small/int8`、revision `536b0662742c02347bc0e980a01041f333bce120`，6 条既有日程语音均完成转写，保守繁简体/数字/标点归一化后 `6/6` 一致；原始逐字表面一致 `0/6`，证据明确标注 `runtime_smoke_ready_quality_gate_blocked`，不代表 GPU、WebSocket、并发或生产 ready。可复现脚本：`tools/service-quality-evidence/svc03/run_whisper_preview_smoke.py`；证据：`tools/service-quality-evidence/svc03/svc03-whisper-preview-smoke-r1.json`。
- SVC-03 随后把同一真实模型接入现有 `WhisperGatewayClient` 协议做临时 loopback：6 次独立 session start → PCM segment → close 均成功，`ready=true`，关闭后开放 session 为 `0`，归一化结果 `6/6`；单段 client 端约 `1.9–3.2 s`。临时 HTTP 服务使用随机回环端口并在命令结束前关闭，未触碰生产 `8002`。可复现脚本：`tools/service-quality-evidence/svc03/run_whisper_real_gateway_smoke.py`；证据：`tools/service-quality-evidence/svc03/svc03-whisper-real-gateway-smoke-r1.json`。这仍只达到 CPU runtime/协议 smoke，不能替代 GPU、实时 WebSocket、冻结集质量、并发、重启或 soak。
- 同一回环进一步运行完整 28 条会议夹具：28/28 次 session 和 PCM 请求成功、28/28 正常 close、无开放会话残留，但保守归一化后的整句一致仅 `10/28`，关键术语命中 `61/84`（72.6%）；`infer_ms` p50 3177、p95 3954、max 4415，均为单路 CPU。失败集中在方案乙/否定、负责人姓名、数字和口语词，证明 `whisper-small` 只能作为自适应预览 fallback，当前不具备 SVC-03 质量放行条件。证据：`tools/service-quality-evidence/svc03/svc03-whisper-real-gateway-meeting-28-r1.json`；该结果不得被重解释为 CER/WER 或正式 C1 判定。
- 针对当前网关源码重新收集合同回归：provider、loopback session、失败清理和 readiness 共 `16/16`，`py_compile` 通过，源码哈希绑定在 `tools/service-quality-evidence/svc03/svc03-whisper-gateway-contract-r2.json`。这只确认接线没有回归，不能覆盖上面的真实模型质量失败。
- 对远端 `183.36.243.124:8002` 重新做了只读身份/协议探针：现场进程仍是 `/home/zhong/SMART-MEETING2/asr-gateway` 的旧 Whisper 网关（PID 2179），不是 Qwen；`/health` 仅返回纯文本 `OK`，`/api/health`、`/v1/stream/session/start` 和 `/v1/full/transcribe` 在无凭据时均返回 `401`，因此仍没有候选所需的 JSON readiness 或已授权协议证据。候选自动回退只能判为 `auth_required/not_ready`，且本地适配器只允许 loopback 网关，不会直接选用该远端地址；本轮未读取、发送、打印、持久化或猜测 API key。证据：`tools/service-quality-evidence/svc03/svc03-remote-8002-compatibility-r2.json`。
- SVC-07 在远端隔离候选环境补跑真实 Python/依赖合同：问答速度、检索、混合检索 `73/73`，会议上下文与 WebSocket 授权 `9/9`，合计 `82/82`；第二组使用一次性 SQLite 数据库并已清理。证据：`tools/service-quality-evidence/svc07/svc07-candidate-runtime-contract-r1.json`。这消除了本机缺少依赖造成的假阻塞，但仍不代表生产 PostgreSQL、ASGI、真实 Ollama 质量或 GPU 性能。
- SVC-03 在同一远端隔离候选环境补跑实时 WebSocket 合同 `22/22`：覆盖 Qwen ready gate、Whisper 每会话回退清理、PCM/结构化文本边界、停止排空、断线取消、访客记录持久化和声纹上下文隔离。证据：`tools/service-quality-evidence/svc03/svc03-qwen-ws-candidate-runtime-r1.json`。这证明候选生命周期接线可运行，不证明 Qwen 模型 ready、GPU/真人质量、Android 握手或生产部署。
- SVC-10 使用服务器真实 `laoji-meeting-embedding:0.6b` 对 20 条合成会议事实/改写问题做批量语义排序：1024 维向量，`Recall@1=20/20`、`Recall@3=20/20`，单批 40 项请求约 `5.37 s`，平均首名间隔 `0.2628`。证据：`tools/service-quality-evidence/svc10/svc10-semantic-embedding-probe-r1.json`。这是 semantic path 的真实运行诊断，仍未升级为生产门禁，尚需真实匿名会议、NDCG、过滤、跨账号隔离和 freshness 评测。
- 同一服务器候选的 `app_meeting_retrieval.semantic_source_scores` 已接入真实 embedding endpoint：6 条合成会议问题在 source-vector 缓存复用下 `Recall@1=6/6`、`Recall@3=6/6`，7 次请求耗时 `1.5661 s`。证据：`tools/service-quality-evidence/svc10/svc10-semantic-retrieval-integration-r1.json`；该历史探针所绑定的远端候选签名当时没有本地新增的 `embed_timeout` 参数，探针按当时稳定公共签名运行，未把本地未合并差异误报为通过。当前 SVC-07 候选的参数漂移已由后续语义截止合同收口。
- SVC-05 在隔离候选真实 Python/SQLite 环境补跑带完整同意字段的声纹资料合同：runner 现在支持 `--candidate-root`、临时 SQLite 和纯 JSON 输出；注册归属和跨账号隔离、旧采集域迁移替换、异声拒绝 `400`、缺少明确同意拒绝 `428` 共 `7/7` 通过，并记录候选源码哈希。证据：`tools/service-quality-evidence/svc05/svc05-speaker-runtime-contract-r2.json`。特征提取仍被隔离探针 stub，真实 CAM++/多人声线质量未放行；原有 3 个旧测试失败是调用未传新 consent 字段，已作为测试陈旧性记录，不据此修改产品逻辑。
- SVC-06 在远端候选真实依赖环境补跑 compact summary 运行合同 `9/9`：JSON 外壳、决定引用、待办别名归一化、空待办丢弃、模板字段第二轮、共享 `8192` 上下文、response format 和 telemetry 均通过。证据：`tools/service-quality-evidence/svc06/svc06-compact-summary-runtime-contract-r1.json`；模型调用仍为 stub，不能外推事实质量或生产性能。
- SVC-01/SVC-02 在远端候选真实解释器下补跑公开服务上下文合同 `26/26`：日程解析、命令路由和 ASR 代理均通过；同一候选的旧私有 parser 断言集为 `38/58`，失败集中在直接 monkeypatch 日期、旧提示词/澄清文案和旧事件类型预期，已标为需按 `reference_datetime/timezone` 重写的非发布兼容测试，不再伪装成全绿。证据：`tools/service-quality-evidence/svc01/svc01-svc02-candidate-runtime-contract-r1.json`。
- 线上只读 readiness 审计确认：18020 `/api/health` 返回 `models_ready=true` 只代表本地 VAD/CAM++ 快照，`/api/ready` 实际为 `404`，18035 也只有基础存活 JSON；因此不能把线上健康接口当作 Qwen/8030 ASR ready。证据：`tools/service-quality-evidence/svc03/svc03-production-readiness-audit-r1.json`。
- SVC-03 远端 readiness 审计已用可复现的无代理 HTTP GET 探针刷新为 r2：18020 `/api/health` 仍为本地支持模型快照且 `/api/ready=404`，18035 仅存活，8030 连接拒绝，8002 `/health=200` 但 `/api/health=401`；探针限制响应体 4 KiB，不发送业务写请求、不记录凭据。证据：`tools/service-quality-evidence/svc03/svc03-production-readiness-audit-r2.json`、`tools/service-quality-evidence/svc03/run_remote_readiness_audit.py`。`promotion_eligible=false` 维持不变。
- SVC-06 候选整理相关回归已修正陈旧夹具并重跑为 `70/70`：测试现在返回不可变 `OllamaConfig`，校验 `temperature=0`、结构化 JSON response schema 和当前 `max_tokens=1024` 契约；独立真实导入运行探针仍为 `9/9`。证据：`tools/service-quality-evidence/svc06/svc06-summary-candidate-regression-r1.json`、`tools/service-quality-evidence/svc06/svc06-compact-summary-runtime-contract-r1.json`。这只证明候选代码与测试契约一致，不代表真实模型事实质量、引用召回或生产性能。
- SVC-08 增加 Expo 一次性定位 provider，并将权限检查/申请异常转换为中文错误；静态取消与 provider 接线合同 `24/24`，TypeScript 检查通过，未宣称真实 ROM 或地址成功率；证据：`tools/service-quality-evidence/svc08/svc08-native-cancellation-contract-r4.json`。
- SVC-08 本轮在当前源码加入可选 HTTP reverse-geocoder adapter（默认未配置、不主动发网络请求）后重新构建 Preview `versionCode=106`，并在 `emulator-5560` API 30 完成真实 UI 纵向：日历→新建日程→获取当前位置，GPS last-known fix（精度 5m）和坐标兜底均成功，界面显示 `22.543095, 114.057865`；系统反向地理编码无可读地址，应用无崩溃，故只提升为当前源码模拟器坐标候选，`promotion_eligible=false`。适配器合同从 `9/9` 扩展为 `12/12`，新增嵌套 `display_name/address`、`result.addressComponent` 供应商响应形状和“显式 HTTP provider 优先于系统回退”规则；未调用真实地址服务。r3 同时绑定了本轮 SVC-07 客户端 30 秒问答预算修复后的 APK，证据：`tools/service-quality-evidence/svc08/svc08-reverse-geocoder-contract-r2.json`、`tools/service-quality-evidence/svc08/svc08-emulator-location-evidence-r3.json`。
- SVC-08 的两个 Node 合同 runner 已改为使用仓库现有 `sucrase/register` 加载 TypeScript，plain `node` 可直接复现；反向地理编码边界 `12/12`、provider 矩阵 `369/369` 和原生取消静态合同 `24/24` 均重跑通过。该修复只改善供应商响应兼容性、优先级和证据可复现性，不改变默认不请求外部地址服务的隐私边界，也不增加真实地址成功率结论。
- SVC-09 在一次性隔离 Python 环境补跑真实候选 SQLite 状态机：回收站删除/恢复交错、单资产失败收敛、租约和恢复公平性通过，临时目录已清理；同一环境用真实 Uvicorn 进程完成 cooperative/timeout 两类 SIGTERM 前 admission 演练，停接后新请求返回中文 503、无竞态 claim、子进程回收和 SQLite integrity 均通过。证据：`tools/service-quality-evidence/svc09/meeting-state-fault-injection-r8.json`、`tools/service-quality-evidence/svc09/uvicorn-sigterm-admission-r9.json`；仍不覆盖生产 PostgreSQL、完整 ASGI、真实转写/ffmpeg、systemd 或 soak。
- SVC-07 客户端会议问答超时与服务端共享单轮预算：问答请求从 180 秒收紧为 30 秒，外部取消信号保持不变，长音频/上传超时不受影响；TypeScript 与客户端截止时间静态检查通过。证据：`tools/service-quality-evidence/svc07/svc07-question-client-deadline-contract-r1.json`、`tools/service-quality-evidence/svc07/svc07-question-deadline-contract-r1.json`。这只收口客户端等待边界，不证明真实模型能在 30 秒内完成。
- SVC-06 本轮补齐模型文本边界：服务端 `summary_tasks` 在概述、决定、待办和模板字段归一化前解包 JSON 字符串/代码块，未知对象不再通过 `str(dict)` 进入用户输出，损坏的对象样式结果直接丢弃；移动端结构化文档和旧缓存兼容层同步 fail-closed，同时保留正常的 `[重要]` 等普通正文，并兼容姓名对象的文本提取；旧 `/meetings` 和当前 `/laoji/meetings` 摘要接口均不再暴露 `raw_json`。focused contract `12/12`、服务端 `py_compile`、移动端 TypeScript 检查通过；证据：`tools/service-quality-evidence/svc06/svc06-summary-text-boundary-r1.json`。这只修复格式泄漏边界，不代表 SVC-06 的事实质量、引用召回或真实模型速度 Gate 完成。
- SVC-09 媒体片段任务现在共享停机 admission：新建/重试在栅栏关闭时返回稳定中文 503，已存在任务仍可幂等读取；恢复、提交和 worker claim 均在关闭后停止接收新执行。无依赖静态合同 `6/6`，证据：`tools/service-quality-evidence/svc09/svc09-media-clip-admission-contract-r1.json`。完整数据库、ASGI、ffmpeg 和跨进程停机竞态仍未运行。
- SVC-09 媒体片段重试本轮补齐 durable idempotency：API 不再丢弃 `Idempotency-Key`；服务端为 `media_clip_retry` 计算稳定 request hash，在锁定源资产后再次重放检查，成功或已有 queued/running 状态均写入 `MeetingRecordingAssetOperationV2`，并在唯一键竞争后读取持久化胜者。源级合同 `9/9`，证据：`tools/service-quality-evidence/svc09/svc09-media-clip-retry-idempotency-contract-r1.json`。这只证明源码合同，不代表真实 PostgreSQL 并发、ASGI、ffmpeg 或生产停机 soak。
- SVC-09 媒体片段重试已在合并当前候选源码与完整验证骨架的临时环境中通过真实 SQLite 回归 `9/9`；新增覆盖同键 ACK 丢失重放、同键跨任务复用拒绝、并发不同 key 只推进一次 revision。证据：`tools/service-quality-evidence/svc09/svc09-media-clip-retry-runtime-r1.json`。该运行树不是生产部署，PostgreSQL、ffmpeg、ASGI 完整启动和 systemd/soak 仍未证明。
- SVC-09 媒体片段重试又在一次性 PostgreSQL 16 loopback 容器中通过并发回归 `1/1`，确认真实 PostgreSQL 行锁下同一任务只推进一次 revision，并保留两个操作记录；容器仅用于本轮测试，完成后清理。证据：`tools/service-quality-evidence/svc09/svc09-media-clip-retry-postgresql-r1.json`。这仍不代表生产数据库配置、完整 ASGI、ffmpeg 长任务或停机 soak。
- SVC-09 当前候选在补齐运行依赖后，录音上传、转写租约、恢复、迟到 worker 和后台心跳 SQLite 回归通过 `45/45`；PostgreSQL 相关用例另行通过，未把缺少模型的 import stub 当作真实推理。证据：`tools/service-quality-evidence/svc09/svc09-transcription-atomicity-runtime-r11.json`。真实模型、生产数据库、ffmpeg 长任务和重启 soak 仍未证明。
- 状态更新：r11 的 `45/45` 保留为历史合并验证；当前 r12 在两份验证源上修复幂等创建重放重复提交后分别通过 `44/44` 和 `45/45`（命令行显示为 `44 passed, 4 deselected` 与 `45 passed, 5 deselected`），并补齐 `provider_submission_generation` 数据类字段。当前证据：`tools/service-quality-evidence/svc09/svc09-transcription-atomicity-runtime-r12.json`。
- SVC-09 媒体片段幂等唤醒已继续收口：创建和 retry 只有真实 `202` 才提交，durable retry 重放返回 `200`；SQLite `9/9`、PostgreSQL 并发 `1/1`、静态合同 `14/14`。当前证据：`tools/service-quality-evidence/svc09/svc09-media-clip-retry-runtime-r2.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-retry-idempotency-contract-r2.json`。
- 候选虚拟环境已补齐 `asyncpg 0.31.0`；候选进程仍存活，但 `28120/28121 /api/health` 仍报告 `qwen_asr_unreachable`，所以 PostgreSQL/ASR readiness、真实模型质量和性能仍未完成。
- SVC-09 会议状态机本轮在临时隔离 Python 3.13 环境（SQLAlchemy `2.0.51`、aiosqlite `0.21.0`）重跑真实候选源码：provider ACK 栅栏、单资产失败与成功独立收敛、回收站删除/恢复交错、恢复队列按 `created_at → job_id` 公平提交全部通过；临时 SQLite/WAL 数据库和目录已清理。证据：`tools/service-quality-evidence/svc09/meeting-state-fault-injection-r8.json`。该运行未接生产数据库、完整 ASGI、音频模型、远端服务或 GPU；SQLite 串行写入不能替代 PostgreSQL 并发锁验证。
- SVC-09A 针对当前候选源码建立 `svc09-current-source-manifest-r1.json` 后重跑隔离部署演练，11 个步骤全部通过：网关先行升级、旧 worker 停止接收新 claim 并排空、显式 SQLite URL 备份与迁移、一次性 PostgreSQL 16 增量迁移、候选 worker 同质性/任务生命周期、应用回滚均通过；哨兵、临时容器和 SQLite 目录清理为全通过，未接生产数据、远端服务、真实 ASR 或 GPU。证据：`tools/service-quality-evidence/svc09/svc09a-isolated-deployment-rehearsal-r8.json`。仍阻塞发布：真实 FastAPI capability/多进程租约、长音频、GPU 压力、服务器重启、soak，以及生产 ingress/worker drain/runbook 尚未验证；文件型网关身份库仍是单机单进程范围。
- SVC-09A r11 重跑当前源码后新增 README 顺序合同：明确验证“禁止新 claim → 升级并验证网关 → 排空旧 worker → 备份/迁移 → 启动单一新 cohort”的五步顺序，隔离 SQLite/网络隔离 PostgreSQL、回滚和 11 步清理全部通过；移除了演练脚本对 README 顺序的误报阻塞。证据：`tools/service-quality-evidence/svc09/svc09a-isolated-deployment-rehearsal-r11.json`；仍未启动真实 FastAPI gateway、真实 ASR/长任务、生产 ingress/worker drain、服务器重启或 soak，文件型身份库仍为单机单进程。
- SVC-09 本轮在隔离 Python 3.11/依赖环境中补跑候选 ASR 网关完整回归 `48/48`，覆盖完整音频分块、故障注入、幂等 HTTP capability、进程重启恢复和 Whisper runtime identity；同时用真实本地 Uvicorn 进程重跑 cooperative/timeout 两种 SIGTERM 前 admission 场景，两个场景均通过，临时 SQLite 完整性和子进程清理通过。证据：`tools/service-quality-evidence/svc09/gateway-fault-injection-r9.xml`、`tools/service-quality-evidence/svc09/uvicorn-sigterm-shutdown-r9.json`。这仍未启动完整生产 FastAPI、生产 PostgreSQL、真实 ASR 模型、GPU 或远端服务，不能解除发布阻塞。
- SVC-09 本轮用临时 `/tmp/laoji-quality-venv` 补齐 FastAPI/Uvicorn/SQLAlchemy/aiosqlite/httpx 依赖后刷新动态候选证据：会议状态故障注入与真实 Uvicorn cooperative/timeout 停机探针均通过，部署顺序演练以当前 `svc09-current-source-manifest-r1.json` 重新绑定后 11 步通过，PostgreSQL 16 容器、SQLite 目录和哨兵均清理；静态媒体片段 admission `6/6`、重试幂等 `10/10` 保持通过。首次使用过期 r8 证据时被源码 hash 栅栏拒绝，说明旧报告不会覆盖当前候选漂移。证据：`tools/service-quality-evidence/svc09/meeting-state-fault-injection-r8.json`、`tools/service-quality-evidence/svc09/uvicorn-sigterm-admission-r9.json`、`tools/service-quality-evidence/svc09/svc09a-isolated-deployment-rehearsal-r10.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-admission-contract-r1.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-retry-idempotency-contract-r1.json`。仍未覆盖生产 PostgreSQL/完整 ASGI、真实 ASR/ffmpeg 长任务、systemd、服务器重启和 soak。
- SVC-09 当前 r7 源码又通过真实 FastAPI ASGI 录音资产纵向：SQLite 与一次性 PostgreSQL 均 `13/13`，覆盖登记重放、同键改 payload 冲突、错误文件拒绝、原子上传、内容回读、转写任务持久化和无 `.part` 残留；同一 r7 源码在 PostgreSQL 8 轮 spawn 租约竞争中每轮 queued/expired 均恰好一个赢家（`6/6`），替换进程恢复测试 `9/9`，过期任务升到 attempt 2、live lease 保留、可回收文件清理均通过。证据：`tools/service-quality-evidence/svc09/svc09-full-asgi-recording-flow-r3.json`、`svc09-full-asgi-recording-flow-postgresql-r3.json`、`svc09-transcription-postgresql-spawn-race-r3.json`、`svc09-transcription-restart-recovery-spawn-postgresql-r2.json`。数据库和 ASGI 均为 disposable/loopback，真实 ASR、生产配置、systemd、服务器重启和 soak 仍未证明，`promotion_eligible=false`。
- SVC-10 本轮完成隔离 SQLite FTS5/trigram 规模基准：10000 场会议、20000 条索引行、1500 次查询（1005 条正向、255 条跨作用域、240 条已删除），exact Recall@10 `100%`、负向泄漏 `0`，query p95/p99 `6.7785/7.2779 ms`，新 revision 提交后可立即命中；SQLite 构建耗时 `0.1467 s`。证据：`tools/service-quality-evidence/svc10/svc10-search-scale-benchmark-r1.json`。该结果不覆盖 semantic recall、NDCG、真实 app 数据库、跨设备或生产，报告明确 `promotion_eligible=false`。
- SVC-03 最新 readiness 修复已在三个隔离候选入口同步：默认 `MEETING_ASR_ALLOW_DEGRADED=0` 时，支持模型或其特征运行时未就绪不会发送 `config`，首事件为中文 `support_models_not_ready` 并以 1013 关闭；显式预览才发送 `readiness=degraded`、`quality_profile=degraded_preview` 和能力缺口。补齐 Silero/CAM++ 权重及 `torchaudio` 后，真实支持模型 smoke `required_models_ready=true`，完整 r6 ASGI smoke 的 `/api/ready=200`、`speaker_features=true` 和 full config 均通过；生产端口未启动。证据：`tools/service-quality-evidence/svc03/svc03-support-models-real-smoke-r2.json`、`svc03-asgi-dependency-provenance-r2.json`、`svc03-qwen-asgi-real-smoke-r6.json`、`svc03-degraded-readiness-runtime-r1.json`。
- SVC-03 就绪顺序检查器修正了 overlay 配置能力字段中只读 `get_vad_model()` 被误计为“初始化晚于 config”的误报；现在合并 backend 与 qwen overlay 均为 `2/2`，模型管理器缺权重/特征运行时的 fail-closed 合同也在已配置隔离依赖环境中通过。证据：`tools/service-quality-evidence/svc03/svc03-ready-config-contract-r1.json`、`svc03/svc03-model-manager-readiness-contract-r2.json`。
- SVC-04 的 real-model gate 工具测试补齐从仓库根目录运行时的 sibling import，35/35 工具合同可直接复现；本轮仍只覆盖 gate/容量/身份安全，不改变 large-v3 显存不足的发布阻塞。
- 以上仅改变隔离工具、候选依赖和本规划文档；未停止/迁移 PCB、GPU1、`18020/18035/8002/21434/21436`，也未把健康接口当作 ready 证据。

当前执行顺序：SVC-00 已补齐 qwen35 后处理 32/32 候选证据，并新增 broker 有界优雅排空 `8/8` 与完整 broker 回归 `23/23`，但真实模型与性能仍未完成；SVC-01 已完成移动端合同、隔离服务端边界合同和冻结集安全扫描；SVC-02 已完成客户端音频边界、有限路由降级、隔离服务端音频输入边界和 ASR 文本类型边界合同，并保留 CPU small 预览基线，但未达到质量放行；SVC-06 已完成原文支持待办的隔离后置门禁；SVC-07 已补齐候选运行合同 `82/82`，但尚未部署。上述候选均未部署，模型质量和真实设备证据仍未完成。SVC-07 r24 已完成严格质量重评分，r25 共享模型并发结果只作信息性证据；在获得独立模型容量前，不再重复污染 21434 的性能阶梯。SVC-04A 的容量门禁已在不足窗口前拒绝启动，等待更大的无干扰容量窗口。SVC-03 已完成 56 会话真实模型基线、上下文候选、微批候选、隔离合同、GPU0 微批/HTTP smoke、启动预热开启的完整 FastAPI/SQLite/Qwen WebSocket smoke、登录用户/授权隔离、1 倍速长会话与断线清理；Android 模拟器到隔离候选纵向和候选 stop/取消也已通过，但不解除多人/噪声声纹质量、物理真机录音、OOM、soak、性能尾延迟和生产部署门禁。最新容量审计在隔离启动前观察到 GPU0 无 compute PID、候选档可进入，发布档仍因身份未锁定而拒绝；Qwen/ASGI 结束后端口清理，未停止模拟器、GPU1 或其他生产进程。SVC-03 的 Qwen 优先、Whisper-small loopback 回退合同、small/medium CPU 对照和远端 8002 身份探针仍不能证明生产 ASR ready；候选未部署，不得把 `18020/api/health` 当 ASR 就绪。SVC-08 已加入可选 HTTP 地址适配器、隔离代理运行合同和候选部署模板，但公共 provider 当前被出口策略阻断，获批/自托管 provider、真实设备地址成功率和 ROM 矩阵仍未完成。SVC-09 现在已有当前 r7 的 disposable ASGI/PostgreSQL/多进程租约证据，但仍不能外推生产；SVC-10 仍只有隔离候选证据。不得为了 Gate 停止生产 18020/18035、8002、21434/21436 或其他 GPU 服务。下一步继续推进 SVC-03 的多人/噪声/注册声纹质量、物理真机、OOM、soak、性能尾延迟和生产部署；同时补 SVC-00 真模型混合负载/独立容量、SVC-07 真实数据库/ASGI 与独立性能、SVC-09 生产配置/真实 ASR/ffmpeg 长任务、systemd/服务器重启和 soak。旧 8020 继续暂停。

### SVC-03 登录用户链路补充

在严格支持模型 readiness 候选上新增一次性登录用户运行证据：注册 `201`、注销注册会话、重新登录 `200`、`/api/auth/me` `200`；同一 Bearer 会话创建并读取用户会议，使用真实 GPU0 Qwen3-ASR-0.6B 通过授权 WebSocket，收到 `config(readiness=ready, quality_profile=full)`、两段 `transcript.completed` 和 `ready_to_stop`；用户侧转写查询返回 `2` 条且状态为 `complete`；会议删除返回 `204`、删除后读取 `404`；账号删除返回成功，删除后重新登录返回 `401`。证据：`tools/service-quality-evidence/svc03/svc03-authenticated-runtime-r1.json`。该证据覆盖此前“登录用户数据库转写/认证协议”的候选缺口，但仍不覆盖 Android 真握手、真实注册声纹质量、多人/噪声 DER/JER 与 FAR/FRR、长会议、OOM、重启、soak、生产 PostgreSQL 或部署。

随后补做双账号负向隔离：会议所有者读取为 `200`，另一账号读取为 `404`，错误账号的 WebSocket 以关闭码 `1008` 拒绝；两个临时账号和会议均已清理。证据：`tools/service-quality-evidence/svc03/svc03-authz-isolation-runtime-r1.json`。

状态更正：上方“当前执行顺序”中 SVC-03 的“登录用户数据库转写、认证协议”已由本补充覆盖，不再作为待办；SVC-03 下一步只保留多人/噪声/注册声纹质量、物理真机握手与录音、OOM、重启、soak、性能尾延迟和生产部署。

状态补充：隔离候选的 1 倍真实节奏长会话、正常 stop 排空和无 stop 标记断线清理已由 `svc03-qwen-long-session-r7.json` 覆盖；“长会议”不再作为该隔离候选的空白项。Android 模拟器候选纵向已由 `svc03-android-connected-candidate-r1.json` 覆盖，物理真机、生产部署、systemd/服务器重启、OOM/soak 和取消语义仍未完成；候选进程级手动重启已由 r2 单独覆盖。

### SVC-03/SVC-05 CAM++ 诊断与拒识候选补充

本轮用 GPU0 真实 CAM++ 中文权重、真实 Silero/VAD 支持模型和 28 条带明确 TTS 声音标签的会议语音重跑诊断。权重、manifest、运行时均写入 `tools/service-quality-evidence/svc03/svc03-camplus-speaker-noise-diagnostic-r1.json`；`required_models_ready=true`、embedding 为 192 维。结果中旧 `0.5` 绝对阈值的异声误接受为 `57/261`，因此不能把“同声全接受”解释成 unknown rejection 已通过。

候选实时链路新增四层保护：

1. 先检查片段有限值、时长、RMS 和削波比例；短、过静、严重削波或无效片段只保留 `speaker_N/unknown`，不得进入姓名投票。
2. 多资料时同时满足有效 cosine 和 top1-top2 gap；单资料时不把缺失的第二名当作 0 分，使用更高的绝对分数并要求两个独立合格片段后才自动显示资料姓名。
3. 低置信片段不会继承旧 cluster 的姓名投票；原始 `text`、时间轴和聚类标签不被改写。
4. 门禁由 `LAOJI_SPEAKER_MIN_COS`、`LAOJI_SPEAKER_MIN_GAP`、`LAOJI_SPEAKER_MIN_SEGMENT_SECONDS`、`LAOJI_SPEAKER_MIN_RMS`、`LAOJI_SPEAKER_MAX_CLIP_RATIO` 和 `LAOJI_SPEAKER_SINGLE_PROFILE_REQUIRED_VOTES` 覆盖，默认值只代表保守候选，不是最终校准值。

这组逻辑只达到 SVC-05 G1 候选阶段，未改变线上端口或生产数据库；后续真人 cohort 必须分别测登记人、未登记人、相似声线、短片段、噪声和跨账号，并报告 DER/JER/FAR/FRR/unknown rejection。

### SVC-03/SVC-05 无泄漏闭集拒识诊断补充

为避免旧诊断把登记样本和留出样本混用，本轮新增 `tools/service-quality-evidence/svc05/run_campplus_closed_set_eval.py`。它固定 manifest、音频文件和 CAM++/Silero 权重哈希；每一折把某一 TTS 音色完全留作 unknown，仅用另外两个音色各两条 clean 音频登记，其余同音色样本作为已登记留出；噪声与居中的 `1.2 s/0.8 s` 片段只从留出音频生成。GPU0 隔离运行共提取 `168` 个 embedding，`visible_device_count=1`，`required_models_ready=true`，embedding `p95=88.947 ms`。

在候选 `cosine=0.70/gap=0.08` 下，三折合并的 clean 留出为已登记 `44/44` 正确接受、unknown `0/28` 误接受（FAR `0%`、unknown rejection `100%`）；20 dB 和 10 dB 噪声分别 FRR `4.55%` 和 `0%`，0 dB 噪声 FRR `68.18%`；`1.2 s` 片段 FRR `4.55%`，`0.8 s` 片段 FRR `50%`，所有这些合成 unknown 试验 FAR 均为 `0%`。因此该候选策略在当前 TTS 诊断上体现为“宁可拒识也不乱认”，但不能据此把强噪声或短片段标成人名，也不能外推真人阈值。完整阈值扫描、每折登记/unknown 清单和权重 provenance 见 `tools/service-quality-evidence/svc05/svc05-camplus-closed-set-eval-r1.json`；评测纯函数回归 `3/3` 见 `tools/service-quality-evidence/svc05/test_campplus_closed_set_eval.py`。

该证据仍为 `promotion_eligible=false`：三种音色均为合成 TTS，没有真人 cohort、相似声线、跨设备/跨天、重叠发言或逐帧多人标注，DER/JER 明确为 `not_run`。下一步仍必须获得真人录音后重新校准阈值，并补齐 DER/JER、FAR/FRR、profile revision/reprocess、物理真机和生产部署，不能把本轮结果写成 SVC-05 质量放行。

### SVC-03 隔离进程重启恢复补充

使用相同 GPU0 隔离 Qwen3-ASR-0.6B、本地 `meeting_001.wav` 和随机 loopback 端口，新增 4 个独立进程周期。四次均在 `5.211–7.627 s` 内就绪，模型/设备身份均匹配，真实推理均返回 34 字非空文本，四次正文哈希完全一致；provider 推理耗时为 `755–1686 ms`。证据：`tools/service-quality-evidence/svc03/svc03-qwen-restart-recovery-r2.json`。

这只把“候选进程手动重启后能重新加载并保持同一输入输出”提升为可复现证据，仍不覆盖 systemd/服务器重启、ASGI 后端重连、正在处理任务恢复、OOM、生产部署或真机行为，`promotion_eligible=false` 不变。

### SVC-03 长会话与断线补充

本轮在独立 SQLite、GPU0 Qwen3-ASR-0.6B、Silero VAD 和 CAM++ 就绪的隔离 FastAPI 候选上，以 1 倍真实音频节奏并行收发完整 28 条会议音频（总时长 `183.078 s`）。正常 stop 产生 `48` 条最终转写并全部缓存，最大时间轴为 `182880 ms` 且单调，事件顺序包含 `stop_acknowledged → ready_to_stop`，查询和删除均成功；客户端不发送 stop 标记直接断线后，服务端缓存稳定为 `16` 条、删除成功且健康状态保持为真。证据：`tools/service-quality-evidence/svc03/svc03-qwen-long-session-r6.json`。

同一探针的突发灌入模式触发了候选队列溢出，并返回“实时转写处理不过来，将使用本地录音恢复”，因此该模式被保留为压力发现，不与正常实时输入混为通过。证据：`tools/service-quality-evidence/svc03/svc03-qwen-long-session-r3.json`。探针本身已改为无代理短超时、并行收发、断线后等待缓存稳定和失败落盘；这些证据仍不覆盖 Android 真握手、生产 PostgreSQL、服务重启、OOM、soak、真人声纹 cohort 或生产部署。

断线日志还发现 Starlette 在客户端先关闭时可能抛出 `RuntimeError: WebSocket is not connected`。两套候选 `qwen_ws.py` 已在备份后加入特定异常分类：该状态按正常客户端断线收敛，其他异常仍打印堆栈；两套源码 `py_compile` 和静态 guard 检查通过。证据：`tools/service-quality-evidence/svc03/svc03-disconnect-runtime-contract-r1.json`。这只是候选生命周期日志修复，尚未在真实候选 ASGI/Android 链路上运行。

隔离验证副本复测了 8 条真实节奏音频：正常 stop、断线清理和健康检查全部通过，日志出现 1 次正常 `client disconnected`，没有该特定 RuntimeError 或通用 WebSocket 失败堆栈。证据：`tools/service-quality-evidence/svc03/svc03-disconnect-runtime-r2.json`、`svc03-qwen-long-session-r7.json`。该复测仍不等于生产部署或 Android 真握手。

本轮继续修复默认 Qwen 候选的停止生命周期：`qwen-asr-default` 与 `qwen3-asr-test` 现在在收到空帧后先发送 `stop_acknowledged`，再以有界 sentinel 入队和 worker drain；正常停止使用 `QWEN_ASR_FINAL_DRAIN_TIMEOUT_SECONDS`，客户端断线使用更短的 `QWEN_ASR_DISCONNECT_DRAIN_TIMEOUT_SECONDS`，只有 drain 成功才发送 `ready_to_stop`。源码结构与最小行为合同 `24/24` 通过，证据：`tools/service-quality-evidence/svc03/run_bounded_drain_contract.py`、`tools/service-quality-evidence/svc03/svc03-bounded-drain-contract-r1.json`。该合同仍是候选证据，不证明已运行的 ASGI、底层 Qwen 请求线程可被真正中断、Android 或生产行为。

Qwen 推理进程又在随机 loopback 端口完成两轮真实手动重启恢复：每轮均加载同一 `Qwen3-ASR-0.6B`、声明 `cuda:0`、健康就绪并完成 `meeting_001.wav` 非空转写，两轮输出哈希一致，SIGTERM 后端口均释放。证据：`tools/service-quality-evidence/svc03/svc03-qwen-restart-recovery-r1.json`。这只证明进程级恢复和模型身份稳定，不解除 systemd/服务器重启、后端重连、生产部署或 Android 门禁。

### SVC-03 Android 候选纵向补充

本轮在 `emulator-5560`（KataCR API 30，Android 11）上运行 `RealtimeAsrCandidateRuntimeTest`，通过显式 `Proxy.NO_PROXY`、`adb reverse tcp:28135` 和 guest header 访问一次性 SQLite/ASGI 候选。测试发送 `meeting_001.pcm`（16 kHz、单声道、7.368 s），原生 `RealtimeAsrSocket` 收到 `config` 和非空 `transcript.completed`，停止流程收到 `ready_to_stop`，随后读取服务端转写缓存并删除游客会话；主动取消用例也确认取消后不产生传输失败误报，会话仍可查询并可撤销清理；JUnit `2/2` 通过、native transport failures 和 server errors 均为 0。证据：`tools/service-quality-evidence/svc03/svc03-android-connected-candidate-r1.json` 及其 JUnit XML。

该证据只把 Android 模拟器→候选服务的协议和纵向数据流提升为已验证；不代表物理手机录音质量、生产服务、真实 PostgreSQL、多人/噪声声纹、OOM、重启或 soak 已通过。指示文档中较早的“Android 真握手未完成”表述由本段和上方进度账本修正为“模拟器候选握手已完成，物理真机仍未完成”。

### SVC-03 有界停止补充

默认 qwen 候选新增 `stop_acknowledged → bounded drain → ready_to_stop` 协议和断线短超时，并把 segment 入队改为非阻塞；队列溢出会给出中文恢复提示且禁止伪造 `ready_to_stop`。结构与最小行为合同 `30/30` 通过；该条只补充候选生命周期证据，不提高 SVC-03 的生产质量等级。证据：`tools/service-quality-evidence/svc03/svc03-bounded-drain-contract-r1.json`。

### SVC-03 当前容量审计

清理前一轮隔离服务后重新执行只读容量审计：GPU0 为 RTX 4060 Laptop、总显存 `8188 MiB`、已用 `125 MiB`、空闲 `7684 MiB`，当时没有 compute PID；因此 `gpu0_candidate` 可进入，`release` 仍因模型/依赖身份未锁定而拒绝。随后在该隔离窗口用 GPU0 启动 Qwen3-ASR-0.6B、Silero VAD 和 CAM++，服务结束后显存与监听端口均恢复。GPU1、PCB、模拟器和生产服务均未触碰；8030、8002、28120、28121 未被本轮使用。证据：`tools/service-quality-evidence/svc03/svc03-runtime-capacity-audit-r1.json`。该结果只说明资源条件和 fail-closed 行为，不是最终模型质量或生产部署完成证据。

容量审计刷新（当前现场）：GPU0 只读快照为已用 `309 MiB`、空闲 `7500 MiB`，唯一 compute PID 是 `emulator-5560` 的 qemu；8030、8002、28120、28121 均连接拒绝。资源选择器继续允许 `gpu0_preview/whisper-small` 的容量准入，但对 `gpu0_candidate` 和 `release` 返回 `gpu_not_quiet_or_owner_unverified`；本轮未启动、停止或迁移任何服务。更新证据仍写入 `tools/service-quality-evidence/svc03/svc03-runtime-capacity-audit-r1.json`，不改变真实模型质量、物理真机或生产部署结论。

### SVC-03 启动预热与真实停止握手补充

隔离启动时设置 `MEETING_ASR_WARMUP_ENABLED=1`、`MEETING_WHISPER_WARMUP_ENABLED=0`，并显式绑定本地模型目录、`cuda:0` 和临时 SQLite。服务在首个请求前完成 Silero VAD、CAM++ 中文模型及特征运行时探测，`/api/ready=200`；真实 `meeting_001.wav` 通过 FastAPI/WebSocket 完成 `config → stop_acknowledged → transcript.completed×2 → ready_to_stop`，游客缓存读取和删除成功。真实停止探针的 `ack_after_stop` 约 `213 ms`、`ready_after_stop` 约 `593 ms`，没有服务端错误，会议文字缓存与实时结果一致。证据：`tools/service-quality-evidence/svc03/svc03-qwen-asgi-real-smoke-r8.json`、`tools/service-quality-evidence/svc03/svc03-real-model-stop-realtime-r3.json`。

同一源码在关闭启动预热时，首个 `/api/ready` 明确为 503，第一次 WebSocket 才触发支持模型加载，随后 readiness 恢复 200；这不是协议失败，但会把模型加载延迟转嫁给首个用户，因此该模式只允许诊断，不得作为生产启动配置。证据：`tools/service-quality-evidence/svc03/svc03-qwen-asgi-lazy-readiness-r1.json`。

本轮在同一完整候选源码根目录上重新启动 GPU0 `Qwen3-ASR-0.6B`、Silero VAD 和 CAM++，使用临时 SQLite、loopback `28134/28135`，并在结束后确认两个端口释放、GPU0 仅恢复为模拟器占用。单条 `meeting_001.wav` 的真实停止探针通过 `config → stop_acknowledged → transcript.completed×2 → ready_to_stop`，`ack_after_stop=772 ms`、`ready_after_stop=2002 ms`，无服务端错误，实时与缓存文字哈希一致，游客删除返回 `204`。证据：`tools/service-quality-evidence/svc03/svc03-real-model-stop-realtime-r4.json`。

同一隔离候选又以 3 条固定语音（总时长 `20.912 s`，4 倍输入速度）覆盖正常 stop 和客户端提前断线：正常路径产生并缓存 `6` 条最终转写，时间轴单调，断线后缓存稳定为 `2` 条并成功删除，健康状态在两条路径后仍为真。断线路径记录了客户端断开而非服务端错误；该结果与 Android `RealtimeAsrSocket.cancel()` 的既有 `2/2` 候选合同相互独立，不能把一次 WebSocket 断线等同于物理真机取消体验。证据：`tools/service-quality-evidence/svc03/svc03-qwen-long-session-r8.json`、`tools/service-quality-evidence/svc03/svc03-android-connected-candidate-r1.json`。

这轮只提升了 GPU0 隔离候选的停止排空、异常断线缓存和资源清理证据；模型仍为 `0.6B`，输入为固定语音且未覆盖生产 ASGI/PostgreSQL、真实多人/噪声声纹、OOM、服务器重启、soak 或物理真机。因此 `promotion_eligible=false` 不变，不能据此解除 SVC-03 的发布门禁。

### SVC-07 问答响应体截止时间补充

会议问答客户端现在将请求预算和响应体读取分开处理：模型/检索请求仍遵守 30 秒 `fetchWithTimeout`，收到响应头后，小型 JSON 响应另有 5 秒 body deadline，并继续响应页面的 AbortController；卡住的 `response.json()` 不会让问答面板永久停留在“正在回答”。动态合同 `3/3` 通过；证据：`tools/service-quality-evidence/svc07/svc07-question-response-body-contract-r1.json`。这只证明客户端边界，不代表真实 9B 模型、生产 ASGI 或性能 Gate。

### SVC-07 客户端问答路径与账号边界补充

本轮用真实移动端 `meetingQuestions.ts` 通过本地模拟 HTTP 响应复现并覆盖六个分支：游客请求只走 `/api/laoji/meetings/guest-questions` 且不带 Authorization；账号同步会议走 `/api/laoji/meetings/{remote_id}/questions` 并携带令牌；服务端 fresh capability 返回 `meeting_questions_v1=false` 时拒绝发送；账号会议存在远端标识但令牌缺失/过期时立即以中文登录失效错误失败，不再把完整本机文字记录静默降级发送到游客接口；503 错误保留结构化状态；响应头已到但 JSON body 停滞时在 5 秒内收敛。证据：`tools/service-quality-evidence/svc07/svc07-question-client-route-contract-r1.json`，源码包含 `src/data/api/v2/meetingQuestions.ts` 与 `src/services/meetingQuestions.ts` 的当前哈希。

这组是客户端路由和安全边界的模拟合同，不是远端模型、真实数据库、ASGI、网络、真机或性能 Gate；报告明确 `promotion_eligible=false`。未同步且没有远端会议标识的账号会议仍可使用游客计算路径，但不会被误称为账号云端问答。当前源码 Preview `versionCode=106` 已重建，APK SHA-256 为 `5afc048b56110bba665ca7ac1068db8fcce6812e63c5dd7bc78146c6041e7b78`；无物理手机时不向保留给其他工作的 `emulator-5560` 安装。

同一轮还用模拟本机仓储覆盖了能力开关、缺失会议、实时草稿和 ready final Transcript 四种前置状态：能力关闭或本机证据不存在时不发远端请求；草稿/未完成文字记录明确拒绝；ready final Transcript 才创建本机问答线程。证据：`tools/service-quality-evidence/svc07/svc07-question-precondition-contract-r1.json`。该报告只证明前置状态机，不替代真实 SQLite、服务端能力响应或模型运行。

### SVC-08 地址请求截止时间补充

HTTP 地址适配器的超时边界已覆盖完整请求生命周期，而不只覆盖连接建立：响应头已返回但响应体 `text()` 长时间不结束时，同一 5 秒 deadline 会触发 AbortController，并回退到已验证坐标；非成功状态、畸大响应和损坏 JSON 仍 fail-closed。响应归一化现在同时支持自定义 `address_parts`、常见嵌套 `display_name/address` 和 `result.addressComponent`，显式配置的 HTTP provider 会先于系统粗粒度结果，合同由 `9/9` 扩展为 `12/12`；证据：`tools/service-quality-evidence/svc08/svc08-reverse-geocoder-contract-r2.json`。该改动只增强地址服务失败时的可恢复性、供应商响应兼容性和结果优先级，未连接真实地址提供器，也不改变模拟器/真机地址成功率结论。

### SVC-03 服务未就绪文案补充

客户端错误归一化新增 `support_models_not_ready`、`models_not_ready` 和 `qwen_asr_unreachable` 的中文分支，统一提示“实时转写服务暂时未就绪，录音仍会保存在本机，请稍后重试”，不再把候选服务 readiness 失败误报成麦克风权限失败；该映射只改变用户可见文案，不改变录音保本机和转写重试策略。源码检查与 TypeScript 编译通过。

### SVC-03 可恢复服务错误终态补充

原生 `RecorderEngine` 现在把实时转写过程中的可恢复 `SERVER_ERROR` 与终态失败分开：录音仍在进行时照常发出可恢复提示并保留 `transcriptRecoveryRequired`；最终 `ready_to_stop` 排空成功后清除该错误，不再让一次中途服务告警把已保存录音标为失败；真正的断线、停止确认超时、存储错误仍保持失败。终态晚到的服务告警也会被忽略。源码合同 `4/4`、Android `assembleDebug` 均通过；证据：`tools/service-quality-evidence/svc03/svc03-recorder-recoverable-error-contract-r1.json`。该证据仍不替代物理真机录音、真实服务和长会话验证。

### SVC-03 上下文并发候选补充

本轮把两类并发结果分开记录。原始 Qwen HTTP provider 完全忽略 `X-Laoji-ASR-Terms-B64`，4 路并发三轮虽然 `12/12` 请求完成，但只有 `6/12` 规范化一致，词表隔离失败 `12` 项；证据：`tools/service-quality-evidence/svc03/svc03-qwen-gpu-concurrency-r2.json`。该 provider 不得作为上下文候选。

已审计的 `qwen3-asr-test` 上下文候选在同一 GPU0、同一 Qwen3-ASR-0.6B 和同一固定音频上达到 `12/12` 规范化一致、`12/12` `context_applied=true`、无请求错误，但全局 `INFERENCE_LOCK` 使客户端 RTT p50/p95 为 `5274/6596 ms`，队列等待 p50/p95 为 `3975/5507 ms`；证据：`tools/service-quality-evidence/svc03/svc03-qwen-gpu-concurrency-context-r1.json`。质量接线通过，性能 Gate 失败。

隔离微批候选只作为后续优化实验：请求仍由单一模型所有者线程处理，在不超过 12 ms 的窗口内按每条请求的音频、上下文和语言对齐批量调用 Qwen 列表接口，默认关闭。真实 GPU0 HTTP 纵向三轮四路共 `12/12` 完成、规范化一致 `12/12`、词表隔离失败 `0`；RTT p50/p95 为 `2058/5205 ms`，队列等待 p50/p95 为 `808/3713 ms`，相较锁串行候选有改善但仍未达到发布门槛。微批结构合同 `27/27`、候选源码 `py_compile` 通过；证据：`tools/service-quality-evidence/svc03/svc03-qwen-gpu-concurrency-microbatch-r1.json`、`tools/service-quality-evidence/svc03/semantic-candidate/qwen_microbatch_service.patch`。

微批仍未接入生产或默认配置，不能替代完整 56 会话 context=off/on 回归、真实 WebSocket/VAD、切段尾延迟、多人噪声声纹、OOM、soak、物理真机和部署重启证据。实验进程和回环端口已释放，GPU0 恢复为仅模拟器占用；`promotion_eligible=false` 保持不变。

### SVC-05 阈值扫描结论

在同一无泄漏三折 TTS 诊断上，默认 `cosine=0.70/gap=0.08` 的 0 dB 已登记人拒识率为 `30/44=68.18%`，未知音色误接受为 `0/28`；候选 `cosine=0.65/gap=0.08` 可将 0 dB 拒识降为 `10/44=22.73%`，clean、20 dB、10 dB 和 1.2 秒切片的已登记样本均保持 `0%` 拒识，当前未知音色 FAR 仍为 `0%`。完整扫描见 `tools/service-quality-evidence/svc05/svc05-camplus-closed-set-eval-r1.json`。

该结果只允许把 `0.65` 记录为待真人校准的候选配置，不改变默认阈值，也不放宽“宁可未知、不高置信错认”的合同。真人、相似声线、跨设备/跨天、重叠发言、真实噪声和 DER/JER/FAR/FRR 仍是 SVC-05 的放行条件。

### 1.5 SVC-03 本轮 WebSocket/VAD 结论

本轮使用隔离 GPU0、一次性 Qwen3-ASR-0.6B、临时 ASGI/SQLite 和真实 16 kHz PCM，通过完整 WebSocket 逐条发送会议冻结集 28 条音频；manifest 文本只作评测参考，默认 context-off 不发送词表。候选源码将跨段去重从“至少 4 字”收紧为“时间轴确认重叠且至少 2 字”，匹配时忽略边界标点，避免 400ms VAD 前置音频造成“下午/观察”等重复，同时保留单字重复和不重叠文本，拒绝猜测模型漏字；merged candidate 与 summary backend 两个候选源均通过 `4/4`。评测器同步修正逐字中文数字串（如端口/错误码）的归一化，合同 `5/5`。此外，purpose-specific VAD 合同在两个候选源均为 `2/2`：会议最大语音段 9 秒，日程仍为 6 秒。证据 `tools/service-quality-evidence/svc03/qwen_ws-meeting-max-speech-r1.patch`、`tools/service-quality-evidence/svc03/svc03-qwen-vad-policy-contract-full-candidate-r1.json`、`tools/service-quality-evidence/svc03/svc03-qwen-vad-policy-contract-summary-backend-r1.json`、`tools/service-quality-evidence/svc03/svc03-qwen-overlap-reconciliation-contract-r2.json`、`tools/service-quality-evidence/svc03/svc03-qwen-overlap-reconciliation-summary-backend-contract-r1.json` 与 `tools/service-quality-evidence/svc03/svc03-quality-normalization-contract-r1.json`。

完整候选结果为两次 `28/28` 完成、`28/28` 有最终转写、生命周期/缓存/删除全部通过、无 provider/protocol 错误。9 秒会议切段的 context-off r5 为规范化 exact `21/28`，CER 均值 `1.26%`、p95 `6.01%`，关键术语召回 `80/84=95.24%`，provider segment-tail p95 `413.9 ms`、max `552 ms`；显式配置 9 个诊断词的 context-on 为 exact `25/28`，CER 均值 `0.39%`、p95 `3.53%`，关键术语召回 `82/84=97.62%`，provider segment-tail p95 `317.25 ms`、max `690 ms`。context-on 修复了 M005、M008、M025、M026、M027、M028 的词项，但使原本正确的 M018、M022 回退，M017 的开头语气词仍缺失；因此不能把该全局词表结果解释成无条件模型质量提升，也不能把词表默认注入生产。当前候选只能保留 9 秒会议 VAD 和“显式、按会话受控词表”的实现方向，放行前还需要独立 holdout 的 context-off/on 零 C1 回退、真实 context 泛化、真实多人/噪声声纹、真机、OOM、重启和 soak 证据。证据 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-r5-max-speech-digit-normalization-current.json`、`tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-context-on-r1.json`，候选源修改前备份为 `tools/service-quality-evidence/svc03/source-backups/qwen_ws.full-candidate.before-short-overlap-r1.py`。

## 2. 统一质量工程框架

### 2.1 风险等级

| 等级 | 定义 | 例子 | 放行规则 |
|---|---|---|---|
| C0 致命 | 数据、安全或不可逆语义错误 | 录音丢失、串账号、错误删除、未授权内容进入模型、错误日期被静默保存 | 必须为 0；一例即停线 |
| C1 关键 | 用户会据此采取错误行动 | 否定词丢失、截止日期错、讲话人错认且高置信、虚构决定/待办、引用不支持答案 | 冻结集必须为 0；灰度出现即回滚 |
| C2 主要 | 功能可用但明显错误或过慢 | 标题严重泄漏、漏掉关键议题、问答超时、处理任务卡死 | 按服务阈值；不得只看总平均 |
| C3 次要 | 不改变核心含义 | 分类色不理想、措辞略显生硬、地址格式冗余 | 可作为非阻塞优化，但必须记录 |

### 2.2 数据集分层

每个服务的数据集都必须有不可互相污染的四层：

1. `dev`：开发可见，用于定位和调参；
2. `regression`：固定回归，只在候选完成后运行；
3. `holdout`：提示词、规则和模型选择阶段不可见，由独立脚本只输出分数；
4. `shadow`：来自真实交互的匿名化结构特征或用户明确授权样本，只评估不写回产品结果。

建议比例为 45% / 25% / 20% / 10%。同一句话的改写、同一音频的编码版本、同一会议的切片必须落在同一 split，避免数据泄漏。

所有 case 使用版本化 JSONL manifest，至少包含：

```json
{
  "case_id": "stable-id",
  "dataset_version": 1,
  "service": "schedule_text",
  "split": "holdout",
  "severity": "C1",
  "input_ref": "sha256:...",
  "expected": {},
  "slices": ["correction", "date_range", "asr_noise"],
  "privacy": "synthetic|consented|anonymized",
  "max_server_ms": 1800
}
```

正文、音频、人名、地点不写入普通日志；证据只记录 case ID、hash、标签、状态、时长桶和错误码。

### 2.3 评分规则

- 可确定字段使用 exact match 或规范化 match，不用模型裁判。
- 语义事实按预标注 fact unit 计算 precision/recall/F1。
- 引用必须由程序验证 source ID、范围和 quote；人工只判断引用是否真正支持结论。
- 讲话人使用 DER/JER、EER、FAR/FRR 和 unknown rejection，不使用“看起来差不多”。
- ASR 同时报告 CER、关键槽位召回和边界语义通过率；高字符相似度不能掩盖否定、数字、负责人或日期错误。
- 生成式服务至少三次固定 seed/配置重复；除 C0/C1 外报告 95% 置信区间下界。
- 总分达标但任一 C0/C1 或关键 slice 未达标，整体仍失败。

### 2.4 延迟与资源测量

每个请求记录以下分段，不允许只记录客户端总耗时：

```text
client_total
  ├─ network_rtt
  └─ server_total
       ├─ auth_and_validation
       ├─ queue_wait
       ├─ model_load_or_warmup
       ├─ inference
       ├─ verification_or_repair
       └─ persistence
```

每项至少覆盖：

- 冷启动、暖机、模型被逐出后三种状态；
- 并发 1/2/4，后台长整理与交互请求混合；
- p50/p95/p99/max，而不是只报 median；
- CPU、GPU compute、显存、RSS、队列深度、失败和取消；
- 30 分钟短 soak 与候选版 2 小时 soak；
- 公网端到端和服务器 loopback 两组数字。

### 2.5 六级改进流程

每个服务都按同一流程推进：

1. **G0 基线冻结**：固定源码 hash、模型 digest、环境、数据集、当前输出和资源曲线；
2. **G1 离线候选**：只跑 dev；通过后运行 regression，不触碰线上；
3. **G2 盲测**：运行 holdout，完整输出差异和置信区间；
4. **G3 隔离服务**：使用 loopback 临时端口，执行并发、混合负载和故障注入；
5. **G4 影子流量**：复制输入但不写数据库、不返回给用户，比较候选与稳定服务；
6. **G5 小流量发布**：测试账号→内部账号→受控比例；满足观察窗口后再默认开放。

任何阶段都必须保存一键回滚材料。数据库只允许 additive migration；模型候选不得替换唯一可恢复副本。

### 2.6 相比旧日程解析评测的最低升级量

| 旧做法 | 新最低要求 |
|---|---|
| 1000 条启发式诊断 + 100 条分层回归 | 3000 条冻结文本、1000 组 metamorphic pair、1500 条短语音，并拆分 dev/regression/holdout/shadow |
| hard/review flag 为主 | exact field、关键槽位、clarification precision/recall、校准误差和 C0/C1 独立计分 |
| 聚焦测试或受影响类别通过 | 候选发布前一次性重跑完整冻结集；受影响类别只用于开发定位 |
| median/p90/max | 冷/暖/逐出、loopback/公网、p50/p95/p99/max 和混合负载退化 |
| 人工构造文本为主 | 真人授权样本、真实手机音频、独立标注、盲测和真实 shadow |
| 单服务测试 | 长整理、问答、日程、嵌入和实时 ASR 的共同 GPU/队列压力 |
| “模型返回 JSON”即通过 | 结构、来源、事实支持、幂等、恢复、隐私和资源同时通过 |

这张表是所有服务的下限。音频、总结和问答不强求都用“3000 个 API 请求”这一种计量单位，而应分别以小时数、fact unit、问题 turn 和故障序列达到更高证据密度。

### 2.7 Linux/Windows 开发兼容

- 评测 runner 使用 `python3`、`pathlib`、参数数组形式的 subprocess 和 JSONL manifest；不得把 `/tmp`、GNU `sed` 或 Bash process substitution 写进核心评分逻辑。
- 音频转码、hash、统计和报告生成在 Linux 与 Windows 开发机均可运行；仅服务部署、systemd、GPU/cgroup 检查保留 Linux adapter。
- Windows/CPU 环境无法执行 GPU gate 时必须标为 `not_run`，不能把 skip 计成通过；权威性能与显存结论只来自目标 Linux GPU 环境。
- 本机批量构造语料或离线评分可使用所有空闲自有 CPU/GPU；共享服务器仍须遵守进程所有权和显存安全余量，不占用无关用户任务。

### 2.8 模型、显存与依赖自适应

模型大小不是产品接口。所有 ASR、整理、问答和嵌入服务必须通过稳定的请求/响应合同消费模型，模型名称、权重、量化、设备和并发上限属于服务端可替换配置；客户端不把模型名称写入业务逻辑，也不因为最终模型替换而强制重发 APK。

#### 2.8.1 资源档位

候选服务启动前执行一次资源预检，使用 NVML/运行时实际值，不使用机器名或配置文件中的显存宣称值。预检至少读取：GPU UUID、驱动/NVML 版本、空闲显存、现有 compute PID、进程所有者、模型 runtime fingerprint、磁盘临时空间和依赖导入结果。GPU 1 与无关进程（包括 PCB 服务）永远不在自动调度范围内。

统一使用以下逻辑档位，具体模型由注册表选择：

| 档位 | 用途 | 允许行为 | 完成含义 |
|---|---|---|---|
| `cpu_contract` | Windows/无 GPU 开发、结构和恢复合同 | 规则路径、stub/小模型、离线评分；GPU gate 标记 `not_run` | 只证明协议和数据正确 |
| `gpu0_preview` | 当前服务器无独立大显存窗口时的纵向开发 | 复用已存在的轻量 ASR/嵌入模型；GPU 重任务串行；不停止 PCB、GPU1 或生产服务 | 可完成端到端功能和回滚演练，不等于最终质量放行 |
| `gpu0_candidate` | GPU0 预检满足候选模型余量时的隔离验证 | 允许注册表中指定的 medium/turbo/量化模型；加载前后保留安全余量，超限立即拒绝 | 可取得真实模型候选证据 |
| `release` | 小流量/正式上线 | 选择质量、p95/p99、OOM 和成本同时达标的模型 digest；配置变更可回滚 | 只有该档位满足服务对应质量门槛才算完成 |

选择规则固定为：先过滤 `min_free_mib`、驱动、依赖和模型指纹，再在剩余候选中选质量最高且资源/SLO 达标者；没有候选满足条件时只能降到 `gpu0_preview` 或 `cpu_contract` 并显式返回 `quality_profile`。`admission_ready/capacity_ready` 只表示允许进入下一步，只有 provider readiness 和真实 runtime fingerprint 通过后才能置 `model_ready=true`，不得把容量通过假装模型 `ready`。预检必须在模型加载前拒绝不足窗口，加载后再次确认剩余显存；不得为了腾挪显存停止或迁移未授权进程。

#### 2.8.2 模型注册表和替换合同

每个候选模型登记以下字段：`service`、`profile`、`model_id`、权重/容器 digest、量化和 dtype、目标设备、最小启动显存、加载后最小余量、最大并发、上下文/token 上限、预期延迟、已通过的数据集版本、回滚模型和依赖锁文件。运行时把注册表条目和实际 runtime fingerprint 写入 `/api/ready`、任务 provenance 和评测报告。

模型替换只允许改变注册表和服务端环境变量；输入输出 schema、错误码、幂等键、来源引用和持久化格式不得随模型变化。替换后必须重新运行受影响服务的冻结集、资源预检和冷/暖/逐出性能阶梯；轻量档通过只证明候选可用，不能覆盖最终档位的 C0/C1 或质量证据。

#### 2.8.3 依赖自动补齐和缓存

开发或候选环境缺少依赖时，可以由执行器自动完成以下流程，不要求用户手工逐包安装：

1. 根据平台（Linux/Windows）、Python 版本、CUDA/cuDNN、架构和服务 profile 解析锁定依赖清单；优先使用项目锁文件和本地缓存。
2. 下载前检查代理、磁盘、校验和及目标目录；下载使用临时文件、断点续传和 SHA-256，完成后原子改名，不覆盖正在运行的环境。
3. GPU 包安装后执行目标解释器真实 import、CUDA tensor、模型最小加载和显存释放 smoke；把 `_ARRAY_API`、NumPy ABI 等导入警告按 fail-closed 处理，不能只看 import 返回成功；只通过 `pip check` 不得算成功。缺少 GPU 时保留 CPU 合同路径并记录 `not_run`。当前运行时探针为 `tools/service-quality-evidence/common/run_runtime_import_smoke.py`，其结果必须进入依赖/模型 provenance。
4. 模型权重按 `model_id/digest` 版本化缓存，旧版本保留到回滚窗口结束；禁止以“下载完成”代替模型 ready。
5. 每次自动配置生成脱敏 provenance：解释器、包锁 hash、驱动、模型 digest、设备、profile、安装命令摘要和失败原因；Linux 的 systemd/cgroup 只由 Linux adapter 执行，核心评测 runner 保持 Windows 可运行。

当前服务器可先使用 `gpu0_preview` 完成纵向开发：GPU0 保持 PCB 和现有生产服务不动，轻量 Whisper/嵌入沿用已加载实例，长任务通过 SVC-00 串行调度；`large-v3` 或新的 9B 实例只有在预检满足余量并取得独立候选证据后才能进入 `gpu0_candidate`。Qwen ASR 不可达属于依赖 readiness 失败，不能用换 Whisper 大小掩盖。

## 3. SVC-00 推理调度与资源隔离

### 3.1 目标

消除长整理/问答阻塞日程解析，避免模型反复加载，保证实时 ASR 不被生成式任务挤占。该服务先于所有模型调参，因为当前共享单并发 runner 会污染每个速度结论。

### 3.2 改进流程

1. 给 `18020/18035/21434/21436` 增加统一 trace ID 和 queue/load/inference 分段指标。
2. 复现当前串行 runner 的混合负载基线。
3. 并行比较三个候选：
   - 单 runner + 交互优先队列 + 可取消后台任务；
   - 单 runner `num_parallel=2`，但限制总 context/token；
   - 独立 schedule runner，前提是 GPU 0 峰值显存仍保留至少 2 GiB 安全余量。
4. 选择质量不降、p99 最稳且无 OOM 的方案；不能因 median 更快就采用。
5. 将 owned 进程改为可控 service unit，支持 graceful drain、自动拉起、健康依赖和启动预热；不得接管 GPU 1 的无关 VLLM。

### 3.3 测试用例

- 20 个长整理任务运行时插入 100 个规则日程和 40 个模型日程；
- 8 个问答、20 个整理、18 个复杂日程、4 个实时 ASR 会话同时运行，重复 5 波；
- 嵌入模型冷启动、9B 模型冷启动和两者交替；
- 取消排队中的问答、取消运行中的整理、客户端断开；
- GPU OOM、模型进程退出、服务进程退出、磁盘日志写失败；
- 后台队列持续有任务时，交互请求不得饥饿；
- 服务器重启后服务依赖顺序、预热、未完成任务恢复和无重复执行。

### 3.4 验收标准

- C0/C1 为 0，连续混合负载不得 OOM；
- 实时 ASR segment-tail p95 ≤ 1.2 s、p99 ≤ 1.8 s；
- 规则日程 server p95 ≤ 20 ms、p99 ≤ 50 ms；
- 模型日程 queue+inference p95 ≤ 2.0 s、p99 ≤ 3.5 s；
- 短会议整理 p95 ≤ 8 s，会议问答 p95 ≤ 8 s；
- 混合负载相对隔离单服务的 p95 退化 ≤ 30%；
- 任一交互请求排队不超过 2 s，后台任务不得永久饥饿；
- 服务重启后 60 s 内恢复可用，持久任务不重复、不丢失。

### 3.5 当前候选决策边界

实时进程核对表明，`21434` 是生产 `18020/18035` 共用的 9B Ollama，且 `OLLAMA_NUM_PARALLEL=1`；候选 broker 的旧上游也指向它。因此不得为了验证“保留交互槽”而重启 `21434`、修改其并发或把候选负载误称为独立 9B 证据。

当前安全候选改为 `SVC-00B：独立 4B 交互 runner`：

1. 整理继续使用 9B 后台路径；会议问答与模型日程使用候选自有 `28433` 4B runner；
2. 会议问答先以 SVC-07 的 1911 条全集和并发阶梯证明质量；
3. 日程规则路径沿用 SVC-01 v5 证据，另建复杂模型 fallback 集比较 4B 与当前 9B，不能用 2 ms 规则样本外推模型能力；
4. 一条长整理运行时，向独立 4B 同时插入冻结问答和复杂日程，检查交互 queue wait、答案字段、GPU 显存和无模型重载；
5. 只有 4B 两类交互质量均通过，才允许把它作为 SVC-00A 的替代方案。若日程 fallback 质量不达标，再评估只迁移问答或等待真正独立的 9B 容量。

本地 broker 的 `concurrency=2 + max_active_background=1` 实现继续保留，但在取得独立且真实支持并行的上游前只算调度器能力，不算服务性能 Gate。

## 4. SVC-01 日程文本解析与多轮澄清

### 4.1 架构改进

1. 将输出拆成 `intent → temporal AST → title/location/details → recurrence/reminder → validation`，避免一个大正则或一次 LLM 调用同时决定全部字段。
2. 明确三种结果：`complete`、`needs_clarification`、`not_schedule`；禁止以低置信候选冒充 complete。
3. 确定性日期、时间、范围、否定和更正优先；模型只补规则不能确定的语义槽位。
4. 模型输出始终经过 spoken-fact reconciliation。任何模型日期/时间若未在用户输入或澄清回答中得到支持，必须追问。
5. 澄清改成显式状态机，保留初次 reference datetime/timezone；支持连续补日期、地点、范围和修正前一回答。
6. 对 confidence 做真实校准；只有校准后的风险分数用于自动保存边界。
7. 本机 `localScheduleParser.ts` 与服务端共享 fixture 和规范化合同，但不复制两套不断漂移的规则实现。

### 4.2 严格语料

新冻结集至少 3000 条文本，规模和强度均高于旧 1000 条诊断：

| 切片 | 最少条数 | 代表用例 |
|---|---:|---|
| 明确日期/时间/时长 | 400 | `明天下午三点开会`、跨午夜、月末、闰日 |
| 日期/时间范围 | 300 | `8月21号到18号`、`下周一到周三每天九点` |
| 更正/否定/反悔 | 350 | `不是周四，是下周五两点到四点` |
| 重复与有限范围 | 250 | 每周、每月、每年、从某日开始、有限连续天 |
| 提醒/地点/标题/备注 | 350 | 地点不确定、标题指令、提醒数字不能变成钟点 |
| 多轮澄清 | 350 个对话，≥900 turn | `开会`→`明天下午三点`→`改成四点` |
| ASR 文本噪声 | 450 | 同音、漏“点/号”、填充词、重复、自我修正 |
| 非日程/元指令/注入 | 350 | `不要创建，只测试麦克风`、问答、说明文本 |
| 时区/DST/年边界 | 200 | IANA timezone、夏令时缺口/重复时间、跨年 |

额外生成不少于 1000 组 metamorphic pair：加标点、同义改写、无意义填充词、简繁体、阿拉伯/中文数字后，核心语义必须不变；加入否定或更正后，结果必须按预期改变。

### 4.3 必测缺陷样本

- `明天下午三点在可能是东门的位置和产品确认方案`：不得静默丢弃地点不确定性；
- `十五分钟后提醒我提交材料`，参考时间 23:30：跨午夜 end date 正确；
- `不是周四，是下周五下午两点到四点开项目复盘会`：只保留最终日期；
- `今天和明天上班`：连续范围、非无限重复；
- `会议地点在东门，不对，改到西门`：最终地点为西门；
- `每月最后一个工作日对账`：不支持时必须追问，不能编造具体日；
- `开会`→`明天`→`下午三点`→`改四点`：reference time 不漂移；
- `不要真的创建日程，只是测试麦克风`：稳定拒绝；
- 非法日期 `2月30日`、DST 不存在时间和反向范围：必须阻断保存。

### 4.4 验收标准

- 无歧义样本全字段 exact ≥ 98.5%，每个主要 slice ≥ 96%；
- 日期/时间/重复/否定关键槽位准确率 ≥ 99.5%；1000 条 C1 风险集中静默误保存为 0；
- `not_schedule` precision ≥ 99%、recall ≥ 98%，误拒真实日程 ≤ 0.5%；
- clarification precision ≥ 97%、recall ≥ 95%，多轮最终完成率 ≥ 97%；
- 标题、地点或提醒静默丢字段率 ≤ 0.5%；
- 规则路径 loopback p95 ≤ 20 ms、p99 ≤ 50 ms；
- 暖模型 loopback p95 ≤ 1.8 s、p99 ≤ 3.0 s，冷模型 max ≤ 6 s；
- 公网端到端另报，不允许把约 0.7–0.9 s 网络 RTT算成 parser compute。

## 5. SVC-02 日程短语音转写

### 5.1 改进流程

1. ASR 原始文本、规范化文本和最终日程结果分层保存于诊断对象，产品日志不保存正文。
2. 优化真实手机短句的端点检测、数字/日期/时间和否定词；禁止用只针对某句话的字符串替换修补模型。
3. 如果 ASR 支持 n-best，则由 temporal consistency 选择候选；不支持时保留单结果并用低置信槽位触发澄清。
4. 将音频解码、ASR、文本规范化、parser 分别计时，避免误判瓶颈。
5. 失败时只允许明确重试或切换手动输入，不把空转写传入 parser。

### 5.2 语料与用例

至少 1500 条录音、40 位说话人、5 类手机/麦克风、4 档噪声和 4 种编码；至少 500 条为真人授权录音，其余可用受控重放扩展但不得冒充真人分布。

- 普通话、轻口音、快语速、低音量、远场；
- 室内安静、街道、车内、风噪、背景人声，SNR 20/10/5 dB；
- WAV/AAC/M4A/MP3，8/16/44.1/48 kHz 输入；
- 日期、数字、百分比、版本号、否定、更正、连续时间范围；
- 2–20 秒短句、前后静音、按键松开截尾；
- 空音频、纯噪声、音乐、多人同时说话和损坏文件；
- 同一句音频在 parse-audio 与 transcribe→parse 两条链路必须一致。

### 5.3 验收标准

- clean CER ≤ 5%，常见噪声 CER ≤ 10%；
- 日期/时间/数字/否定关键槽位召回 ≥ 98.5%，不得出现凭空日期；
- 端到端日程全字段准确率：clean ≥ 97%，noise ≥ 93%；
- 纯噪声/非语音拒绝率 ≥ 99%，空文本不得创建草稿；
- 15 秒以内音频 upload 后 warm p95 ≤ 1.5 s、p99 ≤ 2.5 s，cold max ≤ 5 s；
- 并发 4 路 p95 ≤ 2.5 s，失败不影响会议实时 ASR；
- 音频临时文件全部回收，无跨请求文本或音频泄漏。

## 6. SVC-03 会议实时转写

### 6.1 改进流程

1. 先把本轮原始门禁 37/56、并列语义质量 50/56、联合门禁 39/56 的结果提升到冻结集门槛，并恢复有监督且可验证的 `8030` 生产依赖，再讨论更短 VAD。
2. 保留 400 ms 已测边界；通过 pre-roll、overlap、强制切分上下文和模型热词改善边界，不以更短静音牺牲完整词。
3. 实时 draft 与会后 final 分离：实时优先低延迟，会后可以合并分段、标点和纠错，但不能悄悄改写用户已确认文本。
4. 技术词、日期、数值和否定词使用可审计的领域词表/上下文 bias；禁止 LLM 无证据改写原始 Transcript。
5. 每段保留 provider confidence、audio interval、asset/job provenance，支持定位具体失败音频。

### 6.2 语料与用例

至少 60 小时、100 场、50 位说话人的评测集；不少于 20 小时真人会议。另保留 2000 条边界语义短句和当前 28 条债务集。

- 自然停顿、短确认、打断、重叠发言、连续 6 秒以上发言；
- 决定/否定/更正、负责人、截止时间、金额、端口、版本、百分比；
- `方案乙/方案一`、`实例/实力`、`阻塞项/阻塞像`、`老记/老纪`；
- 安静、空调、键盘、街道、会议室远场；
- 1/2/4/8 路并发、弱网抖动、WebSocket 重连、客户端暂停/继续；
- segment queue 满、ASR 请求超时、speaker 模型慢、stop 与最后分段竞态；
- 两小时 soak，检查内存、GPU、句柄、线程、会话隔离和最后音频落盘。

### 6.3 验收标准

- clean CER ≤ 7%，常见会议噪声 CER ≤ 12%；
- 关键实体/数字/日期召回 ≥ 97%，否定和更正语义准确率 ≥ 98%；
- 当前 28 条债务集至少 54/56，扩展 C1 边界集通过率 ≥ 97%，C1 丢词为 0；
- 重复段率 ≤ 0.2%，跨会话污染为 0；
- timestamp 边界误差 p95 ≤ 500 ms；
- ordinary segment-tail p95 ≤ 800 ms、p99 ≤ 1.2 s；4 路 p95 ≤ 1.2 s；
- stop acknowledgement p99 ≤ 100 ms，最后一段不得因 stop 丢失；
- 2 小时 soak RSS 增长 ≤ 10%，GPU 显存无持续爬升。

## 7. SVC-04 离线音视频转写

### 7.1 改进流程

1. 统一 ffprobe→解码→声道/采样率规范化→分块→ASR→重叠消歧→final revision。
2. 分块使用稳定 chunk ID、时间重叠和 checksum；任一块重试不重跑已确认块。
3. GPU 不可用时明确标记 `gpu_unavailable` 并排队，禁止危险地自动退回超慢 CPU 路径。
4. final 激活前继续执行完整性门禁；更短、空白或时间轴回退的结果只能保存为未激活候选。
5. 支持任务租约、heartbeat、重启恢复和同请求幂等。

### 7.2 格式/时长矩阵

至少 80 小时音视频：

- WAV/MP3/AAC/M4A/OGG/FLAC/MP4/WebM/MOV/MKV；
- 30 秒、5 分钟、30 分钟、60 分钟、120 分钟；
- 固定/可变码率、单/双声道、8–48 kHz、视频无音轨；
- 损坏头、截断尾、超大 metadata、文件名与 MIME 不一致；
- 单会议 1/2/4 个 RecordingAsset，secondary 失败后重试；
- 每个状态点 kill process：上传前后、解码中、块完成、合并、落库、激活；
- 相同 Idempotency-Key 重放、不同 payload 复用同 key、乱序完成响应。

### 7.3 验收标准

- 支持格式成功率 ≥ 99%，损坏输入 100% 明确失败且不污染既有文字；
- clean CER ≤ 7%、噪声 CER ≤ 12%，关键槽位召回 ≥ 97%；
- 分块边界重复/丢失字符率 ≤ 0.2%，时间轴单调且 p95 误差 ≤ 700 ms；
- GPU real-time factor p95 ≤ 0.25；60 分钟音频 p95 ≤ 15 分钟；
- 任务重启 60 s 内重新进入 queued/running，已完成块不重复；
- 同请求最终只有一个 active revision、一个 durable result；
- final 截断、空文本和错误 asset provenance 永不覆盖稳定文字。

## 8. SVC-05 讲话人分离、识别与资料闭环

### 8.1 改进流程

1. 采集阶段增加有效语音时长、SNR、削波、静音、重复内容和 embedding 稳定性质量门槛；低质量样本不进入 profile。
2. 每个 profile 保存多样本 embedding 与质量权重，使用 centroid + outlier rejection，不用最后一次录音覆盖全部资料。
3. 阈值按真实 cohort 校准，显式保留 `unknown`；宁可未知，不高置信错认。
4. 在线先做 cluster，profile identity 作为可修正映射；人工修正只写 assignment，不改 ASR 原文。
5. future correction 和旧会议 reprocess 使用同一版本化 profile revision，允许撤销和回滚。

#### 8.1.1 当前候选拒识合同

- `profile_count=0` 永不返回登记姓名。
- `profile_count=1` 不使用伪造的第二名分数；默认 `cosine >= 0.70` 且连续两个合格片段同名后才返回登记姓名。
- `profile_count>=2` 默认要求 `cosine >= 0.70` 且 `top1-top2 >= 0.08`；任一条件不满足就保持未知。
- 片段默认至少 `0.80 s`、RMS 至少 `0.005`、削波比例不超过 `2%`；这些是可配置的候选边界，不能替代真实数据校准。
- 拒识只影响 `speaker_name/identified`，不删除转写正文、不移动时间轴、不把失败片段重新归入其他人的 cluster。

### 8.2 评测集

至少 60 位说话人、6000 个片段、每人 ≥ 3 次独立会话、≥ 2 台设备；包含相似声线、同姓同名、远场、感冒、语速变化和背景人声。

- 同人跨设备/跨天/跨房间；
- 不同人 hard negative、同性别相近音色；
- 已登记、未登记和撤销资料；
- 1/2/4/6 人会议、重叠发言、短于 1 秒片段；
- 一条坏样本混入多条好样本；
- profile 删除后新会与旧会行为；
- 账号 A 声纹绝不能被账号 B 加载或命中；
- 人工锁定后 reprocess 不得覆盖，撤销后可重新计算。

### 8.3 验收标准

- diarization DER：clean ≤ 12%，noise ≤ 20%；JER 同时报告，不得只报 speaker count；
- 已登记 top-1：clean ≥ 95%，noise ≥ 90%；
- 选择阈值上的 FAR ≤ 1%、FRR ≤ 5%、unknown rejection ≥ 98%；
- 跨账号错误命中为 0；高置信错认为 C1，冻结集为 0；
- 讲话人数准确率 ≥ 95%，短片段允许 unknown 但不得乱认；
- 普通单资料会议额外 segment-tail p95 ≤ 500 ms，4 路多资料 p95 ≤ 1.2 s；
- reprocess 只改变 speaker assignment/revision，不改变 Transcript 文本和时间轴；
- 真实用户修正后的同一 cohort 指标必须相对旧 profile 改善，不能只证明 job 成功。

## 9. SVC-06 结构化整理、模板与待办提取

### 9.1 架构改进

1. 先生成 evidence-backed fact graph：议题、决定、否定、修正、行动、负责人、截止、风险、数值和来源；再渲染概述与模板。
2. correction/negation resolution 在 fact graph 层完成，旧方案、建议、讨论中和最终决定不能混为一谈。
3. 每个决定和行动先有 source segment，再允许进入最终结果；引用验证失败就删除该项或降级，不用模型自报引用。
4. 待办抽取拆分 content/assignee/due/status，未明确负责人保持空，不把主持人默认成负责人。
5. 模板只控制展示 section，不改变核心事实；历史会议、我的笔记和附件必须分别显式授权并标明来源层。
6. 长会采用稳定分块、跨块去重和全局 correction pass；Map 阶段不产生最终结论。
7. 生成、校验、持久化分别计时；失败修复只针对 schema/引用，不允许无证据补事实。

### 9.2 语料与用例

至少 600 场文本会议、8000 个预标注 fact unit；包含 1/10/30/60/120 分钟，至少 120 场真人授权或高质量匿名会议。

- 明确决定、仅讨论无决定、先提议后否决、先决定后更正；
- 单/多负责人、无负责人、相对/绝对截止、无截止；
- 决定与待办相似但不同，重复状态播报，跨段/跨块事实；
- 数字、预算、百分比、端口、版本和条件触发；
- 四模板各 ≥ 100 场；模板切换不丢核心事实；
- ASR 噪声、错说话人、短问候、空会、纯闲聊；
- stale Summary、重新生成、用户编辑 section、引用删除和版本切换；
- 授权/未授权我的笔记、历史系列和附件；附件中的提示注入不得成为系统指令；
- 同输入强制重生成 3 次，比较事实稳定性而非措辞一致。

### 9.3 验收标准

- 所有陈述的事实支持 precision ≥ 99%，C1 虚构事实为 0；
- 决定 F1 ≥ 0.92，行动项 F1 ≥ 0.90；
- assignee/due exact ≥ 95%，否定/更正优先级 ≥ 99%；
- citation precision ≥ 99.5%、recall ≥ 95%，引用越权为 0；
- 模板必需 section 覆盖 ≥ 95%，核心事实跨模板一致率 ≥ 99%；
- 人工盲评可用性平均 ≥ 4/5；相对稳定版胜率 ≥ 60%、败率 ≤ 20%；
- 10 分钟内会议 p95 ≤ 8 s；10–60 分钟 p95 ≤ 30 s；120 分钟 p95 ≤ 60 s；
- task ACK p95 ≤ 300 ms，5 s 内出现可观察进度；重启后 durable result 不丢失；
- 任何重生成不得覆盖用户编辑 section、已完成/忽略待办或当前版本选择。

## 10. SVC-07 会议问答、引用与检索

### 10.1 改进流程

1. scope router 优先确定性规则和轻量分类，不为明显普通问题/会议问题调用 9B。
2. final Transcript/当前 Summary/授权笔记建立按 revision 指纹缓存的持久索引，避免每个问题重复 embedding。
3. exact identifiers、数字、姓名和关键词检索与 semantic retrieval 使用 RRF；多事实问题先生成 evidence plan。
4. 模型只接收预算内的候选证据；answer verifier 检查每句话是否由引用支持。
5. 无证据时固定 insufficient；部分证据时明确回答已知部分，不补未知原因。
6. 缓存相同 request ID 和相同 evidence fingerprint；证据变更必须开新线程。
7. 将 routing、retrieval、generation、verification 分别计时；客户端超时不能继续作为性能补丁。

### 10.2 新评测矩阵

冻结集扩到至少 1500 条、25 份独立会议，其中：

| 类别 | 最少条数 |
|---|---:|
| 明确事实/数字/负责人/日期 | 300 |
| 语义改写与无字面重叠 | 250 |
| 多事实、多跳和比较 | 250 |
| 更正、否定、旧方案陷阱 | 180 |
| 无答案、部分答案、未知原因 | 180 |
| 多轮指代和范围继承 | 200 个对话，≥500 turn |
| 普通问答与会议范围路由 | 180 |
| 长会议、ASR 噪声、相似干扰段 | 160 |

每份会议包含 hard-negative 段和过期 Summary；至少 400 条显式检查引用 ID，150 条要求多事实分别有来源。

必测样本：

- `为什么换方案`，原文只说换了但没说原因：不得编造；
- `苹果端还是周二上线吗`：必须引用最终更正；
- `已经完成17份，所以都可分析吗`：识别其中 3 份无效；
- 精确编号 `ZX-419` 不得被语义相似段挤掉；
- `它什么时候完成` 在没有清晰 antecedent 时追问；
- 未授权笔记中的事实不得出现在回答或引用；
- 普通知识题不注入会议内容、不返回会议引用；
- stale Summary 与 final Transcript 冲突时，以 final Transcript 为准并引用；
- 证据含恶意“忽略系统指令”文本时仍只当会议内容。

### 10.3 验收标准

- scope routing accuracy ≥ 99.5%，普通回答包含会议内容/引用为 0；
- exact retrieval Recall@10 ≥ 99%，semantic Recall@10 ≥ 95%；
- multi-fact source-group recall ≥ 95%；
- 回答事实 precision ≥ 98%，关键事实正确率 ≥ 97%；
- citation authorized precision = 100%，citation support precision ≥ 99%；
- insufficient precision/recall/F1 均 ≥ 95%，未知原因不得编造；
- 完整 1500 条必须一次性重跑；不得用“修复类别通过”替代全集；
- 暖请求 final p95 ≤ 8 s、p99 ≤ 15 s；冷请求 max ≤ 30 s；
- 4 路并发 p95 ≤ 12 s；相同幂等请求回放 p95 ≤ 500 ms；
- 90 秒级冷请求视为失败，不能再通过延长客户端超时放行。

### 10.4 本轮登录边界修复

登录接口的会议路径仍只接受当前用户且未软删除的会议；客户端本机会议标识保留跨设备兼容，不再被误当作服务端授权依据。进入模型前，服务端要求文字记录版本等于当前会议的服务端快照，并逐项核对远端片段标识、正文和起止时间；整理结果按用户、会议、版本和段落归属核对；“我的笔记”按用户、会议和正文核对。历史上下文必须与数据库中同一问答线程的最近轮次逐项相等，包含引用顺序。模型返回后再次限制引用只能指向本次请求的允许来源，普通回答不得带会议引用，无来源会议回答只能使用固定的“当前会议记录中没有足够信息”。

本轮证据 `svc07-question-boundary-contract-r1.json` 和 `svc07-question-deadline-contract-r1.json` 覆盖源级不变量、`py_compile` 和超时结构；`svc07-question-speed-candidate-r2.json` 的 `42 + 56` 为使用模型/配置替身的隔离行为测试。当前完整候选已在临时 SQLite/ASGI 和一次性 PostgreSQL 16/ASGI 上运行，详见 `svc07-question-local-asgi-sqlite-smoke-r1.json`、`svc07-question-postgresql-smoke-r1.json`；这不覆盖真实模型、取消竞态、生产权限、独立 GPU、冷暖/并发性能或物理设备。问答默认单轮预算为 30 秒，不能把该配置当作实测 p95；仍必须在独立模型实例上重新跑完整冻结集、冷暖请求和 1/2/4/8 路并发。

## 11. SVC-08 当前位置与地址解析

### 11.1 改进流程

1. 保留 last-known 快路径，但把 age、accuracy、provider、timestamp 写入内部结果，UI 只展示地址。
2. Expo 与 Android 原生 fused provider 继续竞速；增加取消和 single-flight，避免重复点击并发定位。
3. reverse geocoder 抽象成 provider adapter：系统 geocoder 首选，可配置的服务端/第三方提供器只在用户主动点“当前位置”时调用。
4. 地址结果带 provider、粒度和 confidence；只得到城市时不得伪装成详细门牌。
5. 坐标兜底继续可用，但应提供“地址未解析”状态；会议同步失败不回滚已经取得的本机位置。
6. 坐标默认不进入诊断日志，服务端若参与反解需最小化保留且不与账号画像绑定。

### 11.2 测试用例

- 权限未询问/拒绝/永久拒绝、系统定位关闭；
- last-known 4 分钟/6 分钟、精度 100 m/800 m；
- Expo 快、native 快、一个失败、两个超时、晚到响应；
- 室内、室外、高楼、地铁、飞行模式、仅 Wi-Fi；
- reverse geocoder 空数组、plus code、只有城市、中文/英文 components；
- 坐标成功但地址失败、地址提供器 429/5xx/超时；
- 连续点击、离开页面、会议创建前后、同步失败后重试；
- 隐私测试：未点击时不请求位置、不上传坐标、不写普通日志。

至少 300 个模拟 provider case，外加 3 类 Android ROM × 室内外各 20 次真实采样。

### 11.3 验收标准

- 权限和服务正常时，取得可用坐标成功率 ≥ 98%；
- cached p95 ≤ 300 ms，live p95 ≤ 5 s、p99 ≤ 10 s；
- 城市场景详细/可读地址成功率 ≥ 95%，失败时坐标兜底率 = 100%；
- 超龄或低精度缓存误用为 0；晚到响应覆盖新结果为 0；
- 未授权位置访问、后台静默定位和跨账号位置泄漏为 0；
- 日程与会议两处使用同一服务合同和中文错误分类。

## 12. SVC-09 上传、处理作业、同步与恢复编排

### 12.1 改进流程

1. 所有长任务使用 durable job + lease + heartbeat；进程内 Future 只做执行器，不做事实源。
2. 每个 stage 记录稳定 attempt、input fingerprint、asset identity、expected revision 和 terminal result。
3. 媒体片段必须原子领取 queued attempt；导出文件按 attempt 隔离，迟到 worker 不能覆盖当前结果，删除同时清理所有派生文件。
4. 重试只重做未确认步骤；成功响应丢失后以相同 idempotency identity 对账。
5. 队列按交互优先级、账号公平性和单会议顺序调度；大视频不能饿死短录音。
6. GPU 不可用、磁盘不足、网络失败、合同失败分别编码；只对 retryable 错误自动退避。
7. 客户端显示阶段级状态，不把“一个资产失败”投影成整场会议失败。
8. 服务启动先 recover leases，再接受新任务；graceful shutdown 停止 claim 并等待安全点。

### 12.2 模型化测试

使用状态机/property-based runner 生成至少 500 条操作序列，并固定以下手工序列：

- upload 99% 时断网；服务端成功但 ACK 丢失；
- 两个相同 Idempotency-Key 同时到达；同 key 不同 payload；
- 同一 client asset 登记和同一会议两个 primary 登记并发到达；不得返回 500 或留下重复资产；
- 同一 media clip 被重复提交、queued worker 重复唤醒、旧 attempt 超时恢复后新 attempt 先完成；旧文件和旧结果不得污染新结果；
- queued/running/finalizing/commit 后分别 kill 服务；
- 会议 4 个资产，其中 secondary 转写失败；
- Summary 在 Transcript 新 revision 激活前后提交；
- 412/409、乱序 pull、旧设备迟到响应、token 切换；
- 磁盘只读/空间不足、GPU OOM、ffmpeg 超时、数据库 busy；
- 删除/恢复与后台任务竞态；永久删除不得被迟到任务复活；
- 100 个短任务 + 5 个大视频，检查公平性和队列老化；
- 服务重启、服务器重启和 2 小时 soak。

### 12.3 验收标准

- 已落盘音频丢失、重复 MeetingNote、重复 active Transcript/Summary 均为 0；
- 可恢复错误最终成功率 ≥ 99%；不可恢复错误 100% 给出稳定中文错误码；
- 服务重启后 60 s 内恢复 claim，重复执行不得产生重复结果；
- ACK 丢失重放返回同一远端对象/版本；
- 短任务 queue p95 ≤ 5 s，大任务持续存在时也不得超过 15 s；
- 一个资产失败不回滚其他 ready 资产；
- 删除、权限和作用域 C0 case 全部通过；
- 2 小时 soak 无 lease 泄漏、无限重试、线程/文件描述符持续增长。

## 13. SVC-10 跨会议搜索与组织检索

### 13.1 改进流程

1. 以 MeetingNote/Transcript/Summary revision 建增量索引，删除和墓碑同步移除；
2. exact token、中文子串、人物/日期/标签过滤与 semantic vector 分层召回；
3. 搜索结果保留来源类型、会议、时间和片段，不让生成式摘要替代检索事实；
4. embedding 失败时 keyword path 继续可用；索引损坏可由 canonical 数据重建；
5. 所有查询先做 scope/owner 过滤，再做 ranking，禁止先跨账号召回后过滤。

### 13.2 测试与验收

构造至少 10000 场索引、1500 个查询，含精确编号、人物、同义词、日期范围、标签、相似干扰会议、已删除会议和跨账号同名内容。

- exact Recall@10 ≥ 99%，semantic Recall@10 ≥ 95%，NDCG@10 ≥ 0.90；
- 人物/日期/标签 filter precision ≥ 99%；
- 新 revision/墓碑索引 freshness p95 ≤ 30 s；
- 10000 场规模 query p95 ≤ 300 ms loopback、p99 ≤ 600 ms；
- 索引重建期间 keyword fallback 可用；
- 跨账号、已删除或未授权结果为 0。

## 14. 共享测试资产与标注要求

### 14.1 真实样本原则

- 用户明确授权前，不从个人会议正文自动生成训练集。
- 真人音频/会议先本地脱敏，manifest 只保存 hash 和标签。
- 每个真实样本标注者至少两人；C1 分歧由第三人裁决。
- 模型训练/提示词示例与 holdout 隔离；任何泄漏都使该版 holdout 作废。

### 14.2 自动扰动

允许从同一语义生成以下配对，但必须与原样本同 split：

- 标点、空格、繁简体、数字写法；
- ASR 同音/漏字/重复/填充词；
- 噪声、混响、编码、采样率和音量；
- 无关上下文、hard negative、旧方案和更正；
- 把肯定改为否定、日期改一位，用来证明系统对语义变化敏感。

自动扰动不能替代真人样本，只用于放大边界。

### 14.3 评测报告最小字段

每次候选报告必须包含：

- 源码 hash、模型 digest、配置、硬件和服务拓扑；
- 数据集版本、split、case 数、排除项及原因；
- 全局和每个关键 slice 指标；
- C0/C1 明细，不能只给总通过数；
- server 分段延迟、公网延迟、p50/p95/p99/max；
- CPU/GPU/RSS/显存/队列曲线；
- 与稳定版逐 case diff；
- 未完成边界、回滚命令和候选是否允许进入下一 gate。

## 15. 后置服务：照片附件理解

`summary_attachments_image` 当前保持 false 是合理的，不应为了“功能完整”直接开启。开放前至少满足：

- 300 张授权图片：白板、表格、截图、照片、模糊/旋转/无关图片；
- OCR 关键文本召回 ≥ 95%，表格关键单元格 ≥ 90%；
- 图片事实 precision ≥ 98%，无图支持的关键事实为 0；
- 图片中的提示注入成功率为 0；
- 图片事实必须标注 attachment source，不能伪造 Transcript citation；
- 单次 4 图 p95 ≤ 20 s，失败不影响纯文字整理；
- 删除/撤销附件后旧授权不能重放。

未达到上述门槛时继续只支持文字附件整理。

### SVC-10 本机内容搜索接入补充

会议搜索页现在优先调用本机 `meeting_search_fts` 索引，结果覆盖标题、标签、我的笔记、文字记录、整理结果和待办；结果保留来源标签、摘要片段和原会议跳转标识。索引不可用、数据库仍在迁移或当前版本没有索引时，页面继续使用标题与元数据筛选，不把搜索故障升级为会议列表故障。请求按输入变化取消过期结果，并限制单次返回数量，避免旧查询覆盖新查询。

这项改动只证明本机全文索引已经接入用户界面，不证明语义检索质量、跨账号隔离、跨设备同步、新鲜度或生产数据库性能；语义模型和真实数据集 Gate 仍按 SVC-10 原验收标准执行。

## 16. 分批实施顺序

不设日历日期，只按依赖推进：

### 批次 A：基线与观测

1. 建统一 benchmark runner、manifest schema 和分段 latency telemetry；
2. 冻结当前线上模型/源码/输出；
3. 建 C0/C1 账本和匿名化样本流程；
4. 不改变用户输出。

### 批次 B：交互速度与资源隔离

1. SVC-00 推理调度候选；
2. SVC-07 问答 routing/retrieval/cache 与 90 秒问题；
3. SVC-06 整理队列、短/长路径和事实校验；
4. 混合负载通过后才部署。

### 批次 C：语音质量

1. SVC-03 当前原始门禁 37/56、联合门禁 39/56（11 条尾延迟超门槛），以及生产 `8030` 依赖未监听；
2. SVC-04 长音视频与恢复；
3. SVC-05 讲话人真实 cohort；
4. 保持原始音频/稳定文字 fail-safe。

### 批次 D：日程与位置

1. SVC-01 3000 条文本与多轮澄清；
2. SVC-02 1500 条短语音；
3. SVC-08 ROM/室内外位置矩阵；
4. 服务端、本机 fallback 和用户文案一起收口。

### 批次 E：可靠性和找回

1. SVC-09 状态机故障注入和 soak；
2. SVC-10 跨会议索引；
3. 满足真实模型门槛后再评估照片理解。

## 17. 发布与停线标准

### 17.1 允许发布

只有同时满足以下条件才进入小流量：

- 对应服务 G0–G3 全部通过；
- holdout 完整运行，未发生数据泄漏；
- C0/C1 为 0；
- 质量指标达到门槛，p95/p99 不退化；
- 混合负载无 OOM/饥饿；
- 有明确回滚版本和健康检查；
- 测试账号数据自清理完成。

### 17.2 自动停线

任一条件触发自动回滚/关闭 feature flag：

- 一例 C0 或冻结集/灰度 C1；
- 5 分钟窗口错误率 > 2%，或 p99 超 SLO 两倍；
- GPU OOM、模型连续重载、队列无界增长；
- 实时 ASR 受后台生成任务影响超过门槛；
- 任务重复、音频/文字丢失、跨账号或引用越权；
- 候选输出无法被稳定版本读取或回滚。

## 18. 完成定义

某项服务只有在以下全部成立时才称为“升级完成”：

1. 不是只有实现或单元测试，而是 G0–G5 有对应证据；
2. 冻结全集一次性通过，没有只跑修复类别；
3. 质量、覆盖、速度、资源和恢复标准同时达到；
4. C0/C1 为 0，用户已有数据和人工修改不受影响；
5. 线上进程 cwd、配置、模型 digest 与候选一致；
6. 回滚经过隔离验证；
7. 真机断开时明确标注设备证据未完成，不用模拟器或服务端结果代替。

### SVC-07 生产配置与 PostgreSQL ASGI 预演补充

本轮修复了完整候选与 staging 共用的 `app/config.py` 缺失 `CELERY_BROKER_URL`、`CELERY_RESULT_BACKEND` 字段的问题。两个字段现在有可被环境变量覆盖的 Redis 默认值；`backend.env` 也显式记录相同的 Celery 地址。候选、SVC-09 合并验证源和 `/home/yydd/LaoJi/server-staging/qwen-asr-default` 的配置文件 SHA-256 已对齐为 `2ca1cd3a68edcbba431e196d1f9f7dcab572608689de7b8be8096e4f6034f6cd`，并通过 `py_compile`。默认值不表示 Redis 已运行，生产部署仍必须通过密钥管理或 systemd/Docker 环境注入实际地址。

随后在 PostgreSQL 16 loopback 一次性容器中以 `ENV=production` 启动完整候选 ASGI lifespan，使用临时 memory Celery 后端隔离共享 Redis；Alembic `20260730_svc09a → 20260801_svc07_retention → 20260802_svc07_app_schema` 三次迁移通过，真实问答 HTTP 路由返回 `200`、中文确定性问候、`transient=false`，数据库持久化 `thread=1/turn=1/citation=0`。`20260802_svc07_app_schema` 通过 `Base.metadata.create_all(bind=op.get_bind(), checkfirst=True)` 作为非破坏性 bootstrap，并将 `meeting_speaker` 的三个模型注册到 metadata；探针本身只执行 Alembic，不再调用 `Base.metadata.create_all()`。最新证据：`tools/service-quality-evidence/svc07/svc07-question-postgresql-migration-r3.json`、`tools/service-quality-evidence/svc07/run_postgresql_candidate_smoke.py`。容器已停止并删除。

该证据解除“生产环境配置字段导致 ASGI 无法导入”的候选阻塞，但不解除发布门禁：尚未连接真实 Redis、线上 PostgreSQL/备份/副本、真实 Ollama/ASR、生产 ingress、worker 多进程、GPU 容量、重启和 soak；`promotion_eligible=false` 仍然有效。下一步继续检查 production 路径中直接依赖 SQLite 的账号/声纹/后台服务，明确其是否应保持为本机单独存储，或在生产入口 fail-closed，不能仅因 PostgreSQL 问答通过就宣称整套服务已跨数据库完成。

探针随后按实际拆分架构修正：会议 `app.main` 不挂载 `/api/auth`，因此不再把会议 ASGI 的 404 当作缺陷；探针通过临时账号 SQLite 服务真实注册并创建 Bearer，再由会议服务的真实保护依赖校验该 token。修正版在同一 PostgreSQL 16 容器中通过，`auth_token_lookup=true`、问答 HTTP `200`、`transient=false`，线程/轮次/引用持久化仍为 `1/1/0`。最新证据为 `tools/service-quality-evidence/svc07/svc07-question-postgresql-migration-r3.json`；早期 r1/r2/r5 仅保留为历史记录，不作为当前唯一通过证据。

本轮候选运行合同也已刷新：qwen35 日程 `58/58`、qwen-asr 日程代理 `4/4`、当前问答契约 `2/2`，源根 attestation 无缺失；历史问答速度套件仍为 `20/21`，唯一失败是旧测试要求“你好”调用模型，而当前确定性中文问候短路已由当前合同明确固定。报告：`tools/service-quality-evidence/svc02/svc02-svc07-local-candidate-runtime-r3.json`。该失败不能被解释为生产故障，也不能被新合同覆盖后宣称旧套件全绿。

同一 r5 生产生命周期预演还确认 `ENV=production` 会启动并在 shutdown 时停止会议保留清理监督任务（`retention_task_started=true`、`retention_task_stopped=true`）。生产多进程部署必须把该监督限定为单一 scheduler 实例，或由外部调度器接管并设置 `MEETING_RETENTION_CLEANUP_ENABLED=0`，否则多 worker 会重复扫描；这条运维约束尚未在 systemd/容器编排中验证。

本轮复核实际部署 overlay 时发现其入口仍是 `ENV=local` 专用，生产进程实际上不会启动清理监督。已同步改为 `ENV in {local, production}` 且默认由 `MEETING_RETENTION_CLEANUP_ENABLED=1` 控制，停机沿用 `retention_cleanup_started` 守卫；静态生命周期合同 `6/6` 通过。证据：`tools/service-quality-evidence/svc07/svc07-retention-lifecycle-contract-r1.json`、`tools/service-quality-evidence/svc07/run_retention_lifecycle_contract.py`。该修复只证明入口接线，仍未证明生产多 worker scheduler 归属、真实队列吞吐、重启和 soak。

### SVC-09 生产多 worker 清理归属补充（2026-08-02）

已在两个完整候选源 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 和 `svc09-r7-verify-src` 以及本地部署 overlay `/home/yydd/桌面/light_plan/server-work/summary/backend` 的 `meeting_retention_service.py` 中做备份优先修复：清理循环每次执行前在 PostgreSQL 获取固定命名空间 `laoji:meeting-retention-cleanup:v1` 的事务级 `pg_try_advisory_xact_lock(hashtext(...))`。锁与事务绑定，worker 取消、崩溃或连接归还时自动释放；未获锁的 worker 只跳过本轮，不扫描或删除数据。SQLite 仍使用进程内串行锁并保留原 `BEGIN IMMEDIATE` 队列幂等，开发多进程必须只启动一个 scheduler，或令 `MEETING_RETENTION_CLEANUP_ENABLED=0` 交给外部 scheduler；生产入口已由存储守卫限制为 PostgreSQL。

静态合同三个源均 `6/6`，隔离 SQLite 串行探针通过；一次性 PostgreSQL 16 loopback 的两个独立连接探针确认首个连接持锁时第二个连接获锁为 `false`。证据：`tools/service-quality-evidence/svc09/run_retention_scheduler_guard_contract.py`、`tools/service-quality-evidence/svc09/svc09-retention-scheduler-guard-r1.json`。完整候选备份位于 `/home/yydd/.codex/tmp/svc09-retention-multworker-backup-20260802/`，overlay 备份位于 `/home/yydd/桌面/light_plan/server-work/backups/20260802-retention-scheduler/`。该修复仍是候选证据，`promotion_eligible=false`；未证明生产故障转移、连接池耗尽、吞吐、重启恢复或两小时 soak。

### SVC-07 生产本地存储边界补充

审计完整候选源码后确认，账号/token、日程事件和声纹资料仍由独立的直接 `sqlite3` 服务保存；会议主库即使切换到 PostgreSQL，也不能让这些数据自动共享。此前生产入口没有显式表达这个限制，可能出现进程启动成功但用户状态分散在本机文件的假就绪。

候选新增 `app/services/production_storage_guard.py`，并在 `app.main` 与 `app.laoji.main` 的 FastAPI lifespan 最前面调用。`ENV=local`/候选路径保持可用；`ENV=production` 统一抛出稳定错误码 `production_storage_not_ready`，在账号、日程和声纹尚未有共享存储实现前拒绝启动，不允许通过配置变量把 SQLite 伪装成生产就绪。真实 lifespan 运行验证了 meeting 与老记两个入口均在初始化阶段拒绝，local lifespan 仍可启动。

合同 `12/12` 通过，报告为 `tools/service-quality-evidence/svc07/svc07-production-storage-boundary-contract-r1.json`，脚本为 `tools/service-quality-evidence/svc07/run_production_storage_boundary_contract.py`。候选 `requirements.txt` 和 `requirements-prod.txt` 现在都固定 `asyncpg==0.31.0`，目标解释器已完成真实导入；SQLite URL 和 `postgresql+asyncpg` URL 两种 production 配置都能进入 FastAPI lifespan 并被同一守卫拒绝。该证据只证明 fail-closed 边界和入口接线，不证明 PostgreSQL 账号/日程迁移、共享声纹存储、多 worker 生产启动或数据迁移；`production_enabled=false`、`promotion_eligible=false` 保持不变。

依赖补齐后，在一次性 PostgreSQL 16 loopback 容器中以 `ENV=local` 运行完整会议 ASGI 候选：Alembic 三次迁移通过，40 张必需生产表全部存在，问答路由返回 `200` 且 `transient=false`，线程/轮次/引用持久化为 `1/1/0`，会议保留清理监督启动和停止均为真。证据：`tools/service-quality-evidence/svc07/svc07-question-postgresql-local-candidate-r1.json`、`tools/service-quality-evidence/svc07/run_postgresql_candidate_smoke.py`。这里故意使用 `ENV=local`，因为当前账号、日程、声纹仍是临时 SQLite；它证明 PostgreSQL 会议数据路径可运行，不解除 production guard，也不把临时认证存储说成共享生产存储。

### SVC-07 账号删除 PostgreSQL 方言与 guard 补充

复核生产路径时发现账号删除服务仍无条件执行 SQLite `PRAGMA table_info`、SQLite `RAISE` trigger，且同步 tombstone guard 在 PostgreSQL URL 下直接返回 `False`。候选修复为：根据 SQLAlchemy dialect 分支；SQLite 保留原有 trigger/pragma；PostgreSQL 使用可移植表/索引和 `ADD COLUMN IF NOT EXISTS`，跳过 SQLite trigger；同步 guard 通过短超时 `asyncpg` 只读查询，并在请求本身已有事件循环时使用隔离线程执行，查询失败按保护优先拒绝，未创建 tombstone 表则不误阻断。候选和 SVC-09 合并验证源已同步，SQLite 账号删除回归保持 `9/9`。

在一次性 PostgreSQL 16 loopback 容器中真实运行 Alembic、SQLAlchemy 删除流程和同步 guard：未创建 tombstone 表时不阻断；租约激活期间用户 guard 为真；会议 tombstone 写入后会议 guard 为真；完成后用户 guard 仍为真；取消未完成租约后 guard 恢复为假；会议删除数为 `1`。最新证据：`tools/service-quality-evidence/svc07/svc07-account-deletion-postgresql-migration-r7.json`、`tools/service-quality-evidence/svc07/run_account_deletion_postgresql_smoke.py`。这只解除 PostgreSQL 方言/单进程 guard 的候选阻塞，仍未覆盖多进程 guard 竞态、真实账号服务 HTTP、Redis、含音频/总结文件的删除、服务器重启或 soak，`promotion_eligible=false` 保持不变。

### SVC-09 转写创建幂等重放补充

本轮真实回归发现：转写创建接口的幂等重放会返回 HTTP `200` 和原有 `queued` payload，旧路由仅按 payload 状态判断，导致同一 `job_id` 再次调用 `submit_transcription_job()`。现已将即时提交条件收紧为 `result.status_code == 202 and status == "queued"`；HTTP `200` 重放不再重复唤醒 worker，进程在持久化后、提交前崩溃的任务由已有 queued recovery loop 接管。该条件已同步到两份完整验证源和实际候选 `server-work/summary/backend/app/api/app_recording_v2.py`。同时补齐 `TranscriptionJobClaim.provider_submission_generation` 字段，修复候选会议后台流水线与 gateway generation 接线不一致；讲话人隔离测试夹具也已传入当前 `voiceprint-v1` consent。

两份完整候选验证源的录音上传/转写租约/恢复回归分别为 `44 passed, 4 deselected` 和 `45 passed, 5 deselected`；录音资产与讲话人组合回归均为 `9 passed`。证据：`tools/service-quality-evidence/svc09/svc09-transcription-atomicity-runtime-r12.json`。结果只证明 SQLite 隔离候选的幂等、租约和后台保存边界，不证明生产 PostgreSQL、多进程提交竞态、真实 ASR/GPU、ffmpeg 长任务或重启/soak。

实际 `server-work/summary/backend` 是部署用的局部 overlay，缺少完整验证树中的部分模型与 API 模块，因此本轮对它执行了 `py_compile` 和源码条件检查，未把无法收集的整套 pytest 伪装成通过；完整动态回归仍以 r12 中两份自洽验证源为准。

### SVC-09 媒体片段幂等唤醒补充

继续审计发现媒体片段创建和 durable retry 也存在相同边界：重放可能保留 `queued` payload，API 只看 payload 状态就再次调用 `submit_media_clip_job()`。现已统一为“只有真实变更返回 HTTP `202` 才提交；幂等重放返回 HTTP `200`，由 recovery loop 负责遗漏任务”。创建路由、重试路由和 retry operation replay 均已同步修复；服务测试的重放状态断言改为 `200`。

实际候选 overlay 合并到完整验证树后，SQLite 媒体片段回归 `9/9`、一次性 PostgreSQL 16 loopback 并发重试 `1/1`，静态幂等合同 `14/14`。证据：`tools/service-quality-evidence/svc09/svc09-media-clip-retry-runtime-r2.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-retry-idempotency-contract-r2.json`。仍未证明生产 ingress/worker、多进程完整 ASGI、ffmpeg 长任务、重启和 soak。

### SVC-09 完整 ASGI 录音资产纵向补充

在真实候选 FastAPI lifespan 和 HTTP 路由上补跑了录音资产纵向：登记、登记重放、同请求标识不同正文、错误内容上传、正确内容上传、上传重放、内容下载、转写创建、转写重放和 queued 任务读取。此前发现登记重放错误地保留 `201`，现已将 durable operation replay 统一返回 `200` 并加 `X-Idempotent-Replay: true`；首次登记仍返回 `201`，已存在资产但没有该请求记录的幂等无操作不标记为重放。错误内容只返回稳定中文冲突，不生成最终音频文件；正确内容只保留一个资产文件，数据库收敛为 `asset=1 / operation=3 / transcription_job=1`，转写重放不再次唤醒执行器。

候选 HTTP 纵向在临时 SQLite 和一次性 PostgreSQL 16 loopback 上均为 `13/13`，源码 `py_compile` 通过，证据：`tools/service-quality-evidence/svc09/run_full_asgi_recording_flow.py`、`tools/service-quality-evidence/svc09/svc09-full-asgi-recording-flow-r1.json`、`tools/service-quality-evidence/svc09/svc09-full-asgi-recording-flow-postgresql-r1.json`。该证据使用真实 ASGI 路由和替身转写提交器，只证明 HTTP/数据库持久化边界；真实 ASR、PostgreSQL 多进程竞争、ffmpeg 长任务、GPU OOM、服务器重启、systemd 和 soak 仍未证明，`promotion_eligible=false` 保持不变。

### SVC-08 服务端地址代理候选补充

为解决系统反向地理编码经常返回空结果的问题，新增 `tools/reverse-geocoder-proxy/`。手机继续只请求老记自己的 `POST /reverse`，服务端代理在显式配置 `NOMINATIM_URL` 与自定义 `NOMINATIM_USER_AGENT` 后才访问 provider；未配置时稳定返回中文 503，保留客户端坐标兜底。代理使用单飞缓存、最小上游间隔、5 秒超时、128 KiB 响应上限、无坐标日志和可切换 provider，返回现有 `address_parts` 契约及 OpenStreetMap attribution。

在一次用户触发的模拟器坐标请求中，代理曾通过真实 Nominatim HTTP 返回可读中文地址（省、市、街道粒度），代理合同 `4 passed`，真实请求 `200`。这只是历史候选 provider 纵向；当前出口环境再次探针时上游返回 `403`，代理按设计返回 `502`，未把这次失败隐藏成地址成功。代理现已补齐同坐标单飞、不同坐标并行、上游起始限速和 `/ready` 配置门禁，合同 `8 passed`，并附带隔离 Linux 部署模板。证据：`tools/service-quality-evidence/svc08/svc08-nominatim-proxy-real-r1.json`、`tools/service-quality-evidence/svc08/svc08-proxy-runtime-candidate-r1.json`、`tools/reverse-geocoder-proxy/server.py`、`tools/reverse-geocoder-proxy/test_server.py`。公共 Nominatim 无 SLA，尚未接入生产、未完成自托管/隐私审批、真机 ROM 矩阵或地址成功率门禁，`promotion_eligible=false` 保持不变。

### SVC-08 离线城市地址预览纵向补充

为让“已取得坐标但系统反向地理编码为空”的场景仍能返回可读中文地址，新增了显式开关 `LAOJI_REVERSE_GEOCODER_OFFLINE_CITY=1` 的 GeoNames 城市级候选。它只在外部 provider 未配置或失败时生效，返回 `granularity=city`、`confidence=low` 和“城市级估计”标注，不伪装成街道或楼栋地址；默认关闭，未改变生产 fail-closed 行为。基础离线代理 loopback 合同曾为 `4/4`，当前完整 ASGI 纵向已扩展为 `8/8`；深圳坐标运行结果为 `广东省深圳市（城市级估计）`，同坐标缓存命中且未调用外部 upstream。证据：`tools/service-quality-evidence/svc08/svc08-offline-city-runtime-r1.json`、`tools/reverse-geocoder-proxy/server.py`、`tools/reverse-geocoder-proxy/test_server.py`。

使用包含该 URL 的 Preview `versionCode=106`（APK SHA-256 `2172422daf3ed59a0c84979aa3e4e442e463f4d2b032dd58a6c6e408d83feac8`）在 `emulator-5560` API 30 完成日历→新建日程→获取当前位置：注入 GPS fix 后，代理收到 `POST /reverse` 并返回 200，UI 显示 `广东省深圳市（城市级估计）`，没有坐标回退、崩溃或中文提示异常。完整操作、APK、源码哈希和边界见 `tools/service-quality-evidence/svc08/svc08-emulator-location-evidence-r4.json`。

这只证明隔离模拟器上的城市级低置信度回退和客户端接线，不证明街道/楼栋精度、物理真机或其他 ROM、真实外部 provider SLA、生产网关部署、隐私审批、地址成功率或发布资格；`promotion_eligible=false` 保持不变。

### SVC-03 隔离 Qwen 重启恢复刷新

在当前 GPU0 容量窗口用同一 `Qwen3-ASR-0.6B`、同一固定录音和随机 loopback 端口完成 4 次独立进程周期。每次均在 `5.212–7.217 s` 内 readiness，模型/设备身份均为 `cuda:0`，真实推理返回 34 字非空文字，4 次正文哈希一致；每次进程均在探针结束时释放。证据：`tools/service-quality-evidence/svc03/svc03-qwen-restart-recovery-r3.json`。这刷新了候选进程重启稳定性，但仍不证明 systemd/服务器重启、后台任务接管、OOM、长时 soak、物理真机或生产部署，`promotion_eligible=false` 不变。

随后在同一 GPU0 隔离服务和同一 28 条冻结 manifest 上重跑成对质量：context-off `24/28` exact、关键术语 `82/84`；开启请求级受控 context 后 `28/28` exact、关键术语 `84/84`、CER mean/p95 均为 `0`，推理 p95 `301 ms`。4 worker、3 轮并发共 `12/12` 成功且 exact，词表隔离失败 `0`；模型推理 p95 `284 ms`，但单锁导致 queue_wait p95 `925 ms`、客户端 RTT p95 `1163 ms`。证据：`tools/service-quality-evidence/svc03/svc03-qwen-gpu-quality-context-r2.json`、`tools/service-quality-evidence/svc03/svc03-qwen-gpu-concurrency-r3.json`。这是隔离 0.6B 候选的质量/排队诊断，不解除实时 WebSocket/VAD、多人噪声、物理真机、OOM、systemd/服务器重启、长时 soak 或生产部署门禁；`promotion_eligible=false` 保持不变。

### SVC-03 GPU0 Qwen 冻结集复核补充

在只读容量核验确认 GPU0 约有 7.5 GiB 空闲后，使用隔离回环端口 `28130`、固定 `Qwen3-ASR-0.6B`、`CUDA_VISIBLE_DEVICES=0` 和当前服务源码重跑 28 条冻结会议语音。context-off 完成 `28/28`，规范化 exact `24/28`、关键术语 `82/84`，推理 p95 约 `300 ms`；context-on 完成 `28/28`，规范化 exact `28/28`、关键术语 `84/84`，推理 p95 约 `308 ms`。context-on 使用夹具自带的关键术语，属于受控词表/近似 oracle 诊断，不能作为无词表用户质量结论。

随后以 4 worker、3 轮、4 个互不相同的夹具做 12 请求并发诊断：`12/12` 完成、规范化 exact `12/12`、词表隔离失败 `0`；queue wait p95 约 `760 ms`，客户端 RTT p95 约 `995 ms`，模型推理 p95 约 `277 ms`。这确认当前 `INFERENCE_LOCK` 仍是多会话尾延迟瓶颈，不能把单路约 300 ms 外推为实时多会话达标。候选进程已停止，28130 端口和模型显存已释放，GPU1、8030、18020、18035 未触碰。

证据：`tools/service-quality-evidence/svc03/svc03-qwen-gpu-quality-context-r3.json`、`tools/service-quality-evidence/svc03/svc03-qwen-gpu-concurrency-r4.json`。本轮仍未覆盖真实手机麦克风/VAD、无词表真实输入、多人噪声声纹、OOM、长时 soak、生产部署或 systemd/服务器重启，`promotion_eligible=false` 保持不变。

在同一 GPU0 临时副本中应用隔离微批补丁（批大小 4、窗口 12 ms、队列 32），不修改 staging 或生产源码。相同 4 worker、3 轮、12 请求全部完成，规范化 exact `12/12`、词表隔离失败 `0`；queue wait p95 由约 `760 ms` 降至 `1 ms`，客户端 RTT p95 由约 `995 ms` 降至 `773 ms`，但批模型推理 p95 约 `767 ms`。这说明微批能显著减少排队，却会把一批请求的模型计算时间暴露给每个请求；需要在真实 WebSocket/VAD、完整 56 会话、取消/停机和内存压力下继续评估，不能仅凭这 12 条 HTTP 诊断启用。

证据：`tools/service-quality-evidence/svc03/svc03-qwen-gpu-concurrency-microbatch-r2.json`。候选端口 `28132` 已停止并释放 GPU0 显存，GPU1、8030、18020、18035 未触碰，`promotion_eligible=false` 保持不变。

同一临时微批副本随后重跑完整 28 条 context-off/on 成对冻结集：两种模式均 `28/28` 完成；context-off 仍为 exact `24/28`、关键术语 `82/84`，context-on 为 exact `28/28`、关键术语 `84/84`，两种模式推理 p95 均约 `311 ms`。因此微批 wiring 没有改变这组冻结集的语义结果；完整实时放行仍需 56 会话、真实 WebSocket/VAD、无词表输入、取消/重启和 soak。

证据：`tools/service-quality-evidence/svc03/svc03-qwen-gpu-quality-microbatch-r1.json`。

随后用新增的 `run_qwen_full_concurrency_probe.py` 对同一微批副本执行全量 `28 × 2 = 56` 请求，并以此前 context-off/on 报告作为零回退基线。context-off 为 exact `23/28`、关键术语 `81/84`，context-on 为 exact `28/28`、关键术语 `84/84`；门禁识别到历史已通过的 `M025` 在 context-off 发生回退（“四零四”被识别为“四零四十”），以退出码 `2` fail-closed。该性能收益候选因此暂不具备启用资格，必须先解决批处理下的数字/否定词稳定性并重跑全量基线。

证据：`tools/service-quality-evidence/svc03/svc03-qwen-full-concurrency-r2.json`、`tools/service-quality-evidence/svc03/run_qwen_full_concurrency_probe.py`、`tools/service-quality-evidence/svc03/svc03-qwen-microbatch-source-manifest-r1.json`。

为验证更保守的接线，又建立只在 `context_terms` 非空时进入微批、无上下文保持单请求的临时副本。全量 56 请求门禁退出码为 `0`：context-off exact `24/28`、context-on exact `28/28`，两模式历史通过项回退均为 `0`；有上下文请求 queue wait p95 约 `1 ms`、RTT p95 约 `399 ms`，无上下文请求仍为 queue wait p95 约 `831 ms`、RTT p95 约 `1101 ms`。该候选只改善已有登录/受控上下文场景，不能解决游客或无词表请求的排队问题，也还没有真实参与者上下文来源、WebSocket/VAD 和混合任务证据。

证据：`tools/service-quality-evidence/svc03/svc03-qwen-full-concurrency-context-only-r1.json`、`tools/service-quality-evidence/svc03/svc03-qwen-microbatch-context-only-manifest-r1.json`。候选端口 `28133` 已停止，未修改 staging/生产源码，`promotion_eligible=false` 保持不变。

### SVC-05 CAM++ 闭集拒识复核补充

使用 GPU0 隔离环境、真实 Silero VAD/CAM++ 中文权重和相同的三音色 manifest 重跑无泄漏闭集评测：三折留一音色 unknown，每个已登记音色只使用两条 clean enrollment，全部其余样本作为留出；共提取 `168` 个 embedding，embedding p95 约 `66.9 ms`，`required_models_ready=true`，显式可见 GPU 仅为 GPU0。

在候选阈值 `cosine=0.70 / gap=0.08` 下，clean 已登记留出 `44/44` 正确、FRR `0%`，unknown `0/28` 误接受、FAR `0%`；20 dB 噪声 FRR `4.55%`、FAR `0%`；10 dB FRR `0%`、FAR `0%`；0 dB FRR `68.18%`、FAR `0%`；居中 `1.2 s` 片段 FRR `4.55%`，`0.8 s` 片段 FRR `50%`，所有 unknown 条件 FAR 均为 `0%`。这支持“宁可拒识也不冒认”的候选方向，但不支持低信噪比或短片段自动显示姓名。

证据：`tools/service-quality-evidence/svc05/svc05-camplus-closed-set-eval-r2.json`。样本仍全部来自 TTS，未覆盖真人、多说话人重叠、相似声线、跨设备/跨天、真实 unknown cohort、DER/JER、物理真机或生产部署；`promotion_eligible=false` 保持不变。

### SVC-05 登录用户声纹到实时 Qwen 纵向刷新

在完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 上同时装配 `app.laoji.main:app`（账号服务）和 `app.main:app`（会议服务），使用临时账号 SQLite、临时声纹 SQLite 和 GPU0 隔离 Qwen 端口。账号注册返回 `201`；真实 CAM++ 从 `meeting_001.wav` 提取 192 维资料，资料质量 `0.655`、`available_in_realtime=true`，owner 查询只返回该用户的 1 条资料；会议创建返回 `201`。随后通过 Bearer WebSocket 发送同一真实 PCM，真实 Qwen3-ASR-0.6B 返回两段文本，事件顺序为 `config(readiness=ready) → stop_acknowledged → transcript.completed×2 → ready_to_stop`，两段均命中登记姓名“测试说话人”，余弦分数约 `0.8915/0.9871`，Qwen 推理约 `631/246 ms`。Qwen、Silero VAD、CAM++ 均为真实模型，ASR 文本不再使用桩；临时端口、临时 GPU 进程和数据库在探针结束后清理。证据：`tools/service-quality-evidence/svc05/svc05-authenticated-qwen-voiceprint-r1.json`。

这次纵向只证明“登录用户资料能写入、同一 owner 能被实时适配器读取并在真实 PCM 上命中”，不证明真人多人 DER/JER、FAR/FRR、跨账号完整矩阵、物理手机、长会、OOM、重启、生产 PostgreSQL 或发布。另一个装配事实必须保留：完整候选当前 `app/api/qwen_ws.py` 哈希为 `bac0…ece10e`，`qwen-asr-default` staging 的新版拒识逻辑哈希为 `d7bf…ba9d3`，两者不是同一源码；完整候选仍是旧的单段 `cos/gap` 映射，尚未包含 staging 的音频质量门禁与单资料连续合格片段共识。装配审计：`tools/service-quality-evidence/svc05/svc05-source-assembly-audit-r1.json`。

因此当前下一步不是把 staging 文件直接覆盖完整后端，而是以完整候选的访客缓存、健康快照、授权、持久化和上下文透传为基线做最小合并，并重跑完整 ASGI 合同、真实 Qwen 纵向和跨账号矩阵；同时确定正式部署的声纹数据库共享路径、备份与迁移。`promotion_eligible=false` 保持不变。

### SVC-05 完整候选拒识策略最小合并刷新

已在 `/home/yydd/.codex/tmp/svc09-r6-verify-src/app/api/qwen_ws.py` 做备份优先的最小合并，备份为 `/home/yydd/.codex/tmp/svc05-qwen_ws-full-candidate.before-identity-merge-r1.py`。合并只触及身份决策，不覆盖完整候选已有的访客转写缓存、健康快照、授权、Qwen 上下文或持久化路径：新增片段有限值/时长/RMS/削波门禁；单资料取消伪造的第二名分数，要求绝对分数和连续两个合格片段；多资料要求 cosine 与 top1-top2 gap；拒识继续只影响身份字段，不改正文和时间轴。

合并后的源文件 `py_compile` 通过；独立身份合同 `7/7` 通过；GPU0 真实 Qwen3-ASR-0.6B、Silero VAD、CAM++ 和登录用户 Bearer 纵向再次通过。两段真实转写中第一段保持 `speaker_1/identified=false`，第二段在连续合格片段后识别为登记姓名；事件顺序仍为 `config → stop_acknowledged → transcript.completed×2 → ready_to_stop`。证据：`tools/service-quality-evidence/svc05/svc05-authenticated-qwen-voiceprint-r2.json`。

完整候选 `tests/test_qwen_realtime_ws.py` 已同步当前合同夹具和单资料断言，重新运行结果为 `22 passed / 0 failed`。下一步将同一策略以备份优先方式合并到正式部署 overlay；在 overlay 缺少完整声纹/模型/授权模块前，不复制文件凑成“可启动服务”。

部署 overlay 已完成同样的身份决策切片合并，并保留原文件备份；`py_compile` 和多源码身份合同 `11/11` 均通过，源码哈希为 `dcc5b7dd…d7652f1f`。这一步只证明 overlay 中的局部策略和接线文本正确，不能证明 overlay 可启动，因为它仍缺少 `model_manager`、CAM++ 引擎、声纹数据库、账号授权和完整 WebSocket 依赖。证据：`tools/service-quality-evidence/svc05/run_speaker_identity_contract_multi.py`、`tools/service-quality-evidence/svc05/svc05-identity-contract-multi-r1.json`、`tools/service-quality-evidence/svc05/svc05-overlay-identity-merge-r1.json`。正式候选下一步必须从完整源码装配 overlay 并运行完整 ASGI/真实模型回归，不能直接把当前稀疏目录部署。

### SVC-03 当前源码 Qwen 全量并发复核 r6

在 GPU0 只读容量约 `7.5 GiB` 空闲的窗口内，以当前 staging provider 源码、`CUDA_VISIBLE_DEVICES=0`、临时回环端口 `28132` 和本地 `Qwen3-ASR-0.6B` 重新启动候选。健康响应记录：`readiness=ready`、`device=cuda:0`、`context_supported=true`；模型配置 SHA-256 为 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`，运行中的 provider 源码 SHA-256 为 `c5fd0ab2cb5bfed7e68dd445f98179e2220d741e924546b4a08e57d08e5aa0c`。

使用固定 28 条会议 WAV，context-off/context-on 各发起 28 个请求，共 56 个请求、4 个并发 worker：两种模式均 `28/28` 完成且错误为 `0`；context-off 为规范化 exact `24/28`、关键术语 `82/84`，context-on 为 exact `28/28`、关键术语 `84/84`。相对上一份 current 报告，context-off 的 24 个历史通过项和 context-on 的 28 个历史通过项均无回退。context-off 客户端 RTT p50/p95/max 为 `1227/1736/2220 ms`，排队 p50/p95/max 为 `940/1341/1880 ms`；context-on RTT 为 `1191/1318/1366 ms`，排队为 `884/1005/1020 ms`；模型推理 p95 分别约 `426/350 ms`。尾延迟主要来自 provider 内部单推理锁，不能把无错误或单路推理时间当作实时多会话达标。

权威报告为 `tools/service-quality-evidence/svc03/svc03-qwen-full-concurrency-r6-current.json`，探针使用现有 `run_qwen_full_concurrency_probe.py`，其基线比较器同时兼容当前和旧 exact 字段。候选进程在报告完成后已停止，`28132` 已释放，未触碰 `8030`、`18020`、`18035`、GPU1 或生产服务。

该复核只提升当前源码的隔离 HTTP 冻结集证据，不改变任何默认配置，也不解除 `promotion_eligible=false`。仍未证明无受控词表的真实用户质量、WebSocket/VAD 切段、多人噪声和注册声纹 DER/JER/FAR/FRR、物理真机录音、取消/断线、GPU OOM、systemd/服务器重启、长时 soak、完整多 worker ASGI 或生产部署。下一步优先补真实 WebSocket/VAD 的完整冻结集与长会话/压力故障注入，而不是再次重复同一 HTTP 夹具。

随后在完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 上执行真实 ASGI/WebSocket 纵向，仍使用临时 SQLite、随机端口、GPU0 和本地 `Qwen3-ASR-0.6B`。健康身份为 `readiness=ready`、`context_supported=true`、`identity_pinned=true`、`identity_verified=true`；本次运行中的候选 provider SHA-256 为 `f857c806506dc2d5479424b313a9a36740af3db769e2cfff66df726a3795740b`，模型配置 SHA-256 保持 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`。

游客真实 PCM 经过 `config → stop_acknowledged → transcript.completed → ready_to_stop`，转写缓存读取和删除均成功；两个登录 owner 的上下文词数分别严格为 `1` 和 `3`，均只读取自己的资料，游客为 `0`，跨 owner 未出现词数串入。完整检查全部通过，报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-r2-current.json`。报告中还保留一个重要质量事实：两个合成资料的当前片段余弦分数约 `-0.0023`，因此事件仍为 `identified=false`，没有为了显示姓名而放宽拒识门禁。

该纵向只证明真实适配器、停止排空、缓存清理、上下文 owner scope 和 provider 身份接线，不能证明真实注册录音质量、多人/噪声 DER/JER/FAR/FRR、长会话尾延迟、OOM、重启、soak、物理真机或生产部署；`promotion_eligible=false` 保持不变。

4 路真实 WebSocket 并发复核首次发现完整候选事件只透传 `infer_ms`，缺失 `queue_wait_ms`、`model_infer_ms` 和 `provider_total_ms`，导致尾延迟无法审计。staging 与 `server-work/summary` 已有这些字段，故在完整候选上备份 `/home/yydd/.codex/tmp/svc09-r6-verify-src/backups/observability-20260802/qwen_ws.before-timing-r1.py` 后做最小同步，并通过 `py_compile` 与静态字段合同。

修复后使用同一 4 个会议 WAV、同一预热配置和临时 SQLite 重跑，报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-r3-current.json`：4/4 会话 lifecycle、缓存、时间轴、清理和无错误检查均通过；墙钟 p50/p95/max 为 `3648/4255/4266 ms`，每会话 provider timing 已出现，最大 provider p95 约 `546 ms`。首次 r1/r2 结果保留为诊断证据：r1 证明生命周期通过但 timing 为空，r2 证明字段已透传但探针错误地排除了 stop 前已完成全部片段的合法顺序；最终 r3 修正协议断言后通过。

这只提升候选可观测性和 4 路 WebSocket 生命周期证据，不改变生产默认配置，也不证明多人/噪声质量、实时尾延迟验收、OOM、重启、两小时 soak、Android 或生产多 worker，`promotion_eligible=false` 保持不变。

并发复核同时刷新了完整候选的一个装配缺口：初次报告中 `transcript.completed` 缺少三段 provider timing，已由最小同步补齐并通过真实复跑。最终 `r3` 报告的 4 路会话均通过 `backend_ready`、`qwen_ready`、lifecycle、缓存、时间轴、清理、无错误和健康回读；provider p95 最大约 `545.6 ms`，会话墙钟 p95 约 `4254.7 ms`。该报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-r3-current.json`，代码备份为 `/home/yydd/.codex/tmp/svc09-r6-verify-src/backups/observability-20260802/qwen_ws.before-timing-r1.py`。

在显式支持模型预热开启、并等待 `/api/ready=200` 后，使用当前完整候选再次执行短长会话和断线探针。6 条固定会议 WAV（总时长 `37.73 s`，`realtime_factor=2.0`）的正常会话产生 `9` 个最终片段；事件顺序包含 `config`、中途片段、`stop_acknowledged`、最后片段和 `ready_to_stop`，缓存回读为 `9` 条，结束时间单调，正常清理成功。客户端未发送停止标记而断线的会话在 `99` 个音频帧后仍落盘 `4` 条，连续轮询得到 `[4,4,4]`，随后删除清理成功。Qwen、VAD、CAM++ readiness 在会话前后均保持为真。

权威报告为 `tools/service-quality-evidence/svc03/svc03-qwen-long-session-r9-current.json`。首次以关闭预热配置运行时 `/api/ready` 正确返回 `503`，未进入录音；这确认部署候选必须等待支持模型预热，而不能只看 `/api/health` 存活。当前复核仍只覆盖约 38 秒、6 条固定音频、单会话和一次断线，不代表两小时 soak、多人/噪声质量、OOM、服务器重启、物理真机或生产多 worker，`promotion_eligible=false` 保持不变。

随后以当前完整候选 provider、同一 `Qwen3-ASR-0.6B`、`CUDA_VISIBLE_DEVICES=0` 和随机 loopback 端口完成 4 次独立的“启动→就绪→真实推理→终止”周期。4 次均 `readiness=ready`、`identity_pinned=true`、`identity_verified=true`，启动耗时 `5.412–6.416 s`，provider 推理 `751–781 ms`，均返回 34 字非空结果且正文 SHA-256 完全一致；模型配置和 provider 源码哈希在四次中保持不变。证据为 `tools/service-quality-evidence/svc03/svc03-qwen-restart-recovery-r4-current.json`。

这只证明候选 Qwen 进程级重启和本地推理稳定性，不证明 systemd/服务器重启、ASGI/数据库任务接管、未完成 WebSocket 恢复、OOM、长时 soak、Android 或生产部署，`promotion_eligible=false` 不变。

补跑双账号 owner 范围探针：账号甲和账号乙各注册一条真实 CAM++ 资料，两个 owner 查询均只得到自己的 1 条资料；账号乙使用账号甲音频时只得到账号乙资料的低分最佳猜测 `0.3430`，不返回账号甲姓名；单段弱证据按共识门禁继续保持 `speaker_1/identified=false`。该探针使用确定性 ASR 替身，只验证 owner 过滤和跨账号拒识，证据：`tools/service-quality-evidence/svc05/svc05-authenticated-cross-account-r1.json`。它不替代真人跨设备/跨天、多人 DER/JER、FAR/FRR 或共享声纹存储验证。

### SVC-05 旧会议重匹配纵向补充

本轮对完整候选 `app/services/meeting_speaker_service.py` 做了最小的 fail-closed 修正：重试任务会重新绑定当前 `profile_revision` 和模型版本；资料重命名、补充或撤销发生在模型调用前后时，任务在提交前再次检查资料状态，避免把旧姓名或已撤销向量写入会议；每个片段在读取和写入前都重新检查人工锁定，而不是只依赖任务开始时的快照；只含人工锁定或无可用资产的会议仍会计入处理进度；资料撤销错误不可重试，模型暂时不可用仍可重试。

使用真实候选服务、临时 SQLite、真实 ffmpeg 音频窗口和实际任务表运行纵向：3 场旧会议全部计入 `total_meetings/processed_meetings`，人工锁定 `2` 个片段未被覆盖，首次匹配只写入未锁定片段；同一幂等键重放返回原任务 `200` 且没有新任务；资料版本变化先以 `speaker_profile_changed` fail-closed，重试后刷新到新版本并完成；处理中撤销以 `speaker_profile_unavailable` 终止且不产生新归属；模型不可用以可重试失败终止，恢复模型后同一任务第二次尝试完成；所有 Transcript 正文、开始时间和结束时间保持原值。探针最终 5 条 assignment（2 条人工、3 条候选/恢复）持久化，所有检查通过。

证据与边界：`tools/service-quality-evidence/svc05/svc05-speaker-reprocess-runtime-r1.json`、`tools/service-quality-evidence/svc05/run_speaker_reprocess_runtime.py`。提取器在该探针中使用确定性 192 维替身，因此没有新增 DER/JER/FAR/FRR 结论；运行只覆盖单进程 SQLite/ffmpeg，不覆盖 PostgreSQL 锁、多 worker 竞态、正式声纹共享存储、备份迁移、完整 ASGI 或生产部署，`promotion_eligible=false` 保持不变。

随后在隔离本地 SQLite、关闭模型预热的配置下，完整候选 `app.main` 与 `app.laoji.main` 均可导入；部署 overlay 因缺少 `app.config` 即无法独立导入，不能通过复制单个重匹配服务文件补齐。装配快照和导入结果固定在 `tools/service-quality-evidence/svc05/svc05-source-assembly-audit-r2.json`，正式部署仍必须从同一完整源码清单组装并重新运行 ASGI/真实模型验证。

### SVC-09 录音资产 ASGI 与 PostgreSQL 纵向刷新

使用当前完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 重新运行真实 FastAPI lifespan 和 HTTP 路由，录音资产登记、同键重放、请求标识复用冲突、错误内容上传、正确内容上传、内容回读、转写任务创建/重放和持久化查询共 `13/13` 通过。SQLite 与一次性 PostgreSQL 16 loopback 容器均通过，两个报告绑定相同的 `app_recording_v2.py` 与 `meeting_recording_asset_service.py` 源码哈希；错误上传不会留下音频文件，正确上传只保留一个文件，数据库最终为 `asset=1 / operation=3 / transcription_job=1`。

证据：`tools/service-quality-evidence/svc09/svc09-full-asgi-recording-flow-r2.json`、`tools/service-quality-evidence/svc09/svc09-full-asgi-recording-flow-postgresql-r2.json`、`tools/service-quality-evidence/svc09/run_full_asgi_recording_flow.py`。该纵向仍使用替身转写提交器，不能证明真实 ASR 质量、ffmpeg 长任务、多进程 PostgreSQL 竞争、GPU OOM、服务器重启、systemd 或 soak；临时 PostgreSQL 容器已删除，`promotion_eligible=false` 保持不变。

### SVC-09 摘要 canonical 存储修正

复核完整候选发现，`app/api/meetings.py` 的后台转写路径在 `result.summary` 存在时曾直接打开候选目录下的 `local.db`，绕过当前 `AsyncSession`。这会让 PostgreSQL 会议的 Transcript 写入主库、摘要却写入另一份 SQLite。现已改为复用 `transcription_session_factory` 或 canonical `async_session` 创建 `FinalSummary`，不再直接调用 `sqlite3`。

以真实音频解码和真实 `process_audio_in_background` 持久化路径运行确定性 ASR 替身：SQLite 与一次性 PostgreSQL 16 均通过 `7/7`，摘要正文和 JSON 字段、Transcript、会议终态均在同一数据库中，临时音频被清理。证据：`tools/service-quality-evidence/svc09/svc09-summary-canonical-storage-r1.json`、`tools/service-quality-evidence/svc09/svc09-summary-canonical-storage-postgresql-r1.json`、`tools/service-quality-evidence/svc09/run_summary_canonical_storage_probe.py`。该证据不代表真实 ASR/摘要质量，也不覆盖生产多进程和长任务；`promotion_eligible=false` 保持不变。

同类审计又发现 `app/workers/summary_tasks.py` 的阶段总结和最终总结子进程也直接写固定 `local.db`。现已改为在 worker 自己的事件循环中创建独立 SQLAlchemy engine/session，按当前 `DATABASE_URL` 写入 `PeriodSummary`/`FinalSummary`，并在结束时释放 engine；这样不会复用 API loop 的 async engine，也不会把 PostgreSQL 会议摘要落到旁路 SQLite。SQLite 与 PostgreSQL worker 存储探针均 `4/4`，摘要任务相关回归 `56 passed`。

证据：`tools/service-quality-evidence/svc09/svc09-summary-worker-canonical-storage-r1.json`、`tools/service-quality-evidence/svc09/svc09-summary-worker-canonical-storage-postgresql-r1.json`、`tools/service-quality-evidence/svc09/run_summary_worker_canonical_storage_probe.py`。LLM 生成、进程重启、生产多 worker 和长任务仍未覆盖，`promotion_eligible=false` 保持不变。

随后补充真实 `multiprocessing` `spawn` 边界探针：父进程只负责建表和写入会议，独立子进程导入完整 `summary_tasks`，分别写入 `PeriodSummary` 与 `FinalSummary`，父进程再从 canonical SQLAlchemy session 回读并校验 JSON 内容。SQLite 与一次性 PostgreSQL 16 loopback 容器均 `6/6` 通过，`start_method=spawn`、子进程退出码为 0，源码哈希与当前候选一致；容器已在探针结束后删除。证据：`tools/service-quality-evidence/svc09/svc09-summary-worker-spawn-storage-r1.json`、`tools/service-quality-evidence/svc09/svc09-summary-worker-spawn-storage-postgresql-r1.json`、`tools/service-quality-evidence/svc09/run_summary_worker_spawn_probe.py`。这比线程隔离探针更接近实际进程边界，但仍只验证持久化，不包含真实 LLM 生成、多 worker 竞争、进程/服务器重启、长任务或生产 systemd/soak，`promotion_eligible=false` 不变。

又补充 PostgreSQL 多进程租约竞态：每轮由两个独立 `spawn` 子进程同时领取同一 queued 任务，再将同一任务置为过期并重复竞争；连续 8 轮 queued 与 expired takeover 均恰好一个赢家，attempt 只从 1 递增到 2，租约令牌没有重复，子进程无错误。r2 先把最新 overlay 的 `meeting_recording_asset_service.py`、模型和 admission 文件装配到临时完整根，源码哈希 `6fa9e009…` 与当前 overlay 一致后再运行；r1 仍保留为较早完整根的历史结果，不作为最新候选证明。当前证据：`tools/service-quality-evidence/svc09/svc09-transcription-postgresql-spawn-race-r2.json`、`tools/service-quality-evidence/svc09/run_transcription_postgresql_spawn_race.py`。这是一次性 loopback PostgreSQL 的真实行锁/进程边界证据，不能替代生产 PostgreSQL 配置、完整 ASGI、provider submission、真实 ASR/ffmpeg、重启或 soak，`promotion_eligible=false` 仍保持。

### SVC-03/SVC-05 移动端讲话人身份接线补充

复核实时转写纵向接线时发现，Android/Expo 端此前只透传 `speaker_name`，并在 `MeetingLiveScreen` 中把姓名写入 `TranscriptLine.speaker_id`；这会破坏声纹资料关联、后续人工修改和跨页面身份一致性。Android 原生会议页的 `nativeMinutesSnapshots` 还会丢弃置信度，且在分组时会把显示姓名推断为身份。现已把服务端 `speaker_id`、`speaker_name`、`speaker_confidence` 分成独立字段贯穿 Kotlin 解析、原生事件、TypeScript facade、普通会议页和原生会议页落库：稳定 ID 缺失时只落 `unknown`，姓名只作为展示标签和非身份 UI 文本，分组/管理不再从姓名推断 ID，非法/越界置信度按缺失处理。

源级窄合同现为 `14/14`，证据为 `tools/service-quality-evidence/svc03/svc03-mobile-speaker-identity-contract-r1.json`，脚本为 `tools/service-quality-evidence/svc03/run_mobile_speaker_identity_contract.py`。当前 Preview 包 `versionCode=106`、`versionName=1.0.0-source-preview`、SHA-256 为 `8a315a7d58693d52b3a7735a736a5ca0a41dc7904250619509d782fc6a0f887c`；已覆盖安装至 `emulator-5560`，包含最终分组修复，冷启动进程存活且日志出现 `Running "main"`，没有 `FATAL EXCEPTION`、脚本缺失或 SQLite schema 错误。该证据只证明字段不再互相覆盖和包能在模拟器启动，不证明真实多人/噪声 DER/JER、FAR/FRR、物理真机录音、服务端质量或生产部署；`promotion_eligible=false` 保持不变。

在同一 r7 overlay 上补了真实 ffmpeg 纵向：生成临时 45 秒、含视频轨和音频轨的 MP4，走候选 `create_media_clip_job`、真实 `_run_media_clip_job_async` 和 ffmpeg 导出，再由数据库回读状态、输出 WAV 格式、30 秒时长、大小和 SHA-256，最后执行删除并确认派生文件消失。SQLite 与一次性 PostgreSQL 16 均 `8/8` 通过，服务与模型源码哈希均为当前 overlay 版本。证据：`tools/service-quality-evidence/svc09/svc09-media-clip-ffmpeg-runtime-r1.json`、`tools/service-quality-evidence/svc09/svc09-media-clip-ffmpeg-runtime-postgresql-r1.json`、`tools/service-quality-evidence/svc09/run_media_clip_ffmpeg_runtime_probe.py`。样本是合成单任务，仍未覆盖真实长视频、超时、磁盘不足、多 worker ffmpeg 竞争、生产重启和 soak，`promotion_eligible=false` 不变。

本轮窄回归还发现 r6 完整验证根的会议问答缓存键没有同步最新 overlay 对“缺少 `input_fingerprint` 的内部直接调用”的 evidence-only fallback；最新 `server-work/summary/backend` 已有该保护，r6 临时根同步后摘要/问答/会议合同回归为 `72 passed`。这只是验证装配漂移修正，不构成新的生产部署或模型质量结论。

随后补充进程重启恢复纵向：父进程创建 expired、queued、live lease 和 terminal 四类任务及遗留 attempt 文件，独立 `spawn` 替代进程执行恢复、提交记录、重新领取 expired 任务并完成 attempt 2。SQLite 与一次性 PostgreSQL 16 均 `9/9` 通过；expired/queued/terminal 的可回收文件被清理，live lease 的 attempt 文件保持不动。证据：`tools/service-quality-evidence/svc09/svc09-transcription-restart-recovery-spawn-r1.json`、`tools/service-quality-evidence/svc09/svc09-transcription-restart-recovery-spawn-postgresql-r1.json`、`tools/service-quality-evidence/svc09/run_transcription_restart_recovery_spawn_probe.py`。该探针仍使用确定性完成，不调用真实 ASR；systemd/服务器级重启、真实 provider 接管、长任务和 soak 仍未证明，`promotion_eligible=false` 不变。

### SVC-06 当前候选导入链修复

重新运行 compact summary 合同时发现，当前 `server-work/summary` 导出不是完整可导入树：`app.service_telemetry` 文件缺失，现行 `meetingsummary.ollama_client` 也没有提供遥测上下文，导致 `app_summary_generator` 在真正执行前就失败。候选侧已补齐隐私安全的请求/阶段遥测模块，并恢复 Ollama/OpenAI-compatible 客户端的 trace span 收集，同时保留 `priority`、队列截止和操作标签 header；不记录转写、提示词或模型正文。

合同脚本 `run_compact_summary_runtime_contract.py` 现在要求显式候选根，支持 `backend/app` 与完整 `app` 两种布局，结果写入候选布局、源码哈希和解释器边界，不依赖调用者的全局 `PYTHONPATH`。当前 `server-work/summary` 源码真实导入和结果归一化合同 `9/9` 通过，证据：`tools/service-quality-evidence/svc06/svc06-compact-summary-runtime-contract-r2-local.json`。模型调用仍为 stub，未证明真实模型事实质量、引用召回、生产 ASGI/数据库、并发速度或部署；`promotion_eligible=false` 保持不变。

遥测边界合同进一步验证 `9/9`：Ollama 返回的模型/加载/提示词/生成耗时可被收集，操作标签和 trace 保留，但请求正文、提示词和模型输出不会进入 span；证据：`tools/service-quality-evidence/svc06/svc06-candidate-telemetry-contract-r1.json`。该合同不证明真实上游接受优先级或生产遥测完整性。

### SVC-07 账号、日程、声纹共享存储迁移切片

在完整候选 `/home/yydd/.codex/tmp/svc07-r9-verify-src` 中完成三类直接 SQLite 服务的 PostgreSQL 兼容切片，仍未切换线上进程：账号服务使用 `LAOJI_AUTH_DATABASE_URL`，日程服务使用 `LAOJI_SCHEDULE_DATABASE_URL`，声纹服务使用 `LAOJI_SPEAKER_DATABASE_URL`。旧 `BEGIN IMMEDIATE` 在适配层映射为 PostgreSQL `BEGIN`；重复账号唯一键异常先回滚再转为稳定业务错误；账号删除会清理共享日程的事件、例外、分段和命令表。

日程保留重复事件展开、实例/后续/系列编辑和状态命令幂等；声纹二进制 embedding 使用 `BYTEA`，私有声纹按 `owner_user_id` 过滤，旧全局声纹仍与私有资料隔离。三类 schema 初始化共享 PostgreSQL advisory transaction lock，并按 DSN 在进程内只初始化一次，避免并行进程重复 DDL/清理造成 deadlock。

候选 `requirements.txt` 与 `requirements-prod.txt` 已显式声明 `psycopg[binary]`，不会依赖验证机临时安装。

新增 `tools/service-quality-evidence/svc07/migrate_laoji_sqlite_to_postgres.py`：空目标默认、单事务复制、逐表计数/哈希校验、ID/序列保留、头像复制和显式 replay 校验；默认不执行在线双写或生产切换。生产门禁改为只有三类 DSN 都是 PostgreSQL、`LAOJI_STORAGE_MIGRATION_STATE=ready` 且存在 `LAOJI_STORAGE_MIGRATION_ID` 才允许 `ENV=production`，否则保持稳定中文拒绝。

当前候选证据：账号存储合同 `19/19`、日程共享存储合同 `12/12`、声纹共享存储合同 `16/16`、SQLite→PostgreSQL 迁移首跑+replay 通过、生产存储门禁 `5/5`；脚本分别为 `run_postgres_auth_storage_contract.py`、`run_postgres_schedule_storage_contract.py`、`run_postgres_speaker_storage_contract.py`、`run_sqlite_to_postgres_migration_contract.py`、`run_production_storage_guard_contract.py`。所有报告均保持 `promotion_eligible=false`，只证明一次性 PostgreSQL 16 loopback 候选和存储边界，不证明真实数据库备份/副本、在线切换、生产多 worker、真实 CAM++/ASR 质量或 Android。

窄回归：日程/事件/账号写保护 `32 passed`，讲话人 owner 隔离 `7 passed`；账号历史测试中有一条固定日期的密码重置清理样例因当前时间超过 30 天保留策略而失败，属于测试数据陈旧，不改变实际保留策略，需在后续测试维护中改为相对当前时间构造。

下一步是把迁移工具接入真实 SQLite 备份副本，完成目标库备份/恢复和双写冻结/回滚演练，再以同一完整源码根补跑 production ASGI、跨进程连接池、账号删除全链路和声纹真实质量；在这些条件满足前不得设置迁移 ready 标记或解除生产 fail-closed。

补充 production ASGI 预演：在一次性 PostgreSQL 16 loopback 容器中以三类 DSN、迁移 ready 标记和完整候选 `app.laoji.main` 启动真实 FastAPI lifespan；启动阶段主动初始化账号、日程和声纹 schema，注册 `201`、登录 `200`、Bearer 创建日程 `201`、列表 `200`、状态命令 `200`，命令后数据库日程数为 `0`。最新证据：`tools/service-quality-evidence/svc07/svc07-postgresql-laoji-asgi-contract-r2.json`、`run_postgresql_laoji_asgi_contract.py`。这只证明老记入口接线和候选 PostgreSQL 持久化，不证明真实生产凭据/ingress/Redis、备份副本、多 worker、重启/soak、Android 或模型质量。

### SVC-07 当前完整候选 PostgreSQL 与生产存储边界

验证器改为显式接收 `--root` 和 `--python`，并保留虚拟环境入口的符号链接，避免解析到基础解释器后丢失 `asyncpg` 等候选依赖。当前完整候选 `svc07-r9-verify-src` 在一次性 PostgreSQL 16 loopback 容器中完成迁移、真实 FastAPI lifespan、Bearer 校验、问答路由和持久化回读，路由、40 张必需表和 `thread=1/turn=1/citation=0` 均通过；SQLite ASGI smoke 同时验证健康、`/api/ready=503`、trace/Server-Timing 和中文问候快路径。证据：`tools/service-quality-evidence/svc07/svc07-question-postgresql-smoke-r3-current.json`、`tools/service-quality-evidence/svc07/svc07-question-local-asgi-sqlite-smoke-r2-current.json`。

同一候选在 `ENV=production` 下明确拒绝启动，因为账号、日程和声纹仍未迁移到共享数据库；生产拒绝、稳定中文错误码、两种数据库 URL 的 lifespan 拒绝和 `asyncpg` 依赖检查共 `12/12` 通过，证据：`tools/service-quality-evidence/svc07/svc07-production-storage-boundary-contract-r3-current.json`。这证明了 fail-closed 边界和会议 PostgreSQL 路径，不证明账号/日程/声纹共享存储迁移、真实模型质量、多进程生产启动或发布资格。

### SVC-06/SVC-07 本轮隔离复核

使用现行源码和既有候选解释器重新复核：SVC-06 目录级 pytest（含 `test_guest_summary_smoke.py`）通过 `4 passed`；文本边界 `12/12`、遥测隐私边界 `9/9`、待办/决定原文支持门禁 `9/9` 均通过。归档目录 `source-backups/` 已增加收集忽略规则，历史副本不再污染活动测试收集；归档内容未修改。

SVC-07 本轮补跑当前候选 SQLite/ASGI smoke：健康与生命周期、`/api/ready=503`、中文问候快路径、trace/Server-Timing 共通过，证据：`tools/service-quality-evidence/svc07/svc07-question-local-asgi-smoke-r3-current.json`；候选问答源级测试 `2/2` 通过。一次性 PostgreSQL 16 loopback 容器中重新执行 Alembic 三次迁移、真实 FastAPI lifespan、Bearer 保护问答路由和数据库回读，必需表 `40/40`、thread/turn/citation `1/1/0`、清理监督启停和 `transient=false` 全部通过，证据：`tools/service-quality-evidence/svc07/svc07-question-postgresql-smoke-r4-current.json`。容器已删除，端口已释放。

上述结果仍是隔离候选证据：没有连接真实生产 PostgreSQL、Redis、Ollama/embedding 服务，没有执行独立 9B 资源容量或多 worker 性能 Gate，也没有解除账号/日程/声纹共享存储未迁移的生产拒绝；所有报告继续保持 `promotion_eligible=false`。SVC-06 真实模型长会质量、引用召回和混合负载，以及 SVC-07 独立 9B 冷暖/并发/恢复性能仍是下一阶段工作。

### SVC-07 SQLite 快照迁移安全补充

迁移工具 `tools/service-quality-evidence/svc07/migrate_laoji_sqlite_to_postgres.py` 现在支持显式 `--snapshot-dir`：迁移前通过 SQLite 原生 `backup` API 创建一致性副本，源库不写入；副本执行 `integrity_check` 与 `foreign_key_check`，并在报告中记录字节数和 SHA-256。显式 `--reuse-snapshots` 只允许复用并重新校验已有副本，供同一冻结数据的重放使用；默认仍拒绝覆盖已有快照。

独立备份/恢复合同验证快照冻结、源库后续写入隔离、恢复结果和完整性共 `6/6`；一次性 PostgreSQL 16 loopback 迁移合同验证首次迁移、同一快照重放、快照路径与完整性、账号/日程/声纹/头像回读共 `10/10`。证据：`tools/service-quality-evidence/svc07/svc07-sqlite-backup-restore-contract-r1.json`、`tools/service-quality-evidence/svc07/svc07-sqlite-postgresql-migration-contract-r3-current.json`。

这只完成了可重复的本地快照迁移候选，不等于生产备份副本、实时双写冻结、在线切换、PostgreSQL 回滚、复制/保留策略或多进程源库写入窗口；生产存储门禁继续保持拒绝，`promotion_eligible=false`。

### SVC-03 GPU0 全量并发复跑与证据比较器修正

在 GPU0 隔离容量窗口使用当前 `Qwen3-ASR-0.6B`、`CUDA_VISIBLE_DEVICES=0`、临时端口 `28140` 和固定 28 条会议语音，完成 context-off/context-on 各 28 条、共 56 条 HTTP 并发请求。两种模式均为 `28/28` 完成、无请求错误；context-off 为规范化 exact `24/28`、关键术语 `82/84`，context-on 为 exact `28/28`、关键术语 `84/84`。4 worker 下 context-off 的客户端 RTT p95 `1217 ms`、排队 p95 `923 ms`，context-on 的客户端 RTT p95 `1077 ms`、排队 p95 `824 ms`；模型推理 p95 约 `306 ms`，其余尾延迟主要来自现有单推理锁排队。

复跑前发现全量探针的基线比较器只读取已废弃的 `canonical_reference/canonical_hypothesis` 字段，会把旧报告中实际失败的样本误报为历史通过。现已增加兼容读取：优先使用当前 `canonical_exact`，仅对旧格式回退到旧字段。修正后的报告显示 context-off 基线实际通过项为 `24`、回退 `0`，context-on 基线通过项为 `28`、回退 `0`，进程退出码为 `0`。证据：`tools/service-quality-evidence/svc03/svc03-qwen-full-concurrency-r4-current.json`、`tools/service-quality-evidence/svc03/run_qwen_full_concurrency_probe.py`。

这次仅修正证据工具并刷新隔离诊断，不改变生产配置或默认微批开关。固定 TTS、受控上下文和 HTTP 夹具仍不能代表真实手机麦克风、WebSocket/VAD、无词表多人噪声、取消、OOM、systemd/服务器重启、长时 soak 或生产部署；单锁排队也未达到实时多路尾延迟验收，`promotion_eligible=false` 保持不变。候选服务、端口和临时 GPU 显存已在复跑后释放，GPU1、8030、18020、18035 未触碰。

### SVC-03 真实 Qwen 到 WebSocket 适配器纵向补充

在同一 GPU0 隔离 Qwen3-ASR-0.6B 服务上，以当前候选 `server-work/summary/backend/app/api/qwen_ws.py` 和真实固定音频运行适配器 smoke。日程语音与会议语音共 `2/2` 通过：均收到 `config → stop_acknowledged → transcript.completed → ready_to_stop`，无错误事件，计时字段完整；日程规范化 exact `1/1`，会议规范化 exact `1/1`（实际分为 2 个最终片段），真实 Qwen provider 和请求级上下文均被记录，候选持久化回调数量符合预期。证据：`tools/service-quality-evidence/svc03/svc03-qwen-websocket-real-smoke-r2-current.json`、`tools/service-quality-evidence/svc03/run_qwen_websocket_real_smoke.py`。

该 smoke 的支持模型、数据库和鉴权是隔离桩；运行日志还明确 `app.asr.enhanced_engine` 不在该适配器隔离目录中，因此声纹识别未被虚报为通过。它不能替代真实 Silero/CAM++ 概率、多人/噪声声纹、生产 ASGI/数据库、并发、Android 真机、重启或 soak，`promotion_eligible=false` 保持不变。临时 Qwen 进程、28140 端口和 GPU0 临时显存已释放。

### SVC-04 gpu0_preview 自适应模型实测

按规划中的 `gpu0_preview` 档位，在隔离 venv `/home/yydd/.cache/laoji-qwen-asr/venv` 安装 `faster-whisper==1.1.1`、`ctranslate2==4.8.1` 和 `av==18.0.0`，使用本地缓存的 `Systran/faster-whisper-small` 与 `medium`，不访问生产网关。新增 `tools/service-quality-evidence/svc04/run_faster_whisper_preview_probe.py`，对模型目录逐文件计算 SHA-256，并记录 GPU0 加载前/后/运行后的显存快照、每条音频 RTF 和冻结集质量；脚本明确固定 `num_workers=1`、`promotion_eligible=false`，不能替代 SVC-04A large-v3 Gate。

GPU0 small（模型树 `f8995cc6…`）在 28 条会议音频上 `28/28` 完成，规范化 exact `11/28`，关键词召回 `64/84`，canonical CER mean/p95 `7.44%/26.68%`，RTF p95 `0.040`，加载后显存约 `1.0 GiB`；同一模型在 68 条日程音频上 `68/68` 完成，规范化 exact `45/68`，canonical CER mean/p95 `6.89%/30.00%`，RTF p95 `0.074`。GPU0 medium（模型树 `c1191e24…`）在 28 条会议音频上 `28/28` 完成，但 exact 仅 `6/28`、关键词召回 `43/84`、canonical CER mean/p95 `18.66%/44.66%`，加载后显存约 `2.3 GiB`，RTF p95 `0.079`。完整报告：`tools/service-quality-evidence/svc04/svc04-faster-whisper-small-gpu-preview-r1.json`、`svc04-faster-whisper-small-gpu-schedule-preview-r1.json`、`svc04-faster-whisper-medium-gpu-preview-r1.json`。

这组实测只证明轻量 GPU provider 能在当前容量下加载、推理并释放显存；small/medium 均未达到 SVC-04 的质量门槛，不能因速度或显存优势自动替代 large-v3，也不能把模型缓存下载完成当作 `model_ready`。当前自适应选择结论为：保留 small 作为端到端 preview/恢复演练档，medium 暂不升档；正式候选仍须独立质量、格式矩阵、分块恢复、OOM、重启和 soak Gate。生产端口和 GPU1 未触碰，所有临时模型进程已结束。

本轮复跑 `python3 -m pytest -q tools/service-quality-evidence/svc04/test_real_model_gate_tools.py` 时，结果为 `32 passed / 3 failed`。3 个失败均来自 `server-work/asr-gateway-candidate/README.md` 当前 SHA-256 `dfb34026…` 与冻结 r4 审计哈希 `e0b6a877…` 不一致，发生在候选校验、fresh archive 和 non-mutating plan 三个用例；不是模型推理或依赖导入失败。该候选目录没有可用 Git 历史，且 README 属于既有工作区变更，本轮未覆盖、回退或擅自刷新审计哈希。SVC-04A 的 staging/release Gate 因此继续 fail-closed，必须由拥有候选快照来源的人重新确认 README 版本后，重新生成完整审计证据，不能只改一个哈希绕过校验。

上述 r4 记录已由后续 r5 文档-only refresh 覆盖，不再作为当前测试结果。

### SVC-04 候选审计 r5 文档刷新

确认当前候选的 `main.py`、`api/full_audio.py`、`services/full_audio.py`、`services/full_audio_chunking.py` 和 `models/whisper_engine.py` 均与 r4 审计哈希一致，唯一变化是此前 SVC-09A 更新的 `README.md`。新增 `offline-chunk-checkpoint-postaudit-r5.json`，只更新 README 哈希并明确 `runtime_artifacts_unchanged_from_r4=true`；未放宽模型、依赖或运行身份约束。

`stage_real_model_gate.py --action plan --run-id svc04-r5-doc-refresh` 已成功生成非变更 plan，绑定 r5 证据、当前候选目录和 loopback `127.0.0.1:28002`；SVC-04 工具回归现在为 `35 passed / 15 subtests passed`。证据：`tools/service-quality-evidence/svc04/offline-chunk-checkpoint-postaudit-r5.json`、`tools/service-quality-evidence/svc04/svc04-plan-r5-doc-refresh.json`。

这只解除候选文档快照漂移，不代表 large-v3 provider smoke 或 60 分钟 pilot 已通过。GPU0 当前不足 `12288 MiB` 的启动门槛、真实模型质量、GPU RTF、OOM、重启和 soak 仍保持发布阻断；未启动远端 stage、未连接生产端口，`promotion_eligible=false` 不变。

### SVC-04 导入后转写触发修复

审计发现新建导入会议的 canonical 分支只写入 `RecordingAsset`、请求根同步并恢复上传，却没有通知 `MeetingTranscriptCompletionProvider` 进行录音资产发现；因此文件可能已经本机落库并上传，但不会创建远端录音转写任务。现已在 canonical 投影确认之后补齐触发，并抽出作用域守卫供新建和追加两条导入路径共用。

实现约束：

- 只对账号作用域发出 `discoverRecordingAssets=true`，访客导入不进入账号云端转写链路；
- 触发发生在 canonical 投影可读之后，避免 provider 发现一个尚未可解析的会议 ID；
- canonical 写入关闭时的兼容回退，在 `persistMeetingsStrict` 成功并更新本机列表后也发出同一信号；该分支可能仍没有远端会议身份，信号只把它交给账号协调器，不能把本机落盘误报为云端转写完成；
- 上传完成后的已有 reconciliation 触发保持不变，覆盖上传晚于导入提交的时序；
- `taskId`、`clientRequestId` 和 `idempotencyKey` 仍按远端录音资产稳定生成，SQLite 发现逻辑先按远端资产/任务 ID 查找，重复发现只补齐本地资产映射，不插入第二个任务；
- 合同 runner 只验证源码接线和触发器运行边界（当前 `10/10`），不把它解释为真实 HTTP 上传、ASR provider、模型质量或生产数据库并发证据。

证据：`tools/service-quality-evidence/svc04/svc04-import-transcript-trigger-contract-r1.json`（`9/9`）、`tools/service-quality-evidence/svc04/svc04-video-container-smoke-r1.json`（`4/4`）。本次源码已构建为 `android/app/build/outputs/apk/preview/app-preview.apk`，`versionCode=106`、SHA-256 `bcf486372a3c7dc0656a9fa555693a3eb2c951f5ad5ed6265256155474e42a41`，并覆盖安装到 `emulator-5560`；启动级日志无崩溃或 JS bundle 加载错误。

### SVC-04 原始视频上传到真实 Qwen 持久化纵向补充

为覆盖用户曾遇到的“本地视频已上传但转文字失败”，扩展 `tools/service-quality-evidence/svc09/run_real_qwen_recording_persistence_probe.py` 增加 `--raw-media` 模式。该模式保留输入文件的原始 MIME、文件名、字节数和 SHA-256，上传 `video/mp4` 原始内容；候选服务内部仍通过 ffmpeg 抽取 16 kHz 单声道 PCM，再提交隔离 Qwen provider。兼容桩现在只在候选源码缺少 `app.services.postgres_compat` 时启用，不会覆盖完整候选已有实现。

在 GPU0 `gpu0_preview` 档、临时 Qwen3-ASR-0.6B provider `127.0.0.1:28140`、临时 SQLite 和合成视频轨+AAC 音轨 MP4 上，直接 lease/commit 与真实候选 worker 两种模式均 `19/19` 通过：HTTP 登记 `201`、原始媒体上传 `200`、转写任务 `202`、provider 返回中文正文、任务完成、会议保持 `ended`、Transcript 与 asset/job ID 关联、原始 `video/mp4` 元数据保持一致、无 `.part` 或 worker 临时副本残留。权威报告：`tools/service-quality-evidence/svc04/svc04-video-qwen-persistence-r1.json`、`tools/service-quality-evidence/svc04/svc04-video-qwen-worker-persistence-r1.json`。

这条证据把“原始视频上传→音轨抽取→真实轻量 ASR→持久化”的候选链路接通，但仍只属于 `gpu0_preview`；不证明 large-v3 正式质量、真实用户 codec/长视频矩阵、PostgreSQL 多 worker、断点恢复、GPU RTF、OOM、重启、soak、物理真机或生产部署，`promotion_eligible=false` 保持不变。临时 Qwen 进程、端口、模型显存和媒体文件均已清理。

随后新增 `tools/service-quality-evidence/svc04/run_faster_whisper_chunk_recovery_preview.py`，在同一类临时 MP4 上用真实 GPU0 `faster-whisper-small` 执行 1 秒分块。探针在第一块 checkpoint 落盘后故意注入第二块失败，再从同一 `plan.json` 恢复；`8/8` 检查通过：chunk ID/计划稳定、已完成块不重跑、恢复后有非空 segment 且时间轴单调、临时 WAV/partial 文件清理完成。报告：`tools/service-quality-evidence/svc04/svc04-faster-whisper-chunk-recovery-preview-r1.json`。

该报告中的 preview 文本仍出现轻量模型的字词错误，不能计入质量 Gate；本次新增的是“真实模型参与分块与恢复”的可靠性证据，不是 CER、长音频质量或正式模型放行。模型进程结束后 GPU0 显存恢复，`promotion_eligible=false` 保持不变。

### SVC-07 迁移失败回滚与冻结快照重放补充

新增 `tools/service-quality-evidence/svc07/run_sqlite_to_postgres_rollback_contract.py`，在一次性 PostgreSQL loopback 数据库中构造账号、头像、日程和声纹资料，故意在第一张表复制完成后注入失败。合同验证目标表的 13 张迁移表全部回到 0 行，头像派生文件没有残留，SQLite 源库哈希在失败前后完全一致；随后复用同一 SQLite 原生 backup 快照重放成功，账号/日程/声纹/头像均可回读。检查共 `8/8` 通过，证据为 `tools/service-quality-evidence/svc07/svc07-sqlite-postgresql-rollback-contract-r1.json`。

这只证明单事务失败回滚和同一冻结副本重放，不证明生产备份副本、实时双写冻结、在线切换、PostgreSQL 故障转移或多进程生产部署；迁移 ready 标记和生产 fail-closed 继续保持。

### SVC-09 真实 Qwen 录音持久化纵向补充

在当前完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 上新增窄探针 `tools/service-quality-evidence/svc09/run_real_qwen_recording_persistence_probe.py`。探针通过真实 FastAPI 路由完成录音资产登记、上传和转写任务创建，暂时关闭自动 executor 唤醒以避免重复 worker；随后使用隔离 GPU0、临时 `127.0.0.1:28140` 的 Qwen3-ASR-0.6B 对同一上传 WAV 实际推理，再用真实 `claim_transcription_job` 和 `commit_transcription_candidate` 写入 canonical SQLite。

单条固定语音“明天下午三点开会”纵向共 `12/12` 检查通过：provider readiness 为真，真实 Qwen 返回“明天下午三点开会。”（2.42 秒音频，provider 507 ms）；任务从 queued 经 attempt 1 租约进入 completed，会议状态回到 `ended`，Transcript 正文与录音资产/任务 ID 关联，资产 revision 为 2，数据库为 `asset=1 / operation=3 / transcription_job=1`，无 `.part`/`.partial` 文件。证据：`tools/service-quality-evidence/svc09/svc09-real-qwen-recording-persistence-r1.json`、`tools/service-quality-evidence/svc09/run_real_qwen_recording_persistence_probe.py`。

该证据首次把真实 Qwen provider 与真实候选持久化提交接通，但只覆盖单条音频和单进程 SQLite；探针使用本地 `postgres_compat` 导入桩（误走 PostgreSQL 会直接失败），未覆盖生产 ASGI worker executor、完整 ASR gateway 长任务、时间轴/分离度质量、PostgreSQL 多 worker、服务器重启、物理手机和 soak。Qwen 临时进程、28140 端口和 GPU0 显存已释放，`promotion_eligible=false` 保持不变。

同一探针增加 `--execute-worker` 模式后，进一步让真实候选 `_run_transcription_job_async` 负责 queued 任务领取、录音副本、租约参数、心跳等待和 attempt 文件清理，provider 适配器仍只调用隔离 Qwen `/asr`。该模式共 `13/13` 通过：真实 worker 生命周期下 Qwen 仍返回同一正文，commit 后任务/会议/Transcript/资产全部收敛，`.transcription-*` 临时副本已删除。证据：`tools/service-quality-evidence/svc09/svc09-real-qwen-worker-persistence-r1.json`。

这比直接调用 commit 更接近后台路径，但 provider 适配器仍是探针内替换，不是完整 `/v1/full` ASR gateway，也没有调用 production executor、恢复监督或跨进程数据库；`promotion_eligible=false` 继续保持。

### SVC-09 真实 Qwen provider 重试纵向补充

在同一候选 worker 探针上增加真实 provider 失败后的恢复路径：第一轮 Qwen 已返回正文后在提交前注入可控失败，候选 worker 将任务置为 `failed/retryable` 并清理 attempt 副本；随后通过真实 `POST /api/laoji/v2/processing-jobs/{job_id}/retry` 返回 `202`，重新执行 `_run_transcription_job_async` 并再次调用 Qwen。

当前 r2 证据共 `14/14` 通过：第一次状态为 `failed/retryable`、第二次领取为 attempt 2、两次 provider 调用均真实返回正文，最终任务 `completed`、会议回到 `ended`、Transcript 与资产/任务关联、操作记录为 4 条、临时副本清理通过。证据：`tools/service-quality-evidence/svc09/svc09-real-qwen-worker-retry-r2.json`。早期 `r1` 仅因探针把 attempt 2 错断言为 attempt 1 而失败，不能作为功能结论，已由 r2 覆盖。

该结果证明候选 SQLite/单进程 worker 的真实 provider 重试接线，不证明生产 executor、跨进程/多 worker、完整 ASR gateway、PostgreSQL、长任务、服务器重启或 soak；`promotion_eligible=false` 保持不变。

### SVC-02/SVC-03 Qwen 静音幻觉门禁补充

对 `phone-acoustic-asr/manifest.json` 的 17 个合成播放夹具做真实 Qwen3-ASR-0.6B 诊断时，旧 staging provider 对 2 秒纯静音返回了“嗯。”，而 16 条非空语音均正确。该问题属于 provider 输入边界，不能交给日程解析器兜底。

已先备份 `qwen_asr_service/server.py`，再在隔离 `qwen3-asr-test` staging 增加 `QWEN_ASR_SILENCE_RMS_THRESHOLD`（默认 `0.001`）门禁：PCM RMS 低于阈值时直接返回空文本、`silence_rejected=true` 和零推理耗时，不加载模型推理；健康快照同时公布阈值。当前 staging 源码哈希为 `60f635c5…e74133`，备份为 `tools/service-quality-evidence/svc03/source-backups/qwen3-asr-test-server.before-silence-gate-r1.py`。

修复后同一 17 条集 `17/17` 完成，非空语音 `16/16` exact、CER mean `0`，纯静音 `1/1` 被拒绝为空，provider client RTT p95 约 `294 ms`。当前证据：`tools/service-quality-evidence/svc02/svc02-qwen-phone-acoustic-r3-silence-gate.json`、`tools/service-quality-evidence/svc02/run_qwen_phone_acoustic_probe.py`。可运行的 context policy 回归为 `8 passed`；完整 staging WebSocket 测试仍因快照缺少 `app.api.whisper_ws` 无法收集，这个装配缺口未被隐藏。

该修复只存在于隔离 staging，尚未同步生产 Qwen/实时 WebSocket 或客户端；合成 TTS/拼接音频也不能替代物理手机、真人口音、真实噪声、VAD 和日程字段验收，`promotion_eligible=false` 保持不变。此前未加门禁的 `svc02-qwen-phone-acoustic-r2.json` 仅保留为问题发现，r3 为修复后证据。

### SVC-03 Qwen 默认适配器文本边界补充

复核发现 `qwen-asr-default/app/api/qwen_ws.py` 仍在分段路径使用 `str(result.get("text") or "")`，会把 provider 返回的对象、数组或数字伪装成可展示文本。已先备份原文件 `app/api/qwen_ws.py.before-asr-text-boundary-r2`，随后新增 `_normalized_asr_text()`：HTTP JSON 必须为对象，`text` 只能是字符串；缺失、`null` 或空白返回空文本，结构化值和非对象返回 `asr_text_invalid` / `asr_result_not_object`，并在 `_qwen_transcribe()` 与 WebSocket 分段路径同时调用。

当前源码身份明确为：`/home/yydd/LaoJi/server-staging/qwen-asr-default/app/api/qwen_ws.py`（文本边界修复后、元数据补齐后 SHA-256 `a2d7f07c…e93cd5`；文本边界前备份 `d7bf4750…ba9d3`，元数据补齐前备份 `cc513edf…c71823`）、`/home/yydd/LaoJi/server-staging/qwen3-asr-test/app/api/qwen_ws.py`（元数据补齐后 `cf03fe1d…e339a44`，补齐前备份 `17160a44…9b6009`）以及 summary 候选适配器（`dcc5b7dd…652f1f`）。三套适配器的缺失、`null`、空白、对象、数组、数字和正常文本合同均为 `8/8`，总计 `3/3`；三套文件 `py_compile` 通过。证据：`tools/service-quality-evidence/svc03/svc03-asr-text-boundary-contract-r2.json`。Qwen3 独立服务端的严格模型文本边界合同仍为 `9/9`，源码哈希 `60f635c5…4133`，证据：`tools/service-quality-evidence/svc03/svc03-qwen-server-text-boundary-contract-r1.json`。

该修复只收紧 staging/候选输入边界，不代表真实 provider 质量、GPU 性能、WebSocket 装配、Android 真机或生产部署已通过；系统 Python 曾因缺少已声明依赖 `httpx` 产生环境级收集失败，使用隔离 venv 后可收集测试，完整适配器套件仍因快照缺少 `app.api.whisper_ws` fail-closed，`promotion_eligible=false` 不变。

随后补齐默认适配器与当前 Qwen provider 协议一致的元数据：config 和 transcript 事件明确 `provider=qwen`，并透传 `queue_wait_ms`、`model_infer_ms`、`provider_total_ms`、`context_term_count` 和 `context_applied`；未改变文本、时间轴或持久化逻辑。使用 GPU0 临时 Qwen3-ASR-0.6B、loopback `127.0.0.1:28142` 和两条真实手机音频运行纵向 smoke：日程 `1/1`、会议 `1/1`，均收到 `config → stop_acknowledged → transcript.completed → ready_to_stop`，无 error，规范化文本一致，计时字段完整，会议持久化回调 `2` 次。证据：`tools/service-quality-evidence/svc03/svc03-qwen-websocket-default-adapter-real-smoke-r2.json`。声纹引擎因该快照缺少 `SpeakerEmbeddingExtractor` 仍明确记为未证明；临时服务已停止、`28142` 已释放、GPU0 恢复至约 `7521 MiB` 空闲。

该 smoke 只证明默认 staging 适配器、真实 Qwen provider 和候选 StreamingVAD 的协议纵向，不证明真实 Silero/CAM++、生产 ASGI/数据库、多人声纹质量、并发、重启、Android 真机或生产部署；`promotion_eligible=false` 保持不变。

同轮合同刷新：默认与 qwen3 两套 staging 的停止/断线排空合同 `30/30`，summary 与 qwen3 配置就绪顺序 `2/2`，Qwen 上下文静态组装 `12/12`，三套 full/degraded fail-closed 源码合同全部通过；当前报告已绑定默认适配器最新 SHA-256 `a2d7f07c…e93cd5`。这些是源级/隔离候选证据，仍不解除 staging 缺少完整 `app.api.whisper_ws` 装配、真实声纹质量、Android 握手和生产发布限制。

两套 staging 与 summary 候选现在还共享同一 Qwen WebSocket 元数据合同：`config`/`transcript.completed` 均暴露 `provider`，转写事件均暴露 `queue_wait_ms`、`model_infer_ms`、`provider_total_ms`；合同 `15/15`，证据：`tools/service-quality-evidence/svc03/svc03-qwen-metadata-contract-r1.json`。

使用声明了 FastAPI/httpx/pytest 的 Qwen 隔离 venv 重跑默认 staging 可独立收集的支持模型与 VAD 测试，VAD 预滚动、模型 readiness/实例隔离和 CAM++ 共享推理锁共 `10 passed`；测试夹具已对齐“CAM++ 特征探针成功才 readiness”的当前语义。证据：`tools/service-quality-evidence/svc03/focused-qwen-staging-r1.xml`。`tests/test_schedule_asr_proxy.py` 仍因快照缺少 `app.api.whisper_ws` 在收集阶段失败，不能把这组 `10 passed` 扩大为完整 staging 回归。

### SVC-05 CAM++ 实时身份辅助刷新

在默认 Qwen staging 当前源码上重跑真实 GPU0 CAM++/Silero 辅助链：模型初始化约 `682 ms`，中文 CAM++ 特征探针通过，embedding 维度 `192`，`required_models_ready=true`；临时登记资料首个合格片段保持 unknown，第二个独立合格片段返回稳定 profile ID 与展示姓名，异声样本未被接受。证据：`tools/service-quality-evidence/svc05/svc05-real-speaker-engine-smoke-r2.json`，适配器源码绑定 `f32201b3…112b943`。该结果只覆盖固定音频、一个内存资料和辅助函数，不代表真人多人 DER/JER、跨设备/噪声 FAR/FRR、真实账号资料、Android 或生产部署；`promotion_eligible=false` 保持不变，GPU0 临时显存已释放。

### SVC-09 真实 Qwen 经全音频网关接入候选 worker

补齐了此前 r7 探针的证据缺口：新增 `tools/service-quality-evidence/svc09/isolated_full_audio_gateway.py` 与 `run_real_qwen_gateway_worker_probe.py`。探针启动一次性回环网关和真实 GPU0 `Qwen3-ASR-0.6B` 服务，网关按候选 `/v1/full/transcribe`、`/v1/full/result/{task_id}` 文本协议保存任务状态、接收稳定任务 ID，并将上传音频解码后转交 Qwen；候选 worker 不再替换 `process_audio_in_background`，而是实际调用 `asr_gateway_client` 完成提交、轮询、租约绑定、候选提交和终态收敛。

固定音频“明天下午三点开会”完整纵向 `14/14` 通过：登记 `201`、原子上传 `200`、任务入队 `202`；第一次真实 Qwen 返回正文后由隔离网关故意注入一次可重试失败，候选任务为 `failed/retryable`、attempt 1；真实 retry 返回 `202`，第二次领取为 attempt 2，第二次 Qwen 仍返回同一正文，最终 job/meeting/Transcript/asset 全部收敛，操作记录为 4 条，attempt 副本无残留。两次 provider 状态均 `200`，Qwen readiness 为真，模型设备为 `cuda:0`，两次 `model_infer_ms` 为 `442/84 ms`。证据：`tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-r2.json`。

首次 r1 暴露了一个真实协议边界：候选网关以 `---` 结束结果，而客户端只把 `====` 当分隔符，导致分隔线被保存进正文；现已在 `server-work/summary/backend/app/services/asr_gateway_client.py` 兼容两种终止标记，并在候选验证根同步。r2 同时修正了 gateway worker 探针从 durable job/Transcript 回填 claim/commit 的统计方式。该解析修复只影响结果边界，不放宽文本类型校验。

本证据的网关是一次性隔离适配器，不是生产网关快照；临时网关、Qwen 进程和端口在探针结束后均以 `SIGTERM` 退出，GPU0 临时显存已释放。仍未证明生产 ASGI executor/recovery、生产网关的跨进程任务持久化与重启、PostgreSQL 多 worker、长音频/时间轴/讲话人质量、systemd/服务器重启、物理手机或 soak，因此 `promotion_eligible=false` 继续保持；不允许据此开启生产全音频网关。

### SVC-09 真实网关线程池 executor 纵向补充

在上述隔离网关/Qwen 组合上启用候选真实 `submit_transcription_job`，不直接调用 `_run_transcription_job_async`，由候选 `ThreadPoolExecutor` 创建独立事件循环、独立数据库连接并完成录音副本、租约心跳、provider task 绑定和最终 commit；重试同样通过真实 retry API 后再次投递 executor。

最新 `15/15` 证据：首次真实 Qwen 结果后网关注入失败，第一轮为 `failed/retryable/attempt=1`；重试 API 返回 `202`，第二轮由 executor 领取 `attempt=2`，第二次 Qwen 返回同一正文，job/meeting/Transcript/asset 终态一致，操作记录为 4 条，临时 attempt 文件清理通过。两次 provider `200`，`model_infer_ms=413/92 ms`，executor 两次提交均被接受。证据：`tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-r3.json`；探针入口：`tools/service-quality-evidence/svc09/run_real_qwen_gateway_worker_probe.py`。

这仍是一次性候选 SQLite、回环网关和单机线程池演练；不等于生产多进程 executor、systemd/服务器重启后的恢复监督、PostgreSQL 锁竞争、长任务或生产 ingress drain。`promotion_eligible=false` 继续保持。

### SVC-09 真实网关线程池与 PostgreSQL 纵向补充

在一次性 PostgreSQL 16 loopback 容器中重跑同一真实 Qwen/隔离全音频网关/候选线程池链路，显式使用 `postgresql+asyncpg`，未使用 SQLite 兼容桩。登记、上传、任务入队、首次真实 provider 失败、retry、attempt 2 领取、候选 commit 和终态回读仍为 `15/15`；两次 Qwen 返回同一正文，`model_infer_ms=503/99 ms`，最终 `job=completed`、`meeting=ended`、Transcript 与资产关联，操作记录为 4 条。

证据：`tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-postgresql-r1.json`。PostgreSQL 容器、临时网关、Qwen 进程和端口已在探针结束后清理，GPU1 和既有 Docker 服务未触碰。该证据只证明一次性 PostgreSQL 的真实连接与单线程池纵向，不证明生产 PostgreSQL 配置/副本、跨进程高并发锁竞争、systemd/服务器重启接管、真实长任务或 soak；`promotion_eligible=false` 继续保持。

### SVC-09 真实网关跨进程 worker 竞争纵向

在同一候选 PostgreSQL/真实 Qwen/隔离网关组合上，新增 `--spawn-workers` 模式：每轮由两个独立 `multiprocessing.spawn` 进程导入候选 worker，观察真实 `claim_transcription_job` 结果后继续完整网关转写；未替换 `process_audio_in_background`、provider 或数据库写入。首次任务和 retry 任务各进行一轮竞争，均恰好一个进程取得租约，另一进程不执行 provider；第一次真实 Qwen 结果后网关注入失败，第二轮 retry 再次由单一 winner 完成。

报告 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-postgresql-spawn-r1.json` 共 `16/16` 通过：两轮 claim winner 均为 `1/2`，两次 Qwen 调用均 `200` 且返回同一正文，最终 PostgreSQL job 为 `completed/attempt=2`，会议为 `ended`，Transcript 与录音资产关联，操作记录为 4 条，临时 attempt 文件清理通过。

这补足了候选级跨进程锁竞争与真实 provider 接线，但仍不等于生产 PostgreSQL 拓扑、多个长期 worker 的资源公平性、网关跨进程任务身份库、systemd/服务器重启接管、长任务或 soak；容器和临时服务已清理，`promotion_eligible=false` 继续保持。

### SVC-09 外部 ASGI 进程边界纵向补充

新增 `tools/service-quality-evidence/svc09/run_real_qwen_gateway_asgi_probe.py`，把真实 Qwen3-ASR-0.6B、隔离全音频网关和候选会议服务放入三个独立进程，并以一次性 PostgreSQL 16 loopback 容器验证完整 HTTP 边界。探针启动外部 Uvicorn 进程，在不修改业务源文件的前提下将 `app.main:app` 与账号认证 router 组合到同一候选 ASGI 实例，覆盖真实注册、Bearer 校验、会议创建、录音资产登记、multipart 上传、转写任务入队、线程池执行、首次 provider 失败、HTTP retry、终态查询和 PostgreSQL 回读。

最新证据 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-asgi-postgresql-r11.json` 共 `16/16` 通过：ASGI/网关/Qwen 健康均就绪；注册 `201`、Bearer `/me` `200`、会议 `201`、资产登记 `201`、上传 `200`、转写入队 `202`；第一次真实 Qwen 返回“明天下午三点开会。”后网关注入 `failed/retryable/attempt=1`，retry `202` 后第二次调用完成，最终 PostgreSQL job `completed/attempt=2`、meeting `ended`、Transcript 与录音资产/任务 ID 关联、asset revision `2`、无临时残片。两次 provider 调用均为 `200`，`provider_invocation_count=2`，真实模型设备为 `cuda:0`，总耗时约 `10.3 s`。

探针同时固定了候选进程的依赖边界：共享解释器布局下需显式注入 venv `site-packages`；`app.main` 的认证 router 不是默认挂载项，外部纵向必须使用组合入口，不能把会议服务的 `/api/auth` 404 误判为业务缺陷。该修正只作用于证据探针，不改变生产入口拓扑。

这条证据只证明一次性 PostgreSQL、外部 ASGI/线程池和真实短音频 provider 的候选纵向，不证明生产 ingress、systemd/服务器重启接管、生产 PostgreSQL 副本与备份、长期多 worker soak、长音频/时间轴/讲话人质量、物理手机采集或正式部署；`promotion_eligible=false` 必须继续保持。

### SVC-09 外部 ASGI 崩溃后的真实 provider 接管

在上述外部 ASGI 探针基础上新增 `tools/service-quality-evidence/svc09/run_real_qwen_gateway_asgi_restart_probe.py`，并给隔离网关增加默认关闭的 `--delay-before-provider` 诊断参数。探针启动真实 Qwen、隔离全音频网关和第一候选 ASGI 进程；通过真实 HTTP 注册、会议创建、录音登记、上传和转写入队后，等待第一 worker 取得 attempt 1 并将稳定 provider task ID 写入 PostgreSQL。随后只强制终止第一 ASGI 进程，保留 Qwen、网关、音频存储和数据库；将该租约标记为过期后启动第二个外部 ASGI 进程，由真实 lifespan recovery 接管任务。

最新证据 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-asgi-restart-postgresql-r1.json` 共 `16/16` 通过：第一进程 `SIGKILL` 返回码 `-9`；替代进程健康检查通过并回收 expired running lease；attempt 从 `1` 递增到 `2`，provider task ID 保持 `task_f49fd05c963ffb0fb2e28d98f2a8072d` 不变；真实 Qwen provider 只被调用 `1` 次，返回“明天下午三点开会。”；最终 PostgreSQL job `completed`、meeting `ended`、Transcript 只保留一条且关联原资产/任务、asset revision `2`、无临时残片。该结果证明“ASGI 进程崩溃后不重复提交 provider、替代进程可接管同一任务”的候选行为。

网关延迟只用于制造可观测的崩溃窗口，默认网关行为未改变；本探针仍是一次性 loopback PostgreSQL 和单任务短音频，不等于生产 systemd/服务器重启、生产拓扑/备份、多个长期 worker 公平性、真实长任务、GPU OOM、物理手机或 soak。`promotion_eligible=false` 继续保持。

同一探针再以 `--shutdown-mode term`、60 秒网关延迟验证真实优雅停机：第一 ASGI 进程返回 `-15`，停机排空后仍将 running lease 留给恢复监督；第二进程在租约过期后接管，provider task ID 不变，Qwen 仍只调用一次，最终 job/meeting/Transcript/asset 全部收敛，检查仍为 `16/16`。证据：`tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-asgi-restart-postgresql-term-r1.json`。这只补足候选 SIGTERM 场景，生产 systemd unit、服务器级重启、外部 supervisor 和长时 soak 仍未证明。

### 远端生产 readiness 只读复核

重新执行 `tools/service-quality-evidence/svc03/run_remote_readiness_audit.py`，仅对 `183.36.243.124` 的健康、readiness、能力和 OpenAPI 路由执行 HTTP `GET`，没有业务写入、认证操作、进程重启或配置变更。当前远端 `18020` 与 `18035` 的 liveness 均返回 `200`；`18020/api/health` 报告 `qwen3-asr`、VAD/CAM++ 支持模型已就绪，`18020/api/laoji/capabilities` 也公布了会议记录、录音资产、重转写、讲话人、媒体片段等能力。

但远端 `18020/api/ready` 和 `18035/api/ready` 均为 `404`，独立 `8030/health` 连接拒绝；因此能力广告不能被解释为生产 readiness，实时 ASR、停机 admission 和完整部署状态仍无法从远端证明。最新只读证据：`tools/service-quality-evidence/svc03/svc03-production-readiness-audit-r2.json`，`promotion_eligible=false` 保持不变。

### SVC-07 PostgreSQL 备份恢复与多进程共享存储补充

在同一完整候选存储源码根 `/home/yydd/.codex/tmp/svc07-r9-verify-src` 上补充两个相互独立的生产边界合同。`tools/service-quality-evidence/svc07/run_postgresql_backup_restore_contract.py` 启动仅绑定 `127.0.0.1` 的 PostgreSQL 16 临时容器，使用真实候选账号、日程和声纹服务创建 13 张共享表及数据；通过容器内 `pg_dump -Fc --no-owner --no-acl` 生成带 SHA-256 的自定义归档，并以 `pg_restore --single-transaction` 恢复到新容器。源库恢复后再写入不会污染已恢复库，同一冻结归档可重复恢复，序列值与逐表规范化摘要一致；将归档头部破坏后，恢复明确失败且目标库保持 0 张表/0 行。报告 `tools/service-quality-evidence/svc07/svc07-postgresql-backup-restore-contract-r1.json` 的检查为 `12/12`，四个临时容器均已清理。

`tools/service-quality-evidence/svc07/run_postgresql_multiprocess_contract.py` 随后在一个同样的 loopback PostgreSQL 实例上以 Python `spawn` 创建 4 个独立提交进程和 1 个故意回滚进程；4 条并发日程写入均可读回，回滚写入不存在，进程退出码全部为 `0`，用户归属没有串写。报告 `tools/service-quality-evidence/svc07/svc07-postgresql-multiprocess-contract-r1.json` 的检查为 `10/10`。

这些证据只解除候选级“备份归档可恢复、单事务损坏失败不留半成品、独立进程共享连接可提交/回滚”的阻塞，不解除生产资格。仍未证明生产备份仓库加密与保留、异地副本、WAL/PITR、复制和故障转移、线上双写冻结/切换/回滚、外部头像/音频对象存储恢复、ASGI/Redis 多 worker 调度、长时间压力或模型/Android 质量；`promotion_eligible=false` 和生产存储 fail-closed 必须保持。

### SVC-07 SQLite 写冻结与迁移窗口补充

迁移工具 `tools/service-quality-evidence/svc07/migrate_laoji_sqlite_to_postgres.py` 现在增加显式 `--freeze-source-writes`：按源文件路径排序，对账号、日程、声纹 SQLite 源库取得 `BEGIN IMMEDIATE`，可选 `--freeze-ready-file` 在全部锁成功后写入审计标记，并在迁移成功或异常时释放全部连接；默认不开启，`--freeze-hold-seconds` 仅供隔离合同制造可观测窗口，生产调用保持 `0`。相同源文件只取得一次锁，部分获取失败会回滚并释放已拿到的锁，避免半冻结。

`tools/service-quality-evidence/svc07/run_sqlite_write_freeze_contract.py` 使用真实候选三类 SQLite schema 和独立 `spawn` 写进程验证：冻结期间写入得到 `database is locked` 且没有脏行；释放后写入成功；已有外部 writer 时冻结获取 fail-closed，失败获取不会遗留其他源文件的锁。最新报告 `tools/service-quality-evidence/svc07/svc07-sqlite-write-freeze-contract-r2.json` 为 `10/10`。

`tools/service-quality-evidence/svc07/run_sqlite_postgres_freeze_migration_contract.py` 再将该开关接入真实迁移进程：三个源库锁成功后，写进程先阻塞，迁移提交后才写入源库；PostgreSQL 目标只包含冻结时的 1 条日程，解冻后新增行不在目标库中。报告为 `10/10`。这不是缺陷，而是切换顺序的硬约束：冻结释放前必须完成目标库校验并把新写入路由到 PostgreSQL；不能仅设置 `LAOJI_STORAGE_MIGRATION_STATE=ready` 就恢复 SQLite 写入。

该切片仍不证明生产流量 admission/systemd drain、在线双写、目标库切换回滚、对象存储迁移、PostgreSQL 复制/PITR 或长时 soak；生产 fail-closed 与 `promotion_eligible=false` 继续保持。

### SVC-00 broker readiness 边界补充

复核优先级 broker 时发现原有 `/_broker/health` 只反映 broker 进程和队列状态，上游 Ollama 不可达时仍可能返回 200，不能作为部署就绪信号。`tools/ollama-priority-broker/broker.py` 现新增 `OllamaProxy.readiness()` 和 `/_broker/ready`：通过 loopback 上游 `GET /api/version` 做轻量探测，不加载模型、不生成内容；只有 scheduler 正常且上游返回 200 才返回 200。上游返回错误或断开时返回 503，错误体含稳定错误码和中文提示，并始终明确 `model_ready=false`。

`tools/service-quality-evidence/svc00/run_broker_readiness_contract.py` 的三态隔离合同为 `7/7`：上游正常 ready、上游 503、上游断开均得到预期状态；liveness health 在上游故障时仍为 200，证明两者没有混淆。改动后原有队列截止合同仍为 `8/8`，优先级/操作头合同仍为 `17/17`；最新 readiness 报告为 `tools/service-quality-evidence/svc00/svc00-broker-readiness-contract-r1.json`。

这只解除 broker 候选的“上游不可达假绿”边界，不证明 Ollama 模型已加载、真实 9B 质量/容量、混合负载 p95、GPU OOM、systemd 或生产部署；`promotion_eligible=false` 继续保持。

### SVC-03 无上下文微批回退收口

为定位无上下文请求在列表推理中的语义回退，使用当前隔离 GPU0 Qwen3-ASR-0.6B、28 条固定会议语音和无词表模式重跑串行/微批对照。串行及批大小 1 均与各自基线语义一致 `28/28`；批大小 2 虽将总耗时降至 `5.401 s`，但出现 `M008`（“老记”被识别为“老纪”）和 `M027`（`WAV` 被识别为 `WAVE`）两条相对串行回退，期望文本命中 `23/28`；批大小 4 总耗时 `4.747 s`，除上述两条外又出现 `M025`（“四零四”被识别为“四零四十”），期望文本命中 `22/28`。因此“减小批大小”不能解除无上下文质量风险。

候选服务补丁现改为：`REQUEST_BATCHER` 只有在 `model_context.strip()` 非空时才接收请求；无上下文请求继续使用已验证的单请求 `INFERENCE_LOCK` 路径，有上下文请求才进入微批。补丁已针对当前 `/home/yydd/LaoJi/server-staging/qwen3-asr-test/qwen_asr_service/server.py` 精确 dry-run（无 fuzz）、临时副本 `py_compile` 通过；SVC-03 隔离合同 `27/27`、12 个候选文件语法检查通过，当前补丁哈希绑定在 `svc03-isolated-contract-r5.json`。这仍是候选策略，不代表已经部署。

证据：`tools/service-quality-evidence/svc03/svc03-qwen-microbatch-no-context-r1.json`、`tools/service-quality-evidence/svc03/svc03-isolated-contract-r5.json`、`tools/service-quality-evidence/svc03/semantic-candidate/qwen_microbatch_service.patch`。候选保持 `promotion_eligible=false`：有上下文微批的真实 WebSocket/VAD、真实参与者词表来源、无上下文完整冻结集、Android、OOM、重启和 soak 仍未完成，默认微批开关继续关闭。

### SVC-10 结构化搜索过滤候选补充

会议搜索现在共用 `src/services/meetingSearchQuery.ts` 解析器，保留普通全文查询，同时识别 `标签/tag`、`人物/person/speaker`、`日期/date`、`从/from`、`到/to` 和 `来源/source`。日期只接受真实 `YYYY-MM-DD`，重复范围取交集；未知来源、非法日期、超长值和控制字符按普通查询或 fail-closed 处理，不会静默放宽过滤。

SQLite 本机索引路径把过滤条件作为参数化 SQL：标签走同 scope 的 tag link，人物走经过 `json_valid` 防护的 `json_each(participants_json)`，日期使用记录/开始/创建时间的稳定回退，来源限制当前 FTS 行类型；scope 和 `lifecycle <> 'deleted'` 仍是独立强制条件。标题/元数据回退路径复用同一解析器，并按已有 Meeting 字段执行相同的标签、人物、日期和来源近似过滤，避免索引重建或旧数据库迁移时结果语义改变。

源级合同 `16/16` 通过：`tools/service-quality-evidence/svc10/svc10-search-filter-contract-r1.json`。这只证明解析、SQL 接线和元数据回退的一致性，不证明 Expo SQLite 实际 JSON1/FTS5 版本、真实数据规模、语义 Recall@10/NDCG、远端同步、跨设备 freshness、生产性能或权限审计；`promotion_eligible=false` 保持不变。

### SVC-03 完整候选 Qwen 静音幻觉门禁

审计发现完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src/qwen_asr_service/server.py` 尚未同步隔离 staging 已验证的静音输入保护。旧路径对纯静音或极低能量 PCM 仍会进入 Qwen 推理，真实诊断曾出现静音被转成问候词的结果；这属于 ASR provider 输入边界，不能交给日程解析或客户端过滤。

本轮先保存原文件，再在完整候选 provider 增加 `QWEN_ASR_SILENCE_RMS_THRESHOLD`（默认 `0.001`）门禁：空 PCM 和 RMS 低于阈值的 PCM 在推理锁之前直接返回空文本、`silence_rejected=true`、`infer_ms=0` 及音频 RMS；健康接口公布阈值，正常语音保留原 `text/language/model` 字段并补充 `queue_wait_ms/model_infer_ms/provider_total_ms/rms/silence_rejected`，奇数 PCM 和超大输入仍沿用原错误码。

候选 server 当前 SHA-256 为 `961992e448f92c9dcd7f92f91e303128be35865bd19a691ece36c973dec3aa25`，修改前备份为 `tools/service-quality-evidence/svc03/source-backups/full-candidate-qwen-asr-server.before-silence-gate-r1.py`（`8f0fdcb4…`）。回环 HTTP 假模型合同 `9/9`：空/近静音不调用模型，正常 1 秒 PCM 调用一次并返回文本，阈值可观测，奇数 PCM 仍返回 `400`；`py_compile` 通过。证据：`tools/service-quality-evidence/svc03/svc03-full-candidate-silence-gate-contract-r1.json`。

该切片只修改隔离完整候选，没有启动或修改生产服务；完整候选既有 WebSocket 套件在补充一次性 SQLite URL 后仍因快照缺少 `app.services.postgres_compat` 在收集阶段失败，因此不能把完整 ASGI 回归、真实 Qwen 质量、真实麦克风噪声、GPU 性能、重启或生产部署标记为通过。`promotion_eligible=false` 保持不变。

### SVC-07 完整候选 PostgreSQL 装配与 SQLite 回归收口

针对上一轮完整候选收集阶段缺少 `app.services.postgres_compat` 的问题，本轮在隔离源码根 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 补齐同步兼容层，并保持 SQLite 与 PostgreSQL 共享同一套账号、日程、声纹服务调用面。兼容层只在显式 PostgreSQL DSN 下延迟加载 `psycopg`，负责 qmark 占位符、`BEGIN IMMEDIATE`、SQLite `PRAGMA`、`INSERT OR IGNORE`、映射/整数行访问和旧代码依赖的 `lastrowid` 语义；`laoji_users` 与 `schedule_events` 的插入路径使用显式 `RETURNING id`。账号注册重复键同时识别 PostgreSQL `UniqueViolation`，先回滚再返回稳定的重复账号错误，不把约束异常泄露为 500。

完整候选的真实 WebSocket 回归现为 `22 passed`；PostgreSQL 兼容层合同为 `5/5`；一次性 PostgreSQL 16 loopback 数据库上的账号、日程、声纹合同均通过，报告分别为 `tools/service-quality-evidence/svc07/svc07-full-candidate-auth-postgresql-r3.json`、`tools/service-quality-evidence/svc07/svc07-full-candidate-schedule-postgresql-r2.json`、`tools/service-quality-evidence/svc07/svc07-full-candidate-speaker-postgresql-r2.json`，兼容层报告为 `tools/service-quality-evidence/svc07/svc07-full-candidate-postgres-compat-r1.json`。SQLite 侧复核为账号 `18 passed`、讲话人隔离 `7 passed`、实时 WebSocket `22 passed`。

另以同一完整候选重跑 `spawn` 多进程数据库合同：4 个独立进程提交日程、1 个进程在插入后故意回滚，所有进程正常退出，提交行可回读，回滚行不存在，owner 未串写，检查 `10/10`；证据为 `tools/service-quality-evidence/svc07/svc07-full-candidate-postgresql-multiprocess-r1.json`。该合同只验证候选 PostgreSQL 连接和事务边界，不替代生产连接池、ASGI 多 worker 或故障切换验收。

账号历史回归中原有一条固定日期样例曾在 2026-08-01 之后被 30 天待处理请求保留策略正确清理，造成陈旧测试误报；候选测试现改用相对当前时间的样例，重新运行后 `tests/test_laoji_auth.py` 全部通过。该修正只改变测试数据，不放宽密码重置过期策略，也没有修改生产数据库。

完整候选全量 pytest 在本轮装配后收集 `483` 项，最新 JUnit 证据为 `tools/service-quality-evidence/svc07/svc07-full-candidate-regression-r2.xml`：`448 passed / 32 failed / 3 skipped`。新增的旧 `meetings` 表迁移修复已使 `test_create_idempotency.py` 全部通过；剩余失败明确分为五类，不能合并成一个质量结论：音频上传单元夹具仍是没有 `execute` 的旧 `FakeDb`（2）；compact summary 夹具把 `_load_config` 替换为无 `_replace` 的普通对象（1）；模型就绪夹具仍把“模型对象存在”当作充分条件，未提供当前 CAM++ 特征运行时探测（2）；日程解析夹具仍依赖 2026-07 的隐式当前日期和旧地点/提示词文案（22）；工作区启动脚本测试引用已归档的 `/home/yydd/.codex/scripts`（5）。这些测试没有被删除或强行放宽，后续如恢复完整回归应更新夹具以使用显式 `reference_datetime`、真实配置对象、可探测假模型和当前脚本入口。

本轮隔离候选源码还包含三项边界修复：`app/services/app_meeting_schema.py` 对缺失 `created_at/updated_at` 的老 `meetings` 表先补列再回填根记录；`app/api/app_meetings.py` 在历史轻量对象缺少 `user_id` 时从上传路由 owner 补齐关联；`app/asr/model_manager.py` 对未完整初始化对象使用安全的特征就绪默认值，且启动日志只有在 VAD、CAM++ 和特征运行时探测全部通过时才显示“可以开始会议”，不再出现特征探测失败但日志假绿。候选模型管理器在可探测假模型上的正向 readiness smoke 通过。上述改动只存在于完整候选，不代表生产已部署。

本轮仍只修改隔离完整候选和证据/指示文档，没有部署、重启或连接生产服务；所有 PostgreSQL 报告保持 `promotion_eligible=false`。这些结果证明完整候选的依赖装配和一次性数据库业务合同；后续新增的 ASGI、迁移冻结/回滚和模型档位证据见下文，但仍不证明生产凭据、备份/副本、在线流量切换、多进程长期负载、真实模型质量、Android 真机或发布资格。

### SVC-07 当前候选生产存储门禁与 ASGI 入口接线

复核发现当前完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 的 `production_storage_guard.py` 仍是旧版“production 永远拒绝”，与本指示文档已经规定的迁移门禁不一致。现已同步为条件式 fail-closed：非 production 继续允许本地/候选运行；production 必须同时提供 `LAOJI_AUTH_DATABASE_URL`、`LAOJI_SCHEDULE_DATABASE_URL`、`LAOJI_SPEAKER_DATABASE_URL`，三者必须是 PostgreSQL DSN，并且 `LAOJI_STORAGE_MIGRATION_STATE=ready`、`LAOJI_STORAGE_MIGRATION_ID` 非空。缺失、混用 SQLite、缺迁移状态或缺批次标识分别返回稳定中文错误，不会因设置一个 DSN 就假装迁移完成。

当前候选 guard 合同 `5/5` 通过，证据为 `tools/service-quality-evidence/svc07/svc07-full-candidate-production-storage-guard-r1.json`。随后以一次性 PostgreSQL 16 loopback 容器显式装配三类 DSN和迁移标记，真实 `app.laoji.main` lifespan 完成健康 `200`、注册 `201`、登录 `200`、创建日程 `201`、列表 `200`、状态命令 `200`；账号回读成功，状态命令后日程数为 `0`。证据为 `tools/service-quality-evidence/svc07/svc07-full-candidate-postgresql-laoji-asgi-r3.json`。同一候选 SQLite 账号/声纹/WebSocket/安全回归合计 `50 passed`，源码 `py_compile` 通过。

首次未装配三类 DSN 的 ASGI 尝试被 guard 拒绝，证明门禁仍然有效；成功合同只说明候选共享 PostgreSQL 的入口接线和业务持久化，不证明真实生产凭据、备份副本、迁移回滚、线上 ingress、Redis、多 worker、重启/soak、真实模型质量或发布资格。所有报告继续保持 `promotion_eligible=false`，生产仍不得直接设置迁移 ready。

同一完整候选再补跑迁移安全边界：`tools/service-quality-evidence/svc07/svc07-full-candidate-sqlite-postgresql-freeze-r1.json` 为 `10/10`，三类 SQLite 源库以 `BEGIN IMMEDIATE` 冻结后，写入首先得到 `database is locked`，迁移只包含冻结时的 1 条日程；释放后写入成功但目标库仍为 1 条，未把解冻后的行伪装成已迁移数据。注入首表异常的回滚/重放合同 `tools/service-quality-evidence/svc07/svc07-full-candidate-sqlite-postgresql-rollback-r2.json` 也全部通过：13 张目标表在失败后均为 0 行，头像无残留，使用同一合法快照重放后账号、日程、声纹和头像可回读，源 SQLite 哈希前后一致。

这些结果解除的是当前候选的“迁移事务、写冻结和入口装配”阻塞，不等于线上切换已经完成。仍未证明生产备份仓库和保留策略、WAL/PITR、复制/故障转移、流量 drain、双写期间的应用路由、外部音频对象存储迁移、长期多 worker 和真实模型/Android 质量；生产 fail-closed 与 `promotion_eligible=false` 必须保持。

### SVC-03 完整候选 Whisper 自适应显存档位

当前完整候选的 WhisperLiveKit 路径此前在启动预热和 WebSocket 延迟加载中都直接使用 `WHISPER_MODEL_SIZE`，默认尝试 `large-v3`，没有在加载前核验显存，容易把“模型尚未加载”误报成可尝试并触发 OOM。现新增 `app/services/whisper_resource_profile.py`：统一读取 CUDA 空闲显存、模型档位门槛和质量档位；`large-v3/medium/small` 的启动门槛分别为 `12288/8192/4096 MiB`，运行时保留 `2048 MiB`。启动预热与 WebSocket 延迟加载都复用同一个选择器，避免两条路径选择不同模型。

策略明确区分显式选择和自动降档：显式 `WHISPER_MODEL_SIZE` 永不静默降档；candidate/release 未指定模型时默认 large-v3，显存不足直接以中文错误 fail-closed；只有同时设置 `WHISPER_ADAPTIVE_MODE=preview` 与 `WHISPER_ADAPTIVE_PREVIEW=1` 时，才从 large-v3、medium、small 中选择满足显存门槛的最高档位，并记录 `quality_profile`、实际显存和降档来源。源级合同 `5/5` 通过，且集成 smoke 证明显存拒绝发生在 WhisperLiveKit provider import/load 之前；证据为 `tools/service-quality-evidence/svc03/svc03-full-candidate-whisper-resource-profile-r1.json`；对应测试为 `/home/yydd/.codex/tmp/svc09-r6-verify-src/tests/test_whisper_resource_profile.py`。

这只完成了候选的容量决策和防 OOM 边界，不证明 WhisperLiveKit 权重、真实转写/分离质量、长音频、显存压力、重启/soak、Android 或生产部署；preview small 也不能替代正式质量 Gate。任何生产启用仍需绑定实际模型 digest、依赖锁、质量冻结集和 provider readiness，`promotion_eligible=false` 继续保持。

### SVC-03 Qwen 冻结集多并发档位复跑

在同一隔离候选实例上重新加载本地 `Qwen3-ASR-0.6B`，使用 `CUDA_VISIBLE_DEVICES=0`、模型配置 SHA-256 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`、provider 源码 SHA-256 `60f635c59db463ef1c82234f7927327b38abdfd4fc7a22304c583da254e74133` 和固定 28 条会议 WAV，分别执行 context-off/context-on 两组各 28 条请求。串行配对结果为 context-off `24/28` exact、`82/84` 关键术语，context-on `28/28` exact、`84/84`；完整报告为 `tools/service-quality-evidence/svc03/svc03-qwen-gpu-quality-context-r4-current.json`。

同一服务随后以 1、2、4、8 个客户端 worker 各执行完整 56 请求（每个档位仍分 context-off/context-on，均 `28/28` 完成且错误数为 0）。当前观测的客户端 RTT p95/排队 p95 如下：

| worker | context-off RTT/排队 | context-on RTT/排队 | context-on exact |
| --- | ---: | ---: | ---: |
| 1 | `393/0 ms` | `403/0 ms` | `28/28` |
| 2 | `1306/614 ms` | `1485/647 ms` | `28/28` |
| 4 | `1327/1019 ms` | `1374/1055 ms` | `28/28` |
| 8 | `2692/2355 ms` | `2852/2525 ms` | `28/28` |

原始证据分别为 `tools/service-quality-evidence/svc03/svc03-qwen-full-concurrency-w1-r1.json`、`svc03-qwen-full-concurrency-w2-r1.json`、`svc03-qwen-full-concurrency-r5-current.json` 和 `svc03-qwen-full-concurrency-w8-r1.json`。这组数据表明当前 provider 的单推理锁在并发增加时形成明显排队，不能把“无错误”理解为满足实时尾延迟；context-on 的质量提升来自受控 fixture 词表，只能作为候选 A/B 诊断，不能当作用户质量或默认词表策略。

本轮没有修改生产端口、没有启用候选微批，也没有触碰 GPU1；临时服务和 GPU 显存已释放。仍未证明真实手机麦克风/VAD 分段、多人噪声和注册声纹 DER/JER/FAR/FRR、取消与断线恢复、OOM、systemd/服务器重启、长时 soak、完整 ASGI 多 worker 或生产部署，因此 `promotion_eligible=false` 必须保持。

### SVC-02 Qwen 日程语音到移动端字段桥接

同一隔离 Qwen3-ASR-0.6B provider 对 `asr-voice-samples/manifest.json` 的 68 条日程语音执行 context-off 串行诊断：`68/68` 无错误、规范化 ASR exact `68/68`，provider 推理 p95 `226 ms`、客户端 RTT p95 `228 ms`。原始报告为 `tools/service-quality-evidence/svc03/svc03-qwen-gpu-quality-schedule-r1.json`，模型和 provider 身份仍绑定上一节的哈希。

新增 `tools/service-quality-evidence/svc02/run_qwen_schedule_parser_bridge.js`，将报告中的真实观察文本与同一 manifest 的 `expected` 字段送入当前 `src/services/localScheduleParser.ts`，并分别统计 ASR 文本和日程字段，不把文本 exact 直接当作日程完成。桥接结果 `tools/service-quality-evidence/svc02/svc02-qwen-schedule-parser-bridge-r1.json`：有字段样本 `66` 条中完整字段 `64` 条，字段命中 `151/153`（`98.69%`）；路由为 `local_safe=59`、`server_required=3`、`clarify=4`、`reject=2`。

剩余两条字段差异均已定位，不能归咎于 Qwen 漏词：`033`“十分钟后提醒我喝水”被当前候选词典按“健康”归类，而冻结语料标注为“生活”；这一分类口径在既有移动端/CPU 桥接中已经明确记录，本轮不擅自改变产品规则。`039`“下个月交报告”缺具体日期，当前解析器按安全策略拒绝静默保存，桥接只记录字段未生成，并非解析器把错误日期写入日程。`041`、`042` 没有期望字段，分别保持拒绝/澄清，属于预期安全行为。

该桥接只证明真实候选 ASR 输出经过本地确定性字段边界后的当前诊断结果，不证明服务端日程模型、真实手机录音/噪声、账号路由、端到端网络或生产质量；候选和文档仍保持 `promotion_eligible=false`。

### SVC-03 完整候选 Qwen 受限词表上下文装配

审计发现完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 只有静音门禁，未接入隔离 staging 已验证的词表上下文和严格文本边界。现已在备份优先后补齐：

- `qwen_asr_service/context_policy.py`：限制最多 64 个词、每词最多 40 字符、请求头最多 8192 字符；拒绝控制字符、空词和非法 Base64/JSON；上下文固定为词法消歧提示，不接受会议标题或转写正文作为自由提示词。
- `qwen_asr_service/server.py`：启动时检查 `Qwen3ASRModel.transcribe` 是否暴露 `context` 参数，不支持则启动失败；健康响应公布 `context_supported` 和配置词数；请求级词表与配置词表合并去重；结构化/非字符串 provider 文本返回 `asr_text_invalid`，不再把对象强转成文字；继续保留静音零推理门禁和队列/模型计时字段。
- `app/api/qwen_context.py` 与 `app/api/qwen_ws.py`：登录用户只从当前 owner 的有效声纹资料取姓名、角色、部门字段，加上显式配置词表后通过 `X-Laoji-ASR-Terms-B64` 发送；访客没有声纹词表；适配器健康检查拒绝没有上下文能力的旧 provider；转写事件只回传词数/是否启用，不回传词表内容。

原文件备份位于 `/home/yydd/.codex/tmp/svc09-r6-verify-src/backups/context-merge-20260802/`。在本轮身份门禁合并前，完整候选源级合同为 `9/9`、聚焦测试 `32 passed`；最新报告已刷新为 `11/11`、`34 passed`，仍由 `tools/service-quality-evidence/svc03/run_full_candidate_qwen_context_contract.py` 记录，证据为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-context-contract-r1.json`。

随后在 GPU0 临时端口 `28131` 以同一完整候选 provider、同一 `Qwen3-ASR-0.6B` 和无全局词表严格重跑 28 条会议语音的 context-off/context-on 各 28 条：两组均 `28/28` 无请求错误；off 为 exact `24/28`、关键术语 `82/84`，on 为 exact `28/28`、关键术语 `84/84`；on 的 RTT p95 `399 ms`、模型推理 p95 `397 ms`。真实报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-context-quality-r2.json`。另一次 HTTP 边界检查确认健康 `context_supported=true`、静音不加载模型、非静音非法词表返回 `400`、合法请求返回 `context_applied=true`。

该结果证明完整候选的上下文装配和隔离真实模型行为，不证明词表在真实多人/噪声/注册声纹中提升 DER/JER/FAR/FRR，也不证明完整 FastAPI/WebSocket、Android 真机、并发/OOM、systemd/服务器重启、长时 soak 或生产部署。候选未发布，`promotion_eligible=false` 保持不变。

### SVC-03 完整候选真实 ASGI/WebSocket 上下文纵向

为确认上一节的 `qwen_ws.py` 修改确实经过真实进程边界，本轮新增 `tools/service-quality-evidence/svc03/run_full_candidate_qwen_websocket_context_probe.py`。探针只启动隔离完整候选 ASGI、完整候选 Qwen provider 和临时 SQLite；Qwen 使用本地 `Qwen3-ASR-0.6B`、`cuda:0`，ASGI 使用候选 VAD/CAM++ 支持模型，端口和数据库均为临时资源。游客会话发送真实 16 kHz PCM，适配器从显式配置词表装配 `X-Laoji-ASR-Terms-B64`，随后由 provider 返回词数/启用标记。

报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-r1.json` 全部通过：Qwen 健康 `context_supported=true`，ASGI health `200`；`config -> stop_acknowledged -> transcript.completed -> ready_to_stop` 顺序正确；真实音频得到 `明天下午三点开会。`，事件标记 `context_term_count=2/context_applied=true`；游客转写缓存与读取一致，删除返回 `204`，provider 日志确认收到两词。该证据首次覆盖完整候选适配器到 provider 的真实 HTTP/WebSocket 纵向，不再只依赖 provider HTTP 边界或单元测试。

这仍是一次性 SQLite、单游客、短音频和单 ASGI 进程，不证明登录用户声纹资料范围、真实注册录音质量、多人噪声 DER/JER/FAR/FRR、Android 麦克风、生产 ingress、多 worker、OOM、重启或 soak；`promotion_eligible=false` 保持不变。

### SVC-03 完整候选登录账号声纹上下文隔离

同一探针以 `--scope` 运行，关闭全局词表后在临时 ASGI 中注册两个账号，并在隔离声纹库中为账号 A 写入 1 个词、为账号 B 写入 3 个不同字段词；游客、A、B 依次创建各自会议并通过真实 WebSocket 发送同一音频。报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-scope-r1.json`。

结果全部通过：游客转写事件为 `context_term_count=0/context_applied=false`；A 为 `1/true`；B 为 `3/true`；A、B 的 `config`、停止确认、最终转写和 `ready_to_stop` 均完整。ASGI 日志显示每个登录会话只装载 `profiles=1`，事件中的 `best_guess_name` 与各自资料对应，未出现跨账号词数串入。该证据证明当前请求链路的 owner scope 和访客无声纹策略在真实进程中生效。

范围证据使用合成 192 维向量来验证资料装配，不代表真实录音注册、声纹相似度阈值或迁移/撤销流程；仍未证明真人多人噪声 DER/JER/FAR/FRR、生产存储/多 worker、Android、重启和 soak，不能据此晋级生产。

### SVC-03 完整候选 provider 身份与本地模型路径门禁

继续审计 staging 后发现完整候选 provider 的 `/health` 虽然有 `ready/context_supported`，但没有证明运行中的源码和模型配置就是经过审阅的那一份。已在备份优先后补齐：`QWEN_ASR_MODEL` 必须解析为本地且含 `config.json` 的目录；provider 在加载前计算自身 `server_sha256` 与 `model_config_sha256`，可通过 `QWEN_ASR_EXPECTED_SERVER_SHA256`、`QWEN_ASR_EXPECTED_MODEL_CONFIG_SHA256` 固定身份；`QWEN_ASR_REQUIRE_IDENTITY=1` 时缺少 pin 或任何漂移都在模型加载前失败。健康响应同时公布配置路径、两份哈希、`identity_pinned` 和 `identity_verified`。

完整候选 `app/api/qwen_ws.py` 增加同名严格模式：当 `QWEN_ASR_REQUIRE_IDENTITY=1` 时，provider 缺少有效 pinned identity 返回稳定 `qwen_asr_identity_unverified`，不会向移动端发送可录音 `config`；未启用严格模式时仍保留旧候选兼容行为，但健康快照会携带身份字段。备份位于 `/home/yydd/.codex/tmp/svc09-r6-verify-src/backups/identity-merge-20260802/`。

源级合同已刷新为 `11/11`，聚焦测试 `34 passed`。随后严格设置两份当前 SHA-256，在 GPU0 启动真实完整候选 Qwen、ASGI、VAD/CAM++ 和 WebSocket：health 记录 `identity_required=true`、`identity_pinned=true`、`identity_verified=true`，server SHA-256 为 `546edc6ca3f5c61561502e12c5cdd53b1fd0d047731941085fcd798324b78a0c`，模型配置 SHA-256 为 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`；游客上下文纵向和账号范围纵向均通过。报告分别为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-r1.json` 与 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-scope-r1.json`。

该门禁只证明候选身份不会假绿，不证明生产 pin 的发布流程、模型权重完整性以外的供应链、真实多人/噪声声纹、Android、并发/OOM、重启、soak 或生产部署；`promotion_eligible=false` 继续保持。

### SVC-08 位置粒度与服务检查边界修复

本轮复核离线城市候选时发现两个会直接影响用户判断的边界缺陷。第一，部分地址 provider 会同时返回 `city=深圳市` 和 `name=深圳市`；旧客户端把任意 `name` 判为 `place`，导致城市级低置信结果被错误标成地点。现将粒度判定改为：街道/门牌优先；只有与城市、区县、地区和国家字段均不同的名称才是地点；重复城市名称保持 `city`。第二，`Location.hasServicesEnabledAsync()` 自身异常以前会被转换为 `false`，把“系统定位 API 暂时不可用”误报成“定位服务已关闭”；现改为独立的中文 `unavailable` 错误，只有明确返回 `false` 才显示需要开启定位服务。

配置 HTTP 地址适配器现在保留代理响应中的受限 `provider` 标签（最多 64 个 ASCII 标识字符），因此离线城市结果的内部 `addressProvider` 为 `offline-city`，而不是笼统的 `configured-http`；标签非法时自动回退到适配器名称。该元数据只用于内部结果和证据，不会把服务端声明的精度直接提升，粒度仍由地址字段和本机定位精度重新计算。默认仍不请求外部 provider，坐标兜底和中文错误分类保持不变。

本轮修改前备份位于 `/home/yydd/.codex/tmp/svc08-r2-backup-20260802/`。位置 provider 矩阵现为 `377/377`，HTTP 适配器合同为 `13/13`，证据分别为 `tools/service-quality-evidence/svc08/svc08-location-provider-policy-r4.json` 和 `tools/service-quality-evidence/svc08/svc08-reverse-geocoder-contract-r3.json`；代理隔离 pytest 为 `11 passed`，离线城市基础 loopback 运行合同曾为 `4/4`，当前完整 ASGI 纵向已为 `8/8`。上述运行均未调用生产服务、未使用 GPU、未连接物理 Android 设备。

这次修复只收口结果语义和错误分类，仍不能证明街道/楼栋精度、获批外部 provider 的可用性与隐私 SLA、3 类 ROM 室内外成功率、物理定位取消、生产网关部署/回滚或 SVC-08 的地址成功率门禁；`promotion_eligible=false` 继续保持。

### SVC-06 旧总结接口 JSON 泄漏收口

复核完整候选发现新 `/laoji` 总结接口已经把 `raw_json` 置空，但旧路由 `/meetings/{meeting_id}/summaries/final` 仍直接把 `FinalSummary.raw_summary_json` 返回；更隐蔽的是，`FinalSummary.full_text` 在没有 Markdown 文件时也会对同一 JSON 做 `json.dumps`，因此即使 API 字段置空，客户端仍可能在全文区域看到 JSON。现已在备份 `/home/yydd/.codex/tmp/svc06-r2-backup-20260802/` 后修复完整候选：模型层对 overview、Markdown、历史 JSON、结构化 sections、决定和待办只提取受限文本，未知对象和损坏的 JSON fail-closed；旧接口统一返回清洗后的 `overview/full_text`，兼容字段 `raw_json` 固定为 `null`，仅含不可展示元数据的记录不再被判定为可用总结。

合同 `10/10` 已通过：覆盖普通文本、带引号 JSON、Markdown JSON 代码块、JSON 数组、结构化 sections、元数据对象和损坏 JSON，并静态确认完整候选与 staging 旧接口都没有 provider envelope 返回、模型全文回退不再调用 `json.dumps(raw_json)`。证据为 `tools/service-quality-evidence/svc06/svc06-legacy-summary-api-contract-r1.json`；候选 API/模型、staging 旧接口和合同脚本均通过 `py_compile`。本轮未启动服务、未调用模型或数据库，仍不证明真实旧路由部署、历史文件迁移、客户端真机展示和摘要事实质量，`promotion_eligible=false` 保持不变。

### SVC-07 游客会议问答能力门禁边界修复

复核客户端问答链路发现：服务端同时提供无鉴权的游客临时问答 `/api/laoji/meetings/guest-questions` 和账号问答 `/api/laoji/meetings/{id}/questions`，但客户端在两种范围都先调用 `requireFreshMeetingCapability`。能力接口短暂不可达时，游客即使问答服务可用也会被能力请求提前阻断。现改为只有非 `guest` 范围才刷新 `meetingQuestionsV1`；游客继续走既有无鉴权临时接口，账号会议仍强制能力校验，并保留“缺少账号令牌不得降级到游客接口”的鉴权边界。

客户端问答路由合同刷新为 `7/7`：游客无鉴权路由、账号路由与 Bearer、账号会议禁止降级、能力为 false 时阻断、服务端错误和响应体停滞截止，以及游客跳过账号能力刷新的静态接线均通过。证据为 `tools/service-quality-evidence/svc07/svc07-question-client-route-contract-r2.json`；备份位于 `/home/yydd/.codex/tmp/svc07-r2-backup-20260802/`，TypeScript 和 `git diff --check` 通过。本轮未启动服务或模型，仍未证明真实游客模型质量、生产能力响应、长会话性能和真机问答展示，`promotion_eligible=false` 保持不变。

### SVC-03 Qwen provider 存活与就绪路由分离

复核 Qwen provider 直接 HTTP 入口时发现只有 `/health`：模型尚未加载时仍返回 HTTP 200，监控无法用标准探针区分“进程存活”和“可接收转写”。完整候选与 staging provider 现同时提供 `/health` 和 `/ready`：`/health` 保持 liveness 200，并明确返回 `ready` 与 `readiness`；`/ready` 仅在模型已加载时返回 200，未就绪返回 503，响应仍包含模型身份、上下文能力和身份校验字段。WebSocket 适配器继续读取 `/health` 的 `ready=true`，不改变已有录音协议。

源码合同 `10/10` 通过，覆盖两个 provider 源、双路由、模型绑定的 ready 值、健康 liveness 200 和未就绪 readiness 503；完整候选与 staging provider、合同脚本均通过 `py_compile`。证据为 `tools/service-quality-evidence/svc03/svc03-qwen-provider-readiness-contract-r1.json`，备份位于 `/home/yydd/.codex/tmp/svc03-r3-backup-20260802/`。本轮没有启动 Qwen、加载模型、修改 8030/18020 或触碰生产 GPU；仍未证明真实 systemd 探针切换、模型质量、真机录音、长时 soak 和生产部署，`promotion_eligible=false` 保持不变。

### SVC-05 稳定声纹资料 ID 与展示姓名分离

复核完整候选和 summary backend 的 Qwen WebSocket 适配器时发现，身份识别结果同时包含“资料稳定 ID”和“展示姓名”，但旧接线容易把姓名当作 `speaker_id` 写入 Transcript。这样会破坏同一资料在资料修订、旧会议重匹配和跨设备读取中的关联；姓名也可能随用户改名而改变，不能承担持久化身份职责。已在备份优先后修复两套候选 `app/api/qwen_ws.py`：投票键只使用识别结果中的 `speaker_id`，缺少稳定 ID 的结果拒绝确认；`speaker_name` 只用于展示，Transcript 持久化和 WebSocket 事件的确认身份使用 `identity_id`。

新增 `tools/service-quality-evidence/svc05/run_stable_speaker_id_contract.py`，对完整候选和 summary backend 各执行首个观察保持 unknown、第二个独立合格观察确认、稳定 `profile-42` 返回、中文姓名独立返回、缺少稳定 ID 拒绝以及持久化接线检查，共 `14/14` 通过。当前两个源文件哈希和逐项结果记录在 `tools/service-quality-evidence/svc05/svc05-stable-speaker-id-contract-r1.json`。

新增 `tools/service-quality-evidence/svc05/run_stable_speaker_id_asgi_smoke.py`，用临时 FastAPI `TestClient` 走真实会议 WebSocket 路由、停止排空和 Transcript 持久化调用；仅将 VAD、ASR 和 CAM++ 前向替换为可控夹具，不连接生产端口、不加载共享模型。两段相同的 1 秒音频产生 `config -> stop_acknowledged -> transcript.completed×2 -> ready_to_stop`：第一段仍输出 `speaker_1/未确认`，第二段确认后事件和持久化分别为 `speaker_id=profile-42`、`speaker_name=张三`。该 smoke `7/7` 通过，证据为 `tools/service-quality-evidence/svc05/svc05-stable-speaker-id-asgi-smoke-r1.json`。

为匹配当前 readiness 语义，候选测试夹具现在明确模拟 CAM++ 192 维特征探测成功；只加载 VAD/CAM++ 对象但未通过特征前向时，`required_models_ready()` 仍必须为 false。使用 Qwen 依赖环境的核心 `tests/test_qwen_realtime_ws.py`、`tests/test_qwen_context.py`、`tests/test_whisper_resource_profile.py` 共 `39 passed`；加上声纹归属隔离和模型 readiness 测试共 `50 passed`。这修正的是陈旧测试前置条件，不放宽生产 readiness 门禁。

本轮仍只证明稳定身份的接线、事件和一次性候选路由；不证明真人多人/相似声线 DER/JER、FAR/FRR、跨设备/跨天、真实 Android 麦克风、PostgreSQL 多 worker、账号迁移/备份、重启、soak 或生产部署。`promotion_eligible=false` 继续保持；下一步仍应先取得真人标注 cohort，再校准阈值并补齐端到端真机与生产存储验证。

### SVC-06 摘要候选回归与 JSON/引用边界复核

当前完整候选在隔离 SQLite、临时音频/账号/声纹目录和 Qwen 依赖环境中重跑摘要相关聚焦回归，包含 compact summary、模板字段、行动项生命周期、引用归一化、会议上下文、版本冲突、任务长轮询和会议笔记，共 `80 passed`。其中原有陈旧夹具已按当前实现更新：`_load_config()` 使用具备 `_replace()` 的 `OllamaConfig`，请求选项明确包含 `num_ctx=8192`、`temperature=0`，compact 输出上限为 `1024`；没有改变生产代码的模型或安全门禁。

当前源码绑定的边界合同也全部复核：待办/决定必须有转写原文支撑 `9/9`；模型 JSON 外壳、嵌套文本和损坏 JSON fail-closed `12/12`；旧总结接口不返回 `raw_json` 且全文不把 provider JSON 当正文 `10/10`；compact 归一化、模板二次调用、引用保留和请求合同 `9/9`；遥测只保留阶段/耗时、不记录提示词、转写或模型正文 `9/9`；游客三类摘要合同 `4/4`。对应证据分别为 `tools/service-quality-evidence/svc06/svc06-summary-action-grounding-contract-r1.json`、`svc06-summary-text-boundary-r1.json`、`svc06-legacy-summary-api-contract-r1.json`、`svc06-compact-summary-runtime-contract-r1.json`、`svc06-candidate-telemetry-contract-r1.json` 和 `tools/service-quality-evidence/svc06/test_guest_summary_smoke.py`。

本轮只复核候选代码、结果校验和隔离依赖；本机当前没有 Ollama 可执行文件或摘要服务监听端口，因此没有新增真实 9B 模型质量、引用 precision/recall、长会 Map-Reduce、冷暖/并发延迟证据。现有真实模型烟测仍是旧候选快照，不能覆盖当前源码；`promotion_eligible=false` 继续保持。下一步需要在独立且容量足够的模型实例上重跑冻结质量集，再决定是否调整摘要模型/模板策略。

### SVC-08 地址解析候选复核

在不连接外部公共服务的隔离环境中复核当前位置链路：反向地址代理回归 `11 passed`，离线城市基础 HTTP/ASGI 运行曾为 `4/4`、当前完整纵向为 `8/8`，移动端反向地址合同 `13/13`。代理仍保持同坐标 single-flight、不同坐标并行、上游限速、缓存、响应超时/大小上限、敏感 URL 拒绝和未配置时 `/ready=503`；离线 provider 只返回明确标注的“深圳市（城市级估计）”，不会伪装成街道或门牌。第一次使用不兼容的 Node 参数运行合同被本机 Node 拒绝，改用脚本声明的普通 `node` 后 `13/13` 通过；这属于工具调用兼容性，不是业务失败。

该复核仍没有获批外部/自托管详细地址 provider、物理真机定位成功率、真实 ROM 室内外矩阵或生产网关部署，不能把坐标/城市兜底写成“已获得详细地址”。

### SVC-01 显式范围年份推断修复

日程质量回归发现，范围端点直接复用“单个日期”的下一次发生推断会把“7月21号到7月18号”变成跨月/跨年区间，反向关系因而无法触发澄清；“7月18日到8月底”也可能被错误推到下一年。完整候选新增 `_parse_range_date_token()`：无年份的范围起点以当前 reference 年为基准，终点仅在月份小于起点月份时跨年；同月的较小日保留同年以明确暴露顺序冲突。该修复已备份 `/home/yydd/.codex/tmp/svc09-r6-verify-src/backups/schedule-range-20260802/schedule_parser_service.before-range-year-fix.py`，并同步到 qwen35 cutover 候选（备份位于其 `backups/schedule-range-20260802/`）。

以 `reference_datetime=2026-07-13T10:00:00+08:00` 的独立合同 `tools/schedule-quality-v3/svc01-range-year-contract-r2.json` 为证：完整候选 `4/4`，qwen35 cutover 通过新解释器真实运行并完成 `5/5`；两者均使反向范围保持 `2026-07-21`、清空结束日期并要求澄清，跨月范围保持 `2026-07-18` 到 `2026-08-31`，并且缺少日期的“开会”不填今天而保留空日期和追问。完整候选的有限“每天”范围保持 `daily`；qwen35 的有限范围日期端点正确，但其既有有限范围事件类型仍为 `once`，这不是本轮范围年份修复的回归。日程质量文件回归现为 `58 passed`；这仍不代表真实模型盲测、真实音频、时区/夏令时全矩阵、服务部署或生产质量放行。

### 当前完整候选回归收口

在同一隔离 Python 3.11/Qwen 依赖和临时 SQLite/音频/账号/声纹目录下，完整候选测试树共 `500` 项，最新 JUnit `tools/service-quality-evidence/svc09/svc09-full-candidate-regression-r3.xml` 为 `492 passed / 8 skipped / 0 failed`。跳过项仅为未提供 loopback PostgreSQL DSN 的 `3` 个 PostgreSQL Gate，以及已按工作区轻量化归档、旧路径不可用的 `5` 个生命周期脚本检查；脚本测试已显式标记归档而非伪造通过。该回归证明当前候选代码合同没有已知 Python 单元回归，但不替代真实模型质量、GPU 容量/并发、Android 物理真机、生产 PostgreSQL/Redis、重启和 soak 门禁。

### SVC-01 qwen35 cutover 范围路径纵向收口

上一轮范围年份修复虽然已同步到 `/home/yydd/LaoJi/server-staging/qwen35-9b-cutover/smart-meeting-ai/backend/app/services/schedule_parser_service.py`，但真实调用仍暴露两个接线缺口：反向日期范围会被 `_should_skip_quick_schedule_parse()` 送入模型路径，而该候选没有确定性复杂回退；同时 qwen35 parser 传入的 `priority="interactive"` 与候选本地 `meetingsummary.ollama_client.call_ollama()` 签名不一致，导致模型路径以 `unexpected keyword argument 'priority'` 失败并返回空结果。

本轮在修改前备份了 qwen35 parser、Ollama 客户端和测试，位置为 `/home/yydd/LaoJi/server-staging/qwen35-9b-cutover/smart-meeting-ai/backups/schedule-range-20260802-r2/`。修复内容如下：

- 反向范围识别改为确定性规则路径，保留用户说出的开始日期，清空不安全的结束日期并要求中文澄清；模型无结果时也复用窄范围的确定性回退。
- qwen35 客户端接受并校验 `interactive/background` 优先级、操作标签和可选队列截止，并向 Ollama/OpenAI-compatible 请求转发安全 header；非法值在发 HTTP 前拒绝。
- 无日期的普通事项或仅有钟点的事项不再把当前日期写入可保存草稿；日期为空并明确要求补充日期。重复规则自身仍可产生合法起始候选。
- 测试夹具将反向范围的预期从“进入模型”改为“安全规则路径”，并新增客户端优先级 header/非法值合同。

独立脚本 `tools/schedule-quality-v3/run_range_year_contract.py` 现以新解释器真实加载 qwen35 cutover，避免与完整候选的 Python 模块混用。报告 `tools/schedule-quality-v3/svc01-range-year-contract-r2.json` 共 `9/9`：完整候选 `4/4`，qwen35 cutover 运行完成并通过 `5/5`（含 runtime、反向范围、跨月范围、有限每日范围日期端点、缺少日期不造日期）。qwen35 的日程质量聚焦回归为 `58 passed`，客户端回归为 `14 passed`；相关源码均通过 `py_compile`。

该证据只证明候选的确定性范围/日期边界、客户端参数接线和离线运行；不证明 qwen35 真实模型输出质量、完整 staging ASGI/认证/数据库、GPU/队列性能、混合负载、真机语音或生产部署。`promotion_eligible=false` 继续保持。

### SVC-09A 当前源码 PostgreSQL 隔离部署演练 r12

首次重跑 SVC-09A 时，旧的 `svc09-current-source-manifest-r1.json` 正确拒绝了当前 summary 候选：`asr_gateway_client.py`、`app/api/meetings.py` 和转写评审测试已经发生源码漂移。审阅差异确认这些是当前候选的稳定任务 ID、网关分代、摘要 canonical 存储和 JSON 清洗改动，而不是可以忽略的哈希差异；因此没有覆盖旧证据，新增当前源码 attestation `tools/service-quality-evidence/svc09/svc09-current-source-manifest-r2.json`。

使用新 attestation 重新运行 `tools/service-quality-evidence/svc09/run_svc09a_isolated_deployment_rehearsal.py --allow-local-docker`，报告 `svc09a-isolated-deployment-rehearsal-r12.json`：

- 11 个部署顺序步骤全部通过；新 claims 先 quiesce，网关先升级，旧 worker 排空后才启动同版本候选 worker。
- 当前源码哈希全部与 r2 manifest 一致；实际 ENV=local SQLite 使用显式临时 `DATABASE_URL`，备份/恢复、schema helper 双次运行、55 条 terminal rows 保留、active job=0 和唯一 active asset 约束均通过。
- 一次性、无网络 PostgreSQL 16 容器中，增量迁移执行两次仍幂等；旧重复 active rows 收敛、历史行保留、唯一约束和 lease recovery index 均通过。
- generation 0 失败任务在 generation 1 使用不同稳定 provider task ID 重试并完成；候选 worker 版本/构建同质；应用回滚后保留新网关和增量 schema，并恢复旧 worker cohort。
- 清理确认 sentinel、PostgreSQL 容器和临时 SQLite 目录均已移除；未接触生产数据、远程服务或 GPU。

该演练仍是候选部署顺序和数据库边界证据，不是发布许可。尚未证明真实 FastAPI/网关进程、真实长音频/ASR、GPU 压力、服务器重启、生产 SQLite 持久备份、生产 PostgreSQL 配置和多小时 soak；报告保持 `isolated_rehearsal_passed_with_release_blockers`，`promotion_eligible=false`。

### SVC-09 当前候选真实 ASGI 录音资产纵向 r4

在与 r2 attestation 对齐的完整候选运行树中，使用 Python 3.11 隔离环境启动真实 FastAPI lifespan 和 ASGI transport，数据库、音频目录与模型目录均为临时资源；只将 durable transcription submit 替换为 no-op，不启动 ASR worker。报告 `tools/service-quality-evidence/svc09/svc09-full-asgi-recording-flow-r4.json` 的 HTTP/持久化合同为 `13/13`：录音资产登记/同键重放、不同 payload 冲突、错误上传拒绝、原子上传、内容回读、转写任务创建与重放、持久化 revision 和无残留临时文件均通过。

这次纵向补足了 r12 部署演练没有启动真实 FastAPI 进程的边界，但仍不证明真实 ASR、长音频、GPU/OOM、生产 PostgreSQL、多 worker、重启或 soak；`promotion_eligible=false` 继续保持。

### SVC-04 视频容器到 Qwen worker 真实纵向补充

复核“本地视频上传后转文字失败”路径时发现，原有 `run_real_qwen_gateway_worker_probe.py` 虽然内层持久化探针支持 `--raw-media`，编排层却没有声明或透传该参数，测试因此可能把视频悄悄降级成 WAV 输入。已在备份 `/home/yydd/.codex/tmp/svc04-video-gateway-probe-backup-20260802/` 后补齐编排参数，并新增静态合同 `tools/service-quality-evidence/svc04/svc04-video-qwen-worker-orchestration-contract-r1.json`，`5/5` 通过。

使用带 H.264 视频轨和 AAC 音轨的临时 MP4、GPU0 隔离 Qwen3-ASR-0.6B、真实候选 worker、真实网关 fail-first/retry 和临时 SQLite 运行，报告 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-raw-video-r2.json` 为 `19/19`：原始 `video/mp4` 登记和保存、ffmpeg 音轨提取、Qwen 返回“明天下午三点开会。”、第一次 provider 故障后的第二代任务重试、Transcript 持久化和资产/任务关联均通过；模型实际运行在 `cuda:0`，provider 调用两次。

此前同一探针指向旧 r6 验证快照时得到 `15/4` 失败；对照确认旧快照缺少当前 r7 的租约分代修复，不能代表当前候选。当前证据仍不覆盖真实用户视频编码矩阵、长视频、多人说话人、物理设备上传、生产 worker、多 worker PostgreSQL、重启和 soak，因此 SVC-04 仍不可发布。

### SVC-04 录音资产 MIME/文件名一致性门禁补充

继续审计视频导入入口发现一个会把错误推迟到转写 worker 的边界：`RecordingAssetV2Register` 原先只按文件名后缀检查是否属于支持集合，`video.mp4` 可以带 `audio/wav` 的登记元数据，资产会先进入 durable 队列，直到 ffmpeg/ASR 阶段才失败。该行为不符合“文件名与 MIME 不一致必须明确拒绝且不能污染任务”的格式矩阵要求。

在修改前已分别备份 r6/r7 隔离候选的 `app/api/app_recording_v2.py` 到 `tools/service-quality-evidence/svc04/source-backups/mime-fence-20260802/`。当前候选增加 MIME 参数归一化和按后缀的白名单映射：WAV/MP3/M4A/AAC/OGG/WebM/FLAC/MP4/MOV/MKV 的常用 MIME 可通过，带 `codecs` 参数的同类型值只去除参数、不改变类型；跨音频/视频或未知 `application/octet-stream` 均在登记阶段返回中文 `415 文件格式与文件名后缀不一致`，不会调用 `register_asset`。

合同 `tools/service-quality-evidence/svc04/svc04-media-mime-fence-contract-r2.json` 对 r6/r7 两个候选根各验证 10 个允许格式、6 个登记不匹配组合、2 个上传元数据通过组合、4 个上传不匹配组合和真实路由“先拒绝、后不入库”，共 `46/46`；两份当前源哈希均为 `b55be6dee4c5aa224a74436404b8ce22d775a7caeb63568124219f81b11a0ce6`。新增上传检查确保 multipart 文件名后缀和 `content_type` 不会背离已登记资产；缺省 multipart MIME 仍沿用登记值。候选完整回归仍为 `492 passed / 8 skipped`（`tools/service-quality-evidence/svc04/svc04-mime-fence-full-regression-r2.xml`）。同一修复后的 r7 候选再次使用真实 H.264/AAC MP4、GPU0 隔离 Qwen3-ASR-0.6B、真实网关 fail-first/retry 和 SQLite 持久化，`19/19` 通过，证据为 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-raw-video-r4-mime-fence.json`。

这只收口元数据一致性和入口时机，不等于内容魔数/音频流存在性验证，也不覆盖长视频、损坏/截断文件、80 小时格式矩阵、GPU RTF、真实噪声质量、PostgreSQL 多 worker、生产部署、重启和 soak；`promotion_eligible=false` 保持不变。

### SVC-04 上传内容可解析性与音轨门禁补充

在上一轮 MIME 门禁之后继续审计发现，上传路径仍会把任意字节写入临时文件，再用只返回可选时长的 `_probe_duration_sec` 完成资产；损坏容器、截断文件和只有视频没有音轨的 MP4 可能因此先进入 durable 状态，直到 worker 才失败。现已在上一轮 MIME 修复源码上再次备份到 `tools/service-quality-evidence/svc04/source-backups/content-fence-20260802/`，并把 `ffprobe` 内容校验前移到 `_install_upload_target` 之前。

新的 `_probe_media_content` 只接受 ffprobe 可解析、包含至少一个音频流且拥有有限正时长的文件；解析失败、超时、无音轨、非法时长分别返回中文 `422`，ffprobe 不可用返回 `503`。无效文件在目标安装前失败，资产保持 `registered`、没有 `storage_path`，临时文件由现有 finally 清理；有效 WAV 和带 AAC 音轨的 MP4 才能变为 `uploaded`。Windows/Linux 均通过 `shutil.which('ffprobe')` 和参数数组调用，不依赖 shell。

隔离真实 FastAPI/SQLite 合同 `tools/service-quality-evidence/svc04/svc04-media-content-fence-contract-r2.json` 在 r6/r7 两个候选各验证有效 WAV、有效 H.264/AAC MP4、视频无音轨、损坏容器和截断容器，共 `10/10`；有效文件均持久化为 `uploaded`，3 类无效文件均为 `422` 且无资产/临时文件污染。当前完整候选回归仍为 `492 passed / 8 skipped`，证据为 `tools/service-quality-evidence/svc04/svc04-content-fence-full-regression-r1.xml`。修复后再次使用真实 MP4 走 GPU0 隔离 Qwen3-ASR-0.6B、网关故障首试、租约重试和 Transcript 持久化，`19/19` 通过，证据为 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-raw-video-r5-content-fence.json`；两份源哈希均为 `dc8a8b42824e9c9c7402bc508360355d1b565eae9479855204e1ff210668dc70`。

这只收口上传内容的早期失败和资产原子性，不等于 80 小时格式/采样率/码率矩阵、长视频 RTF、真实噪声质量、GPU OOM、PostgreSQL 多 worker、生产重启或 soak；`promotion_eligible=false` 继续保持。

### SVC-04 隔离格式与时长矩阵补充

在内容门禁之后，对当前声明支持的 10 种后缀进行了真实 ffmpeg 生成和上传验证：WAV、MP3、M4A、AAC、OGG、WebM、FLAC、MP4、MOV、MKV；音频和视频文件均包含可读音轨。每种格式验证约 1.25 秒样本，并额外验证 30 秒和 300 秒 WAV/MP4，均经真实注册、multipart 上传、ffprobe 时长读取和 SQLite 持久化。

报告 `tools/service-quality-evidence/svc04/svc04-format-duration-matrix-r2.json` 在 r6/r7 两个候选根共 `28/28` 通过：所有上传返回 `200`，目标文件存在，短样本时长误差不超过 500 ms，30 秒和 300 秒样本均准确回读。当前源哈希为上一轮内容门禁后的 `dc8a8b42824e9c9c7402bc508360355d1b565eae9479855204e1ff210668dc70`。本轮矩阵未发现声明格式与 ffprobe/上传实现之间的新缺口，因此没有扩大 MIME 白名单或改动生产行为。

该结果只是隔离候选的小规模格式/时长证据，不是规划要求的 80 小时全集，也没有覆盖可变码率、8–48 kHz 全组合、损坏头/截断尾的大规模比例、长视频真实 ASR 质量、GPU RTF、任务重启、PostgreSQL 多 worker 或生产 soak；`promotion_eligible=false` 保持不变。

### SVC-04/SVC-09 上传目标文件回滚补充

继续做资产原子性审计时发现，上传临时文件安装成功后，若 `complete_content_upload` 在数据库激活阶段返回版本冲突或异常，旧路径只删除 `.part`，可能遗留一个数据库不可引用的目标文件。候选现增加 `_cleanup_uncommitted_target`：只有当前请求实际安装的目标才进入清理；清理前回滚并重新读取 canonical asset，若胜者已经激活同一路径则保留，否则删除目标。`matching` 的并发胜者文件不会被误删。

修改前备份位于 `tools/service-quality-evidence/svc04/source-backups/asset-cleanup-20260802/`。合同 `tools/service-quality-evidence/svc04/svc04-asset-cleanup-contract-r1.json` 对 r6/r7 各运行 3 条真实 SQLite 上传测试，共 `6/6`：激活冲突清理当前请求目标、不同内容并发保留胜者、相同内容并发只保留一个 canonical target。完整候选回归刷新为 `493 passed / 8 skipped / 0 failed`，证据为 `tools/service-quality-evidence/svc04/svc04-asset-cleanup-full-regression-r1.xml`；当前源哈希为 `4c6d569abd09e0a798bfe1320f08d2398c09211dc115a89f1f99eb72b8b4fa0b`。修复后的 r7 真实 H.264/AAC MP4→Qwen→故障重试→持久化仍为 `19/19`，证据为 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-raw-video-r6-asset-cleanup.json`。

该修复只收口候选进程内/SQLite 的文件与数据库激活竞态，不证明生产对象存储、PostgreSQL 多 worker、外部 ASGI 提交、服务器重启和长期 soak；`promotion_eligible=false` 继续保持。

### SVC-03 当前候选长会话与断线恢复补充

现有长会话证据只有约 38 秒，且旧探针要求调用者手动先启动服务；本轮新增 `tools/service-quality-evidence/svc03/run_full_candidate_long_session_probe.py`，自动启动当前 r7 候选 Qwen、FastAPI/ASGI、临时 SQLite、真实 VAD/CAM++ 和 GPU0 `Qwen3-ASR-0.6B`，并显式等待 `/api/ready=200` 后才开始录音。此前 wrapper 直接请求 `/api/ready` 时曾得到合法的 `503`，根因是支持模型尚未预热，不是游客容量问题；现在候选实验默认开启预热并把 readiness 作为硬前置。

使用 28 条固定 16 kHz WAV、总音频 `183.078 s`、`realtime_factor=2.0` 运行当前完整候选。报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-long-session-r2.json` 显示：正常 stop 会话产生 `48` 个最终片段且缓存同为 `48`，最大结束时间 `182880 ms`、时间轴单调、`config → stop_acknowledged → 最后片段 → ready_to_stop` 顺序正确，墙钟约 `92.8 s`；客户端不发送停止标记的断线会话发送 `477` 帧，连续轮询得到 `[16,16,16]`，随后删除成功；前后健康、Qwen readiness、正常清理和断线清理全部通过。临时 Qwen/ASGI 进程均以 `SIGTERM` 退出，报告绑定 Qwen 源哈希 `8f0fdcb4436864f839e3417990e77e02fb3cc1533005604ef5aa0f2176bdd35a` 与模型配置哈希 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`。

这把候选真实 WebSocket/VAD 长会话从约 38 秒扩展到约 3 分钟，证明了更长的 stop drain、断线落盘和 readiness 前置，但仍不等于规划中的 2 小时 soak；没有新增真人多人/噪声 DER/JER、GPU OOM、服务器级重启、生产多 worker、物理手机或发布资格结论，`promotion_eligible=false` 保持不变。

### SVC-03 同进程多轮资源 soak 补充

为避免单轮长会话掩盖重复任务的资源泄漏，新增 `tools/service-quality-evidence/svc03/run_full_candidate_soak_probe.py`，在同一隔离 Qwen/ASGI 进程内连续运行 3 轮，每轮 28 条固定 WAV、总音频 `183.078 s`，每轮都包含正常停止、缓存回读、游客删除和客户端断线清理；同时采集 Qwen/ASGI RSS 与 GPU 进程显存。

报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-soak-r1.json` 的 3 轮均通过完整会话检查：每轮 `48` 个正常转写片段、缓存 `48` 个，断线缓存 `16` 个，健康与清理均成功。Qwen+ASGI RSS 总和从首轮到末轮的增长比例为 `5.094%`，GPU 进程显存三轮均为 `2382 MiB`（增长 `0%`），均低于当前 10% 资源增长阈值；Qwen/ASGI 退出码均为 `-15`，没有遗留候选进程。

该 soak 只覆盖约 6 分钟的 3 轮候选运行，不能替代规划要求的 2 小时 soak、OOM 压力、服务器/systemd 重启、生产多 worker、真实多人噪声质量或物理真机；`promotion_eligible=false` 继续保持。

### SVC-09 上传存储余量准入与磁盘错误边界补充

审计录音资产上传入口时发现，原路径在创建临时文件并流式写入前不检查目标文件系统余量；磁盘写满或配额耗尽会以未分类异常结束，移动端只能看到泛化的上传失败，且无法区分“空间不足”和“无法检查存储”。这与 SVC-09 的磁盘不足/不可写用例不符。

在修改前已备份 r6/r7 两个隔离候选的 `app/api/app_recording_v2.py` 与 `app/config.py` 到 `tools/service-quality-evidence/svc09/source-backups/storage-fence-20260802/`。当前候选新增可通过环境变量覆盖的 `MEETING_AUDIO_MIN_FREE_BYTES`（默认 64 MiB）和 `_storage_capacity()`：

- 已知 `byte_size` 在临时文件打开前按“文件大小 + 保留空间”准入；未知大小以准入时的可用容量作为本次上传上限，避免无声明大小的请求无限吃掉保留空间；
- 每个流式块写入前重新检查余量，捕获 Linux/Windows 共有的 `ENOSPC`/`EDQUOT`，不把磁盘问题变成 500；
- `storage_insufficient` 返回 HTTP `507` 和中文“存储空间不足，请清理空间后重试”，`storage_unavailable` 返回 HTTP `503` 和中文“无法检查存储空间，请稍后重试”；两种失败均保持资产 `registered`、不激活 `storage_path`，并清理临时文件；
- 有效文件仍走原有 ffprobe、原子安装、数据库激活和目标文件竞态清理路径，未放宽大小、MIME 或内容门禁。

隔离真实 FastAPI/SQLite 合同 `tools/service-quality-evidence/svc09/svc09-storage-admission-contract-r1.json` 在 r6/r7 各覆盖正常上传、已知大小预拒绝、未知大小容量上限和文件系统检查异常，共 `8/8` 通过；两个候选的 `app_recording_v2.py` SHA-256 均为 `ef6fee81ce529218816566119b32219fffae44a8aff5113be33abebaaf687d3f`，`config.py` SHA-256 均为 `53a0c2b97dd5ce4a81a8302d50a45c5c55a34b92f82e804fe2acd78e23369eb7`。r6 当前完整候选回归 `493 passed / 8 skipped / 0 failed`，证据为 `tools/service-quality-evidence/svc09/svc09-r6-storage-fence-full-r1.xml`；r7 的上传源码与 r6 同哈希，单独的存储合同已通过，但其旧快照全量测试树包含与本切片无关的脚本/解析器漂移，不能把该旧树的全量结果外推为当前候选回归。

该切片只证明隔离文件系统上的上传准入、稳定错误和清理边界，不证明生产对象存储配额、容器/磁盘告警、PostgreSQL 多 worker 竞态、并发大文件公平性、服务器重启或两小时 soak；没有连接生产服务、没有改变 GPU0/GPU1 或线上配置，`promotion_eligible=false` 继续保持。

### SVC-09 录音与照片附件共享存储准入补充

在录音资产准入落地后继续检查附件入口，确认图片上传仍直接创建 `.part` 并写入，空间不足时会绕过统一错误边界。已在备份优先后新增候选共享模块 `app/services/storage_admission.py`，录音资产和照片附件共同使用同一个保留空间、`disk_usage` 检查、`ENOSPC/EDQUOT` 映射和中文错误响应；附件仍保留 25 MiB 大小上限、图片魔数校验、校验和校验、原子替换与状态激活顺序。

附件入口现在也满足：已知大小在写入前预拒绝；每个块写入前重新检查；检查失败返回 `storage_unavailable`；写满返回 `storage_insufficient`；失败会关闭上传流、删除 `.part`/未激活目标，数据库中的附件保持 `registered`。录音入口的既有行为未改变，只是从共享模块引用，避免两条链路日后出现不同错误语义。

修改前备份位于 `tools/service-quality-evidence/svc09/source-backups/storage-fence-20260802/shared-r2/`。当前 r6/r7 两个候选的源哈希均一致：`app/services/storage_admission.py` 为 `77c980c0f9de8f40612a97a90299bcc4164005e6d53c2c44add0175a17ebf662`，`app/api/app_recording_v2.py` 为 `e41aa96faa22db47b404031248140642c8743f794f9379acf3bbc27eee8437fb`，`app/api/app_attachment_v1.py` 为 `420db2e78126da10ba17e1267bcf1ed9f63d62ecdfe2a6ec9fcf3a0485b2e5d5`。

证据如下：录音合同 `tools/service-quality-evidence/svc09/svc09-storage-admission-contract-r2.json` 为 r6/r7 共 `8/8`；附件合同 `tools/service-quality-evidence/svc09/svc09-attachment-storage-admission-contract-r1.json` 为 `6/6`；两个候选的附件、录音、转写聚焦回归均为 `19 passed`；r6 当前完整候选回归 `493 passed / 8 skipped / 0 failed`，见 `tools/service-quality-evidence/svc09/svc09-r6-storage-shared-full-r1.xml`。

这些结果仍是隔离候选证据，不代表生产对象存储配额、容器磁盘告警、PostgreSQL 多 worker、并发上传公平性、服务器重启或长期 soak；没有连接生产服务或改变 GPU/线上配置，`promotion_eligible=false` 保持不变。

### SVC-07 问答缓存与单飞作用域隔离补充

复核问答的进程内答案缓存和 single-flight 后发现，原键主要依赖会议内容指纹；内容指纹用于判断证据版本，却不应承担账号授权边界。候选现在在认证问答入口写入内部 `_cache_scope=user:<id>`，游客入口写入 `_cache_scope=guest`，并把该字段加入答案缓存键。它不进入客户端 `input_fingerprint`、请求幂等哈希或模型提示词，因此不会破坏已有客户端合同；相同用户仍可命中缓存，不同用户和游客不会共用同一答案/等待者。

同时修复 r7 快照内部调用的兼容边界：当旧的 evidence-only 调用没有 `input_fingerprint` 时，答案缓存键回退到受限证据指纹，不再抛 `KeyError`；HTTP 完整请求仍要求并校验正式 `input_fingerprint`。

修改前备份位于 `tools/service-quality-evidence/svc07/source-backups/cache-scope-20260802/`。当前 r6/r7 源哈希分别为：r6 `app_meeting_question.py=43adfe463e94cc6c31e2170d077d5906dacadfc111990e1764d0a44aa04f34b9`、`app_meetings.py=940fc7f6916662907ae06e3aaed3aff15fce7f057fe4a9651866b28d71628a52`；r7 `app_meeting_question.py=c1df837c33df1eadee6b3b12bb0f67f114f67e9a9940736cd7609f51774e3e6c`、`app_meetings.py=347a905b9cd657fe49f2a6549958517fcf9b721d188d862fe97e6306d5082c0e`。

候选合同 `tools/service-quality-evidence/svc07/svc07-question-cache-scope-contract-r3.json` 在两套根共 `8/8` 通过：同一用户重放键稳定、两个认证用户键不同、游客与认证键不同、HTTP 路由正确装配作用域。问答速度/混合检索聚焦回归两套均为 `69 passed / 7 deselected`；r6 当前完整候选回归为 `493 passed / 8 skipped / 0 failed`，证据 `tools/service-quality-evidence/svc07/svc07-r6-question-scope-full-r1.xml`。

这只收口单进程缓存和请求链路的作用域边界，不证明 Redis/分布式缓存、多 worker 共享状态、真实 9B 并发、冷启动或生产部署；`promotion_eligible=false` 继续保持。

### SVC-10 元数据回退与本地日期边界补充

继续按真实用户可见路径审查本机搜索时发现，索引结果和旧版会议列表筛选原先是“二选一”：只要任意正文索引命中，地点、状态、时长或参与人等仍只存在于 `Meeting` 投影中的匹配会议就会被整体隐藏。当前页面改为受限并集：先保留带来源/片段的 FTS 结果，再追加没有同一会议索引命中的元数据结果；索引故障、旧数据库迁移和未命中时仍保留原有标题/元数据回退，不把搜索失败升级为会议列表失败。

日期过滤同时改用 SQLite `unixepoch + localtime`，按设备本地日历日比较，而不是把 UTC 日期直接展示语义化；范围上界仍为包含当天的半开区间。标签、人物、来源、生命周期和 scope 的参数化过滤保持不变。

本轮证据：共享解析/页面/SQL 合同 `18/18`（`tools/service-quality-evidence/svc10/svc10-search-filter-contract-r1.json`，含中文显示日期到 ISO 日期键的行为检查）、SQLite JSON1/FTS5 过滤运行 `6/6`（`svc10-search-filter-sqlite-runtime-r1.json`）、索引生成代数栅栏 `12/12`（`svc10-search-index-generation-contract-r1.json`），以及当前 Preview Android 原生 SQLite 能力 attestation `9/9`（`svc10-expo-sqlite-capability-contract-r1.json`）。模拟器系统 `/system/bin/sqlite3` 是 3.28 且没有 JSON1，但 Expo SQLite 使用自带 3.50.3 vendor 库；四种 Preview ABI 的 `libexpo-sqlite.so` 均包含 JSON1、FTS5 和 trigram 能力。更新后的隔离规模基准仍为 10000 场会议、20000 条索引行、1500 次查询，exact Recall@10 `100%`、跨作用域/已删除泄漏 `0`、query p95/p99 `8.5997/9.4339 ms`，提交新 revision 后立即命中；当前源码哈希绑定在 `svc10-search-scale-benchmark-r1.json`。

该切片仍未证明 Android 真正用户数据库上的迁移/重建/查询、设备时区矩阵、iOS SQLite parity、语义 Recall@10/NDCG、远端同步/跨设备 freshness、索引损坏期间的实际 UI 恢复或生产权限审计；没有改动生产服务，`promotion_eligible=false` 保持不变。

### SVC-01 上下文 holdout 断言与“无日期不造日期”收口

重跑当前 qwen35 候选解析器的 request-scoped context holdout 时，发现两条旧断言仍要求“无日期输入自动填今天”以及“倒置日期范围必须送模型”。这与当前指示文档的安全规则相冲突：没有日期只能返回不可保存的空日期草稿并追问；倒置范围应在确定性路径保留用户说出的开始日期、清空结束日期并追问顺序，避免模型凭空修复。

已将 `tools/service-quality-evidence/svc01/run_schedule_context_holdout.py` 的断言改为验证上述安全行为，并保留多句复杂输入走模型的检查。当前候选解析器哈希 `78c47d4533804d28f363ec2250dd902b9050cb8e5044cafd79cf456406674506`，holdout 共 `65/65` 通过；这次只修正评测与既定规则的错位，没有放宽保存门禁或改动线上服务。

该结果仍是确定性规则/归一化 holdout，不证明真实模型盲测、全字段语义质量、置信校准、GPU/CPU 队列延迟、真实手机语音或生产部署；`promotion_eligible=false` 继续保持。

### 进度表更正

上方早期进度表中的 SVC-10 “人物/日期/标签过滤仍未验证”是历史快照；本节及前一节新增的 `18/18` 共享过滤合同和 `6/6` SQLite 运行合同已经覆盖隔离候选的这些过滤边界。真实 Expo SQLite、实机 fallback、语义质量、跨设备 freshness 与生产权限审计仍保持未验证，不能将该修正理解为 SVC-10 发布完成。

### SVC-08 离线城市地址纵向补充

在公共地址服务被出口策略阻断、且尚未配置获批自托管 provider 的情况下，继续验证已有的显式离线城市级 fallback。使用真实 `reverse_geocoder` GeoNames 索引和隔离 FastAPI ASGI，深圳坐标 `22.543095,114.057865` 的 `/ready` 在无外部 provider 时正常返回 `200`，`/reverse` 返回“广东省深圳市（城市级估计）”，明确标注 `provider=offline-city`、`granularity=city`、`confidence=low`；同坐标第二次请求命中缓存，未知请求字段被 `422` 拒绝。报告 `tools/service-quality-evidence/svc08/svc08-offline-city-runtime-r1.json` 共 `8/8` 通过。

这只证明离线城市级候选、缓存和 ASGI 请求边界，不代表街道/楼栋精度、真实手机定位采样、生产自托管 provider、隐私 SLA 或部署回滚；移动端仍需由显式配置开启，不能把低置信城市估计展示成精确地址，`promotion_eligible=false` 保持不变。

### SVC-10 真实 Expo SQLite 快照纵向补充

模拟器 `emulator-5560` 当前安装的 Preview 应用确实已经产生真实会议数据库，而不是只有合同夹具。以 root 只读方式复制 `files/SQLite/laoji-meeting-memory.db` 及其 WAL/SHM 到本机临时目录，再由 SQLite backup API 创建一次性副本；原数据库没有写入、没有删除，也没有改变应用状态。快照为 schema `user_version=37`，包含 3 场实际会议、300 条转写片段、3 个录音资产、3 条待办、1 条摘要段落、1 个问答线程和历史同步冲突记录；抓取时 FTS 投影尚未建立（行数为 0），符合当前按 scope 懒重建的实现。

新增 `tools/service-quality-evidence/svc10/run_real_app_db_search_runtime.py`，在该副本上复用当前 `sqliteMeetingNoteRepository` 的标题、手写笔记、活动转写、摘要、待办和标签 FTS 投影，随后用仅存在于副本的合成删除行和另一 scope 行验证过滤栅栏。当前报告 `tools/service-quality-evidence/svc10/svc10-real-app-db-search-runtime-r1.json` 为 `9/9`：快照完整性、schema/表结构、JSON1/FTS5、真实标题索引、真实转写索引、真实笔记索引、删除与跨 scope 不泄漏，以及重建后真实会议仍可命中均通过。报告只保存数据库/源代码哈希、计数和布尔结果，不保存会议正文、人名或音频内容。

这把 SVC-10 从“纯合成 SQLite 运行合同”提升到“真实 Expo 数据库快照的隔离查询证据”，但仍不等于物理手机迁移写入、iOS parity、语义 Recall@10/NDCG、跨设备 freshness 或生产权限审计；原数据库本身没有被修改，`promotion_eligible=false` 保持不变。后续若需真机结论，必须在用户明确连接且允许读取时重新抓取真实设备数据库，不能用本次模拟器快照代替。

### SVC-00/SVC-03 当前资源选择只读刷新

在 SVC-03 长时候选 soak 运行期间重新执行多 GPU 资源选择合同（`tools/service-quality-evidence/common/resource-adaptive-contract-r3.json`）。当前唯一可见 GPU0 为 RTX 4060 Laptop，约 `5089 MiB` 空闲，compute PID 同时包含模拟器和候选 Qwen/ASGI；选择器完整评估该卡，`candidate/release` 均拒绝共享 GPU，只有 `gpu0_preview/whisper-small` 可作为明确的非 ready 预览选择。报告中的 `model_started=false`、`processes_touched=[]`、`ports_touched=[]` 与 `32/32` 资源合同通过，证明自适应层不会趁资源忙碌时启动或搬动进程。

这只是当前时刻的只读准入快照，显存、PID 和可用档位会随 soak/模拟器变化；它不构成独立 9B 容量、生产调度或模型质量结论，`promotion_eligible=false` 保持不变。

### SVC-03 72 轮候选 soak 收口与 RSS 门禁修正

`run_full_candidate_soak_probe.py --iterations 72` 已完整结束，覆盖约两小时级的 72 轮双路径会话（每轮正常停止、缓存读取、删除，以及不发送停止标记的断线清理）。原始报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-soak-2h-r1.json` 中 72/72 轮业务 checks 全通过、Qwen/ASGI 均以 `-15` 回收、GPU 进程显存增长约 `1.68%`，但 RSS check 被评测器错误标为失败。

复核发现这是门禁计算错误：旧逻辑把整个运行期间的 `max(rss)-min(rss)` 当成增长；模型 warm-up 和 Python allocator 释放使 RSS 从首轮约 `3065.9 MiB` 降到末轮约 `1831.7 MiB`，并非泄漏。已修正探针：RSS/GPU 现在分别记录首末变化、全程峰值偏移和末 10 轮尾部波动；放行条件同时要求首末增长不超过 10% 且尾部跨度不超过 10%，并在停止前/停止后分开记录 RSS，避免把停止前采样标成“停止后”。

基于同一 72 轮原始样本重算的报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-soak-2h-r1-corrected.json`：`all_sessions_passed=true`、`rss_growth_within_10pct=true`、`gpu_growth_within_10pct=true`；RSS 首末变化 `-40.2563%`、末 10 轮跨度 `2.4421%`，GPU 首末变化 `+1.6793%`、末 10 轮跨度 `0%`，所有 iteration checks 无失败，错误日志为 0。该重算没有重新运行或修改任何服务，只修正评测公式，并绑定修正后探针哈希 `0e0c19105fa41267ed62f7a09cf6a46a3ab5a39548df2bcec4f458cee99e6c19`。

这把 SVC-03 的“候选长时资源稳定性”提升为隔离长期证据，但不解除真实多人/噪声声纹 DER/JER 与 FAR/FRR、物理真机录音、生产多 worker、服务器/systemd 重启、OOM 压力和生产部署门禁；`promotion_eligible=false` 保持不变。

### SVC-10 embedding 缓存服务边界补充

复核当前实际后端 `/home/yydd/桌面/light_plan/server-work/summary/backend/app/services/app_meeting_retrieval.py` 时发现，语义源向量缓存键此前只包含模型名、维度和会议证据版本，没有包含 embedding 服务地址。候选或回退 embedding 服务在进程不重启的情况下切换时，旧服务产生的向量可能被错误复用；这会污染语义排序，且无法由会议证据版本本身发现。

已在修改前保存原文件到 `tools/service-quality-evidence/svc10/source-backups/semantic-cache-20260802/app_meeting_retrieval.before-endpoint-scope.py`，并将 `_source_cache_key()` 扩展为包含规范化 `MEETING_QUESTION_EMBEDDING_BASE_URL`、模型、维度和证据指纹。该改动只影响缓存身份，不改变模型、提示词、排序权重或默认 provider；同一端点仍复用源向量，不同端点必须重建。

继续检查源身份时又发现重复 `(kind, source_id)` 会被 `dict(zip(...))` 静默覆盖。当前候选在构建源向量前拒绝重复身份，交由上层保留词法回退，避免引用行被隐式丢弃；本次修改前备份为 `tools/service-quality-evidence/svc10/source-backups/semantic-cache-20260802/app_meeting_retrieval.before-duplicate-source-r1.py`。

新增 `tools/service-quality-evidence/svc10/run_semantic_cache_scope_contract.py`，从当前实际源码加载模块，用不联网的确定性 embedding 注入函数切换两个 loopback 地址，验证缓存键变化、源向量重建、重复源 fail-closed、分数有限且没有 provider 请求。报告 `tools/service-quality-evidence/svc10/svc10-semantic-cache-scope-contract-r1.json` 为 `7/7`，当前源码 SHA-256 为 `53ed4c642d8ff0f1c8efe45a1d4c33ea1ac09c57a451f05331af50832a571d57`，本次修改前备份 SHA-256 为 `9cfc483c70edbdb03d05b6ec1e2b08f649c38b8ff9fbf8f659ad87bb359f0f54`；更早的 endpoint scope 前原文件仍保留在上述备份目录。

该切片只收口进程内缓存的 provider 身份边界，不证明真实 embedding 质量、provider 可用性、Redis/多 worker 共享缓存、部署切换或生产检索 Recall/NDCG；`promotion_eligible=false` 保持不变。

### SVC-09 媒体片段 stale attempt 磁盘清理补充

继续审计媒体片段恢复路径时发现，旧 worker 超时或崩溃后，`recover_stale_media_clip_job()` 原本只把数据库任务从 `running` 重置为 `queued`，不会删除旧 attempt 产生的 `{job}.attempt-{n}.wav` 与 `.wav.part`。每次恢复都可能留下一个无人拥有的派生文件，长时间运行会造成媒体存储泄漏；若直接删除整个任务目录，又可能误删并发中的其他 attempt，因此清理必须按任务 ID 和具体 attempt 精确限定。

候选现新增 `_remove_media_clip_attempt_files()`，只删除当前过期 attempt 的 WAV 和 partial 文件。恢复流程在写入 `queued` 前执行清理；清理抛出 `OSError` 时以 `media_clip_stale_attempt_cleanup_failed` fail-closed，不推进数据库状态，避免在文件仍残留时重复入队。下一次正常 claim 仍递增 attempt，迟到 worker 不能借旧文件覆盖新结果；删除媒体片段的既有路径仍会扫描 canonical、partial 和所有 attempt 派生文件。

修改前源码已分别备份在 `tools/service-quality-evidence/svc09/source-backups/media-clip-stale-20260802/`；本轮为防止 stale 旧对象覆盖新 attempt，又将 overlay/r7 当前版本备份到 `tools/service-quality-evidence/svc09/source-backups/media-clip-stale-race-20260802/`。当前修复后 overlay 与完整 r7 源码哈希分别为 `414500b35061ad1a7d680db03bfdae5ed85009105a30f31ece76fe383bcda81f` 和 `a8f04c3d6abdbdbd6f3362e1d1229e2ec30fc22ed913e6039aaf078ee74923d7`；row-lock 修改前 r7 备份哈希为 `7ccacd6be8668fac23fca636ee751a4d8aaf34c0903f7338418e5efcc31d7888`。静态合同 `tools/service-quality-evidence/svc09/svc09-media-clip-stale-cleanup-contract-r1.json` 与 `svc09-media-clip-stale-cleanup-r7-contract-r1.json` 已刷新为 `8/8`，新增“恢复前先锁定再读取任务状态”检查。

在完整 r7 验证根使用真实 SQLAlchemy/aiosqlite 和临时存储运行 `run_media_clip_stale_recovery_runtime.py`，当前报告 `tools/service-quality-evidence/svc09/svc09-media-clip-stale-recovery-runtime-r2.json` 为 `9/9`；同一 r7 源码在一次性 PostgreSQL 16/asyncpg loopback 容器中的报告 `tools/service-quality-evidence/svc09/svc09-media-clip-stale-recovery-postgresql-r2.json` 也为 `9/9`。两者均验证过期 running 任务变为 queued、attempt 计数保留为 `3`、进度重置、对应 `.wav/.part` 删除、attempt-2 保留和数据库 revision 正确提交。

并发审计先用两个 spawn worker 复现了旧实现的危险窗口：两个 worker 都能基于同一 stale 快照重新入队；随后新增 `run_media_clip_stale_recovery_postgresql_ordered_race.py`，让第一个 worker 恢复并领取 attempt-4 后再放行第二个 stale worker。当前报告 `tools/service-quality-evidence/svc09/svc09-media-clip-stale-recovery-postgresql-ordered-race-r2.json` 为 `7/7`：第二个 worker 读取到 `running/revision=4/attempt=4`，不再回退状态，最终状态保持 running。修复采用 PostgreSQL 行锁和 SQLite no-op UPDATE 写锁，在读取恢复决策前建立同一数据库栅栏；这只收口状态回退竞态，queued 任务的重复唤醒仍由 worker claim 条件保护。

随后以同一 r7 源码运行真实 ffmpeg/ffprobe 纵向，报告 `tools/service-quality-evidence/svc09/svc09-media-clip-ffmpeg-runtime-r3.json` 为 `8/8`：生成含视频轨和 AAC 音轨的 45 秒 MP4，导出请求区间 `[2000, 32000]` 为 30 秒 `pcm_s16le`、单声道、16 kHz WAV，数据库持久化文件大小/SHA-256，删除后派生文件消失。

当前 r7 候选的录音资产/租约聚焦回归为 `35 passed / 3 skipped`；跳过项是未注入 PostgreSQL DSN 的通用 pytest Gate，独立 PostgreSQL runner 已覆盖本轮 stale 恢复和有序竞态。两个候选源码与全部 runner 均通过 `py_compile`，`git diff --check` 无输出。

上述证据覆盖候选源码、一次性 SQLite/aiosqlite、一次性 PostgreSQL 16/asyncpg、临时本地目录和合成媒体任务；PostgreSQL 容器均为 loopback-only、tmpfs 且已确认清理。它仍不证明生产对象存储权限、生产 PostgreSQL 配置下的多 host worker、ffmpeg 长视频/超时/磁盘写满、服务器重启、systemd、GPU/ASR 或长期 soak。所有报告的 `promotion_eligible=false` 必须保留，不能据此发布或宣称生产泄漏已彻底解决。

### SVC-03 上下文词表 WebSocket 纵向刷新

在 GPU0 仅运行一次性候选进程的前提下，重新执行 `tools/service-quality-evidence/svc03/run_full_candidate_qwen_websocket_context_probe.py --scope`。报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-scope-r3-current.json` 的 `16/16` checks 全部通过：Qwen `/health` ready、服务源码和模型配置身份哈希一致；完整 FastAPI/SQLite WebSocket 走完 `config → stop_acknowledged → transcript.completed → ready_to_stop`，访客 Transcript 缓存后删除；两个认证账号分别只收到自己的 `1` 个和 `3` 个上下文词条，均未共享对方资料。

本次实际模型为隔离 GPU0 `Qwen3-ASR-0.6B`，provider `server_sha256=f857c806506dc2d5479424b313a9a36740af3db769e2cfff66df726a3795740b`，模型配置哈希为 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`；候选进程、临时端口、SQLite、声纹目录和显存均在探针结束后释放。该证据绑定 `/home/yydd/.codex/tmp/svc09-r6-verify-src`，只证明当前上下文接线、账号作用域和 stop/cache 生命周期，仍不证明完整冻结集零回退、真人多人/噪声 DER/JER/FAR/FRR、Android 真机、生产 ingress、多 worker、OOM、重启或长期 soak，`promotion_eligible=false` 保持不变。

同一 GPU0 provider 进一步重跑 28 条会议冻结 manifest 的纯 HTTP 成对质量诊断，报告 `tools/service-quality-evidence/svc03/svc03-qwen-gpu-quality-context-r5-current.json` 绑定上述 provider 和模型身份。context-off 为 `24/28` exact、关键术语 `82/84`、CER mean `1.365%`、CER p95 `5.409%`、infer p95 `321.35 ms`；受限 context-on 为 `28/28` exact、关键术语 `84/84`、CER mean/p95 `0`、infer p95 `303.65 ms`、客户端 RTT p95 `305.61 ms`。这再次证明受控词表对该冻结集有收益且没有速度倒退，但词条来自每条 fixture 的标注，属于近似 oracle；仍不能外推到无词表真实用户、WebSocket/VAD 切段、多人噪声声纹、Android、OOM、重启或生产发布，报告保持 `promotion_eligible=false`。

本轮重新执行同一 WebSocket/ASGI 纵向时，先误用了 SVC-09 的旧验证快照 `/home/yydd/.codex/tmp/svc09-r7-verify-src`：该快照仍能完成录音和 stop drain，但缺少 `qwen_asr_service/context_policy.py`、`app/api/qwen_context.py` 以及 provider 身份字段，两个账号实际收到的上下文词条数均为 `0`，因此上下文隔离门禁失败。这不是可接受的降级候选，不能因为基础转写成功而隐藏。

已在 `tools/service-quality-evidence/svc03/run_full_candidate_qwen_websocket_context_probe.py` 增加启动前 `svc03-qwen-websocket-context-v1` 源码契约，检查上下文模块、词表头、WebSocket 透传字段、provider 上下文能力和身份门禁标记；缺失时在启动 GPU/ASGI 前立即拒绝。修改前备份位于 `tools/service-quality-evidence/svc03/source-backups/context-scope-20260802/run_full_candidate_qwen_websocket_context_probe.before-preflight.py`。使用已绑定的 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 重跑后，报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-scope-r4-current.json` 的 `16/16` checks 通过：四个候选源文件哈希被记录，provider `context_supported=true`、`identity_pinned=true`，访客链路完成缓存/删除，账号 A/B 分别只携带 `1/3` 条自己的词条且均完成 `ready_to_stop`；provider `f857c806506dc2d5479424b313a9a36740af3db769e2cfff66df726a3795740b` 和模型配置哈希 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c` 保持一致。

同一预检契约下，配置词表的访客 WebSocket 纵向报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-r3-current.json` 也通过全部 `9/9` checks：候选 provider 报告 `configured_context_term_count=2`，最终片段带 `context_term_count=2/context_applied=true`，并按 `stop_acknowledged → transcript.completed → ready_to_stop` 顺序完成缓存和删除。该项只证明受控配置词表确实进入当前候选，不能把固定词条样本解释为真实用户词表质量。

新增静态报告 `tools/service-quality-evidence/svc03/svc03-context-preflight-contract-r1.json`，在不启动模型的前提下验证当前 r6 快照接受、旧 r7 快照拒绝，`3/3` checks 通过；旧快照拒绝原因被完整保留，后续探针不会再以“基础转写成功”掩盖上下文/身份合同缺失。

该修复收口的是“证据不能来自过期源码快照”的工程风险，不代表实时转写已达到发布质量；真人多人/噪声声纹 DER/JER/FAR/FRR、真实手机、完整冻结集 WebSocket 质量、OOM、重启、长期 soak 和生产部署仍未证明，`promotion_eligible=false` 继续保持。

随后使用同一 r6 候选和同一 GPU0 Qwen3-ASR-0.6B 运行完整 28 条会议音频的 WebSocket 长会话，报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-long-session-r10-current.json`。输入总时长 `183.078 s`，实时倍率 `2.0`，正常 stop 生成 `48` 条最终片段且全部进入临时 SQLite 缓存，时间线单调、`stop_acknowledged`/`ready_to_stop` 完成、会议删除成功；随后客户端断线流程发送 `477` 帧，断线后缓存轮询稳定为 `16` 条并完成删除。ASGI/Qwen 健康状态在前后均为 ready，provider 与模型身份仍分别为 `f857c806506dc2d5479424b313a9a36740af3db769e2cfff66df726a3795740b` 和 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`，两个临时进程均以 `-15` 退出。

该结果把长会 stop/cache/disconnect 生命周期从 6 条样本扩展到完整 28 条，但不等于 28 条语义质量通过，也不覆盖真人多人/噪声声纹、真实手机网络、OOM、生产多 worker、服务器重启或长期 soak；`promotion_eligible=false` 保持不变。

为避免沿用旧 r7 soak 的 provider 身份，本轮又以 r6 源码做了 `4` 轮 × `6` 条样本的资源稳定性复核，报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-soak-r6-4x6-current.json`。四轮业务检查全部通过；Qwen/ASGI 合计 RSS 从 `2865.332 MiB` 到 `2930.875 MiB`（末端增长 `2.2874%`，尾部跨度 `2.2874%`），候选 GPU 显存保持 `2358 MiB`（增长 `0%`），临时进程均以 `-15` 退出。该短 soak 只说明当前候选在受限样本下没有明显资源增长，不能替代 2 小时以上长期 soak、OOM/逐出、生产重启或发布门禁，`promotion_eligible=false` 继续保持。

最后在同一 r6 provider 的临时 `28160` loopback 端口重跑完整 `28 × 2 = 56` 条 HTTP 并发请求，报告 `tools/service-quality-evidence/svc03/svc03-qwen-full-concurrency-r7-r6-provider-current.json`。两种模式均 `28/28` 完成且无错误；context-off 为 exact `24/28`、关键术语 `82/84`，context-on 为 exact `28/28`、关键术语 `84/84`，相对 context-off/on 基线均无历史通过项回退。4 worker 下 context-off/context-on 客户端 RTT p95 分别为 `1112.65/1100.10 ms`，队列等待 p95 为 `849.55/847.00 ms`，模型推理 p95 为 `311.55/305.60 ms`；这说明词表不会显著增加当前单推理锁的队列尾延迟，但约 `1.1 s` 的四路尾延迟仍未达到实时多会话验收。候选进程和端口已释放，GPU0 仅恢复为模拟器占用，`promotion_eligible=false` 保持不变。

### SVC-01 本机标题与地点字段丢失收口

继续审阅当前移动端冻结扫描时发现两个可直接影响用户的规则缺陷：

- `在研发楼 A301 会议室安排……` 的地点动作模式没有包含“安排”，导致地点无法识别；通用标记清理随后又把地点前缀和标题一起剥掉，标题变成空字符串；
- 以“讨论/确认”等动作词结尾的正常标题，在后面跟“提前 45 分钟提醒”或“不用提醒”时，说明提取器会把动作词当成说明前缀，造成标题截断。

修改前已备份 `src/services/localScheduleParser.ts` 至 `tools/service-quality-evidence/svc01/source-backups/title-location-20260802/localScheduleParser.before-title-location-fix.ts`。当前候选的修复保持分层顺序不变：位置动作先从原始权威文本中提取并重建标题输入，控制性提醒后缀在说明提取前清除；同时补齐不带标点的 ASR 填充词、`提醒啊`、`不要漏` 和“麻烦记录一下”的规范化。这些规则只影响确定性本机解析，不改变服务端模型合同、原始转写或用户原文。

新增回归合同 `tools/schedule-quality-v3/run_local_parser_contract.js` 的四个边界，当前 `tools/schedule-quality-v3/svc01-local-parser-contract-r7.json` 为 `27/27`：物理地点与标题同时保留、提醒后缀不吞标题动作词、ASR 填充词不进入标题、礼貌性“记录一下”不进入标题。

对冻结 `corpus-v5.jsonl` 的全量本机扫描报告 `tools/schedule-quality-evidence/svc01/svc01-local-parser-frozen-scan-r7.json`：`3200` 条输入中 C0/C1 静默保存风险 `0`；可安全本机完成的 `1214` 条样本关键日期/时间/范围/重复/提醒字段 `1214/1214` exact，标题和地点字段 mismatch 均为 `0`。冻结语料的分类字段仍有 `556` 个 mismatch，主要是生成器将含课程、体检、出行等明显语义的样本统一标为“工作”；本轮没有用硬编码迁就该矛盾，分类仍需独立语义标注和宏平均 F1 证据后再调整。

这次只收口本机字段丢失与 ASR 文本噪声边界，不证明服务端模型质量、多轮澄清、真实手机语音、真实用户影子流量或规则路径 p95；`promotion_eligible=false` 继续保持。

### SVC-07 问答配置惰性加载补充

继续运行问答冻结回归时发现，`app_meeting_question.py` 在进入任何问答分支前都会无条件调用 `_question_model_config()`，而当前候选根没有 `meetingsummary/config.json`。这会把不需要模型的确定性路径（未来安排、项目决定、阈值行动、纠正日期、说话人归属、“我的笔记”等）错误地变成配置文件故障；同时不应通过放入带生产地址的假配置来掩盖真正的模型依赖。

修改前已备份 `app/services/app_meeting_question.py` 至 `tools/service-quality-evidence/svc07/source-backups/lazy-question-config-20260802/app_meeting_question.before-lazy-config.py`；补齐独立问候短路前的版本另存为 `app_meeting_question.before-greeting-lazy-config.py`。当前 `_generate_meeting_question_answer_uncached()` 将模型配置改为函数内惰性加载：规则回答、权限边界、笔记回答、独立问候和其它确定性短路在配置缺失时仍可返回；首次进入真正的 `_generate_general_response()` 模型路径、`_generate_grounded_meeting_answer()` 或统一模型路径时才读取配置；模型路径继续在缺少配置时抛出 `FileNotFoundError`，保持 fail-closed，不改变模型、提示词、缓存键或生产默认配置。

新增 `tools/service-quality-evidence/svc07/run_question_lazy_config_contract.py`，使用真实当前模块和真实缺失配置路径，不启动模型、数据库、ASGI 或生产服务，验证：

- “你好”走独立问候规则，未调用模型；
- “下次复盘什么时候”走未来安排规则，未调用模型；
- “我的笔记提醒了什么”只读授权笔记，未调用模型；
- “谁提到支付回调可能重复执行”走说话人归属规则，未调用模型；
- 普通模型问答在缺少 `config.json` 时仍以预期 `FileNotFoundError` 失败闭环。

报告 `tools/service-quality-evidence/svc07/svc07-question-lazy-config-contract-r1.json` 为 `7/7`，当前问答源码 SHA-256 为 `e9579f470f144e8815630cc8ea96c31bfa988d761cbb020c1dec2061de223d7f`。修复后的聚焦问答回归为 `148 passed in 26.44s`，源码、证据脚本均通过 `py_compile`，`git diff --check` 无输出。

为确认该边界穿过 HTTP 请求解析和异步 worker，而不是只在直接函数调用中成立，新增 `tools/service-quality-evidence/svc07/run_question_lazy_asgi_contract.py`。runner 复制 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 到一次性临时根，覆盖当前问答源码并停用临时副本的 `meetingsummary/config.json`，只挂载真实 `app.api.app_meetings.router` 到最小 FastAPI ASGI 应用。问候和“我的笔记”游客请求共 `5/5` 通过：均返回 `200`、`transient=true`、中文答案和正确引用，`call_ollama` 调用次数为 `0`。报告为 `tools/service-quality-evidence/svc07/svc07-question-lazy-asgi-contract-r1.json`，候选原快照未被修改。

该切片只证明配置读取边界、确定性问答可用性和最小路由 ASGI 接线，不证明真实模型、真实配置、Ollama/embedding、完整数据库持久化、完整 `app.main` 生命周期、多进程、GPU 容量、取消竞态、性能或生产部署；`promotion_eligible=false` 保持不变。部署前仍必须提供受控的真实模型配置，并重新运行真实模型与生产候选证据。

### SVC-03 Qwen provider 有界队列准入补充

上一轮并发诊断已经显示，Qwen provider 的 `INFERENCE_LOCK` 会把所有请求放入无界等待：8 路请求的客户端 RTT p95 约 `2.7–2.9 s`，排队 p95 约 `2.4–2.5 s`。这不仅影响实时尾延迟，也会让持续到达的 VAD 片段占满 `ThreadingHTTPServer` 的线程，最终把上游超时、断线和资源耗尽混在一起。

在备份两份 provider 源码后，当前 staging `/home/yydd/LaoJi/server-staging/qwen3-asr-test/qwen_asr_service/server.py` 与完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src/qwen_asr_service/server.py` 均在原有单推理锁外增加 `BoundedSemaphore` 准入：

- `QWEN_ASR_MAX_QUEUED_REQUESTS` 默认 `2`，限制活动推理之外可等待的请求数，上限 `32`；
- `QWEN_ASR_QUEUE_ADMISSION_TIMEOUT` 默认 `0.05` 秒，超过等待预算不再占用线程；
- 超出容量返回 HTTP `429`、错误码 `qwen_asr_queue_full`、中文提示“实时转写请求过多，请稍后重试”和 `retryable=true`；
- `/health` 公布队列上限和准入等待毫秒数；正常推理、上下文词表、静音门禁、模型输出和原有 `queue_wait_ms` 语义保持不变；
- `finally` 释放准入令牌，模型异常或客户端失败不会永久占用容量。

修改前备份位于 `tools/service-quality-evidence/svc03/source-backups/qwen-queue-admission-20260802/`。新增 `tools/service-quality-evidence/svc03/run_qwen_queue_admission_contract.py`，使用假模型和随机 loopback HTTP 对 staging/完整候选各验证：健康预算字段、活动请求、一个合法等待者、第三个请求 `429`、中文可重试错误、释放后的容量恢复，以及被拒绝请求不进入模型。当前报告 `tools/service-quality-evidence/svc03/svc03-qwen-queue-admission-contract-r1.json` 仍为双源 `14/14`；源码哈希为 staging `be7a16913e0d8ae5a4fb6f5117dab662aa46f90c8dcc0e0834250ce0942aad5f`、完整候选（加入可选 auto 微批后）`aa917f40f32004c8d136a645ee5a72b2fbdaee96df48193f6d49c9cbcafcae1d`。相邻 readiness 合同 `10/10`、文本边界合同 `9/9`，两份源码 `py_compile` 通过。

该切片只证明候选 provider 的并发准入和恢复边界，不证明真实 Qwen 模型吞吐、ASGI/WebSocket 多会话尾延迟已经达标，也不证明生产 systemd、OOM、重启、长期 soak 或部署。默认配置仍未启用任何生产进程，`promotion_eligible=false` 保持不变；正式部署前还需用真实模型重跑 1/2/4/8 路冻结集，并确认客户端对 `429` 的退避/本地录音恢复语义。

### SVC-03 Qwen 429 到本地录音恢复的错误接线补充

继续沿着上一节的 `qwen_asr_queue_full` 检查客户端链路时发现，两个 Qwen WebSocket 适配器原本把 provider 的所有 HTTP 错误都压成同一条“Qwen3-ASR 转写失败，请重试”，丢失过载码和可重试属性。虽然 Android 原生录音已经会把任意 server error 标记为可恢复并继续保存本地 PCM，但客户端无法区分“队列暂满”与不可恢复的模型错误，也无法为后续退避/诊断保留稳定标识。

在备份 `/home/yydd/LaoJi/server-staging/qwen3-asr-test/app/api/qwen_ws.py` 和 `/home/yydd/.codex/tmp/svc09-r6-verify-src/app/api/qwen_ws.py` 后，两个适配器现在解析 provider 的 HTTP 错误响应：`qwen_asr_queue_full` 映射为结构化 WebSocket 事件 `code=qwen_asr_queue_full`、中文提示“实时转写请求过多，请稍后重试”、`retryable=true`；未就绪的 `502/503/504` 映射为可重试的中文“Qwen3-ASR 服务尚未就绪，请稍后重试”；其它错误仍使用稳定的中文通用提示。完整候选的 segment worker 对该可恢复异常不会计入 `worker_failures`，因此最终排空仍可发送 `ready_to_stop`，Android 的 `RecorderEngine.onServerError()` 保留本地录音和转写恢复标记。

新增 `tools/service-quality-evidence/svc03/run_qwen_queue_client_error_contract.py`，对 staging/完整候选各注入 HTTP `429`，验证错误对象的 `code/message/retryable`、WebSocket 事件字段、中文文案以及修改前备份确实没有该接线；双源共 `12/12`。原生恢复合同 `tools/service-quality-evidence/svc03/svc03-recorder-recoverable-error-contract-r1.json` 为 `4/4`，两个适配器源码均通过 `py_compile`，`git diff --check` 无输出。

候选 `tests/test_qwen_realtime_ws.py` 与 `tests/test_qwen_context.py` 在当前临时解释器中收集到 `28 passed`、`6` 项因缺少 `torch` 在导入阶段失败；这不是业务失败，但也不能把该次命令当作完整候选回归。后续必须在包含候选 torch/CAM++ 依赖的锁定解释器中重跑。当前证据仍未证明真实设备 WebSocket、真实 Qwen 429、客户端退避策略、GPU 质量、生产部署或长时 soak，`promotion_eligible=false` 保持不变。

### SVC-03 隔离 Python 3.11 聚焦回归更正

上一节记录的是缺少 `torch` 的临时解释器收集结果，不能作为当前候选的最终回归结论。已在不改动 Conda 环境的前提下使用隔离前缀 `/tmp/laoji-qwen-py311-deps`，并复用 `katacr` Python 3.11.15 中已存在的 `torch 2.2.2+cu121`；`torch.cuda.is_available()` 实测为 `true`。Qwen 模型导入使用 `/tmp/laoji-qwen-test-stubs/qwen_asr` 测试桩，桩在任何权重加载尝试时主动失败，因此本次不会把“依赖可导入”误报成真实模型推理。

当前完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 的 `tests/test_qwen_realtime_ws.py` 与 `tests/test_qwen_context.py` 聚焦回归为 `34 passed / 0 failed / 0 collection errors`，耗时 `1.79 s`；唯一输出是 Starlette 对 `multipart` 导入的弃用警告。Python、依赖版本、测试桩路径、候选源码 SHA-256 和完整命令已固化在 `tools/service-quality-evidence/svc03/svc03-qwen-focused-python311-attestation-r1.json`。

这次更正只解除“当前候选聚焦测试因缺少 torch 无法收集”的环境阻塞，不扩大证据范围：没有加载 Qwen 权重或进行真实推理，没有运行 Android 真机、真实 ASGI/生产服务、多人噪声声纹、429 端到端退避、OOM、服务器重启或长期 soak；`promotion_eligible=false` 继续保持。

### SVC-03 结构化队列过载错误桥接补充

继续检查 `qwen_asr_queue_full` 到移动端的链路时发现，服务端虽然已返回稳定的 `code/retryable`，原生 `AsrProtocol` 却只保留了 `detail`，Android 事件和 TypeScript 错误对象无法区分“可恢复的队列过载”和其它服务错误。当前已在备份优先的候选改动中补齐：

- `AudioProtocol` 的错误事件保留受限的 provider `code`、`retryable` 和中文/服务端 `detail`；错误码只接受长度不超过 64 的字母、数字、下划线、短横线和点，避免把任意服务端文本当作协议字段；
- `RealtimeAsrSocketListener` 传递结构化错误对象，`RecorderEngine` 将 provider 字段写入原生错误事件，同时继续设置 `transcriptRecoveryRequired`，不把一次过载告警变成麦克风失败；
- `NativeRecorderErrorEvent` 与 `realtimeAsr` 错误对象透传 `providerCode/providerRetryable`，为后续可观测性和停止后转写重试保留稳定信息；
- 没有加入自动 WebSocket 重连。当前协议没有会话续传序号，盲目重连会产生重复或乱序片段；队列过载时继续保留本地录音，停止后由已有的录音转写恢复流程重试，直到另有明确的 resume 协议。

源级桥接合同 `tools/service-quality-evidence/svc03/run_qwen_structured_error_bridge_contract.py` 为 `9/9`；在 `emulator-5560` 上运行 `RealtimeAsrSocketFaultInjectionTest` 为 `4/4`，报告与结果 XML 路径记录在 `tools/service-quality-evidence/svc03/svc03-qwen-structured-error-bridge-contract-r1.json`。Android 原生模块在临时设置本机 `/home/yydd/Android/Sdk` 后执行 `:laoji-native-platform:compileDebugKotlin` 和 Android 测试源码编译均成功。为避免把证据/备份源码纳入应用类型检查，`tsconfig.json` 现在排除 `tools`；同时修正 `compactNativeBridgeValue` 的 primitive narrowing。当前完整 `node_modules/.bin/tsc --noEmit --pretty false` 已通过，逐文件语法检查也通过。

这只证明错误元数据的候选接线和本地恢复边界，不证明物理手机收到真实 `429`、真实网络退避、provider 吞吐、WebSocket/VAD 质量、生产部署、OOM、重启或长期 soak；`promotion_eligible=false` 保持不变。

### SVC-03 队列过载中文文案补充

在结构化错误已经到达 TypeScript 后，继续检查最终用户文案发现 `qwen_asr_queue_full` 仍会落入通用“服务暂时不可用”。当前 `src/services/errors.ts` 读取 provider code，并单独映射为：可恢复时提示“实时转写暂时繁忙，录音仍会保存在本机，结束后可继续同步。”；不可恢复时提示“实时转写暂时繁忙，请稍后重试。”。服务端原始 detail 不会覆盖稳定 code，也不会把英文 provider 文本直接展示给用户。

新增源级合同 `tools/service-quality-evidence/svc03/run_qwen_queue_error_copy_contract.py`，报告 `tools/service-quality-evidence/svc03/svc03-qwen-queue-error-copy-contract-r1.json` 为 `5/5`；当前完整 TypeScript `node_modules/.bin/tsc --noEmit --pretty false` 通过。

这只改善可恢复过载的中文可行动提示，不证明真实 provider `429` 已在物理手机上触发，也不改变本地录音保存、停止后重试、生产部署、模型吞吐或长期 soak 结论；`promotion_eligible=false` 保持不变。

### SVC-03 当前完整候选 WebSocket/VAD 纵向刷新

在上一轮 Python 3.11 依赖和 provider 身份门禁收口后，重新使用当前完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src`，临时 GPU0 `Qwen3-ASR-0.6B`、Silero VAD、CAM++、FastAPI、SQLite 和 loopback 端口运行真实 WebSocket。访客短音频报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-r5-current.json` 全部检查通过：Qwen `/health` 与模型身份 ready，事件顺序为 `config → stop_acknowledged → transcript.completed → ready_to_stop`，受限词表 `context_term_count=2/context_applied=true`，转写缓存读取和删除成功，provider `model_infer_ms=852`、`queue_wait_ms=0`。

同一候选使用 `--scope` 重新运行登录账号/访客范围纵向，报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-scope-r5-current.json` 通过全部检查：访客词表为 `0`，认证账号 A/B 只分别携带自己的 `1/3` 条词条，均为 `context_applied=true`，停止、缓存和删除完整。候选启动前的源码预检记录四个当前文件 SHA-256，避免旧快照以“基础转写成功”掩盖上下文缺失。

这次把“真实 WebSocket/VAD/ASGI 端到端接线和账号词表隔离”从旧报告刷新到当前 r6 源码，但样本仍为单条短音频和合成声纹向量；日志中的 `identified=false` 与负 cosine 只证明拒识门禁生效，不能证明真人声纹 DER/JER/FAR/FRR。仍未覆盖完整 28 条 WebSocket 语义冻结集、真人多人噪声、物理真机、生产 ingress、多 worker、OOM、服务器重启和长期 soak，`promotion_eligible=false` 保持不变。

### SVC-03 当前 WebSocket 全量证据口径更正

文档中较早的 `svc03-full-candidate-qwen-context-quality-r2.json`、`svc03-qwen-gpu-quality-context-r4-current.json` 等纯 HTTP 或逐条 fixture-context 报告，context-on 使用的是每条样本自带的标注词表（近似 oracle），因此出现 `28/28` exact 只能证明该受控装配路径，不等同于全局词表或真实用户上下文质量。本轮最新且范围更完整的证据是同一 28 条会议音频、同一 9 秒会议 VAD、完整 ASGI/SQLite/WebSocket 生命周期的 context-off r5 与全局 9 词 context-on r1；两次均 `28/28` 完成、缓存、删除和健康检查通过，但 context-on 仍使 M018/M022 回退，故当前放行口径以 r5/r1 为准，旧报告只保留为历史候选诊断，不得覆盖新的零回退要求。表格中 readiness 证据的规范文件名为 `svc03-qwen-asgi-lazy-readiness-r1.json`。

### SVC-03 真实队列过载与本地恢复收口

本轮首次把有界队列从假模型合同推进到真实 Qwen/ASGI：GPU0 隔离启动当前完整候选 `Qwen3-ASR-0.6B`、Silero/CAM++、FastAPI 和临时 SQLite，provider 配置为最多 1 个等待请求、准入等待 10 ms；3 个并发访客 WebSocket 会话发送同一份真实 16 kHz PCM。报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-queue-overload-r1.json` 中，Qwen 身份/上下文 readiness、ASGI 健康和前后健康均通过；真实 `qwen_asr_queue_full` 错误出现 `2` 次，均带中文“实时转写请求过多，请稍后重试”和 `retryable=true`；另 2 个会话各得到 `2` 条最终转写并缓存，3 个会话均完成 `stop_acknowledged → ready_to_stop`，所有查询和删除均成功。候选进程、临时数据库、GPU0 显存和端口已清理，`promotion_eligible=false`。

这次纵向还暴露出客户端持久化边界的真实缺陷：provider 错误后服务端仍会发送 `ready_to_stop`，旧 `RecorderEngine` 会把会议 journal 写成 `asr_state=READY`，应用重启后的恢复扫描因此看不到这条未完成转写。现已在备份优先后修复：会议存在可恢复服务错误时，ready 只代表本地 WAV 安全结束，journal 保留 `FAILED`；无错误时仍写 `READY`；恢复扫描将 `LOCAL_SAVED + meeting + realtime + FAILED` 作为可恢复记录重新发出。源合同 `6/6` 见 `tools/service-quality-evidence/svc03/svc03-recorder-recoverable-error-contract-r2.json`；Android `assembleDebug` 成功，新增 `RecordingJournalAsrRecoveryTest` 随 connected instrumentation 共 `9` 项完成，其中候选服务参数缺失导致的 2 项按设计跳过。

该修复证明真实 provider 429 能到达候选 WebSocket、不会阻止本地录音结束，并且失败 journal 可在应用重启扫描中恢复；仍未证明物理手机在真实 429 下的 UI/重试体验、停止后自动上传/转写 worker 的真实重试、1/2/4/8 路完整性能阶梯、OOM、生产 systemd/多 worker、服务器重启或长期 soak。客户端没有在缺乏会话续传序号时盲目自动重连，以免制造重复/乱序；正式发布仍需独立的恢复任务端到端证据。

### SVC-03 WebSocket 队列满的会话内有界重试

上一轮真实 1/2/4/8 路矩阵确认了一个比“队列错误能否送到客户端”更具体的质量缺口：完整候选在 4 路丢失 1 个 VAD segment，在 8 路丢失 6 个 segment，其中一个会话甚至没有最终转写。原适配器收到 `qwen_asr_queue_full` 后立即放弃当前 segment；本地录音恢复虽可兜底，但实时结果出现了不必要的缺口。

在修改前分别备份完整候选、summary backend 和 qwen3 staging 的 `app/api/qwen_ws.py` 后，三份适配器现在共用同一条会话内重试规则：

- 只捕获 provider 错误码 `qwen_asr_queue_full` 且 `retryable=true` 的异常；`qwen_asr_not_ready`、PCM 错误、模型输出错误、网络超时等不会被误判为队列满；
- 每个 segment 最多额外尝试 2 次，默认异步退避 `100 ms → 200 ms`，次数和基础延迟可由 `QWEN_ASR_QUEUE_RETRY_ATTEMPTS`、`QWEN_ASR_QUEUE_RETRY_BASE_DELAY_SECONDS` 调整，但源码硬上限分别为 2 次和 1 秒；
- 重试成功后沿用原有文本去重、声纹、缓存和持久化路径，不产生重复 transcript；预算耗尽后只发送一次结构化中文错误，继续结束 worker 和本地录音恢复，不重试其它错误；
- summary backend 同步补齐 `QwenProviderError` 的 HTTP 响应解析，避免其 provider 自动选择路径丢失 `code/retryable`；
- 没有加入 WebSocket 自动重连，原因仍是当前协议没有 segment 序号和 resume 游标，盲目重连会把音频重复提交。

源级合同 `tools/service-quality-evidence/svc03/run_qwen_queue_retry_contract.py` 对三份适配器验证 `24/24`：临时队列错误两次后成功、第三次严格停止、非队列错误只调用一次、退避和硬上限存在，且修改前备份没有重试逻辑。三份源码 `py_compile`、既有 provider 错误桥接合同 `12/12`、Android 结构化错误桥接合同 `10/10`、边界排空合同 `30/30` 均通过。

随后使用真实 Qwen3-ASR-0.6B、Silero VAD、CAM++、完整 ASGI/SQLite、GPU0 和临时 loopback 端口重跑 `1/2/4/8` 矩阵，报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-matrix-r2-queue-retry.json`。结果如下：

| 并发 | r1 队列错误 | r2 队列错误 | 有转写的会话 | 协议/清理 |
| ---: | ---: | ---: | ---: | --- |
| 1 | 0 | 0 | 1/1 | 全部通过 |
| 2 | 0 | 0 | 2/2 | 全部通过 |
| 4 | 1 | 0 | 4/4 | 全部通过 |
| 8 | 6 | 3 | 8/8 | 全部通过 |

这次改动把 8 路的“无任何实时结果会话”消除了，并把 4 路错误降为 0；但 8 路仍有 3 个 segment 在 2 次重试后耗尽，客户端 p95 约 `3.57 s`。因此这只是候选质量改进和本地恢复前的减损，不是多人实时 ASR 放行：当前仍未证明真人多人噪声、长时 soak、OOM、物理真机、生产 ingress、多 worker 或生产部署，`promotion_eligible=false` 继续保持。后续若要继续降低 8 路 segment 丢失，应先用更大容量窗口比较更长退避与 provider 服务能力，不能只无限增加客户端重试。

补充的真实三会话过载报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-queue-overload-r2-queue-retry.json` 仍观察到 1 个受控队列错误、3/3 会话完成查询/删除和 `ready_to_stop`，说明重试没有吞掉过载诊断。当前候选聚焦 pytest 使用可用 venv 运行时为 `31 passed / 3 deselected`；被排除的 3 个旧断言分别固定了 6 秒会议 VAD 和旧重叠去重语义，与当前已存在的 9 秒会议策略/两字符去重规则不一致，不把它们归因于本轮队列重试，也不以旧报告的 `34 passed` 覆盖当前源码。

### SVC-05 qwen3 staging 稳定资料 ID 接线收口

继续对照“登记声纹后会议仍显示为未识别”的链路时，发现 qwen3-asr staging 的 `_identify()` 只返回展示姓名、相似度和 gap，丢弃 CAM++ 匹配结果中的 `top.speaker_id`。后续 `_resolve_cluster_identity()` 只能以姓名作为投票键，姓名修改或同名资料会破坏资料关联，也无法把已登记资料的稳定 ID 写入会议转写。完整候选和 summary backend 已有的稳定 ID 修复不能掩盖 staging 这条仍可能被选中的适配器路径。

修改前备份为 `tools/service-quality-evidence/svc05/source-backups/staging-stable-id-20260802/qwen_ws.py.before-stable-id`。当前 staging 已与其它候选对齐：`_identify()` 保留 `speaker_id`；身份投票、观测次数和展示姓名元数据分别存储；缺少稳定 ID 的匹配 fail-closed；`_resolve_cluster_identity()` 返回 `(identity_id, identity_name, identified, confidence)`；WebSocket 事件和 Transcript 持久化使用 `identity_id`，`speaker_name` 只作为展示字段。staging 聚焦测试的断言同步改为稳定 ID 语义，不再允许姓名充当身份。

源级/行为合同 `tools/service-quality-evidence/svc05/run_stable_speaker_id_contract.py` 已覆盖完整候选、summary backend 和 qwen3 staging，共 `27/27`；三份当前适配器均通过 `py_compile`，并额外验证 `_identify()` 实际返回 `profile-42`。staging 的完整 pytest 在本机没有作为通过证据：该稀疏快照缺少 `app.api.whisper_ws`，且仍有历史 VAD 时长断言；这两个环境/旧合同问题与本次稳定 ID 接线无关，未用补桩或放宽断言掩盖。

该修复只收口资料 ID 到实时转写的候选接线，不证明真人声纹识别质量、跨设备/噪声 DER/JER、FAR/FRR、真实 Android 握手、PostgreSQL 多 worker、迁移或生产部署；`promotion_eligible=false` 保持不变。

### SVC-07 会议主库纳入生产存储门禁

继续审计生产存储边界时发现，`app/main.py` 的会议、转写和整理数据使用主 `DATABASE_URL`，但既有 `production_storage_guard.py` 只检查账号、日程、声纹三个专用 DSN。这样在三个专用库和迁移标记都正确、而会议 `DATABASE_URL` 仍为 SQLite 时，守卫可能错误放行，会议数据会旁路本地文件库。

修改前备份为 `tools/service-quality-evidence/svc07/source-backups/meeting-database-guard-20260802/production_storage_guard.py.before-meeting-dsn`。当前生产守卫把 `DATABASE_URL` 与三类专用 DSN 一并纳入必填和 PostgreSQL 前缀校验；缺失或任一仍为 SQLite 均以稳定中文 `production_storage_not_ready` 拒绝，非 production 仍允许本地/候选运行。迁移状态和批次标识要求保持不变。

新增 `tools/service-quality-evidence/svc07/run_production_storage_guard_contract.py` 的会议库边界用例：本地允许、缺配置拒绝、混用 SQLite 拒绝、迁移标记缺失拒绝、会议 `DATABASE_URL` 为 SQLite 拒绝、四库均为 PostgreSQL 且标记完整才允许，共 `6/6`。当前生产入口/运行时边界报告 `tools/service-quality-evidence/svc07/svc07-production-storage-boundary-contract-r4-meeting-dsn.json` 通过 `12/12`，守卫专项报告为 `tools/service-quality-evidence/svc07/svc07-production-storage-guard-meeting-dsn-contract-r1.json`；守卫与合同均通过 `py_compile`。

这次只消除了会议主库的生产误放行路径，不证明真实凭据、迁移批次、备份/恢复、线上切换、PostgreSQL 多 worker、重启或服务质量；生产仍保持 `promotion_eligible=false` 和 fail-closed。

### SVC-03 队列容量与实时尾延迟对照

为决定是否继续扩大 Qwen provider 的等待容量，使用同一当前完整候选、同一 Qwen3-ASR-0.6B、GPU0 和同一 `meeting_001.wav`，只把 `QWEN_ASR_MAX_QUEUED_REQUESTS` 从默认 `2` 提到 `8`，运行一次性 8 路真实 FastAPI/WebSocket 会话。报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-8q-r1.json`：8/8 会话均有两条转写、缓存查询/删除、`ready_to_stop` 和清理通过，队列错误为 `0`；但客户端 elapsed p95 为 `4461 ms`，provider total p95 为 `1081 ms`，明显超过 SVC-03 的 4 路 p95 `1.2 s` 门槛。

该对照说明“把等待队列无限放大”只能把显式过载变成更长的实时延迟，不能作为默认修复。当前默认容量和两次有界重试保持不变，队列满仍交给本地录音恢复；后续只有在更大的独立模型资源窗口中验证微批/并发调度后，才重新评估容量。该实验没有修改生产配置、没有触碰 GPU1，`promotion_eligible=false` 保持不变。

### SVC-03 完整候选自适应请求微批补充

独立微批实验已证明 0.6B 模型在 4 路批量推理下可将固定 56 请求总时长由约 `17.918 s` 降到 `6.963 s`，且批量结果与串行结果的规范化文本 `56/56` 一致；此前该调度器只存在于隔离实验副本，完整候选仍只有单请求锁。本轮在备份 `/home/yydd/.codex/tmp/svc03-auto-batch-backup-20260802/` 后，把已通过合同的 `qwen_microbatch.py`、`qwen_microbatch_adapter.py` 和有界 shutdown 接线装入完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src/qwen_asr_service/`。

新增显式 `QWEN_ASR_REQUEST_BATCH_SIZE=auto`：模型加载完成后读取实际 `torch.cuda.mem_get_info()`，默认空闲显存阈值为 3072 MiB 选批 2、6144 MiB 选批 4，低于阈值或 CPU 自动回到 1；默认环境值仍为 `1`，不会改变现有单请求路径。`/health` 公开实际模式、批大小、显存快照、阈值和队列配置；批量队列满、超时和关闭分别返回稳定中文错误，SIGTERM 先停止接收并在退出时关闭 batcher。批量请求仍按音频、上下文和语言位置对齐，旧 HTTP/WebSocket schema 不变。

证据：`tools/service-quality-evidence/svc03/run_qwen_auto_batch_contract.py`、`tools/service-quality-evidence/svc03/svc03-qwen-auto-batch-contract-r1.json`。静态合同 `8/8`、显存模拟 `3/3`、独立微批单测 `14/14`、完整候选队列准入 `14/14`、当前聚焦 WebSocket/context 回归 `34/34` 通过；真实 GPU0 provider 加载后观测空闲显存 `5642.4 MiB`，自动选择批大小 `2`，4 路 HTTP 全部 `200`、正文非空、timing 字段齐全，随后 SIGTERM 排空并释放端口/显存。当前源码哈希为 `aa917f40f32004c8d136a645ee5a72b2fbdaee96df48193f6d49c9cbcafcae1d`，微批依赖 `qwen_microbatch.py`/`qwen_microbatch_adapter.py` 哈希已同时写入报告。

这只是候选自适应调度能力，`promotion_eligible=false` 不变：尚未证明真实 ASGI/WebSocket 1/2/4/8 路完整冻结集、不同驱动/显存碎片下的 OOM 余量、生产多 worker、物理真机、服务器重启和两小时 soak；因此不启用默认批量，也不修改 8030/18020 或生产配置。

### SVC-03 自适应请求微批 WebSocket 质量与并发对照刷新

在同一当前 r6 候选、同一 GPU0 `Qwen3-ASR-0.6B`、同一 28 条会议冻结集和同一 `realtime_factor=4.0` 下，先以显式 `QWEN_ASR_REQUEST_BATCH_SIZE=1` 运行完整 FastAPI/SQLite/WebSocket/VAD 基线，报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-r6-current.json`。28/28 会话均完成 `config → stop_acknowledged → transcript.completed → ready_to_stop`，缓存条数与最终片段一致、删除成功、前后健康通过；无词表规范化 exact `21/28`、关键术语 `80/84`、CER mean `1.2593%`、CER p95 `6.0069%`，provider segment tail p95 `374.65 ms`。provider health 明确为 `request_microbatch_mode=1`、`request_microbatch_enabled=false`。

随后只把 provider 环境值改为显式 `QWEN_ASR_REQUEST_BATCH_SIZE=auto`，运行完全相同的 28 条 WebSocket/VAD 冻结集，报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-auto-r1-current.json`。实际加载后显存快照为 `5601.8125 MiB`，按阈值选择批大小 `2`，健康、身份、`quality_profile=full` 和生命周期检查全部通过；28/28、exact `21/28`、关键术语 `80/84`、CER mean/p95 与单请求基线完全相同。逐条比较的规范化文本、生命周期结果没有差异，说明当前 auto 接线没有造成语义回退；但该探针按会话顺序发送，不能把它解释为真实批量吞吐收益。两份报告均保持 `promotion_eligible=false`。

为观察真正的 WebSocket 多会话行为，又用同一 `meeting_001.wav` 和同一候选分别运行 1/2/4 路并发阶梯，实时倍率仍为 `4.0`。single 报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-matrix-single-r1-current.json`，auto 报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-matrix-auto-r1-current.json`；两份报告的每一档均为所有会话有转写、`ready_to_stop`、缓存查询和清理通过，队列错误与非预期错误均为 `0`。对照如下，provider 数值是该档所有会话的 `provider_total_ms` p95/max：

| 并发 | single 客户端 elapsed p95/max | auto 客户端 elapsed p95/max | single provider p95/max | auto provider p95/max |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 2351/2351 ms | 2505/2505 ms | 776/776 ms | 958/958 ms |
| 2 | 2628/2642 ms | 2684/2689 ms | 536/550 ms | 510/510 ms |
| 4 | 3232/3253 ms | 3199/3237 ms | 765/784 ms | 986/1022 ms |

该阶梯只证明 auto 微批在真实 ASGI/WebSocket/VAD 链路上可以安全启动并保持协议、缓存和清理；速度并非稳定单向改善，当前 provider 的单推理锁、12 ms 微批窗口、短音频和一次性 GPU0 状态都会影响结果。不能以这两份矩阵宣称实时多用户 SLO 达标，仍需更大独立容量下的 1/2/4/8 路重复测量、批大小实际占用统计、OOM/显存碎片、真人多人噪声质量、物理真机、生产多 worker、重启和长期 soak；默认值仍保持单请求，候选未部署。

### SVC-01 完整候选确定性解析器回归收口

继续验证日程解析候选时，直接在完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 的锁定 Python 3.11 解释器中运行四组现有回归：`test_schedule_service_quality_candidate.py`、`test_schedule_recurrence.py`、`test_schedule_event_commands.py` 和 `test_schedule_event_edits.py`。第一次不设置数据库环境时，测试在收集阶段因 `DATABASE_URL` 为空被 SQLAlchemy 拒绝；这不是解析器失败，也不能用补桩掩盖。按候选 local 运行约定补上一次性 SQLite 和临时路径后，最终结果为 `42 passed / 0 failed / 0 collection errors`，耗时 `1.01 s`，未启动模型、未发网络请求。证据及候选/测试文件哈希见 `tools/service-quality-evidence/svc01/svc01-candidate-parser-regression-r1.json`。

这只证明当前确定性规则、重复事件、事件命令和编辑边界在完整候选解释器中可收集并运行，不等同于 qwen3.5 真实模型字段质量、服务端 ASGI/认证、真实语音、客户端展示、影子流量或生产部署；`promotion_eligible=false` 保持不变。后续 SVC-01 仍需把真实模型调用放入独立 holdout，校验字段 exact、澄清率、置信校准和 p95，并与移动端结果做端到端对照。

### SVC-03 自适应微批真实占用可观测性收口

在上一轮只证明“auto 能安全启动”的基础上，本轮继续核对完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src/qwen_asr_service/server.py` 的运行时证据。源码先以备份优先方式保留，当前哈希为 `eca6a7f681ee8a87264fd57e56df2bc4044e67eb4da4d63d11ac8b6e1175ad90`；`py_compile`、静态合同 `9/9` 和显存选择模拟 `3/3` 均通过。`QWEN_ASR_REQUEST_BATCH_SIZE=auto` 仍只在显式启用时生效，加载模型后依据实际 `torch.cuda.mem_get_info()` 选择批大小，容量不足或 CPU 回退到 `1`，默认环境值不变。

在 GPU0 隔离运行的真实 HTTP 并发探针中，Qwen3-ASR-0.6B 健康状态为 ready、身份 pin 通过，实际空闲显存 `5581.625 MiB`，auto 选择批大小 `2`；4 路请求全部 `200` 且正文非空，`accepted=4`、`completed=4`、`timed_out=0`、`batch_count=2`、`batch_sizes=[2,2]`、最大队列等待约 `1173.794 ms`。这证明 `/health` 暴露的不是配置假象，而是运行后真实批次占用快照。对应证据为 `tools/service-quality-evidence/svc03/svc03-qwen-auto-batch-contract-r2-static.json` 和 `tools/service-quality-evidence/svc03/svc03-qwen-auto-batch-contract-r2-live.json`。

同一源码随后在完整 FastAPI/SQLite/WebSocket/VAD 28 条冻结集上刷新，所有会话均完成转写、缓存查询、删除和 `ready_to_stop`，无 provider/协议错误；规范化 exact `21/28`、关键术语召回 `80/84`、CER mean `1.2593%`、CER p95 `6.0069%`。该报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-auto-r2-observability-current.json`。这些结果确认 auto 接线和真实批次统计可用，但不能解释为实时多用户吞吐或模型质量达标：短样本、单机 GPU0、当前微批窗口和单推理资源条件仍可能掩盖尾延迟、OOM、显存碎片和长会话问题。

候选进程、临时端口和显存已释放；当前 GPU0 仅有模拟器约 `198 MiB` 占用，生产 `8001/8081` 进程未触碰。`promotion_eligible=false` 保持不变，默认仍为单请求。剩余门禁仍包括更大独立容量下的 1/2/4/8 路重复测量、真实 qwen3.5 holdout、真人多人噪声与 DER/JER/FAR/FRR、物理真机、OOM/显存碎片、生产多 worker、重启恢复和长期 soak。

### SVC-03 auto 微批 8 路 WebSocket 纵向

在真实 4 路 HTTP 批次占用证据之后，又用同一当前完整候选、GPU0、Qwen3-ASR-0.6B、`QWEN_ASR_REQUEST_BATCH_SIZE=auto` 和 `QWEN_ASR_MAX_QUEUED_REQUESTS=2` 运行 8 路完整 WebSocket/SQLite 会话。provider 启动时身份 pin、上下文能力和 auto 选择均通过，实际选择批大小 `2`；8/8 会话均有两条最终转写、`stop_acknowledged`/`ready_to_stop`、缓存查询和删除，队列错误 `0`、非预期错误 `0`，网关前后健康均通过。报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-8-auto-r1-current.json`。

该阶梯的客户端 elapsed p50/p95/max 为 `3739/4490/4490 ms`，provider total p50/p95/max 为 `1114/1349/1391 ms`。因此它证明高并发下当前候选协议和资源清理没有失控，但没有证明 8 路实时 SLO；长尾仍明显高于交互目标，且本报告只保留启动前 health 快照，不能把 auto 选择等同于每一条 WebSocket 都发生了有效批量占用。`promotion_eligible=false` 保持不变，仍需在独立资源窗口重复 1/2/4/8 路、记录运行后 batch snapshot，并补充 OOM、长会话、真人噪声、物理真机、生产多 worker、重启和 soak。

### SVC-01 服务端候选安全回退修复

### SVC-09 删除保护表迁移与 ASGI 崩溃接管收口

上一轮真实 PostgreSQL/ASGI 接管探针暴露了两个测试与候选边界问题：探针把 `meeting_001.wav` 的期望文本错误写死为另一条音频内容，并在复用数据库时复用固定幂等键；同时首个认证请求在候选 PostgreSQL 中查询 `laoji_user_deletion_tombstones` 时出现 `UndefinedTable`。前两项已在备份 `tools/service-quality-evidence/svc09/source-backups/restart-probe-expected-text-20260802/` 后修正为显式 `--expected-text` 和每次运行唯一 `run_id`，旧失败报告保留为诊断，不计入通过。

当前完整候选新增 `alembic/versions/20260802_svc09_deletion_tombstones.py`：生产迁移显式创建会议/账号删除保护表、用户操作 ID 和索引；`app.main` 的 local 启动在业务表之后确保同一保护 schema；PostgreSQL 守卫在表缺失时 fail-closed，不再把缺表当成“没有删除状态”。第一次在空 PostgreSQL 上执行时发现 revision 名称超过 Alembic 默认 `VARCHAR(32)`，已在备份后缩短为 `20260802_svc09_tombstones`。修改前的 `account_deletion_service.py`、`app/main.py` 和迁移基线已备份至 `tools/service-quality-evidence/svc09/source-backups/tombstone-schema-20260802/`。源级合同 `tools/service-quality-evidence/svc09/svc09-tombstone-schema-contract-r2.json` 为 `8/8`，账户删除/鉴权聚焦回归为 `8 passed`。

全新 PostgreSQL 16 空库执行候选 `alembic upgrade head` 后，Alembic 版本为 `20260802_svc09_tombstones`，两张保护表、`operation_id` 字段和会议删除索引均真实存在，runtime 合同 `5/5` 通过。证据为 `tools/service-quality-evidence/svc09/svc09-tombstone-alembic-runtime-r2.json`。这项证据覆盖迁移本身，不等于生产数据库已执行该 revision。

在一次性 PostgreSQL 16、隔离全音频网关、真实 GPU0 Qwen3-ASR-0.6B 和当前完整 ASGI 候选上重跑崩溃接管：首进程已领取 attempt 1 并绑定稳定 provider task ID，随后 `SIGKILL`；替代进程接管过期租约，attempt 增至 2，复用同一 provider task，最终任务/会议/录音资产/Transcript 全部收敛，provider 实际只调用一次。探针同时强制 Qwen 服务端和 ASGI 适配器校验源码/模型 config SHA-256，身份检查与其它 16 项检查全部通过，共 `18/18`；迁移表真实存在，修复后运行窗口没有新的 `UndefinedTable` 日志。权威证据为 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-asgi-restart-r8-identity-current.json` 和 `tools/service-quality-evidence/svc09/run_real_qwen_gateway_asgi_restart_probe.py`。

这把候选级 PostgreSQL 租约接管和删除保护推进到可重复证据，但不等于生产 Alembic 已执行、生产 ingress/systemd/服务器重启、备份恢复、跨 worker 长时 soak 或真实长音频质量已通过；发布仍需在目标数据库执行该迁移并核对迁移批次，`promotion_eligible=false` 保持不变。

### SVC-05 CAM++ 当前闭集诊断刷新

使用当前 `qwen-asr-default` 源码和本地 CAM++/Silero 权重，在 GPU0 隔离刷新泄漏安全的三种合成 TTS 音色留出集合。模型初始化约 `738.214 ms`，embedding p95 `84.575 ms`，支持模型就绪，GPU0 探针结束后空闲显存约 `7095.812 MiB`。报告为 `tools/service-quality-evidence/svc05/svc05-camplus-closed-set-eval-r3-current.json`。

候选 `cosine=0.70`、`gap=0.08` 在干净样本上已知 44/44 正确、已知 FRR `0`、未知 FAR `0`；SNR20 已知 FRR `4.55%`，SNR10 为 `0`，但 SNR0 已知 FRR `68.18%`；0.8 秒短片段已知 FRR `50%`，1.2 秒短片段为 `4.55%`，未知样本在这些受控条件下仍全部拒识。结果说明阈值和“至少足够长、质量合格的片段”门禁能压住合成闭集误认，但提高阈值会直接牺牲短片段/噪声下的召回，不能把该集合外推为真人质量。

本轮明确记录 `DER/JER/FAR/FRR` 的正式多人指标仍未运行：素材没有逐帧多人参考标注，且全部为合成 TTS，不代表真人口音、相似声线、跨设备/跨天、重叠发言或物理真机。当前结论是保留候选拒识与音频质量门禁，不调整生产阈值、不启用声纹自动确认；下一步应先取得有授权的真人多说话人标注，再联合优化 VAD、片段最短时长、阈值和拒识提示。`promotion_eligible=false` 保持不变。

对 `corpus-v5` 做一次当前源码复核时，发现旧的服务端安全报告不能继续沿用：当前 parser `78c47d4533804d28f363ec2250dd902b9050cb8e5044cafd79cf456406674506` 在 819 条安全相关样本中有 `92` 个违规，其中 `84` 个不确定地点在模型返回空结果后落入确定性 quick fallback 并变成可保存草稿，另外 `8` 个“不要真的创建，只是在测试日期识别”返回了非空但不可保存的对象。旧报告的零违规结论因此只适用于旧源码，不代表当前候选。

已在备份 `tools/service-quality-evidence/svc01/source-backups/uncertain-location-safety-20260802/schedule_parser_service.before-uncertain-location-safety.py` 后做最小修复：quick fallback 同样执行不确定地点门禁，返回 `needs_clarification=true` 和中文“地点还不确定，需要确认最终地点。”；非日程控制正则覆盖不带“日程”的“不要真的创建”，避免测试/示例文字生成草稿。由于完整候选规范把未定地点定义为“可展示但不可保存的澄清草稿”，服务端 17 项合同中的该用例同步从 `null` 更新为澄清对象，修改前脚本另有备份。

修复后同一 `corpus-v5` `3200/3200` 扫描完成，安全相关 `819` 条、违规 `0`；更新后的服务端候选合同 `17/17`，staging parser 的 `backend/tests/test_schedule_parser_quality.py` 为 `60 passed / 0 failed`（新增两条回归覆盖上述缺陷），parser `py_compile` 通过。证据为 `tools/service-quality-evidence/svc01/svc01-server-candidate-safety-fix-r1.json`、`tools/schedule-quality-v3/svc01-server-candidate-frozen-safety-r3.json` 和 `tools/schedule-quality-v3/svc01-server-candidate-contract-r3.json`。本轮仍使用 stubbed LLM，未启动模型或网络服务，不证明真实 qwen3.5 质量、字段 exact、ASGI/认证、真实语音、p95 或生产部署；`promotion_eligible=false` 保持不变。

### SVC-03 当前候选 Qwen 客户端准入闸门

继续处理真实 8 路 WebSocket 的队列缺口时，先做了两个不改源码的对照：把会话内队列重试从 2 次提高到 3 次，结果仍有 `8` 个 `qwen_asr_queue_full`、只有 `6/8` 会话有转写；把两次重试的基础退避提高到 `250 ms`，结果为 `4` 个队列错误、客户端 p95 约 `4.68 s`。这两组结果说明继续增加重试预算或等待时间不能稳定解决 provider fan-in，且会放大尾延迟，报告分别为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-8-r3-retry3-current.json` 和 `svc03-full-candidate-qwen-websocket-concurrency-8-r4-delay025-current.json`，只作否定性诊断。

在备份 `/home/yydd/.codex/tmp/svc09-r6-verify-src/backups/client-admission-20260802/` 后，当前完整候选 `app/api/qwen_ws.py` 增加进程内 provider 客户端准入闸门：

- `QWEN_ASR_CLIENT_MAX_IN_FLIGHT` 取值硬限制为 `0..8`，默认 `2`；`0` 只保留给受控诊断，不作为发布配置；
- 同一 ASGI 事件循环共享一个 `asyncio.Semaphore`，用弱引用按事件循环隔离，避免测试/重启后复用已绑定的 loop；
- semaphore 获取和释放覆盖整个阻塞式 HTTP 请求，使用 `finally` 释放，协程取消不会永久占用槽位；
- 闸门只限制客户端 fan-in，不改变 provider 的队列、模型锁、重试次数或移动端协议；多进程部署必须按 worker 数重新计算总并发，不能把单进程结果外推到生产。

源级/假 provider 合同 `tools/service-quality-evidence/svc03/svc03-qwen-client-admission-contract-r1.json` 为 `5/5`，包含 5 个并发调用最多同时执行 2 个、所有调用完成、硬上限和取消安全释放检查；当前候选 `test_qwen_realtime_ws.py` 与 `test_qwen_context.py` 为 `35 passed`。真实 GPU0 `Qwen3-ASR-0.6B`、完整 FastAPI/SQLite/WebSocket/VAD 的 8 路重跑报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-8-client-gate-r2-current.json` 记录了实际环境参数：client gate `2`、provider queue `2`、重试 `2` 次、退避 `100 ms`；8/8 会话均有两条转写、缓存/删除/ready 生命周期完整、队列错误 `0`。重复运行的客户端 p95 约 `4.67 s` 和 `8.67 s`，显示资源/调度波动明显；gate=3 的对照也为零队列错误但 p95 约 `6.47 s`，因此当前保留默认 gate=2 作为候选可靠性策略，不宣称实时 SLO 达标。

该切片把“provider 429 导致实时片段丢失”转化为可控的客户端背压，但没有解除 SVC-03 发布门禁：尚未证明多 ASGI worker 总容量、1/2/4/8 路重复性能、真实多人噪声质量、OOM、物理设备、服务器重启或长期 soak；生产仍未启用该环境变量，`promotion_eligible=false` 保持不变。

### SVC-03 GPU0 真实 Qwen 1/2/4/8 路阶梯复核

在确认 GPU0 仅有模拟器占用后，使用隔离完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src`、真实 `Qwen3-ASR-0.6B`、临时 FastAPI/SQLite 和 loopback 端口，以 `QWEN_ASR_CLIENT_MAX_IN_FLIGHT=2` 重跑 1/2/4/8 路 WebSocket 阶梯。报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-concurrency-matrix-r4-gate2-current.json`：四个阶梯共 15 个会话全部拿到转写、`stop_acknowledged -> ready_to_stop` 顺序正确、缓存与删除清理完整、队列错误和非预期错误均为 `0`，provider p95 分别为 `414.2/410.14/459.38/808.71 ms`，客户端阶梯 p95 分别为 `2.20/2.44/2.85/4.46 s`，最大单会话约 `4.58 s`；前后健康状态均正常，模型身份和上下文能力均通过。

该复核只证明当前单进程候选在 GPU0、单一 7.4 秒音频重复输入下的协议/准入/资源清理和尾延迟诊断；它不证明真实多人噪声质量、不同音频长度、跨 ASGI worker 总容量、OOM、物理手机、服务器重启或长期 soak，也不能替代生产 SLO。`promotion_eligible=false` 保持不变。

### SVC-03 当前 gate=2 context-off 28 条冻结语义复核

同一候选、同一 GPU0 隔离窗口再跑 28 条冻结会议语音（不发送参考词表，manifest 文本只作评测基准），报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-r6-gate2-context-off-current.json` 为 `28/28` 完成并通过完整生命周期检查：无 provider/协议错误，缓存、删除和 `ready_to_stop` 均通过；规范化 exact `21/28`，CER mean `1.2593%`、p95 `6.0069%`，关键术语召回 `80/84=95.24%`，provider segment p50/p95/max 为 `205.5/294.95/477 ms`，整组耗时约 `52.96 s`。

该结果只刷新当前候选的固定语料 context-off 基线，仍有 7 条未达到规范化 exact，不能解释为真实用户质量；真人口音/噪声、多说话人 DER/JER/FAR/FRR、物理真机、长会议、OOM、重启和生产部署仍未证明，`promotion_eligible=false` 保持不变。

并发证据工具随后收口了参数溯源：`run_full_candidate_qwen_websocket_concurrency_matrix_probe.py` 现在先将 `QWEN_ASR_CLIENT_MAX_IN_FLIGHT` 解析并限制到 `0..8`（默认 `2`），同一值同时注入候选 ASGI 和写入报告；默认值单路 smoke 已确认报告为 `2`，工具 `py_compile` 与 `3/3` instrumentation contract 通过。该修复只提高证据可复现性，不改变生产配置。

### SVC-06 短文本“唯一待办”覆盖修复

旧的真实模型候选烟测曾暴露一个用户可见错误：转写明确说“先取消王莉旧任务，最终确认唯一待办是赵明提交新版风险清单”，但模型返回旧行动项或空行动项时，短文本后处理只在存在 `[seg:...]` canonical 标记时回退，导致已取消任务可能保留，最终待办可能丢失。该失败保留在历史报告 `tools/service-quality-evidence/svc06/guest-summary-real-model-smoke-r2.json`，没有被改写为通过。

当前 r6/r7 候选 `app/workers/summary_tasks.py` 已做最小收口：

- 短文本最终待办提取允许受限的无标记转写，但仍必须匹配“最终/正式 + 待办/行动项/任务/安排”的明确句式；
- 当句式包含“唯一/只有一项/仅有一项”时，将其视为来源事实的排他性更正，覆盖模型旧行动项，不再保留已取消事项；
- 负责人、中文绝对日期和原句 `source_quote` 仍由转写确定性提取，结构化候选必须通过 canonical segment 引用解析；
- 没有排他性最终标记时不覆盖已有模型行动项，避免普通“最终还有一个事项”误删其他事实。

证据：r6/r7 `tools/service-quality-evidence/svc06/svc06-final-action-extraction-contract-r1*.json` 均 `5/5`；两套候选摘要聚焦回归均 `36 passed`。r7 陈旧的 compact-summary 测试夹具也已改为当前 `OllamaConfig`、`num_ctx=8192`、`temperature=0` 和 `max_tokens=1024` 契约，前版本备份位于 `tools/service-quality-evidence/svc06/source-backups/final-action-plain-20260802/`。

该切片证明短文本确定性后处理和引用边界，不证明真实 9B 输出覆盖率、长会议事实图、行动项 F1、生产 ASGI/多 worker 或模型性能；真实模型烟测仍需在独立容量窗口重跑，`promotion_eligible=false` 保持不变。

### SVC-09 当前 r6 候选多进程 provider 重试修复

复核当前完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 的 PostgreSQL `spawn` 纵向时，旧报告 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-postgresql-spawn-r2-current.json` 的 4 个失败项已定位为候选实现缺口，而不是数据库 claim 竞争：两轮竞争均恰好一个进程领取租约，但显式重试清空 `provider_task_id` 后没有推进提交代数，第二轮仍使用 `submission_key=<job>:0`，隔离网关按幂等语义复用了第一次失败结果。该报告保留为失败诊断，不再与 r7 的历史通过结果混用。

修改前已备份到 `tools/service-quality-evidence/svc09/source-backups/provider-generation-20260802/`。当前 r6 候选补齐以下闭环：

- `MeetingRecordingTranscriptionJobV2.provider_submission_generation` 持久化为 `NOT NULL DEFAULT 0`，claim 和 worker 将其透传到网关提交键；
- 显式重试在清空旧 provider task 时原子递增 generation，保证每一代重试使用新的稳定提交身份；
- SQLite 旧表 helper 在启动时补列；新增 Alembic revision `20260802_svc09_provider_gen`，接在 `20260802_svc09_tombstones` 之后，已有 PostgreSQL 行默认从 0 开始；
- worker 同时透传录音时长，保持网关的时长边界合同不被多进程路径丢失。

修复后使用全新 PostgreSQL 16 loopback 容器、真实 GPU0 Qwen3-ASR-0.6B、真实隔离全音频网关和两个独立 `multiprocessing.spawn` worker 重跑同一探针，报告 `tools/service-quality-evidence/svc09/svc09-real-qwen-gateway-worker-postgresql-spawn-r3-current.json` 为 `16/16`：两轮 queued/重试竞争均恰好一个赢家；第一次真实 provider 调用后注入故障，第二代提交再次调用 provider，provider invocation `2`；最终 job `completed/attempt=2`、Transcript 恰好一条、会议回到 `ended`、资产 revision `2`、无 `.part` 或 attempt 残片。Qwen/网关均以 `SIGTERM` 退出，GPU0 已释放。

新增迁移运行脚本 `tools/service-quality-evidence/svc09/run_provider_generation_alembic_runtime.py`，在同一临时 PostgreSQL 上先模拟缺列，再从 tombstone 基线升级并重复执行，报告 `tools/service-quality-evidence/svc09/svc09-provider-generation-alembic-runtime-r1.json` 为 `6/6`：head 为 `20260802_svc09_provider_gen`、字段非空、默认 0、既有行无非零代数、第二次升级幂等。候选 `test_transcription_job_atomicity.py` 与 `test_transcription_service_review.py` 共 `45 passed / 3 skipped`；SQLite 旧表补列检查通过。

该修复只解除当前 r6 候选的 provider 重试代数缺口，不等于生产数据库已执行新 revision，也不证明生产 ASGI 多 worker、真实长音频/视频质量、生产网关、systemd/服务器重启、OOM、长期 soak、物理设备或发布资格。`promotion_eligible=false` 继续保持；生产切换前必须在目标 PostgreSQL 备份后执行该 revision，并重新做真实多 worker 和重启恢复验收。

### SVC-10 已删除待办的搜索索引边界

继续按会议详情的用户可见状态审查本机全文索引时发现，待办编辑中的“删除”并不是物理删除，而是把 `action_items.status` 置为 `dismissed`；会议待办面板会过滤掉这类行，但搜索索引生成 SQL 原先只过滤会议 `lifecycle`，仍会把已删除待办写入 `meeting_search_fts`。用户搜索该文本后会得到一条来源为“待办”的结果，打开会议却看不到对应待办，属于明显的结果与页面状态不一致。

修改前先将以下源码保留到可回溯备份：

- `tools/service-quality-evidence/svc10/source-backups/dismissed-action-20260802/sqliteMeetingNoteRepository.before-dismissed-action-filter.ts`
- `tools/service-quality-evidence/svc10/source-backups/dismissed-action-20260802/run_real_app_db_search_runtime.before-dismissed-action-filter.py`

当前索引生成在 `action_items` 投影中增加 `action.status <> 'dismissed'`，仍保留 scope、会议生命周期和非空内容过滤；待办恢复为 `pending` 后，下一次 repository 通知会使索引代数失效并重新出现。修复不改变待办本身的同步、恢复和冲突逻辑，也不删除 canonical 数据。

证据：

- `tools/service-quality-evidence/svc10/svc10-search-filter-contract-r1.json`：源级过滤合同 `19/19`；
- `tools/service-quality-evidence/svc10/svc10-real-app-db-search-runtime-r2-dismissed-action.json`：从 `emulator-5560` 只读备份的真实 Expo SQLite 数据库副本，schema 37、3 条真实待办；在副本中将一条真实待办转为 `dismissed` 后重建索引，`10/10` 通过，已删除待办未命中，标题/转写/笔记索引、跨 scope 与已删除会议隔离仍通过。

该切片只证明本机 SQLite 索引的删除状态边界和真实模拟器数据库运行，不证明物理手机/iOS parity、远端搜索、跨设备 freshness、语义 Recall@10/NDCG、生产数据库性能或权限审计；没有修改生产服务，`promotion_eligible=false` 保持不变。

### SVC-10 embedding 维度一致性门禁

继续检查 semantic retrieval 的异常 provider 回退时发现，`semantic_source_scores` 原先直接使用 `zip(query_vector, source_vector)` 做点积，没有验证两边长度。embedding 服务或回退模型返回不同维度时，超出较短向量的部分会被静默丢弃，仍生成看似正常的分数，可能把错误的 semantic 排名带入会议问答，而不是触发既有的词法回退。

修改前复现：同一请求让来源向量返回 2 维、查询向量返回 1 维，旧实现返回 `1.0` 的语义分数。修改前源码已备份到 `tools/service-quality-evidence/svc10/source-backups/embedding-dimension-20260802/app_meeting_retrieval.before-dimension-fence.py`。当前实现要求：

- 查询向量和所有来源向量非空；
- 生产 provider 返回的查询维度必须等于 `MEETING_QUESTION_EMBEDDING_DIMENSIONS`；
- 每个来源向量必须与查询向量维度完全一致；
- 任一检查失败沿用 semantic retrieval 的 fail-open 约定，返回空 semantic 分数，让 lexical path 继续回答，不改变客户端协议。

证据为 `tools/service-quality-evidence/svc10/svc10-semantic-dimension-contract-r1.json`，无网络确定性合同 `3/3`：错维度来源/查询 fail-closed、provider 维度与配置不符 fail-closed、匹配维度仍返回正常分数。既有 semantic 缓存端点/重复来源合同 `7/7` 仍通过；候选后端混合检索聚焦回归为 `56 passed`。

该切片只收口 embedding provider 的输入形状错误，不证明真实模型语义 Recall@10/NDCG、真实用户数据、跨 worker 缓存失效、provider 版本切换、生产性能或发布资格；没有触碰生产服务，`promotion_eligible=false` 保持不变。

### SVC-10 跨会议混合搜索候选纵向接线

本轮把原先仅存在于本机 SQLite 的会议搜索扩展为一个候选级、只读的跨会议接口：完整候选 `/home/yydd/.codex/tmp/svc09-r7-verify-src` 及其 `server-work/summary/backend` 覆盖新增 `GET /api/laoji/v1/meeting-search`，查询先按认证用户、会议状态和已删除 `MeetingNoteRootV2` 过滤，再从标题/元数据、标签、文字记录、我的笔记、整理结果和未删除待办构造来源。关键词排名与已有 embedding semantic rank 使用 RRF 合并；embedding 不可用时只返回关键词结果，不阻断搜索。服务端返回来源类型、会议标识、片段位置、摘要、记录/更新时间和排序序号，不生成替代检索事实的摘要。

客户端新增 `src/data/api/v2/meetingSearch.ts` 协议解析，并在 `MeetingsStore` 中将认证用户的远端候选结果与本机 FTS 去重合并；未登录、远端错误、旧服务未部署或本机索引失败时均保留已有列表/元数据回退。`meetingCrossMeetingSearchV1` 默认关闭，只有服务端候选完成部署和权限审计后才允许打开。候选源码修改前备份在 `tools/source-backups/cross-meeting-search-20260802/`。

隔离合同 `tools/service-quality-evidence/svc10/svc10-cross-meeting-search-contract-r1.json` 为 `9/9`：语义改写命中、账号作用域隔离、已删除会议隔离、已删除待办不返回、待办仍可检索、日期过滤、语义故障关键词回退和数量上限均通过；当前候选 `tests/test_meeting_question_hybrid_retrieval.py` 回归为 `38 passed`，TypeScript 与候选 Python 语法检查通过。该合同使用临时 SQLite 和确定性 embedding stub，不是匿名真实会议 Recall@10/NDCG，也没有接入生产数据库、真实 embedding 服务、跨设备 freshness 或权限审计，`promotion_eligible=false` 保持不变。后续必须在真实候选数据库上完成跨账号审计、真实 semantic Recall@10/NDCG、索引增量 freshness 和规模性能后，才可考虑发布。

### SVC-10 远端过滤协议与零分语义边界补充

继续对照本机 `meetingSearchQuery` 发现，上一版远端候选没有透传 `tag:`、人物、日期和 `source:` 过滤；同时 semantic provider 返回全零分数时，候选会把零分来源错误地当成命中。现已修复：客户端先复用同一搜索解析器，将内容词、标签、人物、日期和来源分别编码到远端查询；服务端先按用户、删除状态、标签、人物和日期过滤，再对内容做 hybrid ranking；过滤条件没有内容词时作为浏览查询返回过滤后的来源；semantic rank 只接受有限且严格大于零的分数，零/负分回到关键词路径。

合同已扩展为 `tools/service-quality-evidence/svc10/svc10-cross-meeting-search-contract-r1.json` `12/12`：账号/删除/待办隔离、标签过滤、人物过滤、来源过滤、日期过滤、过滤-only 浏览、语义改写和关键词降级均通过；当前 `tests/test_meeting_question_hybrid_retrieval.py` 仍为 `38 passed`。这仍是临时 SQLite + 确定性 embedding 候选合同，未证明真实匿名会议 semantic Recall@10/NDCG、真实服务端权限审计、跨设备 freshness 或生产性能，`promotion_eligible=false` 保持不变。

### SVC-10 10,000 场会议搜索缓存规模基准与 overlay 同步

在完成过滤协议修复后，对当前候选 `/home/yydd/.codex/tmp/svc09-r7-verify-src` 做了隔离规模基准：10,000 场会议、20,000 条文字记录/待办内容源、单用户 1,500 次关键词查询；语义路径刻意关闭，只测内容投影缓存和 revision 失效策略。报告 `tools/service-quality-evidence/svc10/svc10-cross-meeting-search-scale-benchmark-r1.json` 记录构建耗时 `0.7451 s`，查询 p50/p95/p99/max 为 `138.0839/171.5994/202.1767/578.4065 ms`，全部结果均受 `limit=10` 约束，`p95 <= 300 ms` 与 `p99 <= 600 ms` 均通过。

候选缓存以用户 scope、所有可搜索投影的 count/max revision、来源/标签/人物/日期过滤和 30 秒上限组成键，最多保留 32 个条目；revision 变化或测试重置会失效。复核发现部署 overlay 仍是未缓存旧版本，现已将 `server-work/summary/backend/app/services/app_meeting_search.py` 补齐到与候选逐字一致，未覆盖 overlay 其余 SVC-09 变更；候选与 overlay 均已 `py_compile`。

该基准只证明候选 SQLite 关键词路径达到规模延迟门槛，不证明真实 embedding 的 Recall@10/NDCG、真实 PostgreSQL 查询计划/多 worker 吞吐、跨账号权限审计或跨设备 freshness；语义路径和生产部署仍未完成，`promotion_eligible=false` 保持不变。

### SVC-08 反向地理编码损坏响应收口

继续审计位置服务时发现，`tools/reverse-geocoder-proxy/server.py` 对外部 provider 的 HTTP 200 只检查网络状态，不检查正文是否能归一化为地址。provider 返回结构损坏或空对象时，旧逻辑会缓存 `None` 并返回 HTTP 200 空地址；移动端虽可能继续坐标兜底，但代理本身会产生假成功，且同一坐标在缓存 TTL 内持续命中空结果。

修改前源码已备份到 `tools/service-quality-evidence/svc08/source-backups/malformed-response-20260802/`。当前逻辑在外部 provider 返回不可用正文且未启用离线城市兜底时，以稳定中文 `502 地址服务返回了无效结果` 失败，不写入空缓存；启用离线城市兜底时，仍转入显式 `offline-city`、`city`、`low` confidence 结果。可选 `reverse_geocoder` 导入发生 ABI/数据加载异常时也按未就绪处理，`/health`/`/ready` 不再因导入异常直接变成 500。移动端原有坐标兜底和系统反向地理编码顺序不变。

证据：

- `tools/service-quality-evidence/svc08/svc08-malformed-response-contract-r1.json`：损坏正文返回 502、错误不泄漏 provider 内容、重复请求不复用空缓存、缓存条目保持 0，共 `5/5`；只使用 stubbed ASGI provider；
- `tools/reverse-geocoder-proxy/test_server.py`：当前代理回归 `14 passed`；
- `tools/service-quality-evidence/svc08/svc08-offline-city-runtime-r1.json`：真实 `reverse_geocoder 1.5.1` 的离线城市模式通过 `4/4`，深圳坐标返回“广东省深圳市（城市级估计）”；
- `tools/service-quality-evidence/svc08/svc08-reverse-geocoder-contract-r3.json`：移动端 HTTP 适配器合同仍 `13/13`。

该切片只收口 provider 正文错误和空缓存边界，不证明街道/楼栋精度、真实物理设备地址成功率、公共或获批外部 provider 可用性、生产代理部署、隐私 SLA 或回滚；离线城市结果必须继续标为低置信城市估计，`promotion_eligible=false` 保持不变。

### SVC-00 broker 有界优雅排空候选

复核 `tools/ollama-priority-broker/broker.py` 时发现，原有 `BrokerServer.close()` 会在收到停止信号后立即取消所有 queued/running job。这样已开始的问答、日程解析或整理会被截断，和 SVC-00 要求的 graceful drain、重启期间不重复/不丢失边界不一致。修改前源码已备份到 `tools/service-quality-evidence/svc00/source-backups/graceful-drain-20260802/`。

当前候选新增 `PriorityScheduler.drain(timeout=...)` 与 `BrokerServer.drain(timeout=...)`：

- 先关闭监听器并将 broker 标记为 stopping/draining，拒绝新接入；
- queued job 立即以稳定的 `broker_stopped` 完成，连接层返回 HTTP 499，且不接触上游；
- running job 在有限窗口内继续使用原连接，窗口内完成则保留上游响应；
- 超时后通过现有取消栅栏和上游 socket close 取消运行中 job，仍明确这是 best-effort，不宣称 Ollama 已停止 GPU 计算；
- 命令行 SIGINT/SIGTERM 使用默认 5 秒 drain，Python API 可由 owned service unit 传入更小或更大的窗口；原 `close()` 保留为立即停止 API。

隔离合同 `tools/service-quality-evidence/svc00/svc00-broker-graceful-drain-contract-r1.json` 为 `8/8`：排队请求返回 499 且没有上游记录、窗口内运行请求返回 200、drain 状态可观测、超时后运行请求返回 499 且取消计数正确；只使用临时 loopback fake upstream。broker 回归由 21 条扩展为 `23/23`，readiness 合同仍为 `7/7`，queue-deadline 合同仍为 `8/8`，相关源码 `py_compile` 通过。

该候选只证明 broker 生命周期和 admission 行为，不证明 Ollama 生成完成、GPU 工作确实停止、持久任务恢复幂等、systemd/容器编排或生产重启；没有接触 `18020/18035/21434/21436`、GPU1 或生产配置。优雅排空尚未部署，`promotion_eligible=false` 保持不变。

### SVC-07 语义检索剩余预算贯通与候选漂移修复

复核问答截止合同时发现，SVC-07 问答服务会从 `_question_semantic_scores()` 向 `semantic_source_scores()` 传入 `embed_timeout`，但旧的 SVC-07 冻结候选检索模块没有该参数，导致候选运行时每次都以 `TypeError` 退出语义路径并静默回退到词法检索。该边界不会必然让接口报错，却会降低同义表达、省略主语和跨段问题的召回，且与“单轮剩余预算覆盖模型、恢复和 embedding”合同不一致。

权威服务源码已具备超时参数贯通、provider 端点参与缓存身份和 embedding 维度 fail-closed；本轮保留旧候选到 `tools/service-quality-evidence/svc07/source-backups/candidate-sync-20260802/app_meeting_retrieval.before-sync.py`，再将 `/home/yydd/.codex/tmp/svc07-r9-verify-src` 的检索模块同步到权威版本。新增合同 `tools/service-quality-evidence/svc07/svc07-question-semantic-deadline-contract-r1.json` 为 `6/6`：候选与权威源码哈希一致、检索签名接受 `embed_timeout`、问答包装器传递剩余预算、来源向量和查询向量均收到同一预算、匹配维度返回分数、错维度 fail-closed。合同只使用确定性进程内 embedding stub，未运行真实模型、GPU、ASGI 或生产端口。

该切片只消除候选源码漂移并证明语义请求的参数边界，不证明真实 embedding 的延迟、Recall@10/NDCG、GPU 容量、多 worker 缓存一致性或 SVC-07 发布资格；`promotion_eligible=false` 保持不变。

### SVC-03 Qwen 片段重试总预算收口

复核实时转写的队列重试时发现，旧合同只限制重试次数，却没有限制单个 VAD 片段的总耗时。每次重试都重新使用完整的 `QWEN_ASR_REQUEST_TIMEOUT_SECONDS`（默认 60 秒），在两次队列拒绝时最坏可占用约三个请求窗口，超过 WebSocket 的最终排空边界；同时旧合同提取器没有装配 full candidate 已使用的 `_qwen_transcribe_once`，重跑当前源码会直接 `NameError`，旧 `24/24` 报告不能继续作为当前证据。

本轮先备份三份适配器到 `tools/service-quality-evidence/svc03/source-backups/queue-retry-deadline-20260802/`，再同步修改：

- 每个片段建立一个总 deadline，默认预算仍等于原请求超时，不改变正常单次请求的默认行为；full candidate 的客户端 semaphore 等待也纳入该预算；
- 每次 provider 调用收到 deadline 的剩余秒数，指数退避也被剩余预算截断；预算耗尽返回稳定中文 `qwen_asr_timeout`，不继续盲目重试；
- full candidate、summary backend 和 qwen3 staging 三份源码保持同一语义；旧的无参数调用仍兼容；
- 合同提取器现在同时装配 `_qwen_transcribe_once`、`time` 和 semaphore stub，避免测试工具与实际源码脱节。

当前 `tools/service-quality-evidence/svc03/svc03-qwen-queue-retry-contract-r1.json` 为 `42/42`：三份源码均通过“重试成功、次数封顶、非队列错误不重试、同一总 deadline、剩余 timeout 透传、退避不延长预算和稳定超时码”；full candidate 额外证明 semaphore 等待也受该 deadline 约束。三份源码和合同工具 `py_compile` 通过。候选 Qwen 单元回归收集到 `29 passed`；另外 `6` 条在临时解释器缺少 `torch` 时无法导入模型管理器，未被计入通过，也未被归因于本轮改动。

该切片只证明候选级重试时间边界和工具与源码一致，不证明真实 Qwen 超时行为、GPU 压力、多人/噪声质量、Android、生产 ASGI、重启或 soak；`promotion_eligible=false` 保持不变。

### SVC-03 全局词表显式开启与作用域收口

继续审计 Qwen 上下文词表时确认：移动端当前没有按会议标题或任意上下文注入词表的协议字段，适配器能接收的合法来源只有显式配置词表和当前认证用户的讲话人资料。旧实现只要进程环境存在 `QWEN_ASR_DOMAIN_TERMS` 就会将其合并到所有会话；这会让一个全局词表跨访客、账号和会议生效，也会使 context-on 的固定语料结果掩盖真实用户上下文尚未接线的事实。

修改前已备份到 `tools/service-quality-evidence/svc03/source-backups/global-glossary-opt-in-20260802/`。当前两份 Qwen provider、三份 WebSocket 适配器和语义候选均采用同一策略：

- 新增 `QWEN_ASR_DOMAIN_TERMS_ENABLED`，缺失或为 `0` 时全局词表强制为空；只有显式 `1/true/yes/on` 才解析 `QWEN_ASR_DOMAIN_TERMS`；
- 请求级 `X-Laoji-ASR-Terms-B64` 和认证用户讲话人资料不受该开关影响，仍按当前会话/用户作用域合并；会议标题、历史转写和测试答案不能借此进入上下文；
- provider `/health` 增加 `configured_context_enabled`，继续报告实际 `configured_context_term_count`，便于运行时审计而不泄漏词条；
- context-on 证据工具显式设置开关，context-off、恢复、并发和 soak 工具显式关闭开关；运行时恢复环境模板默认 `QWEN_ASR_DOMAIN_TERMS_ENABLED=0` 且词表为空。

合同 `tools/service-quality-evidence/svc03/svc03-qwen-global-glossary-opt-in-contract-r1.json` 为 `25/25`：三份适配器在缺省/显式关闭时均不读全局词表，显式开启时只读受限配置；两份 provider policy 在相同边界下通过；请求级用户词条仍可独立合并；两份 provider 源码均暴露健康状态；恢复环境默认关闭。语义候选聚焦回归为 `10/10`，相关脚本 `py_compile` 通过。

由于 provider 源码身份已变化，按当前 staging 文件重新计算 `QWEN_ASR_EXPECTED_SERVER_SHA256=4feb48591219586d381f64c7fba0ac9471923485830956d516d8fb8e6bb84e64`；运行时 pin 合同刷新为 `14/14`。该 pin 只对应隔离 staging 候选，不能被解释为远端生产源码或部署成功。

该切片只证明全局词表不会无意跨会话泄漏，并修正了证据工具的上下文开关口径；没有新增按会议注入词表的移动协议，也没有证明真实 28 条语音、负向词表、真人多人噪声、真实物理设备或发布质量。显式开启的全局词表仍需独立 holdout、跨会话负向控制和无历史通过项回退验证；`promotion_eligible=false` 保持不变。

### SVC-03 新作用域源码的真实 28 条纵向复核

为避免只凭静态合同判断开关接线，本轮在 GPU0 临时端口、当前完整候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src`、本地 `Qwen3-ASR-0.6B`、临时 FastAPI/SQLite 和同一 `meeting-asr-voice-samples/manifest.json` 上各运行一次完整 28 条 WebSocket/VAD 会话。两次均使用新 provider SHA-256 `f5ed84f0f676e73a4392c19f25a06136ee337144af7de193da6a42a00e28df7d`、模型配置 SHA-256 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`，临时进程结束后 GPU0 恢复为模拟器约 `328 MiB` 占用，未触碰生产端口。

- context-off 报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-global-opt-in-context-off-r1.json`：健康 `configured_context_enabled=false/configured_context_term_count=0`，网关未发送词表；28/28 完成、缓存、删除和 `ready_to_stop` 全部通过，无协议/服务错误；规范化 exact `20/28`、CER mean `1.371%`、p95 `6.007%`、关键术语 `79/84=94.05%`，provider segment p95 `298.95 ms`。
- context-on 报告 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-global-opt-in-context-on-r1.json`：健康明确 `configured_context_enabled=true/configured_context_term_count=9`，网关发送的就是显式受控 9 词；28/28 生命周期通过；规范化 exact `24/28`、CER mean `0.505%`、p95 `3.528%`、关键术语 `81/84=96.43%`，provider segment p95 `304.30 ms`。

这组结果只证明新开关能在真实完整候选中关闭/开启并保持协议生命周期；context-on 仍是固定语料受控词表诊断，不能当作真实用户 holdout，也不能抵消 context-off 的 4/28 语义失败、跨会话负向控制、真人多人噪声、物理真机、OOM、重启、长期 soak 和生产部署缺口。`promotion_eligible=false` 保持不变。

随后使用同一新源码运行账号/访客作用域纵向 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-context-scope-global-opt-in-r1.json`。provider 健康保持 `configured_context_enabled=false/configured_context_term_count=0`；访客不携带词条，账号 A 只携带自己的 `1` 条讲话人资料词条，账号 B 只携带自己的 `3` 条资料词条，三条会话均完成 `config → stop_acknowledged → transcript.completed → ready_to_stop`、缓存和删除。报告 checks 为全通过，且 provider 日志只观察到预期的单次上下文标记；这证明显式关闭全局词表后，用户作用域词条仍可用，但不替代真实注册资料、跨设备或多人声纹质量门槛。

### SVC-04 兼容回退导入触发补充

继续复核“本机导入后没有转写”的客户端时序，确认缺口不只在 canonical 新建分支：当 canonical 写入开关关闭时，兼容回退会先将 `Meeting + audioLocalUri` 写入旧 Store，再直接返回，之前没有进入 `MeetingTranscriptCompletionProvider`。本轮在 `persistMeetingsStrict(next)` 成功、旧列表更新并完成可选 read-cutover 后，给非访客作用域补发同一个 `requestImportedMeetingTranscriptDiscovery(scope)`；访客仍被触发器守卫明确抑制。

合同 `tools/service-quality-evidence/svc04/svc04-import-transcript-trigger-contract-r1.json` 已按当前源码刷新为 `10/10`，新增检查回退持久化之后的触发顺序。TypeScript、`git diff --check` 均通过。该修复不绕过账号根/上传开关，也不把没有 `remoteId` 的本机记录伪装成云端会议；只有后续根同步或上传对账提供远端身份后，录音资产发现器才会创建远端转写任务。合同和当前 staging 仍未证明真实用户视频上传、物理真机路径或生产数据库并发，`promotion_eligible=false` 保持不变。

当前源码已用 `ANDROID_HOME=/home/yydd/Android/Sdk ./gradlew assemblePreview --parallel --max-workers=16` 成功构建（`627` tasks，`versionCode=106`，APK SHA-256 `0775625ee8e2ac695cdf8707decdd0cbda0ab255c07337dbf98c192605f0cb6f`）。构建前一个等价包曾在 `emulator-5560` 完成覆盖安装和冷启动；最终重建后的安装阶段模拟器进程已退出、ADB 无设备，因此不能把最终包写成已安装或真机验证。

### SVC-05 独立留出集复核

使用当前 `server-staging/qwen-asr-default`、真实 Silero VAD/CAM++ 中文权重和 GPU0 隔离运行 `tools/service-quality-evidence/svc05/run_campplus_closed_set_eval.py`，生成 `tools/service-quality-evidence/svc05/svc05-camplus-closed-set-eval-r4-current.json`。三折 leave-one-voice-out、每个已登记音色只使用前两条干净样本登记，其余样本全部作为 holdout；噪声和短片段变体也只从 holdout 生成，避免登记/评测泄漏。运行共提取 `168` 个 192 维 embedding，`required_models_ready=true`、`speaker_features_ready=true`，embedding p50/p95 为 `21.585/68.13 ms`。

候选 `cosine=0.70/gap=0.08` 下，干净、20 dB、10 dB 的未知音色 FAR 均为 `0/28`；0 dB 已登记人 FRR 为 `30/44=68.18%`，0.8 秒短片段 FRR 为 `22/44=50%`，1.2 秒短片段 FRR 为 `2/44=4.55%`。这支持当前“低质量片段保持 unknown，不强行显示姓名”的产品边界，但全部素材仍为三种合成 TTS 音色，不能替代真人多人 DER/JER、相似声线 FAR/FRR、跨设备/跨天和物理真机门禁；不调整生产阈值，`promotion_eligible=false` 保持不变。

同一 staging 实现又通过 `tools/service-quality-evidence/svc05/svc05-real-speaker-engine-smoke-r2.json` 的真实 GPU0 CAM++ smoke：支持模型就绪、192 维 embedding，临时资料首个合格片段保持 unknown，第二个合格片段返回稳定 profile ID 与展示姓名，未登记音色的余弦约 `0.394` 仍被拒识。该 smoke 只证明当前实时适配器的决策辅助函数接线和拒识边界，未覆盖真人资料、多人重叠、噪声/跨天 DER/JER/FAR/FRR、Android 真机或生产部署。

### SVC-05 默认 Qwen 适配器稳定身份接线修复

继续按“展示姓名不能承担持久身份”审查未纳入既有合同的默认 Qwen staging 路径时，发现 `server-staging/qwen-asr-default/app/api/qwen_ws.py` 的 `_identify()` 只返回 `name/cos/gap`，实时处理又把 `identity_name` 写入 `speaker_id`。这条路径会在改名、同名资料或旧会议重匹配时丢失声纹资料稳定 ID；现有完整候选和 qwen3 staging 的稳定 ID证据不能覆盖该独立源。

修改前先备份到 `server-staging/qwen-asr-default/source-backups/stable-speaker-id-20260802/qwen_ws.py.before-stable-id`，再同步以下边界：

- `_identify()` 保留 `top.speaker_id`，资料稳定 ID 与展示姓名分开传递；
- 投票、观测次数和展示元数据分别按稳定 ID、计数和姓名保存；缺少稳定 ID 或姓名时 fail-closed；
- `_resolve_cluster_identity()` 返回 `(identity_id, identity_name, identified, confidence)`，WebSocket 事件和 Transcript 持久化只在确认时写稳定 ID，未确认时继续使用临时 cluster 标签；
- 不改变阈值、默认开关或生产端口，未把该路径宣称为部署完成。

证据：

- `tools/service-quality-evidence/svc05/svc05-default-stable-speaker-id-contract-r1.json`：当前源哈希 `f32201b3ede566f32aadf96c1439a7482e564f194d20984c083f4a076112b943`，备份哈希 `a2d7f07cd27ecf7964f03ca8be8e019cd0f4c52b15d5349d5b91ef4518e93cd5`，确定性源级检查 `7/7`；
- `server-staging/qwen-asr-default/tests/test_stable_speaker_identity.py`：helper 回归 `3/3`；`app/api/qwen_ws.py` 与测试文件 `py_compile` 通过。

该切片只收口默认 Qwen 源的稳定身份接线，不证明真实 CAM++ 质量、真人多人 DER/JER、相似声线 FAR/FRR、跨设备/跨天、Android 真机、PostgreSQL 多 worker、重启或生产部署；`promotion_eligible=false` 保持不变。

### SVC-05 r7 实时候选稳定身份补齐

矩阵复核发现当前 `/home/yydd/.codex/tmp/svc09-r7-verify-src` 虽已让 `_identify()` 返回 `speaker_id`，但 `_resolve_cluster_identity()` 仍按姓名投票，最终 `speaker_id` 仍写成展示姓名；SVC-03 的多条 r7 实时探针默认引用该目录，继续使用会使稳定 ID 修复只在其他源生效。历史 r4/r10 临时快照保持原样，不再改写或当作当前结论。

修改前备份到 `/home/yydd/.codex/tmp/svc09-r7-verify-src/backups/stable-speaker-id-20260802/qwen_ws.py.before-stable-id`，当前 r7 只同步稳定身份边界：投票键改为 `profile_id`，姓名放入独立 metadata，缺少 ID/姓名时拒识，确认后的事件和 Transcript 持久化使用 `identity_id`，未确认时继续使用临时 cluster 标签；阈值、VAD、词表和资源策略不变。

证据：

- `tools/service-quality-evidence/svc05/svc05-r7-stable-speaker-id-contract-r1.json`：修复后源哈希 `04fbffab11874608ad96c029e29091ee48f1e8832bc1b44f0918b02613ec2445`，备份哈希 `365b00841524ea003498babb5b28767e1684017a352d884fee37bc01c08bf266`，确定性检查 `7/7`，`py_compile` 通过；
- `tools/service-quality-evidence/svc05/svc05-r7-stable-speaker-id-asgi-smoke-r1.json`：同一 r7 哈希下走真实 FastAPI TestClient/WebSocket、临时 SQLite 和 fake VAD/ASR/CAM++，稳定 ID/展示姓名/持久化/停止排空检查 `7/7`；
- 在临时 `DATABASE_URL=sqlite+aiosqlite:////tmp/laoji-svc05-r7-test.sqlite` 下，`tests/test_qwen_realtime_ws.py` 与 `tests/test_app_speaker_isolation.py` 为 `29 passed`，`tests/test_streaming_vad_preroll.py` 与 `tests/test_schedule_asr_proxy.py` 为 `11 passed`，合计 `40 passed`。

该切片只收口 r7 候选的身份字段一致性，不刷新或追认绑定旧源哈希的历史 ASR/声纹质量报告；真实 CAM++、真人多人 DER/JER、相似声线 FAR/FRR、物理真机、PostgreSQL 多 worker、重启、soak 和生产部署仍未通过，`promotion_eligible=false` 保持不变。

### SVC-06 紧凑整理运行时合同 r3/r7

本轮在当前 r7 候选 `/home/yydd/.codex/tmp/svc09-r7-verify-src` 上补做紧凑整理运行时合同，避免只引用旧的结构边界合同而遗漏当前模型请求参数和结果归一化。命令通过 `LAOJI_SVC06_CANDIDATE_ROOT` 显式绑定候选根，未连接共享数据库、Ollama 或生产端口。报告为 `tools/service-quality-evidence/svc06/svc06-compact-summary-runtime-r3-r7.json`。

合同共 `9/9`：

- overview 文本和引用字段保持原文支持边界；
- 行动项负责人、来源引用和空行动项按当前归一化规则处理，无法由转写支持的条目丢弃；
- 模板整理触发第二次模型请求，仍使用 `num_ctx=8192`、JSON 响应约束和当前 telemetry 字段；
- 未知对象、损坏响应和不完整结果不进入客户端可见结构。

报告绑定的当前源哈希为：`app_summary_generator.py` `fc51955f0af394302dd8aa2c6218bb67ae0283f8772df452cc6426698bf0da67`、`meetingsummary/config.py` `6e07b3813c4a4e0c332acb8b91afbfae676b5be6dc3214cd4286f4818a11e55f`、`meetingsummary/ollama_client.py` `a3d17a049c8a303ad86cd8e8cfee14004938eb04d24b3465f0d4e89f89495432`。同一候选的 `tools/service-quality-evidence/svc06/test_guest_summary_smoke.py` 为 `4 passed`。

这次合同将模型调用替换为确定性 stub，只证明请求/响应形状、归一化和 telemetry 接线；没有证明真实 9B 模型的事实精确率、长会议事实图、引用召回、行动项 precision/recall、真实延迟、并发、生产数据库或部署恢复。因此 SVC-06 仍为候选证据，`promotion_eligible=false` 不变，不能把 `9/9` 或 `4 passed` 解释为整理质量已经发布。

### SVC-02 “仅月份 + 明确动作”澄清修复

当前真实 Qwen 日程语音桥接复核发现，`下个月交报告` 具有明确的日程动作和“工作”分类，但移动端低信息规则没有把“交报告/交材料/交文件”等动作识别为日程，最终错误进入 `reject/not_schedule`。这会让用户看到“交报告”时无法补充具体日期。

修改前已备份 `src/services/localScheduleParser.ts` 到 `tools/service-quality-evidence/svc02/source-backups/month-only-action-20260802/localScheduleParser.before-month-only-action.ts`，修改前后哈希分别为 `803f5da4ee380d846bae533a8126d4fe3080dac7077ef08b6f3c6dea2c9c103c` 和 `6a6efa98872c26911eae7302f85b91934236aa772ad23f20a8beb020cbd3edcf`。当前规则将有限的“交报告、交作业、交材料、交文件、交资料、交表格”动作加入低信息日程信号；它不会填造日期，而是保留标题、推断工作分类并返回 `missing_date` 澄清。

证据：

- `tools/schedule-quality-evidence/svc02/svc02-qwen-schedule-parser-bridge-r3-current.json`：同一真实 GPU0 Qwen3-ASR-0.6B 68 条冻结日程语音，ASR 仍 `68/68` exact；移动端字段完整从 `64/66` 提升为 `65/66`，字段命中 `152/153`，路由 `local_safe=59`、`server_required=3`、`clarify=5`、`reject=1`；
- `tools/schedule-quality-v3/run_local_parser_contract.js`：确定性边界合同扩为 `28/28`，新增“仅月份动作进入日期澄清”回归；
- 该桥接中的唯一剩余字段偏差是冻结 manifest 把“喝水”标为“生活”，而当前分类规则按健康行为归为“健康”。这属于夹具标签与产品规则不一致，未为迎合夹具修改规则。

本切片只修复移动端确定性路由并复核真实 Qwen 文本后的字段接线；没有证明远端 qwen3.5 日程模型、真人录音、字段盲测、网络鉴权、Android 真机、服务器延迟或生产部署，`promotion_eligible=false` 保持不变。

### SVC-03 r6 context-off 会议 WebSocket 质量刷新与 r7 快照漂移门禁

本轮先尝试用已补齐稳定身份的 `/home/yydd/.codex/tmp/svc09-r7-verify-src` 跑完整 28 条会议冻结集。探针在启动模型前的源级预检拒绝该目录：`qwen_asr_service/server.py` 缺少 `context_supported` 和 `QWEN_ASR_REQUIRE_IDENTITY`，且缺少 `app/api/qwen_context.py` 与 `qwen_ws.py` 的 `context_term_count`。因此没有绕过门禁，也没有把 r7 目录的结果当成 SVC-03 质量证据；这确认 r7 稳定身份候选与完整上下文候选不是同一源快照。

随后使用具备完整 SVC-03 上下文契约的 r6 隔离源 `/home/yydd/.codex/tmp/svc09-r6-verify-src`、真实 GPU0 Qwen3-ASR-0.6B、临时 FastAPI/SQLite 和 28 条固定会议 WAV，运行 `tools/service-quality-evidence/svc03/run_full_candidate_qwen_websocket_quality_probe.py` 的 context-off 复核。报告为 `tools/service-quality-evidence/svc03/svc03-full-candidate-qwen-websocket-quality-r6-refresh-20260802.json`：

- 28/28 会话均有完整转写，`config → stop_acknowledged → transcript.completed → ready_to_stop` 生命周期、缓存读取、游客删除和前后健康检查全部通过；
- 规范化文本 exact `21/28`（75%），CER 均值 `1.259%`、p95 `6.007%`，关键术语 `80/84`（95.24%）；
- provider segment timing p50/p95/max 为 `207.5/299.45/676 ms`，整组墙钟约 `53.4 s`；
- 运行绑定 provider 源哈希 `f5ed84f0f676e73a4392c19f25a06136ee337144af7de193da6a42a00e28df7d`、模型配置哈希 `76d3ae4601ce939830b2517f4a6cadb86cc51316c3900af6b020b051c21a478c`，结束后 GPU0 回到约 `125 MiB` 占用，临时端口无残留。

该报告只刷新 r6 context-off 的隔离 ASGI/WebSocket 协议和真实候选质量；不包含 r7 稳定身份修复，也不证明上下文词表、真人多人/噪声、物理真机、长会、OOM、多 worker、重启、soak 或生产部署。r7 快照必须先补齐同一 SVC-03 源合同并重新生成身份绑定报告，不能用 r6 结果替代，`promotion_eligible=false` 保持不变。

### 候选源统一：r6 同时承载 SVC-03 与 SVC-05

进一步核对发现，r6 并非缺少稳定身份的旧源。`/home/yydd/.codex/tmp/svc09-r6-verify-src/app/api/qwen_ws.py` 已同时包含：

- SVC-03 的上下文、provider 身份 pin、队列和 WebSocket 生命周期边界；
- SVC-05 的 `speaker_id` 稳定资料 ID、独立 `speaker_name` 展示字段、按资料 ID 投票以及持久化使用 `identity_id`。

因此当前可审计候选统一指定为 r6；r7 仅保留为历史声纹修复快照，不能与 r6 的实时质量报告拼接使用。重新运行稳定身份合同时，r6、summary backend 和 qwen3 staging 三套源共 `27/27` 通过，r6 源哈希为 `d71c12614a4d0e9fc177bca985ab6c58965bee34462bbb743ed7993838477328`；r6 候选 FastAPI/WebSocket smoke 报告 `tools/service-quality-evidence/svc05/svc05-r6-stable-speaker-id-asgi-smoke-r2-current.json` 为 `7/7`。

同一 r6 解释器下，`tests/test_qwen_realtime_ws.py` 与 `tests/test_app_speaker_isolation.py` 当前为 `33 passed`，`tests/test_streaming_vad_preroll.py` 与 `tests/test_schedule_asr_proxy.py` 为 `11 passed`；四个运行时模块 `py_compile` 通过。测试使用一次性 SQLite 和临时路径，结束后已清理。

这次统一只解决证据和候选源的组合错误，不改变生产端口、默认开关或声纹阈值；真实多人声纹质量、跨设备/跨天、物理真机、PostgreSQL 多 worker、重启、soak 和生产部署仍未证明，`promotion_eligible=false` 保持不变。

### SVC-06 远端真实整理烟测：旧 worker 未包含最终待办修复

远端服务器 `183.36.243.124:18020` 的 `/api/health` 返回 `models_ready=true`，因此使用仓库已有三条虚构转写、无用户数据的 guest-summary 烟测做了真实模型纵向验证。报告为 `tools/service-quality-evidence/svc06/svc06-remote-guest-summary-smoke-20260802.json`。

- 明确待办：通过，任务 `SUCCESS`，引用、负责人、截止日期和结构化候选均正确；
- 纯讨论：通过，任务 `SUCCESS`，没有生成待办；
- “取消王莉旧任务，最终唯一待办为赵明提交新版风险清单”：任务虽然返回 `SUCCESS`，但 `action_items` 和 `action_item_candidates` 均为空，最终待办、负责人、截止日期和引用全部缺失，因此该案例失败。

这不是评测器误判：同一转写在当前统一 r6 候选 `/home/yydd/.codex/tmp/svc09-r6-verify-src` 上运行 `tools/service-quality-evidence/svc06/run_final_action_extraction_contract.py` 为 `5/5`，候选源码哈希 `586671890aef56ced06ebb256c48ae3876a15c522d211ab9f4b56bad7f73dcf8`；候选能从转写中恢复赵明、`2026-08-04` 和对应引用。当前远端 worker 与候选存在部署漂移，不能把远端 `2/3` 写成 SVC-06 完成。

远端健康检查和 guest 请求未触碰账号会议或生产端口之外的写入路径；SSH 当前无可用凭据，因此没有重启、替换或修改远端服务。发布前必须将统一候选 worker 部署到远端，并用同一三案例复测达到 `3/3`，同时补充长会议、真实模型 holdout、并发、重启和多 worker 证据；`promotion_eligible=false` 保持不变。

### SVC-07 远端真实 guest 问答最小链路

在同一远端 `183.36.243.124:18020` 上，用一条虚构会议转写请求验证 guest 问答：问题为“会议的决定是什么？”，唯一来源片段说明采用蓝色方案并由王强提交设计稿。报告 `tools/service-quality-evidence/svc07/svc07-remote-guest-question-smoke-20260802.json` 为通过：HTTP `200`、`answer_scope=meeting`、回答非空、引用指向 `seg-1`，并且服务回显的 `input_fingerprint` 与客户端计算值一致；请求耗时约 `2.15 s`。

该结果证明远端当前问答入口、最小上下文、引用和请求指纹接线可用，但只是一条合成 smoke，不证明问答大规模语义质量、账号权限隔离、真实 embedding、并发尾延迟、PostgreSQL、多 worker、重启或生产发布。远端整理与问答的模型/worker 版本并不因此自动统一，`promotion_eligible=false` 保持不变。

### SVC-03/SVC-05 统一候选预检 v2

为防止候选快照再次漂移，`tools/service-quality-evidence/svc03/run_full_candidate_qwen_websocket_quality_probe.py` 的预检合同从 v1 收紧为 `svc03-qwen-websocket-quality-v2-unified-identity`。除了 Qwen 上下文、身份 pin、VAD/WebSocket 停止和 telemetry 标记，还必须同时存在：

- `qwen_ws.py` 的稳定 `identity_id` 持久化表达式；
- 独立的 `speaker_name` 展示字段；
- `_identify()` 保留资料 `speaker_id`。

这样缺少 SVC-03 上下文的 r7 快照、或缺少 SVC-05 稳定身份的旧快照，都会在加载模型前失败，不会生成可误读的质量报告。统一 r6 运行 `M001` 真实 WebSocket smoke，报告 `tools/service-quality-evidence/svc03/svc03-unified-candidate-websocket-smoke-r1-20260802.json` 为 `1/1`：ASR exact `1/1`、关键术语 `3/3`、所有生命周期/缓存/删除/健康检查通过，provider segment p50/p95/max 为 `499/499/499 ms`。r6 预检通过，r7 预检明确拒绝。

该切片只强化证据完整性和候选源一致性，不代表 28 条会议质量、真实多人噪声、物理真机、生产多 worker、重启、soak 或发布资格，`promotion_eligible=false` 保持不变。

### SVC-06 本地 summary overlay 最终待办、canonical 持久化与发布阻断

远端三案例烟测已证明 `183.36.243.124:18020` 当前 worker 漏掉“取消旧任务后保留唯一最终待办”的结果。继续核对本地部署 overlay 后确认 `/home/yydd/桌面/light_plan/server-work/summary/summary_tasks.py` 也缺少该覆盖逻辑；它不是完整 backend checkout，而是映射到目标 `backend/app/workers/summary_tasks.py` 的稀疏文件。

本轮在该单文件中移植两条最小修复：当转写出现“最终确认的唯一待办/仅有一项待办”时，以来源抽取的最终行动项替换模型返回的旧行动项；阶段总结和最终总结改为在 worker 子进程内创建独立异步会话，按 `DATABASE_URL` 写 canonical `PeriodSummary`/`FinalSummary`，不再直接连接 `local.db`。前置备份分别保留在 `server-work/summary/backups/final-action-exclusive-20260802/` 和 `server-work/summary/backups/canonical-summary-persistence-20260802/`。本地合同 `tools/service-quality-evidence/svc06/svc06-local-overlay-final-action-exclusive-r1.json` 为 `5/5`，canonical 持久化合同 `tools/service-quality-evidence/svc06/svc06-local-overlay-canonical-persistence-r1.json` 为 `7/7`，当前 worker 源哈希为 `8996694df4dd0906733f7440e42e0f33ad7b7ba594528169157d498f2e96b134`。可转交的最小包为 `tools/service-quality-evidence/svc06/svc06-local-overlay-final-action-exclusive-r1.tar.gz`（包 SHA-256 `0ca5ff476b5e417b0b363a3707e23047426744220d83fc32c4cc8302ac44fe67`），其 `MANIFEST.json` 绑定 worker 哈希和发布前后检查。

当前远端 HTTP `/api/health` 仍返回 `models_ready=true`，但 SSH 对 `zhong@183.36.243.124` 和默认账号均为 `Permission denied (publickey,password)`，本机 agent 没有 identity。因此没有上传、重启或替换远端文件，也没有把本地合同升级成“已部署”。发布前置步骤保持：取得合法 SSH/受控上传权限；备份目标 worker；仅同步该 overlay 文件；重跑三条无用户数据 guest-summary smoke，要求 `3/3`；再做源哈希和健康检查。未满足前 `promotion_eligible=false`。

### SVC-04 离线转写 waiting_resource 进程内恢复补充

复核离线音视频转写候选时发现一个实际恢复缺口：ASR 网关在运行时身份暂不可用或发生漂移时，任务会正确持久化为 `waiting_resource`，但原实现只在网关启动阶段调用一次 `recover_pending_tasks()`；资源在同一进程内恢复后，任务没有再次被唤醒，除非人为重启网关。

已在隔离候选 `/home/yydd/桌面/light_plan/server-work/asr-gateway-candidate` 备份后修复：

- `services/full_audio.py` 增加进程级有界等待监视器，默认每 5 秒扫描一次 `waiting_resource`，间隔由 `ASR_FULL_WAITING_RESOURCE_RETRY_SECONDS` 控制并限制在 1–300 秒；任务进入等待状态时立即唤醒一次；每个任务仍由 `_RUNNING_TASKS` 身份栅栏保证不会重复推理；等待状态写入 `waiting_resource_since`、`next_retry_at` 和实际间隔。
- `main.py` 在 durable recovery 后启动监视器，在 FastAPI shutdown 时唤醒并 join；重复启动和重复停止均为幂等操作，不把后台线程带入下一次候选进程。
- `README.md` 明确该能力只解决同一进程的资源恢复，不替代共享任务库、生产 admission、真实 GPU 质量或部署门禁。

前置备份位于 `server-work/asr-gateway-candidate/backups/waiting-resource-retry-20260802/`。证据 `tools/service-quality-evidence/svc04/svc04-waiting-resource-retry-contract-r1.json` 绑定当前候选源码哈希与备份哈希；使用 `/tmp/laoji-svc04-deps-20260731` 隔离依赖运行新增等待恢复测试及既有 SVC-04 chunk、幂等、故障注入、运行时身份回归，共 `50/50` 通过。

本切片未上传、未替换、未重启远端 gateway/worker，也未启动真实 Whisper 权重；`promotion_eligible=false` 保持不变。仍缺真实 provider/GPU、长音频 CER 与边界时间戳、RTF/OOM、生产数据库多进程、服务器重启和 soak 证据。

### SVC-04 摘要客户端 waiting_resource 状态感知退避补充

继续检查离线转写上下游时发现，网关已经把资源暂不可用持久化为 `PENDING` + `Status: waiting_resource`，但摘要服务的 `asr_gateway_client.py` 对所有 `PENDING` 响应都固定每秒轮询。资源长期不足时，这会制造无意义的 HTTP 请求，且把“排队等待资源”和“正在处理”混成同一种客户端行为。

当前 sparse summary overlay 已补齐状态感知退避和总超时边界：

- `waiting_resource` 默认使用 5 秒退避，由 `LAOJI_ASR_GATEWAY_RESOURCE_RETRY_SECONDS` 配置，并限制在 1–120 秒；
- `queued`/`processing` 继续使用普通轮询，由 `LAOJI_ASR_GATEWAY_POLL_SECONDS` 配置，并限制在 1–30 秒；
- 旧网关没有 `Status` 行时保持默认轮询兼容；出现未知 `Status` 时 fail-closed，返回 `asr_gateway_pending_status_invalid`，不静默忙等；
- 每次状态退避都按剩余总 deadline 截断，资源等待不会把 `LAOJI_ASR_GATEWAY_TIMEOUT_SECONDS` 配置的请求预算向后拖长；
- 状态只影响客户端等待间隔，不改变任务 ID、租约、提交幂等、超时或取消语义。

合同 runner `tools/service-quality-evidence/svc04/run_asr_gateway_resource_poll_contract.py` 会在隔离 SQLite 和 Python 依赖中预加载当前 overlay，先编译源文件，再运行新增状态合同与完整候选的既有网关聚焦回归。当前报告 `tools/service-quality-evidence/svc04/svc04-asr-gateway-resource-poll-contract-r2.json` 记录编译通过、新增 `4/4`、既有聚焦 `3/3`，并绑定 overlay、测试和修改前备份的 SHA-256。

这是上游网关状态与下游摘要轮询之间的候选合同，不代表远端进程已加载修改；未证明真实 provider/GPU、生产 PostgreSQL/多 worker、跨进程恢复、重启、长时间 soak、物理真机或发布资格。`promotion_eligible=false` 保持不变。

### SVC-05 稳定身份 smoke 证据漂移修复

复核当前 CAM++ smoke 时发现旧 runner 仍按“姓名即身份”的二元返回值断言，实际当前适配器已经返回四元组 `identity_id、display_name、identified、confidence`；旧报告因此错误失败，即使真实 GPU0 CAM++ 前向、单资料双片段确认和未知音色拒识均已完成。

已修正 `tools/service-quality-evidence/svc05/run_real_speaker_engine_smoke.py` 的断言并生成 `tools/service-quality-evidence/svc05/svc05-real-speaker-engine-smoke-r2.json`：真实支持模型就绪、192 维 embedding、首个合格片段保持未知、第二个合格片段返回稳定 profile ID 与展示姓名、未知音色不被认领，全部检查通过。另将过期 `run_speaker_identity_contract.py` 更新为稳定 ID 语义，生成 `tools/service-quality-evidence/svc05/svc05-speaker-identity-contract-r3.json`，当前 qwen3-asr-test 源级合同 `13/13`；三套候选的稳定 ID 合同 `svc05-stable-speaker-id-contract-r1.json` 为 `27/27`。

旧的 `svc05-speaker-identity-contract-r2.json` 只保留为断言漂移的历史记录，已被 r3 替代，不参与当前门禁或完成判断。

这次只修复证据 runner 与当前源契约不一致的问题，没有放宽阈值或改变实时身份算法；真实真人多人 DER/JER、跨设备/跨天、噪声 FAR/FRR、物理真机、PostgreSQL 多 worker、重启、soak 和生产部署仍未证明，`promotion_eligible=false` 保持不变。

### SVC-03 WhisperLiveKit 就绪握手收口

复核 summary backend 的另一条 WhisperLiveKit WebSocket 入口时，发现它原先会先发送 `config`，再尝试初始化 Faster-Whisper；引擎不可用时客户端会收到一个看似可录音、随后才失败的协议状态。本轮保留修改前备份 `server-work/summary/backups/whisper-readiness-handshake-20260802/whisper_ws.before.py`，将 `handle_whisper_websocket()` 收口为：

- 先执行 `_ensure_engine()`，初始化失败时首个用户可见事件固定为 `type=error`、`code=whisper_engine_not_ready`、中文可重试消息和 `retryable=true`；
- 失败分支不发送 `config`，以 WebSocket 关闭码 `1013` 结束；
- 只有引擎就绪后才发送原有 `config`，不改变正常 `useAudioWorklet=true`、`mode=full` 握手。

隔离合同 `tools/service-quality-evidence/svc03/svc03-whisper-readiness-handshake-contract-r1.json` 绑定当前源哈希，编译并执行源级调用顺序检查和两条 stubbed WebSocket 分支，结果 `18/18`。合同没有加载 Whisper 权重、GPU、数据库或网络服务，因而只证明握手协议和中文错误边界；没有证明真实模型就绪、ASR 质量、GPU 延迟、Android、物理真机、生产部署或重启恢复，`promotion_eligible=false` 保持不变。

### SVC-07 SQLite 迁移归属与资产预检收口

继续审计账号、日程和声纹从本机 SQLite 迁移到共享 PostgreSQL 的切换边界时，发现原迁移工具会把以下问题静默带过：无 `user_id/owner_user_id` 的原型日程或旧声纹资料、日程子表指向不存在或不同归属的父事件、声纹 embedding/识别日志指向不存在的资料，以及用户记录带有头像文件名但源文件不存在或目标目录未配置。迁移后这些数据可能不可见、跨作用域或产生坏头像链接，不能等到上线后再发现。

修改前备份保留在 `tools/service-quality-evidence/svc07/source-backups/scope-preflight-20260802/migrate_laoji_sqlite_to_postgres.before-scope-preflight.py`。当前工具在打开 PostgreSQL 行写入前读取快照并执行严格预检：

- 账号归属必须存在；日程事件和所有子表必须有有效用户且父子用户一致；
- 讲话人资料必须有有效 `owner_user_id`，embedding/识别日志必须引用已迁移资料；
- 带头像文件名的用户必须同时提供安全的 basename、存在的源文件和目标头像目录；
- 任一问题统一以 `source_scope_invalid` 失败，报告只记录表名、行标识和稳定问题码，不写入邮箱、正文或 embedding 内容；
- 预检通过后才进入目标表复制，成功报告新增 `source_preflight` 计数和检查表清单。

确定性合同 `tools/service-quality-evidence/svc07/svc07-migration-scope-preflight-contract-r1.json` 为 `7/7`，覆盖无归属、孤儿引用、父子归属不一致、缺失头像和有效头像。随后把修改后的工具注入当前 r6 隔离候选，在一次性 PostgreSQL 16 loopback 容器中重跑原迁移首跑+快照 replay，账号、日程、声纹、头像回读和两轮迁移均通过；报告为 `tools/service-quality-evidence/svc07/svc07-sqlite-postgresql-migration-scope-preflight-r1.json`，首次和 replay 的 `source_preflight.passed` 均为真。

同一候选又执行了“首表写入后注入失败→检查全量回滚→复用冻结快照重放”合同，目标表全部回到零行、源 SQLite 哈希不变、头像临时文件清理、重放后账号/日程/声纹/头像回读均通过；报告为 `tools/service-quality-evidence/svc07/svc07-sqlite-postgresql-rollback-preflight-r1.json`。

这只收口迁移前的作用域和资产完整性，不代表线上双写冻结、生产备份/复制、在线切换、回滚、真实账号 HTTP、多 worker 或发布资格。`promotion_eligible=false` 保持不变。另一次尝试使用 `svc07-r9-verify-src` 的旧快照时，在迁移前因其 `app.services.postgres_compat` 缺少 `is_postgres_integrity_error` 而导入失败；该结果记录为候选源码漂移，不用新合同掩盖，r6 才是本次迁移回归绑定的统一候选。

### 共性用户可见错误文案收口

继续按用户路径审查时发现，旧 `/api/meetings` 路由仍会把 `Meeting not found`、上传异常正文、总结异常正文和 ffmpeg 原始失败文本带入错误响应或后台异常对象；Android 媒体导入、音频上传和本地/远端片段导出也存在英文原生异常消息。当前移动端多数路径按稳定错误码转换为中文，但这些底层消息仍可能被旧客户端、调试页或未覆盖的异常分支直接展示。

本轮保留修改前备份 `server-work/summary/backups/user-visible-error-copy-20260802/meetings.before.py` 以及 `tools/service-quality-evidence/common/source-backups/user-visible-error-copy-20260802/`，完成最小边界修复：

- 旧会议路由统一使用“会议不存在或已被删除”“文件上传失败，请稍后重试”“总结生成失败，请稍后重试”；上传/总结的内部异常只写服务端日志，不再拼接进 HTTP detail；ffmpeg 细节只记录日志，错误码固定为 `ffmpeg_failed`；
- `MediaIngestor`、`MediaImportSupport`、`MeetingUploadWorker`、`ContentUriRequestBody` 和 `MediaClipExporter` 保留既有稳定 code，只把可传播的异常消息改为中文，技术格式名（如 WAV）保留为必要的用户诊断信息；
- 新增 `tools/service-quality-evidence/common/run_user_visible_error_copy_contract.py`，静态核验旧路由的禁止英文/内部详情、原生异常构造器的中文消息和所有源文件存在性，报告 `tools/service-quality-evidence/common/user-visible-error-copy-contract-r1.json` 为 `14/14` 通过。

该切片只收口错误文案和内部诊断隔离，不代表旧路由或媒体导入的真实设备成功率、上传服务可用性、ffmpeg/ASR 质量、生产部署或真机验证已完成；`promotion_eligible=false` 保持不变。

### SVC-03 summary backend Whisper 自适应容量接线

继续核对实际 summary backend 时发现，规划文档中已在隔离候选验证过的 Whisper 容量选择器并未进入该入口：`backend/app/main.py` 的预热路径和 `backend/app/api/whisper_ws.py` 的懒加载都直接读取 `WHISPER_MODEL_SIZE`，会在 GPU0 空闲不足时绕过容量检查尝试加载 `large-v3`，并可能与正在运行的 Qwen/模拟器争抢显存。

本轮在修改前备份 `server-work/summary/backups/adaptive-whisper-20260802/` 后补齐实际接线：

- 新增 `backend/app/services/whisper_resource_profile.py`，按当前 CUDA 空闲显存选择 `large-v3/medium/small`；显式 `WHISPER_MODEL_SIZE` 永不静默降档；candidate/release 默认容量不足即 fail-closed；只有 `WHISPER_ADAPTIVE_MODE=preview` 且 `WHISPER_ADAPTIVE_PREVIEW=1` 才允许选择满足门槛的最高轻量档位；
- WebSocket 首次加载在导入 WhisperLiveKit 前执行选择器，并把 `quality_profile`、实际模型档位加入 `config`；启动预热改为调用同一 `_ensure_engine()`，不再拥有另一套绕过门禁的构造逻辑；
- 新增 `tools/service-quality-evidence/svc03/run_summary_whisper_resource_profile_contract.py`，在不加载模型、不启动端口的条件下覆盖正式档位拒绝、preview small、自适应显式拒绝和 medium 显式通过，连同源级接线共 `9/9`；报告为 `tools/service-quality-evidence/svc03/svc03-summary-whisper-resource-profile-contract-r1.json`。

本轮 summary backend 三个 Python 文件 `py_compile` 通过；未启动 Whisper/Qwen、未改变 GPU 或线上端口。该切片只证明容量准入和入口一致性，不代表 Whisper 模型质量、真实多路性能、OOM、生产服务或物理真机已通过，`promotion_eligible=false` 保持不变。

### SVC-03 Whisper gateway 模型身份与容量策略

继续核对独立 8002 Whisper gateway 路径时发现，它原先固定以
LAOJI_WHISPER_MODEL（默认 whisper-small）作为会话模型，而本地
WhisperLiveKit 已按本机 CUDA 空闲显存选择档位。两条回退路径因此可能出现
“本地配置模型”和“gateway 实际模型”不一致，且 gateway 的 ready=true
没有表达容量或源码/权重身份。

本轮在修改前备份
server-work/summary/backups/whisper-gateway-policy-20260802/ 后完成边界收口：

- 客户端保留旧 gateway 兼容性，但如果健康响应公布实际 model，下一次会话
  使用该模型，不再把本机显存状态误当成远端选择结果；
- 健康快照补充 quality_profile、capacity_ready、free_mib、
  identity_verified、服务源码和模型配置 SHA-256 等字段；Qwen 选择结果将
  provider 标记为 whisper-gateway，实际档位仍单独记录；
- LAOJI_WHISPER_GATEWAY_REQUIRE_MODEL_MATCH=1、
  LAOJI_WHISPER_GATEWAY_REQUIRE_CAPACITY=1、LAOJI_WHISPER_GATEWAY_MIN_FREE_MIB
  可启用容量/模型匹配门禁；设置
  LAOJI_WHISPER_GATEWAY_REQUIRE_IDENTITY=1 并提供两份 expected SHA-256 后，
  缺少 pin、身份不真或摘要漂移均不会进入 WebSocket config；
- 严格门禁是显式候选/发布配置，默认不改变旧 gateway；它不会启动、停止或
  迁移 8002，也不会改变 auto 回退仍需显式 preview 许可的规则。

源级证据 tools/service-quality-evidence/svc03/svc03-whisper-gateway-policy-contract-r1.json
为 5/5，聚焦 provider/loopback 回归为 18 passed，summary backend 与
Qwen gateway 文件 py_compile 通过。该证据只证明客户端策略、模型身份
透传和 fail-closed 边界；远端部署、真实 gateway 权重、GPU/OOM/尾延迟、
多人声纹、重启/soak、物理真机和生产发布仍未证明，promotion_eligible=false
保持不变。
