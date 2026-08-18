# vNext 隔离候选部署 958c9f2（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`，cwd 为 `/home/zhong/laoji-vnext-candidate/releases/958c9f2/services/laoji-api`。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 生产 `18020/8030`、公网入口、GPU1、PCB、Smart Meeting 和其他服务未修改。
- 上一候选 `fb268c8` 保留，可回滚。

补上了 device-v1 的 4 个旧 producer 绕过点：`/schedule/parse`、`/schedule/parse-audio`、
`/schedule/clarify` 和 `/meetings/{binding_id}/questions`。静态合同现在覆盖 12 个旧整理/问答/日程入口，
`missing_count=0`。候选 ready、队列为 0，capability barrier 仍全部关闭，删除门仍未通过。
