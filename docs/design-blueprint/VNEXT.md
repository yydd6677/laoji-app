# 老记 vNext 架构基线

vNext 已是当前产品架构，不再表示“尚未采用的候选版本”。本文件定义稳定所有权和能力合同；具体发布号见 [CURRENT.md](CURRENT.md)。

## 1. 目标

老记把日程与会议中的原始材料转化为可找回、可核对、可继续执行的个人记忆。架构优先级依次是：

1. 原始数据不丢、用户修改不被模型覆盖；
2. 高频操作即时响应，后台工作可恢复；
3. 生成结果有来源、可解释、可替换模型；
4. 页面状态连续，内部复杂度不转嫁给用户；
5. 在固定服务器资源内保持紧凑、清晰、可运维。

## 2. 产品边界

- 单用户、单设备、去账号；设备身份只用于服务授权、配额和任务恢复。
- 不提供跨设备同步，不让服务器成为日程或会议的第二份业务权威。
- 原始日程、会议、录音、笔记和用户编辑长期留在手机；服务端只接触完成明确计算所需的最小来源。
- 服务端可保留与 device/binding/task 绑定的生成 artifact，以便恢复和质量改进；删除时必须服从 purge fence。
- 当前 Android 为主平台；公共 TypeScript/协议保持 Linux/Windows 开发工具可移植，平台能力由 adapter 隔离。

## 3. 所有权图

```text
ScheduleRepository --------------------> laoji-schedule.db

MeetingRepository ---------------------> laoji-meeting-memory.db
  RecordingAsset ----------------------> app-private media
  TranscriptRevision + SpeakerOverlay -> meeting DB
  Summary/Question version -----------> meeting DB
  ActionItem/Tag/Note -----------------> meeting DB

Native platform
  recorder / importer / player / WorkManager / LJHW transport
        |
        v
Device API: binding + task + attempt + cleanup
        |
        +--> R2 staging
        +--> ASR provider
        +--> LLM + embedding provider
```

每条箭头只有一个写 owner。UI store、缓存、native snapshot、服务端 task 和兼容 mirror 只能投影，不能竞争业务真相。

## 4. 本机存储

### 4.1 日程库

`laoji-schedule.db` 独占事件、重复规则、提醒和日历投影检查点。日程保存不需要账号或服务端记录。复杂解析返回候选 graph，手机 validator 负责最终日期、时间、时区、重复、范围和澄清一致性。

### 4.2 会议库

`laoji-meeting-memory.db` 独占会议聚合、媒体引用、转写 revision、讲话人 overlay、笔记、附件引用、整理、问答、待办、标签、回收站和远端 operation 投影。

日程与会议不建立跨库外键。会议保存日程稳定 ID 和必要快照；“从行动创建日程”等操作通过幂等 use case 提交两次独立事务。

### 4.3 媒体

- 每个媒体资产有稳定 ID、generation、来源、hash、大小、状态和 journal。
- 接纳完成前保留来源；app-private canonical media 成功后才能释放导入临时文件或外接设备 pending 对象。
- 视频在手机提取音频后上传；不把视频字节作为 ASR 输入，也不以原视频体积拒绝可处理音频。
- 容量保护依据可上传音频与本机可用空间，而不是任意文件格式上限。

## 5. 设备与远端任务

### 5.1 设备身份

安装生成设备密钥并完成 challenge bootstrap。短期 token、key revision、device epoch 和 binding generation 共同限制权限；源码和 APK 不持有长期服务器主密钥。

当前发布仍有明确的迁移债务：部分 device-v1 HTTP、日程实时 WSS 和地址调用继续使用旧设备凭据，新安装注册所需的共享 admission token 会进入 APK、可被提取。它只能作为过渡期准入提示，不能承担秘密、设备身份、配额或授权边界。不得让 device-v2 再签发一份长期 v1 secret；迁移应让 v2 短 token 映射到现有 device/epoch 数据 owner，逐调用方切换后删除发布 token 和 v1 注册入口。

### 5.2 Binding

手机生成 opaque meeting binding。服务端只接受单调 revision/cancel fence，不从标题、会议 ID 或正文推导业务对象。binding 允许任务恢复和删除清理，但不是远端会议副本。

