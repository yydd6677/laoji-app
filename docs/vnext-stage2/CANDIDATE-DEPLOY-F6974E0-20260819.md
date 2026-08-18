# 隔离候选部署 f6974e0（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`，PID `1164047`。
- ASR：隔离 `127.0.0.1:8031`，生产 `8030` 未重启。
- release：`/home/zhong/laoji-vnext-candidate/releases/f6974e0`。
- 回滚 release：`db8259a`、`d193dd2` 均保留。
- 服务端包：`artifacts/vnext-candidates/1.1.13-121/laoji-vnext-server-candidate-f6974e0.tar.gz`。
- SHA-256：`12e4e1380a80db000c4f479048db9999dae73af8dc7634087e3f7c526b963c93`。

## 启动验证

- `/api/ready`：`ready=true`，ASR revision 固定，任务队列 `queued=0/running=0`。
- R2：`enabled=true/configured=true`，候选前缀继续为 `vnext-staging-candidate`。
- main/schedule/speaker SQLite 完整性均为 `ok`，WAL 开启。
- `capability_cutovers` 已存在且行数为 `0`；没有任何候选能力被隐式激活。
- VAD/CAM++、生成模型和 embedding 均 ready。

本次重启仅验证候选代码和持久 barrier 读取路径；没有切换公开流量、激活生产 barrier 或修改 GPU1。
