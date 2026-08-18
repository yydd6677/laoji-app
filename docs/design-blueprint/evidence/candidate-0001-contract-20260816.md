# 候选 0001 合同回放证据

- candidate repo: `$CANDIDATE_ROOT/cognitive-runtime-0001`
- branch: `candidate/cognitive-runtime-0001`
- commit: `92d27de`
- runtime: Python 3.12 standard library only
- production calls: none

通过 11 项合同测试：

- 任务身份不受 evidence 顺序影响；
- evidence revision 变化会改变任务身份；
- 结果保留资产 ID、revision 和 hash；
- active evidence 变化时 compare-and-set 拒绝提交；
- Provider 不能引用未声明来源；
- durable capability 缺消费者时启动检查失败；
- 非法状态跃迁和 DAG 环被拒绝；
- ASR graph 将 recognize 与 speakers 放在同一并行层；
- 相同任务复用同一已提交结果。

四类 synthetic replay 已通过：`schedule.parse`、`asr.transcribe`、`meeting.summary`、`meeting.question`。

该证据只验证合同一致性，不证明性能、模型质量、真实数据兼容或生产迁移可行。2026-08-16 独立复核进一步确认 graph 未执行且全部运行状态只在内存，因此该 commit 已被否决为 durable-runtime 实现；仅保留为合同草图，不是 `validated` 或 `adopted`。

完整复核见 [持久运行时候选独立审阅](../research/0001-durable-runtime-review-20260816.md)。
