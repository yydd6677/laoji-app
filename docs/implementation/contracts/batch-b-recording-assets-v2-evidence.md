# 批次 B 证据：RecordingAsset v2 账号上传、独立转写与来源追踪

状态：目标 18020、移动端账号 canonical 数据层和 Android WorkManager 已形成一条真实 RecordingAsset v2 纵向闭环。它覆盖同一会议多资产登记、内容上传、资产列表/下载、逐资产转写任务的自动发现/持久恢复/重试、账号录音后台上传、本机/远端来源合并，以及 Transcript segment 到 RecordingAsset/job 的持久来源追踪。独立 Summary task 也已另行取得运行/重启恢复证据；第二台移动设备和 USB 真机仍未闭环。

## 运行服务合同

- 目标服务仍从 `/home/zhong/laoji-service-platform/smart-meeting-ai/backend` 运行；18020 当前进程使用 `CUDA_VISIBLE_DEVICES=0`，18035 与旧 8020 未被本批替换。
- 部署前备份位于 `/home/zhong/laoji-service-platform/backups/20260726-recording-assets-v2-v1`；Transcript/Summary 解耦前的追加备份位于 `/home/zhong/laoji-service-platform/backups/20260726-transcript-summary-decouple-v1`。
- Transcript provenance 部署前追加备份位于 `/home/zhong/laoji-service-platform/backups/20260726-transcript-asset-provenance-v1`。运行库迁移前后 `foreign_key_check` 均有相同 7 条历史 `final_summaries → meetings` 孤儿，本次没有新增 FK 错误，也没有越界修复旧数据。
- additive schema 新增 `meeting_recording_assets_v2`、`meeting_recording_asset_operations_v2` 与 `meeting_recording_transcription_jobs_v2`。运行 capability 明确返回 `recording_assets_v2=true`；客户端不得由 broad feature flag 推导该能力。
- `POST meeting-notes/{id}/recording-assets` 使用稳定 `client_asset_id`、role、origin 和幂等键登记资产；`PUT recording-assets/{assetId}/content` 校验 revision、文件大小与 SHA-256；列表和认证下载保持具体 asset identity。旧主录音接口只投影兼容，不再限制 MeetingNote 只有一段云端录音。
- 转写创建、查询和重试均绑定 `recording_asset_id`。`OfflinePipeline.process_audio()` 新增 `generate_summary`：旧上传路径保持默认生成 Summary，RecordingAsset transcript job 固定传 `false`，因此 Transcript 成败不再被 Summary subprocess 回滚。运行日志已出现“摘要生成：已跳过（独立阶段）”。
- 独立 Summary endpoint 已在目标 18020 真实完成结构化结果；旧兼容 `SummaryService` 的直接脚本启动错误也已改为 `python -m meetingsummary.main` 并实际出件。任务进程内状态丢失后，durable final version 仍可独立读取；详见 [`phase-4-structured-summary-evidence.md`](phase-4-structured-summary-evidence.md)。

## 移动端实现

