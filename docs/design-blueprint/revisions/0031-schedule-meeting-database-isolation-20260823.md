# 0031 日程与会议数据库隔离

- date: 2026-08-23
- status: `selected and implemented in source`
- supersedes: `VNEXT-IMPLEMENTATION.md` 原“不得新建第二业务数据库”决定
- scope: Android/React Native 本机持久化、升级、删除和恢复

## 触发事实

为清理会议残留而执行安装级 `pm clear` 后，日程与会议一同消失。`pm clear` 无论是否拆库都会删除整个
应用沙箱，因此它不是拆库有效性的证明；但复盘发现日程仓储直接使用名为
`laoji-meeting-memory.db` 的会议库，蓝图也没有为会议清理、数据库重建、迁移失败和损坏恢复定义独立
故障域。这使任何误用 `deleteMeetingDatabase`、文件级恢复或会议库替换都具备删除日程的能力。

## 修订决定

1. `laoji-schedule.db` 是日程唯一持久 owner，保存 `local_schedule_events` 和 calendar projection
   checkpoint。
2. `laoji-meeting-memory.db` 不再接受日程事件写入；会议中的日程关联只保留稳定 ID 和不可变快照。
3. 两库禁止 `ATTACH` 和跨库外键。跨领域动作使用稳定 ID、幂等 request 和可重试 application use case。
4. 会议清理、媒体残留清理、会议库重建和会议恢复器无权删除或打开日程库。
5. 用户明确选择“清除全部本机数据”时，协调器分别删除两库；安装级 `pm clear` 不属于领域维护方案。

## 可恢复升级

新库初始化按以下顺序执行：

1. 创建 schedule schema v1、WAL 和元数据行。
2. 若 `legacy_import_completed_at_ms` 为空，读取旧会议库 `local_schedule_events`。
3. 在新库单一事务中逐行 `INSERT` 日程及既有 calendar checkpoint，并逐字段核对 ID、JSON、revision、
   provenance、投影 hash 和时间戳。
4. 核对全部通过后，在同一事务写入来源数据库版本、日程/检查点行数和完成时间。
5. 事务提交后才删除会议库旧日程表和 calendar checkpoint，并登记 `schedule_database_v1` closed tombstone。
6. 若退役步骤失败，新库仍是唯一活跃 owner；下次启动重试退役，不恢复双写。

完成标记前崩溃会整体回滚复制；完成标记后、旧表删除前崩溃会保留已验证新库并在下次继续退役；旧表
删除后、退役时间未回写前崩溃会把“表不存在”作为幂等成功。已有 AsyncStorage 兼容日程只可导入新库。

## 验证合同

- `localScheduleRepository` 不得导入会议数据库函数。
- `calendar` ProjectionEnvelope checkpoint 必须路由到日程库，其他会议 surface 留在会议库。
- 删除会议数据库文件后，日程事件与 calendar checkpoint 必须仍可读且 integrity 为 `ok`。
- 完整本机清除必须分别列出两个数据库 owner；任一步失败均在结果中报告具体步骤。
- 禁止通过 `pm clear`、删除整个 SQLite 目录或恢复整目录来修复单个会议问题。

自动合同入口：`python3 tools/vnext/verify_schedule_database_isolation.py`。
