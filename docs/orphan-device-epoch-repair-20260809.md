# 临时审计孤儿 epoch 修复（2026-08-09）

源码同步后的设备日程回归中，临时清理脚本直接删除设备主记录时没有开启 SQLite 外键，留下 1 条已删除状态的 `device_epochs` 孤儿行（`principal_id=75`）。这使 `/api/ready` 正确降为 `not_ready`，暴露了完整性检查的有效性。

- 修复前备份：`/home/zhong/laoji-service-platform/compact-production/backend/backups/orphan-device-epoch-20260809-r1/local.db`
- 备份 SHA-256：`94042a3882ca5565a96a2aef5805aefb75d9565b1a6bb737e088dcae1db1db55`
- 停写期间删除孤儿 epoch：发现 `1`、删除 `1`；其余设备控制表关联数为 `0`。
- 修复后：`integrity_check=ok`、`foreign_key_check=0`、三库 ready、四项服务 active、ASR/任务队列为 0。

生产 `device_identity.close_epoch()` 使用自身启用 foreign keys 的连接并保留已删除 epoch，不存在这次测试脚本造成的 orphan 路径。后续临时审计清理必须同时设置 `PRAGMA foreign_keys=ON`，并在删除主记录前/后复核完整性。
