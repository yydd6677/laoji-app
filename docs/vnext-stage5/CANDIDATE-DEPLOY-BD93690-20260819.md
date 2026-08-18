# vNext 隔离候选部署 bd93690（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`，cwd 为 `/home/zhong/laoji-vnext-candidate/releases/bd93690/services/laoji-api`。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 生产 `18020/8030`、公网入口、GPU1、PCB、Smart Meeting 和其他服务未修改。
- 上一候选 `c72472c` 保留，可回滚。

## 本次变更

- `/guest-summary`、App summary generate、guest Q&A、App Q&A 均调用 `summary/question` legacy guard。
- `/parse`、`/clarify`、`/parse-audio`、`/asr/transcribe` 均调用 `schedule` legacy guard。
- barrier 默认关闭，因此候选启动不拒绝当前旧客户端；未来持久关闭后统一返回 `426 UPGRADE_REQUIRED`。
- 静态合同探针覆盖 8 个旧整理/问答/日程写入入口，当前 `missing_count=0`。

## 运行检查

- `/api/ready` 返回 `ready=true`，队列深度为 `0`。
- `capability_cutovers` 仍为 `0` 行；没有任何能力被激活。
- Attempt 状态保持 `terminal_failure=6`；purge 保持 `confirmed=3/pending=2`。

本次只证明旧提交入口已接入可关闭的持久 guard，不构成公开周期、设备回放、能力切换或删除门通过。
