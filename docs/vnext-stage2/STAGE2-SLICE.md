# vNext Stage 2 纵向切片

状态：`in progress`。媒体上传纵向切片已实现但未激活；ASR capability barrier 未切换。

## 已实现

- 0043 为 Transcript 增加 source manifest/text-final 边界，为 segment 增加稳定 key、revision 和
  partial/final 状态。
- 旧 segment 的自动讲话人投影迁入 `speaker_overlay_*`；旧人工 assignment 迁入
  `speaker_manual_overrides`，两层不再互相覆盖。
- v20 `meeting_search_fts` 保持现有结构和查询合同；external-content FTS 与查询仓储一起留到
  0045/Stage 4，避免 Stage 2 复用同名表改变列结构。
- 0044 为历史录音补随机 128-bit `asset_generation`，从可信 checksum 补 `source_sha256`，增加 upload
  operation/remote object revision；删除会议按原 `deleted_at_ms` 补 30 天 `purge_after_ms`。
- RecordingAsset repository 强制 generation 不可变、canonical source SHA-256、remote object revision
  单调、`media.upload` operation owner 合法；Transcript segment 强制 partial/stable/final 单调，讲话人
  automatic overlay 和 manual CAS override 独立演进。
- device-v2 服务端提供 single/multipart session、2/4 会话和 2/4 GiB reservation 硬门、opaque R2 key、
  ETag 恢复、流式整对象 SHA-256 校验，以及 verified asset 与唯一 transcription Task 原子提交。
- multipart 已合并但 API 尚未提交的崩溃窗口通过 `object_completed` probe 恢复，不依赖已消失的
  multipart ETag 列表；取消、过期和 binding/epoch purge 均等到 R2 object/part 确认不存在。
- Android 新增未激活的 `device-v2-r2` WorkManager 协议。唯一业务身份为
  `device_epoch + asset_id + asset_generation`；single PUT 直接流式读取源 URI，multipart 只读取 seekable
  范围、最多同时上传两片，不使用 Base64 或整文件临时副本。
- WorkManager 通过 GET session 恢复 ETag/remote-complete 状态，完成后返回 verified asset revision、
  object revision 和 transcription Task ID。15 分钟 device token 过期时由 Android Keystore 原生签名续期，
  不依赖 JS 进程仍在运行。
- `ensureRemoteMeetingServiceBinding` 在上传前登记本机 binding 和 binding-scoped purge capability；只有
  服务端确认相同 generation/revision/cancel fence 后才将原生 purge capability 标记为 armed。

## 证据

- `python3 tools/vnext/verify_stage2_migrations.py`：通过。
- device-v2/task/purge/upload 聚焦后端测试：21 个通过，包含 remote multipart merge 后恢复。
- 共享 contract 生成检查与 `npx tsc --noEmit`：通过。
- 隔离 `expo prebuild` 后 `:laoji-native-platform:compileDebugKotlin` 和 `:app:compileDebugKotlin`：通过。

尚未验证：真实 R2、进程 kill/restart、1 GiB 内存门、设备网络、APK 安装、真机/模拟器、旧 submit
连续为零和 capability barrier。因此本切片不能声称 Stage 2 完成或生产采用。

## 下一入口

1. 8030 stable batch/stream DTO 与统一的 realtime/schedule/import 优先级队列。
2. VAD segment 同时投递 ASR 和 CAM++；先发布 partial/stable/final 文字，讲话人作为异步 overlay。
3. 实现 NO_SPEECH success/no_content、restart、双上传+实时会议、延迟和内存退出门。
4. 上述门通过后才构建 v2 candidate 并统计旧 submit；barrier 前继续保留显式旧完整协议。

生产服务、公网、APK、设备和 GPU 均未修改。
