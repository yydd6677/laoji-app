# 老记 vNext 实施约束

本文面向实现者，描述当前代码 owner、接口、迁移、恢复和验收。它不再按旧 Stage 复述开发历史；新改动必须在当前架构上做垂直替换。

## 1. 当前基线

- branch：`vnext/implementation`
- mobile：`1.1.97` / Android `205`
- public base：`https://laoji.cloud`，WebSocket 使用 `wss://laoji.cloud`
- product：accountless、single-device、mobile-local authority
- production topology：API `127.0.0.1:18020`、ASR `127.0.0.1:8030`、Ollama `127.0.0.1:21434`

旧分支、旧 Stage 目录、候选工具和历史发布包不是实现输入。需要比对时从 Git 或服务器校验归档恢复到活跃树之外。

## 2. 模块所有权

| 责任 | 当前入口 | 约束 |
| --- | --- | --- |
| App 启动/导航 | `App.tsx`、`src/navigation` | 启动只装载本机必需状态；不得等待服务 readiness |
| 日程业务 | `EventsStore.tsx`、`localScheduleRepository.ts`、日程 native surface | repository 写库；store 只订阅/编排 |
| 会议业务 | `MeetingsStore.tsx`、`meetingNoteRepository.ts`、`sqliteMeetingNoteRepository.ts` | SQLite 是列表/详情共同 owner |
| 录音/导入 | native recorder、media importer、`meetingMediaImport*` | 先本机接纳；网络不在采集关键路径 |
| 上传 | RecordingAsset、native WorkManager、device upload API | Work UUID 不是业务 ID；generation + hash 幂等 |
| 转写 | transcript repository、device task/event ledger、8030 | stable 先持久化再 ack；final 只出现一次 |
| 讲话人 | speaker overlay repository、CAM++ lane | 不改写 transcript text revision |
| 整理 | immutable sources、summary task、Facts/Knowledge schema、adaptive composer | 一份语义文档；`general@3` 仅为内部 envelope |
| 问答 | Q2 source stream、`questionQ2Repository.ts` | 只读当前会议来源；引用当前 revision |
| 待办 | action repository/application use cases | mutable owner 与生成候选分离 |
| 外接硬件 | `contracts/hardware`、native hardware runtime、`hardware.ts` | transport only；输出复用媒体链 |
| 服务编排 | `services/laoji-api` | SQLite durable task/attempt；不保存第二份业务模型 |
| ASR | `services/laoji-asr` | 模型协议、优先队列和推理指标 |

### 2.1 历史 schema 与窄清理桥

历史迁移仍包含 account/sync/template/clip 表名和字段，以保证旧数据库可顺序升级；当前运行时不得读取、写入或通过 capability/error 回退到这些业务链。独立媒体片段只保留永久删除时清理旧文件的窄桥。device-v1 仅保留当前代码明确仍调用的注册/能力、日程、转写恢复、讲话人、删除、日程实时 WSS 和地址能力；每个兼容接口都必须有真实 caller，不能作为无期限保留旧 owner 的理由。

## 3. 本机数据库

### 3.1 打开与升级

- 会议：`src/data/db/openDatabase.ts` -> `laoji-meeting-memory.db`。
- 日程：`src/data/db/openScheduleDatabase.ts` -> `laoji-schedule.db`。
- 两库分别启用 WAL、foreign keys、busy timeout 和完整性检查。
- 日程从旧会议库迁移时先复制、逐行核对、提交完成标记，再停止旧表写入；中断后按标记恢复。
- 任何会议删除、会议库修复、媒体清理都不得打开或删除日程库。

### 3.2 schema 规则

- 业务对象使用稳定 UUID/opaque ID；远端 task/work UUID 不替代实体 ID。
- 生成内容使用不可变 revision 和 active pointer；用户编辑使用独立 overlay。
- 远端 operation 投影至少包含 operation ID、generation、stage、updated revision、retry/cancel 状态。
- transcript segment 的稳定身份不依赖数组下标或重新分段后的顺序。
- 跨库关系只保存稳定 ID 和必要快照；不建立跨库事务。

