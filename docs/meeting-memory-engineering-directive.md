# 老记日历原生会议记忆：工程实施指示

> 文档性质：内部工程规范与实施路线，不是面向用户的产品说明。
>
> 移动端基线：`752fa8a388e6f1e533267118b2c79dfdd8654a61`
> 稳定回溯标签：`stable-before-meeting-memory-roadmap`（标签包含本文件，业务代码与上述移动端基线一致。）
> 稳定标签是不可移动的回溯点；后续实施只新增提交，不重打或强制更新该标签。
> v19 基线：`600c274`（稳定回溯点后的第 37 个实现/证据提交）；其上由本轮独立切片完成游客普通包 canonical cutover。
> 规划估算：核心 P0/P1 框架约完成 100%，完整优化登记表（含线上闭环和 P2）约完成 99.5%。这是功能工作量估算，不是发布通过率；自动 ASR、物理双机与候选版集中验收仍单独计算。

## 0. 执行总览（先看这里）

### 0.1 阅读顺序与完成口径

后续开发先读本节，再按优化 ID 查详细合同。旧文档把“代码是否完成”和“所有线上/真机退出条件是否完成”混成一个 Phase 状态，造成已经落地的功能仍长期显示“未完成”。从本次修订起分成两条独立轴：

- **实现状态**：`已锁定`、`本机闭环`、`框架完成`、`进行中`、`未开始`。它回答功能和架构是否已经写完，已锁定部分默认不重做。
- **证据状态**：`源码/编译`、`模拟器`、`线上账号`、`双设备`、`USB 真机`、`候选版`。它回答结论能证明到哪一层，不反向抹掉已经完成的实现。
- “服务端源码已同步”不等于运行服务已启用；“模拟器闭环”不等于真机或跨设备验收；“缺少高成本矩阵”也不再自动把整个功能降为未实现。
- 当前百分比按优化项剩余工作量和依赖权重估算，不按代码行数、测试数量或 Phase 退出条件机械平均。

### 0.2 当前完成面

| 能力面 | 实现判断 | 当前证据边界 | 后续只做什么 |
|---|---|---|---|
| 本机数据平面、作用域、迁移、独立处理阶段 | 本机闭环；游客、账号根、RecordingAsset 上传、逐资产转写及独立 Summary 均已形成普通包/运行纵切 | 源码、TypeScript/Kotlin、v26 迁移窄合同、保留数据模拟器、线上账号根/action pull、真实 upload/transcript/Summary job；fresh 账号又完成显式游客迁移和唯一 WorkManager 上传；当前 occurrence 样本补齐同一远端 Transcript revision 的 provenance 幂等落库 | 批次 B 只续物理设备候选复核；不重建第二套数据库、迁移 uploader 或状态机 |
| 日程 occurrence、人工笔记、游客迁移 | 本机闭环；冲突录音恢复、多录音选择/分享及账号同步框架已接通；迁移录音统一交给正常上传队列 | 运行目标服务上两个独立账号会话已完成 occurrence/note/root delete/restore 与双 RecordingAsset 往返；另有旧迁移冲突安全认领和全新账号单资产上传，游客源会议/录音/笔记保留 | 只补恢复 secondary 的特定 App 运行样本和物理设备抽查；不再复制迁移专用上传器 |
| 录音结束、Transcript 搜索回听、后台播放 | 本机主链、RecordingAsset v2 上传/下载、逐录音 provenance/回听、每资产 job、独立 Summary 恢复和 reprocessed Transcript 生产入口已形成纵切 | 既有双资产 GPU 转写与 Summary 运行证据；当前 occurrence 账号模拟器又完成 04:09 录音、上传恢复、远端 final Transcript、播放器和整理结果，旧 NVML 事故不再是已确认当前阻塞 | 补真人录音质量、reprocessed 新鲜完整任务和一次物理设备候选抽查；不再重复模拟器短录音主链 |
| 结构化整理、版本、引用、行动项 | 本机/线上闭环；服务端独立 Summary task、四模板与 additive 同步框架运行 | `general@1` 完成非平凡 durable/引用/移动端跳转；四模板完成真实任务；历史授权完成利用、未选隔离、引用隔离、幂等与 durable 闭环；双 Android 实例完成提醒与非协作 action 冲突收敛 | 只续线上版本列表、更广真人样本、附件授权质量和物理设备抽查；候选包自动 ASR 主链另案收口 |
| 文件导入、Marker、片段、分层分享、删除/回收站 | 音视频导入、已有会议多资产加入、Marker 本机事务与账号 create/delete outbox/pull/tombstone、附件分享、可撤销文字链接、本机 WAV 与非 WAV 异步片段、软删除/恢复及双端到期物理清理纵切完成 | 视频/双录音模拟器、真实 MP4 上传/抽取/逐资产转写、v29/v30/v34 保留数据模拟器、18020 共享/清理/片段/Marker 合同；两个独立模拟器完成 Marker 新增、精确跳转和墓碑收敛 | Marker 只续物理双机/USB 与长离线抽查；导入续格式矩阵；片段、分享、删除续跨设备与真机抽查 |
| 通知、Widget、Tile、模板、系列记忆 | 本机纵切完成；四模板与历史授权运行闭环 | 模拟器、运行模板服务、四模板真实结果、决定/行动历史利用与隔离；通知显式动作与 Widget `action=meeting` 已复用同一 occurrence MeetingNote，`action=open` 只进日程；当前候选包又完成 Tile active/重复点击幂等及 Tile 的 App Lock pending 正反分支；双 Android 实例 action 往返、提醒和非协作冲突已收敛 | 不重做页面；只补通知/Widget 的 App Lock、物理设备与发现的缺陷 |
| 讲话人 | segment/cluster/future profile 修正、显式资料同意/撤销、账号离线识别和旧会议重匹配纵切完成 | 运行 correction 201/重放/412/overlay；模拟器资料详情与 reprocess；无真实人声改善证据 | 只补真实多人录音质量、第二设备与 USB；不重做 profile/correction/job 框架 |
| QA、跨会议组织、轻协作、媒体片段、时间点附件 | QA-01、COLLAB-01、ORG-01、CLIP-01 与 ATT-01 均已形成功能/线上纵切 | QA 真实模型/账号持久化与混合检索，v35 保留升级及第二设备本机 ID 问答已运行；COLLAB 模拟器所有者 + 匿名第二客户端；ORG v20/v28 + 18020 标签目录；ATT v21/v32 + 18020 真实账号登记/上传/鉴权下载/墓碑，并完成两个独立模拟器的文字附件新增/pull/墓碑；CLIP v23/v30 + 18020 M4A/MP4 任务 | QA 只续真实长会议开放世界观察和 USB；ATT 只续真实视觉模型、跨设备图片与物理设备；其余按各项补候选抽查 |

### 0.3 已完成并锁定的基础

以下是从稳定标签后已经形成的设计资产；除非出现可复现缺陷，不再重开架构讨论或重复验证：

1. SQLite MeetingNote 聚合、repository/facade、scope ownership/revision、legacy mirror CAS、迁移 runner 与独立 outbox 基础。
2. capture/upload/transcript/summary/speaker 五阶段状态、录音本机提交边界、停止与笔记/网络解耦、账号 Transcript 补全恢复和持久队列唤醒。
3. occurrence 唯一绑定、计划快照、日程开始/继续/查看、orphan 恢复、409/412 冲突保留、detached history，以及冲突录音的 journal 恢复复制与多录音详情。
4. “我的笔记”本机自动保存、版本冲突选择、游客迁移 journal v2 与日程 ID 映射。
5. Transcript revision、截断 final 保护、逐录音 asset/job provenance、本机 Unicode 搜索、循环导航、按来源回听、段落高亮、选择复制/分享和后台播放器生命周期。
6. schema v2 整理结果、不可变版本、citation、行动项编辑/完成/忽略/提醒/后续日程、action 上下行与冲突选择框架。
7. 音频文件/系统分享导入、Marker、内容级文件分享、可撤销文字链接、安全默认、私人笔记二次确认和本机回收站界面。
8. 日程通知动作、语义链接、Widget、Quick Settings Tile、四种内置模板与重复会议系列记忆。
9. 会议根 versioned push/pull、cursor、tombstone/restore、根冲突选择，以及本场讲话人 segment/cluster 修正。
10. 飞书风格的 Calendar/Minutes 原生容器、中文用户文案和已建立的 source/inference 边界。

“锁定”只表示这些基础不应被重写；普通构建开关、线上运行和候选版证据仍按下文剩余主线完成。

### 0.4 剩余主线与压缩后的依赖顺序

剩余工作按四个批次推进，而不是重新从 Phase 0 逐阶段验收：

| 批次 | 目标产物 | 纳入内容 | 不纳入内容 |
|---|---|---|---|
| A：关闭本机架构尾项（已完成） | 普通 Preview 对游客 scope 稳定使用 canonical 主路径 | v19 冲突录音恢复、多录音选择与分享；活动写入口审计；默认包 cutover、覆盖升级、首次 mutation、镜像与冷启动恢复 | 不做全格式、长录音、全故障矩阵 |
| B：启用账号线上闭环（功能纵切完成，证据收口中） | 真实测试账号可完成根、occurrence、笔记、行动项、录音资产和讲话人 correction 往返 | 18020/18035、账号根、实体双会话、action 协作、RecordingAsset、per-asset provenance/job、独立 Summary 与 speaker correction 已完成；当前 occurrence 录音又补齐上传→final Transcript→Summary 及远端 revision 幂等；续真人质量和实体跨物理设备抽查 | 不重复已经通过的本机 UI 冒烟 |
| C：补齐尚缺功能量（已完成） | P0/P1 尾项和五个 P2 纵切均有真实入口、持久化与失败状态 | 视频导入/已有会议加入、附件分层分享、可撤销分享链接、QA/轻协作/账号标签目录、账号附件与 Marker 对象同步、非 WAV 异步片段、整理主题聚合与 reprocessed Transcript 移动端/持久 overlay 纵切均已完成 | 不先建设复杂 Agent、团队权限树或完整编辑器；后续证据尾项进入批次 D，不新造同步系统 |
| D：一次候选版收口 | 一个默认能力配置的可安装候选包 | 数据升级、录制→保存→播放、日程绑定、账号同步、默认隐私和核心恢复任务 | 不把穷举 ROM/格式/时长组合当作目标完成前置条件 |

批次 B 的服务端工作与批次 C 中不依赖线上服务的移动端/领域工作可以并行；只有 schema、API envelope 和 snapshot 需要先冻结。P2 的真实使用指标只决定是否默认开放，不再阻止代码实现，因此不损失升级量，也避免为了收集尚不存在的使用数据而空等。

### 0.5 压缩工期但不缩功能的规则

1. 复用既有 SQLite、outbox、snapshot、sheet、播放器、媒体摄取和通知基础；禁止为新功能再造平行 Store、任务系统或 UI 套件。
2. 同一数据模型的一组 additive migration、capability 和 server endpoint 成批实现/部署；不为每个小字段单独走一次完整发布循环。
3. 每个纵切仍单独提交，但默认只做与改动语言/模块对应的编译和一个最短成功路径；APK 构建、安装、日志扫描按批次合并。
4. 不变页面、旧迁移、已锁定 Feishu 映射和已通过的 Windows 配置不重复验；只有相关代码再次变动时才回归。
5. 严格故障注入只保留在会丢录音、丢人工内容、串账号、错误删除或越权分享的路径；其余矩阵移到候选版后或真实缺陷触发时执行。
6. 外部服务或 USB 暂不可用时，继续完成不依赖它的功能；将线上/真机任务合并到一次可用窗口，不用等待替代开发。

### 0.6 当前完成审计

| 完成条件 | 当前证据 | 判断 |
|---|---|---|
| 第 4 节无 `进行中/部分完成/未开始` | MRK-01 已补齐 18020 schema/capability/API 与移动端 v34/outbox/pull，并完成双独立模拟器新增、跳转和墓碑收敛 | **满足完整功能量口径**；剩余是真实模型、物理设备和候选版证据，不再是缺失功能框架 |
| 普通包 canonical 为主事实源且 capability fail closed | 默认配置中 canonical read/write、账号根/上传及各 P2 flag 均为 true；运行时仍逐项要求 fresh capability，附件和 reprocess 能力缺失时不发送 | **满足源码与候选配置要求** |
| 目标进程、migration、测试账号和多 RecordingAsset 已运行 | 前次 18020 健康快照报告 `qwen3-asr` / `models_ready=true`；root/action/note/occurrence/RecordingAsset/QA/协作/分享/片段/讲话人/附件 capability 已有线上证据。两个全新同账号模拟器已完成 canonical 接管、录音上传、会议/附件 pull、墓碑、根冲突选择和回收站收敛；v35 候选又完成跨设备本机 ID 问答，当前 occurrence 样本完成上传后的远端 final Transcript 与 Summary | **满足对象合同与双模拟器纵切口径**；仍不等于真人 ASR 质量或第二台物理手机，且本轮未重新确认共享服务 PID/cwd |
| V3 七条关键任务 | 第 1 条已有稳定包游客日程/会议/录音/笔记到 v34 的保留升级，当前 Preview 又在保留数据 `emulator-5556` 完成 v34→v35：3 条账号会议、整理结果、19 个待办和播放器状态均保留；第 2 条既有开始、暂停/继续、结束、本机提交和 02:02 回放，当前包又从日程 occurrence 完成开始、离开后继续、结束和 04:09 详情；第 5 条既有导入 Transcript 搜索/回听、非平凡 `general@1`、9 个引用和 7 个行动项，当前包又取得 occurrence 录音的 5 段远端 final Transcript、短整理及冷启动保留，但仍不是可归因于真人语音质量的样本；第 7 条的第二实例 pull、Marker 收敛与真实 409/412 选择已有分轮证据。账号墓碑、第 3–4/6 条尚未在当前包集中重跑，当前 hash 未装 USB | **未满足一次性候选版全量重跑口径**；已有分轮证据不反向抹掉功能完成，也不得把模拟器录音或双模拟器改写成真人 ASR/物理双机证据 |
| 默认候选 APK、回溯提交与稳定标签 | Preview `8756696f…e74d33b5`（91,071,052 bytes，v104，构建于 `2026-07-28 23:29:28 +0800`）对应业务提交 `7b4766b`，已保留数据覆盖安装到仅供老记候选验证的 `emulator-5556`，设备内 `base.apk` 哈希完全一致；冷启动 canonical account projection 为 4 条会议且无 SQLite/React Native/native fatal，04:09 录音、5 段文字和整理结果保留，canonical revision 稳定在 86。`stable-before-meeting-memory-roadmap` 仍为 `cde96f9d5266961e380957893ecba39855aea39b` | **满足当前可回溯候选包与保留数据模拟器口径**；USB 已断开，当前 hash 的真机安装、物理双机与稳定包覆盖升级重跑仍待 |

源码审计还确认：冲突恢复产生的 RecordingAsset 固定为 `secondary + recovered`，Store 扫描全部本机就绪且无远端身份的资产，WorkManager 与同步 API 都保留 role/origin 和具体 asset ID。因此“恢复 secondary 尚缺 App 往返”是特定运行样本缺失，不是需要再建上传实现；后续不得为此复制第二套调度器。

### 0.7 旧增量状态记录

下面的长记录保留用于查找已经作出的事务和协议决策，但不再作为进度入口；与本节或第 4 节状态表冲突时，以较新的对账结论为准。

<details>
<summary>展开历史增量状态</summary>

