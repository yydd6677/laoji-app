# 生产活动源码同步记录（2026-08-09）

审计发现工作区的 server overlay 比生产活动源码旧：客户端已使用的设备 `/schedule/clarify`、分片上传和设备 WebSocket 鉴权在本地副本中缺失。生产运行没有回退，但未来从工作区部署会有回退风险。

已完成同步：

- `backend/app/api/device_v1.py` → `f8c6b8ead988de0447837807a9e5d97d4cee0ee3f328188370cde347d249d58d`
- `backend/app/api/ws_auth.py` → `7f51444f1a57190abf65c2fbd37529e6d582bd95014170fd973a4b5603fd3b99`
- `backend/app/api/qwen_ws.py` → `b4b7a629bbd24bf147197992d2eef40b11b404e9c53e7f4f7e4da028b1ca9f3c`

同步前的三个本地副本保存在：
`server-work/laoji-compact-production/backend/backups/source-sync-20260809-r1/local-before/`

同步后已用 Python 3 语法编译检查，并确认 `/schedule/clarify`、分片上传路由和 `Bearer dv1` + `X-Laoji-Data-Epoch` 鉴权代码存在。没有重启生产服务；活动服务器源码保持不变。

同步后的公网回归也通过：临时设备调用 `/api/device/v1/schedule/parse` 和 `/schedule/clarify` 均返回 `200` 且带结构化 `result`；测试设备 epoch 和主记录随后清理。
