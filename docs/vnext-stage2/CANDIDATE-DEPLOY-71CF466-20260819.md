# 隔离候选部署 71cf466（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`，PID `1176837`。
- ASR：隔离 `127.0.0.1:8031`，生产 `8030` 未重启。
- release：`/home/zhong/laoji-vnext-candidate/releases/71cf466`。
- 可回滚 release：`f6974e0`、`db8259a`、`d193dd2` 均保留。
- 服务端包：`artifacts/vnext-candidates/1.1.13-121/laoji-vnext-server-candidate-71cf466.tar.gz`。
- SHA-256：`d8be25feaab92d87ee3174fbf038aee514479b1b47b864c289702f8c6e078b32`。

启动 `/api/ready` 通过，候选任务队列为 `queued=0/running=0`，R2 ready，`capability_cutovers`
仍为空。v2 Graph API 的代码已部署，保持能力关闭，不产生候选流量。
