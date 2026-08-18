# vNext 隔离候选部署 bb38e64（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`，cwd 为 `/home/zhong/laoji-vnext-candidate/releases/bb38e64/services/laoji-api`。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 生产 `18020/8030`、公网入口、GPU1、PCB、Smart Meeting 和其他服务未修改。
- 上一候选 `958c9f2` 保留，可回滚。

本候选补齐 App 音频 `/audio`、`/upload`、兼容 recording-assets/content/transcriptions/retry，以及
device-v1 `/summary` 和 `/summary-v3` 的旧媒体/整理 guard。媒体静态合同覆盖 6 个账号兼容入口，
生成合同覆盖 14 个整理/问答/日程入口，均无漏门。候选 ready、队列为 0，capability barrier 仍全部关闭。
