# 老记去账号化与本机主数据改造指示

> 本文件是《老记服务最紧凑生产架构计划》之后的执行级补充。目标是把老记收敛为“本机保存用户事实，服务器只做短时计算和可选生成结果留存”的单设备应用。日期不作为里程碑；每个阶段以源码、接口和模拟器证据验收。

## 2026-08-09 当前运行时复核增量

- 当前工作区 release APK 实际文件为 `android/app/build/outputs/apk/release/app-release.apk`，`versionCode=106`，SHA-256 为 `86e9112bd978ccbaaa3a0d4359aa45f54135804c22e978a30b75e9701ec02a24`；源码静态门禁、APK 入口门禁和 TypeScript 均通过。本轮没有操作 `emulator-5560`；`emulator-5562` 当前离线，未把模拟器安装状态当作本轮证据，真机验收继续按约定跳过。
- 通过当前 release 中的临时设备注册引导配置，对 `https://laoji.cloud` 做了新的临时设备闭环：注册 `201`、能力 `200`、日程解析 `200`、会议绑定 `201`、资产注册、两段分片上传 `200`、分片合并 `200`、转写提交 `202`、任务 `completed`，随后整理任务 `success`，返回 `general@2`、结构化 schema `2` 和 Markdown；epoch 清理 `200`，所有临时设备内容随 epoch 删除。
- 发现并修复生产源码漂移：服务器设备核心三个文件仍与工作区一致，但 `summary_tasks.py` 缺少本轮已验证的“负责人待定具体候选保留”和“决定折叠到概述时携带真实引用”两处修复。已在服务器建立 `/home/zhong/laoji-service-platform/migration-baselines/compact-summary-candidate-fix-20260809-2327/` 回滚备份，替换后的服务器 SHA-256 为 `50fc259088eb074ed7b3943958dcdcfe4b2accaf6f7b4c9525ec6faaa3dbbcb4`。
- `laoji-api` 已由现有 systemd 恢复并重新加载该源码；API、ASR、Ollama、Cloudflare Tunnel 均为 `active`，公网 `/api/ready` 返回 `ready=true`，任务队列和 LLM 队列均为 `0`，三套 SQLite 完整性/WAL/外键状态仍正常。

## 当前执行对齐（2026-08-09）

- 本轮收尾审计确认四个 systemd 单元仍为 `active/enabled`，公网/loopback `/api/ready` 均为 `ready=true`，业务端口仅监听回环；旧端口运行时没有进程或活动部署引用。已删除服务器上 5 个过期手工运行 PID 文件及两个旧端口日志，保留现行模型、精简 venv、数据库、Tunnel 凭据和历史迁移证据。
- 设备源文件的失败留存边界已补齐：设备资产无任务，或最新转写任务超过 24 小时进入终态后由 retention loop 删除源文件并清空数据库路径；账号资产、近期失败和 queued/running 后续任务不受影响；隔离回归与生产现场证据见 [`docs/device-source-failure-retention-audit-20260809.md`](device-source-failure-retention-audit-20260809.md)。
- `app.config.js` 现会在非开发构建阶段拒绝缺少设备注册引导密钥；使用受保护临时注入并以 `APP_ENV=production-rehearsal` 重建 release `1.0.6`，APK SHA-256 为 `86e9112bd978ccbaaa3a0d4359aa45f54135804c22e978a30b75e9701ec02a24`，APK 内引导密钥长度为 64。当前未操作 `emulator-5560`，老记专用 `emulator-5562` 不在线，真机验收仍按约定跳过。
- 本地冻结检查点为 commit `7ad25e4`、tag `laoji-device-primary-freeze-20260809`；未推送远端，工作区中未纳入本次提交的历史质量语料和审计杂项保持原样。

