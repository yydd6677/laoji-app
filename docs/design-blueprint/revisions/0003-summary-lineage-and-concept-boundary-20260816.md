# 蓝图修订 0003：整理结果血缘与单一任务所有者

## 状态

- revision: `0003-summary-lineage-and-concept-boundary-20260816`
- status: `candidate`; **not adopted**
- parent: `0002-incremental-artifact-flow-20260816`
- observed at: `2026-08-16 Asia/Shanghai`
- evidence: source inspection plus candidate contract design; no production mutation

## 为什么需要这次修订

0002 选定“增量证据流”作为候选方向，但没有把 v3 整理结果的事务边界和
转写版本血缘闭合。当前服务端事实文档写入和 `summary_tasks_v2` 成功标记是
两笔事务，客户端还存在以 source fingerprint 代替 transcript revision、投影
丢失 revision 的问题。继续在此状态上接入增量 Artifact 会把错误的血缘永久化。

## 保留的目标

1. `summary_tasks_v2` 仍是唯一 claim、lease、retry、recovery 和 cancel owner。
2. 结果层可以新增不可变 artifact/current pointer，但不得新增 `operations` 或
   第二套任务账本。
3. partial/stable/final 仍按水位发布；完整验证不能阻塞已经可读的较低水位产物。
4. 所有整理、引用、问答和模板投影都绑定同一个 canonical transcript revision。

## 新增的硬约束

- 最终 v3 artifact、current pointer 和 task success 必须在 task store 的同一
  SQLite 事务中提交；任一异常全量回滚。
- source fingerprint 只标识输入内容集合，不得作为 transcript revision ID。
- worker 重新读取来源时必须做 source + revision CAS；迟到 worker、过期 lease、
  已取消任务全部零写入。
- `MeetingSummaryDocument.transcriptRevisionId` 不得为 v3 生成结果写死 `null`。
- 旧 v2 结果在 v3 成功前继续可读；v3 失败不得降级覆盖已有结果。

## 调用图中另外一个待收紧点

`meetingSummaryInputFingerprint()` 目前把模板 ID/revision 纳入 fingerprint，
而 v3 的 request ID 又由该 fingerprint 派生。虽然服务端可能因 source identity
复用已有结果，客户端的待办任务、处理状态和“可更新”判断仍可能把纯模板变化当成
输入变化。模板切换必须继续保持纯本地投影；后续切片要把“来源指纹”和“视图偏好”
拆成两个身份，并为其增加不发网络请求的测试。

本次审计还固定记录以下血缘缺口，作为实现前置门禁：

- `src/services/meetingSummary.ts` v3 POST 目前把 `inputFingerprint` 填入
  `transcript_revision`；
- `src/services/meetingSummaryV3.ts` 的 v3 `MeetingSummaryDocument` 投影目前把
  `transcriptRevisionId` 写成 `null`；
- 服务端 `normalize_sources()` 当前重新计算 transcript identity，未把客户端声明
  revision 纳入 CAS；
- `summary_v3_store.persist_document()` 与 `summary_task_store.mark_success()`
  仍是不同连接/事务。
- `meetingSummary.ts` 在任务轮询 404 时会直接读取会议 latest v3 document，当前
  没有对 `sourceFingerprint`、`transcriptRevision`、笔记/附件 revision 做匹配；
  正常/恢复返回也固定投影 `DEFAULT_MEETING_TEMPLATE`。服务端 GET 只按会议返回
  active latest，因此旧任务可能被误认成当前结果。

这些是“可编译但语义不闭合”的问题，不能等到 UI 或模型质量测试时才发现。

## 概念预算

这次切片最多增加两个持久结果概念：`summary_v3_artifact` 和
`summary_v3_current`。它必须同时删除或旁路一个现有独立写入入口
`summary_v3_store.persist_document`，并把其写入职责移入现有 task owner。
如果实现后仍需第二个 claim/lease/retry/cancel owner，切片自动否决。

## 实施顺序

1. 在复制数据库实现 `commit_v3_result` 原子合同和 source/revision CAS。
2. 用真实 `summary_tasks_v2` schema 做故障注入：崩溃、lease 丢失、取消、重复
   提交和 source 变化。
3. 修正客户端 revision 传递与投影，仅在隔离 API 上 shadow 回放。
4. 对比旧 v2 查询、设备能力和旧客户端兼容，再决定是否进入生产候选。
5. 为 404 恢复增加完整 identity CAS：只有 task identity 与 latest document 完全
   一致才允许复用；否则创建/恢复同一 task，或明确返回“结果已过期”，不得静默
   接受 latest。

0008 的隔离 Node 合同已验证 9/9 身份拒绝/接受情况，但尚未接入真实 API；它只
证明判定边界，不证明服务端已经返回了足够的 identity 字段。

详细切片合同见 [0005 lineage slice](../research/0005-summary-v3-lineage-slice-20260816.md)；
完整入口/恢复调用图见 [0006 callgraph audit](../research/0006-summary-callgraph-revision-audit-20260816.md)。
