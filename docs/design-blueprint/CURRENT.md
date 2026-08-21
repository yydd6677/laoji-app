# 老记设计蓝图当前入口

- current architecture: `LaoJi vNext global development baseline`
- architecture revision: `vnext-1`
- baseline release: `1.1.10 (118)`
- design status: `global development baseline frozen`
- production/App/GPU mutation: `none`; `emulator-5562` carries isolated candidate only
- stable source reference: `master` / `v1.1.10`
- implementation reference: `vnext/implementation`
- source and runtime paths are intentionally environment-specific; use repository-relative paths and deployment variables
- implementation branch: `vnext/implementation`
- stable baseline: Stage 0 passed at `1.1.10 (118)`; see [Stage 0 exit](../vnext-stage0/EXIT-20260818.md)
- implementation status: `Stage 0 passed; Stage 1 passed; Stage 2 speaker-overlay performance is now closed by a 30-run replay, while independent ASR/speaker quality, public zero-cycle and capability adoption remain open; Stage 3 deterministic four-template/rich-block projection and Stage 4 slices remain isolated/not adopted; emulator candidate 1.1.48 (156); Stage 4 voice 30-run host-audio envelope measured but failed closed`

## 权威文件

1. [VNEXT.md](VNEXT.md)：唯一产品画像、全局拓扑、数据所有权、领域合同和质量预算。
2. [VNEXT-IMPLEMENTATION.md](VNEXT-IMPLEMENTATION.md)：真实模块/API/schema 映射、Stage 0-5、迁移、删除和验收。
3. [VNEXT-DECISIONS.md](VNEXT-DECISIONS.md)：SELECTED/STAGED/RETAINED 决策、否决项、风险和证据。

历史 `revisions/`、`research/`、`evidence/` 和 `proposals/` 只提供事实与决策血缘，不再作为开发入口。
用户更新且明确的产品决定始终高于本文。

## 全局结论

vNext 不是某一个会议能力升级，而是覆盖日程、录音/导入、上传、ASR、讲话人、Transcript、
整理/行动、问答、组织/搜索/删除/分享/更新、UI 投影和服务器资源的整体版本。

核心结构：

```text
mobile SQLite + app-private media (business authority)
  -> domain-specific remote intent
  -> laoji-api minimal task/attempt owner
  -> laoji-asr / Ollama / R2 adapters
  -> revisioned result
  -> atomic local projection
```

手机拥有用户业务数据；服务器只拥有设备授权、临时加密任务、生成 artifact、上传 session 和 R2
清理义务；R2 只保存有 TTL 的 staging object。账号和跨设备同步不进入 vNext。

## 领域闭合

| 领域 | 状态 |
| --- | --- |
| 本机数据、设备、隐私、删除 | SELECTED |
| 日程文字/语音解析 | STAGED |
| 实时录音、导入、上传 | STAGED |
| ASR、讲话人、Transcript | SELECTED |
| 整理、行动、模板和编辑 | SELECTED |
| 本场待办、提醒和后续日程 | RETAINED |
| 会议问答 Q2 | SELECTED |
| 标签、分类、搜索、回收站、分享、更新 | SELECTED/RETAINED |
| JS/native 页面投影 | STAGED |
| Provider、任务、资源、可观察性 | SELECTED |

`STAGED` 的目标路线已经确定，只保留一个发布周期的受限适配器；它不是待研究或待选路线。

## 实施顺序

- Stage 0：冻结 1.1.10、导入并版本化真实后端源码、生成共享 schema。
- Stage 1：手机业务权威与 device v2 最小任务 owner。
- Stage 2：原生 R2 上传、文字优先 ASR、讲话人异步 overlay。
- Stage 3：Facts V3 长会闭合、行动候选、Q2 single reader。
- Stage 4：Mention Graph 日程、FTS、ProjectionEnvelope 和全局本地功能（0045/FTS 与 MentionGraph
  隔离切片已实现，未采用）。
- Stage 5：删除 account/sync、旧上传、summary v2、Q0、重复 parser、mirror/fallback 并发布；当前候选已补齐
  运行日志隐私静态门禁，删除门仍未通过。

## 当前边界

