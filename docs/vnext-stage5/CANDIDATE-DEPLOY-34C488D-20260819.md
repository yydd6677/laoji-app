# vNext 隔离候选部署 34c488d（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`，当前 cwd 为候选 `candidate-current/services/laoji-api`，PID 会随候选重启变化。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 生产 `18020/8030`、Cloudflare Tunnel、公网入口、GPU1、PCB、Smart Meeting 和其他服务未修改。
- 候选复用既有候选数据库 `/home/zhong/laoji-vnext-candidate/api-data/api-asr-retry.db`，R2 使用 `vnext-staging-candidate` 前缀；旧候选 release 仍保留。

## 真实启动证据

- `/health`：HTTP 200，`status=ok`。
- `/api/health`：HTTP 200，ASR、Silero VAD 和 CAM++ 均 ready。
- `/api/ready`：HTTP 200，`ready=true`；ASR/LLM/embedding/VAD/CAM++、任务 worker、三库 WAL 完整性、磁盘和 R2 配置均有响应。
- `/api/ready` 首次探测约 5.97 秒，原因是候选启动后的 provider readiness probe；同一进程第二次探测约 81.9 毫秒。该延迟证据只属于候选，不改变生产。
- 候选日志中的请求与阶段事件已改为隐私安全字段；不输出会议正文、标题、人物、文件名或原始实体标识。静态门禁见 [privacy log audit](PRIVACY-LOG-AUDIT-20260819.md)。
- 设备实时断线恢复和无语音回放见 [device-v2 realtime reconnect](../vnext-stage2/DEVICE-V2-REALTIME-RECONNECT-20260819.md)。

删除门报告：`docs/vnext-stage5-deletion-audit-20260819-34c488d.json`。五个 capability barrier 仍未激活，报告中的 `safe_to_delete=false` 保持不变。