> 实施状态：Phase 0 线上契约仍待验证；Phase 1 离线数据平面进行中。默认关闭的 SQLite canonical read 已完成 Store 接线和模拟器 fail-closed 验证；canonical mutation 原语、scope ownership/revision 和 legacy mirror CAS 已由媒体导入、游客会议创建、游客会议标题/详情、游客软删除、游客录音 capture/asset、游客 Transcript 内容/revision 及游客 Summary version/section/action 七个受控 canonical-first 纵切接入 Store，并完成游客模拟器 clean mirror、写入期稳定投影、删除后 occurrence 动作恢复、录音启动失败的可恢复资产保留与冷启动 owner 恢复。游客 Transcript 纵切已把 draft 原位替换、immutable final/reprocessed、stable final 防迟到 draft 降级、较短 final 保留、Summary stale、Marker 对账和 canonical revision 收入同一事务语义。游客 Summary 纵切复用 schema v2 归一化与 immutable version 管线，保护用户编辑/已处理 action，拒绝 realtime draft、主键错配和显式 Transcript revision 错配；事务内发现输入 revision 已过期时只保存历史候选，不替换当前版本或阶段 fingerprint。账号录音上传保留 AsyncStorage registry/WorkManager 的唯一调度权，SQLite 只记录 RecordingAsset、upload phase、attempt、operation ID 和 credential generation；同 operation 的 uploaded 不被迟到失败或延迟远端列表降级。账号 MeetingNote 根 outbox 已补齐逐会议真实插入顺序、陈旧 claim 回收、complete/retry/blocked/permanent/conflict 终态和旧 API 消费器；同 scope drain 进程内串行，本机主键保持不变，远端 UUID 只写 `remote_id`，create 复用稳定 `client_request_id`，PATCH 只发送设值字段，DELETE 404 视为幂等完成。独立账号根写开关下，普通 Store 创建/编辑/删除、录音根状态、Transcript/Summary、远端刷新合并和 ASR/上传/读取/播放/分享的 local/remote ID 边界均已接入 canonical 路径；远端 merge 保护未完成 mutation、墓碑和本机内容，列表缺项不解释为删除。目标部署源码与实际 SQLite 已确认空标题、`client_request_id/location/recorded_at`、用户内幂等和 PATCH 显式清空合同并完成源码同步，但配置中的 18020/18035 服务仍未运行，账号鉴权读写、真实 WorkManager、跨设备恢复和冲突闭环尚未验证，因此普通构建的 canonical write、账号根写和账号上传写开关继续关闭。Phase 2 已形成 occurrence 与“我的笔记”的本机纵向闭环、游客迁移 journal v2、账号日程 ID 映射及账号作用域 sidecar 迁移；人工笔记和 occurrence 的服务端窄 v2 源码合同也已同步，occurrence 现有独立 outbox、按 occurrence 回查、安全附着、冲突保留和 orphan 状态，冲突录音恢复也已完成合成数据模拟器闭环。但目标服务未启动，真实账号迁移、鉴权运行、双设备收敛、服务端多录音资产和真机验证仍未完成，因此 Phase 2 尚未满足退出条件。按“先框架和功能、后严格门禁”的目标执行顺序，Phase 3 已完成第二个本机纵向切片：单场 Unicode 搜索、循环匹配导航、范围/播放段落高亮、无音频 seek 保护、选择复制/分享、snapshot v3，以及 Draft/Final 完整性判定、inactive final 持久化和条件式 active revision 切换已实现；详情暂态不再清除后台 MediaSession、相同 source 命令幂等、同录音 URL 更新保位及 stale callback 防护也已落地。服务端明确 completeness 字段、60 分钟真机精度与带有效录音的后台返回录像仍待完成。
> MeetingNote v2 根增量状态：目标部署源码已以既有 `Meeting` 为唯一主对象，实现 root metadata/operation、单调 revision、幂等 create/patch/delete/restore、tombstone 和会议级 cursor；旧 App API 同步维护同一根元数据。移动端严格 v2 上行和根专用下行 cursor 仅由本次 fresh capability 开启；上行 ACK 持久化远端 root revision，并在日程创建时原子收敛 occurrence outbox；下行按页合并 revision、tombstone/restore 和 occurrence 后才 CAS 推进独立 cursor，保护未完成本机根 mutation，已建立 v2 下行状态后 capability 降级或探测失败不再回退旧列表。`client_note_id` 与旧 `client_request_id` 保持独立语义，不用来源设备 ID 覆盖本机请求身份。目标源码的内存 SQLite 窄合同已通过且文件哈希一致；移动端 v17 schema/绑定参数/cursor CAS、TypeScript 与 Android bundle 已做轻量验证。但运行数据库、鉴权 endpoint、双设备 cursor、APK/模拟器/USB 真机均未验证，18020/18035 仍未启动，全局 `sync_cursor` 与普通构建账号根写开关继续关闭。
> MeetingNote v2 根冲突闭环状态：移动端已严格解析 409/412 包装中的完整 `current`，只有远端 ID/`client_note_id`、revision、origin、entry point 和 calendar occurrence 身份均可证明兼容时才允许选择版本。选择云端只替换根元数据；选择本机会作废旧根 outbox，并按远端/本机删除状态生成 update、delete 或 `restore -> update` 新幂等操作，录音、文字记录、整理结果、人工笔记和待办均不随根版本替换。删除态冲突仍保留在会议列表，Minutes snapshot v11 以独立“会议同步冲突 / 处理”固定状态入口打开老记自有版本选择 sheet，不复用 processing retry stage。当前只有 TypeScript、Debug/Kotlin 构建、1878 modules Android bundle 和内存 SQLite 回滚/排序/可见性窄合同；18020/18035、真实 409/412、鉴权、跨设备和 USB 真机仍未验证，普通构建开关继续关闭。
> Phase 4 已形成连续纵向闭环：schema v2 sections/citations、immutable version、受保护版本不自动覆盖、本机候选/历史版本选择、snapshot、可定位引用、行动项创建/编辑/完成/忽略恢复/来源/提醒/后续日程，以及 action outbox/pull/冲突选择均已接通。SUM-02 的 segment-ID prompt、compact/Map-Reduce 来源保留、canonical 时间/quote 校验、唯一 quote 回填、漂移哈希与来源感知 action identity 已在目标 18020 运行。两个账号会话已覆盖 action ACK/pull、真实 409/412 与显式版本选择；两个隔离 Android App 实例又完成提醒收敛，以及非协作 action 的断网分歧、明确选版和原端回拉。保留本机版本会以严格晚于云端候选的客户端时钟生成新 operation，避免 `action_clock_regression` 二次冲突。四模板均已有真实模型成功结果，定向访谈又生成全部四类 section 与 5 个 canonical 引用。该样本不是自动 ASR，也不替代物理双机；全账号 change feed、全局 `sync_cursor`、batch、action tombstone 和线上版本列表仍未完成。验证继续遵循“轻测试、轻校验”，严格样本与归档门禁后置。
> Phase 5 已完成五个本机纵向切片，并把 IMP-01 延伸为移动端/线上纵切。Marker 已接通录音中/暂停态固定入口、canonical SQLite 事务、active Transcript 覆盖段对账、详情定位/删除、显式转待办和最小披露文字分享。文件选择与 Android 系统分享已接通持久 Intent inbox、原生流式摄取、可恢复 journal、`MeetingNote + RecordingAsset(imported)`、统一详情/播放器和 snapshot v8；专用确认页已接通标题、录制时间、可选 occurrence、作用域持久 draft、视频图标和已有会议显式“保存到/加入”。选择已有会议后在一个 canonical transaction 内加入 imported RecordingAsset；已有 primary 时新增为 secondary，同时推进阶段、使旧整理结果 stale、更新 MeetingNote revision 和 legacy mirror。旧正文、Transcript、人工笔记、Action 和既有 RecordingAsset 均不得移动、覆盖或推测归属。视频入口只由 fresh remote capability 开放，目标 18020 已完成 MP4/WebM/MOV/MKV 音轨抽取；模拟器覆盖 MP4 新建、WAV 追加、双录音播放，真实中文 MP4 又完成流式上传、下载对账和逐资产转写。分层分享已接通内容级勾选、安全默认、私人笔记二次确认、附件默认关闭、文档/音频/图片 ZIP 产物和最小审计。`PRIV-01` 已把本机/未同步会议的永久删除与已同步会议的可恢复删除拆开：移动端 migration v18 保存删除前 lifecycle，账号根 outbox 支持 delete/restore 顺序重放，Android 原生会议页具备 capability 门控的 30 天回收站、恢复确认、长按动作和物理返回。后续批次已启用普通包 canonical/account 写入，目标 18020/18035 已运行并验证真实 tombstone/restore；migration v27 与服务端后台任务又补齐到期 DB/文件物理清理。CLIP-01 随后以 v30、18020 异步任务和 Android 原生下载校验补齐非 WAV 派生片段。Phase 5 的本机功能量已收口；导入只剩格式矩阵、第二设备和 USB，片段/分享/删除只剩跨设备与真机抽查。Marker 账号同步不在当时本机收口证据内，后续已按第 12.7 节完成 v34/18020/双独立模拟器纵切。证据见 [`implementation/contracts/phase-5-marker-evidence.md`](implementation/contracts/phase-5-marker-evidence.md)、[`implementation/contracts/phase-5-media-import-evidence.md`](implementation/contracts/phase-5-media-import-evidence.md)、[`implementation/contracts/phase-5-layered-share-evidence.md`](implementation/contracts/phase-5-layered-share-evidence.md)、[`implementation/contracts/phase-5-deletion-semantics-evidence.md`](implementation/contracts/phase-5-deletion-semantics-evidence.md)、[`implementation/contracts/phase-5-retention-cleanup-evidence.md`](implementation/contracts/phase-5-retention-cleanup-evidence.md) 与 [`implementation/contracts/phase-8-media-clips-evidence.md`](implementation/contracts/phase-8-media-clips-evidence.md)。
> Phase 5 后续增量：Marker 已作为独立、默认关闭的内容 scope 纳入分层分享，只导出时间点和用户标签，不隐式附带 Transcript。可撤销文字链接也已形成 Android、v29 本机状态、18020 内容 scope、默认冻结、可选最新整理、系统发送、应用深链、管理与撤销纵切；录音继续走文件分享。非 WAV 异步片段也已形成 M4A/MP4 运行合同、v30 中断恢复和模拟器原生校验纵切；当前只保留跨设备片段目录、第二设备与 USB 证据尾项。证据见 [`implementation/contracts/phase-5-layered-share-evidence.md`](implementation/contracts/phase-5-layered-share-evidence.md) 与 [`implementation/contracts/phase-8-media-clips-evidence.md`](implementation/contracts/phase-8-media-clips-evidence.md)。
> Phase 6 已完成 ENTRY-01、ENTRY-02、TPL-01 与 SERIES-01 的本机/线上纵切。通知、语义链接、Widget/Tile、四模板、规范系列身份、最近 ended 会议、决定/action 投影、来源跳转、人工笔记导入和独立 Summary 历史授权均已接通。授权 request ID、项目 identity、模板和 Transcript 进入同一 fingerprint/pending 链；纯文字历史现进入受限 4B 上下文路径，选中项确定性进入带来源的讨论 section，未确认历史 outcome 与伪引用落库前移除，附件仍走完整管线。目标 18020 已完成四模板、定向访谈和真实账号决定/行动历史的利用、未选隔离、引用隔离、幂等与 durable 任务；两个隔离 Android App 实例又完成同一 action 的创建、第二端完成和原端 revision 回拉。剩余是 App Lock/真机、Tile active、过期投影跨时钟、物理双机与远端 series identity 抽查。证据见 [`implementation/contracts/phase-6-entry-evidence.md`](implementation/contracts/phase-6-entry-evidence.md)、[`implementation/contracts/phase-6-template-evidence.md`](implementation/contracts/phase-6-template-evidence.md) 与 [`implementation/contracts/phase-6-series-memory-evidence.md`](implementation/contracts/phase-6-series-memory-evidence.md)。
> Phase 7 的 SPK-01 功能纵切现已补全。除原有 migration v11/v12、本场 segment/cluster 修正与 capability-gated outbox 外，目标 18020 已运行账号隔离的 correction v2、逐会议 assignment revision、幂等重放、409/412 冲突、future profile 样本状态和旧会议 reprocess job；账号 profile 持久化 revision/consent/model version，撤销会移除未来识别向量但保留历史显示快照。移动端修改讲话人 sheet 可显式选择既有资料并再次勾选“用于以后会议识别”，资料详情可启动/恢复旧会议重匹配；reprocess 跳过 `user_locked=1` 人工 assignment。离线转写也已从错误的全局原型声纹切换为当前账号资料，并修复空资料库崩溃。运行证据覆盖 correction 201、同请求 200、陈旧 revision 412、Transcript overlay、合成 profile 的零片段 reprocess durable completion 和模拟器页面；真实多人录音准确率、有效片段样本更新、跨设备与 USB 仍是证据尾项。详见 [`implementation/contracts/phase-7-speaker-profile-evidence.md`](implementation/contracts/phase-7-speaker-profile-evidence.md)。
> Phase 8 的 ORG-01 功能量已完成并锁定。前三组切片分别以 migration v20 接通作用域隔离的用户标签与本机分源索引、从 active Transcript/用户标签派生人物与主题、从 current ready/stale Summary 只读派生整理主题；整理主题始终不写入 `meeting_tags`。第四组以 migration v28 复用 durable outbox/conflict，按稳定 client tag ID 和远端 meeting ID 同步账号级标签目录；18020 的 `meeting_tags_v1` 使用持久幂等结果与 optimistic revision，陈旧写返回完整 412 候选。本机保留未知远端会议分配，根身份未就绪时先同步会议；冲突明确选择“保留本机 / 使用云端”，不做 last-write-wins。真实测试账号覆盖 create/replay/update/stale-412，普通 Preview 覆盖 App push/pull 和匿名第二写入方冲突落库；测试夹具已恢复。Folder 仍只在大量会议需求成立时添加，后续只补第二台移动设备与 USB，不重做标签/索引/聚合/冲突框架。证据见 [`implementation/contracts/phase-8-organization-search-evidence.md`](implementation/contracts/phase-8-organization-search-evidence.md)。
> Phase 8 已完成 ATT-01 的本机与线上对象纵切：migration v21 提供绑定 Marker/时间点的短文字和相册照片、应用私有文件、附件总览、删除、默认关闭的分层分享及逐次授权整理；migration v32 再增加附件 SHA-256、remote identity/revision、create/delete outbox、失败重试和旧照片校验值补算。账号同步只在 fresh `meeting_attachments_v1` capability 下运行，完成 register→鉴权图片上传→ACK、远端列表/tombstone 拉取、鉴权下载校验以及删除 ACK 后清本机文件；创建尚未上传时删除仍保留文件直至云端收敛。照片整理仅允许登录账号选择已同步且 revision/checksum 当前的照片，每次默认零选择，最多 4 张、合计 40 MB；服务端再次核对 owner/meeting/revision/checksum 并复制请求独占的不可变快照，Ollama 与 OpenAI-compatible 末次模型调用分别传真实 `images` 与 `image_url`，Map 阶段不读图片。目标 18020 已部署附件 schema 并广告 `meeting_attachments_v1=true`；真实测试账号已通过文字登记/幂等重放、图片登记/上传/鉴权下载、未鉴权拒绝、陈旧 revision 拒绝、墓碑删除与清理，两个全新同账号模拟器又完成文字附件新增/pull/墓碑收敛。因没有已确认的视觉模型，`summary_attachments_image=false` 仍硬性 fail closed；跨设备图片、第二台物理手机与 USB 真机仍属证据边界。ATT 轮次中 A 端 Marker 未出现在 B 端，证明附件同步不能替代 Marker；后续 MRK-01 已另行完成真实 Marker 同步纵切。证据见 [`implementation/contracts/phase-8-timepoint-attachments-evidence.md`](implementation/contracts/phase-8-timepoint-attachments-evidence.md)、[`implementation/contracts/phase-8-summary-attachments-evidence.md`](implementation/contracts/phase-8-summary-attachments-evidence.md) 与 [`implementation/contracts/phase-5-marker-evidence.md`](implementation/contracts/phase-5-marker-evidence.md)。

> NOTE-01 / CAL-01 增量状态：人工笔记已具备账号级窄云同步闭环；occurrence 已具备用户内唯一服务端合同、会议级 GET/PUT、按 occurrence 查询、不可变计划快照、独立客户端 outbox、跨设备安全附着、冲突保留及 active/orphaned 生命周期。真正双会议冲突已有 detached history 和“本机独立保留、日程使用云端关联”的原子恢复路径；v19 进一步把可读取的来源录音安全复制为目标 RecordingAsset，并支持 journal 恢复、多录音播放和当前录音分享。文字记录、整理结果、我的笔记和行动项仍不跨会议自动合并，服务端多资产也未实现。目标 18020/18035 服务仍未启动，新表和鉴权路由没有运行证据，因此不能把源码合同或恢复路径写成线上、跨设备或真机已验收。
> 账号同步调度增量状态：MeetingNote 根、occurrence、人工笔记、行动项和讲话人 correction 五类 outbox 均从 SQLite 的绝对 `next_attempt_at_ms` 与 `in_flight.updated_at_ms + stale interval` 恢复 provider 定时；App 进程重启不再依赖上一次内存中的 `setTimeout`。各队列仍保持原有分组、顺序、远端身份和 blocked/permanent/conflict 门禁，持久唤醒只决定何时再次进入 claim，不绕过是否允许发送。当前仅有 TypeScript、纯时间合并合同和查询/claim 同域源码审计，尚未做真实进程强杀、系统时钟跳变、账号切换或远端恢复验证。
</details>

> 适用范围：老记 Android、React Native 领域层、本机持久化、会议服务、日程服务对接。
> 规范词：`必须`、`不得`、`应`、`可以`分别对应 MUST、MUST NOT、SHOULD、MAY。

## 1. 目标、边界与不可伪造的保证

老记的目标定位固定为：

> **日历原生、现场优先、人工可控的中文个人会议记忆工具。**

本文件覆盖当前证据能够支持的目标架构、数据迁移、接口契约、交互状态、失败恢复、实施依赖和阶段验收。它不能保证未来需求、第三方服务和真实用户行为永远不变，因此采用以下工程保证替代“把未来一次性写死”：