- 当前权威 release 为 `1.0.6`/`versionCode=106`，SHA-256 `f226843a3a53d59704dd2f1f01e9e395118f1f80921447fe3b2e57d00dd3fef4`，已覆盖安装于 `emulator-5562`。构建时临时注入有效设备注册引导密钥；启动现场出现 `device_service_ready`，guest 兼容日志已明确标记 `scope_kind=device-local` 与 `network_path=device-v1/none`。详见 [`docs/device-scope-runtime-audit-20260809.md`](device-scope-runtime-audit-20260809.md)。
- 当前有效公网混合负载证据为 5 路实时设备 WSS + 2 路后台资产上传：实时段结束到最终文字 p95 `1846.47 ms`，低于 2 秒门槛；此前 `3.61 s`、`2.44 s` 和 `903.21 ms` 均为旧夹具或旧路径的历史对照，不再作为当前门禁结论。
- 历史合同针对性集合（设备合同、安全、地址进程内缓存、统一日程 ASR、LLM、检索、存储准入）已在临时测试依赖和隔离 SQLite 中 `25 passed`；完整历史 pytest 仍未全量执行。
- 去账号化、本机日程/会议主数据、设备鉴权、分片上传、断点恢复、生成结果留存开关、实时网络优先级和设备问答/整理旧路由隔离已进入 release `1.0.6`；当前 APK SHA-256 为 `608a8062afc12e6b25eae516b1ec058206936b12521efa20bd4cc7de6583b0e6`，已安装于 `emulator-5562`。真机验收按要求跳过。
- 本轮继续为设备就绪证明增加 60 秒缓存/并发去重，并为设备转写轮询增加 404/网络失败退避；最终 release `1.0.6` SHA-256 为 `9801f2baf787540477fcb971768975a0be47aac8441d4fcc09fe96c766fd2a6d`，已覆盖安装于 `emulator-5562`。真机验收仍按要求跳过。
- 本轮继续收紧兼容边界：旧账号日程、会议、录音、文字记录和整理 API 在缺少账号令牌时统一在网络请求前 fail-closed；Android guest 路径新增静态门禁，禁止重新引入旧 guest session、旧 guest-summary 或未鉴权兼容调用。设备录音待上传在 guest 模式下也可由详情页手动重试，仍只走设备/epoch 上传器；后台补全器改按本机 SQLite 转写 revision 判断草稿/ready，不再因 `hasTranscript=true` 跳过实时草稿的最终拉取；上传返回的设备转写任务 ID 另存为不含正文的本机任务注册表，可区分 queued/running、completed 和 no_speech/failed，删除会议时一并清理。最新 release `1.0.6` SHA-256 为 `14d5ac7a44c1aed06eb81c85b49ba0be506590defbae65256227c8e01a790937`，已覆盖安装于 `emulator-5562`。
- 复杂日程文本、追问和短音频解析已不再从移动端调用旧 `/api/laoji/*` 计算接口，统一走设备 `/api/device/v1/schedule/*`；服务端 clarify 路由已部署并完成临时设备真实探针。
- Android 构建、TypeScript、diff 和 compact source 检查均通过。服务端四个 systemd 单元 active/enabled，公网 `/api/ready` ready，队列 0；历史旧服务字符串仅保留在审计文档/兼容测试中，当前生产进程和模型不再调用旧链路。
- 设备问答和整理对旧 guest 兼容接口已 fail-closed：设备绑定不存在、携带本机笔记或旧附件/续写请求时不上传本机全文，直接返回中文不可用状态；账号兼容代码仍保留但不再是本机主链路。
- 录音上传成功后的转写任务提示现在是 best-effort 本机元数据：AsyncStorage 临时不可用不会把已完成上传改判为失败；设备服务返回 `job_id`、`task_id` 或 `transcription_task_id` 时都能保留轮询标识。最新 release 仍为 `1.0.6`，仅覆盖安装于 `emulator-5562`，SHA-256 为 `814ed80ac55c698b5d1bce0a133d81e6f68e5969aa37e31e8baf512c6526ca34`。
- 发布复核发现上一包的 `deviceBootstrapKey` 为空，新安装设备会被服务器拒绝注册；已从服务器运行进程受保护环境临时注入引导密钥重建 release，APK 内仅保留密钥值、不写入源码或工作区。最新 `1.0.6` SHA-256 为 `3faf199d8db165d75a7c35d326c1b10eeeadd4850db91e3f7491a4d46368efab`，覆盖安装 `emulator-5562` 后真实出现 `device_service_ready`。
- 移动端实时网络优先租约与服务端统一调度已在有效公网混合负载中达到 p95 `1846.47 ms`；该结果不等于真机性能验收，真机仍按用户要求跳过。
- 其余未完成边界：会议问答专题、真实声纹纵向质量、真机验收和完整历史 pytest 旧断言修订。它们不阻塞当前单设备主数据闭环，但阻止把整个改造计划标记为“全部完成”。

