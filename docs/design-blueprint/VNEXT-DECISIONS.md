# 老记当前架构决定

状态只使用：`ADOPTED`（当前架构）、`COMPATIBILITY`（有真实调用方的过渡接口或历史读取/迁移）、`DEFERRED`（合同已定但尚未完成）、`REJECTED`（不得重新引入）。旧 Stage 或 candidate 状态不再代表当前产品。

## 1. 有效决定

| ID | 领域 | 状态 | 决定 |
| --- | --- | --- | --- |
| D01 | 产品身份 | ADOPTED | 去账号、单用户单设备；设备身份只用于授权、配额、恢复和删除 |
| D02 | 本机权威 | ADOPTED | 日程、会议、媒体、用户编辑和本地组织由手机长期拥有 |
| D03 | 数据库 | ADOPTED | 日程与会议使用独立 SQLite 文件，无跨库外键/事务/双写 |
| D04 | 远端任务 | ADOPTED | Task/Attempt/lease/checkpoint 是唯一计算 owner；页面和缓存只投影 |
| D05 | 日程解析 | ADOPTED | 本机/模型 producer 输出同一个 graph，手机 validator 唯一裁决 |
| D06 | 语音日程 | ADOPTED | 先本机采集再联网补发；补充修改同一 draft |
| D07 | 会议媒体 | ADOPTED | 所有来源先成为本机 RecordingAsset，再异步准备、上传和识别 |
| D08 | 上传 | ADOPTED | native WorkManager 直传 R2；generation、hash 和 cleanup obligation 幂等 |
| D09 | ASR | ADOPTED | 8030 Qwen3-ASR 统一实时/短语音/批量；stable 逐批发布 |
| D10 | 讲话人 | ADOPTED | CAM++ 异步 overlay；未知人匿名；人工修正不改 transcript text |
| D11 | 整理 | ADOPTED | 结构化事实与引用生成，本机一份自适应展示；四模板不再是产品能力 |
| D12 | 行动 | ADOPTED | 生成项只作候选；用户采用后进入本机唯一 mutable ActionItem |
| D13 | 问答 | ADOPTED | Q2 只读当前会议不可变来源，一次 reader，引用归属和相关性 fail closed |
| D14 | 组织/搜索 | ADOPTED | 显式标签 + 本机搜索；人物为 speaker 派生，整理主题不成为长期分类 |
| D15 | 删除 | ADOPTED | 本机先删；远端 artifact/R2 清理由 fence 和 obligation 恢复 |
| D16 | 分享 | ADOPTED | 当前由本机导出 Markdown/文件；账号型公开链接退役，未来只能新增设备范围 capability |
| D17 | UI/native | ADOPTED | JS repository 拥有业务 snapshot；native 拥有平台能力和瞬时 surface |
| D18 | 服务 | ADOPTED | 三业务进程：laoji-api、laoji-asr、Ollama；R2 仅 staging |
| D19 | Provider | ADOPTED | 所有生成走 LlmProvider；本地/云端显式选择，禁止静默切换 |
| D20 | 外接硬件 | ADOPTED | LJHW/1 是唯一协议；USB/BLE/Wi-Fi 只增加 transport，不增加会议 owner |
| D21 | 音频片段 | COMPATIBILITY | 独立入口退役；旧表/文件只读清理，播放与引用直接使用原录音 |
| D22 | 旧账号/同步 | REJECTED | 远端同步 reader/writer 已退役；历史迁移字段可保持惰性，不能恢复网络链 |
| D23 | 硬件离线对象 | ADOPTED | 测试板已实现 SD、恢复、manifest、Range、ack/delete；正式硬件替换安全和电源 adapter |
| D24 | device-v1 鉴权 | COMPATIBILITY | 当前调用迁移到 v2 短 token 前保留；APK 中共享 admission token 可提取，只是准入提示，不是秘密或授权边界 |

## 2. 决定说明

### A01 手机是业务 owner

账号和跨设备功能已放弃。继续在服务端保存完整日程、会议、录音和用户修改只会制造冲突、隐私暴露和删除歧义。服务端保留的是计算所需最小来源、可恢复任务、明确允许的生成 artifact 和清理义务。

### A02 日程与会议物理分库

两者数据体积、迁移频率、清理策略和故障恢复不同。repository 分层不能阻止误删/重建扩大影响，因此使用 `laoji-schedule.db` 与 `laoji-meeting-memory.db`。完整卸载仍会清除整个沙箱；分库解决的是应用内部爆炸半径，不是假装提供安装级备份。

### A03 关系聚合 + 不可变 revision

核心实体使用关系表；转写、整理、问答和来源使用不可变 revision + active pointer；用户编辑使用 overlay。拒绝全量事件溯源，因为单用户产品不需要 event log、reducer 和重建投影三套状态。

### A04 一个任务 owner

Task 拥有输入 generation 和终态，Attempt 拥有一次租约执行。自动重试增加 Attempt，用户重新生成增加 Task。内存 Future、页面轮询、WorkManager 和服务端领域 worker 都不能建立第二任务真相。

### A05 一个日程语义合同

本机快速 producer 和服务端模型 producer 都输出 `ScheduleMentionGraph`，最终只执行一次手机 validator。拒绝本机与服务器各维护一套同义规则，也拒绝把补充回答作为新输入从头解析。

### A06 先接纳，再处理

录音、语音输入和文件导入的首要目标是保住用户输入。网络鉴权、hash、模型预热、媒体抽取和远端登记都移出交互关键路径。后台任务必须可恢复，不能用固定“同时只能两条”替代资源调度。

