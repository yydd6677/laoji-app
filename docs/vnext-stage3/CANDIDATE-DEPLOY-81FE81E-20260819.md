# vNext 隔离候选部署 81fe81e

状态：`candidate-only`，生产未触碰。

- API：`127.0.0.1:18021`，PID `1332687`。
- cwd：`/home/zhong/laoji-vnext-candidate/releases/81fe81e/services/laoji-api`。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 回滚：旧 `releases/6a80576` 保留；本次仅切换候选 API handler。
- 数据库：继续使用候选 `api-data/api-asr-retry.db`、候选 schedule/speaker 数据库，未接触生产库。
- 模型：候选 API 使用 Ollama `qwen3.5:9b` 和 `qwen3-embedding:0.6b`；ready 探针通过。
- 版本：服务端 `PROMPT_REVISION=facts-v3-r7`，提示词 SHA-256 为
  `8273d0fb2ffc252df04d2ca897e70ba24e8e098b6ec3cb1372a587580c6eddd9`。

`/api/ready` 复核：ASR、LLM generation/embedding、VAD、CAM++、任务 worker、三库 WAL/完整性、
R2 和磁盘门均为 ready。公网入口、GPU1、PCB、Smart Meeting 和稳定 18020/8030 没有变更。
