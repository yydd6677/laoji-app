# 隔离候选部署 6a80576（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`，PID `1224481`。
- ASR：隔离 `127.0.0.1:8031`，生产 `8030` 未重启。
- release：`/home/zhong/laoji-vnext-candidate/releases/6a80576`。
- 回滚 release：`71cf466`、`f6974e0`、`db8259a`、`d193dd2` 均保留。
- 服务端包 SHA-256：`8c1132749e15a6961a9bf8e7aa23d071772e56eb18c5833cfbf53608768022a7`。

启动 `/api/ready` 通过，候选任务队列为空，R2 ready，`capability_cutovers` 仍为空；真实
model-only 日程回放结果见 [时间范围回放](../vnext-stage4/SCHEDULE-MODEL-RANGE-REPLAY-20260819.md)。