### 5.3 Task/Attempt

- Task 表示一次不可变输入 generation；Attempt 表示一次租约执行。
- 自动重试增加 Attempt，用户明确重新生成增加 Task。
- 阶段单调推进；重启后从持久 checkpoint 恢复，成功 artifact 原子发布。
- `no_speech`、无行动候选等是内容结果，不是系统错误。
- 取消、重试、commit 和 purge 都以 generation/revision/CAS 防止迟到写覆盖当前结果。

## 6. 日程解析

```text
文字或语音
  -> 本机规范化与高置信 producer
  -> 无法闭合时提交 server graph producer
  -> 同一个 ScheduleMentionGraph
  -> 手机 validator
  -> 同一草稿上的澄清
  -> 本机保存
```

规则和模型不是两个最终解析 owner。本机规则只负责高置信快速生产；服务端复杂路径不再重复跑另一套同义规则。澄清必须携带 prior graph/draft 和缺失槽位，不能把回答当新句子解析。

语音先采集本地缓冲，再连接 WSS 和补发；连接建立、模型预热和鉴权不得截掉开头语音。

## 7. 会议采集与上传

### 7.1 手机录音

Android 先创建本机会议/journal 并启动麦克风，再异步准备 device session、binding 和实时 ASR。实时附着失败时继续同一手机录音，停止后由批量链补全文字。

### 7.2 文件导入

用户选择后立即返回会议页并持久化导入任务；音频抽取、复制、哈希和上传由原生后台执行。允许不同会议并行准备，同一资产串行幂等；并发受到 I/O、内存和服务器队列的有界调度，而不是用户可见的固定“只能两条”。

### 7.3 外接设备

`LJHW/1` 统一 USB、BLE 和 Wi-Fi transport 的发现、能力、控制、音频帧、对象、校验、ack 与错误：

- 测试板：MicroSD PCM WAV owner、USB/BLE live mirror、Wi-Fi Range bulk 和显式文件管理。
- 正式硬件：可协商 Opus、电池和电源；bulk 必须使用配对身份与 `tls_pinned`。
- 所有来源都落为 app-private pending media，再进入同一 RecordingAsset 链。
- ack 不删除，delete 绑定 generation；断线不切换麦克风，不让硬件直传业务云端，不为型号建立平行业务表。

### 7.4 R2

WorkManager 使用短期 single/multipart 凭据直传 R2。服务端验证 hash/size 后才创建 verified asset 和 ASR task；终态、取消、删除和过期均产生可恢复 cleanup obligation。

## 8. ASR、讲话人和文字记录

- `laoji-asr` 的一个 Qwen3-ASR 模型同时处理实时片段、日程短语音和长媒体 batch，按交互优先级排队。
- 文字以 partial/stable/final 事件发布；stable 事件有稳定键、来源时间范围和模型 revision。
- 客户端先持久化 stable segment 再 ack；WSS 丢事件时从 durable ledger 补齐。
- VAD 负责音频选择和时间边界，不用频繁句号制造语义断句；标点由 ASR/后处理在稳定文本边界合并。
- CAM++ 与声纹匹配走异步 lane；speaker overlay 不改变文字 revision，未知人保持匿名。
- 无声音频正常结束为 `no_speech`，页面显示“未检测到讲话”而非“处理失败”。

## 9. 整理与行动

### 9.1 来源

转写是主来源；当前笔记自动加入；附件必须由用户本次授权。每个来源带稳定 ID、revision、hash 和可定位引用，临时正文加密并按 TTL 清理。

### 9.2 语义层

模型只生成结构化事实、certainty、关系、指标、观点和行动候选，不生成 Markdown、图标、颜色或布局。长会议按时间/语义分章选择证据并生成同一协议，服务器确定性合并；不得递归总结后丢失原始依据。

引用、数字、日期、负责人和期限都必须能解析到当前来源版本。无效事实删除，冲突事实保留来源并标记待确认。模型调用由统一 Provider 承担，正常一次生成，结构损坏最多一次修复。

### 9.3 自适应展示

本机只显示一份整理：

