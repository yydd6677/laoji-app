# 整理任务原始输入留存边界修复（2026-08-10）

## 发现

设备主链路的 `device-final` 任务已经只保存会议引用、模板和 revision，但旧账号兼容路径仍把完整 `worker_args` 写入 `summary_tasks_v2.request_json`。生产数据库中发现 38 条历史 `final` 任务，最大请求字段为 49,727 字节；这与“服务端不长期保存原始转写、生成结果可按开关保留”的新产品边界不一致。

## 修复

- `summary_tasks.py` 的持久化条件改为 `task_kind.startswith("device-")`。设备任务仍由 SQLite 任务表、租约、检查点和重启恢复机制负责；账号/旧兼容整理只在进程内运行，不再把转写参数写入持久任务表。
- 生产切换前将 `local.db` 通过 SQLite backup API 保存到服务器备份目录；随后仅更新非 `device-*` 任务的 `request_json` 为不含正文的脱敏标记，保留任务状态、生成结果和任务 ID，未删除生成式结果。

## 证据

- 工作区/服务器当前 `summary_tasks.py` SHA-256：`b80a88406d250b9acd265b0299a2df2176dd77a9b60d4a5ae7f39137c71e4c39`。
- 部署前源码备份：`/home/zhong/laoji-service-platform/compact-production/backend/backups/account-summary-input-redaction-20260810-002937/summary_tasks.py.before`。
- 临时数据库快照在验证后已删除：原文件大小 `7,155,712` 字节，SHA-256 为 `343b7a18f5311c58009c3f9ab103f40a82775faa8e4af3467e43d84378830432`；删除前可读且完整性检查通过，避免把原始请求作为长期回滚副本留在服务器。
- 生产更新前后：38 条非设备任务由最大 `49,727` 字节降为 `57` 字节，残留 `transcript`/`worker_args` 原始请求标记为 `0`。
- 更新后 `PRAGMA integrity_check=ok`、`foreign_key_check` 为 0、journal mode 为 WAL；有序重启 `laoji-api.service` 后 `/api/ready` 为 `ready=true`，ASR/LLM/支持模型、队列和任务 worker 均正常。

## 边界

这项修复不删除已保留的生成结果，也不改变 `device-final` 的恢复协议；会议问答质量、真人声纹纵向质量和真机验收仍是独立延期项。