1. 每个功能必须有稳定领域对象、状态机、数据所有权和失败语义。
2. 每个竞品结论必须区分安装包源码事实、真机事实、产品决策和老记推断。
3. 每个未知项必须有验证门槛；未验证的推断不得直接升级成源码事实。
4. 每个实现切片必须能独立提交、回滚或继续恢复；构建和安装按批次合并，禁止跨数周的大爆炸分支。
5. 用户原文、已确认的人工修改、录音和已完成行动项不得因 AI 重生成、登录切换、日程修改或同步冲突而静默丢失。

本计划不会恢复 `archive/workspace-lightening-20260718` 中已经归档的历史门禁和测试体系。每个切片只做与改动直接相关的轻量检查；构建、安装、线上往返和真机任务按批次集中执行，验证资料完成后归档，不重新膨胀主工作区。

## 2. 证据基线

### 2.1 证据标签

- `[PRODUCT]`：用户已经确定的老记产品合同。
- `[SOURCE]`：当前版本 APK、反编译资源、Hermes、老记或服务端源码直接确认。
- `[DEVICE]`：对应版本在用户手机或指定模拟器上的真实运行分支。
- `[INFERENCE]`：为老记独有能力设计的桥接方案，必须在实施阶段验证。

UI 变更还必须遵守 `/home/yydd/.codex/skills/feishu-ui-style/SKILL.md`，尤其是中文术语、组件状态、固定槽位和首帧稳定；静态映射随改动审查，运动/手势视频按第 16 节在批次或候选版集中完成。

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

### 3.1 对账事实源

- 稳定回溯点为 `stable-before-meeting-memory-roadmap`；本次只统计该标签之后的提交和当前工作树，不把标签前已有功能重复计入升级量。
- 截至 `600c274`，本路线提交从 SQLite foundation 延伸到 versioned meeting root、root conflict、capability-gated recycle bin 和 migration v19 冲突录音恢复，共 37 个实现/证据提交。
- migration v19 已完成本机纵向闭环：双会议冲突原子生成恢复任务，原生流式复制具备进程重启 journal 恢复，目标详情支持多录音选择并分享当前录音，来源会议和原文件保持。证据只到合成数据模拟器和默认 Preview；它不证明服务端多资产、真实账号、双设备或 USB 真机完成。
- v19 之后的普通 Preview 已默认开启游客 canonical read/write；后续批次已分别开启账号根写和账号上传写。账号上传仍需每个会话取得 fresh `recording_assets_v2=true`，探测失败时 fail closed。保留数据首次标题 mutation 将 owner/revision 与三份 legacy mirror 同步提交，强停冷启动从 canonical owner 恢复；预试快照随后恢复。
- `docs/implementation/contracts/` 是证据边界索引，不是待办清单。历史文档中的“Phase 未退出”通常表示缺少线上或真机证据，不等于对应代码仍未实现。

### 3.2 原“结构缺口”的处理结果

| 原缺口 | 当前判断 |
|---|---|
| AsyncStorage 整 scope JSON、宽松 Meeting/Transcript/Summary | SQLite 聚合、repository、revision、transaction 和 compatibility mirror 已建立；游客与账号根普通包 cutover、账号 RecordingAsset 上传均已完成，剩余实体按独立 capability 收敛 |
| 单一 `Meeting.status` | 五个独立 processing stage、统一投影和阶段级重试已实现 |
| 日程无会议关联 | occurrence link、计划快照、状态化动作、orphan/冲突/detached history 已实现 |
| 没有独立人工笔记 | 录音页与详情页笔记、autosave、冲突选择和账号同步框架已实现 |
| Transcript 无搜索/高亮 | Unicode 搜索、循环导航、播放段落高亮、复制/分享和 DiffUtil 局部刷新已实现 |
| Summary 无稳定结构/版本/引用 | schema v2、immutable version、citation 校验和服务端 additive 源码已实现 |
| 行动项 ID 不稳定、不可编辑 | 稳定 identity、编辑/完成/提醒/后续日程、上下行和冲突处理已实现 |
| 分享没有内容级授权 | 七类内容选择、安全默认、私人笔记二次确认和 manifest 已实现 |
| 游客迁移丢失日程身份 | event ID 映射、逐阶段 journal v2 和 occurrence 重建已实现 |
| Android 缺少导入/Widget/Tile | 三类入口及统一语义导航已实现 |
| 构建含个人绝对路径 | 配置插件已改为项目相对路径，Linux 与 Windows 配置/TypeScript 基线已检查 |

### 3.3 仍然真实存在的结构缺口

1. 普通交付包已为游客、账号根和账号 RecordingAsset 上传开启 canonical 路径。账号根冷启动已完成 compatibility 投影导入、canonical owner 接管和真实 action pull；上传只有在本次 fresh capability 明确开启时发送，旧镜像只承担旧包回滚，不再是账号根主事实源。
2. 配置对应的 18020/18035 已由目标工作区专用脚本启动，既有 additive 表、RecordingAsset 三表及 speaker correction/profile/reprocess 表已在运行数据库实例化；同账号独立会话已覆盖 root、occurrence、manual note、delete/restore、action、双 RecordingAsset 与 correction 合同。跨物理设备仍不能由双会话证据代替。
3. 服务端和移动端已经接通同一 MeetingNote 的多 RecordingAsset 登记、内容上传、认证下载列表、具体 asset 转写 job、v26 自动调度/恢复、Transcript provenance，以及独立 Summary task/结构化 durable result；旧单主录音 API 仅保留兼容投影。真实结构缺口已收敛为共享 GPU 恢复，以及 secondary 的 App/第二设备恢复尚未验证。
4. 讲话人 profile 同意/撤销、future correction、账号离线识别、旧会议重匹配和跨 revision 人工锁定已实现；真实结构缺口只剩带有效人声/录音资产的改善质量、跨设备收敛和物理设备证据。
5. video ingest、远端视频音轨处理、已有会议显式加入、附件分层分享、可撤销文字链接、CLIP-01 非 WAV 异步片段和 ORG-01 账号标签目录/整理主题已经完成移动端/18020 纵切。reprocessed Transcript 已完成移动端生产入口、v31 恢复任务、不可变版本与持久服务端 overlay，只剩线上真实 job 证据。账号附件与 Marker 均已完成移动端、18020、真实测试账号合同和双独立模拟器收敛；照片多模态仍缺真实视觉模型，Marker 仍缺物理双机/USB 与长离线证据。
6. `MeetingLiveScreen.android.tsx` 和 `TranscriptionScreen.android.tsx` 已抽出关键用例但仍是较重 controller；只在继续增加功能会产生重复事务时再拆，不为纯洁架构单独延长路线。
7. USB 真机、真实模型、长录音和双设备证据尚未集中取得；它们归入候选版收口，不再分散阻塞每个切片。

## 4. 完整优化登记表与实现状态

状态解释：`已锁定`表示功能合同和主实现已完成；`本机闭环`表示用户路径在本机完成但线上/候选证据可后补；`框架完成`表示基础设施已完成但仍有 cutover 或关键纵切；`部分完成`和`进行中`仍包含实际功能工作；`未开始`不是删除项。

| ID | 优化项 | 当前实现状态 | 剩余功能闭环 |
|---|---|---|---|
| ARC-01 | 事务型本地会议数据层与可恢复迁移 | 本机/账号根/录音资产线上闭环 | 账号离线长期重试与第二设备；保留兼容镜像用于旧包回滚 |
| SRC-01 | 日程、临时录音、文件导入统一为 `MeetingNote` | 本机与账号音视频、多录音、per-asset Transcript、账号附件线上对象同步、非 WAV 派生片段纵切闭环 | 第二设备抽查 |
| PROC-01 | 五类处理独立状态与独立重试 | 本机闭环；RecordingAsset transcript 与独立 Summary 均有运行/恢复纵切 | 自动任务候选复核和账号长期重试收敛 |
| CAL-01 | occurrence 绑定、状态化动作、计划快照 | 本机/线上账号双会话闭环；多录音运行合同与 `secondary + recovered` 通用上传源码已接通 | 恢复 secondary 的特定 App 运行样本；第二台移动设备抽查 |
| NOTE-01 | 永不被 AI 覆盖的“我的笔记” | 本机/线上闭环；双 Android 实例断网冲突、选版与回拉收敛完成 | 物理双机、USB 与长离线抽查 |
| TRN-01 | 搜索、跳转、按录音来源回听、高亮、复制/分享、重新生成 | 本机闭环；per-asset provenance 已运行；reprocessed 移动端/v31/overlay 纵切完成 | 运行服务的真实 reprocess job；候选版长录音抽查 |
| ACT-01 | 行动项编辑、完成、提醒/日程、来源 | 本机/线上闭环；运行 action pull、协作者 revision、双 Android 实例提醒重建/取消及非协作 action 断网冲突选版收敛完成 | 物理双机抽查；全账号 change feed、batch 和 tombstone 不作为本项框架重做理由 |
| SUM-01 | 有序结构化整理结果 | 本机/线上纵切闭环；四模板结构、durable 恢复、历史授权和幂等当前版本已运行 | 更多真人样本、附件授权质量和线上版本列表 |
| SUM-02 | 结论/行动项引用 Transcript | 本机/线上纵切闭环；9 个 canonical 引用及移动端跳转已运行 | 自动 ASR 直连样本和更多真人会议质量抽查 |
| SUM-03 | 结果版本与用户修改保护 | 已锁定 | 只随真实模型/冲突路径做候选抽查 |
| IMP-01 | 文件选择与系统分享导入音视频 | 本机/线上纵切闭环；视频、远端多资产处理和已有会议显式加入已完成 | 格式兼容矩阵、第二台移动设备与 USB 真机 |
| MRK-01 | Marker、会后跳转、转行动项/分享 | 功能/线上纵切完成；本机能力、v34 create/delete outbox、revision/tombstone/pull、18020 owner API 和双独立模拟器新增/跳转/删除收敛已闭环 | 物理双机、USB 真机和长离线/弱网抽查；不重建第二套同步系统 |
| ENTRY-01 | 会前通知开始/继续/查看 | 本机闭环；当前候选包补 ended 记录通知直达 | notification 的 App Lock、首次成功录音/active 继续和物理设备抽查 |
| ENTRY-02 | Widget 与 Quick Settings Tile | 本机闭环；当前候选包补 Tile active、重复点击同一录音与 App Lock pending 正反分支 | Widget/通知 App Lock、Tile paused 状态和真机 Launcher/Tile 抽查 |
| TPL-01 | 四个内置模板 | 本机/线上纵切闭环；四模板真实输出、定向访谈与历史授权已运行 | 快速连续切换、跨设备与 USB 抽查 |
| SERIES-01 | 重复会议系列记忆 | 本机/线上闭环；真实账号历史利用/隔离/durable 与双 Android 实例 action 往返收敛已运行 | 物理双机、并发冲突和远端 series identity 抽查 |
| SHARE-01 | 内容级分层分享 | 功能/线上纵切完成；Marker/附件默认关闭，可撤销文字链接默认冻结且可选跟随最新整理 | 第二台移动设备、USB 真机；录音仍走文件分享 |
| REC-01 | 日程结束只提醒、不自动停止 | 已锁定 | 候选版确认通知和录音状态不互相改写 |
| SPK-01 | 本场修正→资料反馈→未来改善→旧会重匹配 | 框架/线上纵切闭环 | 真实多人录音改善质量、跨设备和 USB；人工锁定与撤销合同不再重做 |
| PRIV-01 | 默认私有、永久删除与回收站 | 软删除/恢复与双端到期物理清理纵切闭环 | 真实到期记录、多录音/WorkManager 组合和 USB 抽查 |
| QA-01 | 单场有来源问答 | 本机/服务端线上闭环；真实模型、引用、拒答、幂等与账号持久化完成 | 用真实 final Transcript 走完整移动端页面；USB 真机 |
| ORG-01 | 标签/Folder、多场检索与聚合 | 功能纵切完成；标签目录线上同步、分源搜索、人物、用户标签主题与当前整理主题闭环 | 第二台移动设备与 USB；Folder 仅在需求成立时添加 |
| COLLAB-01 | 共享行动项与轻协作 | 本机/线上闭环；App 所有者、viewer/editor、revision、撤销及匿名第二客户端完成 | 第二台移动设备往返与 USB 真机；不扩建团队权限树 |
| CLIP-01 | Marker/Transcript 媒体片段 | 功能纵切完成；本机 WAV 与非 WAV 服务端异步导出（实测 M4A/MP4）、持久化、恢复、分享、定位与删除闭环 | 跨设备片段目录、第二台移动设备与 USB 真机；另一设备现可从同步源录音重新生成 |
| ATT-01 | 时间点照片/人工附件 | 功能/线上纵切完成；本机附件、显式分享、混合附件逐次授权整理、账号登记/上传/下载/墓碑、父会议清理及双模拟器文字附件收敛已运行 | 真实视觉模型、跨设备图片文件、第二台物理手机与 USB 真机；未确认模型前 `summary_attachments_image=false` |
| ANDR-01 | Android 创建、录制、恢复、核对、执行闭环 | 核心主链本机闭环 | 合并剩余功能、线上能力与一次候选版收口 |

上述登记表仍是完整范围。P2 改为“先实现、后由真实指标决定默认开放”，不再因缺少尚未产生的使用数据而延迟开发；明确不进入本路线的项目见第 18 节。

第 9–13 节保留的“验收/验证”文字是风险与预期行为目录，不代表每个切片都要立即执行。实际调度统一服从第 16 节：安全例外随切片检查，其余合并到批次或候选版。

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
- Linux 构建与 Windows 配置解析/TypeScript 基线已经完成并锁定；只有构建插件、路径处理或维护脚本再次变化时才重跑对应 Windows 检查。

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
- `meeting_tags`、`meeting_tag_links`、可选单层 `folders`。
- `share_manifests`、`share_grants`。
- `qa_threads`、`qa_messages`、`qa_citations`。
- `series_rollups` 仅作为可重建缓存，不作为事实源。

### 6.4 单场和多场搜索

单场 Transcript 搜索第一阶段在 Kotlin 页面内对当前 snapshot 做 Unicode 归一化后的 substring 搜索，原因是中文短词、段落规模和即时高亮不需要依赖设备 FTS tokenizer。

Android 多场搜索使用应用随包携带的 Expo SQLite，而不是 ROM 的系统 SQLite。当前固定依赖 Expo SQLite 16.0.10 / SQLite 3.50.3，并在构建中显式启用 FTS5：

1. 三个及以上 Unicode codepoint 的 term 使用 FTS5 trigram，对标题或正文中间子串也能命中。
2. 一到两个 codepoint 的中文短词使用转义后的逐来源 `LIKE`；SQL 只返回有界 snippet，不能把整段 Transcript 复制过 bridge。
3. 搜索始终限定当前 scope、未删除会议、active Transcript 和 current Summary；标题展示列不得参与其他来源的 MATCH。
4. 未来若替换 Expo SQLite 或增加非 Android repository adapter，必须先证明 FTS5/trigram 能力；不支持时由该 adapter 实现普通索引/受限 LIKE，不能让数据库初始化失败，也不能静默变成前缀搜索。

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

1. `capture=preparing/recording/paused`：正在准备录音/正在录音/录音已暂停。
2. `capture=finalizing`：正在安全保存录音。
3. `capture=failed_recoverable/failed_terminal`：录音中断/录音失败；只有 recoverable 返回 capture 重试目标。
4. 本地文件存在且 `upload=queued/uploading`：录音已保存在本机，等待上传/正在上传。
5. `upload=failed_retryable/blocked`：上传失败，可重试/上传受阻；播放器仍可使用本地文件。
6. `transcript=finalizing/realtime_draft`：正在生成文字记录/文字记录仍在补全。
7. `transcript=failed_retryable`：文字处理失败，可单独重试；音频状态不得变成失败。
8. `summary=queued/generating`：正在整理会议记录。
9. `summary=failed_retryable`：整理失败，可单独重试；Transcript 和音频保持可用。
10. `speaker=processing/failed_retryable`：正在同步讲话人修改/讲话人修改同步失败，可单独重试；本机名称和其他四阶段资产保持可用。
11. 输入变化时显示“整理结果可更新”；`speaker=partial` 且没有更高优先级状态时显示“讲话人修改已保存在本机”；五阶段均为初始空状态时显示“未开始”；其余主要资产就绪时显示“已完成”。

列表、日程详情和会议详情必须调用同一个 `deriveMeetingPresentationState()`，不得各写一套条件。

