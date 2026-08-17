# 研究 0014：语音唯一 owner 的 durable runtime 重做

## 状态与问题

- researched: `2026-08-16 Asia/Shanghai`
- status: `runtime comparison + isolated prototype selected`; **not adopted**
- trigger: [candidate 0020](../evidence/candidate-0020-speech-owner-convergence-final-rejection-20260816.md)
- production mutation: none

问题已不再是“给旧 job 再加什么列”，而是：谁真正拥有 workflow ID、claim、恢复与代码
版本，并如何让旧 worker 无法写入新 generation。任何方案若只包住旧 worker、却保留旧
recovery scan，直接否决。

## 比较

| 路线 | 执行 owner | 单 key 串行 | 应用 DB 原子写 | 新常驻进程/状态 | 当前判断 |
|---|---|---:|---:|---:|---|
| C0 | 旧 in-process queue/job | 不可靠 | 普通事务 | 0 | 冻结回滚基线 |
| 自研 clean-room SQLite executor | 新 event/lease/outbox | 需自行证明 | 可同库 | 0 进程，多张 owner 表 | 暂缓；高概率重造 DBOS/Restate |
| DBOS Python 2.29 | workflow system DB | workflow ID/queue | datasource transaction 可与结果原子记录 | 嵌入 API；新增 system DB | 已建立隔离候选 0006 |
| Restate | durable log/journal；Virtual Object/Workflow | 原生 per-key single writer | 外部 DB 写仍需幂等/CAS | 新 Restate 进程、持久卷、log/RocksDB | 保留生产 challenger |
| Temporal | Temporal Service/workflow history | workflow ID | 外部 activity 幂等 | 服务集群与持久 DB | 当前单机资源不匹配 |

## DBOS

官方说明 workflow 在进程中断后从最后完成 step 恢复，workflow ID 是幂等键；step 至少
执行一次，datasource transaction 的应用写与 durability output 在同一数据库事务中记录，
从而只提交一次：

- [Workflows](https://docs.dbos.dev/python/tutorials/workflow-tutorial)
- [Transactions and Datasources](https://docs.dbos.dev/python/tutorials/transaction-tutorial)
- [Queues and Concurrency](https://docs.dbos.dev/python/tutorials/queue-tutorial)

这正面覆盖 M1-O 的两个致命缺口：运行时接管恢复，且 immutable generation 的提交不再
依赖旧 worker attempt。DBOS 可嵌入 `laoji-api`，不增加业务进程；旧
`meeting_recording_transcription_jobs_v2` 对新合同只保留兼容读投影或完全绕开。

限制同样明确：Python DBOS 默认可用 SQLite，但官方把 SQLite定位为 prototype/testing，
生产推荐 PostgreSQL；SQLite 也不能跨多服务器。datasource 可指向独立 SQLite 应用库，
但 workflow system DB 仍是额外 durable state：

- [Database connections](https://docs.dbos.dev/python/tutorials/database-connection)
- [Configuration](https://docs.dbos.dev/python/reference/configuration)

DBOS 代码升级也不是透明的。官方 versioning 会只恢复匹配 application version 的旧
workflow，并推荐 blue-green 保留旧版本进程到 drain；单机部署必须证明 drain/patching，
不能只升级 systemd 后假定旧 workflow 会继续：

- [Upgrading workflow code](https://docs.dbos.dev/python/tutorials/upgrading-workflows)

因此 DBOS 当前只获得 prototype 权限。采用门槛必须包含 PostgreSQL、SQLite 单机风险的
明确例外，或证明 Restate 更适合现有“无 PostgreSQL”约束。

## Restate

Restate Server 先持久化 invocation，再用 journal replay handler；Workflow 每 ID 只有一个
run，Virtual Object 对每 key 原生 single-writer。它比“DBOS + SQLite system DB”更明确
支持自托管单节点生产形态：单二进制、持久卷，耐久性取决于磁盘；内部仍增加 durable
log、metadata store 和 RocksDB materialized state：

- [Request lifecycle](https://docs.restate.dev/guides/request-lifecycle)
- [Services and per-key ownership](https://docs.restate.dev/foundations/services)
- [Self-hosted overview](https://docs.restate.dev/server/overview)

它的主要代价不是代码量，而是新常驻 stateful process 和备份对象。`ctx.run` 包装外部
应用数据库写时仍需要应用侧幂等/CAS，不能把 Restate journal 误当成 LaoJi domain
transaction。默认 idempotency/workflow/journal retention 还只有 24 小时，必须显式配置：

- [Service retention configuration](https://docs.restate.dev/services/configuration)
- [Durable steps](https://docs.restate.dev/develop/python/durable-steps)

若 DBOS 因 production SQLite、版本 drain 或同机锁竞争失败，下一原型必须是 Restate
Virtual Object keyed by asset，而不是再回到旧 job 补丁。

## Temporal 与自研 executor

Temporal 能提供长期 durable workflow，但自托管服务与持久层超过个人单机当前边界；它
只作为规模上升后的基准：[Temporal documentation](https://docs.temporal.io/)。

自研 clean-room SQLite executor 理论上能用一个 outbox/event log 取代旧 queue，但必须
自行重做 workflow ID、step outcome、恢复、版本、取消、重试与观察性。0003/0004 已证明
“看起来更轻”的 ledger 很容易变成第二 owner；在框架候选被真实资源或语义证伪前，不再
优先自研。

## 当前选择与概念预算

建立 `speech-durable-owner-dbos-0006`，只允许以下三个权威概念：

1. DBOS workflow history：唯一执行 owner；
2. immutable text generation + automatic/manual overlay：domain result/history；
3. mobile asset/generation/run/projection cursor：设备消费水位。

必须删除/绕开的旧 owner：legacy queue recovery、job attempt claim、draft current-owner、
filesystem checkpoint authority、final delete/reinsert canonical。旧表可在迁移期只读兼容，
不能继续写 v3。

原型先证明 `os._exit` 恢复、外部 step 至少一次而 domain transaction 一次、late old
generation 拒绝、重分段保留历史、manual expected revision CAS 和 speaker-after-EOF。
它不做 ASR 质量或性能宣传。通过后再由独立代理审计 DBOS system SQLite、版本升级、
取消和真实 worker 隔离；Restate 同合同回放仍是必要 challenger。
