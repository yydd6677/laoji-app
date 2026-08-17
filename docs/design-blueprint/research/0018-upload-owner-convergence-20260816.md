# 研究 0018：录音上传唯一 owner 收敛

## 状态

- status: `research candidate; not adopted`
- date: `2026-08-16 Asia/Shanghai`
- target: 删除重复状态和重试 owner，不增加通用任务内核
- production mutation: `none`

## 当前真实 owner 地图

同一录音上传目前至少被四处表达：

1. `meetingRecording.ts` 保存 AppStorage
   `pendingMeetingAudioUploads:v1/v2/v3`，另有进程内 in-flight map、listener、自动 retry、
   backoff 和 failure projection；代码仍明确保留“JS retry compatibility fallback”。
2. SQLite 已有 canonical `RecordingAsset` 和 upload `ProcessingStage`，
   `reconcileMeetingAudioUpload.ts` 能在事务中校验 operation/evidence 并投影状态。
3. Android WorkManager 已拥有网络约束、进程死亡恢复、HTTP retry、credential lease 和
   unique operation；v2 register/content 已使用 Idempotency-Key 与 If-Match。
4. `MeetingsStore.tsx` 又从 SQLite asset 重建 pending registry，并把
   `audioSyncPending/audioSyncBlocked` 和“待上传/上传受阻”标签持久回会议对象。

这不是有意的 CQRS：四份状态会互相反向重建，任一晚到结果都可能覆盖另一 owner。

## 三条路线

| 路线 | 形态 | 判断 |
|---|---|---|
| U0 维持 | registry、SQLite stage、WorkManager 和标签镜像并存，只修当前 bug | rollback；禁止新增状态 |
| U1 owner 收敛 | `RecordingAsset + active upload generation/stage` 是唯一业务真相；WorkManager 只执行；UI 全派生 | **下一隔离候选** |
| U2 transfer runtime | 内容寻址、分块续传、独立 transfer runtime/API | 只有 U1 被真实大文件/恢复反证后进入 |

当前慢上传已经有 R2/媒体抽取等独立问题，但速度不能证明需要第五个 transfer owner。
先收敛业务状态，之后才能准确测量传输协议。

## U1 数据与事务边界

最小业务模型：

```text
RecordingAsset
  asset_id, meeting_id, source_revision, local_uri
  byte_size, content_sha256, duration, tombstone
  active_upload_generation

UploadGeneration
  asset_id, generation, operation_id
  queued | running | retry_wait | blocked | uploaded
  executor_enqueued, attempt, next_retry_at
  remote_asset_id, remote_revision, error_code
```

`RecordingAsset + generation=1 queued` 必须在本地文件可读后以同一 SQLite 事务提交，
再 enqueue WorkManager。事务成功、enqueue 前崩溃时，启动恢复扫描
`executor_enqueued=false` 并重投同一 operation；不能创建新业务任务。

WorkManager 是执行 owner，不是业务真相。它只接收 asset/generation/operation/source
identity，按稳定 operation ID 调 server。started/retry/blocked/uploaded 回调必须在同一
domain SQLite 中 CAS 当前 generation；旧 generation、已 tombstone 或 source digest
不一致时 no-op 并记录计数。

若 Android worker 无法安全写当前 SQLite，同一故障域内可增加窄 completion inbox 表，
但 inbox 只能保存 operation/result identity，并由同一 DB transaction consume；不得再用
SharedPreferences/AppStorage 建第五份状态。

## 状态与重试语义

- `queued -> running -> retry_wait -> running` 可循环；attempt 单调；
- 401/403、文件缺失、checksum 变化和无效响应进入 `blocked`；
- 408/429/5xx 由 WorkManager 调度重试，同时将业务 stage 投影为 `retry_wait`；
- 用户重试创建更高 generation，旧 operation 仍可完成网络调用但不能 commit；
- success 必须带 remote asset/revision 且 server 幂等；重复 success 等价；
- delete 先写 tombstone，再 cancel unique work；迟到 success 永不复活 asset/meeting/tag；
- local asset 在上传前即可播放；网络状态不阻塞本地会议可用性。

## UI 和标签

UI 只从当前 asset/stage 派生：准备、排队、上传、等待网络、需要处理、完成。WorkInfo
只能补充进度百分比，不能决定业务完成。

“待上传”和“上传受阻”从用户标签目录和会议持久标签中删除；
`audioSyncPending/audioSyncBlocked` 只允许存在于一次性兼容 DTO，不能继续写回数据库。
上传状态属于会议详情/列表 presenter，不是分类标签。

## 旧 registry 迁移

1. 只读 v3/v2/v1，按 asset/source digest 合并；
2. 一次事务 upsert RecordingAsset、创建或关联 active generation；
3. 对已上传远端 identity 做幂等确认，不把 completed 降回 pending；
4. 写 migration marker 和导入计数；
5. 事务成功后才删除三个 AppStorage key；
6. 后续版本禁止 SQLite asset 反向重建 registry；
7. 无法解析的项 fail closed 并保留可诊断 hash，不静默丢本地文件。

迁移期最多一个发布版本读旧 registry，禁止长期双写。

## 可移植性

Domain state machine、operation identity 和 server idempotency 与平台无关。Android 以
WorkManager 实现 executor；Linux/Windows 若以后承担桌面客户端，只实现相同 executor
port，不复制业务状态机。Android systemd、Windows service 或 Linux daemon 不进入 domain
模块。

## 采用门

- 文件落盘与 queued stage 原子；断网/force-stop/重开后本地立即可播放；
- commit 后 enqueue 前崩溃可恢复同一 operation；
- server success 后本地 commit 前崩溃，重放后只产生一个 remote asset；
- 重复、乱序、迟到回调和新 generation 后旧 success 均收敛；
- delete/enqueue/success 竞态永不复活会议；
- 401/403、408、429、5xx、文件缺失、checksum 变化和 DB busy/full 明确收敛；
- v1/v2/v3 migration 重跑幂等，完成后 registry claim 为 0；
- 真机录音、音频导入、视频导入、前后台、断网恢复、删除和两主题只显示一个状态；
- 与 U0 比较本地可用、入队、恢复 p50/p95、吞吐、内存和 100% bytes/hash 完整性；
- 实际删除 registry、状态标签语义和至少一个 JS retry owner，不能只增加 facade。

U1 两轮后仍不能删除一个 owner、仍会复活已删除会议、或必须再建通用 operation ledger，
停止当前形态并保持 U0，只比较 U2。
