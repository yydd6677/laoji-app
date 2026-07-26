# 批次 B 证据：RecordingAsset v2 账号上传、独立转写与来源追踪

状态：目标 18020、移动端账号 canonical 数据层和 Android WorkManager 已形成一条真实 RecordingAsset v2 纵向闭环。它覆盖同一会议多资产登记、内容上传、资产列表/下载、具体资产转写任务、账号录音后台上传、本机/远端来源合并，以及 Transcript segment 到 RecordingAsset/job 的持久来源追踪。该结论不等于 App 已自动调度并恢复每一段资产的转写任务、第二台移动设备已收敛或 USB 真机已验收。

## 运行服务合同

- 目标服务仍从 `/home/zhong/laoji-service-platform/smart-meeting-ai/backend` 运行；18020 当前进程使用 `CUDA_VISIBLE_DEVICES=0`，18035 与旧 8020 未被本批替换。
- 部署前备份位于 `/home/zhong/laoji-service-platform/backups/20260726-recording-assets-v2-v1`；Transcript/Summary 解耦前的追加备份位于 `/home/zhong/laoji-service-platform/backups/20260726-transcript-summary-decouple-v1`。
- Transcript provenance 部署前追加备份位于 `/home/zhong/laoji-service-platform/backups/20260726-transcript-asset-provenance-v1`。运行库迁移前后 `foreign_key_check` 均有相同 7 条历史 `final_summaries → meetings` 孤儿，本次没有新增 FK 错误，也没有越界修复旧数据。
- additive schema 新增 `meeting_recording_assets_v2`、`meeting_recording_asset_operations_v2` 与 `meeting_recording_transcription_jobs_v2`。运行 capability 明确返回 `recording_assets_v2=true`；客户端不得由 broad feature flag 推导该能力。
- `POST meeting-notes/{id}/recording-assets` 使用稳定 `client_asset_id`、role、origin 和幂等键登记资产；`PUT recording-assets/{assetId}/content` 校验 revision、文件大小与 SHA-256；列表和认证下载保持具体 asset identity。旧主录音接口只投影兼容，不再限制 MeetingNote 只有一段云端录音。
- 转写创建、查询和重试均绑定 `recording_asset_id`。`OfflinePipeline.process_audio()` 新增 `generate_summary`：旧上传路径保持默认生成 Summary，RecordingAsset transcript job 固定传 `false`，因此 Transcript 成败不再被 Summary subprocess 回滚。运行日志已出现“摘要生成：已跳过（独立阶段）”。

## 移动端实现

- `src/data/api/v2/recordingAssets.ts` 严格解析 register/list/content/transcription/status/retry 响应，校验 schema、meeting/client/remote identity、revision、时间、下载同源路径和 409/412 current revision。
- pending upload registry 从 meeting-keyed v2 升级为 asset-keyed v3，并兼容读取旧记录。同一会议可同时保存 primary 与多个 secondary；删除会议会取消该会议全部 native work。
- Android `MeetingUploadWorker` 使用两阶段协议登记并上传内容，input 携带 asset ID、role、origin、byte size、duration 和 checksum，output 返回 remote asset ID/revision；credential lease 仍不把 token 放入 WorkManager input。
- Store 是 v2 唯一调度者：扫描全部 `local_ready && remoteAssetId == null` 的 captured/imported/recovered 资产，取得本次 fresh capability 后才登记 WorkManager。详情页只读取/合并远端列表，不再与 WorkManager 并发成为第二上传者。
- 上传成功按具体 RecordingAsset 对账并保存 `remoteAssetId`；远端列表按 `client_asset_id` 与本机来源合并，避免同一录音重复显示。游客迁移的音频阶段也使用 RecordingAsset v2，不再落回单主录音端点。
- 普通 Preview 默认打开独立账号上传开关；capability 不可达、陈旧或明确为 false 时不发送，已有本机录音和 pending 状态保持可恢复。

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

## 尚未闭环

1. App 还没有为上传完成后的每个 RecordingAsset 自动创建、持久恢复和重试 transcription job。当前服务端 job 与 combined transcript 已可用，但移动端仍需把每资产调度/恢复接入既有 processing stage 和持久队列。
2. Summary 已从 transcript job 中解耦，但独立 Summary 运行入口仍需修复模块启动与任务恢复；不得把它重新塞回 Transcript job。
3. 尚未用 occurrence 冲突恢复出的 secondary 在移动端走完整上传/下载/转写恢复，也没有第二台移动设备的多资产 pull、断网/强杀长期重试或 409/412 用户选择证据。
4. speaker correction/profile 仍未形成运行纵切；当前 capability 明确为 false。
5. 当前仅有模拟器设备；USB 真机、长录音和候选版七条关键任务仍后置到批次 D。

这些边界意味着 ARC-01/SRC-01/TRN-01 的 RecordingAsset 与逐录音回听合同已经前进，但 PROC-01 的每资产 job 调度/恢复、独立 Summary job 和批次 B 的 speaker correction 仍是实际功能工作，不能把本批写成整个目标完成。
