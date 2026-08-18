# 候选 0003：增量 Artifact Flow 回放证据

## 身份与边界

- candidate repository: `$CANDIDATE_ROOT/incremental-artifact-flow-0003`
- branch: `candidate/incremental-artifact-flow-0003`
- commit: `3f6a633`
- runtime observed: Linux Python `3.13.5`
- production/model/device calls: none
- main LaoJi worktree: unchanged by this candidate

这是隔离合同原型，不是生产实现，不证明真实 ASR/LLM 质量、Android 集成、Windows 兼容或端到端性能。

## 当前原型做了什么

- SQLite WAL 账本持久保存 `operations`、不可变 `artifacts`、当前指针、用户编辑和事件记录。
- Artifact 以 `meeting_id + logical_key + revision + digest` 标识；来源引用必须属于同一会议并在写事务内再次检查当前 revision。
- 同一输入和合同的 operation/artifact 幂等复用；强制重生成必须改变显式 contract revision，不能偷偷重复调用。
- `provisional -> stable -> final` 按逻辑键替换；来源 revision 更新会自动使旧事实和答案失效，不删除历史。
- 讲话人 operation 失败不会隐藏仍可读的转写；问答要求最终且 verified 的转写来源。
- 用户编辑独立保存，后续生成 revision 不覆盖编辑；来源失效时编辑仍保留为 `preserved_edits`。
- 取消请求在跨 SQLite 连接可见，取消后的 operation 不能发表迟到 Artifact。

## 验证结果

命令：

```text
python3 -m unittest discover -s tests -v
```

结果：`15/15` 通过。

覆盖的合同包括：

- partial 先于 stable/final 可见；
- 来源修订使旧事实失效；
- 用户编辑跨生成 revision 保留；
- 未达 final/verified 时问答拒绝；
- 跨会议来源、过期来源和 watermark 回退拒绝；
- 同连接与跨连接取消、重启恢复和幂等去重；
- 讲话人失败不阻塞转写；
- 同输入复用，显式新合同才产生新 operation。
- 生成结果没有来源引用、或 operation 的任一输入已变旧时拒绝提交；未核验的 provisional 事实不进入展示投影。

回放 fixture `fixtures/meeting-flow.jsonl` 的事件时间（合成，不是模型延迟）：

- 首个可读转写：`220 ms`
- 首个 verified 事实：`900 ms`
- 首个 final 转写：`1200 ms`

这些数值只表示 replay event 的相对顺序，不得解释为老记真实服务 p50/p95。

## 与旧候选的差异

候选 0001 (`92d27de`) 的 graph、registry、trace、dedupe 和 result 都是进程内对象，且不执行 graph。候选 0003 将账本和 current-pointer 更新放入 SQLite 事务，并把来源 CAS 放在写事务内；它仍没有真实 Provider、GPU 资源准入、可中断 HTTP/ASR transport 或生产迁移。

## 未通过/未验证边界

- 只在 Python 3.13.5/Linux 验证；Python 3.12、Windows CI 尚未运行。
- 未接现有 `summary_tasks_v2`，所以尚未证明能删除旧 task owner。
- 未注入进程在 provider 返回与 checkpoint 之间的真实崩溃，也未运行 100 轮随机故障门禁。
- 未证明多个 worker 的公平调度、GPU/CPU 峰值、取消对外部推理的实际 abort。
- 未接 RN/Android projection；`ProjectionEnvelope` 候选仍未 validated。

结论：候选 0003 可进入“与现有 summary-v3 ledger 的隔离对照”阶段，现有 ledger 仍是更完整的任务 owner；候选只证明 Artifact/result 合同。它仍为 `candidate`，不得标记 `validated`、`adopted` 或部署。对照见 [summary-v3 ledger comparison](../research/0002-summary-ledger-comparison-20260816.md)。