三份 vNext 文件已经冻结为全局开发基线，但不是生产采用证明。Stage 0 已通过
[Stage 0 exit](../vnext-stage0/EXIT-20260818.md) 并冻结稳定版本；Stage 1 已在
隔离工作树完成 0040–0042、本机 owner、device v2、generic task owner 与原生 purge-only capability，
退出记录见 [Stage 1 exit](../vnext-stage1/STAGE1-EXIT.md)。未部署服务、未切公开流量、未发布生产 APK；
`1.1.13 (121)` 仅作为隔离候选归档，构建证据见
[candidate build](../vnext-candidates/1.1.13-121.md)；`1.1.12 (120)` 和此前的 `1.1.11 (119)` 仍保留用于回溯。

Stage 2 已实现 0043/0044、RecordingAsset generation/source/operation 不变量、Transcript stable
segment/text state、speaker/manual overlay 仓储，以及隔离的 device-v2 R2 upload session、容量预留、
流式 SHA-256 验证、verified asset + transcription Task 原子提交和 purge-aware cleanup obligation。
未激活的 Android `device-v2-r2` WorkManager 已支持 single/multipart 源 URI 直传、两片并发、ETag 和
remote-complete 崩溃恢复、原生短令牌续期，并在远端确认后 armed binding-scoped purge capability。
上传网络调用已绑定 WorkManager 协程取消；v2 realtime 只有服务端显式宣告 capability 后才可选择，
候选路由默认 fail-closed。
8030 已新增不破坏 v1 的严格 v2 batch contract；realtime chunk/stable/final event ledger 已落库，
Android stable 事件已先持久化本机 Transcript 再确认 durable event；guest device-v2-r2 WorkManager
接入和 ASR/CAM++ 异步 lane 已在隔离工作树接通。Android 会议录制也已接入默认关闭的本地构建标志
与远端 `realtime_asr_v2` 双门，
但 capability 默认关闭，线上 8030 当前仍只有 `/v1/asr/batch`，尚未提供候选 `/v2/asr/batch`。
v20 搜索表保持原结构，Stage 4 才与查询仓储一起切换。聚焦证据见
[Stage 2 slice](../vnext-stage2/STAGE2-SLICE.md)；这些只证明隔离切片，不代表 Stage 2 退出。
最新完整后端回归的精确结果与旧合同失败边界见
[2026-08-19 回归复核](../vnext-stage2/RECHECK-20260819.md)，不要继续引用过期的 `488/17` 统计。

2026-08-20 的候选将上传校验时已经读取的压缩媒体流复用为私有、有界、事务提交后才可见的临时缓存，
避免 worker 再做一次公开 R2 Range 下载；R2 仍为恢复来源，终态或孤儿缓存会被确定性清理。使用隔离
API/数据库/R2 前缀和 loopback v2 测试桥、但复用生产 GPU0 上完全相同的 Qwen3-ASR-1.7B/revision，
30 条真实媒体全链路首段 p95 为 `2.877s`、RTF p95 为 `0.140411`，30/30 文本、单 final 与清理均通过。
这关闭了选定架构的首段/RTF 性能项；纯 CPU 和 8 秒片段路线被否决。正式 8030 v2 handler 部署、
Android/质量/混合负载、公开零流量和 capability barrier 当时仍开放，详见
[校验媒体复用与 GPU0 回放](../vnext-stage2/VERIFIED-MEDIA-CACHE-GPU-20260820.md)。

2026-08-21 已在 `emulator-5562` 对隔离 `18031/8031` 完成真实原生 v2 网络中断与 App 进程死亡组合
回放；恢复后只有一个 WorkManager operation、一个 transcript task/attempt 和一个本机 active revision，
115 个最终片段的稳定键无重复。独立静音文件通过同一路径形成 `no_speech` 成功结果、空错误码和零片段。
再合并 10 分钟全局混合负载、1 GiB 上传内存及本轮 cleanup/SQLite 审计后，Stage 2 历史运行/资源
子集为 `19/20`；该数字未包含 CER、数字时间、speaker overlay 和已登记/未知讲话人质量，不能表示
Stage 2 只差一个门。质量感知预检已补齐这些门；正式 8030 v2 部署、公开零旧提交周期及 capability
人工采用仍开放，详见
[Android v2 网络与进程恢复](../vnext-stage2/ANDROID-V2-NETWORK-PROCESS-RECOVERY-20260821.md)。

当前 10 组 MP4/SRT 各抽 3 个窗口的弱参考诊断得到 CER 中位数 `5.56%`、p95 `41.67%`、数字/时间
`89.71%`；最高误差窗口已确认包含明显字幕漏句/错词，因此结果只能生成独立校正清单，不能判定模型
通过或失败。证据边界见
[ASR 弱字幕诊断](../vnext-stage2/ASR-SRT-WEAK-DIAGNOSTIC-20260821.md)。

