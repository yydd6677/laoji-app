# 设备失败源文件留存边界验收（2026-08-09）

## 发现

设备转写成功和 `no_speech` 终态原本会立即清理服务器源文件，但普通可重试失败会保留 `storage_path`，仅依靠回收站物理清理。这不符合计划中“失败终态最长 24 小时”的隐私边界。

## 修复

- 在 API retention loop 中增加设备源文件失败/孤儿 TTL 清理，周期仍由现有 retention loop 驱动。
- 只选择 `data_epoch_id` 非空、会议与资产 epoch 一致、资产仍有 `storage_path`，且没有任务或当前最新转写任务已经是超过 24 小时的 `failed/completed` 终态的设备资产。
- 删除路径先经过既有音频根目录约束，再在线程池执行文件删除；成功后清空资产和会议音频路径，资产标记 `processed`，任务标记不可重试并写入 `recording_source_expired`。
- 旧失败任务不会覆盖后续排队、运行或新完成的任务；账号资产不参与该清理。

## 证据

- 第一版部署备份：`/home/zhong/laoji-service-platform/compact-production/backend/backups/device-source-failure-retention-20260809-110917/meeting_retention_service.py.before`；随后补充孤儿/成功终态保护的备份：`/home/zhong/laoji-service-platform/compact-production/backend/backups/device-source-failure-retention-orphan-20260809-111817/meeting_retention_service.py.before`。
- 当前部署源码 SHA-256：`3850c3ae4687663dd22024dff1fc93e21ec4a4dd511fbeb9682af3f198f3c646`。
- 隔离 SQLite + 临时音频目录回归：过期失败源、无任务孤儿源和过期成功终态源被删除并清空数据库路径；最近失败源、存在更新任务的源、账号源均保留，结果 `PASS`。
- 生产函数现场执行返回 `(0, 0)`，表示当前没有需要清理或清理失败的过期设备源；随后 API 有序重启，四个服务均 active，`/api/ready` 为 `ready=true`，队列与活动租约为 0。
