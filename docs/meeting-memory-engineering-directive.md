# 老记日历原生会议记忆：工程实施指示

> 文档性质：内部工程规范与实施路线，不是面向用户的产品说明。
>
> 移动端基线：`752fa8a388e6f1e533267118b2c79dfdd8654a61`
> 稳定回溯标签：`stable-before-meeting-memory-roadmap`（标签包含本文件，业务代码与上述移动端基线一致。）
> 稳定标签是不可移动的回溯点；后续实施只新增提交，不重打或强制更新该标签。
> 实施状态：Phase 0 线上契约仍待验证；Phase 1 离线数据平面进行中。默认关闭的 SQLite canonical read 已完成 Store 接线和模拟器 fail-closed 验证；canonical mutation 原语、scope ownership/revision 和 legacy mirror CAS 已由媒体导入、游客会议创建、游客会议标题/详情、游客软删除、游客录音 capture/asset、游客 Transcript 内容/revision 及游客 Summary version/section/action 七个受控 canonical-first 纵切接入 Store，并完成游客模拟器 clean mirror、写入期稳定投影、删除后 occurrence 动作恢复、录音启动失败的可恢复资产保留与冷启动 owner 恢复。游客 Transcript 纵切已把 draft 原位替换、immutable final/reprocessed、stable final 防迟到 draft 降级、较短 final 保留、Summary stale、Marker 对账和 canonical revision 收入同一事务语义。游客 Summary 纵切复用 schema v2 归一化与 immutable version 管线，保护用户编辑/已处理 action，拒绝 realtime draft、主键错配和显式 Transcript revision 错配；事务内发现输入 revision 已过期时只保存历史候选，不替换当前版本或阶段 fingerprint。账号录音上传保留 AsyncStorage registry/WorkManager 的唯一调度权，SQLite 只记录 RecordingAsset、upload phase、attempt、operation ID 和 credential generation；同 operation 的 uploaded 不被迟到失败或延迟远端列表降级。账号 MeetingNote 根 outbox 已补齐逐会议真实插入顺序、陈旧 claim 回收、complete/retry/blocked/permanent/conflict 终态和旧 API 消费器；同 scope drain 进程内串行，本机主键保持不变，远端 UUID 只写 `remote_id`，create 复用稳定 `client_request_id`，PATCH 只发送设值字段，DELETE 404 视为幂等完成。独立账号根写开关下，普通 Store 创建/编辑/删除、录音根状态、Transcript/Summary、远端刷新合并和 ASR/上传/读取/播放/分享的 local/remote ID 边界均已接入 canonical 路径；远端 merge 保护未完成 mutation、墓碑和本机内容，列表缺项不解释为删除。目标部署源码与实际 SQLite 已确认空标题、`client_request_id/location/recorded_at`、用户内幂等和 PATCH 显式清空合同并完成源码同步，但配置中的 18020/18035 服务仍未运行，账号鉴权读写、真实 WorkManager、跨设备恢复和冲突闭环尚未验证，因此普通构建的 canonical write、账号根写和账号上传写开关继续关闭。Phase 2 已形成 occurrence 与“我的笔记”的本机纵向闭环、游客迁移 journal v2、账号日程 ID 映射及账号作用域 sidecar 迁移；人工笔记和 occurrence 的服务端窄 v2 源码合同也已同步，occurrence 现有独立 outbox、按 occurrence 回查、安全附着、冲突保留和 orphan 状态。但目标服务未启动，真实账号迁移、鉴权运行、双设备收敛、待合并录音处理和真机验证仍未完成，因此 Phase 2 尚未满足退出条件。按“先框架和功能、后严格门禁”的目标执行顺序，Phase 3 已完成第二个本机纵向切片：单场 Unicode 搜索、循环匹配导航、范围/播放段落高亮、无音频 seek 保护、选择复制/分享、snapshot v3，以及 Draft/Final 完整性判定、inactive final 持久化和条件式 active revision 切换已实现；详情暂态不再清除后台 MediaSession、相同 source 命令幂等、同录音 URL 更新保位及 stale callback 防护也已落地。服务端明确 completeness 字段、60 分钟真机精度与带有效录音的后台返回录像仍待完成。
> Phase 4 已进入连续纵向切片：schema v2 sections/citations、immutable version、受保护版本不自动覆盖、本机候选/历史版本选择、snapshot v5、可定位引用、本机行动项手动创建/编辑/完成/忽略恢复/来源/提醒/后续日程，以及 capability 默认关闭的 action outbox 消费骨架已接通。SUM-02 的服务端 segment-ID prompt、compact/Map-Reduce 来源保留、canonical 时间/quote 校验、唯一 quote 回填、漂移哈希与来源感知 action identity 已同步到目标源码。服务端 `action_items_v2` 已完成稳定 ID、幂等重放、entity revision、If-Match/If-None-Match、409/412 当前版本返回和可靠 upsert；客户端已完成冲突可见、版本选择、旧 operation 取代、云端字段应用和本机版本新 operation 的原子闭环。新增会议级 action collection 使用不透明 `(updated_at, id)` cursor，并以独立 `action_items_pull_v2` capability 控制详情页 pull；客户端已接通完整 provenance 解析、cursor CAS、新建/单调更新/精确附着/冲突保留、active Transcript segment 唯一映射和提醒对账。上行来源也已改用 provider/server 稳定 segment identity，不再发送本机主键。目标服务未启动，新表尚未实例化，因此真实模型引用质量、运行合同、账号 ACK/重试、真实冲突选择和跨设备收敛仍未验证。全账号 change feed、全局 `sync_cursor`、batch、action tombstone 和跨会议同步仍未完成。验证遵循“轻测试、轻校验”，严格样本与归档门禁后置。
> Phase 5 已完成四个本机纵向切片。Marker 已接通录音中/暂停态固定入口、canonical SQLite 事务、active Transcript 覆盖段对账、详情定位/删除、显式转待办和最小披露文字分享。文件选择与 Android 系统分享已接通持久 Intent inbox、原生流式摄取、可恢复 journal、`MeetingNote + RecordingAsset(imported)`、统一详情/播放器和 snapshot v8；专用确认页已接通标题、录制时间、可选 occurrence、作用域持久 draft 与已有会议拒绝，模拟器已验证系统“文件”的冷/热启动分享、短窗口 URI 去重、多选中文拒绝、日期/时间 picker、键盘稳定、日程冲突、播放器与重启对账。分层分享已接通内容级勾选、安全默认、私人笔记二次确认、文档/音频/ZIP 产物和最小审计；模拟器已验证默认文档、显式音频 ZIP、默认状态复位和全不选禁用。删除语义首个纵切已统一四个入口：本机/未同步会议明确永久删除，当前没有服务端回收站证据时不虚构可恢复；录音中、暂停和 finalize 状态在 UI 与 Store 双层阻止。当前线上 capability 与会议端口不可达且没有 USB 真机；服务端上传/转写、处理语言合同、视频、已有会议显式合并、强杀/大文件/格式矩阵、真实录音 Marker、Marker/附件分享、分享链接、远端删除 tombstone 重试及真实 soft-delete/回收站仍未完成，因此 Phase 5 尚未满足退出条件。
> Phase 6 已完成 ENTRY-01、ENTRY-02、TPL-01 与 SERIES-01 会前记忆的本机纵向切片。ENTRY-01 已接通日程通知中文 action、默认查看/明确记录语义、pending intent、App Lock 后置执行、统一 occurrence 用例和去重；ENTRY-02 已接通固定 scheme、严格语义链接、最小未来日程投影、近期日程 Widget、隐私标题和临时会议 Quick Settings Tile；TPL-01 已接通四个版本化内置模板、模板感知的任务身份/恢复/结果校验、不可变 Summary version 保护，以及详情页模板选择 sheet；SERIES-01 已接通规范系列身份、最近 ended 会议、最多三条决定、最多五条同系列 pending action、来源跳转、可靠决定 citation 定位、用户明确选择后带入新会议人工笔记，以及与笔记授权分离的新 Summary 历史参考选择。授权 request ID、完整项目 identity、模板和 Transcript 进入同一任务 fingerprint/pending 恢复链，服务端校验账号来源归属并回传同一 identity；有授权时不走无法接收上下文的 compact 快路径。migration v13 的逐来源实体 ledger 已实测覆盖部分重叠选择，完成原 action 后会前投影同步消失。模板与 carry-forward additive 适配已同步到共享服务器目标工作区；模板批次通过 81 项 API/任务/解析合同与 34 项 meetingsummary 底层测试，carry-forward 隔离候选另通过 56 项相关合同。目标 18020/18035 服务没有启动或重启。App Lock 生物识别实测、真机/不同 ROM、成功持续录音、Tile active、ended 详情、过期投影跨时钟、账号并发冲突、真实模型四模板/历史参考输出、远端运行和新授权 sheet 的恢复数据设备交互仍未完成，因此 Phase 6 尚未满足退出条件。证据见 [`implementation/contracts/phase-6-entry-evidence.md`](implementation/contracts/phase-6-entry-evidence.md)、[`implementation/contracts/phase-6-template-evidence.md`](implementation/contracts/phase-6-template-evidence.md) 与 [`implementation/contracts/phase-6-series-memory-evidence.md`](implementation/contracts/phase-6-series-memory-evidence.md)。
> Phase 7 已完成 SPK-01 的本场修正纵向切片，并建立 capability-gated 账号 correction outbox 客户端框架。migration v11/v12、匿名 speaker cluster、不可变 correction/assignment、段落与本场同簇更名、游客本机名称、Summary stale 保护、realtime draft 阻止、飞书来源的修改讲话人 sheet、独立远端 Transcript revision 映射、幂等提交/退避/冲突记录均已接通；本场更名不会建立声纹资料，缺少服务端 segment 身份时也不会上传本机 hash。模拟器已完成本场修改、持久化、v10→v11→v12 迁移和最终 v13 无夹具恢复验证。远端当前不可达（先前返回 502，最终直连无 HTTP 响应），因此 capability 开启、真实账号 correction、跨设备同步、`future_profile`、旧会议重新匹配、真实中文多人准确率改善和 USB 真机仍未完成，Phase 7 尚未满足退出条件。证据见 [`implementation/contracts/phase-7-speaker-assignment-evidence.md`](implementation/contracts/phase-7-speaker-assignment-evidence.md)。

> NOTE-01 / CAL-01 增量状态：人工笔记已具备账号级窄云同步闭环；occurrence 已具备用户内唯一服务端合同、会议级 GET/PUT、按 occurrence 查询、不可变计划快照、独立客户端 outbox、跨设备安全附着、冲突保留及 active/orphaned 生命周期。真正双会议冲突已增加 detached history 和“本机独立保留、日程使用云端关联”的原子恢复路径，但跨会议移动录音/内容仍未实现。目标 18020/18035 服务仍未启动，新表和鉴权路由没有运行证据，因此不能把源码合同或恢复路径写成线上、跨设备或真机已验收。
> 适用范围：老记 Android、React Native 领域层、本机持久化、会议服务、日程服务对接。
> 规范词：`必须`、`不得`、`应`、`可以`分别对应 MUST、MUST NOT、SHOULD、MAY。

## 1. 目标、边界与不可伪造的保证

老记的目标定位固定为：

> **日历原生、现场优先、人工可控的中文个人会议记忆工具。**

本文件覆盖当前证据能够支持的目标架构、数据迁移、接口契约、交互状态、失败恢复、实施依赖和阶段验收。它不能保证未来需求、第三方服务和真实用户行为永远不变，因此采用以下工程保证替代“把未来一次性写死”：

1. 每个功能必须有稳定领域对象、状态机、数据所有权和失败语义。
2. 每个竞品结论必须区分安装包源码事实、真机事实、产品决策和老记推断。
3. 每个未知项必须有验证门槛；未验证的推断不得直接升级成源码事实。
4. 每个阶段必须能独立构建、安装、回滚或继续恢复，禁止跨数周的大爆炸分支。
5. 用户原文、已确认的人工修改、录音和已完成行动项不得因 AI 重生成、登录切换、日程修改或同步冲突而静默丢失。

本计划不会恢复 `archive/workspace-lightening-20260718` 中已经归档的历史门禁和测试体系。每阶段只做与当期变更直接相关的契约检查、构建检查和真机任务验证；验证资料完成后归档，不重新膨胀主工作区。

## 2. 证据基线

### 2.1 证据标签

- `[PRODUCT]`：用户已经确定的老记产品合同。
- `[SOURCE]`：当前版本 APK、反编译资源、Hermes、老记或服务端源码直接确认。
- `[DEVICE]`：对应版本在用户手机或指定模拟器上的真实运行分支。
- `[INFERENCE]`：为老记独有能力设计的桥接方案，必须在实施阶段验证。

UI 变更还必须遵守 `/home/yydd/.codex/skills/feishu-ui-style/SKILL.md`，尤其是中文术语、组件状态、固定槽位、首帧稳定和真机视频验证要求。

### 2.2 固定分析对象

| 产品 | 版本 | 本地证据根目录 | 本文件采用的角色 |
|---|---|---|---|
| Notion | 0.6.4014 | `/home/yydd/文档/apk-analysis/meeting-apps-20260722/notion-0.6.4014-v10014` | 稳定会议文档、人工笔记、可引用结果、结果进入行动 |
| Notion Calendar | 1.47.0 | `/home/yydd/文档/apk-analysis/meeting-apps-20260722/notion-calendar-1.47.0-v100` | occurrence 作为会前、会中、会后统一动作中心 |
| Otter | 3.103.0-6392 | `/home/yydd/文档/apk-analysis/meeting-apps-20260722/otter-3.103.0-v26392` | Transcript 搜索回听、当前段高亮、说话人修正反馈、原设备恢复 |
| Fireflies | 0.5.48 | `/home/yydd/文档/apk-analysis/fireflies-0.5.48-v207-20260722` | 多入口统一会议资产、独立处理阶段、Summary sections、Marker、任务 |
| Granola | prod-260703.2 | `/home/yydd/文档/apk-analysis/meeting-apps-20260722/granola-prod-260703.2-v26070302` | 人工主稿、AI 增强稿、细粒度恢复、默认私有 |

汇总分析位于 `/home/yydd/文档/apk-analysis/meeting-apps-20260722/五款应用功能对比与老记优化建议.md`；四份同目录单品报告和 Fireflies 根目录的 `Fireflies-功能分析.md` 是功能证据索引。实施时从报告定位，再回到相同版本 JADX/Hermes/资源复核，不把报告文字当可执行 API 合同。

证据摘要：

- `[SOURCE]` Notion Android 存在原生会议前台服务、重试动作、上传失败事件和会议资源；其会议结果以页面、Transcript、Summary、行动项组合存在。
- `[SOURCE]` Notion Calendar Hermes 中存在会议笔记关联、未来会议入口、通知和 Android Widget 数据源；它把事件作为动作入口，但会议正文仍由 Notion 承载。
- `[SOURCE]` Otter Android 的 Conversation、Transcript、播放器、说话人、导入和恢复功能包与文案证明“文字是音频索引”；“未完成上传需回原设备继续”来自分项报告记录的官方产品资料，不伪装成反编译结论。预埋 Chat 2.0 不视为当前 Android 已开放事实。
- `[SOURCE]` Fireflies Hermes GraphQL 结构直接包含 caption 起止时间、`averageConfidence`、说话人 `durationPct`、Summary section 顺序、Local Recordings、重试上传、任务和 Soundbite。
- `[SOURCE]` Granola Room 数据库包含 notes、全文索引、transcript chunk、recording session/segment/upload/upload part；录音源码和文案明确区分准备上传、上传失败、转写、生成、恢复以及 `My notes / Enhanced`。

### 2.3 证据强度的解释

竞品收敛只能说明问题普遍、方案可行，不能因果证明一定提高老记留存。因此本文件使用三级证据：

- `强`：至少两个独立产品收敛，且老记当前存在可复现缺口或已有半成品基础。
- `中`：竞品和工作流均支持，但老记真实使用频率尚未验证。
- `实验`：价值合理但成本、使用频率或中文效果未证明，必须在稳定闭环后小范围验证。