### 3.3 数据清理

- 回收站是本机 soft delete；永久删除事务先 fence 本机实体，再登记远端 purge。
- 媒体文件只有在引用计数为零且无活跃 task/lease 时删除。
- 完整“清除本机数据”分别点名两库、媒体、临时导入、硬件 pending、SecureStore 和任务 journal；不得用领域修复替代 `pm clear`。

## 4. 日程实现

### 4.1 文本

1. 输入规范化只处理空白、中文数字/时间形式和明确别名，不改变语义。
2. 本机 fast producer 能闭合时生成 `ScheduleMentionGraph`。
3. 不能闭合时调用 `POST /api/device/v2/schedule/graph`，不在服务端再跑同一规则 parser。
4. 手机 validator 统一检查日期、时间、时区、持续时间、重复、提醒、范围和操作目标。
5. 缺槽位时保留 graph/draft；补充走 `/schedule/graph/clarify`，只更新同一草稿。
6. 最终事务只写 `laoji-schedule.db`。

### 4.2 语音

- 按下即启动本机 PCM buffer；连接状态不作为用户可见阻塞。
- WSS 可用后按序补发 pre-connect 音频；断线保留 cursor 并重连。
- ASR 文本进入同一 graph/validator，不建立“语音专用日程规则”。

## 5. 会议媒体实现

### 5.1 统一 RecordingAsset

所有来源映射到同一字段：`asset_id`、`meeting_id`、`generation`、`source_kind`、`local_uri`、`mime`、
`audio_duration_ms`、`sha256`、`ingest_stage`、`upload_operation_id`、`transcript_task_id`。

状态单调：

```text
accepted -> preparing -> local_ready -> upload_registered -> uploading
         -> verified -> transcribing -> transcript_ready
```

失败记录具体 operation 与可重试边界，不把整个会议降级。页面从本机 operation 投影状态；返回/重进不触发状态推进。

### 5.2 文件/视频导入

- 系统选择器只过滤受支持的音频/视频 MIME；选择完成立即持久化 draft 和会议。
- native extractor 以流式 ffmpeg/MediaExtractor 产生 app-private 音频，不生成第二份永久视频。
- 上传限制依据提取音频和服务容量，不能以视频源文件大小直接拒绝。
- 不同会议可并发准备；同一 meeting/asset 使用 keyed lock。并发数从设备 I/O 和内存预算配置，不写成产品限制。

### 5.3 手机实时录音

- `AudioRecord`、WAV journal 和本机 meeting identity 先成功，再异步 `attachDeviceV2`。
- WSS 连接前缓存有界 PCM；附着时验证 meeting/session/storage scope，再有序补发。
- 停止以本机文件成功为准；final drain 超时进入后台补转写，不返回录音失败。
- 前台 service/media session 只在真实录音或播放时激活，结束后必须释放通知状态。

### 5.4 外接硬件

- 协议 owner：`contracts/hardware/laoji-hardware-control-v1.schema.json` 与 `docs/hardware/LAOJI-HARDWARE-PROTOCOL-V1.md`。
- native `HardwareRuntime` 独占连接、session、sequence、CRC、设备 manifest、临时网络、pending file 和 ack。
- USB/BLE 解码同一 LJHW frame；Wi-Fi 只接收控制面选中的不可变 generation，并支持 Range。
- 设备 `.part -> WAV`、手机 `.part -> pending WAV` 各自原子提交；generation、长度、WAV 和 SHA 全通过前禁止 ack。
- ack 只更新设备确认位；设备删除必须来自用户显式操作。pending media 继续调用现有 importer。
- bridge/Kotlin/provider 原文只能进脱敏日志，用户错误通过单一映射层输出中文动作。

## 6. 上传与转写服务

### 6.1 Device v2 主合同

主路径位于 `/api/device/v2`：

