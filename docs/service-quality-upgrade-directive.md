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
| 会议实时转写 | 已重跑 28 条语义债务、并发 4、双轮共 56 会话；stop acknowledgement 时序通过，ready p95 12 ms | 原始门禁 37/56；并列语义审计在不改原文和原始 CER 的前提下为 50/56，但 11 条仍超尾延迟门槛，联合门禁为 39/56。M003/M008/M018 仍有未解决词项，M025/M027 属于数字/技术词表记差异，不应当作语义丢失；生产 `18020` 所依赖的 `127.0.0.1:8030` 当前未监听，因此旧结果也不能代表当前生产可用性；Android 真握手、真人长会议和 soak 仍不足 |
| 离线转写 | RecordingAsset、视频音轨、任务恢复和真实 GPU 主链已接通 | 格式、时长、真人噪声、截断保护、服务重启和长音频质量矩阵不足 |
| 讲话人 | 资料采集、修正、未来改善和旧会议重匹配合同已接通；窄样本曾 8/8 | 不能证明跨设备、多人、相似声线、噪声、未知人拒识和真实录制后的改善；用户已观察到录制资料后仍未识别 |
| 整理结果 | schema v2、四模板、版本、引用、待办、长文 Map-Reduce 和 durable task 已实现 | 合成/规则样本多；近期真实任务可达约 92 s；没有大规模盲测的事实精确率、漏项率、引用召回和人工可用性 |
| 会议问答 | 350 条、6 份夹具；检索 110/110 等分组通过 | 最后一次完整集为 347/350，修复后只跑了受影响组；冷请求曾约 90 s、暖请求约 26.6 s；真实 ASR 长会议与开放式多轮不足 |
| 位置解析 | Expo + Android 原生定位竞速、5 分钟缓存、系统反向地理编码、坐标兜底 | 没有可替换地址提供器、没有真实 ROM/室内外矩阵；拿到坐标但地址为空时只能展示经纬度 |
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

