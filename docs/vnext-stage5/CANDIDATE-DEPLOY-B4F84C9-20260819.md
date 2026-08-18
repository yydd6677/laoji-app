# vNext 隔离候选部署 b4f84c9（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`；当前 cwd 为 `/home/zhong/laoji-vnext-candidate/releases/b4f84c9/services/laoji-api`。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 生产：`18020/8030`、公网入口、GPU1、PCB、Smart Meeting 和其他服务未修改。
- 回滚：旧候选 `47640f3` 仍保留；本次仅复制候选 release 并替换 capability service 文件。
- 代码哈希：`services/laoji-api/app/services/vnext_capability_cutover.py` 的 SHA-256 为
  `82377e344d6c563a1f2631e74133b86228e901e0ead7da84f7e9d4c1e3fe9a66`。

## 运行检查

- `/api/ready` 返回 `ready=true`。
- ASR、生成模型、embedding、VAD、CAM++、任务 worker 和三库完整性均 ready。
- 候选任务队列深度为 `0`，磁盘可用约 `466.4 GiB`。
- 候选数据库 `capability_cutovers` 已由新代码补齐 reader-removal revision/evidence 字段，当前行数仍为 `0`。

本次没有激活任何 capability、没有登记 reader removal 证据、没有产生候选业务流量；Stage 5 删除门仍为
`safe_to_delete=false`。这次部署只证明新 schema 初始化与候选进程启动，不构成设备、公开周期或生产验收。
