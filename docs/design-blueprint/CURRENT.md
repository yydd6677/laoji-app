# 老记设计蓝图当前入口

- current architecture: `LaoJi vNext global development baseline`
- architecture revision: `vnext-1`
- baseline release: `1.1.10 (118)`
- design status: `global development baseline frozen`
- production/App/APK/device/GPU mutation: `none`
- stable source worktree: `/home/yydd/LaoJi-worktrees/feishu-source-driven`
- implementation worktree: `/home/yydd/LaoJi-worktrees/vnext-implementation`
- implementation branch: `vnext/implementation`
- stable baseline: Stage 0 frozen at `1.1.10 (118)`
- implementation status: `Stage 0 passed; Stage 1 passed; Stage 2 in progress; Stage 3 source-stream/Facts-V3 artifact candidate and Stage 4 schedule provenance slices implemented in isolation`

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

三份 vNext 文件已经冻结为全局开发基线，但不是生产采用证明。Stage 0 已冻结稳定版本；Stage 1 已在
隔离工作树完成 0040–0042、本机 owner、device v2、generic task owner 与原生 purge-only capability，
退出记录见 [Stage 1 exit](../vnext-stage1/STAGE1-EXIT.md)。未部署服务、未切公开流量、未发布或安装 APK。

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

隔离 8031/18021 候选已完成真实 `/v2/asr/batch`、R2 上传、尾索引媒体 HTTP Range 解码、连续文字
事件、ACK/cleanup、API 中断恢复和 ASR 推理中断恢复，详见
[Stage 2 真实候选证据](../vnext-stage2/REAL-CANDIDATE-20260818.md)。ASR revision 现在要求固定值，
否则服务 fail-closed。
双上传+realtime 的身份和优先级已通过 CPU 候选，但 16.224 秒 realtime 只证明队列顺序，不满足
生产延迟。下一入口是 Android 网络/进程恢复、手机连续文字投影和 NO_SPEECH/性能门；
不得重放 Stage 0/1，也不得激活生产 capability barrier。当前登记的 12 个会议
视频和 10 份弱参考字幕已经冻结为验收来源之一，见
[会议视频验收样本清单](../vnext-acceptance/meeting-video-samples-20260817.md)；字幕不是 ground truth，且
不得进入生产 prompt、规则或样本专用补丁。只有 Stage 2–5 的实施、迁移和发布门通过后才可声明生产采用。

Stage 4 已新增连续 0045 迁移，将日程来源哈希、生产者 revision、Graph schema revision 和事件
revision 纳入本机 `local_schedule_events`，并将本机搜索切换到外部内容 FTS5 文档表；隔离的
Graph producer/validator 已接入默认关闭的 device-v2 capability 和手机解析/澄清 owner；
Graph 来源/revision 已贯穿确认、详细编辑和本机 CRUD；ProjectionEnvelope 仍未包裹 native 页面
快照/动作，且未跨 capability barrier，证据见
[Stage 4 日程切片](../vnext-stage4/STAGE4-SLICE.md)。

Stage 3 当前已补齐隔离的 source stream 纵向切片：`device/v2` 默认关闭的来源流可以与 generic
Task 在一个事务创建，manifest 页和章节 group 受设备/全局数量与字节配额约束，正文使用 AES-GCM
临时加密存储；章节只能按 ordinal 消费，恢复点固定为两个交替槽，每槽最多 4 MiB。已验证的 Facts
V3 章节经过确定性 reducer 合并到 40 条事实、48 条关系和 10 条行动候选上限，最终结果与 Task
成功状态在同一事务写入加密 artifact，失败恢复不会再次调用已经完成的章节 provider。该切片已有
SQLite、API、加密、取消、租约丢失、三章双槽、artifact 回放和旧 Summary V3 回归证据，但尚未
接入手机 source repository、Q2、真实模型/样本或 capability barrier，因此不能称为 Stage 3 退出，
也没有改变当前稳定版服务流量。

Q2 已增加默认关闭的 `questionQ2Candidate` fake-transport adapter：它从当前 immutable evidence
创建 snapshot/thread，provider 只接收脱离可变状态的来源视图，回答分句必须完整覆盖答案并逐字匹配
UTF-8 引用，随后才写入 Q2 clause/citation 表。该 adapter 仍没有接入实际 reader，也没有改变现有
问答 UI；语义 holdout、真实 provider 和 capability barrier 仍是 Stage 3 未完成项。