## 3. 当前实现审计

### 3.1 保留的基础

以下能力已经投入较多可靠性设计，必须复用：

- `CalEvent.sourceEventId + occurrenceDate` 已形成稳定 occurrence identity；重复范围编辑、删除/撤销、缓存与通知均围绕它工作。
- `RecorderEngine.kt`、`RecordingJournal.kt`、`RecorderForegroundService.kt` 已负责 16 kHz 单声道 WAV、断点 journal、原子重命名、文件修复、进程恢复和录音电平。
- `MeetingUploadWorker.kt`、credential lease 和 JS pending-upload registry 已形成持久上传与退避重试链路。
- `Media3MinutesPlayerAdapter.kt`、MediaSession 与加密播放缓存已形成后台播放、倍速、跳转和缓存清理链路。
- TypeScript 构建版本化 `MinutesViewSnapshot`，Kotlin 原生页面消费快照并发出语义动作；这一 UI/领域边界继续保留。
- 游客与账号按 `guest` / `user:{id}` 隔离；现有游客迁移 journal 已经能逐阶段恢复会议正文、状态和音频。

### 3.2 必须先解决的结构缺口

1. `Meeting`、`TranscriptLine`、`MeetingSummary` 仍是宽松接口；会议、转写和总结按整个作用域序列化到 AsyncStorage JSON。它不适合事务、全文搜索、版本、引用、跨实体唯一约束和局部更新。
2. `Meeting.status` 把录音、上传、转写和总结压成一个字符串；列表标签再叠加 `audioSyncPending`，不同页面无法稳定表达同一失败。
3. 日程详情只有编辑、删除和重试，没有会议关联；`Meeting` 也没有 occurrence reference 或计划快照。
4. 录音页只有实时 Transcript，没有独立人工笔记。
5. 当前 Transcript 行可以点击跳转，但没有搜索、匹配导航和播放中的当前段高亮；适配器仍以 `notifyDataSetChanged()` 全量刷新。
6. 总结仍需兼容 JSON 字符串、Markdown 和固定字段；服务端结果缺少稳定 section、版本和引用。
7. 服务端读取 Summary 时临时为行动项生成 UUID，导致同一行动项每次请求 ID 都不同；它不是可编辑对象。
8. 分享的“完整资料”默认打包信息、总结、Transcript 和音频，没有内容级授权。
9. 游客迁移没有持久化“游客日程 source ID → 云端日程 ID”映射；增加 occurrence 绑定后会丢失关联。
10. 移动端 `createMeeting` 发送 `location`、`recorded_at`、`client_request_id`。2026-07-24 已从目标部署源码、生成 OpenAPI 和实际 SQLite schema 确认这些字段、用户内唯一索引、空标题及 PATCH 显式清空合同；但 18020/18035 未运行，不能把源码合同写成线上端到端已通过。开始新接口前仍必须复核运行实例。
11. Android manifest 没有音频 `ACTION_SEND` / `ACTION_OPEN_DOCUMENT` 接收入口、App Widget 或 Quick Settings Tile。
12. 稳定基线的生成版 `android/app/build.gradle` 曾含指向本机工作树的绝对 ProGuard 路径。Phase 0 已改为由配置插件生成 `rootProject.file(...)` 相对路径；后续预构建仍必须执行跨平台路径检查，防止回归。

## 4. 完整优化登记表

| ID | 优化项 | 证据 | 优先级 | 主要依赖 |
|---|---|---:|---:|---|
| ARC-01 | 事务型本地会议数据层与可恢复迁移 | 强 | 基础 | 无 |
| SRC-01 | 日程、临时录音、文件导入统一为 `MeetingNote`，保留来源语义 | 强 | P0 | ARC-01 |
| PROC-01 | 录音、上传、转写、整理、说话人处理独立状态与独立重试 | 强 | P0 | ARC-01 |
| CAL-01 | occurrence 与会议一对一绑定、状态化动作和历史计划快照 | 强 | P0 | SRC-01、PROC-01 |
| NOTE-01 | 永不被 AI 覆盖的“我的笔记”与中断恢复 | 强 | P0 | ARC-01、CAL-01 |
| TRN-01 | 单场搜索、匹配跳转、点击回听、播放高亮、复制/分享 | 强 | P0 | ARC-01、播放器 |
| ACT-01 | 行动项对象化、编辑、完成、截止、提醒/日程、来源回跳 | 强 | P0 | TRN-01、SUM-01 |
| SUM-01 | 有序 Summary sections，禁止原始 JSON 进入 UI | 强 | P0 | ARC-01、PROC-01 |
| SUM-02 | 决定、结论和行动项引用 Transcript 证据 | 中强 | P1 | TRN-01、SUM-01 |
| SUM-03 | AI 结果版本管理，重生成不覆盖用户编辑 | 强 | P0 | SUM-01 |
| IMP-01 | 文件选择与 Android 系统分享导入音视频 | 中强 | P1 | SRC-01、PROC-01 |
| MRK-01 | 会议中 Marker、会后跳转、转行动项/分享文本 | 中 | P1 | TRN-01 |
| ENTRY-01 | occurrence 会前通知直接开始/继续记录 | 中强 | P1 | CAL-01 |
| ENTRY-02 | 近期日程 Widget 与临时会议 Quick Settings Tile | 中 | P1 | ENTRY-01、Android 投影 |
| TPL-01 | 通用、1:1、项目同步、访谈四个内置模板 | 中 | P1 | SUM-01、SUM-03 |
| SERIES-01 | 重复会议“系列记忆”：上次决定和未完成行动项 | 中强 | P1 | CAL-01、ACT-01、SUM-02 |
| SHARE-01 | 默认只分享纪要，Transcript、音频、我的笔记分层选择 | 强 | P1 | NOTE-01、SUM-01 |
| REC-01 | 日程结束只提示，不得机械停止录音 | 强 | P0 合同 | CAL-01、PROC-01 |
| SPK-01 | 段落修正→资料反馈→未来改善→旧会议重匹配 | 中强 | P1/P2 | TRN-01、服务端声纹 |
| PRIV-01 | 默认私有；未同步删除与已同步回收站使用不同语义 | 中强 | P1 | PROC-01、同步 |
| QA-01 | 单场、有来源的会议问答 | 中 | P2 | SUM-02、TRN-01 |
| ORG-01 | 标签/Folder、多场检索、按人物/主题聚合 | 实验 | P2 | ARC-01、SPK-01 |
| COLLAB-01 | 共享行动项与轻协作 | 实验 | P2 | ACT-01、SHARE-01 |
| CLIP-01 | 从 Marker/Transcript 导出重要媒体片段 | 中 | P2 | MRK-01、录音资产 |
| ATT-01 | 将照片或简短人工内容绑定会议时间点 | 中 | P2 | MRK-01、附件资产 |
| ANDR-01 | Android 内完成创建、录制、恢复、核对、执行的完整闭环 | 强 | 横切 | 全部 P0/P1 |

上述登记表是完整范围。P2 不是删除项，而是必须等 P0/P1 的任务指标达标后再实施。明确不进入本路线的项目见第 18 节。

## 5. 总体架构决策

### 5.1 核心聚合

```text
CalendarOccurrence (external reference)
    sourceEventId + occurrenceDate
                  │ 0..1
                  ▼
MeetingNote (stable local UUID / optional remote UUID)
    ├─ Origin + ScheduleSnapshot
    ├─ ManualNote
    ├─ RecordingAsset[]
    ├─ ProcessingStage[capture|upload|transcript|summary|speaker]
    ├─ TranscriptRevision[] -> TranscriptSegment[] -> TranscriptWord[]?
    ├─ SummaryVersion[] -> SummarySection[] -> SummaryCitation[]
    ├─ ActionItem[]
    ├─ Marker[] -> Attachment[]?
    ├─ SpeakerAssignment[]
    └─ Tag[] / ShareManifest[] (later)
```

`MeetingNote` 是业务聚合，`RecordingAsset` 不是主对象；同一模型承载现场录音、日程启动、文件导入和系统分享导入。来源决定初始上下文和可用动作，不得复制四套会议页面。

### 5.2 层次与数据所有权

| 层 | 所有内容 | 明确禁止 |
|---|---|---|
| TypeScript domain | 领域实体、状态推导、冲突策略、用例 | 直接依赖 React 组件或 Android View |
| TypeScript data | SQLite、AsyncStorage 迁移、API DTO、outbox | 在 UI 中散落 SQL/API |
| TypeScript application | 创建/绑定/结束/导入/总结/行动用例 | 以页面 `useEffect` 拼装跨阶段事务 |
| React route/controller | 导航、权限请求、订阅 repository、构建 snapshot | 持有唯一业务真相或直接改 Kotlin 状态 |
| Kotlin native UI | 布局、动画、局部搜索、播放器高亮、语义动作 | 网络、账号同步、业务持久化 |
| Kotlin platform | 录音 journal、Media3、WorkManager、Content URI、Widget/Tile | 生成总结、决定日程关联 |
| 服务端 | 账号数据、处理作业、最终 Transcript、Summary 版本、跨设备同步 | 控制正在录音的本机文件安全 |

### 5.3 目标目录

```text
src/
  domain/meeting/
    entities.ts
    processing.ts
    occurrence.ts
    summary.ts
    actions.ts
    invariants.ts
  application/meeting/
    createMeetingNote.ts
    bindOccurrence.ts
    recordingSessionController.ts
    importMeetingMedia.ts
    generateSummary.ts
    reconcileMeeting.ts
  data/db/
    openDatabase.ts
    migrations/
    legacyImport.ts
  data/repositories/
    meetingNoteRepository.ts
    transcriptRepository.ts
    summaryRepository.ts
    actionItemRepository.ts
    processingRepository.ts
    syncOutboxRepository.ts
  data/api/v2/
    contracts.ts
    meetingNoteApi.ts
    processingApi.ts
  presentation/minutes/
    buildListSnapshot.ts
    buildRecordingSnapshot.ts
    buildDetailSnapshot.ts
```

迁移期间 `MeetingsStore.tsx` 保留为兼容 facade，但内部只订阅 repository；新功能不得继续往该文件增加 AsyncStorage map。`EventsStore.tsx` 保留当前重复事件和通知事务设计，只增加 occurrence 查询适配器。

### 5.4 跨服务约束

日程与会议当前使用不同服务基址，因此：

- 不建立跨数据库外键。
- 会议服务保存外部 occurrence reference：`calendar_source_event_id`、`occurrence_date`、可选 `calendar_revision`。
- 会议服务对 `(user_id, calendar_source_event_id, occurrence_date)` 建唯一约束。
- 日程详情由移动端用 occurrence reference 查询本地 meeting index；跨设备同步后仍能重建。
- `ScheduleSnapshot` 是创建/绑定时的不可变快照；日程后来移动、改标题或拆分重复规则，不回写历史快照。

### 5.5 ID、时间和作用域

- 本机实体 ID 使用应用生成的随机 UUID；创建前即存在，作为重试和 outbox 幂等键。统一通过 `ClientIdFactory`：优先使用运行时安全随机 UUID，缺失时调用 native `java.util.UUID.randomUUID()`；没有安全随机源时创建失败，绝不退化到 `Date.now()+Math.random()`。
- `remote_id` 独立存储，不覆盖 local ID。
- occurrence identity 继续使用原始 recurrence anchor：`sourceEventId + occurrenceDate`。移动单次 occurrence 时不得把 occurrenceDate 改成新显示日期。
- 数据库时间统一保存 UTC epoch milliseconds；日程的年月日仍保存 ISO local date，解释时带设备时区/快照时区。
- 聚合根表及跨聚合队列表带 `scope_key`：`guest` 或 `user:{stableUserId}`；子表通过 meeting 外键继承作用域，repository 查询子表时必须同时约束根表 scope。登出只切换活动作用域，不删除数据。
- 用户可见标题允许为空；列表层通过 `displayMeetingTitle()` 显示“未命名会议”，不得把占位文本写回用户内容。

### 5.6 Linux/Windows 开发主机兼容性

- Gradle 使用 `project.file(...)`、`rootProject.file(...)` 或依赖自身公开的 ProGuard consumer rules，不保存 `/home/...`、盘符或个人用户名路径。
- Node/TypeScript 路径统一使用 `path.resolve/join`，不手拼 `/`；开发脚本优先 Node `.mjs` 或 Gradle task，不以 zsh/bash 专属语法作为唯一入口。
- 必须使用 Python 的维护脚本以 `python3` 运行，并使用 `pathlib`；不得假设命令名 `python`、GNU-only `sed` 或 Linux `/tmp`。
- Android 运行时 `file://`/`content://` 逻辑与开发主机文件路径分开；不得把 adb/设备路径传给 Windows 主机文件 API。
- Phase 0 至少在 Linux 完整构建并在 Windows 执行配置解析/TypeScript 编译；没有 Windows Android SDK 时也必须验证脚本和 Gradle configuration phase 无 POSIX 绝对路径依赖。

## 6. 本机事务数据层

### 6.1 技术选择

使用与当前 Expo SDK 匹配的 `expo-sqlite`，通过 `npx expo install expo-sqlite` 安装，不手写漂移版本。原因：

- 当前领域和同步在 TypeScript，SQLite 可避免建立第二套 Room bridge。
- 需要事务、索引、局部更新、版本和后续全文检索。
- Android 原生录音 journal 与 WorkManager 已独立可靠，不要求业务数据库接管它们。

初始化必须执行：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

录音线程不得等待 SQLite；录音安全继续由原生文件 journal 保证。SQLite 写入失败只能影响业务投影，不能停止音频采集。

### 6.2 第一版核心表

以下为规范 DDL 形状；实施时拆成可回滚 migration，不在组件启动时拼接 SQL。

