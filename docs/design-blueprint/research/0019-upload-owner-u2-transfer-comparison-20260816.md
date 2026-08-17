# 研究 0019：上传 owner 证伪后的 U2 传输执行层比较

## 状态

- status: `research candidate; not adopted`
- date: `2026-08-16 Asia/Shanghai`
- scope: 在不新增业务状态 owner 的前提下重做录音传输执行层
- production mutation: `none`

这份研究不是对 0014/0015 的第三轮修补。两版候选已经证明 U1 的抽象状态机不能直接接入
老记真实代码；本文件只定义下一次架构比较和进入候选前必须证明的边界。

## 事实基础

现场源码显示，上传结果同时由以下路径表达：

1. 正式 SQLite 的 `recording_assets`、`processing_stages` 和转写任务表；
2. `@laoji:pendingMeetingAudioUploads:v1/v2/v3`、进程内 retry/backoff 和会议字段镜像；
3. Android `WorkManager` 的 unique work、`workId` 和输出数据；
4. 服务端 `meeting_recording_assets_v2`、`meeting_recording_asset_operations_v2`、R2
   session 和会议级状态。

当前 guest 主链路还会在 JavaScript 中直接执行 R2 分片上传：每个分片先以 Base64 读入
JS，再落到临时文件，最多两个并行分片；WorkManager 只覆盖部分 authenticated 路径。
因此“R2 已启用”不等于后台执行、状态所有权或大文件内存路径已经收敛。

0014/0015 的独立审计证实：抽象候选不能替代正式表；迟到 seal 可以回退已完成状态；删除
会清除最后的 fence；迁移会静默覆盖跨会议身份；完整 `read()` 不适合 1 GiB；sealed
原音频没有闭合 TTL/删除协议。完整证据见 candidate 0029/0030。

## 外部研究（仅作候选依据）

研究日期为 2026-08-16，未上传老记私人内容。

- Android 官方 WorkManager 文档说明 unique work 用 `KEEP` 防止重复入队，并可按 unique
  name 使用 `getWorkInfosForUniqueWork` 查询；不能把调用方刚构造的 `WorkRequest.id`
  当作被 KEEP 的实际执行 ID。见
  <https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work>。
- Android 14 起官方提供 User-Initiated Data Transfer（UIDT）JobScheduler 路径，用于用户
  明确触发、需要立即开始且可能长时间运行的数据传输，并要求持续通知；它不是所有后台
  上传的通用替代。见 <https://developer.android.com/develop/background-work/background-tasks/uidt>。
- Cloudflare R2 官方 S3 兼容文档确认支持 multipart、预签名 URL 和条件对象操作；同一对象
  key 的并发写入仍需由应用提供唯一 staging key/CAS，不应把 R2 的强一致性误当成业务
  exactly-once。见 <https://developers.cloudflare.com/r2/api/s3/api/> 和
  <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>。
- tus 1.0 官方协议提供 `HEAD` offset 恢复、checksum、expiration、termination 和可选
  concatenation；它解决协议层断点续传，不自动解决老记的 device epoch、业务删除、原文
  临时保留或 domain CAS。见 <https://tus.io/protocols/resumable-upload>。

这些资料说明“可以做”，不证明任何方案在老记的 Android、R2、Cloudflare Tunnel 和固定
服务器资源上已经更快或更可靠。

## 三条可行路线

| 路线 | 执行形态 | 业务 owner | 传输/资源特征 | 结论 |
| --- | --- | --- | --- | --- |
| U2-A 原生 R2 executor | Android Worker 从本机文件流式读取，直接 PUT/multipart 到现有 R2；服务端只登记、校验、接管 | 现有 SQLite 资产 + upload generation | 去掉 JS Base64 和每片临时副本；可利用系统后台约束；不增加常驻服务 | **首选隔离候选** |
| U2-B 精简自有 transfer session | 保留现有 `/chunks` 或 device R2 API，改为 native streaming、按 operation 唯一 key | 同上 | 可在无 R2 时工作，但经过 API 隧道；需要维护 chunk 状态和超时回收 | 仅作兼容/故障降级候选，不作为默认 |
| U2-C tus 1.0 服务 | 新增 tus endpoint/daemon，客户端以 offset 续传，可选并行拼接 | 必须另定义 tus session owner | 协议成熟，但新增常驻服务、持久卷、清理任务和鉴权适配；并行拼接会增加对象生命周期 | 当前资源约束下不选 |

