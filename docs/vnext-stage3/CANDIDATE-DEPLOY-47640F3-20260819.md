# vNext 隔离候选部署 47640f3

状态：`candidate-only`，生产未触碰。

- API：`127.0.0.1:18021`，PID `1501255`。
- cwd：`/home/zhong/laoji-vnext-candidate/releases/47640f3/services/laoji-api`。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 回滚：`releases/9f7cbbd`、`81fe81e` 与更早候选均保留。
- 就绪探针：`LAOJI_LLM_READINESS_EMBED_TIMEOUT=10`；embedding 冷启动实测约 2.2 秒后 ready。
- Facts：继续使用 `facts-v3-r8`。

`/api/ready` 复核：ASR、LLM generation/embedding、VAD、CAM++、任务 worker、三库 WAL/完整性、
R2 和磁盘门均为 ready。生产 18020/8030、公网入口、GPU1、PCB、Smart Meeting 和其他服务没有变更。