## 当前实现状态（2026-08-09）

- 移动端本机日程/会议主数据、设备身份、质量改进开关和设置入口已落地；release 1.0.6 已在 `emulator-5562` 验收离线日程 CRUD 与设备注册。
- 服务端设备整理结果已切换到持久任务结果而非 `FinalSummary`：关闭开关的正文带 24 小时 TTL，开启开关才长期保留匿名结果；设备问答默认不写账号兼容问答表，开启后写入带 30 天 TTL 的匿名候选。
- 本机删除会议后会立即写入只含会议 UUID 的设备删除 outbox；删除不等待网络，联网/回到前台时自动幂等调用设备删除接口，失败按退避重试，不把远端失败投影成“同步冲突”。
- 本机删除讲话人时姓名立即从本机映射中移除，匿名声纹 ID 进入独立删除 outbox；列表先过滤待删除项，服务端删除在启动/前台时幂等重试。
- 设备删除接口现在会在删除服务端会议行前回收该设备会议的音频资产路径；部署前源码已备份，重启后 `/api/ready` 和空队列保持正常。
- 实时链路已切换为设备凭据：会议开始前先建立设备会议绑定，`/ws/meeting/{meeting_id}/qwen` 和日程语音 `/ws/laoji/schedule/{session_id}/qwen` 使用设备 Bearer 与 `X-Laoji-Data-Epoch`，移动端不再创建旧 guest session。
- 设备资产分片上传已形成服务端闭环：客户端在隧道环境对中等 WAV 提前使用 512 KiB 二进制分片，服务端按序校验、合并和 SHA-256 原子提交；模拟器真实收到 6 个分片、complete 200、转写提交 202。
- 任务结果清理已接入既有 retention loop；`summary_tasks_v2.request_json` 仍只保存 worker 引用参数，不保存完整转写正文。
- 日程语音设备 WebSocket 已用临时设备真实直连通过；三个老记 systemd 单元均已做一次有序重启，ASR 重启后用真实 16 kHz WAV 推理通过，API/LLM/任务 worker 恢复正常。
- 地址反向解析已补齐设备 Bearer + active epoch 鉴权，仍保留账号和游客/IP 限流；重启 API 后用临时设备真实调用高德 Web 服务成功，临时 epoch 已清理。
- 旧 8002、18035、21436、VibeVoice、WhisperLiveKit 监听/进程/compact 运行时引用审计无命中；模型目录只保留 Qwen3-ASR-1.7B、qwen3.5:9b 和 qwen3-embedding:0.6b。没有直接删除其他用户目录或小型历史说明备份。
- WAV、M4A、MP3、MP4、WebM 的 30 秒真实公网分片上传/转写矩阵均已通过；两条不同会议的同时上传/转写也已通过且没有资产覆盖；真实 61 分钟音频覆盖率约 100.02%；上传中途重启 API 后续传、校验和转写也已通过。有效公网实时+后台并发 p95 也已通过；尚未完成的边界为真机验收、真实声纹纵向样本、问答专题质量和完整历史 pytest 的旧断言更新。
- 设备域删除保护已修正为按 `data_epoch_id` 区分设备与账号；鉴权热路径只读，分片写入/合并不占用 uvicorn 事件循环；删除会议和关闭 epoch 显式清理旧的非级联子行。真实回归证明设备绑定、转写、删除和 epoch 清理可重复执行，SQLite 外键检查为 0。
- 新增移动端 `deviceNetworkPriority`：实时录音持有网络优先租约，设备后台上传在注册、每个分片和 complete 前等待租约释放；录音停止或失败时幂等释放，后台 durable upload 自动续跑。它不删除或覆盖本机音频，只改变传输顺序。