同日独立 speaker overlay 在隔离候选完成 30 次真实 6 秒语音暖态回放，`30/30` 成功，文字完成后的
overlay p50/p95/max 为 `479.6/629.6/702.5 ms`，所有 binding/epoch 清理均确认，回放后数据库、任务和
两个加密 spool 均已收敛。退出预检同时要求至少 30 条样本，质量感知结果更新为 `20/28`；剩余 8 项仅为
独立人工 ASR/讲话人质量的 7 项门和公开零旧提交周期。回放发现并修复 Uvicorn WebSocket 原始路径日志
泄漏，修复候选的外层/Tee 两份真实日志动态扫描均为 0 项。证据见
[speaker overlay 暖态回放](../vnext-stage2/SPEAKER-OVERLAY-WARM30-20260821.md)。

隔离 8031/18021 候选已完成真实 `/v2/asr/batch`、R2 上传、尾索引媒体 HTTP Range 解码、连续文字
事件、ACK/cleanup、API 中断恢复和 ASR 推理中断恢复，详见
[Stage 2 真实候选证据](../vnext-stage2/REAL-CANDIDATE-20260818.md)。ASR revision 现在要求固定值，
否则服务 fail-closed。
最新无字幕完整视频回放和严格返回合同校验见
[ASR full replay](../vnext-stage2/ASR-FULL-REPLAY-20260819.md)；该证据仍只属于隔离 CPU 候选。
真实 device-v2 R2 上传、稳定/最终事件、ACK、测试时钟清理和 R2 对象不存在见
[device-v2 R2 probe](../vnext-stage2/DEVICE-V2-R2-REAL-PROBE-20260819.md)。
32 MiB multipart 四片上传、合并、转写事件、ACK 和 purge 也已在候选回放通过，见
[multipart R2 replay](../vnext-stage2/MULTIPART-R2-REPLAY-20260819.md)。
当前隔离 API 已部署 `47640f3`，并显式绑定候选 `8031`（部署记录见
[candidate deployment](../vnext-stage3/CANDIDATE-DEPLOY-47640F3-20260819.md)；旧候选仍可回滚）；生产 `18020/8030`
仍未修改。
双上传+realtime 的身份和优先级已通过 CPU 候选，但 16.224 秒 realtime 只证明队列顺序，不满足
生产延迟。Android 网络/进程恢复、手机连续文字投影、NO_SPEECH 和混合负载门已由后续回放关闭；
下一入口是独立转写/讲话人质量、正式 8030 v2 handler、公开零流量周期与 capability barrier；
不得重放 Stage 0/1，也不得激活生产 capability barrier。当前登记的 12 个会议
视频和 10 份弱参考字幕已经冻结为验收来源之一，见
[会议视频验收样本清单](../vnext-acceptance/meeting-video-samples-20260817.md)；字幕不是 ground truth，且
不得进入生产 prompt、规则或样本专用补丁。只有 Stage 2–5 的实施、迁移和发布门通过后才可声明生产采用。
2026-08-19 复核实际目录仍为 12 个 MP4、10 个同名 SRT，视频哈希与清单逐项一致，见
[样本快照复核](../vnext-acceptance/SAMPLE-SNAPSHOT-VERIFY-20260819.md)。

兼容设备转写补全路径现已将“任务明确完成、响应完整但无文字”收敛为成功的 `no_speech` 内容结果，
不再把明确的无语音录音标记为可重试失败；该修复仍属于隔离候选，后续已经过专属 Android 设备回放。
真实一秒全零 PCM 曾在旧 8031 被 Qwen 幻觉为“嗯。”；`0eae538` 统一 ASR coordinator 现以可配置的
保守 RMS/峰值双门在模型前收敛数字静音，并已在隔离 8031 对相同输入返回稳定 `no_speech`、
空文本和 `infer_ms=0`。生产 8030 未改变；专属 Android 无语音/中断回放已在 2026-08-21 闭合。

随后在隔离候选完成了正式 device-v2 WebSocket 的真实短语音回放：一条真实会议语音在第 5 个分片后
断线并从服务端游标恢复，得到 stable/final `text`；一条无语音输入得到 final `no_speech`，两次均完成
binding purge。证据见 [device-v2 realtime reconnect](../vnext-stage2/DEVICE-V2-REALTIME-RECONNECT-20260819.md)。
Android v2 客户端同时修复了不足 1ms PCM 尾部导致的无效 wire frame，并完成 `:app:compileDebugKotlin`。
这只闭合候选协议、客户端帧边界和服务端清理；服务端同一会话的 token refresh + 游标恢复
已有候选回放证据，但仍不替代 Android 进程死亡、原生 token refresh 和页面投影验收。