当前三层纵切已补全严格的五阶段聚合与统一 label/tone/retryStage，并接入 canonical list projection、occurrence 日程动作、详情页和旧 `Meeting` DTO 兼容投影；旧 DTO 只根据粗粒度 status、显式上传/内容字段作保守重建，canonical 阶段可读时优先。已提交的 Minutes snapshot v12 保留详情头部紧凑状态槽，Transcript/Summary 分页的 loading/error 与同一 stage snapshot 对齐；页面和状态槽的重试统一分派到录音恢复、现有上传 registry、Transcript 重新同步、Summary pending-task 恢复或单会议 speaker correction drain，不复制后台任务实现。讲话人阶段从不可变 correction 与 outbox 行聚合：新 correction 在同一事务投影状态，claim 才增加 attempt，成功、可重试失败、永久阻断/冲突分别收敛为 `ready`、`failed_retryable`、`partial`；fresh capability 明确关闭时只把展示降为 `partial`，不删除未来可用的 outbox，不把本机改名伪装成失败。能力探测传输失败会把具备完整远端身份的队列持久化为 retry，进程重启后从 outbox 的下次时间或 stale claim 时间恢复调度；手动重试只把当前会议的 retry 行重新置为 pending。当前已有 TypeScript 与纯状态窄检查，仍没有真实远端成功/失败、进程重启计时、多个阶段同时失败、账号切换和真机状态槽证据，因此 PROC-01 仍不能表述为完整验收。

Summary 生命周期纵切已把页面内 loading 提升为 canonical 阶段状态：准备提交写 `queued`；得到稳定 task ID 后写 `job_id/input_fingerprint`，且同一 task 恢复或重复轮询不增加 attempt；服务端 `PENDING/STARTED` 分别投影为 `queued/generating`。当前 API 不提供可信百分比，因此 `progress` 保持 `null`，禁止从耗时推算虚假进度。页面关闭或请求 generation 变化只停止可见 UI 更新，已提交任务的 pending registry、阶段状态和最终结果保存继续按捕获时的 meeting/scope 执行；已知后台 task 的 Abort 保持运行态，只有没有 task 身份的提交中断、明确 worker/传输失败、恢复 registry 不可读或 pending 被明确丢弃时才进入可重试失败或 `stale`。阶段写入按 meeting 串行且只记诊断，SQLite 失败不得反向伪装为服务端提交失败。`saveCachedSummary()` 仍是 `ready` 和 Summary version 落盘的唯一完成路径。候选 v104 先证明了长任务恢复与真实失败分流，随后又以 `general@1` 任务补齐成功路径：约 92.3 秒生成 3 条决定、7 条待办和 9 个有效引用，页面关闭/覆盖安装后的 durable 读取可恢复，冷启动重复响应为 `unchanged`，不覆盖用户当前版本、不重写处理阶段，也不增加 canonical revision。前一任务的 120/600 秒超时只保留为旧部署失败样本，不再代表当前 Summary 阻塞。

Transcript 远端完成状态纵切将 `incomplete`、远端处理失败、同步失败和本机持久化失败映射为独立路径：明确 `incomplete` 时只写可替换 draft/finalizing，并按 1/2/4 秒有限重取，随后降为 15 秒检查；服务端虽然明确 `complete`、但候选覆盖范围明显短于当前可读 draft 时，同样保留 draft/finalizing 并沿该节奏复查，直到取得不退化的 final 或页面失效。已有稳定 final 时不因更短 complete 候选进入无意义轮询；旧服务的 `unknown` 兼容读取和明确 `failed` 也仍只走原有终止路径。页面失效或 Abort 静默退出，不写失败。每次候选保存后必须重读 canonical active revision 作为下一轮 baseline；远端失败或传输失败进入 `failed_retryable`，但已有稳定 final 时保留 `ready`。状态百分比继续为 `null`，不得把轮询次数伪装成进度。当前详情重试可重新发起 Transcript 同步；目标 18020 又补齐“有正文、无活动任务时暴露稳定 final”的运行合同，使最新重试失败不再隐藏可用 Transcript。录制中或 queued/running 仍是 incomplete，空正文失败仍是 failed；当时的 NVML/VibeVoice 事故已恢复，当前候选包的新鲜真实录音收敛仍是独立边界。

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
- 两个设备同时创建时由服务端唯一约束裁决；收到 409 时拉取已存在对象并保留本机临时 MeetingNote。若本机记录已有音频，不得直接丢弃：为每段可恢复录音写持久任务，再把独立副本加入日程当前关联；来源记录和原文件继续保留。

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

#### 双会议冲突录音恢复（migration v19）

当 occurrence 冲突已经严格证明“本机临时会议”和“日程当前关联的云端会议”是两条不同 MeetingNote 时，处理事务必须同时完成以下工作：

1. 在 `meeting_occurrence_detached_history` 保存本机旧 link、计划快照和选择结果；本机 MeetingNote 不删除、不改成目标 MeetingNote。
2. 读取本机会议当时全部具有 `local_uri` 或仍处于 `capturing/ingesting` 的 RecordingAsset；集合若在事务内变化则整次冲突处理回滚。
3. 为每段录音写 `meeting_recording_merge_tasks`，持久化 source/target asset identity、来源快照、attempt、error、retryable 和完成时间。任务 ID 与目标 asset ID 一旦写入就不能在重试时更换。
4. 完成旧 occurrence outbox、解除本机 link、把严格匹配的远端 link 附着到目标会议并解决 conflict；上述变更与恢复任务位于同一 SQLite transaction。

任务执行复用 MediaIngest 原生流式复制，不通过 JS 读取整段音频：

```text
source RecordingAsset.local_uri
  -> .media-ingest-v1.json: copying
  -> fsync temporary copy
  -> prepared
  -> atomic rename + directory fsync
  -> ready
  -> SQLite verifies source scope/state/checksum/size
  -> insert target RecordingAsset + complete task
  -> acknowledge journal
```

- 目标已有主录音或远端根时，恢复副本必须是 `secondary`；只有没有主录音且没有远端根的目标才可把首段恢复副本设为 `primary`。
- 复制结果必须是目标会议目录中的独立 URI。不得把来源 URI 直接挂到两个 MeetingNote，也不得在成功后删除来源 RecordingAsset、来源文件或来源上传任务。
- 进程在 prepared、rename、SQLite commit 或 acknowledge 前退出时，启动恢复读取同一 journal 和目标 asset ID；校验失败进入可重试任务，不能降低 checksum/size 约束来“修好”测试。
- 来源仍在录制时先显示等待；录音结束后由详情明确“加入”。永久不可读只阻止该任务，不回滚已经完成的 occurrence 选择，也不把目标会议的文字/整理状态改成失败。
- 目标详情只在存在两段及以上可播放录音时显示固定 44 dp 选择槽；36 dp 可见 chip 使用 regular 字重、6 dp 半径和 normal/pressed 状态。当前选择是播放器和显式音频分享的唯一来源；未上传副本标记“仅本机”。
- 永久删除目标会议时删除其 MediaIngest 目录；来源会议的 recorder 文件不在该清理范围。普通软删除/回收站不提前物理删除录音。

v19 的本机证据仍是合成双会议模拟器：覆盖 stale checksum 拒绝、重装后 journal 恢复、目标 primary+secondary、来源保留、两段播放、当前第二段分享、Preview 冷启动持久化和测试前快照恢复。后续批次 B 已补齐运行服务的双 RecordingAsset 登记/上传/下载/独立转写合同、per-asset Transcript provenance 和 v26 移动端 job 调度/恢复，并用 v104 模拟器完成一段账号录音的 WorkManager 真实上传与真实 job create/retry；但 occurrence 恢复出的 secondary 尚未在 App 走完整往返，双设备和 USB 仍未完成。证据见 [`implementation/contracts/batch-b-recording-assets-v2-evidence.md`](implementation/contracts/batch-b-recording-assets-v2-evidence.md)。

#### 游客资料显式合并（journal v2 运行收口）

`[PRODUCT]` 游客资料迁移是复制，不是切换所有权：只有用户明确点击“立即合并”才把日程、MeetingNote、我的笔记、Transcript、Summary version、行动项、Marker 和录音逐阶段复制到当前账号；游客源对象和文件继续保留，声纹资料不得迁移。登录流程固定经过 `guest -> signed_out -> authenticated`，因此 provider 不得依赖相邻 mode transition；每个新认证 user ID 只检查一次 pending journal，`pendingCount=0` 时不打扰用户。

journal v2 继续按 `userId + guest source ID` 保存每阶段完成位和错误；失败只重开该阶段，不回滚已完成实体，也不改变 source。录音阶段的 `audioUploaded` 从 handoff v1 起表示“账号 canonical RecordingAsset 已与云端对账，或已持久交给正常账号上传队列”，不表示迁移函数另开一条上传链。具体约束如下：

1. `ensureAccountCanonicalMeeting()` 先生成账号 scope RecordingAsset；迁移必须复用该资产的稳定 UUID、role、origin 和 source URI。
2. 新迁移只写既有 `pendingMeetingAudioUploads:v3:<scope>`，由唯一 WorkManager/JS reconciler 注册和上传；刷新 Store 只触发这条既有队列。
3. 旧 build 可能已经以 `guest-migration:<sourceMeetingId>:primary` 注册云端资产。升级后只允许按这个精确 client ID、当前 meeting owner 和 role 找到旧资产，再把其 immutable remote ID 认领到账号 canonical RecordingAsset；不得再注册第二个资产。
4. 若账号会议已有不同主录音，迁移进入可重试错误并要求人工处理，不覆盖、不删除，也不猜测哪个音频相同。
5. 播放器同时用 canonical client ID 与已确认 remote ID 做同一性匹配；历史 server client ID 可以保留，但不得显示成第二段“仅本机”录音。

候选 v104 已覆盖两种运行路径：旧直接上传夹具被安全认领且只显示一段录音；fresh `user:85` 从显式提示开始，只产生一个 UUID client asset、一个成功 WorkManager 和一个 uploaded 云端主录音，pending 注册表随后清空。退出账号回到 guest 后源会议/录音/`V3KEEP` 仍在，重新登录原账号后账号副本也在；临时账号已通过正式删除合同清理。该证据是模拟器和真实 18020 账号往返，不等于 USB 真机或真人录音。详见 [`implementation/contracts/candidate-v3-evidence.md`](implementation/contracts/candidate-v3-evidence.md)。

#### 文件改动入口

- `src/screens/EventDetailScreen.android.tsx`
- `src/native/nativeCalendarPages.ts`
- `modules/laoji-native-platform/src/calendarPages.ts`
- `CalendarPageContracts.kt`、`CalendarDetailPageView.kt`
- `src/services/guestDataMigration.ts` v2
- 会议服务 occurrence 字段/唯一约束

#### 候选版风险任务

以下任务由 V2/V3 组合执行，不在每次 CAL-01 改动后全量重跑：

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

v104 已用两个隔离 Android App 实例完成真实冲突纵切：共同云端基线为 revision 14；B 端只阻断目标服务地址后编辑到本机 revision 20，保留 `base_remote_revision=14`、dirty 笔记和 6 个 pending outbox，A 端在线把不同内容提交为云端 revision 15。B 恢复网络并冷启动后，旧操作全部 blocked、pull 进入同一 unresolved conflict，页面仍保留本机内容；版本 sheet 同时展示本机/云端候选，选择本机后旧操作被 supersede，新 operation 把服务端推进为 revision 16 / `client_note_revision=21`。A 冷启动再从本机 revision 15 拉到 21。该证据关闭“双 Android 实例 App 冲突选择”功能项，但不冒充物理双机、USB 或长离线验收。

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

#### 中断安全边界

修改笔记持久化、录音停止顺序或 migration 时，V0 至少注入一个最接近改动的中断点；候选版再覆盖“刚停止输入 / 写入中 / 暂停录音 / 停止录音中”四类代表状态。已确认落盘字符必须完整，内存 draft 不能被错误清成空白。

### 9.4 TRN-01：Transcript 与音频联动

#### Draft 与 Final

- 实时 ASR 只写当前 `realtime_draft` revision；partial 行可以更新，final 行一旦落盘只允许服务端最终修订产生新 revision。
- 会后精加工完成后创建 `final` revision 并切为 active；保留 draft 直到 final 完整性验证成功。
- 完整性验证比较最晚时间、总字数、非空段数和服务端声明；final 明显短于 draft 时不自动替换，显示“文字记录仍在补全”。
- 说话人更名是 assignment/override，不重写原始 ASR 文本。

当前移动端实现将“明显短于”收敛为可复用纯函数，而不是页面内按行数猜测：NFKC 后非空 Unicode code point、非空段数、最大 `start/end` 时间共同参与；分段数单独减少永不构成拒绝，因为 final 可能合并 draft 段。`[INFERENCE]` 第一版要求至少两项显著回退，或时间/文字出现极端回退才保留 active draft。阈值集中在 `transcriptCompleteness.ts`，后续真实 10/30/60 分钟样本只调整这一处。服务端明确 `incomplete/processing/finalizing` 时，候选只能更新 `realtime_draft` 并保持补全状态；明确 complete 也不能绕过本机截断检测；无声明时按本机指标 fail-safe。

final 候选与当前 active revision 的读取、候选 revision 保存、active 切换和 processing stage 更新必须位于同一 SQLite transaction。被拒绝的 immutable final 仍以 inactive revision 保存，不能写入旧缓存覆盖当前可读 draft；相同内容后续仅声明从 incomplete 变 complete 时，不得通过修改 immutable revision 元数据伪造新版本。当前兼容层把 incomplete 内容写入可替换的 `legacy-live` draft，只有得到 final 候选且完整性通过时才创建并激活 immutable final。

客户端只把服务端明确 `complete` 的 `transcript_revision_id` 交给 final revision；`incomplete`、空正文 `failed` 或互相矛盾的声明一律 fail closed，丢弃该远端 revision ID。无新增字段的旧服务继续按 `unknown` 兼容路径读取一次，不启动轮询。相关 `transcript_status`、nullable `is_complete`、稳定 combined revision 与 RecordingAsset 处理源码已保留在持久 deployment overlay `server-work/summary`；目标 18020 已加载修复后的状态合同，并以“有正文、无活动任务”的稳定 final 支撑一次成功 Summary。旧 NVML/VibeVoice 阻塞已恢复，但仍需当前候选包的新鲜自动 ASR 证据，不能由该下游成功代替。

#### 重新生成文字记录

- 只有登录账号、已同步 MeetingNote/RecordingAsset、active final/reprocessed 文字和本次 fresh `transcript_reprocess_v1=true` 同时满足时，会议更多动作才显示“重新生成文字记录”。
- migration v31 保留每段 RecordingAsset 的 generation/batch/source revision。新批次先归档当前任务，再用新 request/idempotency identity 原子重置为 pending；不建立第二套 worker 或轮询器。
- 多录音必须同批全部 completed 后才读 combined Transcript。新结果以 immutable `reprocessed` revision 保存，远端 revision ID 参与本机身份，因此正文相同的两次生产也不冲突。
- 完整性门禁继续与当前 active revision 比较；更差或截断的结果不激活，旧文字与旧 Summary 引用不会被覆盖。有效新版激活后只将当前 Summary 标为 stale。
- 当前证据是 v30→v31 保留数据模拟器升级、Preview 冷启动与持久服务端 overlay。线上单/多资产 job、截断结果、重启恢复和同请求重放仍待服务恢复后一次收口。详见 [`implementation/contracts/phase-3-transcript-reprocess-evidence.md`](implementation/contracts/phase-3-transcript-reprocess-evidence.md)。

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

#### 逐录音来源与 fail-closed 回听

- 每个 segment 持久保存 nullable 本机 RecordingAsset ID、远端 RecordingAsset ID 和 transcription job ID；任一已知身份都属于 immutable provenance，final revision 只允许从未知补全，不允许改成另一段资产或 job。
- 服务端同一资产成功重转写只替换该资产的旧文字；空结果或失败保留此前稳定文字。App transcript 路由返回 asset/job identity，combined revision 纳入各资产 result revision。
- 本机可由远端 ID 唯一解析 RecordingAsset 时补全 local ID；会议恰好一段资产时可安全回填旧文字。多资产且来源未知时不得按 primary、列表顺序或当前播放器猜测。
- 文字、Summary/Action 引用、Marker 和外部 focus 在 seek 前先切换到 segment 对应 player source；来源未知且有多段可播放录音时保持当前来源和位置。片段生成同样只使用目标资产及其重叠文字。

当前 v25 provenance、v26 每资产任务账本、双录音模拟器定位和目标 18020 的 14 项真实 HTTP provenance 断言已完成；保留数据模拟器又实际创建并恢复了账号 transcription job。当时共享 GPU 驱动/NVML 失配使该 job 保持 `failed_retryable`；目标服务当前已恢复健康，但候选包的新鲜 combined Transcript、第二移动设备和 USB 真机仍后置。证据见 [`implementation/contracts/batch-b-recording-assets-v2-evidence.md`](implementation/contracts/batch-b-recording-assets-v2-evidence.md)。

#### 长按与选择

- 正文 TextView 保持 `textIsSelectable=true`，不得让 root long-click 抢占系统选择。
- 系统 ActionMode 至少提供复制和分享选中文本；分享内容带说话人和时间，但不自动附整场 Transcript。
- 短按 seek 与长按选择的手势冲突只在相关触控代码改变或 V3 时做真机视频；超过 touch slop 或进入 selection 后仍不得触发 seek。

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

#### 候选版精度抽查