## 1. 已锁定产品决策

- 日程、会议主体、标题、地点、笔记、附件、提醒、用户编辑内容：手机本机是唯一事实源。
- 原始音频、视频、声纹采样：仅为完成计算临时上传。服务端不得把它们作为长期用户资料；任务结束、失败终态或 TTL 到期后删除。
- 转写、整理、候选待办、问答答案：可在用户开启“帮助改进生成质量”后保留匿名生成结果；默认关闭。结果必须带 `device_id`、`data_epoch_id`、模型 revision、输入摘要哈希和创建时间，不带账号、姓名、原文日志或坐标。
- 删除账号、登录、注册、跨设备同步、游客迁移、公开会议链接：产品上移除，不在首屏或设置中提供入口。旧接口只保留服务器兼容层，不由移动端调用。
- 每次安装生成设备 UUID、设备密钥和 `data_epoch_id`。卸载重装不恢复旧设备数据；清除数据或用户主动“清空本机数据”生成新 epoch。服务端用设备墓碑拒绝旧 epoch 的迟到请求。
- 讲话人姓名、姓名编辑和原始声纹样本只存在手机本地。服务端最多接收匿名 profile ID、匿名 embedding/音频临时片段、同意版本和模型 revision；生成的转写只回传匿名标签或本机映射后的名称。
- 讲话人列表的匿名 profile 元数据也保存在本机缓存；在线响应只用于刷新，网络失败时回退本机列表，待删除的匿名 ID 在本机先隐藏。
- 会议删除是本机优先：先进入 30 天回收站并从列表隐藏，再写入持久删除 outbox；联网后幂等通知服务端清理生成结果和临时资产。失败不阻塞本机删除，也不永久显示“同步冲突”。
- 地址反向解析只作为服务，不改变本机事件事实。客户端无网络时保留系统地址或经纬度；服务端地址缓存为进程内短 TTL，不写入用户数据库。

## 2. 移动端架构

### 2.1 启动和数据层

`AuthStore` 保留兼容类型名，但运行时永远是 `mode=guest`、`session=null`、`accessToken=null`。`RootNavigator` 直接进入日程/会议主界面。启动路径不得等待网络、账号恢复或迁移；本机 SQLite 先 hydrate，再异步启动设备服务协调器。

日程 CRUD 必须走 `localScheduleRepository` 和 SQLite WAL。`EventsStore` 的 guest 分支是唯一可达分支：加载、冲突检测、重复事件展开、提醒调度、回收站均在本机完成；认证分支不得被新的 UI 调用。任何远程日程 CRUD、远程月历刷新和账号缓存 Provider 都属于兼容死代码，逐步删除或通过静态门禁禁止。

会议主体和用户编辑内容同理：会议列表、标题、笔记、附件、标记、代办确认状态、顺序和回收站先写本机仓库。设备服务只接收 `meeting_id`、`asset_id`、epoch 和临时上传句柄，不返回需要云端同步的用户对象。

### 2.2 设备身份

SecureStore 保存：

```text
device_id: UUID
device_secret: 32 bytes random
data_epoch_id: UUID
```

请求使用 `Authorization: Bearer dv1.<device_id>.<device_secret>`，并单独携带 `X-Laoji-Data-Epoch: <epoch_id>`。服务端只接受已注册设备和 active epoch；HTTP/WebSocket 均拒绝缺少数据域、错误凭据和已关闭 epoch。密钥不打印、不进入错误文本、不上传日志，也不放入 URL/query。

### 2.3 生成质量开关

在设置中增加本机开关“帮助改进生成质量”，默认关闭，并说明“开启后会匿名保留整理/问答结果及质量反馈，不会上传姓名、原始录音或本机日程”。开关值保存在本机 SecureStore/SQLite。设备整理、问答、日程解析请求携带 `retain_generated_result: boolean`；关闭时服务端只保留任务状态、输入摘要哈希和短期错误信息，终态正文与引用在 TTL 后删除。