```sql
CREATE TABLE meeting_notes (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  remote_id TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('calendar','ad_hoc','file_import','share_intent')),
  entry_point TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT,
  participants_json TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  mode TEXT,
  client_request_id TEXT,
  recorded_at_ms INTEGER,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','active','ended','deleted')),
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  current_summary_version_id TEXT,
  remote_revision INTEGER,
  sync_state TEXT NOT NULL DEFAULT 'local',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(scope_key, remote_id)
);

CREATE UNIQUE INDEX idx_meeting_canonical_client_request_unique
  ON meeting_notes(scope_key, client_request_id)
  WHERE client_request_id IS NOT NULL
    AND COALESCE(entry_point, '') != 'legacy_store';

CREATE INDEX idx_meeting_recorded_at
  ON meeting_notes(scope_key, recorded_at_ms DESC, id DESC);

CREATE TABLE meeting_occurrence_links (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  calendar_source_event_id TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  calendar_revision INTEGER,
  recurrence_segment_id TEXT,
  series_key TEXT,
  link_state TEXT NOT NULL DEFAULT 'active',
  linked_at_ms INTEGER NOT NULL,
  UNIQUE(scope_key, calendar_source_event_id, occurrence_date)
);

CREATE INDEX idx_occurrence_series
  ON meeting_occurrence_links(scope_key, series_key, occurrence_date);

CREATE TABLE meeting_schedule_snapshots (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  event_title TEXT NOT NULL DEFAULT '',
  planned_start_ms INTEGER,
  planned_end_ms INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  timezone_id TEXT,
  location TEXT,
  participants_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  captured_event_revision INTEGER,
  captured_at_ms INTEGER NOT NULL
);

CREATE TABLE manual_notes (
  meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'plain',
  revision INTEGER NOT NULL DEFAULT 0,
  base_remote_revision INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  last_saved_at_ms INTEGER NOT NULL,
  user_edited_at_ms INTEGER
);

CREATE TABLE recording_assets (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'primary',
  origin TEXT NOT NULL CHECK(origin IN ('captured','imported','recovered')),
  local_uri TEXT,
  remote_asset_id TEXT,
  mime_type TEXT,
  file_name TEXT,
  byte_size INTEGER,
  duration_ms INTEGER,
  checksum_sha256 TEXT,
  waveform_json TEXT,
  local_state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_recording_meeting ON recording_assets(meeting_id, role);

CREATE TABLE processing_stages (
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('capture','upload','transcript','summary','speaker')),
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  progress REAL,
  job_id TEXT,
  input_fingerprint TEXT,
  error_code TEXT,
  user_message_key TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(meeting_id, stage)
);

CREATE TABLE transcript_revisions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('realtime_draft','final','reprocessed')),
  status TEXT NOT NULL,
  source_provider TEXT,
  source_model TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  finalized_at_ms INTEGER
);

CREATE INDEX idx_transcript_revision_active
  ON transcript_revisions(meeting_id, is_active, created_at_ms);

CREATE TABLE transcript_segments (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES transcript_revisions(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  speaker_cluster_id TEXT,
  speaker_profile_id TEXT,
  speaker_label TEXT,
  speaker_label_override TEXT,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  confidence REAL,
  is_final INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(revision_id, ordinal)
);

CREATE INDEX idx_transcript_timeline
  ON transcript_segments(meeting_id, revision_id, start_ms, ordinal);

CREATE TABLE transcript_words (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL,
  UNIQUE(segment_id, ordinal)
);

CREATE TABLE summary_versions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  template_revision INTEGER NOT NULL,
  input_fingerprint TEXT NOT NULL,
  transcript_revision_id TEXT REFERENCES transcript_revisions(id),
  manual_note_revision INTEGER NOT NULL,
  schedule_snapshot_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','generating','ready','failed','stale')),
  generated_by TEXT,
  user_edited INTEGER NOT NULL DEFAULT 0,
  supersedes_version_id TEXT,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);

CREATE INDEX idx_summary_meeting_versions
  ON summary_versions(meeting_id, created_at_ms DESC);

CREATE TABLE summary_sections (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES summary_versions(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  generated_text TEXT NOT NULL DEFAULT '',
  user_text TEXT,
  ordinal INTEGER NOT NULL,
  user_edited_at_ms INTEGER,
  UNIQUE(version_id, stable_key)
);

CREATE TABLE summary_citations (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES summary_sections(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  quote_hash TEXT,
  ordinal INTEGER NOT NULL
);

CREATE TABLE action_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  remote_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','dismissed')),
  assignee_text TEXT,
  due_at_ms INTEGER,
  reminder_notification_id TEXT,
  followup_event_source_id TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('generated','manual','marker')),
  source_marker_id TEXT REFERENCES markers(id) ON DELETE SET NULL,
  source_summary_version_id TEXT,
  source_segment_id TEXT,
  source_start_ms INTEGER,
  generation_fingerprint TEXT,
  user_edited_at_ms INTEGER,
  completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_actions_due
  ON action_items(meeting_id, status, due_at_ms);

CREATE INDEX idx_actions_marker_source
  ON action_items(meeting_id, source_marker_id)
  WHERE source_marker_id IS NOT NULL;

CREATE TABLE action_item_citations (
  action_item_id TEXT NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  quote_hash TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(action_item_id, segment_id, ordinal)
);

CREATE TABLE markers (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  nearest_segment_id TEXT,
  label TEXT,
  kind TEXT NOT NULL DEFAULT 'important',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_markers_timeline ON markers(meeting_id, position_ms);

CREATE TABLE sync_outbox (
  operation_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  base_revision INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER,
  last_error_code TEXT,
  request_payload_json TEXT,
  claim_token TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_outbox_ready
  ON sync_outbox(scope_key, status, next_attempt_at_ms, created_at_ms);

CREATE TABLE meeting_scope_write_state (
  scope_key TEXT PRIMARY KEY,
  write_owner TEXT NOT NULL CHECK(write_owner IN ('legacy','canonical')),
  canonical_revision INTEGER NOT NULL CHECK(canonical_revision >= 0),
  legacy_mirror_revision INTEGER NOT NULL CHECK(legacy_mirror_revision >= 0),
  legacy_mirror_status TEXT NOT NULL CHECK(legacy_mirror_status IN ('clean','pending','failed')),
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL,
  CHECK(legacy_mirror_revision <= canonical_revision)
);

CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  local_revision INTEGER,
  remote_revision INTEGER,
  local_payload_json TEXT NOT NULL,
  remote_payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved',
  created_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
);

CREATE INDEX idx_conflicts_unresolved
  ON sync_conflicts(scope_key, status, created_at_ms);

CREATE TABLE migration_runs (
  migration_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  source_version TEXT NOT NULL,
  phase TEXT NOT NULL,
  source_hash TEXT,
  imported_counts_json TEXT,
  last_error TEXT,
  started_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);
```

已安装 SQLite v1/v2 的设备必须通过 additive v3 migration 增加上述六个会议上下文字段和两个索引，不重建 `meeting_notes`，也不移动既有稳定标签。`date/time` 从 `recorded_at_ms` 或时间字段派生，`duration` 从主录音资产派生，展示标签从 lifecycle/processing stage 派生，均不在会议根表重复保存。旧 Store 影子行允许历史重复 `client_request_id`；只有 canonical 行按 `(scope_key, client_request_id)` 唯一，避免脏历史阻塞无损导入。

`transcript_words` 只在服务端确有词级时间戳时写入；没有词级时间戳时只做段落高亮，不得伪造逐词效果。

### 6.3 后续扩展表

P1/P2 再引入：

- `speaker_clusters`、`speaker_assignments`、`speaker_corrections`。
- `attachments`，通过 `marker_id` 或 `meeting_id + position_ms` 绑定。
- `tags`、`meeting_tags`、可选单层 `folders`。
- `share_manifests`、`share_grants`。
- `qa_threads`、`qa_messages`、`qa_citations`。
- `series_rollups` 仅作为可重建缓存，不作为事实源。

### 6.4 单场和多场搜索

单场 Transcript 搜索第一阶段在 Kotlin 页面内对当前 snapshot 做 Unicode 归一化后的 substring 搜索，原因是中文短词、段落规模和即时高亮不需要依赖设备 FTS tokenizer。

多场搜索在 P2 使用两级能力探测：

1. 若设备 SQLite 支持 FTS5 trigram，则建立外部内容 FTS 表。
2. 若不支持，不允许初始化失败；退化为标题/笔记索引加受限 `LIKE`，长 Transcript 查询走服务端搜索。

不得假设所有 API 24+ 设备都具有相同 FTS5 tokenizer。

### 6.5 Repository 与事务接口

页面不得直接取得 SQLite handle。最小 repository 契约：

```ts
interface MeetingNoteRepository {
  transaction<T>(work: (tx: MeetingTransaction) => Promise<T>): Promise<T>;
  get(id: string, scopeKey: ScopeKey): Promise<MeetingNoteAggregate | null>;
  findByOccurrence(ref: EventRef, scopeKey: ScopeKey): Promise<MeetingNoteAggregate | null>;
  listProjection(scopeKey: ScopeKey, query: MeetingListQuery): Promise<MeetingListProjection>;
  observeMeeting(id: string, scopeKey: ScopeKey, listener: () => void): Unsubscribe;
  observeList(scopeKey: ScopeKey, listener: () => void): Unsubscribe;
}

interface MeetingTransaction {
  insertMeeting(note: NewMeetingNote): Promise<void>;
  bindOccurrence(link: OccurrenceLink, snapshot: ScheduleSnapshot): Promise<void>;
  upsertStage(stage: ProcessingStage): Promise<void>;
  saveManualNote(note: ManualNote): Promise<void>;
  appendTranscriptSegments(revisionId: string, segments: TranscriptSegment[]): Promise<void>;
  insertOutbox(operation: SyncOperation): Promise<void>;
}
```

- mutation 与对应 outbox 必须同 transaction commit，避免本机已改但永不上传。
- `operation_id` 是不可变幂等键：完全相同的 operation 重试必须是 no-op；同一 ID 的 scope、aggregate、operation type、base revision 或 payload 任一变化必须拒绝整个 transaction。已经 ACK 的 operation 重放不得再次推进领域状态。
- repository 内部序列化同一 meeting 的写操作；不同 meeting 可以并行。
- React 使用 `useSyncExternalStore` 或等价稳定订阅读取 projection，不能在每个 render 执行 SQL。
- 查询返回只读 projection；UI 不直接 mutate entity 后再整对象覆盖。
- DB connection 单例按 app process 管理；migration 未完成前 repository readiness gate 阻止业务写，但 native recorder recovery 可以先运行并缓存报告。

### 6.6 聚合不变量

每次 transaction commit 前在 domain 层验证：

1. calendar origin 必须有 occurrence link 和 schedule snapshot；其他来源可以后续绑定，但同样受唯一约束。
2. 一场 meeting 至多一个 `role='primary'` 且未删除的 recording asset。
3. 一场 meeting 至多一个 active Transcript revision；切换 active 必须在同一 transaction 清旧置新。
4. `current_summary_version_id` 必须属于同一 meeting 且 status 为 ready/stale。
5. citation 的 segment 必须属于该 Summary 锁定的 Transcript revision。
6. action/marker/citation 的 source time 不得超出已知录音 duration；一个 action 可以有多条 `action_item_citations`，列表投影只选第一条作为快速回跳。duration 未知时允许写入，获知后再校验并标诊断，不能截断用户数据。
7. capture 尚在 recording 时不得 hard-delete primary recording asset。
8. AI 路径不得调用 `saveManualNote()`；只读 manual note snapshot 作为输入。
9. scope_key 在聚合内必须一致；跨 scope 复制只能由 migration use case 完成。
10. deleted meeting 不接受新处理作业；已在跑的 job 结果以 tombstone 拒绝落 active projection。

## 7. 旧数据迁移与回滚

### 7.1 迁移输入

- `@laoji:meetings:v2:{scope}`
- `@laoji:meetingTranscripts:v1:{scope}`
- `@laoji:meetingSummaries:v1:{scope}`
- `@laoji:pendingMeetingAudioUploads:v2:{scope}`
- `@laoji:pendingMeetingSummaryTasks:v1:{scope}`
- Android `RecordingJournal` 和 WorkManager 状态
- 游客事件 `@laoji:guestEvents:v1`

### 7.2 每个作用域的迁移顺序

1. 计算源 JSON 的长度、实体数和内容 hash，写 `migration_runs`。
2. 在单一 SQLite transaction 中导入 meeting 基础行和来源。
3. 为每场会议创建 `manual_notes` 空行、五个 `processing_stages` 基线行。
4. 旧 Transcript 进入一个 `final` 或 `realtime_draft` revision；保留原 ID，缺失 ID 时使用稳定 hash 生成。
5. 旧 Summary 进入 `template_id='legacy'` 的只读 `summary_version`；解析失败仍保存 raw legacy backup，但 UI 不展示 raw JSON。
6. 旧 `action_items` 先作为 legacy generated actions 导入；通过稳定 fingerprint 生成 ID，不使用服务端临时 UUID。
7. 录音 URI、时长、波形和 pending upload 映射到 `recording_assets + processing_stages.upload`。
8. 用原生 `recover()` 报告按 session/meeting ID 对账；数据库缺行时补 `origin='recovered'`，不得删除孤立 WAV。
9. 比较 meeting、Transcript、Summary 和音频引用计数；任一关键计数减少则 rollback transaction。
10. 标记完成后才切换 repository 读源。

### 7.3 切换策略

- Release A：SQLite shadow import + 只读一致性报告，UI 仍读旧 store。
- Release B：`local_meeting_db_canonical_read_v1` 显式开启后，只有当前 scope 的 shadow import 完成，非法/重复身份、可见顺序、meeting/context、Transcript 逐行语义和 Summary 展示文本全部一致，且结果仍属于同 scope 的最新读请求，才从 SQLite 构建旧界面兼容投影；任一 mismatch、repository 提交导致的在途读取失效、分页漂移或内容读取异常立即保留旧 Store 快照。`deleted` 墓碑只计入脱敏诊断，不进入可见列表或 `extra`。首次 canonical mutation 必须与 scope write ownership 和单调 canonical revision 在同一 SQLite transaction 提交；旧模型镜像成功后用 revision CAS 标记 clean，强杀恢复时根据 owner/revision 修复，不得仅靠两次存储写入的先后顺序猜测事实源。随后 SQLite 成为 canonical；旧模型支持的字段继续 shadow write，保证短期降级可见。
- Release C：停止旧字段写入，但保留只读 legacy backup 两个安装版本；确认真机升级后再清理。
- 新增的人工笔记、引用、行动项版本不能降级到旧结构；回滚 Release B 时必须保留 SQLite 文件，旧 APK不可清理本机数据。
- 实施期间可以在可恢复的模拟器快照上显式开启 read/write，逐个验证 canonical-first 纵切、revision CAS 和强杀恢复；这类单纵切 opt-in 只属于工程验证，不构成 Release B 扩量，也不得进入普通交付包。

### 7.4 游客登录迁移 v2

当前 journal 必须升级并保存映射：

```ts
type EventMigrationStateV2 = {
  imported: boolean;
  cloudSourceEventId?: string;
  clientRequestId: string;
  lastError?: string;
};

type MeetingMigrationStateV2 = {
  cloudMeetingId?: string;
  cloudOccurrenceLinked: boolean;
  manualNoteSynced: boolean;
  transcriptSynced: boolean;
  summaryVersionsSynced: boolean;
  actionsSynced: boolean;
  markersSynced: boolean;
  audioUploaded: boolean;
  completed: boolean;
};
```

迁移必须先创建所有日程并得到 `guest source ID -> cloud source ID`，再创建/更新会议 occurrence link。单个音频失败不得阻塞 Transcript、人工笔记、总结或其他会议；每个阶段有独立 retry。声纹资料仍不得从游客数据自动迁移，原因是它属于账号绑定的生物特征资料和独立同意范围。

## 8. 处理状态规范

### 8.1 阶段状态

```ts
type CaptureStatus =
  | 'not_started' | 'preparing' | 'recording' | 'paused'
  | 'finalizing' | 'local_ready' | 'failed_recoverable' | 'failed_terminal';

type UploadStatus =
  | 'not_required' | 'queued' | 'uploading' | 'uploaded'
  | 'failed_retryable' | 'blocked';

type TranscriptStatus =
  | 'none' | 'realtime_draft' | 'finalizing' | 'ready'
  | 'failed_retryable' | 'unavailable';

type SummaryStatus =
  | 'none' | 'queued' | 'generating' | 'ready'
  | 'stale' | 'failed_retryable';

type SpeakerStatus =
  | 'none' | 'processing' | 'ready' | 'partial' | 'failed_retryable';
```

禁止以一个 `meeting.status='failed'` 覆盖这些状态。服务端可以保留兼容字段，但移动端状态必须从阶段数据推导。

### 8.2 用户状态推导优先级

1. `capture=recording/paused`：正在录音/录音已暂停。
2. `capture=finalizing`：正在安全保存录音。
3. 本地文件存在且 `upload=queued/uploading`：录音已保存在本机，等待上传/正在上传。
4. `upload=failed_retryable/blocked`：上传失败，可重试/上传受阻；播放器仍可使用本地文件。
5. `transcript=finalizing`：正在生成文字记录。
6. `transcript=failed_retryable`：文字处理失败，可单独重试；音频状态不得变成失败。
7. `summary=queued/generating`：正在整理会议记录。
8. `summary=failed_retryable`：整理失败，可单独重试；Transcript 和音频保持可用。
9. 主要资产就绪：已完成；若输入变化则显示“整理结果可更新”，而不是失败。

列表、日程详情和会议详情必须调用同一个 `deriveMeetingPresentationState()`，不得各写一套条件。

### 8.3 错误合同

- 底层持久化 `error_code` 和内部诊断，不持久化供应商英文错误作为用户文案。
- UI 只根据 `user_message_key` 映射中文；未知错误统一为该阶段的中文 fallback。
- 每个失败状态必须说明“已保存什么”和“下一步能重试什么”，但不得添加显而易见的说明书式文案。
- 一个页面最多突出一个主重试动作；其他阶段状态进入详情或次级动作。
- 错误槽位、加载槽位和主要操作槽位尺寸固定，状态变化不得导致主控件上下跳动。

### 8.4 REC-01：录音结束合同

`[PRODUCT]` 日程计划结束时间不是录音停止条件。到达计划结束时间时：

