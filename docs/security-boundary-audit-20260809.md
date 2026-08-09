# 公网安全边界复核（2026-08-09）

## 已复核

- 未携带设备凭据访问 `/api/device/v1/capabilities` 返回 `401`，错误为中文 `DEVICE_AUTH_REQUIRED`。
- 无效公开分享 token 返回 `404`，不会返回会议内容。
- 未授权访问会议共享列表返回 `401`，带 `WWW-Authenticate: Bearer`。
- `/api/ready` 不包含 secret、token、password、authorization、正文或坐标字段；只返回服务就绪、模型状态、队列、数据库完整性和磁盘准入状态。
- 设备和地址接口现在都返回 `Cache-Control: no-store`、`Pragma: no-cache`、`X-Content-Type-Options: nosniff`；此前中间件只覆盖账号和普通会议路由，已补齐 `/api/device` 与 `/api/location`。
- 生产日志和最近 1000 条 API journal 中未发现 Bearer、`dv1`、`device_secret`、`audio_base64` 或 password 字样；`/etc/laoji/laoji.env` 与 `/etc/cloudflared/token` 权限均为 `0600`。
- API 重启后 `laoji-api`、`laoji-asr`、`laoji-ollama`、`cloudflared` 全部 active，公网 `/api/ready` 仍为 ready，ASR/task queue 和 active leases 均为 0。

## 部署记录

- 修改文件：`server-work/laoji-compact-production/backend/app/security_headers.py`。
- 服务器备份：`backups/security-headers-device-location-20260809-r1/security_headers.py.before`。
- 活动源码 SHA-256：`d87a283ad36a67a104f0b55fe7c6ffd355f4ff4a86feff328418eed267c262b3`。
- 只重启了 `laoji-api.service`，未重启 ASR、Ollama、Tunnel 或其他用户服务。

本审计不替代问答质量、声纹纵向质量或真机验收；这些仍按当前范围延期。