Stage 4 已新增连续 0045 迁移，将日程来源哈希、生产者 revision、Graph schema revision 和事件
revision 纳入本机 `local_schedule_events`，并将本机搜索切换到外部内容 FTS5 文档表；隔离的
Graph producer/validator 已接入默认关闭的 device-v2 capability 和手机解析/澄清 owner；
Graph 来源/revision 已贯穿确认、详细编辑和本机 CRUD；ProjectionEnvelope 已在隔离 worktree 接入
Calendar/Minutes native snapshot parser、stale reducer 和 mutation/action 回显，并提供默认关闭的
三个页面生成协调器。Stage 4 的 0045 迁移还加入唯一的本机 projection checkpoint owner，按
device epoch / surface / entity 持久恢复 revision/hash fence，幂等接收同版本同 hash 并拒绝旧版本；
候选流量尚未启用且未跨 capability barrier，证据见
[Stage 4 日程切片](../vnext-stage4/STAGE4-SLICE.md)。本机 v45 SQLite/FTS 迁移回放和 12,000 条搜索
工作负载、projection checkpoint 关闭重开回放已通过；`emulator-5562/LaoJi_API_35` 已继续完成
calendar、recording、transcript 三页面同实体重建和详情 tab 稳定性回放，并在 JS action 执行前增加
全身份 fence，见 [ProjectionEnvelope 全局 Android 回放](../vnext-stage4/PROJECTION-GLOBAL-ANDROID-REPLAY-20260820.md)。
真实 native 日历操作跨 JS bridge 排队并在新快照后恢复的竞态已验证为 `projection_stale`，且本机日程
没有被修改；独立人工日程质量、语音 p95、公开零流量周期和 capability barrier 仍未通过，因此
Stage 4 仍是未采用的隔离候选。
Graph owner 边界已进一步收敛：候选 Graph 路由强制 `model_only`，请求透传调用方 `client_intent`，
producer 不再导入旧 intent classifier 或在缺少 observation 时隐式同步 fallback；空模型观察失败关闭。
这只是一项候选静态/集成边界修复，不改变生产 `/parse`，证据见
[Graph owner boundary](../vnext-stage4/GRAPH-OWNER-BOUNDARY-20260819.md)。
随后客户端复杂解析/澄清准入也已收敛：本机只保留简单高置信快速路径，复杂 `create/clarify` 在
构建开关与 device-v2 capability 同时成立时进入 Graph；能力缺失直接失败关闭，不回落旧解析，
Graph 草稿澄清不会把补充拆成独立输入。查询/删除/拒绝不进入模型创建候选。该切片仍默认关闭，
证据见 [移动端 Graph owner boundary](../vnext-stage4/MOBILE-OWNER-BOUNDARY-20260819.md)。
隔离候选的统一 `/api/ready` 又发现并修复了 embedding 探测阻塞健康请求的问题：现在使用单飞后台
刷新和最近状态缓存，冷启动明确返回 `ready=false` 而不是长时间无响应。代码和候选验证见
[readiness probe latency boundary](../vnext-stage5/READINESS-PROBE-20260819.md)；尚未部署远端，
不代表生产 readiness 延迟已改善。
Stage 2 退出门现在有统一的只读聚合预检 `tools/vnext/verify_stage2_exit_preflight.py`，对 Android
恢复、性能/资源、speaker overlay、独立 ASR/讲话人质量、候选清理和旧公开零流量逐项 fail-closed；
历史 `19/20` 只代表运行/资源子集，speaker overlay 已由 30 次证据关闭，质量感知 schema v2 仍有
8 项阻断，证据见
[Stage 2 exit preflight](../vnext-stage2/STAGE2-EXIT-PREFLIGHT-20260819.md)。
Stage 4 同样增加了只读聚合预检，要求独立日程人工 holdout、语音 p95、页面重建/stale action、FTS
和旧 schedule submit 零流量证据；当前仅静态/迁移门通过，真实 Android 与质量 envelope 缺失，证据见
[Stage 4 exit preflight](../vnext-stage4/STAGE4-EXIT-PREFLIGHT-20260819.md)。
自然日程 150 条盲审队列的来源和注册分布自动审计已通过，但双人母语标注与裁决仍缺，见
[自然日程语料审计](../vnext-stage4/NATURAL-SCHEDULE-VALIDATION-20260819.md)。
2026-08-20 已把双人盲审、揭盲裁决、冻结后预测、开发集重叠审计和指标计算固化为可执行证据包；
Stage 4 预检只接受带完整哈希血缘的 `schedule-human-holdout-v1` 报告，旧的手填布尔值/指标会失败关闭。
公开本地化或编写语料仍不能晋级，真实第一方双人 gold 尚未提供，见
[自然日程盲审与质量证据包](../vnext-stage4/NATURAL-HOLDOUT-EVIDENCE-PACK-20260820.md)。
模型时间范围两种自然语序回放已通过，证据见
[日程模型时间范围回放](../vnext-stage4/SCHEDULE-MODEL-RANGE-REPLAY-20260819.md)。
Stage 4 语音日程 native 候选已将 `RecorderEngine` 的顺序改为本机 AudioRecord/journal/录音线程先启动，
再异步连接 realtime ASR；未连接期间的 PCM 使用既有有界队列，连接失败保留本地录音并进入恢复路径。
快照现在增加向后兼容的 `asrPhase`（connecting/connected/recoveryRequired/completed/notRequired），
让连接慢和 ASR 故障不会被 UI 当成麦克风失败；顺序/阶段合同脚本、TypeScript 和 Kotlin 编译均通过。
同时记录首个 PCM 到连接完成、首个 PCM 到首个转写事件的单调延迟，仅用于设备 p50/p95 回放统计。
专属 `emulator-5562` 的首轮 5 次真实中文回放测得旧闭段路径首文字 p95 `9256ms`。候选随后在同一
ASR owner 内实现有界 active-speech snapshot：有效讲话 `640ms` 后首个 preview、间隔至少 `1600ms`、
单会话最多 4 次，partial/final 共享 revision key 且 final 权威替换。更新后的 5 次真实会议讲话采集/
首文字 p95 为 `43/1490ms`；完整日程 TTS 3 次采集/首文字/Draft p95 为 `43/1481/2513ms`。
这证明低延迟候选可行，但不是模型级 streaming。随后改用宿主 PipeWire/PulseAudio monitor 而不是
Emulator gRPC 流，完成了同一真实 App 链路的 30 次暖态回放：采集/首文字/Draft p95 为
`97/1398/3087ms`，28/30 到达 Draft；一次是 Graph Provider 对该次转写失败关闭，一次是宿主音频注入
全零，另有一次采集启动 `517ms`。因此该批次真实记录为 `passed=false`，不能封存成退出证据。
同一规范文本的独立 Graph 复放为 30/30 成功、约 `1.98--2.22s`，把单次 503 收敛到“该次转写或
模型结构输出”的可观察性缺口，而不是固定网络断线。十分钟六通道混合负载已由提交 `05d6183` 的
独立报告关闭，不再重复执行；语音 30 样本本身仍需重跑通过。详见
[语音日程真实音频回放](../vnext-stage4/SCHEDULE-VOICE-EMULATOR-REPLAY-20260821.md)。断网、进程死亡、
正式性能 envelope、自然质量和 capability barrier 仍未完成，候选默认仍关闭。