| 服务/切片 | 最高已证实阶段 | 当前证据 | 尚未证实与下一步 |
|---|---|---|---|
| SVC-00 推理调度 | G3 旧方案失败；SVC-00A 本地候选 | 五波混合负载中问答 p95 33.574 s、模型日程 p95 39.698 s、整理 p95 124.709 s，55 个交互请求有 15 个排队超过 2 s；broker 已新增总并发 2、后台最多占 1 槽并通过 16 条本地调度/关闭测试；隔离 mixed-load runner 自测 22 请求通过（15 成功、取消/断开钩子均被覆盖，危险端口全部拒绝）。SVC-00 日程后处理审计 r3 使用 qwen35 staging parser、固定参考时钟和 32 条语料，`32/32` 通过；qwen35 parser 合同测试在 import-only 依赖 stub 下 `58/58` 通过；证据：`tools/service-quality-evidence/svc00/schedule-model-fallback-postprocess-candidate-r3.json`、`tools/service-mix-runner/runner.py` | 该审计和测试只证明确定性归一化/边界合同，隔离 runner 自测不等于真实候选服务混合负载，staging 原生 `meetingsummary.ollama_client` 依赖仍未补齐。仍需真实 4B/9B 模型质量、GPU 速度、混合负载和 2 s 排队 Gate；若显存、质量或排队线失败，转独立 schedule runner |
| SVC-01 日程文本解析 | G1 确定性移动端合同 + 隔离服务端候选合同 + 冻结集安全扫描 | v5 语料 3200 条、1000 组 metamorphic pair 的生成/泄漏/评分器自测通过；移动端 C0/C1 合同 7/7 通过；隔离 staging 服务端候选修复显式非法日期截断、解释/假设/取消/提示词注入、不确定地点静默保存和同日范围否定；新增 request-scoped `reference_datetime/timezone`，相对日期、跨午夜、澄清和 DST 缺口/重复时间均使用同一上下文；上下文合同 14/14，服务端边界合同 14/14；冻结 v5 安全相关样本 819 条、违规 0；`event-commands-20260715` 的请求/响应模型和路由上下文透传合同 12/12，日程命令回归 27/27；新增组装检查确认 event API 复用 qwen35 parser，且 event checkout 无解析器副本；本轮 qwen35 parser 更新后重新通过 14/14 服务端候选合同、3200/3200 冻结扫描（819 条安全相关、0 违规）（证据：`tools/schedule-quality-v3/svc01-local-parser-contract-r1.json`、`svc01-local-parser-frozen-scan-r1.json`、`tools/schedule-quality-v3/svc01-server-candidate-contract-r2.json`、`svc01-server-candidate-frozen-safety-r2.json`、`tools/schedule-quality-v3/schedule-context-router-contract-r1.json`、`tools/schedule-quality-v3/event-commands-assembly-contract-r1.json`） | staging 候选未部署、未接真实模型；event-commands 仍缺完整 parser/runtime/auth 依赖，组装检查不等于独立部署或 HTTP 运行；仍非正式模型盲测，v5 主要为合成数据，尚缺真实匿名输入、独立 holdout 服务运行、完整字段 exact、置信校准和混合负载延迟 |
| SVC-02 日程短语音 | G1 客户端 + 隔离服务端输入边界合同 | `src/services/api.ts` 已在 HTTP 前拒绝空音频、空 ASR 文本和不完整解析响应；错误上下文已统一为中文；语音解析请求已透传 `reference_datetime/timezone`；staging 服务端增加严格 base64/data URI/大小边界，服务端边界 5/5；证据：`tools/service-quality-evidence/svc02/svc02-audio-boundary-contract-r1.json`、`tools/schedule-quality-v3/svc02-server-audio-boundary-contract-r1.json`、`tools/schedule-quality-v3/schedule-context-router-contract-r1.json` | 本轮质量 Gate 未开始；staging 服务端未部署，仍需真实手机、说话人、噪声、编码和关键日期/否定槽位语料，以及服务端路由和 ASR 质量/速度证据 |
| SVC-03 实时转写 | G1 真实模型并发基线；词表候选 r4 已被 fail-closed 阻断，当前隔离接线已完成协议合同但未完成模型运行验证 | 基线 `svc03-semantic-debt-56-r3.json` 为原始 37/56，ready p95 12 ms、max 17 ms、segment-tail p95 1686 ms、max 2108 ms；r4 context 历史报告原始仅 21/56，语义审计 51/56，但出现 18 条原通过样本回退，segment-tail p95 2424 ms、max 3605 ms，ready max 883 ms，故 `promotion_eligible=false`（证据：`svc03-semantic-debt-56-r4-compare.json`）。当前 qwen3-asr-test 已完成 WebSocket→context header→推理服务静态组装 `12/12`；新增无模型隔离候选合同覆盖上下文/语言逐请求配对、并发批处理、取消、队列关闭、结果数量 fail-closed 和默认关闭时可选微批依赖缺失，`26/26` 通过，源码语法 `12/12` 通过，补丁 hunk 结构检查通过（证据：`svc03-context-assembly-contract-r2.json`、`svc03-isolated-contract-r3.json`）。历史 r4 原始运行副本仍不存在，当前报告不可从现有 checkout 复现。生产 `8030` 仍未监听，候选未部署 | 不得推广 r4；仍需在具备锁定依赖和模型容量的隔离环境重跑 context=off/on 配对，分别记录模型 `infer_ms`、队列/切段延迟和 stop drain，确认是否是 context 内容还是候选运行时导致回退。要求原通过项零回退、segment-tail/stop 不回退、阴性词表和跨会话隔离；微批仍需真实 GPU 吞吐、完整冻结全集、Android 真握手、重启恢复和 soak。`18020/api/health` 不能证明 Qwen 就绪 |
| SVC-04 离线音视频转写 | G1 post-audit CPU 候选；真实 GPU provider 未通过 | SVC-04A 使会议网关路径不再为计算时长整段物化 PCM；默认关闭的 v2 候选提供 10 分钟 core/15 秒 overlap、稳定块 ID、块 checkpoint、进程 kill 恢复、结果 checksum 和单进程推理串行；实际 Whisper checkpoint SHA/device/dtype 身份覆盖层已加入。47/47 gateway 合并回归、51 条 summary 合同、SVC-04A 工具回归 35 条通过。r2 容量窗口在启动前有 9989 MiB，但 large-v3 加载到约 9.72 GiB 后仍以仅余 27.25 MiB OOM；旧 `/health=OK` 和 PID/cgroup/监听身份因此被证明是假绿，候选 unit 已单次 verified stop，生产目录未改动 | 控制器现要求启动前至少 12288 MiB、加载后至少保留 2048 MiB，并在上传前通过带临时凭据的 `provider-readiness`，精确核验 `runtime_model_ready`、model revision 和 runtime fingerprint。修复后同一 9989 MiB 现场被 preflight 明确拒绝且未启动 GPU。仍未证明真实 provider smoke、CER、边界消歧、GPU RTF、格式矩阵、重启和 soak。证据：`tools/service-quality-evidence/svc04/svc04-start-r2-window.json`、`svc04-stop-r2-window.json`、`svc04-preflight-r4-readiness-fix.json`；不得停止或卸载共享 21434/其他 GPU 服务，分块开关不得在生产开启 |
| SVC-05 讲话人闭环 | G1 确定性拒识候选 | 实时身份映射现在要求当前片段同时满足 cosine 和 gap 阈值，低置信片段不会继承历史 cluster 投票；新增 AST/行为合同 `8/8` 通过（证据：`tools/service-quality-evidence/svc05/svc05-speaker-identity-contract-r1.json`） | 当前 Python 缺少 NumPy/FastAPI，真实 WebSocket、CAM++、跨设备/相似声线和 unknown rejection 质量尚未运行；仍需真实 cohort 的 DER/JER、FAR/FRR、profile revision 和 reprocess 验证 |
| SVC-06 结构化整理 | G1 脚手架 + 合同回归 + 隔离结果边界候选 | 160 条 synthetic/dev、1020 个 fact unit 的评分脚手架；真实模型 3 条合成烟测通过；结构合同回归覆盖明确待办、纯讨论、待办更正、引用篡改和失败任务拒绝；staging 紧凑整理结果增加原文支持门禁，扩展到 `6/6` 边界合同通过：无法由转写支持、明确否定或取消的待办不会进入结果，后续重新确认的正向待办仍可保留（证据：`tools/service-quality-evidence/svc06/svc06-structured-summary-contract-r1.json`、`tools/schedule-quality-v3/svc06-server-summary-boundary-contract-r1.json`） | staging 候选未部署；未完成正式质量 Gate、长会事实图、引用 precision/recall 和并发速度验证；真实烟测目标报告的 `/api/health` 为 `models_ready=false`，不能外推为模型或生产完成 |
| SVC-07 会议问答 | G3 9B 质量候选已通过；性能候选未收口；新增登录问答边界和单轮超时候选 | `qwen3.5:9b` r24 原始 1911 条全通过；使用当前严格 v3 评测器离线重评分仍为 `1911 PASS / 0 FAIL`，覆盖 1911 个唯一 case，响应无 verdict/text 变化。严格证据见 `tools/service-quality-evidence/svc07/svc07-question-endpoint-v3-9b-1911-r24-strict-r1.json`，当前 evaluator SHA-256 为 `e9613d0172f25839ea4fa36892362d6090182c589cc653308216be106b2a939b`；旧 4B 完整报告严格重评分为 `1787/1908`，保留 121 条真实失败。r25 workers=4 并发样本质量通过但延迟门槛失败。登录接口新增服务端文字记录版本/片段正文与时间校验、整理结果和我的笔记归属校验、历史问答线程逐轮校验、模型引用白名单；源级合同 `7/7` 通过，证据为 `tools/service-quality-evidence/svc07/svc07-question-boundary-contract-r1.json`。问答模型、embedding 和 single-flight 等待者现在共享每轮截止时间，默认为 30 秒并将剩余预算透传到每次模型、恢复和语义检索请求，超时 fail-closed；源级合同 `6/6` 通过，证据为 `tools/service-quality-evidence/svc07/svc07-question-deadline-contract-r1.json`；隔离速度/检索合同 `42 + 56` 全部通过，证据为 `tools/service-quality-evidence/svc07/svc07-question-speed-candidate-r2.json` | 尚未有独立 GPU/9B 实例上的 workers 1/2/4/8 性能 Gate、冷启动/逐出/混合负载和 90 秒问题收口；本轮服务器合同只做语法/源级检查，因本机缺少 SQLAlchemy/FastAPI 运行依赖未跑 ASGI/数据库；速度/检索测试使用配置和 Ollama 替身，不能外推真实模型延迟；共享 21434 只作信息性性能证据，候选 28120/28121 与 21434 共用模型，不能据此证明资源隔离 |
| SVC-08 位置解析 | G1 确定性候选 | SVC-08A 已保留 provider/精度/年龄/时间戳/粒度/置信等级，增加 single-flight、晚到抑制、geocoder adapter 和可取消 request ID；修复原生模块同步异常降级、重复 request ID 和读取缓存期间的取消竞态；`369/369` provider matrix、`22/22` 取消静态合同、TypeScript 与 `:laoji-native-platform:compileReleaseKotlin` 均通过（证据：`tools/service-quality-evidence/svc08/svc08-location-provider-policy-r3.json`、`tools/service-quality-evidence/svc08/svc08-native-cancellation-contract-r3.json`） | 尚未证明 Expo/native 底层物理取消、3 类 ROM 室内外真实采样、真机速度与地址成功率；不得标记为 SVC-08 完成 |
| SVC-09A 转写任务租约 | G2 隔离部署演练通过，不可部署 | r7 修复“失败任务显式重试仍复用旧网关任务”：租约接管保持 generation，显式重试递增 generation。50 条 summary/SQLite 聚焦合同、11 条 gateway 合同通过；11 步 CPU-only 演练通过 SQLite 备份/迁移/回滚、PostgreSQL 次级兼容、旧 12 位任务恢复与新旧 worker 不混跑 | 两侧均未部署；真实 HTTP gateway、长 ASR、服务器重启、GPU 压力和 soak 未完成；网关仍为单机单进程身份库 |
| SVC-09 其余编排 | G2 CPU 故障注入候选，不可部署 | r8 已覆盖 ACK fencing、多资产部分失败、删除/恢复交错、FIFO/恢复公平性、ENOSPC、只读目录、结果重建和真实 Uvicorn SIGTERM。r9 新增跨进程 admission sentinel，创建/重试返回中文 503，submit/claim/recovery 均受控，`/api/ready` 在停接时返回 503；58 条通过、3 条仅 PostgreSQL 跳过，cooperative/timeout 两类真 Uvicorn 演练均无竞态 claim。r10 又修复资产登记/媒体片段并发唯一冲突暴露 500、媒体片段重复 worker 领取、过期 worker 覆盖新结果及共享输出文件竞态；5 条隔离合同通过（证据：`tools/service-quality-evidence/svc09/uvicorn-sigterm-admission-r9.json`、`tools/service-quality-evidence/svc09/media-clip-atomicity-r10.json`） | 未跑真实 PostgreSQL、完整生产 ASGI 应用、真实转写/ffmpeg 长任务、生产 systemd 停机流程或 2 小时 soak；新门禁、租约和网关侧候选均未部署 |
| SVC-10 跨会议检索 | G1 确定性索引候选 | 现有 SQLite FTS 已按 scope/lifecycle 过滤并保留来源类型、来源 ID 和时间位置；新增 generation fence，防止索引重建与会议修改并发时发布旧快照；源级合同 `12/12` 通过（证据：`tools/service-quality-evidence/svc10/svc10-search-index-generation-contract-r1.json`） | 尚未完成真实数据库查询、10000 场索引规模、exact/semantic Recall@10、NDCG、freshness p95 和跨设备/生产验证；embedding/semantic path 仍未启用 |

