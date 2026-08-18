# 老记设计蓝图当前入口

- current architecture: `LaoJi vNext global development baseline`
- architecture revision: `vnext-1`
- baseline release: `1.1.10 (118)`
- design status: `global development baseline frozen`
- production/App/APK/device/GPU mutation: `none`
- stable source reference: `master` / `v1.1.10`
- implementation reference: `vnext/implementation`
- source and runtime paths are intentionally environment-specific; use repository-relative paths and deployment variables
- implementation branch: `vnext/implementation`
- stable baseline: Stage 0 passed at `1.1.10 (118)`; see [Stage 0 exit](../vnext-stage0/EXIT-20260818.md)
- implementation status: `Stage 0 passed; Stage 1 passed; Stage 2 in progress; Stage 3 source-stream/Facts-V3 artifact candidate and Stage 4 schedule provenance slices implemented in isolation; 1.1.13 (121) candidate archived`

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
- Stage 5：删除 account/sync、旧上传、summary v2、Q0、重复 parser、mirror/fallback 并发布。

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
当前隔离 API 已部署 `6a80576`，并显式绑定候选 `8031`（部署记录见
[candidate deployment](../vnext-stage2/CANDIDATE-DEPLOY-6A80576-20260819.md)；旧 `71cf466`/`f6974e0`/`db8259a` 可回滚）；生产 `18020/8030`
仍未修改。
双上传+realtime 的身份和优先级已通过 CPU 候选，但 16.224 秒 realtime 只证明队列顺序，不满足
生产延迟。下一入口是 Android 网络/进程恢复、手机连续文字投影和 NO_SPEECH/性能门；
不得重放 Stage 0/1，也不得激活生产 capability barrier。当前登记的 12 个会议
视频和 10 份弱参考字幕已经冻结为验收来源之一，见
[会议视频验收样本清单](../vnext-acceptance/meeting-video-samples-20260817.md)；字幕不是 ground truth，且
不得进入生产 prompt、规则或样本专用补丁。只有 Stage 2–5 的实施、迁移和发布门通过后才可声明生产采用。

兼容设备转写补全路径现已将“任务明确完成、响应完整但无文字”收敛为成功的 `no_speech` 内容结果，
不再把明确的无语音录音标记为可重试失败；该修复仍属于隔离候选，尚未经过专属 Android 设备回放。
真实一秒全零 PCM 曾在旧 8031 被 Qwen 幻觉为“嗯。”；`0eae538` 统一 ASR coordinator 现以可配置的
保守 RMS/峰值双门在模型前收敛数字静音，并已在隔离 8031 对相同输入返回稳定 `no_speech`、
空文本和 `infer_ms=0`。生产 8030 未改变，Stage 2 仍缺专属 Android 设备无语音/中断回放。

Stage 4 已新增连续 0045 迁移，将日程来源哈希、生产者 revision、Graph schema revision 和事件
revision 纳入本机 `local_schedule_events`，并将本机搜索切换到外部内容 FTS5 文档表；隔离的
Graph producer/validator 已接入默认关闭的 device-v2 capability 和手机解析/澄清 owner；
Graph 来源/revision 已贯穿确认、详细编辑和本机 CRUD；ProjectionEnvelope 已在隔离 worktree 接入
Calendar/Minutes native snapshot parser、stale reducer 和 mutation/action 回显，并提供默认关闭的
三个页面生成协调器。Stage 4 的 0045 迁移还加入唯一的本机 projection checkpoint owner，按
device epoch / surface / entity 持久恢复 revision/hash fence，幂等接收同版本同 hash 并拒绝旧版本；
候选流量尚未启用且未跨 capability barrier，证据见
[Stage 4 日程切片](../vnext-stage4/STAGE4-SLICE.md)。本机 v45 SQLite/FTS 迁移回放和 12,000 条搜索
工作负载、projection checkpoint 关闭重开回放已通过；`emulator-5562/LaoJi_API_35` 也已真实完成
候选 APK 的 0045 迁移和 calendar fence 恢复，但这不等于全局 Expo SQLite/Android 迁移、真实页面重建
 或搜索性能验收，后者仍未通过。
自然日程 150 条盲审队列的来源和注册分布自动审计已通过，但双人母语标注与裁决仍缺，见
[自然日程语料审计](../vnext-stage4/NATURAL-SCHEDULE-VALIDATION-20260819.md)。
模型时间范围两种自然语序回放已通过，证据见
[日程模型时间范围回放](../vnext-stage4/SCHEDULE-MODEL-RANGE-REPLAY-20260819.md)。
Stage 4 语音日程 native 候选已将 `RecorderEngine` 的顺序改为本机 AudioRecord/journal/录音线程先启动，
再异步连接 realtime ASR；未连接期间的 PCM 使用既有有界队列，连接失败保留本地录音并进入恢复路径。
快照现在增加向后兼容的 `asrPhase`（connecting/connected/recoveryRequired/completed/notRequired），
让连接慢和 ASR 故障不会被 UI 当成麦克风失败；顺序/阶段合同脚本、TypeScript 和 Kotlin 编译均通过。
同时记录首个 PCM 到连接完成、首个 PCM 到首个转写事件的单调延迟，仅用于设备 p50/p95 回放统计。
这仍尚未经过专属设备的首帧延迟、断网和进程死亡回放，候选默认仍关闭。

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
或 Android 验收。
超预算长会证据包已在隔离候选真实调用 `qwen3-embedding:0.6b` 并完成一次 Facts 生成；MMR 选段比例
不能替代人工事实支持率，详见 [长会 embedding 回放](../vnext-stage3/LONG-EMBEDDING-REPLAY-20260819.md)。