### 2.4 讲话人边界

本机表：`speaker_id -> display_name -> local_embedding_ref -> consent_version`。注册和改名先写本机；上传请求只发稳定匿名 `speaker_id`、同意版本和用于计算的临时音频/embedding。服务端响应 `speaker_id`、质量、模型 revision，不返回或持久化姓名。会议转写收到 `speaker_id` 后由本机映射为显示名称；找不到映射时显示“讲话人 1/未知讲话人”。删除本机讲话人同时写设备删除 outbox，服务端删除匿名 profile 和 embedding。

### 2.5 删除与恢复

删除操作使用本机 `deleted_at`、`purge_at=deleted_at+30d` 和 `delete_outbox` 三个字段。回收站页面只操作本机；恢复清除本机删除标记并取消尚未发送的删除 outbox。永久清理先尝试服务端幂等删除，再删除本机原始音频；服务不可用也不得把已删除记录重新显示为冲突。

## 3. 服务端接口与生命周期

### 3.0 设备请求并发与实时优先级

`device_identity.authenticate` 只做控制库读取，不在每次请求更新 `last_seen_at`；注册和显式生命周期操作仍更新时间。`_connect` 不在热路径重复执行 `PRAGMA journal_mode=WAL`。设备上传的分片临时文件写入及 complete 合并/哈希通过 `asyncio.to_thread` 执行，避免单 worker API 的事件循环被磁盘 I/O 卡住。

移动端通过 `src/services/deviceNetworkPriority.ts` 维护进程内实时租约。`startRealtimeAsr` 建立租约，在成功停止、失败事件或启动异常时幂等释放；`deviceApi` 和 `deviceMeetingService` 在设备资产注册、分片上传、complete 及转写提交前等待实时租约。实时会话期间不擅自取消后台上传，已完成的分片保持有效，录音结束后从原上传 ID 继续。

loopback/SSH 转发的早期 p95 `903 ms` 和关闭本机代理直连公网的旧 p95 `3.61 s` 仅作历史对照；当前有效公网 WAV 混合负载 p95 为 `1846.47 ms`，已通过计划的 2 秒门槛。

### 3.1 设备 API

继续使用 `POST /api/device/v1/register`、`/capabilities`、会议/资产/分片上传、转写、整理和问答接口。所有接口要求 device 身份、epoch、`Idempotency-Key`。服务端对象必须带 `device_id` 和 `data_epoch_id`，查询不得跨设备或跨 epoch。

实时语音使用同一设备身份，不创建临时 guest session：会议建立 `/api/device/v1/meetings/{meeting_id}` 绑定后连接 `/ws/meeting/{meeting_id}/qwen`；日程语音使用短期随机 session ID 连接 `/ws/laoji/schedule/{session_id}/qwen`，该会话不落库。服务端会议 WebSocket 会校验会议所属 principal/epoch，日程 WebSocket 只校验设备身份；声纹加载按设备 principal + epoch 隔离。

分片合同为 `PUT /api/device/v1/assets/{asset_id}/chunks/{index}`（二进制正文、上传 ID、偏移、总大小、总片数头）和 `POST .../chunks/complete`（按序合并、大小/SHA-256 校验、资产 revision 幂等提交）。客户端默认 512 KiB，服务端最大合同仍为 4 MiB；分片目录在任务结束后清除。

新增/统一：

- `POST /api/device/v1/jobs`：创建 `device_service_jobs`，记录类型、阶段、状态、租约、重试、输入摘要哈希和临时输入引用。
- `GET /api/device/v1/jobs/{id}`：只返回当前设备任务状态和结果引用；关闭保留开关时不返回已删除正文。
- `DELETE /api/device/v1/data/{meeting_id}`：写设备域删除墓碑，幂等清理资产、临时输入和生成结果。
- `POST /api/location/reverse`：高德调用只在请求期间使用；成功响应进入进程内 TTL 缓存。坐标、原始高德响应和 key 不写日志或数据库。