Stage 3 当前已补齐隔离的 source stream 纵向切片：`device/v2` 默认关闭的来源流可以与 generic
Task 在一个事务创建，manifest 页和章节 group 受设备/全局数量与字节配额约束，正文使用 AES-GCM
临时加密存储；章节只能按 ordinal 消费，恢复点固定为两个交替槽，每槽最多 4 MiB。已验证的 Facts
V3 章节经过确定性 reducer 合并到 40 条事实、48 条关系和 10 条行动候选上限，最终结果与 Task
成功状态在同一事务写入加密 artifact，失败恢复不会再次调用已经完成的章节 provider。该切片已有
SQLite、API、加密、取消、租约丢失、三章双槽、artifact 回放和旧 Summary V3 回归证据。
移动端 source-stream client 已接入 Device V2 合同，并已挂入整理服务的双开关候选编排（来源构造、分章上传、任务恢复和
artifact 投影）；章节上传已按服务端两组未消费上限反压，任务恢复会核对 `input_sha256/source_stream_id`
并补传未完成的 manifest/group，移动端响应字段也已与服务端 `received_*` 合同对齐。默认 capability/feature flag
关闭，稳定整理入口不会产生 source-stream 流量。服务端已有独立单 worker
消费 active source-stream task，每次最多处理一章，租约心跳和重启扫描可恢复；仍缺 Q2 的真实语义 holdout、设备回放和
capability barrier，
因此不能称为 Stage 3 退出，
也没有改变当前稳定版服务流量。

