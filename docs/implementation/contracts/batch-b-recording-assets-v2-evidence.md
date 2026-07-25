# 批次 B 证据：RecordingAsset v2 账号上传与独立转写

状态：目标 18020、移动端账号 canonical 数据层和 Android WorkManager 已形成一条真实 RecordingAsset v2 纵向闭环。它覆盖同一会议多资产登记、内容上传、资产列表/下载、具体资产转写任务、账号录音的后台上传和本机/远端来源合并。该结论不等于 per-asset Transcript 已完成、第二台移动设备已收敛或 USB 真机已验收。

## 运行服务合同

- 目标服务仍从 `/home/zhong/laoji-service-platform/smart-meeting-ai/backend` 运行；18020 当前进程使用 `CUDA_VISIBLE_DEVICES=0`，18035 与旧 8020 未被本批替换。
- 部署前备份位于 `/home/zhong/laoji-service-platform/backups/20260726-recording-assets-v2-v1`；Transcript/Summary 解耦前的追加备份位于 `/home/zhong/laoji-service-platform/backups/20260726-transcript-summary-decouple-v1`。
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

## 真实证据

- 新 RecordingAsset 窄合同为 `2 passed`，与 root/occurrence/manual-note 合并合同为 `7 passed`。
- 目标 18020 真实 HTTP 使用两个独立账号会话完成 12 个断言：primary + secondary 登记、幂等重放、内容上传/重放、认证下载、稳定列表顺序、陈旧 revision 412、具体 secondary 转写身份、GPU job `completed`，测试会议最终软删除。
- Preview v104 在 `emulator-5556` 真实录制约 142.6 秒。WorkManager `99e6b7dd-2685-4c3f-bb55-c73353efec1b` 最终为 `SUCCESS`；云端会议 `e4c3d843-2be1-4592-9da9-baaec31cdd67` 保存资产 `584a7f55-0985-40e2-abe7-a1690743a573`，client asset ID `7a72b324-01e1-4b0a-9653-387990864952`，role=`primary`、revision=`2`、upload state=`uploaded`、byte size=`4563244`。随后再次通过运行 API 只读确认该资产仍存在。
- 该纵切暴露出一个真实竞态：native SUCCESS 后详情页旧 JS 自动上传又触发 412，较旧 blocked 状态覆盖成功。修复后 v2 只由 Store/WorkManager 调度，native SUCCESS 先按具体 asset 对账；最终详情不再显示“上传受阻”或旧错误，播放器仍可见，未发现 App 崩溃。
- 轻量收口通过 `npx tsc --noEmit` 与 `git diff --check`。最终 Preview APK 大小 `90725868` 字节，SHA-256 为 `77e13fedb3266dcd510e2c31f693ca27e0c60da5339ec55ffdd27154d0549fc4`，已覆盖安装到 `emulator-5556`。

## 尚未闭环

1. 当前 TranscriptLine/Transcript segment 仍是会议级事实，没有持久的 source RecordingAsset identity。多资产分别转写后无法安全合并、重试或只替换某一资产的 segment；下一纵切必须先补 per-asset Transcript provenance。
2. Summary 已从 transcript job 中解耦，但独立 Summary 运行入口仍需修复模块启动与任务恢复；不得把它重新塞回 Transcript job。
3. 尚未用 occurrence 冲突恢复出的 secondary 在移动端走完整上传/下载，也没有第二台移动设备的多资产 pull、断网/强杀长期重试或 409/412 用户选择证据。
4. 当前仅有模拟器设备；USB 真机、长录音和候选版七条关键任务仍后置到批次 D。

这些边界意味着 ARC-01/SRC-01/PROC-01 的 RecordingAsset 运行合同已经前进，但 TRN-01 的 per-asset provenance 和批次 B 的 speaker correction 仍是实际功能工作，不能把本批写成整个目标完成。