- V3 使用一份带有效时间戳的真实中文录音抽查至少 5 个分散段落；点击误差不超过 300 ms 或源时间戳误差，取较大者。
- 同一任务检查一个重复词的第二处跳转、跨段播放无整页闪烁，以及后台返回后高亮恢复。
- 10/30/60 分钟、20 段和连续 100 段的扩展矩阵移到第 16.3 节；只有抽查失败或修改搜索/播放器算法时升级执行。

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

- 用户从会议“更多 → 本场待办”手动创建；Summary 只返回 candidate。手动事项属于 meeting-global action，`source_summary_version_id` 必须为空，不得写入或伪装成整理版本内容。
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
- 第一阶段行动项统一在会议详情的“本场待办”sheet 和由提醒打开的同一列表中管理；不因 Fireflies 有 Tasks 主 Tab 就立即增加第三个底栏入口。

#### 同步冲突

- action 使用 entity revision。字段冲突时：完成状态按显式最近用户操作合并；content/due 同时变化则生成冲突副本并要求选择。
- 服务端必须返回稳定 action ID；当前 `_get_app_final_summary` 临时 UUID 逻辑必须移除。

当前 additive 纵切已在目标服务落地可靠上行 upsert：`MeetingActionItem` 保存稳定远端 ID 和单调 revision，`MeetingActionOperation` 持久保存幂等请求哈希及原成功响应；首次创建、同 key 重放、revision 更新、陈旧写拒绝均有窄合同。客户端把 409/412 的错误码与当前云端 payload 一起持久化，详情行显式标记冲突并暂停会产生新版本的完成/后续日程命令。用户选择本机版本时，旧未完成 operation 全部标记为被取代，并以云端当前 revision 创建新 operation；选择云端版本时，只覆盖当前协议能安全表达的字段，保留本机来源/创建身份，清除设备通知 ID 后对账。冲突状态、action、outbox、meeting sync state 和 canonical revision 同事务更新，CAS 或 payload 校验失败时保持 unresolved。会议级 action list/cursor/pull 已在运行实例生效：测试账号所有者创建 action，匿名 editor 将 revision 2 更新为 3，所有者 App pull 后观察到修改；viewer 越权写入被拒绝，陈旧 editor revision 返回 412。来源 segment 只在 active Transcript revision 唯一映射时保留链接。仍没有全账号 change feed、全局 sync cursor、batch、action tombstone 或第二台物理设备证据，不得据此宣称完整全账号同步。

为避免 pull 丢失用户语义，action v2 envelope 携带 `client_created_at_ms`、`user_edited_at_ms`、`completed_at_ms` 与 `generation_fingerprint`。创建时间、source kind、source Summary/segment/time 和 generation fingerprint 是 identity/provenance，首次创建或旧表一次性补全后不得被普通更新改变；content/status/assignee/due/reminder/follow-up 和相应用户时间是 revision 管理字段。completed 必须有处于 action 生命周期内的完成时间，非 pending 不保留提醒，manual/marker 不携带 generated fingerprint。字段已同步到目标运行库，账号拉取及匿名协作者 revision 回流已有运行证据。两个隔离 Android App 实例又验证：A 创建日期型提醒后，B pull 以同一 action identity 重建设备专属 09:00 通知；B 完成将同一 action 推进 revision 并清空远端提醒，A/B 各自在下一次本机对账中取消自己的闹钟。真实旧表大批量升级、非协作冲突选择和第二台物理设备仍待候选抽查。

#### 候选版关键任务

V3 在同一行动项上串联编辑内容、设截止、完成、重新生成 Summary、重启和来源跳转；用户编辑与完成状态必须保持，提醒通知必须为中文。换账号与远端冲突并入 V2，不单独重复整条 UI 流程。

### 9.7 ANDR-01：本机录音与业务数据库协调

原生 recording journal 是音频安全真相，SQLite 是业务投影。协调器 `RecordingReconciler` 在启动、回前台和录音页进入时执行：

1. 调 `recoverNativeRecordings()` 获取 finalized/recovered 文件。
2. 按 exact session ID 匹配 meeting；不允许用文件时间猜测覆盖已有录音。
3. 有 journal 无 meeting 时创建 `origin='ad_hoc'` 的恢复记录，并标明 `recovered`。
4. 有 meeting 指向不存在文件时，不删除 meeting；recording asset 标 `missing`，保留 Transcript/notes/summary。
5. WorkManager 已成功但 JS pending registry 未清时，以远端 `audio_available` 和 worker result 共同确认后清理。
6. stop 超时但 `localSaved=true` 时 capture=`local_ready`，ASR/transcript 单独进入待恢复；不得显示麦克风失败。

应用层不得把数据库写、上传、最终 Transcript 拉取和 Summary 生成串成一个必须全部成功的 `try`。每阶段完成后立即 commit，自身失败只改变自身 stage。

当前 Android 录音页已经完成第一层控制器收敛：`RecordingSessionController` 只持有 JS 侧启动 token、当前 native session handle、结束中的共享 Promise，以及多个结束请求合并后的跳转意图。重复开始会被拒绝；重复结束复用同一次 finalize；finalize 失败保留 active handle 供重试，成功后才释放。原生录音已经启动后，即使 JS 接管或计划结束提醒调度失败，也不得删除游客实时会话、把 meeting 标成 `failed`，或向用户伪报麦克风失败。

录音结束第二层纵切已拆开本机音频与最终 Transcript 的成败：只有 native stop 未得到可恢复结果，或 Transcript 写失败且同时无法确认本机音频 URI 时，整次 finalize 才失败并保留 active handle；一旦本机音频已确认，Transcript 持久化失败只返回 `transcriptSaveFailed`，继续把音频、时长、波形和会议结束状态落账，并继续独立安排上传。legacy meeting status 更新必须等待自身 stage mirror 完成，再写最终 Transcript 失败，禁止异步 mirror 把 `failed_retryable` 迟到覆盖成 `finalizing`。失败回调把 canonical Transcript 标为 `failed_retryable`，但已存在稳定 final revision 时不得被第二次兼容缓存写失败降级。Android 只显示“会议录音已保存”后的中文次级警告并正常进入详情，不能再显示整场保存失败。当前会议根状态写入仍属于把 journal asset 关联到业务 meeting 的 capture commit：在 canonical journal 尚不能反向修复关闭 read flag 时的 legacy 投影前，该写入抛错仍保留 finalize 重试，不得提前释放会话并假设后台一定修复。

录音结束第三层纵切固定执行顺序为 `native stop -> 本机 Transcript/audio/meeting 状态提交与上传登记 -> 远端 Transcript 补全`。`stopAudio` 不再包含网络读取；只有前两段成功后才运行 `completeMeetingTranscriptAfterCapture()`。后置补全统一返回 `ready/pending/failed`，明确 incomplete 只保存 draft，服务端失败、同步失败和二次缓存失败分别写入 Transcript 可重试状态；该步骤自身抛错也被提交边界外捕获，不能再让已经落账的会议被控制器视为 finalize 失败。首次本机 Transcript 写失败但后置补全成功时，以最终补全状态为准，不继续展示过期警告。legacy 列表或上传刷新不得把 `failed_retryable` 当成成功重试并覆盖为 `finalizing`；只有 active stable final 已经 ready 时才能清除此失败。游客临时 ASR 会话在本机提交及补全尝试完成后清理；本机提交失败并保留控制器重试权时不得提前删除。恢复出的本机音频同样先落账再拉取文字。

录音结束第四层纵切把剩余网络等待移出 capture finalize：账号 legacy 状态先完成本机持久化和 stage mirror，远端 PATCH 再后台执行；pending upload registry 写失败时只启动一次不受控的 best-effort 直传并立即返回“上传状态未保存”，不再等待网络结果；远端 Transcript 补全以不会向控制器抛错的 `transcriptCompletionTask` 继续运行，控制器在本机提交后即可释放 session handle。页面留在原处时订阅 task 并更新文字/中文状态，已经进入详情时由 canonical stage 与详情轮询继续呈现。迟到的状态 PATCH 合并时以当时 Store 中的音频投影为准，不能把已经上传成功的资产重新标成待上传。正常后台状态同步不弹出伪故障，失败仍保留 `statusSyncPending` 供列表刷新重试。两份临时无落盘合同分别覆盖上传 Promise 永不结束、同步抛错、补全 Promise 永不结束、本机提交失败保留控制器重试权，以及游客会话只在补全结束后清理；TypeScript 编译与 Android JS bundle 均通过。

录音结束第五层纵切为账号 Transcript 补全增加无凭据持久恢复：本机 capture commit 后、控制器释放前，按 `user:{id}` 写入只含本机会议 ID、远端会议 ID、创建/尝试/下次重试时间和结果状态的 registry；不得保存 access token、guest token、Transcript 正文或用户资料。当前账号的 `MeetingTranscriptCompletionProvider` 在启动、回前台和显式 trigger 时临时注入当前 token，单次最多处理四项；同 scope/meeting 的进程内任务合并，明确 incomplete 每 15 秒复查，失败从 30 秒指数退避到 15 分钟，23 小时后停止自动恢复并保留阶段手动重试。ready 后清 registry，账号删除会议时同步清理；账号切换或会议已删除时 `saveCachedTranscript()` 明确拒绝，不能静默成功、清掉原账号任务或生成孤儿缓存。registry 首次写失败只降低强杀恢复能力，不把已落账录音重新判为失败，当前进程仍继续补全。游客临时 ASR token 不安全落盘，因此本层明确只支持账号；游客仍依赖当前进程补全和再次打开详情，不能宣称强杀恢复。临时无落盘合同已覆盖 scope 隔离、过期清理、attempt/next retry、凭据不落盘、同任务合并、ready 清理、failed 保留，以及 registry 写完前控制器不释放；TypeScript 与 1869 模块 Android bundle 通过，尚无真实进程强杀或运行服务证据。

录音结束第六层纵切补齐 native stop 的 scope ownership 和桥接异常兜底。`RecorderSnapshot` 现在从 `RecorderStartConfig` 原样携带 `storageScope`，start/state/event/stop 都跨桥返回；Android 页面只接纳同时满足 exact session ID 与 exact current scope 的活动 snapshot、失败 stop result 和 finalized journal。`ready_to_stop_timeout` 等带 `localSaved` 的既有结果继续直接提交；若桥接或前台服务异常只抛错误而没有 result，则立即扫描 finalized journal，只在 purpose=`meeting`、mode=`realtime`、session 与 scope 全部一致且 recovery report 提供非空 URI 时合成本机 `localSaved` snapshot 并继续 capture commit；同身份有多个候选时按 PCM 字节数、时长和 URI 确定性择优，波形结果未知时不伪造。无 scope 的旧 journal、其他账号、speaker 文件或近似时间文件不得由页面直接接管，仍交给集中 reconciler 的保守策略。纯函数合同已覆盖 session/scope/purpose/mode/无 scope 拒绝、重复候选择优和恢复 snapshot；TypeScript、1870 模块 Android bundle、`:app:compilePreviewKotlin`（232 tasks，9 executed）通过。真实 stop timeout、服务销毁竞态、恢复后可播放性和 USB 真机仍未验证，因此不能把源码兜底写成运行验收。

录音结束第七层纵切移除 manual note 对 capture stop 的前置阻塞。用户确认结束后先启动当前笔记 `flush()`，但不再 `await` 它才调用 native finalize；笔记仍使用既有 SQLite 原子事务、400 ms autosave、App background/unmount flush 和中文失败状态，录音则立即进入 journal stop/local commit。这样数据库锁或异常慢写最多延后笔记落账，不能继续占用麦克风或把录音停止伪装成笔记保存操作。本层只有 TypeScript 与源码顺序证据，尚未注入真实 SQLite 长锁、强杀未落盘 draft 或真机停止并发，因此 NOTE-01 的强杀退出条件仍未满足。

这一切片不改变事实源边界：Android recorder/journal 仍唯一负责采集状态、音频字节、本机文件、停止结果和进程恢复；控制器不缓存或推断 native capture state。`FinalizeNativeMeetingRecordingUseCase` 现在拥有“本机提交、启动远端 Transcript 补全、补全后清理游客会话”的顺序，`useNativeMeetingRecordingFinalizer` 组装 Store/API/WorkManager 依赖，`MeetingLiveScreen.android.tsx` 不再直接组装这些结束依赖或实现补全算法；页面仍负责创建会议、启动原生录音、订阅状态、用户动作和可见反馈，因此尚未达到纯状态订阅者的最终形态。当前只有 TypeScript、Android JS bundle 和临时窄合同证据，没有模拟器冒烟、强杀、停止超时、长录音或 USB 真机证据，这些仍属于后续退出条件。

## 10. P1 功能详细设计

### 10.1 IMP-01：音视频文件与系统分享导入

#### Android 入口

1. UI 文件选择使用原生 `MeetingMediaPickerContract` 调用 `ACTION_OPEN_DOCUMENT`。实时 capability 未明确返回视频 MIME 时只请求 `audio/*`；只有本次 remote capability 列出对应类型后才用 `EXTRA_MIME_TYPES` 加入 MP4、WebM、MOV 和 MKV。
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
- 视频只在服务端本次 fresh capability 确认抽取音轨能力和文件上限后开放对应 MIME；UI 不因扩展名存在、旧缓存或网络失败就声称支持。当前目标 18020 已为 MP4/WebM/MOV/MKV 显式选择第一条音轨并转为 16kHz 单声道 PCM；无音轨必须失败。
- 电话录音只能作为已有文件导入，不请求通话录制或后台捕获其他 App 音频。

#### 流程

```text
选取/分享 URI
  -> ContentResolver 检查真实元数据
  -> 用户确认标题/时间/可选关联日程
  -> 持久化 scope/title/time/calendar draft
  -> 本机流式摄取
  -> 新建 MeetingNote + RecordingAsset(imported)，或显式加入已有 MeetingNote
  -> 上传
  -> 转写
  -> 整理
```

来源 `file_import/share_intent` 复用同一播放器、Transcript、Summary、Action 和分享页面。日历关联是新建会议的可选动作；若 occurrence 已有会议，明确要求选择其他日程/不关联，或通过“保存到”显式选择已有会议，不自动覆盖 occurrence。

已有会议路径使用独立 `meetingMediaImportExistingV1` flag，并要求 canonical write：目标必须存在、未删除且不处于 preparing/recording/paused/finalizing。一个 SQLite transaction 内插入 imported RecordingAsset；已有 primary 时新增为 secondary，同时推进 capture/upload、标记当前 Summary stale、更新 MeetingNote revision 和 legacy mirror。旧正文、Transcript、人工笔记、Action 和既有 RecordingAsset 均不得移动、覆盖或推测归属。asset identity 冲突或中途异常使整笔事务回滚；复制已经 ready 而目标失效时保留 journal/draft，允许重新选择保存位置。处理语言没有可验证的请求字段前不得展示无效控件。

当前运行证据包括模拟器 MP4 新建、WAV 加入已有会议后的双录音播放，以及含中文人声 MP4 的真实注册、流式上传、SHA-256 下载对账和逐资产转写。导入功能实现因此锁定；格式矩阵、第二台移动设备和 USB 作为候选证据后置，详见 [`implementation/contracts/phase-5-media-import-evidence.md`](implementation/contracts/phase-5-media-import-evidence.md)。

#### 批次/候选风险任务

V1 使用一个当前代表格式完成真实摄取/播放，再选择一个最接近本批改动的失败样本；任何中断都不能产生没有恢复动作的“僵尸会议”。七格式、空文件、伪装类型、权限撤销、超大文件、复制强杀、上传中断和重复分享的完整矩阵按第 16.3 节后置，除非对应解析/摄取代码发生变化。

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

服务端采用严格 `id@revision` 白名单，把模板合同归一化为 schema v2。真实 `FinalSummary` 表尚无模板列，因此兼容阶段将 v2 envelope 存入输出 JSON 的 `_laoji_structured_summary`，不伪造已完成的数据库迁移。无附件的四模板使用 4B 动态 JSON schema 精简路径；纯文字历史授权以受控上下文进入同一路径，选中项确定性进入既有讨论 section，未确认历史 outcome 和伪引用在落库前移除；附件仍走完整管线。目标 18020 已完成四模板和真实账号历史利用/隔离任务；剩余是跨设备和真机抽查。

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

双移动实例抽查使用同一 v104 Preview 和同一隔离账号：A 端 App 创建 action 后得到稳定 remote/client ID 与 revision 1，B 端详情 pull 到同一对象并在 App 内完成，服务端推进为 revision 2；A 端冷启动重新进入详情后显示同一 action 已完成。该往返没有创建同名副本，也没有把临时录音伪装为 calendar series；现有未来 occurrence 设备证据继续证明 completed action 会从下一次 pending 系列查询中移除。

migration v13 的 `meeting_series_carry_imports` 以 `(target_meeting_id, source_kind, source_item_id)` 唯一标识一次来源导入，并固化来源 meeting/occurrence/title/content、负责人、截止时间、segment 与 start time 快照。ledger insert 与人工笔记 CAS 必须在同一事务；只渲染本次成功插入的项目。删除目标 meeting 级联删除 ledger；来源 meeting 不设外键，删除来源后仍保留已写入笔记的解释快照。v13 之前的纯文本块不反向猜测 ledger；Summary 重生成若改变决定 identity，语义相同文本仍可能成为新来源项目。模拟器以“决定 A + 事项 B”后再选“事项 B + 决定 C”验证最终三条 ledger、笔记 revision 2、事项 B 正文一次。