- 可以显示安静通知或状态提示“日程已到结束时间”。
- 不发送 stop command，不改变 capture state。
- 用户手动停止、系统无法继续采集、达到明确存储上限时才结束。
- 若应用进程/界面消失，前台服务继续按现有 journal 合同运行。

`[INFERENCE]` 当前 Android 第一纵切只增加系统提醒，不改 recorder command/state machine：`startNativeRecorder()` 成功后才从 canonical schedule snapshot 读取 `planned_end_ms`；仍在未来时，以稳定 session ID 在独立低重要性通道幂等调度“日程已到结束时间 / 会议录音仍在继续”。录音启动不申请通知权限，未授权或无计划结束时间时静默跳过；活动 native session 恢复时补调度并去重，native capture 进入 `localSaved/failed`、恢复出已结束文件或手动 finalize 成功后取消并移除提醒。通知不包含会议标题、地点、参与人或正文；点击只按系统默认行为打开 App并消费该 response，当前不伪装成 event/meeting-action 导航目标。计划结束时间已经过去时不补发追溯提醒。

## 9. P0 功能详细设计

### 9.1 SRC-01：统一 MeetingNote 来源模型

#### 产品合同

- 从 occurrence 开始：`origin='calendar'`，自动带入计划快照。
- 会议页直接录制：`origin='ad_hoc'`，标题可以为空，开始时间取真实录制时间。
- 文件选择器导入：`origin='file_import'`。
- 其他 App 分享导入：`origin='share_intent'`。
- `entry_point` 额外保留 `calendar_detail / notification / widget / meeting_tab / quick_tile / document_picker / share_intent`，用于恢复入口和无正文指标；它不改变 MeetingNote 的处理模型。
- 四种来源进入同一列表、详情、处理和分享链路；列表可以用不抢眼的来源元数据区分，但不得复制页面。

#### 创建事务

`CreateMeetingNoteUseCase` 必须在一个本机事务内：

1. 生成 local meeting ID。
2. 插入 meeting、空 manual note、五个 stage。
3. 若来自日程，插入 occurrence link 和 schedule snapshot。
4. 若来自文件，先插入 recording asset 的 `local_state='ingesting'`。
5. 写 outbox `meeting.create`；游客不写远端 outbox。
6. commit 后才导航到录音或导入状态页。

服务端创建失败不得删除本机 meeting；标记 `sync_state='pending'` 后继续允许录音。重复提交使用 local meeting ID 作为 `client_note_id`，服务端必须返回同一对象。

#### 唯一性

- 同一作用域同一 occurrence 最多绑定一个未删除 MeetingNote。
- 用户重复点击“开始记录”时，repository 先查唯一索引；存在 `active` 则继续，存在 `ended` 则查看。
- 两个设备同时创建时由服务端唯一约束裁决；收到 409 时拉取已存在对象并把本机临时对象合并到它。若本机临时对象已有音频，不得直接丢弃，进入“待合并录音”恢复路径。

### 9.2 CAL-01：occurrence 绑定与日程动作

#### 状态化动作

`EventDetailScreen.android.tsx` 不直接遍历 `meetings`，而是调用：

```ts
resolveOccurrenceMeeting(scopeKey, {
  sourceEventId,
  occurrenceDate,
}): Promise<OccurrenceMeetingProjection | null>
```

投影返回 `meetingId`、计划快照、聚合展示状态和唯一主动作：

| 条件 | 主动作 | 导航 |
|---|---|---|
| 无绑定记录 | 开始记录 | 原子创建并进入 `MeetingLive` |
| capture 可恢复/正在进行 | 继续记录 | 恢复同一 session |
| 已有任何本地或云端结果 | 查看记录 | `Transcription`/会议详情 |
| 创建/同步冲突处理中 | 正在准备 | disabled，保持固定槽位 |
| 创建失败且无任何资产 | 重试创建 | 重用同一 client ID |

日程卡片或详情可以显示简短处理状态，但不得让点击日程空白区域自动创建会议；只有明确动作触发创建。

#### 快照规则

- 初次绑定记录 event title、planned start/end、timezone、location、participants、description 和 event revision。
- 会议创建后，日程修改只更新“当前日程投影”，不覆盖 `meeting_schedule_snapshots`。
- 详情同时需要当前日程与历史计划时，文案明确区分“当前日程”和“记录时计划”；默认只展示历史计划，避免跳动。
- recurrence 的 `following` 分段仍以原 `sourceEventId` 形成系列；具体 occurrence 继续用原 anchor date。
- 删除日程不级联删除会议；link 变为 `orphaned`，会议保留快照和系列来源。
- 删除会议不删除日程；日程动作恢复为“开始记录”。

#### 文件改动入口

- `src/screens/EventDetailScreen.android.tsx`
- `src/native/nativeCalendarPages.ts`
- `modules/laoji-native-platform/src/calendarPages.ts`
- `CalendarPageContracts.kt`、`CalendarDetailPageView.kt`
- `src/services/guestDataMigration.ts` v2
- 会议服务 occurrence 字段/唯一约束

#### 验收

1. 从重复日程的第二次 occurrence 开始并结束会议。
2. 修改“此项及以后”，原会议仍从原 occurrence 打开。
3. 删除日程，会议仍可播放、查看和分享。
4. 连续快速点击主动作只产生一个 meeting 和一个 recorder session。
5. 登录迁移后，云端 event ID 改变但 occurrence 关联正确重建。

### 9.3 NOTE-01：我的笔记

#### 数据与编辑合同

- `manual_notes.content` 是用户事实源；AI 永远不直接写入该字段。
- 第一版使用纯文本，允许换行；不引入块编辑器、富文本关系或 Markdown 工具栏。
- 每次本地修改递增内存 draft revision；停止输入 400 ms 后写 SQLite transaction。
- App 进入 background、开始停止录音、离开页面和 Android `onHostPause` 时立即 flush。
- SQLite 写失败时内存 draft 不清空，固定错误槽显示中文并提供重试；下一次生命周期 flush 再尝试。
- 同步只上传已落盘 revision。服务端以 `base_remote_revision` 做乐观并发；冲突产生“本机版本/云端版本”两个候选，不允许 last-write-wins 静默覆盖。

#### 当前同步实现

- 账号笔记实际变化与 SQLite 保存同事务写入 `manual_note.upsert`；旧 dirty 笔记缺少 operation 时由 scheduler 幂等补齐。
- 只有实时获取的 `manual_notes_v2` capability 允许网络写入。创建使用 `If-None-Match: *`，更新使用 `If-Match`；重试复用持久请求快照和 operation ID。
- 完成旧 claim 时只确认该请求快照。若用户在请求进行中继续输入，新 draft 保持 dirty，后续 operation 以刚确认的云端 revision 继续提交。
- 详情页和录制页进入及回前台执行会议级 GET。完全相同的内容、编辑时间和客户端时间可以安全附着；存在未完成 outbox 或 unresolved conflict 时，不同云端内容不得覆盖本机。
- 409/412 或 pull 分歧进入同一 `manual_note` conflict。旧 operation 被阻塞，状态槽显示“笔记同步冲突，点击处理”；版本 sheet 只提供本机/云端两个候选和一个提交动作。
- 选择本机时先推进本机 revision/clock，再以当前云端 revision 创建新 operation；选择云端时原子应用云端内容或明确接受云端空白，并使当前 Summary 进入 `stale`。

#### Summary 输入

总结 input fingerprint 必须包含：

```text
active transcript revision ID + normalized segment hashes
manual note revision + manual note content hash
schedule snapshot hash
template ID + template revision
speaker assignment revision
```

人工笔记变化时，现有 Summary 标为 `stale`，但仍显示；用户主动选择“更新整理结果”才生成新版本。不得在每次按键后自动消耗总结服务。

#### UI

- `[INFERENCE]` 录音页内容区增加 `我的笔记 / 实时文字` 两个稳定页面；底部录音控制不移动。切换只改变内容区，不重建 recorder root。
- `[INFERENCE]` 详情主 Tab 增加“我的笔记”；与“文字记录”“整理结果”视觉和语义分开。
- 输入容器使用 Minutes 中性 surface/text/divider token，不使用 AI 渐变、巨大圆角或说明书文案。
- 只在真实保存中、保存失败或存在冲突时占用状态槽；不持续显示“自动保存”等教学文案。
- 键盘出现不挤动录音底部控制；内容区使用 inset/resize，固定操作区由同一 inset owner 管理。

#### 中断验收

录音中输入不少于三行，分别在以下时点强杀并恢复：刚停止输入、写入中、暂停录音、停止录音中。恢复后已确认落盘的字符必须完整；未落盘 draft 至少通过生命周期 flush 或恢复 journal 保留，不能回到空白。

### 9.4 TRN-01：Transcript 与音频联动

#### Draft 与 Final

- 实时 ASR 只写当前 `realtime_draft` revision；partial 行可以更新，final 行一旦落盘只允许服务端最终修订产生新 revision。
- 会后精加工完成后创建 `final` revision 并切为 active；保留 draft 直到 final 完整性验证成功。
- 完整性验证比较最晚时间、总字数、非空段数和服务端声明；final 明显短于 draft 时不自动替换，显示“文字记录仍在补全”。
- 说话人更名是 assignment/override，不重写原始 ASR 文本。

当前移动端实现将“明显短于”收敛为可复用纯函数，而不是页面内按行数猜测：NFKC 后非空 Unicode code point、非空段数、最大 `start/end` 时间共同参与；分段数单独减少永不构成拒绝，因为 final 可能合并 draft 段。`[INFERENCE]` 第一版要求至少两项显著回退，或时间/文字出现极端回退才保留 active draft。阈值集中在 `transcriptCompleteness.ts`，后续真实 10/30/60 分钟样本只调整这一处。服务端明确 `incomplete/processing/finalizing` 时，候选只能更新 `realtime_draft` 并保持补全状态；明确 complete 也不能绕过本机截断检测；无声明时按本机指标 fail-safe。

final 候选与当前 active revision 的读取、候选 revision 保存、active 切换和 processing stage 更新必须位于同一 SQLite transaction。被拒绝的 immutable final 仍以 inactive revision 保存，不能写入旧缓存覆盖当前可读 draft；相同内容后续仅声明从 incomplete 变 complete 时，不得通过修改 immutable revision 元数据伪造新版本。当前兼容层把 incomplete 内容写入可替换的 `legacy-live` draft，只有得到 final 候选且完整性通过时才创建并激活 immutable final。

#### 单场搜索

Kotlin `MinutesTranscriptSearchController` 持有：

```kotlin
data class TranscriptSearchState(
  val query: String,
  val matches: List<TranscriptMatch>,
  val selectedIndex: Int,
)
```

- 使用 Unicode NFKC、Locale.ROOT lowercase；中文按 substring，英文同样允许子串。
- 空 query 不显示结果；最多缓存 1000 个 match，超出显示 `1000+`，避免病态输入阻塞 UI。
- 上一处/下一处循环跳转；选中后滚动到段落并只高亮匹配范围。
- 搜索 query 是页面临时状态，不写会议数据库；页面 state store 可以保存“搜索是否展开”，不保存正文。

#### 播放高亮

- 对 active revision 的 segments 按 `start_ms` 排序，二分查找 `start_ms <= position < max(end_ms,next.start_ms)`。
- 播放器位置回调最高 4 Hz；只有 active segment 改变时更新 RecyclerView。
- 将 `MinutesTranscriptPageAdapter` 改为 `ListAdapter + DiffUtil`，使用 payload 更新旧/新 active row 和 match row；禁止每次位置变化 `notifyDataSetChanged()`。
- 点击段落 seek 到 `start_ms`，播放器准备完成前缓存最后一次 seek command。
- 没有本地/远端音频时，段落仍可搜索复制，但点击不假装播放；显示固定音频状态槽。
- 有 word timing 时才做逐词高亮；第一阶段段落高亮已经构成验收。

#### 长按与选择

- 正文 TextView 保持 `textIsSelectable=true`，不得让 root long-click 抢占系统选择。
- 系统 ActionMode 至少提供复制和分享选中文本；分享内容带说话人和时间，但不自动附整场 Transcript。
- 短按 seek 与长按选择必须真机验证：超过 touch slop 或进入 selection 后不触发 seek。

#### Snapshot 扩展

`MINUTES_SNAPSHOT_SCHEMA_VERSION` 与 Kotlin 常量一起升级。新增字段必须有默认值并 fail closed：

```ts
interface MinutesTranscriptLineSnapshot {
  // existing fields...
  active?: boolean;
  searchRanges?: readonly { start: number; end: number }[];
  selectedSearchMatch?: boolean;
  revisionKind?: 'realtimeDraft' | 'final' | 'reprocessed';
}
```

搜索 query 和 selection 可以由 native 局部状态管理；TS snapshot 变化时 controller 重新计算 match，不将每次按键穿越 bridge。

#### 精度验收

- 对 10、30、60 分钟三份中文录音，随机选择至少 20 个段落，点击后的播放器位置误差不超过 300 ms 或段落自身时间戳误差，取较大者。
- 搜索重复词，匹配总数、第二处跳转和滚动位置正确。
- 连续播放跨越 100 个段落无明显整页闪烁或滚动抖动。
- 后台播放返回详情后，高亮恢复到当前 MediaSession 位置。

### 9.5 SUM-01/SUM-02/SUM-03：结构化、有引用、可版本化的整理结果

#### 输出协议

服务端不得再把 Markdown 或 JSON 字符串作为唯一协议。目标 schema：

```json
{
  "schema_version": 2,
  "template_id": "general",
  "sections": [
    {
      "key": "overview",
      "kind": "paragraph",
      "title": "会议概述",
      "content": "……",
      "citations": [
        {
          "segment_id": "seg-123",
          "start_ms": 42000,
          "end_ms": 51000,
          "quote_hash": "sha256:…"
        }
      ]
    }
  ],
  "action_item_candidates": [
    {
      "content": "整理验证清单",
      "assignee": "王芳",
      "due_at": "<RFC3339 timestamp with timezone>",
      "citations": [{ "segment_id": "seg-456", "start_ms": 88000 }]
    }
  ]
}
```

服务端 Pydantic/JSON Schema 必须验证：section key 唯一、ordinal 稳定、引用 segment 存在、时间在音频范围内、action content 非空。无效引用删除并记录诊断；整体结构无效时允许一次受约束修复，仍失败则 stage 失败，原版本继续显示。

#### Prompt 输入

- 每个 Transcript 段使用不可歧义 ID，例如 `[seg:seg-123 t=42.000-51.000 speaker=spk-2]`。
- 明确区分 `【日程上下文】`、`【我的笔记】`、`【文字记录】`。
- 人工笔记是高权重意图但不是事实免检；与 Transcript 冲突时 Summary 应保留“笔记中记录/文字记录中提到”的来源差异。
- 相对日期继续以 schedule/meeting local date 解析，结果返回有时区的绝对时间。
- 超长会议可以抽取，但决定、更正、取消、行动及其 segment ID 不得因抽取丢失；当前 `prepare_compact_summary_input` 需要改为结构化 segment 输入，而不是先拼不可追踪纯文本。

#### 版本规则

1. 每次生成创建新 `summary_version`；不 UPDATE 旧版本的 generated content。
2. 当前版本没有用户编辑时，新版本 ready 后可以自动设为 active。
3. 当前版本存在任一 `user_text` 或关联行动项被用户修改时，新版本作为候选，UI 提示“新整理结果已生成”；用户选择后切换。
4. 用户编辑 section 写 `user_text`，保留 `generated_text` 和 citations。
5. 用户编辑不删除 citations；若编辑后引用已不再支撑内容，允许用户移除引用，系统不得伪造新引用。
6. Transcript revision、notes revision、template revision 或 speaker assignment 改变时旧版本标 `stale`，但不隐藏。
7. 历史版本入口放在更多菜单，不在主页面堆叠版本说明。

#### 客户端渲染