- `/bootstrap/*`、`/auth/*`：设备 challenge、短 token、key rotation；
- `/capabilities`、`/ready`：协议和依赖 readiness；
- `PUT /meetings/{binding_id}`、`GET /bindings/cursor`：binding generation；
- `/uploads`：R2 session、part、complete、cancel；
- `/tasks`、`/tasks/{id}`：持久 task/attempt/result；
- `/tasks/{id}/transcript-events`：稳定事件重放/ack；
- `/source-streams`：整理和问答的不可变来源；
- `/meetings/{binding_id}/questions-v2`：Q2。

当前 v1 调用不能通过再签发长期 v1 secret 来迁移。v2 bootstrap 应原子查找或建立同一 device/epoch 对应的兼容整数 `principal_id` 投影；v1 依赖在验证 `dv2` 短 token 后只复用该投影访问既有表。既有 v1 principal/epoch 必须原样保留，revoked、closed 或归属冲突一律 fail closed。手机 HTTP、旧日程 WSS 和地址调用逐项改发 v2 token 与 device/epoch header 后，才能删除 APK admission token、`/device/v1/register`、dv1 bearer 和服务端 shared-key fallback。summary 新协议只进入 device-v2 source stream/task，不再扩展 v1。

### 6.2 R2

- 预签名凭据短时、binding/generation scoped。
- multipart 每 part 记录 ETag；complete 可在客户端崩溃后 probe 并恢复。
- 服务端以流式 hash/size 验证，完成 verified asset 与 transcription task 的原子登记。
- 取消、过期、终态和永久删除均创建 cleanup obligation；后台重试直到确认对象不存在。

### 6.3 ASR

8030 保留兼容 `/asr`，主批量协议为 `/v2/asr/batch`：

- 每 item 有稳定 ID、PCM metadata、源时间范围、优先级和 deadline；
- 响应带 text、language、model revision、queue/inference timing、content outcome；
- 实时会议 > 日程短语音 > 后台导入；microbatch 只合并等待窗口内兼容请求；
- 文字事件逐批落库，不能等整文件完成才一次返回；
- VAD/CAM++ 可流水并行，speaker overlay 在 text stable 后独立发布。

## 7. 整理实现

### 7.1 Source stream

客户端提交 manifest，再分组上传 transcript、当前笔记和明确授权附件的不可变 bundle。每项包含
source ID、revision、hash、位置/时间边界；服务端验证后 commit source fingerprint。正文使用加密临时载荷，成功、永久失败或 TTL 到期后清理。

### 7.2 生成协议

- Pydantic schema 是服务端输出权威；Provider 只接收 schema 与通用 prompt。
- prompt 不含评测样本、会议标题、人物、固定话术或业务关键词补丁。
- 短会一次完整输入；长会按连续时间与语义切章，保留首尾、纠正/否定、时间数字、负责人和跨主题连接段。
- 每章生成同一事实协议；代码按 source hash、certainty、relation 和语义相似度确定性合并。
- 正常每章一次生成；只有整体结构不合法允许一次 repair。引用或字段无效时确定性删减，不再调用模型润色。

### 7.3 本机投影

- active UI 只使用 unified adaptive composer。
- 历史数据行可保留 `general/one_on_one/project_sync/interview` 字段；当前运行时不读取、不展示、不转换，也不用它创建网络任务。
- 图表白名单：timeline、flow、comparison、stat；没有显式证据即退化为段落/列表。
- `action_candidates` 与 `action_items` 分表；采用候选是显式本机操作。
- 刷新期间保留上一份可用结果；source fingerprint 未变时不显示“可更新”。

## 8. Q2 实现

1. 构造只包含当前 binding 的 source stream。
2. 本地 embedding 检索问题相关 segment，保留相邻上下文和来源版本。
3. 一次 attributed reader 输出答案与 source IDs。
4. 服务器校验引用归属、原文定位和问题相关性；越界引用使结果失败关闭。
5. 结果与 task revision 原子提交，本机按 request ID 去重。

笔记默认可作为来源；附件必须本次授权。旧 Q0、多轮 verifier/editor 和样本答案不得回到 active provider。

## 9. 服务端实现

### 9.1 `laoji-api`

