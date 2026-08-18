# 代理证据来源说明 2026-08-16

旧 `laoji_blueprint_maintainer` 及其研究子代理创建于用户关闭 Fast 之前。创建请求曾声明高推理配置，但当前没有足够运行元数据证明所有实际采样都未经过 Fast 路由。

因此：

- 旧代理的外部研究、技术推荐和未复核结论一律保持 `hypothesis`；
- 旧代理继续产生的新输出不直接写入蓝图事实；
- 只有主代理重新读取源码/服务器，或由关闭 Fast 后明确创建的最高推理代理复核，才能升级为 `observed`；
- 性能、质量和迁移结论仍必须经过独立候选验证才能升级为 `validated`。

本轮已经由主代理独立复核的静态事实包括：

- 多类 meeting sync trigger/outbox 未发现生产消费者，meeting root 除外；
- `transitionProcessingStage` 没有合法状态边和跨 stage 因果校验；
- v3 本地投影把 `transcriptRevisionId` 设为 null，并在保存时绑定当时 active transcript；
- Minutes detail 通过多 generation 和中文状态文案合并业务状态；
- Calendar Search 没有消费 native dismiss；
- SharedAction/SharedMeetingContent token 可进入最长 7 天的普通导航持久化。

这些仍是静态调用图/源码证据，不自动证明每个问题已在当前真机复现。

## 代理批次重建记录

用户要求废弃关闭 Fast 前创建的旧代理上下文后，主代理先核对代理树：旧
`$AGENT_RUN_ROOT/laoji_blueprint_maintainer`、`provenance_audit` 和
`schedule_structured` 均已结束，没有仍在运行的旧任务；未向它们续发任务，也未把它们重新标记为当前批次。

随后创建了全新批次：

- `$AGENT_RUN_ROOT/blueprint_nofast_20260816`：创建时显式指定 `gpt-5.6-sol`、`reasoning_effort=ultra`；完成 revision 0002 蓝图复核，未改生产代码。
- `$AGENT_RUN_ROOT/blueprint_nofast_20260816/source_audit`：由新蓝图代理派生，负责源码证据审计；其报告仍需主代理复核。
- `$AGENT_RUN_ROOT/durable_runtime_nofast_20260816`：创建时显式指定 `gpt-5.6-sol`、`reasoning_effort=ultra`；只写持久运行时研究报告，不改生产代码。

新批次的报告不能自动升级为 `adopted`；模型质量、真实设备、生产服务和性能结论仍需独立证据。代理工具没有向主代理暴露可供事后审计的完整路由元数据，因此除明确指定的父代理外，派生代理的具体采样路由保持 `provisional`，不作为“已证明非 Fast”的唯一依据。

## 0003 切片审计后的新批次

在上一批完成后，主代理再次清理活动树并重开两个同配置代理；创建请求均显式
指定 `gpt-5.6-sol` 与 `reasoning_effort=ultra`，没有启用 Fast：

- `$AGENT_RUN_ROOT/v3_callgraph_audit_fresh`：复核 v3 移动端、设备 API、任务 404 恢复、
  transcript/version 测试和服务端调用图；输出仍是静态/隔离证据。
- `$AGENT_RUN_ROOT/durable_slice_fresh`：复核真实 `summary_tasks_v2` 与 v3 artifact 的
  事务边界，形成 research 0005；未改生产代码、服务、设备或数据。

两者的结论已由主代理读取并写入 0003/0005；它们不代表生产已切换，也不覆盖
先前旧批次的 Fast 路由不确定性。完成后不再续用旧上下文。

## 上传 U1/U2 审计批次

本轮上传候选的独立审计代理读取了 0014/0015 实现、测试、正式 TS/Kotlin/Python
调用图；未修改生产代码、服务、数据库、APK 或设备。其结果已经由主代理复核并写入
candidate 0029/0030。一个独立审计子代理的本地认证服务曾返回 503，因此没有把它的
中断当作通过证据；已有复现的终态回退、删除 fence、迁移冲突和整文件内存问题足以
维持 `rejected-current-shape`。

随后创建的 `$AGENT_RUN_ROOT/upload_u2_native_executor_arch` 明确指定
`gpt-5.6-terra`、`reasoning_effort=high`，只在隔离候选目录设计 U2-A contract probe，
不接生产。最高推理的蓝图复核由 `$AGENT_RUN_ROOT/laoji_blueprint_maintainer` 完成只读复核；其
建议仅作为候选审阅，蓝图事实仍由主代理源码核对确认。