### A07 文字先于讲话人

ASR stable segment 逐批发布；CAM++/声纹独立计算并发布 overlay。讲话人计算慢或失败不能拖住文字，人工姓名也不能在重转写时被模型覆盖。

### A08 结构化语义与展示分离

模型生成事实、关系、指标、观点、引用和行动候选；本机选择概述、议题、风险、时间线、流程、对比、数据、观点等板块。模型不得输出图标、颜色、坐标或布局。四模板标题不同却复用相同内容的设计已被一份自适应整理取代。

### A09 来源决定可信度

整理和问答只接受当前 transcript、当前笔记和本次获准附件。数字、时间、人物和行动必须能定位到来源；summary 不是问答事实源，模型 confidence 不是展示依据，评测样本不能进入生产 prompt/规则。

### A10 生成候选不是用户待办

模型可宽松提出候选，代码负责来源、状态、重复、范围和日程适配度。用户确认后才创建 ActionItem；重新整理不能覆盖用户的编辑、完成、提醒和后续日程。

### A11 平台能力不拥有业务状态

Kotlin 独占录音、播放、文件选择、WorkManager、系统 UI、硬件 transport 和瞬时页面状态。TypeScript repository 生成持久业务 snapshot。跨桥消息必须携带实体和 revision，不能用中文文案或数组位置判断状态。

### A12 外接硬件只是一种来源

测试板 SD、USB/BLE/Wi-Fi 与未来正式硬件都通过 `LJHW/1` capability。硬件拥有源 session/object，ack 只记录已接收且不自动删除；手机校验并原子保存后进入同一 RecordingAsset 链。断线不能换成手机麦克风，设备不能直接上传业务服务或创建会议。

### A13 紧凑服务与可换 provider

生产仅有 `laoji-api`、`laoji-asr` 和 Ollama。R2 是暂存对象服务。Redis、Celery、PostgreSQL、Neo4j、Chroma、VibeVoice、Whisper 和额外业务进程均不采用。生成可在 Ollama 与 DashScope 间显式切换，但必须走同一 schema、grounding 和日志合同。

## 3. 明确否决

| 方案 | 状态 | 原因 |
| --- | --- | --- |
| 恢复账号/跨设备作为默认 | REJECTED | 违背当前单设备、本机权威产品边界 |
| 日程/会议重新合并一库 | REJECTED | 扩大删除、迁移和损坏恢复爆炸半径 |
| 服务端复制完整业务模型 | REJECTED | 重新制造同步冲突和隐私成本 |
| 本机/服务端两套解析规则 | REJECTED | 重复 owner，行为难以解释和测试 |
| 连接后才开始录音 | REJECTED | 直接损害最高频输入路径 |
| 等整份完成才返回转写 | REJECTED | 不必要地增加用户等待和状态不确定性 |
| speaker 阻塞 transcript final | REJECTED | 慢计算拖住已经可用的文字 |
| 四种模板分别生成 | REJECTED | 事实漂移、重复调用、区分度虚假 |
| summary 作为问答事实源 | REJECTED | 生成内容不能替代原始来源 |
| 关键词硬否决行动 | REJECTED | 候选语义被僵化规则误删 |
| 静默 provider/词法 fallback | REJECTED | 隐私、质量和 revision 不可解释 |
| 外接设备第二套业务链 | REJECTED | 产生重复会议、上传、同步和删除 owner |
| 永久保留 APK/候选/备份副本 | REJECTED | Git/构建可恢复资产不应污染活跃工作区 |
| 用缩短动画掩盖页面卡顿 | REJECTED | 不解决同步 I/O、组件重建和状态耦合 |

## 4. 当前风险与处理

| 风险 | 处理 |
| --- | --- |
| 历史迁移仍含 account/sync/template/clip 名称 | 保持迁移可重放；运行时 import、route、writer 和 fallback 必须为零 |
| 长会输入与延迟 | source stream 分章、滚动 checkpoint、交互优先；不静默截断 |
| 模型升级造成结果漂移 | 持久 model/prompt/schema revision；同输入回放和真实人工抽查 |
| R2/网络中断 | WorkManager、multipart probe、task lease、cleanup obligation |
| 页面状态闪烁或回退 | 列表/详情共享 operation revision；上一份结果持续展示；条件 UI 不移动固定结构 |
| 测试板与正式硬件差异 | 只按 capability 编程；测试证据不外推到电池、存储、功耗和量产安全 |
| device-v1 admission token 可从 APK 提取 | 不复用任何其他 secret；v2 token 映射既有 device/epoch owner，按 HTTP/WSS/地址垂直切换后删除 v1 注册 |
| 清理误删当前依赖 | import/route/config/open-file/DB lifecycle 五类证据；不确定项仓库外校验归档 |

## 5. 修改决定的条件

新证据可以修改实现，但不能只因旧代码存在就恢复旧架构。只有出现下列反证才重开本文件对应决定：

- 当前 owner 无法满足真实数据生命周期或恢复；
- 固定资源下目标质量/时延在多种实现上均不可达；
- Android 平台能力使合同无法实现且没有等价 adapter；
- 用户明确恢复账号、跨设备、长期云存储或新的硬件产品边界。

其他问题按 [VNEXT-IMPLEMENTATION.md](VNEXT-IMPLEMENTATION.md) 在当前 owner 边界替换实现，不新增平行蓝图。