- `src/data/api/v2/recordingAssets.ts` 严格解析 register/list/content/transcription/status/retry 响应，校验 schema、meeting/client/remote identity、revision、时间、下载同源路径和 409/412 current revision。
- pending upload registry 从 meeting-keyed v2 升级为 asset-keyed v3，并兼容读取旧记录。同一会议可同时保存 primary 与多个 secondary；删除会议会取消该会议全部 native work。
- Android `MeetingUploadWorker` 使用两阶段协议登记并上传内容，input 携带 asset ID、role、origin、byte size、duration 和 checksum，output 返回 remote asset ID/revision；credential lease 仍不把 token 放入 WorkManager input。
- Store 是 v2 唯一调度者：扫描全部 `local_ready && remoteAssetId == null` 的 captured/imported/recovered 资产，取得本次 fresh capability 后才登记 WorkManager。详情页只读取/合并远端列表，不再与 WorkManager 并发成为第二上传者。
- 上传成功按具体 RecordingAsset 对账并保存 `remoteAssetId`；远端列表按 `client_asset_id` 与本机来源合并，避免同一录音重复显示。游客迁移的音频阶段也使用 RecordingAsset v2，不再落回单主录音端点。
- 普通 Preview 默认打开独立账号上传开关；capability 不可达、陈旧或明确为 false 时不发送，已有本机录音和 pending 状态保持可恢复。
- migration v26 新增 `recording_asset_transcription_tasks`，每段远端资产独立保存稳定 request/idempotency ID、远端 job ID、服务端 attempt/progress/result revision、连续传输失败次数、退避时间和 combined Transcript 是否已拉取。会议级 transcript stage 只聚合展示，不承载多 job 身份。
- `MeetingTranscriptCompletionProvider` 每个认证会话先取得一次 fresh `recording_assets_v2=true`，启动、App 回前台和上传对账成功时发现资产；普通内部轮询最多每五分钟重拉资产列表。pending/queued/running/failed-retryable 会从 SQLite 恢复，409 的 `transcription_already_running` 和 `job_not_retryable` 只在身份完整时收敛，其他冲突 fail closed。
- job 完成后复用既有 combined Transcript completion/cache 管线；只有服务端声明 complete 且 canonical Transcript 已落盘，才将该会议已完成资产标记为 content synced。完成但未拉取的任务由 completion 退避管理，不形成一秒空转。详情页“重试文字处理”会真正唤醒逐资产任务，不再只刷新页面。

## 逐录音 Transcript 来源

- 目标服务的 TranscriptLine 增加 nullable `recording_asset_id` 与 `transcription_job_id`。RecordingAsset job 把两项稳定身份传入 pipeline；同一资产成功重转写只替换该资产旧文字，失败或空结果保留此前稳定文字，不删除其他资产的段落。
- App 实际使用的认证 transcript 路由按 legacy、primary、secondary 和资产创建顺序稳定返回来源字段；combined revision 纳入每个资产的稳定 result revision。旧会议级 transcript 路由和 App 路由均已对齐，避免只修未被移动端调用的端点。
- migration v25 为 `transcript_segments` 增加本机 RecordingAsset ID、远端 RecordingAsset ID 和 transcription job ID。旧会议只有恰好一段录音时才回填；多录音旧文字保持未知，不按 primary 或列表顺序猜测。
- canonical 保存、legacy import/mirror、read cutover、projection、Summary payload 和 v5 fingerprint 全程保留来源。final segment 只允许从未知补全为已知身份；已有本机、远端或 job 身份互相矛盾时拒绝替换。
- Minutes player source 同时携带本机/远端资产身份。文字、引用、Marker 和外部 focus 在 seek 前先绑定对应录音；多录音且来源未知时不 seek。媒体片段优先使用目标 segment 对应资产，并只拼接同一资产时间范围内的文字。

## 真实证据