Q2 已从 fake transport 推进为默认关闭的真实 reader 候选：服务端 `questions-v2` 使用严格请求模型、设备
binding fence、单次本地 Provider 调用和 UTF-8 来源校验；移动端以 `questionQ2Candidate` 双开关接入
Q2 snapshot/thread/turn/clause/citation 仓储，并把只读结果投影到现有问答页。来源仅包含当前转写和用户明确纳入的
我的笔记，不把整理结果或历史答案提升为证据；失败重试会更换 device operation 并复用、重新绑定原未完成 turn，
不会按新的 ordinal 留下重复问题。隔离候选已用真实 `qwen3.5:9b` 对 5 个弱参考样本问题完成 smoke，期间
修复了 Qwen 紧凑引用结构和不可靠坐标的确定性归一化；明确未提及问题的 3 题拒答 smoke 也已通过，
但这不等于完整语义 holdout。当前仍未
通过独立自然问题、拒答质量、LaoJi 专属设备回放和 capability barrier，不能称为 Stage 3 退出。
2026-08-19 的隔离真实回放复核见
[Stage 3 rerun](../vnext-stage3/REAL-HOLDOUT-RERUN-20260819.md)；该报告仍明确区分字幕窗口证据与
完整视频、人工质量和设备门禁。
同日完成的真实视频 ASR→Facts V3 串联回放见
[ASR to Facts](../vnext-stage3/ASR-TO-FACTS-20260819.md)；首次暴露的输出截断已在 `facts-v3-r6`
提示词中修复并复验通过。随后 `facts-v3-r7` 增加了“结果/指标不是行动候选”的通用语义边界，
聚焦回放见 [Facts V3 r7](../vnext-stage3/FACTS-V3-R7-FOCUSED-REPLAY-20260819.md)；该提示词仍未
包含样本内容，且只属于隔离候选证据。`facts-v3-r8` 已加入主要议题覆盖、单次输出条数上限、
截断保护和错位根字段清理；9 个当前样本 Facts 用例复跑为 `9/9`，见
[Facts V3 r8](../vnext-stage3/FACTS-V3-R8-REPLAY-20260819.md)。Q2 当前样本 27 题复跑为 `27/27`，见
[Q2 当前样本复跑](../vnext-stage3/Q2-CURRENT-SAMPLE-R2-20260819.md)；这仍不是人工引用相关性
或 Android 验收；最终 r8 提交状态再次复跑仍为 `27/27`。新增无字幕完整视频 `1221445661-1-192.mp4` 的 ASR→Facts r8 回放为 `PASS`，
证据见 [无字幕视频回放](../vnext-stage3/ASR-TO-FACTS-1221445661-R8-20260819.md)。
超预算长会证据包已在隔离候选真实调用 `qwen3-embedding:0.6b` 并完成一次 Facts 生成；MMR 选段比例
不能替代人工事实支持率，详见 [长会 embedding 回放](../vnext-stage3/LONG-EMBEDDING-REPLAY-20260819.md)。
Q2 reader 另已增加默认关闭的有界 raw-source retrieval：完整来源不超过预算时原样进入模型，超预算时由本地
embedding 按问题、纠正/时间/负责人信号和相邻上下文选择，引用仍绑定完整 immutable snapshot；该切片不替代
尚未闭合的 Q2 source-stream 消费链，证据见
[Q2 bounded retrieval](../vnext-stage3/Q2-BOUNDED-RETRIEVAL-20260819.md)。随后补齐了候选 Q2 source-stream
纵向切片：长来源可按最多 8 个 bundle 上传，最后一章提交后进入 `complete`，服务端以 generic Task lease
读取完整加密来源并只调用一次 Q2 reader；成功结果、Task `content_outcome` 和来源/预约清理在同一事务提交，
provider 失败保留可重试任务，重放可用 task ID 幂等读取。短来源仍使用原直接请求路径。该切片默认关闭，
未改变稳定问答或生产流量，证据见
[Q2 source-stream](../vnext-stage3/Q2-SOURCE-STREAM-20260819.md)。
随后对当前 78 分钟视频执行了完整音频 ASR→Facts V3 候选回放：336 个 ASR 分片、335 个文本段、
一次 Facts 模型调用，结果合同通过；证据见
[长会议完整视频回放](../vnext-stage3/ASR-TO-FACTS-1437681208-LONG-20260819.md)。这仍不等于
人工事实质量、移动端 source-stream 恢复或 capability barrier 已通过。
移动端 source-stream 清单提交随后补上了有界分页和恢复：清单不再假设所有章节必须在首个请求中
一次提交，进程在中途退出后会从 `next_manifest_page/next_manifest_chapter` 继续，并对容量等待和
响应丢失使用同页幂等重放；候选接口仍默认关闭，未改变稳定整理入口。
Q2 grounding 随后增加了确定性最小相关性门：逐字引用还必须与回答分句或问题共享中文/数字短语，
否则 fail-closed，避免“引用真实但与回答无关”。该修复只属于隔离候选，人工引用相关率和 Android
回放仍未通过，证据见 [Q2 citation relevance gate](../vnext-stage3/Q2-CITATION-RELEVANCE-GATE-20260819.md)。

