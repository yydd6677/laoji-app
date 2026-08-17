# 研究 0015：durable speech owner 对称选择

## 触发

- parent: [revision 0009](../revisions/0009-durable-speech-execution-owner-20260816.md)
- evidence: [DBOS 0021](../evidence/candidate-0021-dbos-speech-durable-owner-selftest-20260816.md)
- evidence: [Restate 0023](../evidence/candidate-0023-restate-speech-durable-owner-audit-20260816.md)
- researched: `2026-08-16 Asia/Shanghai`
- status: architecture comparison; **not adopted**

0009 正确撤销了旧 worker + 新 ledger 的双 owner，但实验顺序过早偏向外部 durable runtime：
同库 clean-room SQLite executor 尚未按同一合同实现，就先选择 DBOS 并强制 Restate challenger。
当两个框架都引入独立持久状态、正文 journal 和版本 drain 问题时，这种顺序不能证明它们
比受限的单库执行器更简单。

## 统一权威边界

所有候选必须满足同一边界：

```text
execution owner  -> invocation / retry / cancellation / handler revision
domain DB        -> generation reservation + active pointer + immutable results + overlays
mobile           -> projection cursor + local manual/delete transaction
```

- generation 必须由 domain DB 的同一事务分配，执行 runtime 不保存另一份业务 generation；
- runtime/system journal 只能保存 opaque asset/source/operation ID、revision 和 digest；
- 外部 decode、ASR、speaker、R2 和通知均是 at-least-once，必须以 operation ID 自行幂等；
- 旧 worker 结构上看不到新合同，不依赖 feature flag 或约定退出；
- 普通进程崩溃自动恢复；物理库丢失属于灾难恢复，只允许配对快照或显式放弃旧 invocation
  并创建新 generation，不能由另一库静默重建 owner。

## 对称候选

| 候选 | 持久执行状态 | 业务结果状态 | 常驻代价 | 当前状态 |
|---|---|---|---:|---|
| D0 单库 executor | domain SQLite 中受限 run/stage 表 | 同一 SQLite | 无新进程 | 未实现，必须 challenger |
| D1 DBOS 0006 | DBOS system SQLite | domain SQLite | 嵌入 API | self-tested，`BLOCK` |
| D2 Restate 0007 | Restate log/state | domain SQLite | Restate + service | self-tested，独立 `BLOCK` |
| D2b Restate short reserve | Restate workflow/object | domain SQLite | 同 D2 | 未实现；只作反事实 |

### D0：受限单库 executor

D0 不是给旧 job 再补列，也不是通用 Artifact/Event/Lease 框架。它最多新增：

1. `speech_runs`：operation、asset、generation、handler revision、phase、attempt、next run、
   cancellation 和错误投影；
2. `speech_stage_results`：稳定 operation/stage key、opaque output ref/digest 和完成水位。

API 在同一 `BEGIN IMMEDIATE` 事务中 reserve generation、切换 active pointer并插入 run。
systemd只运行一个新 worker；启动仅扫描这一张 run 表。外部 action 允许重复，stage result和
domain publish按 operation ID幂等。它不导入旧 recording job、draft/final writer，也不允许
第二个 recovery scanner。

SQLite single-writer和原子事务只是底层前提，不是候选正确性证明。D0 必须接受与框架候选
相同的 crash、并发、版本、隐私和真实适配测试。

### D1：DBOS

0006 已证明 process exit恢复、重复 step + 单次 domain commit、late generation、历史保留和
manual CAS。阻断项为：

- system/app 两个 SQLite故障域及单边恢复；
- 合成正文作为 workflow input/step output进入 system tables；
- 固定 application version，没有连续升级和旧版本 drain；
- SQLite 是官方开发/测试默认，单机生产例外尚未用破坏性测试证明；
- 未接真实媒体、8030、CAM++、取消和优先级。

官方“生产推荐 PostgreSQL”不能单独否决或放行单机 SQLite。只有统一门禁结果能决定。

### D2：Restate

0007 已真实证明 service/server crash恢复、per-key single writer和 external action 重复时
domain commit幂等；也证明当前形态不可采用：

- 长 exclusive handler阻塞同 asset新 generation reserve；
- ingress payload和 run result正文进入 journal；
- runtime/domain单边丢失只能 409 fail closed，尚无配对恢复；
- 多次复跑 Restate RSS `253.5-303.1 MiB`、运行中空 base-dir实际分配约 `273.3 MiB`，
  另有约 `28 MiB` service 和 `211 MiB` binary；
- 没有版本化 deployment drain、真实 adapter和删除审计。

D2b 若实现，只能把 per-asset exclusive handler缩为 reserve/cancel/publish；每 request
Workflow执行长步骤，publish回 domain DB 做 generation fence。它仍必须消除业务 generation
K/V镜像和明文 journal，不能只是拆函数。

## 统一证伪门禁

任一失败即 `BLOCK`：

1. 八个阶段边界各注入 50 次崩溃，`400/400` 后 active result唯一、历史完整；
2. 64 个同 asset重复/新请求跑 100 轮，新 generation能在旧 ASR阻塞时完成 reserve，旧提交
   全部 superseded；
3. runtime/app DB删除、回滚、只读、磁盘满、WAL busy和错配恢复矩阵全部检测并 fail closed；
4. 正文、姓名、源路径 canary在非授权持久层、journal、日志和 introspection中匹配为 `0`；
5. 连续三次 handler/application/deployment升级，在每阶段保留在途任务，无原地强制覆盖、
   双执行或永久悬挂；
6. mobile在 cursor、text、speaker、manual、delete SQL边界各退出 100 次，只能恢复完整旧
   snapshot或完整新 snapshot；
7. 真实旧 worker对新任务 claim/write次数为 `0`；
8. D0/D1/D2b用相同工作负载测 RSS、运行/关闭磁盘、冷启动、恢复延迟和 journal增长，
   只有正确性均通过后才选择概念和运维成本最低者。

## 选择

下一隔离候选选择 D0，因为它补齐当前比较中缺失的最小故障域，不是因为已认定它最好。
DBOS 0006 进入独立破坏性审计；Restate 0007停止继续修长 exclusive handler；D2b只在 D0
无法满足恢复/版本门禁或概念数反而更多时实现。mobile 0005并行做真实 repository transaction
审计，但不接生产 App。

官方参考：

- [SQLite isolation](https://sqlite.org/isolation.html)
- [SQLite atomic commit](https://sqlite.org/atomiccommit.html)
- [DBOS databases](https://docs.dbos.dev/python/tutorials/database-connection)
- [DBOS workflow upgrades](https://docs.dbos.dev/python/tutorials/upgrading-workflows)
- [Restate handlers](https://docs.restate.dev/foundations/handlers)
- [Restate service versioning](https://docs.restate.dev/services/versioning)