### 3.2 临时输入和任务持久化

原始音频/视频按 `device_id/epoch/asset_id` 隔离，分片 complete 后校验 SHA-256。ASR、VAD、CAM++ 和 LLM worker 通过引用读取，不生成整份临时 WAV。每阶段写检查点，已有可用转写/整理结果不可被失败任务降级。`summary_tasks_v2.request_json` 不得保存完整转写或音频正文，只保存 `input_ref`、摘要哈希、截断统计和 schema version；迁移期旧正文需一次性清理。

`device_service_jobs` 是 API 重启后的唯一恢复依据。worker 租约超时后重新入队，完成写入必须带条件更新和幂等键；客户端重复轮询不能产生第二份结果。

### 3.3 保留策略

- 原始音频/视频、临时 PCM、声纹样本：任务成功后立即删除；失败终态最长 24 小时；无心跳的 upload 句柄最长 6 小时。
- 关闭质量改进时的整理/问答正文：响应交付后最多保留 24 小时用于重试，之后删除；开启时只保留匿名生成结果和模型元数据。
- 删除墓碑：至少保留 30 天，防止旧客户端迟到请求复活数据。
- 正常本机录音不因服务器容量自动删除。磁盘低于 40 GiB 告警，低于 20 GiB 停止新云端上传，保留本机待上传任务。

### 3.4 紧凑运行拓扑

公网仅 Cloudflare Tunnel `laoji.cloud`，内部 `18020` API、`8030` ASR、`21434` Ollama 均 loopback。Ollama 只常驻 `qwen3.5:9b` 和 0.6B embedding，交互请求优先，后台整理可暂停/恢复。GPU1、PCB、其他用户服务不触碰。

## 4. 实施顺序

1. 保存当前 APK、数据库完整性、音频清单、服务 cwd/模型哈希和本机 Git 检查点；不自动提交/推送。
2. 保持设备上传/转写/整理闭环不变，先移除移动端外层账号、同步和游客迁移 Provider，确认本机日程/会议启动不等待网络。
   - 实时录音和日程语音已经完成旧 guest session 到设备 WebSocket 凭据的切换；模拟器会议录音已真实连通 Qwen。
3. 将设置头像/“我”语义统一为“设置”，清理登录、账号、用户协议重复入口；加入质量改进开关并把值贯穿设备生成请求。
4. 把讲话人姓名和改名切到本机映射，补充匿名 profile 合同和删除 outbox。
5. 服务端实现任务统一表、输入引用/TTL、地址内存缓存和设备域删除墓碑；旧 API 仅兼容，不从移动端调用。
6. 通过静态扫描禁止业务代码访问旧账号 Base URL、11434/21435/21436、远程日程 CRUD 和姓名上传；运行 TypeScript、合同检查和 release 构建。
7. 在 `emulator-5562` 安装候选包，断网验证首屏、本机日程 CRUD、会议列表和回收站；恢复网络验证设备注册、样本上传、转写和整理恢复。`emulator-5560` 不操作。
8. 最后做服务端 pytest/重启恢复/多格式矩阵和旧重资产删除审计。未执行的项目保持“未验收”，不以构建成功替代真实服务验收。

## 5. 验收门槛

- 冷启动离线可进入主界面，本机日程增删改查、提醒和回收站不请求服务器。
- 设备注册和服务请求不携带账号 token；每个请求有 device/epoch/idempotency 元数据。
- 姓名、原始录音和本机日程不会出现在服务器日志、任务正文或地址缓存中。
- 同一任务重复上传、轮询、API 重启只产生一份最终转写/整理结果；已有可用结果不降级。
- 关闭质量改进后，任务终态正文按 TTL 清理；开启后只保留匿名生成结果和模型 revision。
- `https://laoji.cloud/api/ready` 报告 API、ASR、生成/embedding、VAD/CAM++、任务 worker、磁盘和队列状态；公网不能直接访问 18020/8030/21434。
- 任何未完成的真实格式、长音频、并发、重启、说话人和问答测试在验收记录中明确列为未通过/延期。