- 新 RecordingAsset 窄合同为 `2 passed`，与 root/occurrence/manual-note 合并合同为 `7 passed`。
- 目标 18020 真实 HTTP 使用两个独立账号会话完成 12 个断言：primary + secondary 登记、幂等重放、内容上传/重放、认证下载、稳定列表顺序、陈旧 revision 412、具体 secondary 转写身份、GPU job `completed`，测试会议最终软删除。
- provenance 服务窄合同共 `11 passed`；目标 18020 另以真实认证 HTTP 完成 14 个断言：两段 RecordingAsset、secondary GPU 转写、App transcript 路由的 asset/job identity、combined revision，以及测试会议自动软删除。重转写资产 A 不删除资产 B 文字，资产 A 空结果保留此前稳定文字。
- Preview v104 在 `emulator-5556` 真实录制约 142.6 秒。WorkManager `99e6b7dd-2685-4c3f-bb55-c73353efec1b` 最终为 `SUCCESS`；云端会议 `e4c3d843-2be1-4592-9da9-baaec31cdd67` 保存资产 `584a7f55-0985-40e2-abe7-a1690743a573`，client asset ID `7a72b324-01e1-4b0a-9653-387990864952`，role=`primary`、revision=`2`、upload state=`uploaded`、byte size=`4563244`。随后再次通过运行 API 只读确认该资产仍存在。
- 该纵切暴露出一个真实竞态：native SUCCESS 后详情页旧 JS 自动上传又触发 412，较旧 blocked 状态覆盖成功。修复后 v2 只由 Store/WorkManager 调度，native SUCCESS 先按具体 asset 对账；最终详情不再显示“上传受阻”或旧错误，播放器仍可见，未发现 App 崩溃。
- provenance 轻量收口通过 TypeScript、Kotlin、`git diff --check` 与 Preview 整包构建。保留数据 Preview 冷启动将真实库升级到 `user_version=25`，`integrity_check=ok`，未出现 SQLite/React Native/Kotlin 崩溃。
- 双录音临时夹具验证：主录音文字定位到 `00:10 / 02:22`；补充录音文字先自动切换“录音 2”再定位到 `00:05 / 00:12`；第三条无 provenance 文字保持录音 2 和 `00:05`，没有误 seek。夹具、派生 journal 和 transcript cache 随后清除，原 Meeting SQLite 三文件恢复，最终 Preview 页面重新显示“暂无文字记录”。
- 当前 Preview APK 大小 `90734500` 字节，SHA-256 为 `9c1caf467b5bf4a413d08fce262be73d91b720108d9873a15c4d75c9b4f83caf`，已覆盖安装到唯一设备 `emulator-5556`；版本仍为 v104 / `1.0.0-source-preview`。
- v26 窄 SQLite 合同验证了 scope 内远端资产唯一、删除本机资产只清空 nullable local identity、删除 MeetingNote 级联任务以及 `foreign_key_check/integrity_check=ok`。TypeScript、Kotlin/Preview 整包和 diff whitespace 通过。
- 保留数据覆盖安装后，`emulator-5556` 冷启动从真实账号发现 1 段已上传资产并写入任务，目标 18020 创建稳定 job `fe396cde-ea67-4a24-b42d-418ec2004144`；App 在进程内从 attempt 1 恢复到 attempt 3，失败 stage 与中文重试入口同步可见，证明 create/poll/retry 与 v26 恢复链实际运行。当前 APK 大小 `90764220` 字节，SHA-256 为 `a94b0a7ee8c62310d96251833ef9df46e7b242e82a6f99ce3fe7b97184dc0229`，版本仍为 v104 / `1.0.0-source-preview`。
- 该真实 job 未能完成的根因在共享服务器：内核 NVIDIA 模块为 `595.71.05`，用户态 NVML 为 `595.84`，`nvidia-smi` 和 PyTorch 均报 driver/library mismatch。App 正确保留 `failed_retryable`；为避免持续占用服务，验证后已 force-stop 模拟器 App。未获得共享主机重启授权，因此这不是 combined Transcript 成功证据。

## 尚未闭环

1. 尚未用 occurrence 冲突恢复出的 secondary 在移动端走完整上传/下载/转写恢复，也没有第二台移动设备的多资产 pull、断网/强杀长期重试或 409/412 用户选择证据。
2. 本批结束时 speaker correction/profile 尚无运行纵切、capability 为 false；后续 SPK-01 已补齐并在目标 18020 实测为 `speaker_corrections=true`、`speaker_profiles_v2=true`、`speaker_reprocess_v1=true`，见 [`phase-7-speaker-profile-evidence.md`](phase-7-speaker-profile-evidence.md)。
3. 共享服务器 GPU 驱动/NVML 版本失配需由主机维护窗口处理；修复后再补一次 App 自动 job → completed → combined Transcript 落盘的真实成功证据。
4. 当前仅有模拟器设备；USB 真机、长录音和候选版七条关键任务仍后置到批次 D。

这些边界意味着 ARC-01/SRC-01/TRN-01 的 RecordingAsset、逐录音回听，以及 PROC-01 的每资产 job 与独立 Summary 已形成纵切；speaker correction/profile 已由后续 SPK-01 关闭功能缺口，共享 GPU 恢复及跨设备/真机仍是实际工作，不能把本批写成整个目标完成。
