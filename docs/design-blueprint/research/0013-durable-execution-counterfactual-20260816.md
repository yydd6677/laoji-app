# 研究 0013：语音任务是否应改用 durable-execution runtime

## 状态

- observed/researched: `2026-08-16 Asia/Shanghai`
- status: `counterfactual research`; **no framework adopted**
- production mutation: none
- question: 0008 的 owner convergence 是否只是因为现有 SQLite 方便，而错过了更先进的
  durable-execution 重做路线？

## 比较对象

| 路线 | 持久 owner | 新增运行概念 | 当前判断 |
|---|---|---|---|
| C0 | in-process queue + job/draft/checkpoint/final 的混合 | 无新增，但 owner 漂移继续存在 | 只作生产回滚基线 |
| M1-O | 现有 job attempt/asset generation/manifest/canonical 同库事务 | 一个 job 子 manifest、一个手机只读 speaker overlay | 当前隔离候选；尚未通过独立复核 |
| DBOS | workflow/step/system DB + application datasource | workflow identity、deterministic replay、system tables、version/patch | 暂不采用；保留触发条件 |
| Restate | 独立 durable log/partition state/runtime | 新服务、journal、RocksDB/持久卷、运维/备份 | 当前资源与拓扑不适合 |
| Temporal | 独立 workflow service + persistence + workers | 新集群/服务/数据库/worker 协议 | 超出个人单机生产边界 |

## DBOS

DBOS Python 当前默认可用 SQLite system database，也提供 SQLAlchemy datasource，把
应用数据库事务与 workflow execution 记录结合。官方同时明确：SQLite 适合原型和测试，
生产建议 Postgres；workflow 要保持 deterministic，非确定性数据库/网络调用必须放在
step/datasource；并发序列还要符合 durable execution 的启动顺序。

来源：

- [DBOS database connections](https://docs.dbos.dev/python/tutorials/database-connection)
- [DBOS workflows](https://docs.dbos.dev/python/tutorials/workflow-tutorial)
- [DBOS transactions and datasources](https://docs.dbos.dev/python/tutorials/transaction-tutorial)
- [DBOS workflow upgrades](https://docs.dbos.dev/python/tutorials/upgrading-workflows)

它能替代老记的 retry/recovery/timeout 部分，但不能自动拥有：

- asset active generation；
- segment/source identity；
- text/speaker 双 revision；
- 人工 speaker lock 优先级；
- 手机 projection CAS。

如果只给现有 worker 外包一层 workflow，而旧 job/checkpoint/final 仍可写，会形成第五套
状态而不是收敛。要真正采用，就必须让 DBOS datasource transaction 取代当前 job claim、
checkpoint owner 和 queue recovery，并接受 system DB/版本化 workflow 的长期运维。

当前老记明确不引入 PostgreSQL，且只有单机偶发并发。为一条语音管线增加 system DB
与 workflow history 的复杂度，尚无速度、资源或正确性收益证据。DBOS 因此保留为
`future alternative`：只有出现多 API 实例、跨进程任务数量显著增加、现有 SQLite CAS
在真实故障矩阵持续两轮失败，或产品接受 Postgres 时重开。

## Restate

Restate 可作为单一自包含二进制运行，也能持久恢复 handler；但它本身拥有 durable log、
partition processor state 和 RocksDB cache，单节点仍要求持久卷，可靠性由磁盘和备份
决定。集群模式还引入复制、对象存储和额外控制面。

来源：

- [Restate quickstart](https://docs.restate.dev/quickstart)
- [Restate self-hosted overview](https://docs.restate.dev/server/overview)

这对跨服务、高吞吐、长期 durable invocation 有价值，但老记当前目标是压缩为
`Nginx + API + ASR + Ollama/Provider`，而非增加一个新的状态服务。即使引入 Restate，
应用数据库里的 canonical、人工 speaker assignment 和手机 projection 仍要独立设计。
因此它当前被判为 `architecturally valid but resource-misaligned`，不是质量更差。

未来只有当老记需要多节点 API、跨服务编排、长期 timer/notification，且愿意为 durable
log 配置持久卷、备份和额外进程时再比较。

## Temporal

Temporal 的 worker/workflow 模型适合大规模跨服务编排，但自托管需要独立服务与持久化
层。当前没有证据证明老记单用户音频任务需要这一成本；它作为规模上升后的基准，不进入
本轮原型。没有安装、下载或运行 Temporal。

## 反事实结论

M1-O 被保留不是因为它最接近旧代码，而是因为它当前有机会**删除**状态：

- 用 job attempt 删除“进程活着就是 owner”的隐含假设；
- 用 source cursor/EOF 删除 `max(end)` 假水位；
- 用 asset generation 删除旧 run 迟到写；
- 把 filesystem checkpoint 降为缓存；
- 用手机 remote projection cursor 删除 timestamp/count revision；
- 用独立只读 speaker overlay 避免复制整份 final transcript。

但 candidate 0004 的自测并未证明这些删除已可嵌入。独立审计已经初步发现真实 v1
在途 owner、SQLAlchemy 必填列和手机 speaker immutability 反证；修订前仍是
`REVISE`，不能因为框架替代成本较高就放宽当前候选门禁。

## 下一次重开框架替代的门槛

满足任一条件时重新比较 DBOS/Restate/Temporal：

1. M1-O 在同一 owner 假设上连续两轮仍无法通过 crash/recovery；
2. API 由单实例扩展为多实例，SQLite 单 writer 成为真实 p95 瓶颈；
3. 日程、上传、转写、整理和问答都需要跨服务 durable workflow，且能删除三套以上旧
   task owner；
4. 用户接受 Postgres 或新的持久 runtime、备份和运维成本；
5. 隔离同 PCM/同故障对照证明框架方案在正确性或恢复时间上有实质收益。

在此之前继续 M1-O，但每次修订必须列出删除对象；若只增加列、表和 projector 而不
删除旧 owner，本研究的支持结论立即失效。