决定 citation 只在可证明映射时用于精确回跳：section 仅一条决定时保留其引用；多条决定必须与按 ordinal 排序的 citation 数量相等并按位置一一绑定，否则该决定不携带精确来源。可靠映射进入来源会议“文字记录”并按 segment/source time 定位；歧义或缺失时退回来源“整理结果”。Calendar detail snapshot 为 v2；已提交的 Minutes snapshot v12 保留初始 Transcript 定位 request，并包含详情处理状态、阶段重试和回收站语义。合法 `laoji://` 冷/热深链不会被媒体导入 inbox 抢占。本机合同和模拟器证据见 [`implementation/contracts/phase-6-series-memory-evidence.md`](implementation/contracts/phase-6-series-memory-evidence.md)。

#### Summary 使用

新 Summary 可以接收用户明确选择的 carry-forward actions；未选择的历史内容不进入 prompt。由新会议确认完成旧行动项时，修改的是同一个 action，而不是复制一条同名任务。

“带入我的笔记”只授权写入私人笔记，不自动授权把内容发送给模型。当前 Summary carry-forward 在模板选择后重新查询候选：默认零选择，取消终止生成，“不引用”显式继续；只有独立勾选项进入请求。授权 request ID、项目快照、模板和 Transcript 固化进 input fingerprint 与 pending task。账号服务校验来源归属；历史只作带来源的讨论背景，未被本场明确重新确认时不得进入决定/待办，不得生成或借用本场引用。目标 18020 已以真实账号的决定型和行动型历史完成利用、未选隔离、引用隔离、幂等复用和冷启动 durable 读取。

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

当前实现使用 migration v29 的 `meeting_content_shares` 保存本机冻结快照、内容 scope、远端 revision、幂等 operation 和失败/撤销状态。账号会议在 fresh `meeting_content_shares_v1=true` 时可创建文字链接；游客、未登录、未同步会议和能力缺失均 fail closed。勾选录音时只保留“发送文件”，不得把录音伪装成公开文字链接。

服务端 owner API 按账号与会议隔离 create/list/revoke，公开读取只返回创建时显式选择的 section。原始 token 不落库，只保存 SHA-256；幂等 operation 也不保存可重放 URL。默认冻结全部 section；用户显式选择“链接使用最新整理结果”时，只替换 Summary section，其他信息、行动项、Transcript、Marker、附件索引和私人笔记仍冻结。撤销使 revision 单调增加，公开读取返回 410。

当前邀请地址为严格的 `laoji://share/meeting?token=...` 应用深链，Android 清单和语义解析只接受该 host/path、唯一 token 参数及长度字符集约束；接收端需安装老记。共享页提供发送、失败重试和撤销，撤销冲突先刷新远端 revision，避免本机状态永久卡住。通用网页落地页、非 Android 创建入口、第二移动设备和 USB 不是本纵切已验证范围。

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
POST /api/laoji/v2/meeting-notes/{id}/speaker-corrections
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

当前纵切已覆盖三种 scope。migration v11/v12 继续保存本机不可变 correction/assignment 与服务端 Transcript revision；游客只产生 `local_only` 名称，账号 correction 只有在 Meeting/Transcript/segment 远端身份完整且 fresh capability 开启时发送。目标 18020 的 additive 表保存 correction、人工锁定 assignment、profile revision/model version、样本状态和 reprocess job；服务端先核验稳定 Transcript、片段集合和 base revision，再返回 assignment revision。`future_profile` 只接受当前账号已有且 consent 为 granted 的资料，片段样本异步检查时长、已知重叠、质量和与原 profile 的一致性；不合格时保留标签但不更新向量。资料撤销会物理删除 embedding 并禁止未来识别，不重写历史文字。旧会议 job 只更新未人工锁定片段并生成独立 speaker revision。实现与运行证据见 [`implementation/contracts/phase-7-speaker-assignment-evidence.md`](implementation/contracts/phase-7-speaker-assignment-evidence.md) 和 [`implementation/contracts/phase-7-speaker-profile-evidence.md`](implementation/contracts/phase-7-speaker-profile-evidence.md)；真实多人改善率、第二设备及 USB 仍未验证。

### 10.10 PRIV-01：默认私有与删除语义

- 新 MeetingNote 默认 private；系统分享只导出用户当次选择的文件，不自动创建公开链接。
- 本地未上传录音删除时明确提示永久丢失，不能写成“移到回收站”。
- 已同步 meeting 的服务端删除目标是 soft-delete + 30 天回收站；服务端尚未实现前，UI 不得虚构可恢复。
- 删除 active recording 必须先停止并安全 finalize；若 stop 失败但文件已保存，提供“保留并稍后处理”，不允许直接清空。
- 删除 meeting 时依次处理 outbox、WorkManager、播放缓存、recording journal 和 DB；远端删除失败时本地 tombstone 保留并重试，避免会议重新同步回来。
- 删除 occurrence 不删除 meeting；删除 speaker profile 不重写历史文字，只移除未来识别资格和必要的身份展示。

当前到期清理已落地。移动端 v27 只在 fresh capability 下原子删除已同步 tombstone，并用独立 job 恢复录音、附件、片段、缓存、任务和通知清理；未同步 delete、根冲突与未完成录音合并固定 fail closed。目标 18020 在启动及每六小时按同一 30 天期限批量删除 DB 子内容，并在无 Meeting 外键的 job 中恢复音频文件删除。实现、部署和副本夹具证据见 [`implementation/contracts/phase-5-retention-cleanup-evidence.md`](implementation/contracts/phase-5-retention-cleanup-evidence.md)。

## 11. P2 功能详细设计

### 11.1 QA-01：单场带来源问答

默认开放门槛：引用有效率、Transcript 时间跳转成功率和 Summary 独立重试率均已达到第 16 节阈值；实现本身不等待这些后验指标。

- 问答助手先自动判断当前问题是否需要会议背景。明确相关或有歧义的问题只检索当前 meeting 的 active Transcript、active Summary 和用户选择包含的我的笔记；明显无关的问题进入普通问答，不向模型注入会议来源。
- 会议范围的普通答案必须返回一到多个 `segment_id`/section citation；用户显式纳入“我的笔记”时允许使用锁定的 note revision citation。会议范围无足够来源时回答“当前会议记录中没有足够信息”，不得补常识。普通问答以独立 `general` scope 保存，必须无会议引用。
- 后续问题保留单场 thread context与回答 scope；会议追问每轮重新校验引用仍属于当前 meeting/revision，普通追问只携带连续的普通问答上下文。
- 默认不把“我的笔记”发往问答服务；首次使用时由用户选择是否纳入，选择按 thread 保存。
- 服务端保存问题、答案和 citation，不保存模型隐藏推理。
- UI 放在会议更多动作或详情次级入口，不增加底栏 Agent。

当前已用 migration v22 完成受独立 flag 保护的本机纵切，migration v35 又为每轮增加 `meeting/general` 范围。每个线程锁定 active final/reprocessed Transcript、当前可读 Summary 和可选 manual-note revision 的完整 SHA-256 证据指纹；来源变化会切换新线程，不把旧回答续接到新内容。问题、最终回答、范围和规范化引用保存在 canonical SQLite；会议回答无有效引用时客户端拒绝落库，普通回答必须为无引用 `general`。引用可跳回文字记录时间点、整理结果或我的笔记。会议详情“更多”中的独立问答页复用老记会议页的标题栏、UD 输入/按钮与中性色阶，没有新增底栏入口或说明书式文案。

服务端 overlay 新增游客临时问答与账号问答合同：账号线程按 owner/meeting/client thread 持久化 question、final answer、citation、revision 与 idempotency hash，不保存隐藏推理；游客远端响应为 transient，本机仍持久化。服务端重算完整输入指纹，会议回答的未知、重复或伪造引用会被丢弃，普通问答必须为无会议引用的 `general`。客户端在保存前再次校验 meeting/thread/request/ordinal/fingerprint/revision/scope 全部回显身份。该 overlay 已部署到目标 18020，并完成精确+语义混合检索、真实模型、账号持久化、引用/拒答、多轮幂等和第二设备本机 ID 问答纵切；剩余是真实长会议开放世界观察与 USB 抽查。实现与边界见 `implementation/contracts/phase-8-meeting-question-evidence.md`。

### 11.2 ORG-01：组织与多场找回

实施顺序固定：

1. 用户标签：多对多，名称唯一、可改名/合并。
2. 单层 Folder：只有真实大量会议需求时添加；不先做树形权限。
3. 多场搜索：标题、我的笔记、Transcript、Summary、Action 分源显示。
4. 人物聚合：优先稳定 speaker profile ID；只有名字没有 profile 时按作用域内精确名字临时聚合并标为未确认。
5. 主题聚合：用户标签与 current structured Summary 的 `topics` 独立派生；整理主题不自动变成用户标签。

搜索结果必须展示命中来源和时间；点击 Transcript 命中直接进入 meeting 并 seek。全库问答仍不因此自动开放。

当前落地：第 1、3、4、5 项及第 1 项的账号目录同步纵切均已完成。整理主题由独立 flag 从当前可读 Summary 版本派生，复用既有模型产物和用户编辑保护，不新建并行模型任务、表或标签写入；页面明确区分“用户标签/整理主题”。migration v28 与 18020 `meeting_tags_v1` 以账号目录 revision、持久 outbox/idempotency 和显式本机/云端冲突选择覆盖创建、重命名/合并、删除与会议分配。第 2 项仍等待大量会议的真实需求证据，不属于当前剩余功能量。实现与模拟器边界见 `implementation/contracts/phase-8-organization-search-evidence.md`。

### 11.3 COLLAB-01：轻协作

只在个人闭环稳定后添加：

- 当前协作对象只允许单个 ActionItem；整场 MeetingNote 继续使用 SHARE-01 的显式内容导出，不创建整场公开协作链接。
- 权限仅 `viewer` / `action_editor`；不做 Workspace 角色树。
- action_editor 可以改状态、负责人和截止时间，不能访问未分享的 Transcript、音频或我的笔记。
- 每次修改有 actor、revision、updated_at；冲突按 ACT-01 规则。
- 无复杂自动分享、Channel、用户组或组织默认录制规则。

当前已用 migration v24 和独立 `meetingActionCollaborationV1` flag 完成受控纵切的移动端部分。每条共享回执绑定 canonical MeetingNote/Action 和 scope，创建、失败重试、撤销各有稳定 operation ID；详情中的共享入口不替换原待办编辑入口。所有者 sheet 只提供 `viewer` / `action_editor`，登录后才能创建或撤销，系统发送内容只有待办正文与 capability 链接。严格深链 `laoji://collaboration/action?token=...` 可持久排队并恢复到独立共享待办页；匿名 viewer 只读，editor 只能改状态、负责人和截止日期，revision 冲突提供“使用最新版本 / 保留我的修改”。本机稳定随机 actor ID 只用于协作事件，不映射用户身份。

服务端 overlay 新增 owner create/revoke、匿名单待办投影、editor revision 更新、幂等 operation 与 actor event。token 由至少 32 字节的 `LAOJI_ACTION_SHARE_SECRET` 派生 HMAC，数据库只保存 SHA-256 查询哈希；secret、表或 capability 任一缺失时能力保持关闭。公开投影不含会议标题、Transcript、录音、Summary、我的笔记或来源身份，协作者修改直接推进既有 ActionItem revision，所有者原 action pull/conflict 链可观察。overlay 已同步到目标 18020 并完成运行验证：owner 创建/撤销、viewer 403、editor revision 2→3、陈旧 revision 412、所有者 pull 和撤销后 410 均收敛，公开投影及数据库 token hash 也已核对。实现与证据边界见 [`implementation/contracts/phase-8-action-collaboration-evidence.md`](implementation/contracts/phase-8-action-collaboration-evidence.md)。剩余边界是第二台移动设备与 USB，不扩展为团队权限树。

### 11.4 CLIP-01：重要媒体片段

- 来源是 Marker 或 Transcript 选择，保存 start/end；默认前后扩展小缓冲但允许调整。
- WAV 本机录音可由 native 按 PCM frame 边界复制并重写 WAV header；不得解码整段到内存。
- MP3/M4A/视频等导入格式第一版走服务端异步导出，避免在移动端引入庞大转码栈。
- 片段最短/最长限制由 capability 返回；导出前明确显示范围和是否包含说话人/文字。
- 片段是派生资产，删除片段不删除原录音；删除原录音前提示现有片段依赖。

当前已用 migration v23 和独立 `meetingMediaClipsV1` flag 完成本机 WAV 纵切。Marker 更多操作与 final Transcript 文字选择都能进入编辑 sheet；范围默认带小缓冲，并按 native capability 的最短/最长/步长调整。每条 pending 记录锁定 RecordingAsset checksum/更新时间、来源、范围和讲话人/文字快照；中断后以稳定 clip ID 重试，ready 文件必须具备完整 SHA-256。Android native 解析 RIFF chunk，只接受应用私有目录内的 16kHz/单声道/16-bit PCM，以 64KiB 缓冲按 sample frame 流式复制、重写 WAV header，并通过 `.part` 后同步再改名。片段列表支持来源定位、失败重试、系统分享和独立删除；含讲话人或文字时输出 WAV + `片段信息.txt` 的 ZIP，不含时直接分享 WAV。模拟器 Marker 路径已实际生成 10 秒、320044 字节且 header/数据库 hash 一致的 WAV；原夹具随后恢复。

migration v30 与 fresh `media_clips_v1` capability 进一步完成非 WAV 异步纵切。移动端按远端 RecordingAsset 身份、上传状态、SHA-256 及本机/FFprobe 较小时长边界创建稳定 job；18020 已以真实账号 M4A/MP4 验证 202 创建、200 幂等重放、16kHz/单声道/16-bit PCM WAV 产物、鉴权下载和 204 删除。Android 下载后再校验字节数、完整 SHA-256、RIFF/PCM 参数和时长，原子保存失败时复用 completed job 重新下载，不重复转码；pending/deleting 都可在中断后恢复。模拟器已完成已同步 MP4 从 Marker 编辑、远端生成、原生落盘、来源定位、系统分享及双端删除，且源 RecordingAsset 字节与校验值不变。CLIP-01 因此记为功能纵切完成；尚未宣称跨设备片段目录、第二台移动设备或 USB 真机完成。详细边界见 [`implementation/contracts/phase-8-media-clips-evidence.md`](implementation/contracts/phase-8-media-clips-evidence.md)。

### 11.5 ATT-01：时间点附件

- 照片和简短文本作为 `attachment`，绑定 marker/time，不嵌入 Transcript 文本。
- 拍照需要新增相机权限；当前 manifest 明确移除了 CAMERA，因此在没有真实高频需求前优先支持相册/文件选择，不擅自扩大权限。
- Summary 是否读取附件文字/图片必须由用户显式选择，并记录在 input fingerprint。
- 附件分享默认关闭；删除附件不改变 Transcript 或 Summary 历史版本。

当前已用 migration v21 和既有 Marker 完成本机短文字/相册照片闭环。照片在落库前复制到应用私有 `documentDirectory/meeting-attachments`，Marker 删除只断开来源而不丢失时间点；可恢复删除保留、永久删除清理。分层分享已增加默认关闭的“附件”项；只有用户显式勾选后，短文字/照片索引、原图和不含本机路径的 manifest 才进入 ZIP。

