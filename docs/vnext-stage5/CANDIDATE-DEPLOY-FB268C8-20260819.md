# vNext 隔离候选部署 fb268c8（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`，cwd 为 `/home/zhong/laoji-vnext-candidate/releases/fb268c8/services/laoji-api`。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 生产 `18020/8030`、公网入口、GPU1、PCB、Smart Meeting 和其他服务未修改。
- 上一候选 `bd93690` 保留，可回滚。

本次只调整旧 App summary/Q&A guard 的执行顺序，使鉴权和会议归属校验成功后才累计 legacy submit；
候选 `/api/ready` 为 ready，队列为 0，Attempt 为 `terminal_failure=6`，purge 为
`confirmed=3/pending=2`。能力 barrier 仍全部关闭，删除门仍未通过。
