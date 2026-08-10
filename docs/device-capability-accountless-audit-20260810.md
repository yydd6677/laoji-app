# 设备能力探测去账号化审计（2026-08-10）

## 发现

文件/视频导入的能力探测原先复用了 `loadMeetingCapabilities()`。该函数请求旧的
`/api/laoji/capabilities`，在旧实现中允许缺少 `Authorization`，因此即使当前
`AuthStore` 固定为本机 `guest`，导入入口仍会探测账号兼容端点。这不是会议主体
CRUD，但违反了设备主数据改造中“移动端不调用账号接口”的边界。

## 修复

- `src/services/deviceApi.ts` 新增 `loadDeviceServiceCapabilities()`，使用设备
  UUID、设备密钥和 `X-Laoji-Data-Epoch` 调用 `/api/device/v1/capabilities`，并在
  设备 epoch 内缓存 60 秒；`ensureDeviceReady()` 的首次能力证明会复用同一缓存。
- `MeetingMediaImportProvider` 的视频 MIME 检查和文件选择均改走设备能力，不再
  读取账号能力缓存，也不再携带可能为空的账号令牌。
- `src/data/api/v2/capabilities.ts` 的账号兼容能力读取在读取缓存前即要求有效令牌；
  无令牌时直接失败，不产生网络请求。账号功能保留给历史兼容代码，但不会被设备
  模式静默降级为匿名请求。
- 服务端 `/api/device/v1/capabilities` 增加 `media_import.mime_types` 和
  `media_import.max_bytes`，与现行 `MEETING_AUDIO_MAX_BYTES` 同源；旧账号能力接口
  没有被修改。

## 部署与证据

- 服务端部署前文件备份：
  `/home/zhong/laoji-service-platform/migration-baselines/device-capabilities-20260810-pre/device_v1.py`
- 部署后服务端文件 SHA-256：
  `10dde960b88d5f1213280045965bcb644ee0d71a2902d95a6c9a2831cc12bac3`
- `laoji-api.service` 重启后为 `active`；本机和公网 `/api/ready` 均为
  `ready=true`，ASR/整理队列保持空闲。
- 新建临时设备完成注册 `201`、设备能力读取 `200`，能力响应包含 11 种音频/视频
  MIME 和 `max_bytes=1073741824`；随后关闭临时 epoch，未留下会议、资产或任务。
- `media_import` 只有在服务端同时检测到 `ffmpeg` 与 `ffprobe` 时才报告为可用，避免
  能力声明与实际解码依赖漂移。
- 本地 `npx tsc --noEmit`、`git diff --check`、
  `python3 tools/verify_device_primary_source.py` 通过。
- 服务端 `python3 -m compileall -q backend/app/api/device_v1.py` 和设备合同静态
  测试 `7 passed` 通过。

## 边界

本记录只证明能力探测边界和服务重启后的健康状态，不替代真机验收、会议问答专题、
真实声纹纵向质量或完整历史 pytest；这些项目仍按用户决定延期。
