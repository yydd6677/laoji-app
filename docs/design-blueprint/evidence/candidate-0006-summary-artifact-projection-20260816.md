# 候选 0006：Summary Artifact Projection r1 集成证据

## 身份与边界

- candidate repository: `$CANDIDATE_ROOT/summary-artifact-projection-r1-0006`
- branch: `candidate/summary-artifact-projection-r1-0006`
- commit: `6f2140a`
- pinned owner candidate: `summary-artifact-owner-0004@8faa61cca69058f71c6bc5582fecb6e8a6826f55`
- pinned projection candidate: `detail-projection-v2-0005@2a146962e3e540b0243f63b75e7bd8a75829f431`
- runtime observed: Linux Python 3.13.5 + Node standard library
- production/model/device calls: none

## 做法

集成回放不复制两个候选的源码：Python runner 通过固定 commit 的 0004 负责 task create/claim/lease/recovery 和 Artifact 事务，再调用 0005 的 Node projection module 重建一个详情视图。数据库只包含一个 `summary_tasks_v2` owner，没有 `operations` 表。

每轮先写不可变 transcript source，创建并 claim summary task，再以同一事务写 fact Artifact 和 task success；随后将结果投影到 0005 的单 `projectionRevision` reducer。奇数轮在 Artifact 写入后、task success 前注入异常并重开数据库，验证 lease recovery 后只能提交一份结果。

## 验证结果

命令：`python3 -m unittest discover -s tests -v`，结果 `2/2` 通过。

- 基础正常轮和回滚轮均得到一个 fact projection；
- 100 轮确定性故障矩阵通过；
- 50 轮异常回滚、50 轮重启后继续；
- 100/100 轮最终每个会议只有一个 fact；
- 候选依赖 commit 在运行前校验，工作树漂移会直接失败。

这证明的是隔离 SQLite/Node 合同和事务顺序，不是 100 次真实进程随机崩溃，也不是服务器模型质量/延迟。

## 未验证边界

- 0004 仍是缩减版 task schema，不是生产完整 `summary_tasks_v2`、加密 payload、checkpoint callback 或 retention；
- 没有调用真实 `summary_tasks.py`、Ollama、ASR、网络、RN 或 Android；
- 没有证明旧 worker 内存 dedupe/future maps 可删除；
- 没有验证 Python 3.12/Windows CI、WAL backup/restore 或多 worker 竞争；
- 没有切换 active summary、旧 v2 mirror 或真实用户数据。

结论：候选 0006 通过了“单 task owner + 单结果 projection”的隔离门禁，可作为下一步真实代码设计输入，仍为 `candidate`，不得部署、双写生产或标记 `adopted`。
