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
- 8030 保留 `/asr` 和 `/v1/asr/batch`，新增隔离 `/v2/asr/batch`。v2 请求严格拒绝未知/缺失字段，
  输出 stable segment key/revision、源时间、模型 revision、排队/推理耗时和明确的 `text/no_speech`
  内容结果；同一 shared schema 生成 TypeScript/Kotlin 哈希清单。
- 新 `vnext_realtime_asr_sessions`、`vnext_realtime_chunk_checkpoints` 和
  `vnext_realtime_event_ledger` 保存 task/binding/asset generation fence、连续 chunk cursor、稳定/final
  event cursor 与加密载荷。partial 只走瞬时 stream，event sequence 为 0；stable/final 才进入 durable
  ledger，重放必须内容一致，片段 revision 只能单调推进。

## 证据

- `python3 tools/vnext/verify_stage2_migrations.py`：通过。
- device-v2/task/purge/upload/ASR/realtime 聚焦后端测试：30 个通过，包含 remote multipart merge、
  chunk/event replay、binding fence 和 NO_SPEECH contract。
- 共享 contract 生成检查与 `npx tsc --noEmit`：通过。
- 隔离 `expo prebuild` 后 `:laoji-native-platform:compileDebugKotlin` 和 `:app:compileDebugKotlin`：通过。

尚未验证：真实 R2、进程 kill/restart、1 GiB 内存门、设备网络、APK 安装、真机/模拟器、旧 submit
连续为零和 capability barrier。因此本切片不能声称 Stage 2 完成或生产采用。

## 下一入口

1. 将 v2 realtime WSS 的 durable chunk ack/event cursor 接到上述 store；partial/stable/final 落到手机
   Transcript owner，断线和 token refresh 从游标续接。
2. VAD segment 同时投递 ASR 和 CAM++；文字稳定立即发布，讲话人作为低优先异步 overlay。
3. 在 worker attempt 提交中把 NO_SPEECH 原子完成为 success/no_content，并闭合 restart、双上传+实时
   会议、延迟和内存退出门。
4. 上述门通过后才构建 v2 candidate 并统计旧 submit；barrier 前继续保留显式旧完整协议。

生产服务、公网、APK、设备和 GPU 均未修改。