- Kotlin summary page直接消费 `MinutesSummarySectionSnapshot[]`，不再解析 raw JSON。
- legacy Markdown parser 只服务迁移的 `template_id='legacy'`，不得用于 v2 结果。
- 点击 citation 发出 `seekTranscript`，先切换文字记录页、滚动到 segment，再 seek 播放器；三个动作由一个 application command 保证顺序。
- Summary loading/error/ready 使用同一页面槽位；重新生成不清空旧版本。

### 9.6 ACT-01：行动项对象

#### 创建与合并

- 用户可以手动创建；Summary 只返回 candidate。
- candidate 的稳定 fingerprint：规范化 content、assignee、due、排序后的 source segment IDs、template key 的 hash。
- 若 fingerprint 对应一个从未被用户编辑且仍 pending 的旧 generated action，可以关联新 summary version，但不改变用户可见字段。
- 若旧 action 有 `user_edited_at_ms`、已完成或已 dismiss，重生成不得覆盖或复活。
- 新 fingerprint 创建新 action；旧版本不再提到的 action仍保留，最多标记来源版本已过期，不自动删除。

#### 编辑与执行

- 内容可编辑，空内容不能保存。
- 状态 pending/completed/dismissed；完成时间单独保存，取消完成恢复 pending。
- due time 可为空；有 due 时可创建本机提醒。提醒 deep link 定位 meeting + action item。
- “创建后续日程”复用现有 AddEvent draft，并在 action 保存 `followup_event_source_id`；重复点击不得创建多个 event。
- 每个 action 保留 meeting、summary version、segment/time 来源；从 action 点击来源必须回到具体 Transcript 时间。
- 第一阶段行动项只在会议详情和由提醒打开的详情中管理；不因 Fireflies 有 Tasks 主 Tab 就立即增加第三个底栏入口。

#### 同步冲突

- action 使用 entity revision。字段冲突时：完成状态按显式最近用户操作合并；content/due 同时变化则生成冲突副本并要求选择。
- 服务端必须返回稳定 action ID；当前 `_get_app_final_summary` 临时 UUID 逻辑必须移除。

当前 additive 纵切已在目标服务源码落地可靠上行 upsert：`MeetingActionItem` 保存稳定远端 ID 和单调 revision，`MeetingActionOperation` 持久保存幂等请求哈希及原成功响应；首次创建、同 key 重放、revision 更新、陈旧写拒绝均有窄合同。客户端把 409/412 的错误码与当前云端 payload 一起持久化，详情行显式标记冲突并暂停会产生新版本的完成/后续日程命令。用户选择本机版本时，旧未完成 operation 全部标记为被取代，并以云端当前 revision 创建新 operation；选择云端版本时，只覆盖当前协议能安全表达的字段，保留本机来源/创建身份，清除设备通知 ID 后对账。冲突状态、action、outbox、meeting sync state 和 canonical revision 同事务更新，CAS 或 payload 校验失败时保持 unresolved。会议级 action list/cursor/pull 现已完成源码切片：整页严格解析，本机不存在则插入，有未完成 outbox/冲突时只允许全字段相同的安全附着，无本机待写时只应用单调更高 revision，其余均生成可见冲突。来源 segment 只在 active Transcript revision 唯一映射时保留链接。该切片仍没有全账号 change feed、全局 sync cursor、batch、action tombstone 或运行中跨设备证据，不得据此宣称完整双向/跨设备同步。目标进程未启动，新表和 capability 尚未在运行实例生效。

为避免 pull 丢失用户语义，action v2 envelope 携带 `client_created_at_ms`、`user_edited_at_ms`、`completed_at_ms` 与 `generation_fingerprint`。创建时间、source kind、source Summary/segment/time 和 generation fingerprint 是 identity/provenance，首次创建或旧表一次性补全后不得被普通更新改变；content/status/assignee/due/reminder/follow-up 和相应用户时间是 revision 管理字段。completed 必须有处于 action 生命周期内的完成时间，非 pending 不保留提醒，manual/marker 不携带 generated fingerprint。字段已同步到目标源码并通过窄合同，远端读取与 active Transcript 来源 ID 映射已有客户端源码闭环；真实旧表升级、账号拉取和跨设备收敛仍没有运行证据。

#### 验收

编辑内容、设截止、完成、重新生成 Summary、重启 App、换账号再返回；用户编辑和完成状态必须保持。点击来源能跳到正确段落，创建提醒后系统通知标题与正文均为中文。

### 9.7 ANDR-01：本机录音与业务数据库协调

原生 recording journal 是音频安全真相，SQLite 是业务投影。协调器 `RecordingReconciler` 在启动、回前台和录音页进入时执行：

1. 调 `recoverNativeRecordings()` 获取 finalized/recovered 文件。
2. 按 exact session ID 匹配 meeting；不允许用文件时间猜测覆盖已有录音。
3. 有 journal 无 meeting 时创建 `origin='ad_hoc'` 的恢复记录，并标明 `recovered`。
4. 有 meeting 指向不存在文件时，不删除 meeting；recording asset 标 `missing`，保留 Transcript/notes/summary。
5. WorkManager 已成功但 JS pending registry 未清时，以远端 `audio_available` 和 worker result 共同确认后清理。
6. stop 超时但 `localSaved=true` 时 capture=`local_ready`，ASR/transcript 单独进入待恢复；不得显示麦克风失败。

应用层不得把数据库写、上传、最终 Transcript 拉取和 Summary 生成串成一个必须全部成功的 `try`。每阶段完成后立即 commit，自身失败只改变自身 stage。

## 10. P1 功能详细设计

### 10.1 IMP-01：音视频文件与系统分享导入

#### Android 入口

1. UI 文件选择使用与当前 Expo SDK 匹配的 Document Picker，调用 `ACTION_OPEN_DOCUMENT`，MIME 初筛 `audio/*` 和受支持 `video/*`。
2. `MainActivity` 增加 `ACTION_SEND`/`ACTION_VIEW` 接收，但只接受单文件；多选第一阶段明确拒绝并用中文提示。
3. `singleTask` Activity 必须同时处理 cold-start initial intent 和 `onNewIntent`；短窗口去重使用小写 scheme/authority 与解码后的 path/query 形成规范 URI 身份。size/lastModified 只用于预检和来源变化判断，不参与短窗口身份，因为等价 URI 的编码或 grant 状态会让 ContentProvider 元数据暂时缺失。
4. Android 组件和 intent-filter 通过现有 config plugin 生成，避免 `expo prebuild` 覆盖手改 manifest。

#### 摄取而非长期依赖 URI

- 不能假设分享方 URI 永久有效。Native `MediaIngestor` 使用 `ContentResolver.openInputStream()` 流式复制到 app-private `meeting-audio/imports/{meetingId}/`。
- 复制过程中计算 SHA-256、字节数，写 `.part`，`fsync` 后原子改名；进程中断保留 ingest journal，重启可重试或清理无主 `.part`。
- 禁止把整个文件读入 JS 或 base64；当前 `audioUriToBase64()` 只适用于短语音日程，不用于会议导入。
- 文件大小上限由服务端 capability 返回；本机预检磁盘可用空间至少大于文件大小加 10% 安全余量。
- 元数据用 MediaMetadataRetriever/Media3 读取时长、容器和音轨；格式不支持时在创建处理作业前失败。

#### 支持范围

- 第一版可靠支持当前播放器和服务端已验证的 WAV、MP3、M4A/AAC、OGG、WEBM、FLAC 音频。
- 视频只在服务端确认抽取音轨能力和文件上限后开放对应 MIME；UI 不因扩展名存在就声称支持。
- 电话录音只能作为已有文件导入，不请求通话录制或后台捕获其他 App 音频。

#### 流程

```text
选取/分享 URI
  -> ContentResolver 检查真实元数据
  -> 用户确认标题/时间/可选关联日程
  -> 持久化 scope/title/time/calendar draft
  -> 本机流式摄取
  -> 创建 MeetingNote + RecordingAsset(imported)
  -> 上传
  -> 转写
  -> 整理
```

来源 `file_import/share_intent` 复用同一播放器、Transcript、Summary、Action 和分享页面。日历关联是可选动作；若 occurrence 已有会议，当前明确要求选择其他日程或不关联，不自动覆盖。显式合并必须等目标会议选择、资产归属和冲突回滚合同完成后另行开放。处理语言没有可验证的请求字段前不得展示无效控件。

#### 验收

至少验证 7 种格式、0 字节、伪装扩展名、URI 权限撤销、2 GB 以上拒绝路径、复制中强杀、上传中断和重复分享。导入中断不能出现只有列表卡片但无恢复动作的“僵尸会议”。

### 10.2 MRK-01：会议 Marker

#### 记录

- `[INFERENCE]` 录音底部操作区增加一个 44–48 dp 触控目标的“标记”图标动作；图标和状态继承最近的 Minutes operation family，不增加说明文字。
- 点击时从 native recorder snapshot 读取 `durationMs`，而不是用墙钟与 startedAt 相减。
- 本地事务立即写 marker；轻触觉反馈和简短 Toast `已标记 12:34`，不弹阻断 Dialog。
- pause 状态允许标记当前停点；preparing/finalizing 不允许，按钮 disabled 且布局不移动。

#### 会后关联

- final Transcript ready 后，后台 reconciliation 找到时间最近且覆盖 `position_ms` 的 segment，写 `nearest_segment_id`。
- Marker 页面/区域按时间排序，点击 seek；没有音频时只定位 Transcript。
- 可从 Marker 创建行动项，默认 source_kind=`marker`，但不自动将附近文字当成任务。
- 可分享“时间 + 附近一段文字”；第一阶段不生成媒体片段。
- 删除 Marker 不删除由它创建的行动项，只清除 source marker link 并保留 meeting/time。

### 10.3 SUM-02：引用生成与校验补充

引用功能晚于基础 Summary sections 上线，采用以下两阶段策略：

1. 服务端让模型输出 segment ID；校验未知 ID、时间边界和空引用。
2. 对没有合法 ID 但含短 quote 的结果，在同一 Transcript 内做规范化精确匹配；唯一命中才回填，零/多命中均不猜。

`quote_hash` 用于发现 Transcript revision 后内容漂移，不作为加密或权限边界。切换 final/reprocessed Transcript 时，旧 Summary 仍引用其原 revision；用户点击旧引用应加载对应 revision 或提示该版本文字已归档，不能把引用悄悄指向新段落。

当前纵向实现采用任务输入 Transcript 作为唯一 canonical 索引：模型时间一律忽略，服务端用真实 segment 秒值换算毫秒；合法 ID 也必须与同段逐字 quote 相符。空 quote、未知/重复/不可映射 ID、无效时间和多义 quote 均 fail closed。无声明 citation 的确定性 fallback 只有在最终文本作为短 quote 唯一命中一个稳定 segment 时才回填；模型显式声明了空或错误 citation 时不得借 fallback 洗成有效引用。`quote_hash` 对完整 segment 文本计算 SHA-256；action identity 使用排序后的来源 segment IDs。compact、普通总结和 Map-Reduce 都保留来源，游客请求也传递本机 line ID，避免服务端自造 ID 无法映射锁定 revision。源码与窄合同已同步，运行中服务与真实模型样本仍是退出条件。

### 10.4 ENTRY-01：会前通知和 occurrence 直达

当前 event reminder registry 继续负责去重、取消和 occurrence identity。实际 version 3 notification data 保持 event-only，不预先写 meeting ID 或把点击动作塞进业务 payload：

```ts
type MeetingStartNotificationData = {
  kind: 'event';
  version: 3;
  eventSourceId: string;
  eventOccurrenceDate: string;
  notificationScope: ScopeKey;
  fingerprint: string;
  eventSnapshot: NotificationEventSnapshot;
};
```

- 通知标题和正文均为中文：标题“日程即将开始”，正文使用用户日程标题；空标题沿用日历展示层的 `(无主题)`，不得回写领域标题。
- Android category action identifier `start-or-resume-meeting` 与默认 action 分别解析为 `start-or-resume-meeting/open-event`；semantic intent 与 occurrence ref 在响应后持久化，兼容旧 pending event 缺 intent 的情况。
- 通知 action 只携 occurrence ref，不携 meeting ID；打开后 `openOccurrenceMeeting()` 原子解析，避免旧通知指向过期 meeting。详情页与通知必须调用同一用例。
- App Lock 开启时先通过 gate，再执行 pending semantic action；认证失败不创建 meeting。
- 点击通知时若已有 active recording，直接继续；已有 ended 记录则查看；没有才创建。
- 通知被重复投递或用户连点不会创建重复 meeting。
- 响应成功后按原 notification ID 移除系统卡片；默认点击仍只打开日程详情，不能隐式创建 meeting。

当前本机实现与模拟器证据见 [`implementation/contracts/phase-6-entry-evidence.md`](implementation/contracts/phase-6-entry-evidence.md)。服务端冲突裁决、App Lock 生物识别任务和真机/不同 ROM 仍是退出条件，不因本机纵切通过而视为 Phase 6 完成。

### 10.5 ENTRY-02：Widget 与 Quick Settings Tile

#### Widget

- 原生 AppWidget 不直接启动 React Native 查询 SQLite；JS/领域层每次事件或 meeting projection 改变时写一个最小 `UpcomingEventsProjection` 给 native DataStore/SharedPreferences。
- 投影最多包含未来 24 小时的 5 个 occurrence：ref、显示标题、时间、meeting action state、更新时间；不含描述、Transcript、Summary 或我的笔记。
- Widget 读取投影并生成 PendingIntent；过期投影显示“打开老记查看”，不得展示错误日程。
- 用户开启 App Lock 时提供“锁屏隐藏标题”设置；默认遵循当前隐私设置。

#### Quick Settings Tile

- Phase 0 先在 `app.config.js` 固定自有 scheme `laoji` 并让 navigation parser 只接受白名单 route/参数；通知、Widget、Tile 共用同一 semantic-link resolver，不各自解析字符串。
- Tile 点击只打开 `laoji://meeting/new?origin=quick_tile`；不在后台静默启动麦克风，避免 Android 后台限制和误录。
- Activity 可见、权限通过、App Lock 通过后进入临时会议录音页；沿用现有自动开始行为前必须有一次真机确认。
- 正在录音时 Tile 显示 active，但点击只返回当前录音，不直接 stop。

### 10.6 TPL-01：内置会议模板

模板是版本化配置，不是不同录音流程：

```ts
type MeetingTemplate = {
  id: 'general' | 'one_on_one' | 'project_sync' | 'interview';
  revision: number;
  title: string;
  sectionSchema: readonly SummarySectionDefinition[];
  actionExtraction: 'standard' | 'follow_up_focused';
};
```

- 通用：概述、关键讨论、决定、行动项。
- 1:1：讨论主题、反馈/关注、双方约定、后续事项。
- 项目同步：进展、风险/阻塞、决定、行动项。
- 访谈：主题、受访者观点、证据摘录、后续问题。

模板只影响 Summary schema 和 prompt，不改变录音、上传、转写或权限。默认 `general`。更换模板创建新 Summary version；现有人工编辑版本继续保留。第一阶段不开放自由 prompt 编辑器，避免把模型错误直接暴露给用户。

当前移动端实现以 `templates.ts` 作为唯一内置注册表，模板键进入请求、pending task、v2 input fingerprint、恢复匹配和响应校验；登录态成功轮询优先消费该 task 自身结果，避免快速切换模板时读取到另一版本。Android 原生详情与通用详情均从“生成/重新生成”打开同一模板 sheet，更换模板继续沿用 immutable Summary version 保护，不覆盖人工编辑版本。

服务端采用严格 `id@revision` 白名单，把模板 prompt 作为临时 suffix 传入既有模型 CLI，并把固定 `template_sections` 归一化为 schema v2。真实 `FinalSummary` 表尚无模板列，因此兼容阶段将 v2 envelope 存入输出 JSON 的 `_laoji_structured_summary`，不伪造已完成的数据库迁移。补丁已与共享服务器目标工作区当前源码三方合并并同步，保留任务隔离、幂等、删除保护和总结质量清洗；服务未启动，因此真实四模板模型输出、账号链路和运行 OpenAPI 仍是未完成项。合同和模拟器证据见 [`implementation/contracts/phase-6-template-evidence.md`](implementation/contracts/phase-6-template-evidence.md)。

