# 隔离候选部署 ccb65f0（2026-08-19）

状态：`isolated candidate deployed; production unchanged`。

## 变更

- 服务端候选包：`5cd231e6d3b602b50afc0245bd53f4d3b9df2cc2fc5c500fabf38426cf7e6f31`，大小约 824 KiB。
- 新 release：`/home/zhong/laoji-vnext-candidate/releases/ccb65f0`。
- 仅重启隔离 API `127.0.0.1:18021`，旧 `0eae538` release 保留用于回滚。
- 明确设置候选 API 的 ASR 地址：
  - `LAOJI_INTERNAL_ASR_PORT=8031`
  - `QWEN_ASR_READY_URL=http://127.0.0.1:8031/ready`
  - `QWEN_ASR_V2_BATCH_URL=http://127.0.0.1:8031/v2/asr/batch`
- `LAOJI_VNEXT_REALTIME_V2_ENABLED=0`、`LAOJI_VNEXT_MEDIA_UPLOAD_BARRIER_ENABLED=0`，候选能力仍
  fail-closed。

## 发现的隔离缺口

旧候选 API 日志原先请求 `127.0.0.1:8030/ready`，会让隔离 API 观察到生产 ASR。此次部署通过显式
环境变量修正，重启后日志确认请求已指向 `8031`。这是候选部署缺陷修复，不涉及生产配置。

## 运行核验

- API：`18021 /api/ready` 返回 `200`、`ready=true`。
- ASR：`8031 /ready` 返回固定 revision
  `7278e1e70fe206f11671096ffdd38061171dd6e5`。
- API readiness 的 ASR、Ollama 9B/embedding、VAD/CAM++、任务 worker、三库 WAL/完整性和磁盘检查
  均通过。
- API 进程 cwd：`/home/zhong/laoji-vnext-candidate/releases/ccb65f0/services/laoji-api`。

## 回滚

停止当前候选 API，使用保留的 `0eae538` release 和原候选环境重新启动即可。未删除旧目录、未修改
生产 systemd、GPU、R2、公网或数据库；候选 API 使用独立 SQLite 数据目录。

