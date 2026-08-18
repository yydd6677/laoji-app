# vNext 隔离候选部署 9f7cbbd

状态：`candidate-only`，生产未触碰。

- API：`127.0.0.1:18021`，PID `1431539`。
- cwd：`/home/zhong/laoji-vnext-candidate/releases/9f7cbbd/services/laoji-api`。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 回滚：`releases/81fe81e` 与更早候选均保留；本次只切换隔离 API handler。
- 版本：服务端 `PROMPT_REVISION=facts-v3-r8`。

`/api/ready` 复核：ASR、LLM generation/embedding、VAD、CAM++、任务 worker、三库 WAL/完整性、
R2 和磁盘门均为 ready。生产 18020/8030、公网入口、GPU1、PCB、Smart Meeting 和其他服务没有变更。