2026-08-20 的 r5 稳定资源回放已关闭 Stage 3 的 Summary 暖态性能门：相同 10 份完整字幕每份三轮
共 30/30 一次成功，单包 p50/p95 为 `15.368s/35.498s`，含双章节长会的完整证据路径 p95 为
`60.483s`；所有显示引用逐字匹配，临时任务与来源均 purge-confirmed。该改进来自 Summary embedding
固定 CPU，避免挤出 GPU0 上常驻的 9B 生成模型；未改提示词或事实协议。详见
[r5 稳定延迟](../vnext-stage3/SUMMARY-V3-R5-STABLE-LATENCY-20260820.md)。Stage 3 仍缺独立人工事实/行动
与 Q2 质量、公开零 v1 流量周期和 capability barrier，不能采用或删除旧链路。

同日 Stage 3 又完成了隔离 Summary/Q2 并发纵向切片。Question stream 不再占用 Summary checkpoint
和 active manifest 配额；Provider 支持后台 Summary checkpoint 重试前让出交互请求；Summary 与 Q2
统一使用 CPU/2K embedding runner，并以正文 SHA-256 + runner options 共享同一 360 字/30 秒来源
向量。`q2-reader-v2` 对并列回答逐项校验当前来源、数字和否定极性，只删除无依据子项，不生成补丁
答案。冷缓存 5 pair / 10 条真实流全部成功，实际重叠 Q2 p50/p95/max 为
`10.991s/12.897s/13.271s`，显示引用逐字匹配、幂等重放和清理均为 `100%`。详见
[Stage 3 Summary/Q2 混合切片](../vnext-stage3/STAGE3-SUMMARY-Q2-MIXED-20260820.md)。随后提交
`05d6183` 在全新迁移数据库上完成蓝图规定的 10 分钟全服务混合负载：日程 p95 `1.794s`、Q2
p95 `11.249s`、Summary p95 `13.953s`、实时 stable p95 `1.845s`、导入首段 p95 `3.291s`、
导入 RTF p95 `0.129`，资源和清理门全部通过。根因是原日程 8K 与 Summary/Q2 16K context 使
同一 9B Ollama runner 反复重载；现已统一为部署级 16K resident runner。证据见
[全局混合负载](../vnext-global/GLOBAL-MIXED-LOAD-20260820.md)。这关闭混合负载性能缺口，但不替代
独立人工 `>=95%` 质量门、公开零 v1 流量周期或 capability barrier，Stage 3
继续保持未采用。

同日，Facts V3 Android 激活围栏在 `emulator-5562` 补齐了 binding revision 与明确授权文字附件
revision 两种原生迟到结果竞态。远端旧来源 task 均可独立完成，但手机恢复时会把它收敛为
`input_changed`、清除 pending intent、保留上一份可用整理，不写入迟到 artifact。device-primary
文字附件能力不再依赖 account endpoint；无 task ID 的孤儿 preparation 状态可安全清理；首次提交和
重启恢复统一使用 canonical transcript revision 构造来源身份。最终 Release 候选为 `1.1.38 (146)`，
测试附件、immutable revision 和 test APK 已清除，本机数据库完整性为 `ok`。证据见
[Facts V3 激活围栏矩阵](../vnext-stage3/SUMMARY-V3-ACTIVATION-FENCE-MATRIX-20260820.md)。同一专用模拟器
随后又逐项完成 binding epoch、附件删除、附件移位与附件正文变化四种原生竞态；四个远端 Task 均先独立
成功，手机恢复后均拒绝迟到 artifact、清空 intent 并保留旧结果。最终审计中 Facts 为 `15`、intent 为
`0`，SQLite integrity 为 `ok` 且无外键违规；夹具和 test APK 已清除。Summary V3 选定的原生来源变化
矩阵由此关闭；独立人工质量、公开零 v1 流量周期与 capability barrier 仍开放，
因此 Stage 3 继续保持未采用。

