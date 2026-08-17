# summary-v3 持久 owner 对照 2026-08-16

## 观测边界

本报告来自服务器只读 SSH、服务源码读取和隔离候选回放；没有写数据库、重启服务、改配置或调用生产任务。

- service: `laoji-api.service`
- systemd executable: `/home/zhong/laoji-service-platform/.venvs/laoji-compact-py312/bin/python`
- command shell `/usr/bin/python3`: `3.10.12`（不能代表服务运行时）
- service unit: uvicorn `app.main:app`, `127.0.0.1:18020`, one worker
- observed service start: 2026-08-16 01:14:41 CST
- source cwd: `/home/zhong/laoji-service-platform/compact-production/backend`

## 现有 owner 的事实

远端 `app/services/summary_task_store.py` 的 `summary_tasks_v2` 表包含：

- task identity、task kind/scope/meeting、dedupe key 和 request JSON；
- queued/running/success/failure、stage、attempt；
- lease owner、lease expiry、heartbeat；
- checkpoint、result、error、retention/expiry；
- SQLite WAL、foreign keys、busy timeout、`BEGIN IMMEDIATE` claim/create。

`app/workers/summary_tasks.py` 调用该 store 完成 create、claim、lease renewal、stage update、checkpoint、success/failure 和 recoverable task 扫描。它不是只存在内存的假 owner。

同时，worker 内仍有 `_guest_summary_task_ids`、Future/dedupe/serialization maps 等进程内结构；这些是重复的执行协调状态，但不能因此把 `summary_tasks_v2` 判定为没有消费者或没有恢复能力。

## 与候选 0003 的逐项比较

| 能力 | 现有 summary_tasks_v2 | 候选 0003 Artifact ledger | 判断 |
|---|---|---|---|
| 持久 task owner | 有，包含 claim/lease/recovery | 只有 operation row，无 worker claim/lease | 候选不能替换 owner |
| 来源版本 | request 内可携带，但需业务校验 | Artifact ref + 写事务 current-pointer CAS | 候选的数据合同更明确 |
| 增量结果 | result/checkpoint 以 task 为中心 | partial/stable/final Artifact 可独立投影 | 候选适合做结果层 |
| 任务取消 | 当前 store 没有完整 cooperative cancel 合同 | 有 cancel request/late output rejection 合同 | 两者都尚未证明外部推理 abort |
| 恢复 | lease expiry、recoverable scan、checkpoint | SQLite 重开和幂等，未做 worker recovery | 现有 owner 更完整 |
| 用户编辑 | 不负责本地投影 | 独立 edit overlay | 候选适合本地 projection |
| graph/step | worker 内部流程和 checkpoint，非通用 graph | operation 仍不执行 graph | 两者都不能宣称 durable graph |

## 结论

1. 候选 0003 不得新增第二个生产 task 表。它应作为同一 SQLite 数据库中的 Artifact/result projection 对照，或在隔离环境中把 Artifact 表附着到现有 task owner。
2. 下一项最小纵向实验应模拟“一个 `summary_tasks_v2` operation + 一组 Artifact 表 + 一个事务提交”：task 的 claim/lease/retry 仍由旧 owner 负责，Artifact 的 source CAS 和 projection 由候选负责。实验必须证明旧 worker 的重复 maps 可以删除一组，而不是继续双写。
3. 若实验需要新的独立 claim/retry/lease 表，或无法在旧 task owner 事务内完成 Artifact commit，就否决该收敛方向，转回只做事实投影而不改任务系统。
4. 不能把 shell Python 3.10.12 当作服务兼容性证据；Linux/Windows 和 Python 3.12 的候选测试仍需独立运行。

## 下一轮门禁

- 同一 task id 在 claim、provider 返回、source revision 变更、commit 和 worker ack 各故障窗口只产生一个 active Artifact projection；
- 旧 `summary_tasks_v2` 仍能恢复 task，Artifact commit 不会绑定新 transcript；
- 至少删除一套 worker 内存 dedupe/serialization owner；若做不到，候选不进入 adopted；
- 仅使用隔离复制数据库和合成/脱敏 fixture，不触碰生产数据库。

本报告不授权迁移、双写生产或删除旧代码。