### 10.7 SERIES-01：重复会议系列记忆

#### 系列身份

- 对 calendar origin，`series_key = calendar:{scope_key}:{sourceEventId}`。
- occurrence exception、移动和 `following` segment 仍属于同一 source series；若服务端明确拆成新 source ID，则从拆分点起成为新系列。
- ad-hoc/import 第一阶段没有 series；P2 可由用户手动加入系列，禁止仅凭相似标题自动合并。

#### 会前投影

打开未来 occurrence 时查询同系列、当前 occurrence 之前最近一场 `ended` MeetingNote，投影：

- 上次会议日期和标题。
- 上次 active Summary 的决定 sections，最多 3 条。
- 同系列所有未完成 action，优先 due 时间，最多 5 条。
- 每条都保留来源 meeting 和 citation。

这是确定性查询，不先引入跨会议 LLM。会前内容默认只读；用户选择“带入我的笔记”时才复制为新会议人工笔记，且复制内容标明来源，不能自动污染新笔记。

当前本机纵切以 `calendarMeetingSeriesKey()` 统一生成规范 key，migration v10 回填旧 link；repository 严格按 scope、active link、当前 occurrence 之前和 ended lifecycle 查询最近会议与原始 pending action。未来重复 occurrence 的日历详情以无卡片嵌套的信息组展示上次会议、最多三条决定和最多五条事项；事项跳转携带原 action ID，完成后下一次查询自然移除。用户可在默认不勾选的 bottom sheet 中明确选择决定/事项；写入前重新查询并校验来源 ID，通过统一 occurrence 用例找到或创建目标会议，以 revision CAS 在保留已有正文的前提下追加带日期、标题、负责人和截止时间的来源块，不复制 action 对象。

migration v13 的 `meeting_series_carry_imports` 以 `(target_meeting_id, source_kind, source_item_id)` 唯一标识一次来源导入，并固化来源 meeting/occurrence/title/content、负责人、截止时间、segment 与 start time 快照。ledger insert 与人工笔记 CAS 必须在同一事务；只渲染本次成功插入的项目。删除目标 meeting 级联删除 ledger；来源 meeting 不设外键，删除来源后仍保留已写入笔记的解释快照。v13 之前的纯文本块不反向猜测 ledger；Summary 重生成若改变决定 identity，语义相同文本仍可能成为新来源项目。模拟器以“决定 A + 事项 B”后再选“事项 B + 决定 C”验证最终三条 ledger、笔记 revision 2、事项 B 正文一次。

决定 citation 只在可证明映射时用于精确回跳：section 仅一条决定时保留其引用；多条决定必须与按 ordinal 排序的 citation 数量相等并按位置一一绑定，否则该决定不携带精确来源。可靠映射进入来源会议“文字记录”并按 segment/source time 定位；歧义或缺失时退回来源“整理结果”。Calendar detail snapshot 为 v2；Minutes snapshot v9 提供初始 Transcript 定位 request。合法 `laoji://` 冷/热深链不会被媒体导入 inbox 抢占。本机合同和模拟器证据见 [`implementation/contracts/phase-6-series-memory-evidence.md`](implementation/contracts/phase-6-series-memory-evidence.md)。

#### Summary 使用

新 Summary 可以接收用户明确选择的 carry-forward actions；未选择的历史内容不进入 prompt。由新会议确认完成旧行动项时，修改的是同一个 action，而不是复制一条同名任务。

“带入我的笔记”只授权写入私人笔记，不自动授权把内容发送给模型。当前 Summary carry-forward 在模板选择后重新查询候选：默认零选择，取消终止生成，“不引用”显式继续；只有独立勾选的项目进入请求。授权 request ID、项目快照、模板和 Transcript 固化进 input fingerprint 与 pending task；恢复、任务丢失重提及结果校验保持同一 identity。账号服务校验来源会议归当前用户；历史内容只作为背景，不得冒充本场 Transcript 或生成本场引用。目标服务尚未运行，因此真实模型利用质量和未选内容隔离仍需运行证据。

### 10.8 SHARE-01：分层分享

#### 默认选择

打开分享 sheet 时：

| 内容 | 默认 | 说明 |
|---|---:|---|
| 基本会议信息 | 开 | 标题、日期、可选地点 |
| 整理结果 | 开 | 当前 active version |
| 行动项 | 开 | 作为整理结果的一部分，可单独关闭 |
| 文字记录 | 关 | 用户显式开启 |
| 录音 | 关 | 用户显式开启 |
| 我的笔记 | 关 | 用户显式开启，需二次强调它是私人原文 |
| Marker/附件 | 关 | P1/P2 可选 |

不得保留当前 `bundle` 一键无提示包含全部资料的语义。可以保留“完整资料”，但必须先展示以上勾选项；默认只选当前可用的基本信息、整理结果和行动项，后三类原始/私人内容始终默认关闭。

#### 导出 manifest

ZIP/文档同时生成内部 `share_manifest.json`：meeting ID 的不可逆短 hash、导出时间、包含内容、Transcript revision、Summary version，不含 access token、speaker embedding 或本机绝对路径。文件名保持中文；临时目录继续按当前 10 分钟清理合同。

#### 分享链接（P2）

服务端链接必须保存内容级 scope 和可撤销 grant；后续重新生成 Summary 不自动改变已分享内容，除非用户选择“始终显示最新版本”。默认分享冻结版本。

### 10.9 SPK-01：说话人反馈闭环

#### 三层对象

1. `speaker_cluster`：本场 diarization 的匿名簇，例如 Speaker 1；不是人物身份。
2. `speaker_assignment`：本场簇/段落被用户指派给某个 profile 或临时名称。
3. `speaker_profile`：账号级、经过同意建立的声纹身份。

不得把“检测到三种声音”和“知道三个人是谁”混成一个字段。当前 UI 的百分比固定解释为“发言时长占完整录音的比例”；`confidence` 若展示则明确为转写置信度，二者不能互换。

#### 修正范围

用户修改说话人时明确选择：

- 仅此段。
- 本场同一 Speaker 簇。
- 关联现有讲话人资料并用于以后会议。

创建新声纹或将会议片段用于训练必须满足已有显式同意；仅改本场显示名不自动创建生物特征资料。游客可以设置 meeting-local 名称，但没有账号级 profile，也不在登录迁移时转成声纹。

#### 服务端反馈

```json
POST /api/laoji/v2/meetings/{id}/speaker-corrections
{
  "client_request_id": "uuid",
  "transcript_revision_id": "tr-1",
  "scope": "segment|cluster|future_profile",
  "segment_ids": ["seg-1"],
  "cluster_id": "cluster-2",
  "speaker_profile_id": "spk-9",
  "display_name": "王芳",
  "consent_to_profile_update": true,
  "base_revision": 3
}
```

服务端立即返回 assignment revision；模型更新异步执行。可用作 profile 样本的片段必须达到时长、信噪比、无重叠语音和采集 profile 一致性阈值，否则只保存标签反馈。

#### 未来与旧会议

- 新会议实时 ASR 可以使用已注册 profile 返回候选名字，但低置信度仍显示匿名 Speaker，不强行命名。
- 会后 diarization/identification 产生 final assignments。
- “重新匹配旧会议”是用户触发的 batch job；创建新 transcript/speaker revision，不覆盖手工 assignment。
- 每次模型版本和 profile revision 写入处理元数据，便于判断结果是否可比较。

当前本机纵切实现 active 稳定 Transcript 的“仅此段 / 本场同一匿名簇”修正。migration v11 保存不可变 correction/assignment 历史，当前显示通过 override 投影；migration v12 增加独立服务端 Transcript revision 映射和 correction 同步结果。游客只产生 `local_only` 名称；账号 correction 仅在具备服务端 segment IDs 时与 outbox 同事务写入，真正发送还必须具备服务端 Meeting/Transcript revision IDs，并由实时远端 capability 明确开启。请求使用 correction ID 幂等，支持失败退避和 409/412 冲突记录；本机 canonical hash 不作为远端 ID。两种作用域都不创建 profile。修改会把当前 Summary 标为 `stale` 但保留正文；realtime draft 直接以中文阻止。实现合同、飞书来源分类、SQLite 计数和模拟器恢复证据见 [`implementation/contracts/phase-7-speaker-assignment-evidence.md`](implementation/contracts/phase-7-speaker-assignment-evidence.md)。远端当前不可达，故真实账号反馈、future profile、跨设备同步和旧会议重匹配仍按本节目标保留为未完成项。

### 10.10 PRIV-01：默认私有与删除语义

- 新 MeetingNote 默认 private；系统分享只导出用户当次选择的文件，不自动创建公开链接。
- 本地未上传录音删除时明确提示永久丢失，不能写成“移到回收站”。
- 已同步 meeting 的服务端删除目标是 soft-delete + 30 天回收站；服务端尚未实现前，UI 不得虚构可恢复。
- 删除 active recording 必须先停止并安全 finalize；若 stop 失败但文件已保存，提供“保留并稍后处理”，不允许直接清空。
- 删除 meeting 时依次处理 outbox、WorkManager、播放缓存、recording journal 和 DB；远端删除失败时本地 tombstone 保留并重试，避免会议重新同步回来。
- 删除 occurrence 不删除 meeting；删除 speaker profile 不重写历史文字，只移除未来识别资格和必要的身份展示。

## 11. P2 功能详细设计

### 11.1 QA-01：单场带来源问答

上线门槛：引用有效率、Transcript 时间跳转成功率和 Summary 独立重试率均已达到第 16 节阈值。

- 检索范围默认仅当前 meeting 的 active Transcript、active Summary 和用户选择包含的我的笔记。
- 每个答案必须返回一到多个 `segment_id`/section citation；无足够来源时回答“当前会议记录中没有足够信息”，不得补常识。
- 后续问题保留单场 thread context，但每轮重新校验引用仍属于当前 meeting/revision。
- 默认不把“我的笔记”发往问答服务；首次使用时由用户选择是否纳入，选择按 thread 保存。
- 服务端保存问题、答案和 citation，不保存模型隐藏推理。
- UI 放在会议更多动作或详情次级入口，不增加底栏 Agent。

### 11.2 ORG-01：组织与多场找回

实施顺序固定：

1. 用户标签：多对多，名称唯一、可改名/合并。
2. 单层 Folder：只有真实大量会议需求时添加；不先做树形权限。
3. 多场搜索：标题、我的笔记、Transcript、Summary、Action 分源显示。
4. 人物聚合：优先稳定 speaker profile ID；只有名字没有 profile 时按作用域内精确名字临时聚合并标为未确认。
5. 主题聚合：先用户标签，再实验模型 topic；模型 topic 不自动变成用户标签。

搜索结果必须展示命中来源和时间；点击 Transcript 命中直接进入 meeting 并 seek。全库问答仍不因此自动开放。

### 11.3 COLLAB-01：轻协作

只在个人闭环稳定后添加：

- 分享单个 MeetingNote 或单个 ActionItem。
- 权限仅 `viewer` / `action_editor`；不做 Workspace 角色树。
- action_editor 可以改状态、负责人和截止时间，不能访问未分享的 Transcript、音频或我的笔记。
- 每次修改有 actor、revision、updated_at；冲突按 ACT-01 规则。
- 无复杂自动分享、Channel、用户组或组织默认录制规则。

### 11.4 CLIP-01：重要媒体片段

- 来源是 Marker 或 Transcript 选择，保存 start/end；默认前后扩展小缓冲但允许调整。
- WAV 本机录音可由 native 按 PCM frame 边界复制并重写 WAV header；不得解码整段到内存。
- MP3/M4A/视频等导入格式第一版走服务端异步导出，避免在移动端引入庞大转码栈。
- 片段最短/最长限制由 capability 返回；导出前明确显示范围和是否包含说话人/文字。
- 片段是派生资产，删除片段不删除原录音；删除原录音前提示现有片段依赖。

### 11.5 ATT-01：时间点附件

- 照片和简短文本作为 `attachment`，绑定 marker/time，不嵌入 Transcript 文本。
- 拍照需要新增相机权限；当前 manifest 明确移除了 CAMERA，因此在没有真实高频需求前优先支持相册/文件选择，不擅自扩大权限。
- Summary 是否读取附件文字/图片必须由用户显式选择，并记录在 input fingerprint。
- 附件分享默认关闭；删除附件不改变 Transcript 或 Summary 历史版本。

## 12. 服务端与同步契约

### 12.1 开工前的契约盘点

移动仓库不包含完整生产服务端。本机可见的 `server-work` 和 `/home/yydd/LaoJi/server-staging/qwen35-9b-cutover/smart-meeting-ai` 是部署副本/覆盖文件，不能自动等同线上版本。Phase 0 必须从实际部署读取 OpenAPI、数据库 migration 版本和以下 endpoint 的请求模型：

- meeting create/update/list/transcript/audio/summary。
- guest session、guest import、speaker profile。
- event create/edit command 的 idempotency 和返回 ID。

将结果保存为不含凭据和私人正文的版本化 contract snapshot。发现不一致时先兼容服务端，不以移动端当前 TypeScript interface 作为事实。

当前 Phase 0 契约证据记录在 [`implementation/contracts/phase-0-meeting-contract-snapshot.md`](implementation/contracts/phase-0-meeting-contract-snapshot.md)。该记录明确区分线上探测、本机部署副本和目标 v2 提案；线上契约未确认前不得开启 v2 写入。

### 12.2 能力协商

新增：

```http
GET /api/laoji/capabilities
```

目标响应：

```json
{
  "schema_version": 1,
  "meeting_notes_v2": true,
  "structured_summary_v2": true,
  "summary_citations": true,
  "action_items_v2": true,
  "action_items_pull_v2": true,
  "speaker_corrections": false,
  "media_import": {
    "mime_types": ["audio/wav", "audio/mpeg", "audio/mp4"],
    "max_bytes": 1073741824
  },
  "sync_cursor": true,
  "soft_delete_days": 30
}
```

移动端按能力显示功能；服务端未开放时不展示死按钮。capability 缓存带获取时间，网络失败使用上次值，但会改变数据的操作必须在服务端再次校验。

当前目标源码已有该 endpoint 的保守子集：只有 action 表可查询时才报告 `action_items_v2=true` 和独立 `action_items_pull_v2=true`；未实现的 `meeting_notes_v2`、全局 `sync_cursor`、`speaker_corrections` 继续返回 false，`media_import` 与 `soft_delete_days` 返回未知。目标服务尚未启动，因此客户端仍必须按缺失能力处理，不能用源码存在代替运行时协商。

### 12.3 MeetingNote v2 endpoint

建议以现有 meeting ID 作为远端 MeetingNote ID，新增规范化子表，避免并行维护两套会议主对象。

```http
POST /api/laoji/v2/meeting-notes
Authorization: Bearer …
Idempotency-Key: {client_note_id}
Content-Type: application/json
```

```json
{
  "client_note_id": "local-uuid",
  "origin": "calendar",
  "title": "",
  "recorded_at": "<RFC3339 timestamp with timezone>",
  "occurrence_ref": {
    "calendar_source_event_id": "1234",
    "occurrence_date": "<local YYYY-MM-DD>",
    "calendar_revision": 8,
    "recurrence_segment_id": "2"
  },
  "schedule_snapshot": {
    "title": "项目同步",
    "planned_start": "<RFC3339 timestamp with timezone>",
    "planned_end": "<RFC3339 timestamp with timezone>",
    "timezone": "Asia/Shanghai",
    "location": "会议室 A",
    "participants": []
  }
}
```

响应必须包含 `id`、`client_note_id`、`revision`、规范化 occurrence ref、所有 processing stages 和 `created_at/updated_at`。语义：

- 同 Idempotency-Key 重放返回相同 ID，不重复创建。
- occurrence 唯一冲突返回 409，并在结构化 error 中给 `existing_meeting_id`。
- title 空字符串合法。
- occurrence_ref 缺失时 origin 不能是 calendar。

其他 endpoint：