保留 U0（当前 JS/R2 + registry）只用于回滚读取和历史任务 drain，不再接受新写入。继续
维护 U0 不能解决 WorkManager KEEP 返回错误 ID、Base64 双份 I/O 或多 owner 反向重建。

## U2-A 目标合同

### 1. 领域 owner

不建立第二套 `server_assets` 或通用 task ledger。扩展正式 SQLite 资产域：

```text
recording_assets
  source_revision, source_digest, data_epoch_id, tombstone_at
  active_upload_generation

recording_asset_upload_generations
  asset_id, generation, operation_id, source_revision, source_digest
  queued | running | retry_wait | blocked | uploaded | superseded | cancelled
  attempt
  remote_asset_id, remote_revision, error_code
```

`recording_asset_upload_generations` 是每个资产的历史和 fencing 记录，不能被会议级
`processing_stages.upload` 或 UI 镜像反向写入。会议级 upload stage 只作为同一事务内的
派生投影；如果一次会议有多个资产，投影按资产状态优先级计算，不能覆盖资产事实。

reserve generation、删除 tombstone、恢复、重试和 active pointer 必须在同一个 SQLite
事务中完成。`uploaded/superseded/cancelled` 是不可回退终态；`blocked` 的用户重试创建更高
generation，不能原地复活。`unknown/conflict` 仅是迁移/外部观察分类，不是 generation
状态，不得驱动 executor。现有 `sync_outbox` 可承载网络 mutation，但不能复制 upload
stage；如需删除 outbox，必须与资产 generation 同库并有 epoch 条件。调度重试由 Android
executor 拥有，domain 不保存 `executor_enqueued` 或用 `next_retry_at` 成为第二调度 owner。

### 2. operation 和 WorkManager 边界

- 稳定执行名：`laoji-upload:<scope>:<data_epoch>:<asset_id>:<generation>`；服务端幂等根为
  `recording-asset:<scope>:<data_epoch>:<asset_id>:<role>:<origin>:<source_revision>:<source_digest>`，
  跨 credential generation 不改变。digest 只是内容校验，不能单独合并不同业务资产。
  这里的 epoch 不能省略：真实移动端游客 `scope_key` 长期为 `guest`，epoch 是独立设备
  身份；若只使用 scope/asset/generation，更换 epoch 后会与旧 WorkManager unique work
  碰撞。meeting ID 不进入稳定来源根，会议归属变化必须另作显式 CAS。
- JS 只调用 `ensureUpload(operationId)`、`inspectUpload(operationId)`、
  `cancelUpload(operationId)`；不保存 `workId`，也不把 `WorkInfo` 当业务真相。
- Android 以 `enqueueUniqueWork(name, KEEP, request)` 执行；enqueue 后按 unique name
  查询实际 WorkInfo。若 WorkManager 已 prune，先做服务端 register/content replay
  probe，再决定是否重新入队同一 operation。
- Worker 回调必须携带 operation、generation、source revision/digest。旧 generation、
  tombstone、epoch 不匹配或 digest 变化均为 no-op/blocked，不得把成功结果写回新任务。
- 不引入 completion inbox。若 RN SQLite 与 Worker 无法安全共写，Worker 只返回执行
  证据；remote commit 后进程被杀时，启动恢复必须用同一幂等根反复 probe server，再在
  同一 domain 事务完成 CAS，并有有界超时后转为 `unknown/conflict`。前台轮询只能改善
  可见性，不能充当 completion handoff 或业务真相。

### 3. 传输和校验

1. 本机采集或导入必须先形成 app-private、可重复读取的源资产；对不可 seek 的
   `content://` 只允许 MediaIngestor 先复制/抽取，不能在 Worker 中隐式复制整份文件。
2. 服务端 register 只声明资产身份、epoch、大小和客户摘要；所有 register replay 必须
   返回同一 remote asset 或明确冲突。
3. R2 object key 必须包含 epoch、asset、generation、operation，不复用共享 key。短音频
   用 presigned single PUT；较大资产用现有 multipart，分片大小由能力接口给出，并验证
   非末片满足 R2/S3 的最小 5 MiB 约束、总片数和 URL/credential lease 的有效期。客户端
   可并行 2 个分片作为起点，真实网络测量后再调，不以盲目增加并发换吞吐。
4. R2 只保存私有 staging object。complete 请求在服务端按 session/epoch/asset/digest
   CAS claim；服务端以 256 KiB 或更小固定缓冲流式下载并同时计算 SHA-256/字节数，禁止
   `read()` 整体加载。
