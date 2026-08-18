# Stage 5 候选删除门复核 R2（2026-08-19）

状态：`safe_to_delete=false`。本次只读复核未删除文件、未改数据库、未停止进程、未启用 capability barrier，
也没有切换公网流量。

## 审计对象

- 隔离候选 API：`127.0.0.1:18021`，候选进程仍在运行；生产 `18020` 未触碰。
- 隔离候选 ASR：`127.0.0.1:8031`；既有 ASR 服务和其他用户服务未触碰。
- 候选数据库：服务器 `/home/zhong/laoji-vnext-candidate/api-data/api-asr-retry.db` 的只读副本。
- 审计命令：`python3 tools/vnext/audit_stage5_deletion_gate.py . --database <candidate-db> --json-out <report>`。

## 运行时证据

候选 API 最近一次 `/api/ready` 返回 `ready=true`，ASR、生成模型、embedding、VAD/CAM++ 和任务 worker 均 ready，
任务队列深度为 0，磁盘可用约 `466.4 GiB`。这只证明候选服务当前健康，不证明 capability 已达到切换条件。

服务器候选 API 进程的 RSS 约 `845 MiB`，ASR 进程约 `540 MiB`；这些是进程快照，不是生产资源预算验收。

## 删除门结果

| 检查 | 结果 |
| --- | --- |
| 五个 capability cutover | `0` 行；`media.upload`、`transcript.realtime`、`summary`、`question`、`schedule` 均未激活 |
| 活动源码遗留引用 | `291` 个：account sync 241、旧上传 3、旧整理/Q0 37、旧日程 10 |
| 旧媒体写入门静态合同 | `7` 个 `device_v1` POST/PUT `/assets` 路由，`0` 个未调用 `_guard_legacy_media_submit()` |
| 任务状态 | `failure=2`；任务本身无 active 状态 |
| attempt/租约状态 | `retryable_failure=6`，生命周期未排空 |
| 上传状态 | `verified=3`、`cancelled=1`，无未完成上传 |
| 转写状态 | `failed=2`，无运行中转写 |
| purge 状态 | `confirmed=3`、`running=2`，仍有运行中的清理任务 |
| R2 清理义务 | `confirmed=7`，未发现待清理状态 |
| 旧客户端 task-id 查询恢复 | `unverified`，没有本地记录可以证明完整回放 |
| 完整公开周期 | `missing`，不能用“没有真实用户”替代外部周期记录 |
| 删除执行 | `false` |

## 结论

当前候选可以继续做隔离测试，但不能进入 Stage 5 删除或生产切换。直接阻断项是：

1. 五个能力没有持久 activation、legacy submit closed 和 reader removal 记录。
2. 源码仍保留设备旧上传、旧日程、旧同步和旧整理兼容路径；这些引用没有被误判为可删除。
3. 有 6 个 retryable attempt 和 2 个 running purge，不能宣称任务与回收生命周期已排空。
4. 没有旧客户端查询恢复和完整公开零流量周期的外部证据。

因此旧上传、旧 ASR、summary v2/Q0、旧问答、旧日程 parser、mirror/fallback 和旧模型继续保留；下一步仍应先完成
设备回放、能力 barrier 证据、legacy drain 和公开周期记录，再重新执行本报告。物理删除保持禁止。
