# 蓝图修订 0010：durable owner 对称门禁

## 状态

- revision: `0010-durable-owner-symmetric-gates-20260816`
- status: `candidate`; **not adopted**
- parent: `0009-durable-speech-execution-owner-20260816`
- observed: `2026-08-16 Asia/Shanghai`
- production mutation: none

## 本轮重新审视

0009 已把 execution owner 从旧 recovery worker中剥离，但“先 DBOS、再 Restate”的实验顺序
没有包含同库最小 executor，无法证明外部 runtime是最简路线。Restate 0007 的真实崩溃
测试一方面确认 durable replay有效，另一方面证伪了长 per-asset exclusive pipeline：新
generation无法抢占旧任务，正文进入 journal，两套持久状态还需要灾难恢复。

因此撤销“框架候选优先”的隐含假设，恢复 D0/D1/D2 的对称比较。0009作为历史修订保留，
不回写其当时判断。

## 权威边界

```text
runtime/executor: invocation, retry, cancel, handler revision
domain DB:        atomic generation reserve, active pointer, immutable history, overlays
mobile DB:        projection cursor, local manual/delete atomicity
```

runtime不能另存一份业务 generation；domain DB也不能扫描并重建 workflow。双方通过稳定
operation ID、revision和 digest协作。运行时 journal只允许 opaque reference，不允许正文、
姓名或真实源路径。

普通 process crash必须自动恢复。任一持久库物理丢失属于 disaster recovery：启动检测错配
并 fail closed，只能从配对快照恢复，或明确取消旧 invocation后创建新 generation。

## 候选状态

- D0 单 domain SQLite executor：`BLOCK / not implemented`；下一候选，用于补齐最小故障域。
- D1 DBOS 0006：`BLOCK`；已 self-tested，待独立 crash/version/privacy/store-loss审计。
- D2 Restate 0007：`BLOCK`；`8/8 + 6/6` 自测和 runtime审计完成，长 exclusive形态停止。
- D2b Restate short reserve + request Workflow：仅保留反事实，D0未证伪前不实现。
- mobile 0005：`BLOCK integration`；reducer/SQLite通过不等于真实 repository原子恢复。

完整比较与统一门禁见
[research 0015](../research/0015-durable-owner-symmetric-selection-20260816.md)，Restate 实测见
[candidate 0023](../evidence/candidate-0023-restate-speech-durable-owner-audit-20260816.md)。

## D0 概念预算

D0 不得复制旧任务系统，只允许：

1. `speech_runs`：唯一执行状态机和恢复来源；
2. `speech_stage_results`：按 operation/stage幂等的 opaque result ref/digest；
3. 既有 immutable generation/result/automatic/manual domain表；
4. 一个 systemd worker进程中的单恢复循环。

不得新增通用 event bus、Artifact ledger、第二 lease框架或第二 recovery scanner。API reserve
generation、active pointer和 run必须在同一 SQLite事务完成；旧 worker表和路径不能看见
新合同。外部 ffmpeg/ASR/CAM++ 是 at-least-once，domain publish必须幂等和 generation-fenced。

## 当前门禁

本轮锁定八项对称门禁：阶段崩溃 `400/400`、同 asset并发 `6400` 轮次事件、存储损坏矩阵、
隐私 canary `0` 泄漏、三次版本升级、mobile SQL边界退出、legacy claim `0`、相同负载资源
比较。门禁是证伪工具，不是达到后结束持续目标的条件。

## 实施顺序

1. 在全新隔离目录实现 D0 最小状态机，不接生产代码和真实 DB；
2. 同时独立破坏性审计 DBOS 0006，不由实现者自评；
3. 把 mobile 0005 reducer映射到真实 Expo SQLite repository transaction的只读设计审计；
4. 三者使用相同 operation/source/history/manual合同；
5. 正确性门禁通过前不做真实 ffmpeg、8030或 APK集成；
6. 结果反写蓝图，再决定 D0、DBOS或 D2b谁进入真实 adapter候选。

## 禁止项

- 不回到 M1-O 或任何旧 worker兼容写路径；
- 不继续给 Restate 0007 长 exclusive handler打第三轮补丁；
- 不因 DBOS官方推荐 PostgreSQL就直接否决 SQLite单机例外；
- 不把 fail closed误写为已经恢复；
- 不把 fixture、编译、自测或框架 exactly-once宣传写成生产证明；
- 不修改或重启生产、APK、真机、公网、GPU1、PCB或真实数据库。

当前没有 adopted runtime；生产保持冻结。
