# 设备数据域清理加固验收（2026-08-09）

## 发现

关闭设备数据域原本只删除主库中会议及其外键子表、设备控制表和声纹 profile/embedding。`summary_tasks_v2` 是独立的 SQLite 任务表，不受会议外键级联影响，因此已删除 epoch 的整理正文、检查点和任务请求引用可能继续留存。声纹识别日志同样以匿名 profile ID 独立存储，原先的 epoch 删除没有一并清理；声纹库清理失败也只记录日志，没有可恢复状态。

## 修复

- `close_epoch` 在关闭前写入 `device_speaker_cleanup_outbox`，并删除精确 `device:<principal_id>:<epoch_id>` 任务范围中的 `summary_tasks_v2` 行，包括已开启质量留存的结果。
- 声纹清理改为幂等、可重试的 outbox；关闭请求立即尝试一次，数据库锁或进程异常时保留 pending 行，由启动和 retention loop 再次 drain，不让已关闭 epoch 永久保留声纹。
- `delete_owner_epoch` 在删除 profile/embedding 时同时删除 `speaker_identification_log`。
- `purge_expired_device_data` 会清掉历史实现遗留的、属于非 active epoch 的 device summary task，并回收已完成的声纹清理提示。

## 证据

- 服务器源码备份：`/home/zhong/laoji-service-platform/compact-production/backend/backups/device-epoch-cleanup-hardening-20260809-234127/`。
- 当前服务器源码 SHA-256：`device_identity.py` `fc4025425677a21d7470368f7188b15ed7b06fa30901a7a685cd2105578c6c5b`；`speaker_db_service.py` `fa4d5908732d16501b9bda9f4cf5ce3769dedaa65c42d648efe8e00e4ca10f01`。
- 修改前现场发现 3 条属于已删除临时 epoch 的整理任务；API 重启加载新代码时自动清理，之后仅剩 1 条 active 设备 epoch 的任务。
- 隔离 SQLite 回归：epoch 删除同时移除会议、整理任务、profile、embedding 和识别日志；合成声纹库失败后返回 pending，恢复依赖后再次 drain 成功。
- 公网 loopback 真实探针：新设备注册、会议绑定、创建持久整理任务、写入声纹及识别日志后调用 `DELETE /api/device/v1/epochs/{epoch}`，返回 `summary_tasks_deleted=1`、`speaker_count=1`、`speaker_cleanup_pending=false`；随后数据库扫描均为 0，`/api/ready` 仍为 `ready=true`。
- 加固后四个 systemd 单元均为 `active`，三库 WAL/完整性/外键检查通过；GPU、Tunnel 和其他用户服务未改动。

## 边界

这项修复只收紧设备域删除和隐私留存边界，不替代延期的会议问答专题、真人声纹纵向质量、真机验收或完整历史 pytest 验收。