- 必有：概述和与内容相称的主要板块。
- 可选：时间线、流程、对比、数据、风险、问题、观点、代表性引用。
- 只有显式关系、时间或同单位数据满足准入时才显示相应图表，否则退化为文字结构。
- 板块显隐是本机偏好，不创建网络任务；用户编辑形成覆盖层，不改共享事实。
- 普通条目按板块收纳依据，不重复尾注讲话人/时间。

历史数据行可保留旧 `general/one_on_one/project_sync/interview` 字段，但运行时不读取、不展示、不转换，也不得驱动新生成。

### 9.4 ActionItem

模型行动只是不变候选；本机校验来源、重复、已完成/否定/纯提问和日程适配度。用户采用后进入唯一 mutable `action_items`，重新整理不得覆盖其编辑、完成、提醒或后续日程。

## 10. 会议问答

问答一次读取当前会议的 transcript/note/authorized attachment source stream，先检索相关段，再生成答案并绑定精确引用：

- 不读取其他会议，不以整理结果代替原始证据。
- 引用必须属于当前 binding、当前 source revision，并通过逐字/位置校验与问题相关性门。
- 结果与请求 ID 原子提交；页面重进读取同一持久任务，不重复生成。
- embedding 留在本地 provider；若 embedding 不可用，明确失败，不静默退化成不可解释的词法答案。

## 11. 组织、删除、分享和更新

- 标签由用户显式管理；主题不从某个整理结果自动提升为长期分类。
- 搜索以本机 FTS 和当前标签/讲话人派生索引为主。
- 删除先本机 tombstone/回收站；永久删除 fence binding 并异步完成远端 artifact 和 R2 清理。
- 分享默认由手机导出 Markdown 或所选文件。旧账号型公开链接不属于当前能力；未来若新增设备公开 capability，必须具备随机 token、范围、撤销和删除绑定，且不暴露 R2 对象 URL。
- 更新清单包含版本、构建号、hash、大小和下载地址；客户端只呈现一个主要下载/安装动作。

## 12. UI 与原生边界

- TypeScript repository 拥有持久业务 snapshot；Kotlin 拥有录音、播放、系统选择器、WorkManager、硬件 transport 和 native surface 瞬时态。
- 跨桥消息必须带实体 ID、revision/generation 和 action ID；迟到事件无法覆盖较新 projection。
- 列表和详情读取同一状态；重进页面不能因局部 state 丢失正在处理的任务。
- 条件内容不得移动固定导航。加载时保留上一帧可用内容，避免空白首帧、布局重排和格式闪变。

## 13. 服务与资源

生产常驻仅保留：

| 服务 | 监听 | 资源角色 |
| --- | --- | --- |
| `laoji-api` | `127.0.0.1:18020` | HTTP/WSS、SQLite task store、ffmpeg/VAD/CAM++ 编排 |
| `laoji-asr` | `127.0.0.1:8030` | Qwen3-ASR GPU 推理与有界队列 |
| Ollama | `127.0.0.1:21434` | 一个生成模型和一个 0.6B embedding 模型 |

公网只经 `laoji.cloud`。Redis、Celery、PostgreSQL、Neo4j、Chroma、VibeVoice、Whisper 和其他模型服务不进入老记拓扑。GPU1、PCB、Smart Meeting 与其他用户服务不可被老记部署脚本操作。

## 14. 不变量

- 不双写、不静默 fallback、不把缓存升级为 owner。
- 不把评测样本内容、人物、标题或表达风格写进生产 prompt/规则。
- 不以关键词门禁替代行动语义，不以模型输出替代来源校验。
- 不因网络、服务或 speaker 失败损害已完成的本机录音/导入。
- 不让当前页面状态依赖用户重新进入、重启 App 或重复点击。
- 不把“源码存在、单测通过、候选运行”描述成生产已发布或真实流程已验证。

## 15. 演进方式

后续改进以垂直替换为单位：先定义 owner 和合同，再接入真实输入和恢复，切断旧 writer，验证当前发布，最后单独删除兼容 reader 与历史资产。禁止重新建立 Stage 候选文档体系或在当前链外长期养第二套实现。