当前执行顺序：SVC-00 已补齐 qwen35 后处理 32/32 候选证据，但真实模型与性能仍未完成；SVC-01 已完成移动端合同、隔离服务端边界合同和冻结集安全扫描；SVC-02 已完成客户端与隔离服务端音频输入边界合同；SVC-06 已完成原文支持待办的隔离后置门禁；SVC-07 新增登录问答证据边界合同，但尚未部署。上述候选均未部署，模型质量和真实设备证据仍未完成。SVC-07 r24 已完成严格质量重评分，r25 共享模型并发结果只作信息性证据；在获得独立模型容量前，不再重复污染 21434 的性能阶梯。SVC-04A 的 r2 容量重试证明旧健康门禁会在 Whisper OOM 后假绿；新门禁已要求 12288 MiB 启动余量和真实 provider readiness，同一现场已在启动前拒绝，等待更大的无干扰容量窗口。SVC-03 已完成 56 会话真实模型基线、可审计语义重评分、lexical context 候选、默认关闭且可回滚的微批接线候选，以及 `26/26` 的无模型隔离合同证据；联合门禁仍只有 39/56，候选未部署且没有当前可授权 GPU，不得恢复性空转或把 `18020/api/health` 当 ASR 就绪。SVC-09 r10 已补齐资产登记和媒体片段的并发/过期 attempt 文件栅栏，但只达到隔离 CPU 候选，不能外推生产。不得为了 Gate 停止生产 18020/18035、8002、21434/21436 或其他 GPU 服务。下一步继续推进 SVC-03 的隔离依赖/真实模型条件准备，并补 SVC-00 真模型、SVC-07 真实数据库/ASGI 与独立性能、SVC-09 真 PostgreSQL、真 ASR、重启和 soak。旧 8020 继续暂停。

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

本轮证据 `svc07-question-boundary-contract-r1.json` 和 `svc07-question-deadline-contract-r1.json` 覆盖源级不变量、`py_compile` 和超时结构；`svc07-question-speed-candidate-r2.json` 的 `42 + 56` 为使用模型/配置替身的隔离行为测试。由于当前执行环境缺少 SQLAlchemy/FastAPI，未运行数据库、ASGI、真实模型、取消、权限矩阵或性能测试，不能据此标记 SVC-07 生产完成。问答默认单轮预算为 30 秒，不能把该配置当作实测 p95；必须在独立模型实例上重新跑完整冻结集、冷暖请求和 1/2/4/8 路并发。

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
