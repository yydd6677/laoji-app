# vNext Stage 2 纵向切片

状态：`in progress`。媒体上传、文字优先转写和 capability barrier 候选已实现但未激活；线上 8030
仍只发布 v1 ASR 入口，因此候选 v2 全链路尚不能切换。

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
  内容结果；同一 shared schema 生成 TypeScript/Kotlin 哈希清单。ASR 启动和 `/ready` 均要求固定
  `QWEN_ASR_MODEL_REVISION`，未固定时 fail-closed，避免重启后产生 `unresolved` 结果。
- 新 `vnext_realtime_asr_sessions`、`vnext_realtime_chunk_checkpoints` 和
  `vnext_realtime_event_ledger` 保存 task/binding/asset generation fence、连续 chunk cursor、稳定/final
  event cursor 与加密载荷。partial 只走瞬时 stream，event sequence 为 0；stable/final 才进入 durable
  ledger，重放必须内容一致，片段 revision 只能单调推进。
- guest/device 上传在服务端同时宣布 `upload_sessions_v2` 与 `import_transcript_events_v2` 后，移动端从
  本机 immutable RecordingAsset 读取 `asset_generation`、源 SHA-256、大小和 MIME，接入
  `device-v2-r2` WorkManager；v2 native handle 成功后携带 transcription task ID，旧 native handle
  会被隔离清除，不会在同一次请求中静默回退 v1。
- `vnextCapabilityBarrier` 与服务端 `vnext_capability_cutover` 增加持久单调 `media.upload` barrier、
  旧提交计数和 `426 UPGRADE_REQUIRED` 门；默认环境变量关闭，未经完整公开周期和人工切换不改变当前
  生产入口。
- ModelManager 在 compact 环境优先读取标准 Torch Hub 缓存的 Silero JIT，并用现有 `soundfile/scipy`
  提供文件读取，流式 VAD 初始化不再强制依赖不匹配的 torchaudio。
- `deploy/linux/` 已提供隔离候选的 ASR/API systemd 模板和脱敏环境模板：默认仅监听
  `127.0.0.1:8031/18021`、CPU 运行 ASR、关闭 R2 和 capability barrier；`tools/vnext/verify_deployment_templates.py`
  对端口、路径、GPU 和密钥占位进行静态检查。
- Android native transfer 已修复三个恢复边界：`KEEP` 重入返回真实 unique WorkInfo ID；本机擦除在
  删除媒体前同时清理 `guest` 与 `device-v2:<epoch>` lease/tag；WorkManager/Uploader 不再吞掉
  `CancellationException`。v2 源在 PUT 前严格校验精确字节数、SHA-256 和 multipart part layout。

## 证据

- `python3 tools/vnext/verify_stage2_migrations.py`：通过。
- device-v2/task/purge/upload/ASR/realtime/import/cutover 聚焦后端测试：58 个通过，包含 remote multipart merge、
  chunk/event replay、binding fence 和 NO_SPEECH contract。
- 共享 contract 生成检查、`npx tsc --noEmit` 和 Android 两个 Kotlin compile task：通过。
- `python3 tools/vnext/verify_deployment_templates.py`：通过；模板未安装到服务器。
- `python3 tools/vnext/verify_stage2_android_contract.py`：通过；该探针是源码合同检查，不是设备运行证据。
- 隔离服务器候选 8031/18021 已真实启动并保持 loopback；`/api/ready` 对 ASR revision、R2、VAD、
  CAM++、SQLite 和 worker 报告 ready。完整 360 秒设备 v2/R2/转写链路产生 115 stable + 1 final，
  ACK 和到期清理通过；API 在任务运行中终止后由第二 attempt 恢复且业务 Task 唯一。详见
  [真实候选证据](REAL-CANDIDATE-20260818.md)。
- 修复尾部 `moov` MP4/M4A 通过非 seekable stdin 被误判 no-content：生产改用短期 R2 GET + HTTP
  Range，仍不生成完整 WAV；修复前后真实 60 秒样本由 0 stable 变为 19 stable + 1 final。
- 双 60 秒真实 R2 PUT + 两个 transcript Task + 一条 realtime 请求通过；两个转写各为 19 stable +
  1 final，realtime 在离线批次之间优先执行。CPU 候选 realtime 为 16.224 秒，只证明顺序，不满足
  生产延迟预算。
- 1 GiB 稀疏样本完成真实 128 片 multipart/R2 verified；候选 API RSS 采样峰值相对本次基线增加
  13.65 MiB，未生成整份本地副本。该样本的尾部补零会诱发完整对象解码，已在转写前主动取消，
  所以这是上传内存上界证据，不是 1 GiB 完整媒体转写验收。
- 使用合法 MP4 `free` padding atom 重跑 1 GiB 完整链路：128 片上传、R2 Range 解码、`no_content`
  成功终态、1 个 final、ACK 和 purge 全部确认；API RSS 峰值增量 4.29 MiB。详见
  `device-v2-r2-1g-valid.json`。`no_content` 在 v2 合同中是成功内容结果。
- 线上只读参考回放（样本 `39799065_da2-1-16.mp4`，360.133 秒，现有 `/v1/asr/batch`）：首个稳定批次
  1.993 秒，RTF 0.1008，115 段/36 批，模型推理耗时合计 82.756 秒，进程峰值 RSS 约 1180 MiB。
  该数据只证明当前 v1 模型/硬件参考性能，不证明 v2 合同。

仍未验证：Android 设备网络、APK、
真机/模拟器、完整 RSS、旧 submit 连续为零和 capability barrier。生产 8030 仍未发布 v2，
所以这些候选证据不能声称生产采用；当前 GPU/ADB 外部边界见
[当前外部门](LIVE-BLOCKERS-20260818.md)。

## 下一入口

1. 继续在隔离候选完成 Android 网络/进程死亡恢复证据；1 GiB 媒体和上传内存门已关闭，不得覆盖线上 v1。
2. 将 v2 realtime WSS 的 durable chunk ack/event cursor 接到上述 store；partial/stable/final 落到手机
   Transcript owner，断线和 token refresh 从游标续接。
3. VAD segment 同时投递 ASR 和 CAM++；文字稳定立即发布，讲话人作为低优先异步 overlay。
4. 在 worker attempt 提交中把 NO_SPEECH 原子完成为 success/no_content，并闭合 restart、双上传+实时
   会议、延迟和内存退出门。
5. 上述门通过后才构建 v2 candidate 并统计旧 submit；barrier 前继续保留显式旧完整协议。

生产服务、公网、APK、设备和 GPU 均未修改。