独立“选择附件”sheet 现接收短文字与受控照片：每次生成默认零选择，“取消”终止，“不使用”以空附件授权继续；授权不复用分享选择。游客照片严格关闭；登录账号只有在 fresh `meeting_attachments_v1 + summary_attachments_image` 同时开启时，才能选择 `synced`、无 pending operation 且具备 remote ID/revision/checksum 的照片。单张仍限 25 MB，每次最多 4 张且合计不超过 40 MB；文字与照片总数仍不超过 12。pending task 保存 request ID、附件稳定身份、kind、时间点和当前性字段，照片不保存本机路径；全部进入 v6 fingerprint。任务恢复和提交前重新读取 SQLite 并重新请求 capability，附件删除、内容/时间点、remote revision、MIME、大小、checksum 或更新时间变化都会丢弃旧授权。服务端再次按 owner/meeting 核对远端行，把照片复制到请求独占的不可变任务快照；同授权重放会清理未使用副本，任务结束清理已用副本，进程中断残留由期限回收。最终模型调用对 Ollama 使用 message `images`，对 OpenAI-compatible 使用 data-URI `image_url`；长会议只在 Reduce 阶段读图，禁止把文件名或时间点冒充视觉内容。当前 18020 已部署附件 schema 并广告 `meeting_attachments_v1=true`；因没有已确认的视觉模型，部署候选将 `summary_attachments_image` 硬性保持为 false。账号对象登记/上传/下载/墓碑已用真实测试账号闭环，两个独立同账号模拟器又完成文字附件新增、pull 与墓碑删除；跨设备图片、真实图片理解、第二台物理手机和 USB 真机仍待。该附件轮次中 Marker 未随另一模拟器恢复，故当时不能把附件的 `meeting + position_ms` 拉取扩写为 Marker 同步；后续 MRK-01 已用独立 v34/18020 合同补齐。

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
  "speaker_corrections": true,
  "speaker_profiles_v2": true,
  "speaker_reprocess_v1": true,
  "media_import": {
    "mime_types": ["audio/wav", "audio/mpeg", "audio/mp4"],
    "max_bytes": 1073741824
  },
  "sync_cursor": true,
  "soft_delete_days": 30
}
```

移动端按能力显示功能；服务端未开放时不展示死按钮。capability 缓存带获取时间，网络失败使用上次值，但会改变数据的操作必须在服务端再次校验。

当前目标 18020 的运行响应已明确：`meeting_notes_v2`、结构化整理/引用、文字附件整理、`meeting_attachments_v1`、单场问答、action/pull/collaboration、`meeting_content_shares_v1`、`manual_notes_v2`、`occurrence_links_v2`、`recording_assets_v2`、`speaker_corrections`、`speaker_profiles_v2` 与 `speaker_reprocess_v1` 为 true，音视频 `media_import` 返回受控 MIME/大小合同，`soft_delete_days=30`；`summary_attachments_image` 与全局 `sync_cursor` 为 false。客户端仍逐项按本次实时响应控制会改变数据的操作，不能由某个 broad flag 推导 upload、speaker、图片理解或全局同步能力。

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
  "schema_version": 2,
  "client_note_id": "local-uuid",
  "client_request_id": "local-uuid",
  "origin": "calendar",
  "entry_point": "calendar_detail",
  "title": "",
  "description": null,
  "participants": [],
  "location": "会议室 A",
  "mode": "realtime",
  "recorded_at": "<RFC3339 timestamp with timezone>",
  "occurrence_ref": {
    "source_event_id": "1234",
    "occurrence_date": "<local YYYY-MM-DD>",
    "calendar_revision": 8,
    "recurrence_segment_id": "2",
    "series_key": "calendar:user:7:1234"
  },
  "schedule_snapshot": {
    "event_title": "项目同步",
    "planned_start_ms": 1785000100000,
    "planned_end_ms": 1785003700000,
    "all_day": false,
    "timezone_id": "Asia/Shanghai",
    "location": "会议室 A",
    "participants": [],
    "description": null,
    "captured_event_revision": 8,
    "captured_at_ms": 1785000000000
  }
}
```

响应必须包含 `id`、`client_note_id`、`revision`、规范化 occurrence ref、所有 processing stages 和 `created_at/updated_at`。语义：

- 同 Idempotency-Key 重放返回相同 ID，不重复创建。
- occurrence 唯一冲突返回 409，并在结构化 `current.id` 中给出已关联会议 ID。
- title 空字符串合法。
- occurrence_ref 缺失时 origin 不能是 calendar。
- `Meeting` 仍是唯一主对象；root metadata 只保存客户端身份、来源、单调 revision、生命周期和游标时间。
- 旧 App API 创建/修改/删除必须维护同一 root metadata；已有 root 的旧 API 删除转为软删除并从旧列表隐藏，禁止绕过 tombstone/revision。
- `meeting_notes_v2` 只在 root 与 operation 两张表都可查询时开启；全账号多资产 change feed 未完成前 `sync_cursor` 继续为 false。

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

当前纵切在目标部署中复用既有 `Meeting` 实现 root metadata、持久幂等 operation、create/get/list/patch/delete/restore、`If-Match`、409/412 current payload、日程创建原子关联、软删除和 `(updated_at, meeting_id)` cursor；SQLite 启动 helper 会幂等回填既有 App meeting。移动端严格 v2 parser/transport 只在本次实时 capability 明确开启时工作，并把远端 root revision 与原子 occurrence identity 写回本机；已持有 v2 revision 的会议不会因 capability 探测失败退回无版本旧写。除源码窄合同外，目标 18020/18035 与实际数据库现已运行：同一测试账号的两个独立登录会话完成原子创建、相同请求重放、第二会话 list pull、root/occurrence/manual-note 三类陈旧 412、计划快照不可变 409、soft-delete/restore 及子实体保留。该证据证明线上账号双会话合同，但不冒充 App 断网队列、第二台物理设备或 USB 真机。

移动端根下行使用 v17 `meeting_root_pull_state`，只在账号 canonical owner 与独立账号根写开关同时成立时工作，不开启或冒充全局 `sync_cursor`。每页严格验证 schema、完整实体、微秒级 `(updated_at,id)` 顺序、重复身份、空页和 cursor 前进；根合并成功后应用可安全附着的 occurrence，最后以 expected cursor 做 SQLite CAS。崩溃或 CAS 竞争会重放本页，合并保持幂等；20 页保护上限命中时保留已提交 cursor，由下次刷新继续。存在未完成本机根 outbox 时只允许精确 `client_note_id` 附着远端身份，不覆盖本机字段；旧 revision 忽略，同 revision 非等价根字段报合同错误，远端较新 revision 可应用 tombstone 或 restore。`mode=null` 与服务端默认 `realtime`、以及首次 ACK 后的远端删除时间允许一次规范化写回。日程关联若因根身份尚未可用而延后，根 cursor 仍推进，避免一条本机冲突永久阻塞后续根；现有按 occurrence 独立查询负责恢复，并记录 `occurrence_deferred` 诊断。Store 在整段下行和 canonical projection 收敛期间抑制 observer 抢读。

本机轻量证据为 TypeScript、Android bundle、v17 schema、active/deleted 根插入的 21 参数绑定及 nullable cursor CAS；未恢复归档测试门禁。普通 Preview 已开启账号根 canonical read/write，构建并保留数据覆盖安装到 `emulator-5556`，账号 owner 恢复和 action pull 已运行。随后 RecordingAsset v2 批次独立开启账号上传写，并以 fresh capability 门控完成 v104 WorkManager 真实上传；尚缺 App 进程强杀后的长期离线重放、第二台物理设备和 USB 真机证据。

根 409/412 冲突闭环保持 fail closed：冲突副本必须包含严格 v2 `current`，本机已有关联时远端 ID 必须一致，本机尚无远端 ID 时 `client_note_id` 必须等于 canonical meeting ID；origin、entry point 和 calendar occurrence 身份也必须兼容。选择云端只覆盖根字段并保留所有子资产；选择本机按双方 tombstone 组合生成完整 update、delete 或 `restore -> update`，旧未完成根操作在同一事务中 supersede，任一新 operation 碰撞必须回滚会议、冲突和 outbox 的全部变更。删除态 unresolved root conflict 不从默认列表过滤。该流程是 `[PRODUCT]` 的本机/云端选择与 `[INFERENCE]` 的老记专有冲突页，视觉上复用 Minutes 固定状态槽、Feishu sheet 与 UDButton family，不声称飞书提供同一功能。

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

当前运行实现已完成上述资产边界：同一 MeetingNote 的 primary/secondary 可独立登记、上传、认证下载并创建绑定具体 asset ID 的 transcript job；旧主录音 endpoint 只保留兼容投影。RecordingAsset transcript job 调用 pipeline 时关闭 Summary，使上传成功和 Transcript 完成不再被 Summary subprocess 失败回滚。移动端 v104 使用 asset-keyed pending registry、两阶段 WorkManager 和具体 asset 对账完成真实账号录音上传；v25 完成 Transcript segment provenance、按资产安全替换和多录音回听；v26 再完成每资产 job 发现、持久恢复、冲突收敛、自动/手动重试以及 combined Transcript 落盘 ACK。独立 Summary task 现也已运行并证明进程重启后 durable result 可恢复；尚缺共享 GPU 恢复后的成功自动转写证据和跨设备抽查。详见 [`implementation/contracts/batch-b-recording-assets-v2-evidence.md`](implementation/contracts/batch-b-recording-assets-v2-evidence.md) 与 [`implementation/contracts/phase-4-structured-summary-evidence.md`](implementation/contracts/phase-4-structured-summary-evidence.md)。

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
POST       /api/laoji/v1/meeting-notes/{id}/markers
GET        /api/laoji/v1/meeting-notes/{id}/markers
DELETE     /api/laoji/v1/meeting-markers/{marker_id}
GET        /v2/sync/changes?cursor=&scope=meeting
POST       /v2/sync/batch
```

Marker 已落为独立 v1 对象合同：`POST /api/laoji/v1/meeting-notes/{id}/markers`、会议 owner list 与 `DELETE /api/laoji/v1/meeting-markers/{id}` 使用稳定 Idempotency-Key、单调 revision、If-Match 和删除墓碑；`meeting_markers_v1` 只在目标 18020 fresh capability 中启用。移动端 migration v34 保存 remote identity/revision、sync state 与 create/delete outbox，账号会议根落库后自动重跑 pull；详情页订阅 Marker 变化，另一实例无需第二次重启即可出现或移除 Marker。两个独立 Android 模拟器已完成 A 创建 02:33 Marker、B 首次登录恢复、B 点击精确 seek、A 删除与 B 前台墓碑收敛。验收后发现已同步墓碑会被 repair 逻辑再次排队，已改为只修复未同步删除状态；最终 Preview 的提取 SQL 窄检查确认 synced tombstone 不再入队。附件仍凭自身 `meeting + position_ms` 独立同步，二者不互相冒充证据。

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
- provider 每次启动或 drain 后必须从持久 outbox 重建下一次绝对唤醒时间；`retry` 使用 `next_attempt_at_ms`，未完成的 `in_flight` 使用最后更新时间加 stale claim 间隔。进程内刚产生的相对退避与持久绝对时间取更早者，时钟已越过目标时按立即可唤醒处理，但实际 timer 至少延迟 1 秒，避免热循环。
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

### 13.3 Minutes snapshot v13

v12 基线包含 `mediaImporting/importMedia`、普通列表/回收站 mode、回收站入口和 restore action；录音页包含人工笔记与 Marker；详情包含 page states、结构化 sections/citations、actions、markers、播放器、action focus、处理状态 label/tone/retry stage、独立 `rootSyncConflict` 及处理动作，以及 `focusTranscriptSegmentId`、`focusTranscriptPositionMs`、`focusTranscriptRequestId` 初始来源定位。

v13 已为 v19 录音恢复增加 `playerSources`、录音 label/本机标记、`recordingMergeStatus/Action` 和 `mergeRecordingAssets/selectPlayerSource`，TypeScript/Kotlin 版本常量与 parser 默认值同步。合成模拟器已验证多录音切换、播放、分享和冷启动，因此它是当前客户端兼容基线；旧 snapshot 缺失新字段时仍安全退化为单录音。未知 retry stage 必须 fail closed；根同步冲突不得伪装成 processing retry stage；focus request 只有实际找到目标或可靠时间回退后才能消费。

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
- Summary 只渲染 `source_kind='generated'` 的行动项，不显示新建入口；`manual` / `marker` 不回填进 AI 整理内容。会议“更多 → 本场待办”汇总三种来源并承担手动新建、编辑、完成、来源和后续日程操作。

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
- 字体放大、TalkBack、键盘和导航 inset 是持续设计约束；只对本批新增或改动的组件做定向检查，不重复遍历已锁定页面。
- 动画、长按、拖动和首帧不能由截图证明，但视频任务合并到批次 APK 或候选版；普通数据/服务切片不要求重复录制 UI。

## 14. 代码改造地图

| 当前文件/模块 | 改造方向 |
|---|---|
| `src/types/index.ts` | 只保留导航 DTO；Meeting 领域类型迁往 `domain/meeting`，旧 interface 标 deprecated |
| `MeetingsStore.tsx` | 变成 repository facade，移除 meetings/transcript/summary 整体 JSON map |
| `EventsStore.tsx` | 保持 recurrence 事务；增加 occurrence meeting projection 查询，不把 meeting 塞回 CalEvent |
| `MeetingLiveScreen.android.tsx` | 收敛为 `RecordingSessionController` 订阅者；移出创建/停止/上传/同步长流程 |
| `FinalizeNativeMeetingRecordingUseCase` / `useNativeMeetingRecordingFinalizer` | 固定本机 commit 边界并组装停止、上传登记、Transcript 补全；页面只订阅结果 |
| `meetingTranscriptCompletionTasks.ts` / coordinator / Provider | 账号补全无凭据 registry、同任务合并、退避与启动/前台恢复；不得持久化 token 或正文 |
| `TranscriptionScreen.android.tsx` | 收敛为 detail controller；summary task、audio materialize、action mutation进入 use case/repository |
| `nativeMinutesSnapshots.ts` | 已从 repository projection 构建 v13 snapshot并接入多录音字段；不再把 Markdown 作为主 Summary 输入 |
| `minutes.ts` / `MinutesState.kt` | schema 同步升级，增加 notes/action/marker/stage/citation |
| `MinutesDetailPages.kt` | 新 notes page、Transcript search/highlight、结构化 summary/action/citation |
| `MinutesRecordingSurface.kt` | 内容切换、manual note editor、Marker；录音控制 geometry 保持 |
| `MinutesDetailSurface.kt` | 版本动作、引用跨 tab 跳转、稳定 page state |
| `MeetingUploadWorker.kt` | 从 meeting audio 扩展为 recording asset upload，保留 credential generation |
| `RecordingJournal.kt` | 保持文件安全合同；只增加可选 asset/session reconciliation metadata，禁止大改 |
| `RecorderSnapshot` / `nativeMeetingRecordingRecovery.ts` | 跨桥携带 scope ownership；只按 exact session + exact scope 接管 bridge 异常后的 finalized journal |
| `meetingShare.ts` | 从 kind 三选一改为 content manifest；默认 summary-only |
| `MeetingImportSheet.tsx` / `MeetingMediaImportProvider.tsx` | 元数据确认、键盘稳定、occurrence 冲突预检；确认后才摄取 |
| `meetingMediaImportDrafts.ts` | 持久 scope/title/time/calendarContext；ready journal 恢复时阻止跨账号落库 |
| `guestDataMigration.ts` | v2 event ID map、逐实体阶段和 occurrence link |
| `notifications.ts` | 增 occurrence meeting action，不破坏现有 reminder registry |
| config plugin / native Android | share intent、Widget、Tile、相对路径构建配置 |
| `server-work/summary/api/app_meetings.py` 对应线上模块 | additive v2 models/endpoints、稳定 IDs、location/recorded_at/client ID 对齐 |
| `summary_tasks.py` / app summary generator | segment-ID 输入、sections/citations schema、immutable version |

## 15. 剩余实施计划

### 15.1 执行原则

- 目标由第 4 节的优化 ID 驱动，不再按旧 Phase 从头走一遍；已锁定和本机闭环项默认只在依赖变化或出现缺陷时回访。
- 每个纵切保持单一领域结果、可恢复状态和独立提交；编译/安装/线上/真机证据按第 16 节分层合并。
- 路线只规定依赖和批次，不设明确日期。外部服务、测试账号或 USB 可用时立即合并验证窗口，不可用时继续其他功能。
- recorder 核心、canonical cutover 和运行中服务 migration 仍不在同一工作树切片并发修改；只读 UI、additive 服务端 endpoint 和独立 P2 领域表可以并行。
- 纯重构只有在减少即将发生的重复事务或明显降低数据风险时才进入路线；不为代码美观挤占剩余功能量。

### 15.2 批次 A：关闭本机架构尾项

批次 A 已完成，不再占用剩余工期：

1. v19 recording merge 与目标已有主录音的窄夹具已完成，验证后恢复测试前快照，提交基线为 `600c274`。
2. 活动业务写入口审计只发现 `MeetingsStore` 内的兼容镜像/回滚写；Store 外保留的是日程独立存储、迁移 journal 和导入草稿，不是第二套会议事实源。
3. 普通 Preview 默认开启游客 canonical read/write；首次真实标题 mutation 得到 owner=`canonical`、revision/mirror=`1/1 clean`，改回原值后为 `2/2 clean`，两次冷启动均由 owner 恢复且内容对账全零。
4. broad canonical write 不再使账号媒体导入抢占 owner，冷启动也只有在账号根写开关开启时恢复账号 canonical owner。账号根写和独立账号上传写均已在批次 B 启用；上传还必须取得本次 fresh `recording_assets_v2=true`。
5. 本批没有为形式上的拆分重写 `MeetingLiveScreen`/`TranscriptionScreen`；已有 use case 边界足以完成 cutover。

### 15.3 批次 B：账号和服务端真实闭环

1. 已确认并启动目标工作区的 18020/18035，运行数据库已实例化 additive schema；8020 的旧工作区未被替代使用。
2. Meeting root、occurrence、manual note、action、collaboration、soft-delete 和 speaker correction/profile/reprocess capability 已运行；SPK-01 服务端纵切不再是批次 B 的功能阻塞。
3. RecordingAsset 已从单主录音兼容 API 扩成多资产 v2：稳定 asset ID、role、revision、upload operation、独立转写输入和下载列表均已在目标 18020 运行；旧主录音端点继续投影兼容。移动端 v104 已完成 WorkManager 真实账号上传，并修复 native/JS 并发 412 覆盖成功状态。
4. 测试账号两个独立登录会话已覆盖 create/update、相同请求重放、409/412、delete/restore、occurrence、笔记、action 和第二会话 pull；NOTE-01 又由两个隔离 Android App 实例完成断网 outbox、冲突选择和双端回拉。其他实体的 App 离线冲突纵切及第二台物理设备仍留到对应纵切/候选抽查。
5. 普通包账号根写与独立账号上传写均已开启；上传和逐资产转写每个认证会话仍要求 fresh `recording_assets_v2=true`，保留 capability fail-closed 和旧版本回滚窗口。per-asset provenance、v26 transcription job、独立 Summary 恢复/成功引用、四模板及 speaker correction/profile 已完成；批次 B 只剩 GPU 自动 ASR 与第二移动设备抽查。

### 15.4 批次 C：补齐剩余功能量

- `SPK-01`：功能纵切已完成并锁定；后续只用真实多人录音评估改善质量，并补跨设备/USB，不扩建第二套 profile 或 correction 系统。
- `IMP-01`：功能纵切已完成并锁定。视频 ingest、实时 capability 门控、远端音轨抽取/多资产处理与已有会议显式加入均已闭环；后续只补格式矩阵、第二台移动设备和 USB，不再新建媒体导入状态机。
- `PRIV-01`：到期物理清理纵切已锁定；只续真实到期组合、第二设备和 USB，不再扩建第二套删除系统。
- `QA-01`：本机/线上纵切已完成并锁定；后续只用真实 final Transcript 抽查完整移动端页面和 USB，不重做问答线程/引用/拒答/幂等框架。
- `ORG-01`：功能纵切已完成并锁定。标签目录账号同步、跨会议本机分源检索、人物、用户标签主题和 current Summary 整理主题聚合均已闭环；整理主题不写回用户标签，冲突不做 last-write-wins。后续只补第二台移动设备/USB；Folder 只在大量会议需求成立时添加。
- `COLLAB-01`：本机/线上纵切已完成并锁定；后续只补第二台移动设备往返与 USB，不建设 Workspace/Channel 权限树。
- `SHARE-01`：功能/线上纵切已完成并锁定。内容 scope、默认冻结、可选最新整理、token hash、幂等创建、系统发送、应用深链、管理与撤销均已闭环；后续只补非 Android、第二台移动设备/USB 和是否需要通用网页落地页，不把录音并入文字链接。
- `TRN-01`：reprocessed Transcript 移动端/v31/持久 overlay 纵切已完成；服务未监听时入口 fail closed。后续只补真实单/多 RecordingAsset job、截断不覆盖、重启恢复与真机抽查，不重建 Transcript 版本或逐资产 worker。
- `MRK-01`：功能/线上纵切已完成并锁定。本机创建/定位/删除/转待办/分享及与附件、片段的关联，服务端 owner API、revision/tombstone，移动端 v34/outbox/pull/前台恢复和双独立模拟器第二实例收敛均已闭环；后续只补物理双机、USB 与长离线抽查，不得由 ATT 的独立 `position_ms` 同步替代 Marker 本身。
- `CLIP-01/ATT-01`：ATT 的本机 Marker/时间点短文字、相册照片、显式分享、混合附件逐次授权整理与账号对象登记/上传/下载/墓碑已完成移动端/18020 纵切，两个独立同账号模拟器已补文字附件新增/pull/墓碑；CLIP 的本机 WAV 与非 WAV 异步生成、原生校验、中断恢复、片段列表、分享、定位与删除已完成。ATT 只续真实视觉模型、跨设备图片与物理设备，CLIP 只续跨设备片段目录与物理设备抽查。片段与附件都是派生资产，不修改原录音。

这些纵切各自使用独立 flag。实现完成后即可计入路线完成；真实使用数据只决定默认开放和后续深化，不决定是否允许开工。

### 15.5 批次 D：候选版收口

1. 冻结默认 feature flags、运行服务 schema/capability 和一个可回溯 commit。
2. 构建一个默认配置 APK，优先覆盖安装 USB 真机；USB 不可用时先在保留数据模拟器完成同一最小任务，真机窗口出现后只补设备特有项。
3. 只执行第 16.2 节的关键闭环；发现缺陷则回到对应优化 ID，不顺带恢复历史全量门禁。
4. 修复后只重跑受影响任务和一个端到端主链，生成最终候选包并记录仍后置的兼容矩阵。

### 15.6 剩余依赖图

```text
v19 recording merge（已完成） ── guest canonical cutover（已完成）