- FastAPI 只暴露公网 API 的业务入口；内部 provider 地址来自部署环境。
- SQLite task store 开启 WAL/busy timeout/integrity check；进程重启扫描可恢复 lease。
- 所有 LLM 调用经过 `app/services/llm_provider.py`；选择 Ollama 或 DashScope 是部署级显式配置。
- `ffmpeg`、VAD、CAM++ 是 task 内部步骤，不成为常驻业务服务。
- `/api/ready` 报告 ASR、生成、embedding、worker、队列、磁盘和最近真实推理；不返回密钥、正文、文件名或坐标。

### 9.2 `laoji-asr`

- 启动固定 Qwen3-ASR model revision；未固定或未预热时 fail closed。
- 队列、batch、音频时长/字节和并发均有上限；过载返回可重试错误，不在 API 进程加载第二个模型。

### 9.3 Ollama/provider

- 生产保留一个生成模型和 `qwen3-embedding:0.6b`。
- `NUM_PARALLEL=1`，交互请求优先；长整理在章边界让出队列。
- 云端 provider 只能显式切换，结果仍走同一 schema/grounding；本地失败不自动外传。

## 10. 状态、错误和隐私

- durable stage：`queued/preparing/generating/verifying/persisting/success/failure`；媒体和 transcript 可有领域子阶段，但 UI 映射到少量可理解状态。
- 列表与详情只读同一 operation revision。页面 state 不自行推断“正在处理”。
- 日志记录 ID hash、revision、stage、duration、bytes、provider/model revision 和错误码；禁止正文、引用、坐标、密钥、文件名和人物信息。
- 用户错误由领域错误码映射为中文结果与下一动作；异常堆栈、bridge 文本和内部函数名不得展示。
- 低磁盘先停止新云端接纳并保留本机任务，不自动删除正常录音。

## 11. 发布与验收

### 11.1 发布不变量

1. `app.config.js`、`android/app/build.gradle` 和 APK metadata 的 versionName/versionCode 一致。
2. 构建按目标 ABI：真机 arm64、专用 `emulator-5562` x86_64；release 不携带无关 ABI、样本媒体、日志、备份或测试模型。
3. `tools/app-update/latest.json` 的 URL、hash、size、版本与公开 APK 一致。
4. 发布说明为简短功能变化，不暴露内部修复过程。

### 11.2 最低真实验收

| 领域 | 必须验证 |
| --- | --- |
| 启动/导航 | 冷启动、后台恢复、主题切换、页面重进无白屏/错位/闪变 |
| 日程 | 手动/语音、复杂解析、补充、增删改查、搜索、视图和提醒 |
| 媒体 | 手机录音、音频/视频导入、多任务、重启恢复、永久删除 |
| 转写 | stable 连续出现、final 唯一、no_speech、speaker 异步、服务重启 |
| 整理 | 短会/长会、笔记/附件、来源引用、自适应板块、无模板网络请求 |
| 问答 | 常见/追问/无答案/数字时间、引用归属和相关性 |
| 硬件 | USB/BLE live、断线、页面重建、pending ack、无静默换源 |
| 服务 | readiness、队列优先级、磁盘、R2 cleanup、provider revision、日志脱敏 |

性能至少记录触发到首个可用结果、完整完成、RTF/吞吐、p50/p95 和资源峰值。单元测试、mock、截图或一次成功不替代完整真实流程。

## 12. 遗留删除规则

删除旧代码/表/接口前形成机器可核对清单：

1. 当前构建无 import、反射、路由、feature flag、配置、原生 manifest 或脚本引用；
2. 当前数据库无只被旧 reader 理解的数据，或已完成可恢复迁移；
3. 服务端无活跃 task/lease/object/open file；
4. 当前发布已走唯一 writer，回滚资产在 Git/服务器归档可恢复；
5. 删除后通过类型检查、原生编译、服务测试和真实流程。

不确定但有追溯价值的内容移到仓库外的校验归档；确定可由 Git/构建系统恢复的 APK、cache、venv、候选源码副本和 Stage 证据直接清理。不得在活跃树继续创建 `backup-*`、第二工作区副本或长期 candidate 链。