```text
GET    /api/laoji/v2/meeting-notes?cursor=&limit=
GET    /api/laoji/v2/meeting-notes/{id}
PATCH  /api/laoji/v2/meeting-notes/{id}             If-Match: revision
PUT    /api/laoji/v2/meeting-notes/{id}/manual-note If-Match: note revision
DELETE /api/laoji/v2/meeting-notes/{id}             soft delete when supported
POST   /api/laoji/v2/meeting-notes/{id}/restore
```

列表返回稳定 cursor，不再让移动端固定拉最多 50 页完整历史。cursor 必须按 `(updated_at,id)` 排序并包含 tombstone，避免同毫秒更新丢失。

### 12.4 Recording 与处理作业

现有 `/audio` 和 `/upload` 可保留兼容，v2 将资产和处理分离：

```text
POST /v2/meeting-notes/{id}/recording-assets       注册资产/幂等
PUT  /v2/recording-assets/{assetId}/content        上传或分片完成
POST /v2/recording-assets/{assetId}/transcriptions 创建转写作业
GET  /v2/processing-jobs/{jobId}?wait_ms=5000      长轮询
POST /v2/processing-jobs/{jobId}/retry             只重试该阶段
```

每个 job 响应至少包含：`job_id`、`meeting_id`、`stage`、`status`、`attempt`、`progress`、`error_code`、`retryable`、`result_revision_id`。上传成功不得自动被 Summary 失败回滚。

WorkManager 上传继续使用 credential lease 和 generation；但 worker 的 endpoint、MIME、checksum、asset ID 从 input data 获取。结果 `uploaded/already_uploaded/deleted` 均需幂等。遇 401 不无限重试，等待新 credential generation；遇 4xx 永久格式错误标 blocked；5xx/网络按指数退避。

### 12.5 Transcript API

```text
GET  /v2/meeting-notes/{id}/transcript-revisions
GET  /v2/meeting-notes/{id}/transcripts/{revisionId}?cursor=&limit=
PATCH /v2/meeting-notes/{id}/transcript-segments/{segmentId}
POST /v2/meeting-notes/{id}/speaker-corrections
```

- segment ID 在 revision 内稳定，分页按 ordinal/cursor，不按 offset；避免新段插入造成重复。
- final revision 只有服务端作业提交后一次激活；客户端读取到未完整 final 时继续显示 draft。
- 编辑 Transcript 正文若后续开放，必须产生 correction revision 或保存 override；不得直接破坏旧 Summary citation。

### 12.6 Summary API

```http
POST /api/laoji/v2/meeting-notes/{id}/summary-versions
Idempotency-Key: {client_request_id}
```

```json
{
  "client_request_id": "uuid",
  "template_id": "general",
  "template_revision": 1,
  "transcript_revision_id": "tr-final-1",
  "manual_note_revision": 4,
  "schedule_snapshot_hash": "sha256:…",
  "speaker_assignment_revision": 2,
  "carry_forward_action_ids": []
}
```

- 同一完整 input fingerprint + template 可以返回已有 ready version，除非明确 `regenerate_nonce` 创建新候选。
- `force=true` 不能再复用为含糊 query；重生成通过新 request ID/nonce 表达。
- GET job 与 GET version 分开；job 过期后 version 仍存在。
- 服务端将原始模型输出保存在受控诊断存储，客户端永远只拿通过 schema 验证的 sections。
- guest 总结仍可 transient，但客户端必须把结果落本机 summary version；登录迁移上传结构化版本而不是 raw 模型字符串。

### 12.7 Action、Marker 与同步

```text
PUT        /api/laoji/v2/meeting-notes/{id}/action-items/{client_action_id}
GET        /api/laoji/v2/meeting-notes/{id}/action-items?cursor=&limit=
POST/PATCH /v2/meeting-notes/{id}/markers
GET        /v2/sync/changes?cursor=&scope=meeting
POST       /v2/sync/batch
```

Action upsert 使用本机稳定 action ID 作为 `client_action_id`。首次创建发送 `If-None-Match: *`；已有远端实体发送 `If-Match: {remote_revision}`。`Idempotency-Key` 使用本次合并 cohort 中最后一个不可变 operation ID，成功响应必须返回稳定远端 ID、相同 client action ID 和单调整数 revision。409/412 必须返回可保存为冲突副本的当前远端 payload/revision，不得由客户端静默 last-write-wins。

当前服务端纵切严格实现上述单项 upsert：同一用户内持久化 Idempotency-Key 重放，key 与不同请求复用返回 409，已存在/缺失/陈旧 revision 返回 412 和当前实体；operation 结果不自动清理，满足至少 30 天去重窗口。同一纵切新增会议所有权保护的 collection GET，按 `(updated_at, id)` 升序分页并返回不透明 cursor；已越过 cursor 的 action 后续更新会推进服务端 `updated_at` 并再次出现。目标服务启动时由既有 `create_all + ensure_app_meeting_schema()` additive 路径建表/索引。此次只同步源码并运行 Python 编译与 3 项窄合同，没有启动/重启目标服务，也没有把 8020 旧工作区当作该合同的运行证据。

客户端当前只在会议详情页进入/回到前台时拉取该会议 action，不扫描全账号。migration v14 将 cursor 与 canonical meeting/remote meeting/scope 绑定，每页数据合并和 cursor CAS 同事务提交。本机存在未完成 outbox 或未解决冲突时不静默覆盖；只有所有 wire 字段完全一致才收敛为已满足，否则写入冲突并阻止继续上行。无本机待写时只接受更高 remote revision；同 revision 不同 payload fail closed。pull 后统一重建/取消当前作用域的设备提醒。

`sync/batch` 每个 operation 独立返回 success/conflict/permanent_error/retryable_error，不能因一项失败回滚整个客户端 batch。服务端保存 `operation_id` 去重结果至少 30 天。

Outbox 调度：

- 同一 aggregate 串行，不同 meeting 最多并发 3。
- 首次 claim 将当前最终 action 状态固化到 `request_payload_json`；网络结果不明确、进程中断或 token 切换后的重试必须复用该快照和同一 Idempotency-Key。后续本机编辑进入新 cohort，不能改写在途请求。
- `claim_token` 保护迟到响应：只有仍持有同一 token 的 `in_flight` cohort 可以 ACK、转 retry 或写 conflict；过期 claim 由新 token 回收。
- 网络恢复、App foreground、用户手动刷新触发。
- 自动重试遵守 next_attempt；手动重试可以绕过时间但不绕过 blocked。
- scope/token generation 改变时旧请求停止，不能把用户 A 的操作发送到用户 B。
- 客户端只有在本次实时 `GET /api/laoji/capabilities` 明确返回 `action_items_v2=true` 时才 claim/send；404、断网、旧缓存或缺字段均不发写请求，本机 mutation 不回滚。
- 409/412 不自动覆盖：冲突记录必须保留本机发送快照、云端 current payload/revision 和错误码。用户选择本机版本后用新 operation/Idempotency-Key 对云端 current revision 重试；选择云端版本后取消该 action 所有旧未完成 operation。损坏 payload、身份错配或 revision 漂移时保持 unresolved，不允许推测字段。
- 日志只记 ID、stage、状态、耗时和错误码，不记标题、笔记、Transcript、Summary 正文或 token。

### 12.8 服务端表与迁移原则

现有 `meetings` 继续为主表；新增至少：

- `meeting_occurrence_links`，用户+event ref 唯一。
- `meeting_manual_notes`，revision/updated_at。
- `recording_assets`、`processing_jobs`。
- `transcript_revisions`，现有 transcript rows 增 revision ID。
- `summary_versions`、`summary_sections`、`summary_citations`。
- `action_items`、`markers`。
- `idempotency_results` 或各表 client ID 唯一索引。
- `sync_change_log`，保留 cursor/tombstone。

所有 migration 先 additive、回填、双读，再切换约束；不得在同一部署中删除旧 `FinalSummary` 字段。回填 action 时为旧临时 UUID生成稳定 ID，旧客户端响应仍可由 active v2 version投影。

## 13. UI、原生快照与交互合同

### 13.1 通用原则

- 用户可见统一使用“会议记录”“会议录音”“文字记录”“整理结果”“我的笔记”，不得出现其他产品专有名称。
- 所有错误、警告、系统通知、权限提示和重试状态使用中文；服务商 raw error 必须经过映射。
- 不添加“按住说话”“AI 将自动……”等显而易见说明；通过熟悉图标、状态、动效和无障碍标签表达。
- Calendar 使用蓝色域；会议 AI/录音操作只有源证据支持时使用 Minutes 靛紫渐变，不能把行动项、笔记、导入页全部染成紫色。
- 页面切换共享 status/navigation inset owner；新 Tab 不销毁整个 native root，避免上下跳动。
- 所有异步状态使用固定槽，loading/error 不改变主按钮和播放器位置。

### 13.2 组件分类与证据

| Surface | 分类 | 设计依据 |
|---|---|---|
| 日程详情会议动作 | capability-reduced / LaoJi-only | `[PRODUCT]` occurrence 工作流；`[INFERENCE]` 采用 Feishu 日程详情动作容器与 UDButton 层级 |
| 我的笔记编辑器 | LaoJi-only | `[PRODUCT]` 人工主稿；`[INFERENCE]` Minutes 中性内容页和输入 token |
| 独立处理状态 | LaoJi-only | `[SOURCE]` 多竞品阶段；`[INFERENCE]` Feishu 状态/错误容器 |
| Transcript 搜索/高亮 | capability extension | `[SOURCE]` Otter/Granola/Fireflies；现有 Minutes Transcript 几何保持 |
| Marker | capability-reduced | `[SOURCE]` Otter/Fireflies；只保留单击标记，不复制剪辑器 |
| Action item row | LaoJi-only | `[SOURCE]` Notion/Otter/Fireflies；使用 Feishu checkbox/list/button hierarchy |
| 导入 sheet | LaoJi-only | Android 系统 picker + Feishu bottom sheet/UDButton |
| 分层分享 sheet | LaoJi-only | 现有分享能力 + Feishu sheet/checklist 语义 |

实施每个 surface 前必须补短 evidence note，包含 `[PRODUCT]/[SOURCE]/[DEVICE]/[INFERENCE]`。没有直对应组件时不得声称“飞书就是这样”。

### 13.3 Minutes snapshot v9 与后续扩展

当前运行合同为 v9：列表已包含 `mediaImporting` 与 `importMedia`，录音页已包含人工笔记和 Marker 状态，详情已包含 page states、结构化 sections/citations、actions、markers、播放器、action focus，以及 `focusTranscriptSegmentId`、`focusTranscriptPositionMs`、`focusTranscriptRequestId` 初始来源定位。TypeScript 和 Kotlin 必须同步使用版本常量，旧 schema 不得静默按当前字段解释；focus request 只有实际找到目标或可靠时间回退后才能消费，避免 Transcript 尚未加载时永久丢失定位。

后续 processing stage、版本选择和同步字段仍按当期纵切逐次增加；目标补充形状如下：

```ts
type MinutesDetailTab = 'notes' | 'transcript' | 'summary' | 'speakers' | 'info';

interface MinutesManualNoteSnapshot {
  content: string;
  revision: number;
  savePhase: 'idle' | 'saving' | 'saved' | 'failed' | 'conflict';
  message?: string;
  editable: boolean;
}

interface MinutesProcessingStageSnapshot {
  stage: 'capture' | 'upload' | 'transcript' | 'summary' | 'speaker';
  phase: string;
  label: string;
  tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
  retryable: boolean;
  progress?: number;
}

interface MinutesActionItemSnapshot {
  id: string;
  content: string;
  completed: boolean;
  dueLabel?: string;
  sourceTimeLabel?: string;
  hasSource?: boolean;
  sourceSegmentId?: string;
  sourceStartMs?: number;
  canEdit: boolean;
}

interface MinutesMarkerSnapshot {
  id: string;
  positionMs: number;
  timeLabel: string;
  nearbyText?: string;
}
```

新增 semantic actions：

```text
updateManualNote / retryManualNoteSave
createMarker / openMarker / deleteMarker / markerToAction
toggleAction / editAction / setActionDue / openActionSource / actionToEvent
openCitation
retryProcessingStage
selectSummaryVersion / regenerateSummary
openOccurrenceMeeting
```

所有 action 带 `meetingId` 和适用的 entity ID/generation；controller 拒绝 route 已切换后的 stale action。

### 13.4 Tab 和页面布局

- 详情目标 Tab 顺序：我的笔记、文字记录、整理结果、讲话人、信息。
- 在 360 dp 宽真机上若五项等宽导致文字挤压，使用可滚动 tab strip，但首次打开必须完整露出前三个核心 Tab；不缩小到难读字号。
- 录音页只在内容区切换我的笔记/实时文字；标题、位置、计时、波形、pause/stop/marker 固定。
- Summary 页面旧版本继续渲染，顶部状态区显示生成中/新版本已生成；不得用全页 spinner 擦除旧内容。
- Action 在 Summary 对应 section 内渲染为真正可操作 row；如果 Summary 没有行动项，用户仍可手动新增。

### 13.5 具体尺寸与状态

遵循 `feishu-ui-style` 当前 token：

- 页面 body `#F8F9FA`、surface `#FFFFFF`、主要文字 `#1F2329`、次要文字 `#646A73`、三级文字 `#8F959E`。
- Calendar 主操作默认 `#1456F0`，pressed `#0442D2`；危险操作 `#E22E28`。
- 标准中按钮 36 dp、16 sp、6 dp radius；全宽关键提交 48 dp、17 sp、6 dp radius。
- 会议录音主操作维持已确认的 44 dp 高、24 dp radius 和 source-backed 渐变；Marker 是次级图标动作，不与停止按钮同权重。
- 所有图标按钮有效触控范围 44–48 dp，glyph 16–24 dp；无障碍标签使用中文。
- 不使用 Android 默认 Button、任意大圆角、重阴影或每页新硬编码色板。

### 13.6 首帧、动画和无障碍

- 新 notes tab、import sheet、share sheet 在首帧读取当前 decor insets；不靠 mount 后补 padding。
- bottom sheet 从实测完整高度进入/退出，约 300 ms；backdrop 同步；退出结束后才导航/销毁。
- 录音页切 notes/transcript 不垂直动画整页。
- 当前 Transcript 高亮只改变行背景/指示，不改变行高度。
- 字体放大到 1.3x、TalkBack、键盘、三键/手势导航均验证。
- 真机视频验证 tab 切换、长按选择、marker press、sheet cancel、录音恢复和首帧；截图不能替代运动验证。

## 14. 代码改造地图

| 当前文件/模块 | 改造方向 |
|---|---|
| `src/types/index.ts` | 只保留导航 DTO；Meeting 领域类型迁往 `domain/meeting`，旧 interface 标 deprecated |
| `MeetingsStore.tsx` | 变成 repository facade，移除 meetings/transcript/summary 整体 JSON map |
| `EventsStore.tsx` | 保持 recurrence 事务；增加 occurrence meeting projection 查询，不把 meeting 塞回 CalEvent |
| `MeetingLiveScreen.android.tsx` | 收敛为 `RecordingSessionController` 订阅者；移出创建/停止/上传/同步长流程 |
| `TranscriptionScreen.android.tsx` | 收敛为 detail controller；summary task、audio materialize、action mutation进入 use case/repository |
| `nativeMinutesSnapshots.ts` | 从 repository projection 构建 v9 snapshot；不再把 Markdown 作为主 Summary 输入 |
| `minutes.ts` / `MinutesState.kt` | schema 同步升级，增加 notes/action/marker/stage/citation |
| `MinutesDetailPages.kt` | 新 notes page、Transcript search/highlight、结构化 summary/action/citation |
| `MinutesRecordingSurface.kt` | 内容切换、manual note editor、Marker；录音控制 geometry 保持 |
| `MinutesDetailSurface.kt` | 版本动作、引用跨 tab 跳转、稳定 page state |
| `MeetingUploadWorker.kt` | 从 meeting audio 扩展为 recording asset upload，保留 credential generation |
| `RecordingJournal.kt` | 保持文件安全合同；只增加可选 asset/session reconciliation metadata，禁止大改 |
| `meetingShare.ts` | 从 kind 三选一改为 content manifest；默认 summary-only |
| `MeetingImportSheet.tsx` / `MeetingMediaImportProvider.tsx` | 元数据确认、键盘稳定、occurrence 冲突预检；确认后才摄取 |
| `meetingMediaImportDrafts.ts` | 持久 scope/title/time/calendarContext；ready journal 恢复时阻止跨账号落库 |
| `guestDataMigration.ts` | v2 event ID map、逐实体阶段和 occurrence link |
| `notifications.ts` | 增 occurrence meeting action，不破坏现有 reminder registry |
| config plugin / native Android | share intent、Widget、Tile、相对路径构建配置 |
| `server-work/summary/api/app_meetings.py` 对应线上模块 | additive v2 models/endpoints、稳定 IDs、location/recorded_at/client ID 对齐 |
| `summary_tasks.py` / app summary generator | segment-ID 输入、sections/citations schema、immutable version |