5. 校验通过后写入 operation 专属的 `O_CREAT|O_EXCL`、权限 0600 临时文件，`fsync` 后
   原子 rename 为 sealed ingest 文件；数据库只在 digest、size、generation 都匹配时
   激活。任何失败只能更新当前 operation 的错误，不能回退已完成 operation。
6. 转写 worker 接管 sealed 文件后，原始 R2 object 和临时 sealed 文件按现有 retention
   合同及时删除；删除失败进入有界清理队列，不影响已提交的转写/本地录音。手机本地
   原始录音仍由用户删除权和回收站合同控制。

### 4. 速度和资源假设

U2-A 的可测收益来自减少 Base64 编解码、JS 临时文件、API 隧道往返和前台轮询，不保证
R2 网络本身更快。必须同时记录首字节、端到端完成、CPU、峰值 RSS、临时磁盘和失败重试；
若 native streaming 没有改善，不能继续增加并发，而应重新审查网络入口或 R2 region。

执行器还必须按上传语境比较：普通后台/自动恢复使用 WorkManager；Android 14+ 上由用户
明确发起且预计长时间运行的大文件，比较 UIDT JobScheduler。UIDT 要求可见通知并允许用户
停止，旧系统仍需 WorkManager，因此两者只能共享同一个 operation/domain contract，不能
形成两套业务状态。1 GiB 不能在没有长任务配额、URL 到期和凭据轮换证据时默认交给普通
WorkManager。

## 迁移、回滚和废弃

1. 先只读扫描真实 SQLite/AppStorage/WorkManager/R2 session，生成按 scope、epoch、asset、
   role、origin、source revision、digest 的 manifest。WorkInfo 已 prune、R2 session 已过期
   或任何字段不可观测时只能生成 `unknown/conflict`，不能声称 manifest 完整，也不能删除
   旧 key。遇到同 asset 跨 meeting、同 operation 不同 digest、未知 epoch 直接
   `migration_conflict`，不删除旧项。
2. 新版本只写正式 generation 域；一个发布周期内旧 registry 只读导入，禁止双写。每个
   imported key 必须有精确 claim，marker 只能在 claim 与事务提交后写入。
3. U2-A 先以 shadow executor 上传一份合成大文件和真实非隐私样本；不得把真实会议原音频
   作为研究外传。通过 crash/恢复/删除门后才切新任务。
4. 回滚只回到旧 executor 读取未完成 generation；已完成 generation 的 server replay
   和 source digest 不变。meeting/asset/generation 的 late-result fence 在物理 purge
   后也要保留有限期；restore 必须创建更高 generation。不得删除新 generation 或重新
   生成新的 remote asset。
5. 迁移完成并观察一个发布周期后，删除 v1/v2/v3 registry 写入口、JS retry owner、
   `workId` 持久字段和会议状态标签语义；旧兼容 API 仅保留协议投影，不能继续创建第二种
   operation。

## 进入实现前的硬门

- 正式 schema migration 能证明旧入口每一条都有唯一替代，且无第二 owner；
- Android native Worker 在模拟 force-stop、进程杀死、系统重启、WorkManager prune 后，
  通过 operation name + server probe 只产生一个服务端幂等逻辑资产；remote commit 后
  再杀进程也必须最终由同库 CAS 收敛，无法观测时保持 `unknown/conflict`；
- R2 真实 multipart/single PUT、断网恢复、乱序、同 key 并发和删除竞态通过；
- 1 GiB 文件峰值内存不随文件大小线性增长，临时目录按 operation 可清理；
- 会议删除、epoch 删除、凭据轮换、内容 digest 改变和本地 URI 失效均 fail-closed；
- guest/device 与 authenticated/account 两个 scope 都通过同一 domain/API 合同；Android
  API 只存在于 executor adapter，schema 与核心状态机保持 Linux/Windows 可移植；
- Android 14+ 的主动大文件比较 WorkManager 与 UIDT 的开始延迟、通知、用户取消、配额和
  恢复；旧 Android 回退仍使用同一 operation；
- 与 U0 对比有真实 p50/p95 速度、CPU、RSS、磁盘和失败率证据；
- 通过前不修改生产服务、数据库、APK 或真机。

当前结论：U2-A 值得建立隔离候选；U2-B 只作兼容实验；U2-C 暂不引入。没有方案进入
`adopted`。