2026-08-21，Q2 当前笔记/明确附件、同 Task 恢复、附件变化和 binding epoch 的 Android 原生恢复矩阵
已闭合，见 [Q2 附件与跨快照恢复](../vnext-stage3/Q2-ANDROID-ATTACHMENT-RECOVERY-20260821.md)。同日旧整理
后台升级完成 115 段失败任务收敛和 1,357 段运行中进程死亡恢复：过长稳定 Transcript ID 不再进入有界
传输别名；旧不匹配 Task 被精确取消；长会重启后沿用同一 Task/Attempt，只新增一个原子版本且旧版本
始终可读。测试夹具已精确还原，升级队列为 0，SQLite 完整性、外键和 7 条会议投影通过。证据见
[旧整理升级恢复](../vnext-stage3/SUMMARY-V3-LEGACY-UPGRADE-RECOVERY-20260821.md)。Stage 3 的剩余门由此收敛为
独立人工 Facts/行动/Q2 质量 `>=95%`、公开零旧链路周期与 capability barrier；仍不得采用或删除旧链路。

同日 Q2 完整来源评估器增加了 Git 工作树外 `0600` 私有盲审包、逐题原子检查点、断点续跑和失败题
精确重试。27 题真实候选回放先暴露 4 类 provider 形态波动，候选以“只删除无依据分句、全部无依据
仍失败”的确定性投影关闭列表序号、空缺失分句和跨相邻 ASR 行引用问题；最终自动回放 `27/27`、
逐字引用 `100%`，暖态 p95 `11.529s`。私有包已有 27 行但人工字段仍为空，所以只关闭了可审阅证据包
和自动化稳定性，不关闭独立人工 `>=95%` 门。见
[Q2 独立盲审包](../vnext-stage3/Q2-BLIND-REVIEW-PACK-20260821.md)。

Facts/行动候选也已对 10 份完整 SRT 通过真实 device-v2 source stream 生成独立私有盲审包：自动回放
`10/10`、104 条事实、4 个行动候选、233 条引用全部逐字匹配并 purge-confirmed；单章节 p95
`41.791s`，两章节 p95 `65.063s`，满足既定 `45s/90s` 路径门。私有包含完整来源和逐事实/逐行动
人工字段，但字段仍为空，因此不把自动化结果冒充事实支持、重要遗漏或行动质量通过。见
[Facts/行动完整来源盲审包](../vnext-stage3/FACTS-ACTIONS-BLIND-REVIEW-PACK-20260821.md)。

同日 `1.1.46 (154)` 将四模板可见说明与 Facts V3 的稳定投影块对齐，并在 `emulator-5562` 逐项切换
通用、1:1、项目同步和访谈。切换窗口候选 API 日志保持 `139 -> 139`，选择“项目同步”后强制重启仍
恢复同一偏好，整理版本页也没有产生新版本。确定性合同与 activation fence 合并 `26/26` 通过，100 次
暖态本地投影约 `7ms`。这关闭模板本地切换和说明漂移，不关闭独立人工质量或 Stage 3 adoption；见
[四模板本地投影合同](../vnext-stage3/SUMMARY-V3-TEMPLATE-PROJECTION-CONTRACT-20260821.md)。

随后 `1.1.47 (155)` 使用可恢复的 Release-target SQLite 夹具，在 `emulator-5562` 对八种 Facts V3
白名单富块完成标准蓝和绚彩可见回放。回放发现“后续问题”被旧“后续*”行动区前缀误判并隐藏；候选将
规范化标题分类收敛为无依赖纯函数，明确保留问题类 section，同时继续识别“后续行动”。回归与
activation fence 合并 `27/27` 通过；两主题下段落、项目符号、引用、时间线、窄屏流程退化、方案对比、
风险卡和统计均可见。原 Facts JSON、主题和模板偏好已恢复，临时备份表和测试包已清除，SQLite 完整性
通过。该证据关闭富块视觉门，不关闭独立人工质量、公开零旧链路周期或 capability barrier；见
[富内容 Android 回放](../vnext-stage3/SUMMARY-V3-RICH-BLOCK-ANDROID-REPLAY-20260821.md)。