目标服务运行/migration
  ├─ root + occurrence + note + action capability ── 真实账号/双设备 ── account cutover
  ├─ recording-assets v2 ── per-asset Transcript ── 每资产 job 调度/恢复 ── 独立 Summary ── video/已有会议加入（均已完成纵切）── clip / attachment 尾项
  └─ speaker-correction v2 ── profile consent ── future improvement / old-meeting reprocess

已锁定的 TRN + SUM citation ── QA-01（本机与服务端源码已完成）
已锁定的 ARC + speaker projection ── ORG-01
已锁定的 ACT + SHARE ── COLLAB-01 移动端/overlay（已完成）── 运行 capability / 双设备
MRK 本机能力（已完成）── Marker 账号 schema/outbox/pull（已完成）
已锁定的 MRK 本机能力 + RecordingAsset ── CLIP-01 本机 WAV + 非 WAV 异步纵切（已完成）/ ATT-01（对象同步已完成）

Marker 账号同步完成 + 四模板真实模型完成 ── 自动 ASR ── 单次候选版物理设备收口
```

## 16. 精简验证与完成门槛

### 16.1 四级验证节奏

| 级别 | 触发时机 | 默认动作 | 明确不做 |
|---|---|---|---|
| V0 切片检查 | 每个提交前 | `git diff --check`；TypeScript 改动跑一次 `npx tsc --noEmit`，Kotlin/资源改动跑对应 compile；migration 做一次 open/upgrade 窄检查 | 不 assemble APK、不安装、不录视频、不跑无关测试 |
| V1 批次冒烟 | 3–5 个相关切片或需要交付 APK 时 | 一次 `assemblePreview`、一次覆盖安装、一个成功路径、一次 crash/SQLite 错误扫描 | 不重复每个切片的设备任务，不做组合矩阵 |
| V2 线上闭环 | capability/schema 批次部署后 | 一个测试账号、一个第二 scope/设备、一次正常往返和一次冲突/断线恢复；核对服务进程 cwd 与运行库 | 不逐 endpoint 穷举状态码，不重复本机视觉验证 |
| V3 候选版 | 完整功能量落地后 | 第 16.2 节七条关键任务、默认隐私检查和最终覆盖安装 | 不以所有 ROM、格式、时长、字体组合全覆盖作为目标完成条件 |

安全例外：涉及录音文件丢失、人工笔记覆盖、账号串数据、永久删除误判或未授权分享时，当前切片必须增加一条对应的失败/回滚检查，不能推迟到候选版。

### 16.2 候选版只保留的七条关键任务

1. **覆盖升级与作用域**：从稳定版保留数据升级；guest/user 数据、墓碑和迁移 journal 不丢失、不串账号。
2. **录制主链**：开始、暂停/继续、结束、本机提交、详情播放；断网或远端失败不把已保存录音判成整场失败。
3. **日程主链**：同一 occurrence 从日历/通知/Widget 进入同一 MeetingNote；双会议冲突保留两边内容并能加入本机录音。
4. **人工与 AI 边界**：我的笔记、用户编辑的整理结果、已完成行动项在重生成、同步冲突和重启后保持。
5. **文字与来源**：Transcript 搜索/回听、Summary citation、行动项来源跳转在一场带真实录音的会议中成立。
6. **隐私与删除**：分享默认不含 Transcript/录音/我的笔记；本机永久删除与账号回收站文案和行为不混淆。
7. **账号恢复**：服务端运行时完成一次离线 outbox 重试、第二设备 pull 和 409/412 用户选择，随后默认能力包冷启动正常。

### 16.3 后置而不阻塞目标完成的矩阵

以下项目仍有价值，但除非当前改动直接命中或已经出现真实缺陷，不作为剩余功能开发的前置门槛：

- 所有 Android ROM、Launcher、ContentProvider、字体倍率、深色模式和导航方式的排列组合。
- 七种音频格式 × 分享/导入/强杀/超大文件的完整笛卡尔积；每类先保留一个代表样本。
- 2 小时/10000 段压力、60 分钟逐段 seek 精度、所有网络状态码和所有并发时序。
- 已锁定页面的重复截图/视频、每次 build 的 Windows 复跑、未改 migration 的重复数据库 hash 对账。
- 留存、使用率和准确率改善统计；这些用于发布后调整默认开关，不用于阻止 P2 实现。

### 16.4 必须持续成立的性能与安全不变量

- 录音采集线程不得等待数据库、网络或 UI；业务失败不能停止已开始的音频采集。
- manual note 继续 400 ms debounce，生命周期离开时 flush；SQLite 写失败保留内存 draft 和明确重试状态。
- Transcript 搜索/播放高亮不得每次全量刷新，snapshot 不跨 bridge 复制无限历史。
- migration 必须 additive 或可恢复；一个逻辑 MeetingNote 的实体写入保持事务，日志不记录正文、文件名、地点、人名、token 或绝对 URI。
- 默认分享只包含用户当次明确勾选的内容；能力探测失败不得退化为更破坏性的永久删除或未版本化写入。

这些是代码审查和缺陷判断的约束，不要求每个切片重新跑性能基准。

### 16.5 证据记录

- 普通切片只在提交说明或对应状态表记录检查结果，不为每次编译新增 evidence 文件。
- 只有新 schema/API、不易复现的数据恢复、首次设备分支或安全边界才更新 `docs/implementation/contracts/`。
- 同一批次的 APK、设备、服务和未决项写入一份证据；旧 APK 时间和重复构建流水不继续堆到主指示文档顶部。
- 观测事件复用 `meeting_note_*`、`processing_stage_*`、`media_ingest_*`、`summary_*`、`action_item_*` 和 `speaker_correction_*` 家族；payload 只含随机 hash、状态、计数、时长桶和错误码。

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
- `recording_assets_v2`
- `speaker_profiles_v1`
- `video_import_v1`
- `meeting_qa_v1`
- `meeting_organization_v1`
- `meetingActionCollaborationV1`（服务端 capability：`action_collaboration_v1`）
- `meeting_clips_v1`
- `meeting_attachments_v1`

`local_meeting_db_v1` 只控制 Release A 的 schema/shadow/reconciliation。普通包现在默认开启 `local_meeting_db_canonical_read_v1` 与 `local_meeting_db_canonical_write_v1`，但每个尚未取得 owner 的 scope 仍先执行完整 shadow import、内容级 preflight 和最终投影对账；任一不一致立即保留旧 Store 读取，写操作 fail closed，不以单个按钮抢占事实源。基础 DB flag 关闭时 read/write 仍被强制关闭，显式关闭 read 也会强制关闭 write。

`local_meeting_db_account_root_write_v1` 与 `local_meeting_db_account_upload_write_v1` 分别再依赖上述三项，普通包现在均默认开启，但仍是两个可独立回滚的授权边界。broad canonical write 只提供基础条件；账号媒体导入、启动 owner 恢复、根消费者和上传状态必须分别确认对应账号开关，不能因 broad flag 自动取得账号所有权。根写继续要求 fresh `meeting_notes_v2`，上传写及逐资产转写调度继续要求本次认证会话 fresh `recording_assets_v2=true`；陈旧缓存、网络失败或明确关闭都不得发送。运行服务、真实 WorkManager 上传、具体 asset 对账、per-asset Transcript、v26 job 恢复、独立 Summary durable result、四模板与来源已有证据，但自动 ASR 的共享 GPU、离线长期重试、第二设备合并与 USB 尚未闭环，因此不能把默认开启解释为候选版验收完成。数据 schema 不随 UI flag 回滚；关闭 canonical read 或 preflight 失败时立即保留旧 Store 读取，关闭其他 flag 只停止对应新写入路径，已有数据仍可导出和恢复。

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

### 开始切片前

- [ ] 对应第 4 节一个优化 ID 和一个可见结果；确认它不是已锁定内容的重复实现。
- [ ] 读取 Git 状态、最近提交和相关 repository/use case；保留用户已有工作树改动。
- [ ] 定义事实源、scope、transaction、幂等键、失败后保留内容和独立 retry target。
- [ ] 只有变更 UI 时读取 `feishu-ui-style` 和对应来源；不为纯数据/API 切片重复做视觉证据。

### 提交切片前

- [ ] 没有新增平行 Store、散落 AsyncStorage map、页面内跨阶段长事务或第二套上传调度器。
- [ ] 录音 journal、人工内容、用户编辑、完成状态、引用 identity 和默认隐私没有被削弱。
- [ ] TS/Kotlin snapshot 或 API schema 同步升级，旧字段有安全默认；用户可见字符串为中文。
- [ ] 执行与改动对应的 V0；只有安全例外才增加定向失败检查。
- [ ] Python 命令使用 `python3`；构建/脚本不引入 Linux 个人路径，并保持 Windows 可解析。

### 批次交付前

- [ ] 执行一次 V1；涉及线上 schema/capability 时再执行一次 V2。
- [ ] 恢复默认 feature flags，确认 APK 不残留 mock、本机端口或临时测试能力。
- [ ] 临时数据库、录音、截图、视频和脚本已删除或归档；日志没有正文、凭据或身份信息。
- [ ] 更新第 4 节状态和剩余闭环；只在达到“本机闭环/已锁定”时提升实现状态。

## 20. 完成定义

### 20.1 功能实现完成

整个路线的实现完成不是“所有页面都有按钮”，而是第 4 节全部优化项至少形成可运行纵切：有真实入口、稳定领域对象、持久化、失败状态、恢复/重试和用户可理解的结果。核心闭环为：

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

除此之外，QA/组织/轻协作/片段/附件必须各有受控纵切，不能只留下表结构、按钮或设计文档。它们可以默认关闭，但不能以“尚无使用指标”为理由从完成范围移除。

任何优化项只要无法说明“事实源在哪里、失败后保留什么、重试只重跑什么、用户修改如何不被覆盖”，就不满足实现完成定义。反之，缺少与本项无关的格式/ROM/压力矩阵不会把已实现功能重新降为未开始。

### 20.2 目标完成

目标模式可以标记完成时必须同时满足：

1. 第 4 节没有 `进行中`、`部分完成`或`未开始`；P2 至少达到受 flag 保护的本机/线上纵切。
2. 普通包以 canonical 作为已迁移 scope 的主事实源；账号能力由运行中的 capability 控制，探测失败 fail closed。
3. 目标服务的实际进程、数据库 migration、测试账号鉴权和 RecordingAsset 多资产合同已运行，不只是源码同步。
4. V3 七条关键任务通过，且没有已知的录音丢失、人工内容覆盖、串账号、错误永久删除或越权分享。
5. 有默认配置候选 APK 和回溯 commit；稳定标签 `stable-before-meeting-memory-roadmap` 仍保持不动。

第 16.3 节后置矩阵、发布后的效果指标和未出现缺陷的兼容组合不阻塞目标完成，但必须作为已知边界记录，不能伪装成已验证。

## 21. 作为目标模式附件时的执行协议

1. 目标必须指向本文件的整体完成定义，不得把“完成当前 Phase”或“产出一个 APK”误当整体目标完成。
2. 用户最新明确指令高于本文件；已验证的源码、线上契约和真机事实高于文档推断。产生偏差时必须记录原因并更新相应契约，不得为了贴合旧文字而忽略新证据。
3. 每次续做先读取 Git 状态、最近提交、第 0/4 节和相关契约证据；从最后一个实现检查点继续，已锁定事项默认不重做。
4. 每个可恢复纵向切片单独提交；执行对应 V0。可安装包和设备任务按批次/V1/V3生成，不再要求每个产品行为提交都单独构建和录像。
5. 外部服务或设备一时不可用时，关闭对应写能力并记录证据边界；同时推进批次 C 或其他不依赖项，把线上/真机任务合并到下一个可用窗口。
6. 每完成一个批次更新第 4 节状态；实现完成与证据状态分开报告，不因少做后置矩阵虚增完成度，也不因缺 USB 抹掉本机闭环。
7. 适时提交但不自动 push；工作树存在其他用户改动时只暂存本切片文件，不 reset、clean 或覆盖无关内容。
8. 稳定版验证用 `git rev-parse stable-before-meeting-memory-roadmap^{}`，应返回 `cde96f9d5266961e380957893ecba39855aea39b`。需要回溯时使用 `git worktree add --detach <target-directory> stable-before-meeting-memory-roadmap`，不得通过重置当前开发工作树来验证稳定版。
