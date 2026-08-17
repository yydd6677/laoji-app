# 候选 0004：summary task owner + Artifact 结果层证据

## 身份与边界

- candidate repository: `/home/yydd/LaoJi-candidates/summary-artifact-owner-0004`
- branch: `candidate/summary-artifact-owner-0004`
- commit: `8faa61c`
- runtime observed: Linux Python `3.13.5`
- production/model/device calls: none

这是对服务器现有 `summary_tasks_v2` 的缩减 schema 隔离复刻，不是生产数据库副本，也没有连接生产 API。主工作树、服务器、设备和真实数据均未修改。

## 验证结果

命令：`python3 -m unittest discover -s tests -v`，结果 `9/9` 通过。

验证内容：

- 只有 `summary_tasks_v2` 负责 task dedupe、claim、lease expiry/recovery；schema 中没有第二个 `operations` 表；
- Artifact 插入和 task success 在同一个 SQLite 事务中完成；
- 在 Artifact 插入后、task success 前注入异常，Artifact 和 success 状态一起回滚；
- task 输入的任一来源 revision 变化时，整次 commit 被拒绝，task 仍可恢复；
- 结果不能引用 task request 之外的来源；
- source revision 更新后，已提交旧事实从投影消失；
- 跨连接 claim 只有一个 owner，重启后 task 和投影仍可读；
- 同 dedupe 输入复用，只有显式 force 才建立新 task。

## 与候选 0003 的关系

候选 0003 证明了更丰富的 Artifact/用户编辑合同，但自带 `operations` 表。候选 0004 刻意删除这个表，把 operation 生命周期交给现有 `summary_tasks_v2`，只新增结果层表。它因此更接近“减少 owner”的方向，但还没有把候选 0003 的 partial/stable/final、用户编辑和讲话人分支全部接入。

## 未验证与反证条件

- 只复刻了 task store 的核心字段，没有逐字迁移服务器 schema、加密 payload、retention 和所有 worker stage；
- 没有接真实 `summary_tasks.py`、Ollama、ASR、provider queue 或 checkpoint callback；
- 没有在 Python 3.12、Windows 或多 worker 生产部署运行；
- 没有证明现有 worker 内存 dedupe/future maps 可以安全删除；
- 没有做 100 轮真实进程 crash、WAL backup/restore 或真实模型调用。

结论：候选 0004 可以进入“隔离 task-owner 迁移设计”阶段，仍是 `candidate`，不得标记 `validated`/`adopted`，不得双写生产。