## 15. 分阶段实施计划

### 15.1 执行原则

- 以 Android 优先，每个阶段包含必要的服务端适配和真机验证。
- 路线只规定依赖顺序、交付物和退出条件，不设日历日期或固定工作日承诺；实际节奏由当期风险、外部能力和验证结果决定。
- 每个阶段尽早产出可安装 APK；范围较大时使用 feature flag 拆分可验证纵向路径，不等待整阶段所有功能一次完成。
- 不并行修改 recorder 核心、SQLite cutover 和 Summary 协议三个高风险面；可以并行做只读 UI、服务端 additive schema 和证据采集。

### 15.2 路线

| 阶段 | 交付物 | 退出条件 |
|---|---|---|
| Phase 0：契约冻结 | 线上 API snapshot、相对构建路径、DB schema/migration runner、能力协商骨架 | 当前 APK 行为不变；Linux/Windows 路径无硬编码；shadow import 计数一致 |
| Phase 1：数据平面与独立状态 | SQLite canonical、repository facade、processing stages、原生 journal 对账 | 旧数据无损；断网上传/转写/总结可独立表达；产出安装验证包 |
| Phase 2：日程绑定与我的笔记 | occurrence 唯一绑定、事件动作、计划快照、notes autosave、游客迁移 v2 | 重复日程真实任务通过；强杀后笔记保留；产出安装验证包 |
| Phase 3：文字精确回听 | Draft/Final revision、搜索、匹配跳转、段落高亮、长按复制/分享 | 60 分钟中文会议性能/精度通过；产出安装验证包 |
| Phase 4：整理结果与行动 | sections、immutable versions、citations、action object、提醒/后续日程 | 重生成不覆盖；引用可回听；action 编辑/完成/提醒通过；产出安装验证包 |
| Phase 5：导入、Marker、分享 | 文件/系统分享摄取、Marker、分层分享、同步感知删除 | URI/强杀/断网上传恢复通过；默认不泄露额外内容；产出安装验证包 |
| Phase 6：快速入口与系列记忆 | 会前动作通知、Widget projection、Tile、四模板、确定性系列记忆 | occurrence 去重、App Lock、过期投影、历史 action 来源通过；产出安装验证包 |
| Phase 7：说话人闭环 | segment/cluster/profile 修正、反馈 API、旧会议重匹配 job | 中文多人样本达到阈值；手工 assignment 不被覆盖；产出安装验证包 |
| Phase 8：P2 实验 | 单场问答→标签/检索→轻协作→片段/附件 | 每项按真实使用指标单独决定扩量 |

### 15.3 依赖路径

```text
ARC-01
  ├─ PROC-01 ── SRC-01 ── CAL-01 ── SERIES-01
  │                 ├─ NOTE-01 ── SUM-01 ── SUM-03
  │                 └─ IMP-01
  └─ TRN-01 ── SUM-02 ── ACT-01 ── COLLAB-01
         ├─ MRK-01 ── CLIP-01 / ATT-01
         ├─ SPK-01
         └─ QA-01 / ORG-01

CAL-01 ── ENTRY-01 ── ENTRY-02
SUM-01 ── TPL-01
NOTE-01 + SUM-01 + TRN-01 ── SHARE-01
```

不得在 ARC/PROC/TRN/SUM-02 未稳定时提前做全库 Agent、复杂协作或媒体剪辑。

### 15.4 每阶段交付节奏

1. 开始：冻结当期 schema、snapshot 和 API contract，写 evidence notes。
2. 最小路径：打通可独立构建和验证的纵向闭环，feature flag 默认关。
3. 中点：安装内部 APK，验证数据不丢和错误恢复；通过后才补完整 UI。
4. 结束前：服务端 additive 部署、移动端开 flag、真机任务录像。
5. 结束：归档验证资料、记录未决项和实际耗时；不得把临时脚本/大截图留在轻量主树。

## 16. 验证、指标与阶段门槛

### 16.1 不恢复历史门禁的验证方式

每阶段至少执行：

- `npx tsc --noEmit` 或当时仓库等价 TypeScript 编译检查。
- Android `assemblePreview`/用户指定 release 构建；不得依赖本机绝对路径。
- 对本阶段纯函数和迁移写窄范围 executable contract checks；不恢复 archive 中整套 tests/gates。
- 对 SQLite migration 做一份脱敏 synthetic fixture 和一份用户授权设备备份的计数/hash 对账，不读取私人正文到日志。
- 真机安装覆盖升级，不只全新安装。
- 按 `feishu-ui-style` 用截图验证静态几何、视频验证首帧/切页/长按/拖动/状态变化。

### 16.2 P0 任务矩阵

| 任务 | 必须验证的故障注入 |
|---|---|
| occurrence 创建/继续/查看 | 双击、重复通知、系列修改、日程删除、两设备 409 |
| 我的笔记 | 写入中强杀、磁盘写失败、账号切换、同步冲突、Summary 重生成 |
| 录音结束 | 断网、WS stop timeout、App background、上传 401/500、文件仍可播放 |
| Transcript | partial/final 竞争、final 变短、搜索 1000+、无音频 seek、后台播放返回 |
| Summary | schema 无效、引用 ID 幻觉、job 超时、旧版本有编辑、input 变 stale |
| Action | 重生成、完成后再生成、提醒权限拒绝、后续日程重复点击、来源 revision 归档 |
| 迁移 | malformed JSON、孤立 WAV、缺 meeting、guest event ID 改变、单音频失败 |

### 16.3 性能预算

- 录音采集线程：不得因 DB/API/UI 任务产生等待；现有 audio read loop 不引入业务锁。
- manual note 本地保存：正常设备 p95 小于 100 ms；UI debounce 400 ms。
- 会议列表首屏本地查询：p95 小于 150 ms（1000 场 synthetic meetings）。
- 单场搜索：2 小时/10000 段 p95 小于 100 ms 首次结果，小于 16 ms 切上一/下一匹配。
- 播放高亮：位置回调不超过 4 Hz，active row 切换不全量刷新。
- SQLite migration：每 500 行分批，但一个逻辑 meeting 的导入保持事务；显示真实进度，不阻塞录音服务恢复。
- Snapshot：只传当前页面需要的数据；超长 Transcript 后续分页/窗口化，不一次通过 bridge 复制无限历史。

### 16.4 功能有效性指标

只记录计数和状态，不记录正文：

| 功能 | 核心指标 | 首轮门槛 |
|---|---|---:|
| occurrence 绑定 | 从日程开始后能回到同一记录的成功率 | ≥ 99% 测试任务；真实使用观察 |
| 我的笔记 | 已确认落盘内容在异常恢复后保留率 | 100% 故障注入 |
| 处理恢复 | retry 后只重跑失败阶段的比例 | 100% 契约；成功恢复率 ≥ 95% 测试环境 |
| Transcript seek | 点击后落入目标段时间窗 | ≥ 98% 有效时间戳样本 |
| 引用 | citation 指向存在段且点击可定位 | ≥ 99%；无效引用不得展示 |
| 行动项 | 编辑/完成状态跨重生成保留 | 100% 契约 |
| 导入 | 已摄取文件在分享 URI 失效后仍可恢复 | 100% 故障注入 |
| 分层分享 | 默认导出不含 Transcript/音频/我的笔记 | 100% |
| 说话人 | 人工修正后未来中文样本准确率变化 | 先建立基线；未显著改善不自动扩量 |

真实留存、完成率和主观价值没有足够数据时，不得用竞品数量替代结果。P2 开启前至少收集 P0/P1 的真实任务数据和用户主观反馈。

### 16.5 可观测性

建议事件：

```text
meeting_note_create_requested/completed/conflicted
occurrence_meeting_opened
manual_note_save_completed/failed/conflicted
recording_reconciled
processing_stage_transition/retry
transcript_search_used/seek_completed
summary_version_requested/ready/activated
summary_citation_opened
action_item_created/edited/completed/reminder_created
media_ingest_started/completed/failed
marker_created/opened
share_manifest_created
speaker_correction_submitted
```

payload 只含随机 meeting hash、origin、stage、duration bucket、count、error code、app version；禁止正文、文件名、地点、人名、token 和绝对 URI。

## 17. 回滚和发布规则

### 17.1 Feature flag 粒度

至少分：

- `local_meeting_db_v1`
- `local_meeting_db_canonical_read_v1`
- `local_meeting_db_canonical_write_v1`
- `local_meeting_db_account_root_write_v1`
- `local_meeting_db_account_upload_write_v1`
- `occurrence_meeting_link`
- `manual_notes`
- `transcript_audio_link`
- `structured_summary_v2`
- `action_items_v1`
- `media_import`
- `markers`
- `layered_share`
- `series_memory`
- `speaker_feedback_v2`

`local_meeting_db_v1` 只控制 Release A 的 schema/shadow/reconciliation；`local_meeting_db_canonical_read_v1` 必须显式 opt-in，默认关闭，且基础 DB flag 关闭时强制关闭。`local_meeting_db_canonical_write_v1` 还必须依赖 canonical read，默认关闭；只有 scope 完成 preflight 且所有活动 mutation 表面都支持 ownership revision 和 legacy mirror 恢复后才可在普通构建开启，不能只为单个按钮翻转写入顺序。`local_meeting_db_account_root_write_v1` 与 `local_meeting_db_account_upload_write_v1` 分别再依赖上述三项，只用于账号根 outbox、远端合并与上传状态纵切的可恢复工程验证；两者不得因为 broad write flag 开启而自动开启。根消费者还必须确认当前 scope 已是 canonical owner，不能用后台启动抢占未完成 preflight 的 legacy scope。账号 Store、云刷新和 local/remote ID 边界虽已接管，但部署 API、真实上传、离线恢复、跨设备合并与冲突处理没有闭环证据，因此两项仍不得进入普通包。可恢复模拟器上的单纵切工程验证是唯一例外，验证后必须恢复原数据并重新生成默认关闭的交付包。数据 schema 不随 UI flag 回滚；关闭 canonical read 或其自动 preflight 失败时立即保留旧 Store 读取，关闭其他 flag 只隐藏/停止对应新写入路径，已有数据仍可导出和恢复。

### 17.2 自动停线条件

出现以下任一项，停止扩量并回到上一可安装版本/关闭 flag：

- 录音文件丢失或 journal 恢复率下降。
- migration 实体计数/hash 减少。
- 登录/登出导致作用域串数据。
- occurrence 重复创建率非零且无法合并。
- Summary 重生成覆盖人工笔记、用户编辑或已完成 action。
- 默认分享包含未勾选内容。
- UI 状态把上传/转写错误错误表达成麦克风或录音失败。

### 17.3 服务端发布顺序

1. additive schema。
2. v2 write endpoint 和 idempotency。
3. v2 read endpoint，从旧表投影兼容。
4. shadow write/compare。
5. 移动端 capability 开启。
6. 稳定两个移动版本后才考虑移除旧字段；实际没有旧客户端淘汰证据时不删除。

## 18. 明确不做与延后边界

当前路线明确不实现：

- Zoom/Meet/Teams 自动参会机器人。
- Phone/Dialer 平台或后台捕获其他 App 通话。
- Google/iCloud/Outlook 完整多账号日历聚合。
- Scheduling Links、会议室、企业 OOO 和跨日历阻塞。
- Channel、Workspace 角色树、复杂自动分享和用户组。
- 销售情绪、教练、独白等团队分析。
- AI Skills 市场、Playlist 和完整音视频编辑器。
- 在单场引用/恢复没有达标时建设跨全库 Agent。

P2 的标签、检索、轻协作和片段也不得反向污染 P0 领域模型：它们通过关联表/派生资产扩展，不给 `meeting_notes` 增加几十个可空业务字段。

## 19. 开发执行检查单

### 开始一个优化项前

- [ ] 找到登记表 ID、依赖和阶段。
- [ ] 阅读当前实现，不按本文件中的旧行号盲改。
- [ ] 检查线上 capability/OpenAPI 与本机副本是否一致。
- [ ] 涉及 UI 时读取 `feishu-ui-style` 及对应 references，建立 evidence note。
- [ ] 确认不会恢复历史 gates/tests 或向轻量工作树写大证据文件。
- [ ] 定义失败状态、重试范围、幂等键、作用域和回滚 flag。

### 提交实现前

- [ ] 数据修改处于 repository transaction；组件没有新增散落 AsyncStorage map。
- [ ] 原生录音 journal 和 WorkManager 的已有合同未被削弱。
- [ ] TS/Kotlin snapshot schema 同步升级，旧/缺失字段有安全默认。
- [ ] 用户可见字符串全中文且无其他产品专有术语。
- [ ] 人工内容、用户编辑、完成状态、引用 revision 在重生成后仍存在。
- [ ] 登录切换、guest migration、删除和通知 deep link 已覆盖。
- [ ] Linux/Windows 构建脚本无个人绝对路径；Python 命令统一使用 `python3`。

### 交付前

- [ ] 构建并覆盖安装到真机。
- [ ] 验证正常路径和本阶段故障注入。
- [ ] 截图只验静态，视频验动画/手势/首帧。
- [ ] 检查默认分享 manifest 和临时文件清理。
- [ ] 检查日志没有正文、凭据、路径或身份信息。
- [ ] 记录 source-matched、device-confirmed 和 intentional inference。
- [ ] 更新本文件的实际完成状态、schema/API 版本和偏差原因。

## 20. 完成定义

整个路线的完成不是“所有页面都有按钮”，而是以下真实闭环稳定成立：

```text
具体 occurrence 或临时入口
  -> 唯一 MeetingNote
  -> 本机可靠录音 + 可恢复人工笔记
  -> 独立上传/转写/整理阶段
  -> 可搜索、可按文字回听的 Transcript
  -> 有证据且不覆盖人工修改的整理版本
  -> 可编辑、可提醒、可回到来源的行动项
  -> 默认最小披露的分享
  -> 下一次同系列会议可找回上次决定与未完成事项
```

任何阶段只要无法说明“事实源在哪里、失败后保留什么、重试只重跑什么、用户修改如何不被覆盖”，就不满足本文件的工程完成定义。

## 21. 作为目标模式附件时的执行协议

1. 目标必须指向本文件的整体完成定义，不得把“完成当前 Phase”或“产出一个 APK”误当整体目标完成。
2. 用户最新明确指令高于本文件；已验证的源码、线上契约和真机事实高于文档推断。产生偏差时必须记录原因并更新相应契约，不得为了贴合旧文字而忽略新证据。
3. 每次续做先读取 Git 状态、最近提交、文档顶部实施状态和当期契约证据；从最后一个已验证检查点继续，不重做已完成工作。
4. 每个可恢复纵向切片单独提交；涉及产品行为的阶段必须有可安装包和对应真机任务证据。代码写完不等于通过退出条件。
5. 外部服务或设备一时不可用时，关闭对应写能力并记录未验证项；只要仍有不依赖该外部条件的有意义工作，就继续推进，不把局部阻塞误报为整体目标阻塞。
6. 稳定版验证用 `git rev-parse stable-before-meeting-memory-roadmap^{}`，应返回 `cde96f9d5266961e380957893ecba39855aea39b`。需要回溯时使用 `git worktree add --detach <target-directory> stable-before-meeting-memory-roadmap`，不得通过重置当前开发工作树来验证稳定版。
