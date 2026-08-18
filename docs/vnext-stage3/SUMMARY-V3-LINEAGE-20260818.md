# vNext Stage 3 整理血缘切片证据

- status: `isolated candidate; not production`
- observed: 2026-08-18 Asia/Shanghai
- worktree: `$VNEXT_REPO`
- production mutation: `none`

## 本次闭合

1. v3 任务状态现在回显服务端计算的 `source_fingerprint`、`model_revision` 和
   `prompt_revision`。客户端恢复时只接受与本次任务身份一致的结果。
2. 任务 404 不再无条件读取会议的 latest v3 document。若没有已观察到的任务身份，
   客户端重新提交同一个逻辑请求；只有来源、模型和提示词 revision 全部匹配时才做
   durable-result reconciliation。
3. `MeetingSummaryDocument` 增加可选的 `remoteTranscriptRevisionId`，保存服务端实际
   用于生成的转写 revision；`transcriptRevisionId` 仍只表示本机 SQLite revision，避免
   把服务端哈希误当成本机 CAS ID。
4. v3 facts document 与 `summary_tasks_v2` 的 success result 通过同一 SQLite
   `BEGIN IMMEDIATE` 提交。错误租约会回滚事实文档和任务终态，旧任务在“事实已提交、
   task 未成功”窗口中恢复时会按 immutable identity 重放，不再次调用模型。

## 代码边界

- 服务端：`summary_task_store.mark_success_on_connection`、
  `summary_v3_store.persist_document_and_mark_task_success`、
  `workers/summary_tasks._do_device_summary_v3`。
- 客户端：`meetingSummary.ts` 的 v3 identity matcher、`meetingSummaryV3.ts` 和
  `meetingSummaryDocument.ts` 的 remote transcript revision 保留。
- 没有切换 18020/8030、公网入口、systemd、GPU1、PCB、Smart Meeting 或发布 APK。
- 移动端新增 `deviceV2SourceStream.ts` 和 `meetingSummaryV3SourceStream.ts`，通过现有 Device V2 会话调用
  source-stream 的 manifest page、chapter group、bundle/item、commit、任务/ artifact 读取和取消接口；来源由
  不可变转写、当前笔记和明确勾选的文字附件构造，按 UTF-8 范围、内容哈希和时间信息分章。所有请求先检查
  `source_stream_v2` capability，整理入口还需 `meetingSummarySourceStreamCandidate` feature flag，响应按
  `source.stream.v2` 和 binding/task fence 严格校验。任务恢复现在读取并核对 `source_stream_id`、
  `input_sha256`，重建同一来源清单并按 group 状态补传未完成章节，不会只轮询一个永远等待来源的任务。
  章节上传现在遵守服务端“最多预取下一章”和
  设备两组未消费容量：通过 `next_consumable_chapter` 反压，遇到有界 409/429 以稳定 group/bundle ID
  幂等重试，不会把整场长会议一次性推入远端队列。候选已挂入整理编排但默认不会产生网络流量。
- 服务端新增 `vnext_summary_worker`：SQLite 扫描 active source-stream summary task，单并发、每次一章、租约心跳，
  进程重启后从 task/checkpoint 恢复；最终 artifact 输出同时带 Facts V3 document identity/coverage 元数据，设备
  可通过受保护的 `/api/device/v2/tasks/{task_id}/artifact` 读取。

## 验证

- `PYTHONPATH=. ../../.venv-vnext/bin/pytest -q tests/test_summary_v3.py -k
  'document_and_task_success_commit_together'`：`1 passed`。
- v3 identity/status、immutable document 和 task stage 回归：`4 passed`。
- 完整 `tests/test_summary_v3.py`：`39 passed`。长会议样本现在确实超过
  10,240 token 预算；关键时间/纠正/负责人信号超预算时 fail-closed。
- `test_summary_v3.py`、`test_persistent_summary_tasks.py`、
  `test_summary_versions_v1.py` 在隔离 SQLite 下合计：`52 passed`（13 个既有
  `datetime.utcnow()` 弃用警告）。
- `tools/vnext/verify_stage3_source_stream_contract.py` 通过，锁定服务端
  `received_bundle_count/received_item_count` 与移动端响应 normalizer，以及恢复/反压字段的对应关系。
- `npx tsc --noEmit`：通过。
- `python3 -m compileall -q services/laoji-api/app`：通过。
- `git diff --check`：通过。

## 真实模型 smoke

- 隔离候选通过临时 SSH 转发访问 Ollama `qwen3.5:9b`，对
  `1436403866-1-192.srt` 的 80 个字幕片段执行当前 Facts V3 一次生成和确定性校验。
- 模型调用数为 `1`，校验成功；输出 3 条带来源事实、2 条带血缘行动候选，生成耗时
  `14.567s`，校验耗时 `2.539ms`。脱敏结果见 `facts-v3-real-model-smoke-20260818.json`。
- 这只证明当前 provider 能完成一次结构化 Facts V3 交付，不代表事实支持率、行动有效性或长会议覆盖已达发布门。

## 多样本真实回放（当前仍未达退出门）

- 新增 `tools/vnext/evaluate_facts_v3_real_holdout.py`，对 8 个不同主题字幕窗口执行真实
  `qwen3.5:9b` Facts V3 生成、最多一次结构修复和确定性验证；字幕只作为弱参考，不进入生产
  prompt 或规则。长转写进入模型前按原时间连续片段确定性打包，详见
  `docs/vnext-stage3/FACTS-V3-HOLDOUT-RECHECK-20260818.md`；最新回放报告为
  `facts-v3-real-holdout-recheck-20260818.json`，当前 `8/8` 通过。

  随后以同一 provider 和同一生产提示词重新执行完整候选集合，加入规划样本后为 `9/9`；
  脱敏报告见 `facts-v3-real-holdout-resume-20260818.json`。这只是重复性证据，不改变人工
  支持率和 capability barrier 的退出门。
- 回放曾暴露高覆盖长窗口只产出过少事实、议题覆盖不足，以及模型偶尔把战略方向输出成中适配
  行动。连续片段打包解决了碎片化上下文问题；通用验证仍将无明确有限交付边界的“加强/建立体系/
  持续推进”等宏观候选降为 `schedule_fit=low`，不能直接进入日程，这不是样本关键词门禁。
- 增加了严格根数组分隔符归一化后，偶发 JSON 漏闭合不再消耗第二次模型修复；完整 8 样本候选
  回放通过，但事实支持率、长会议人工覆盖和行动有效性仍需独立盲审，未满足 Stage 3 退出门，
  不能切 capability barrier。

## 尚未关闭的门

- 对三份完整长字幕执行了 source-stream 证据包回放，分别包含 1,357、1,946 和 1,569 个原始段。
  embedding 恢复后以真实 `qwen3-embedding:0.6b` 完成构建，证据包分别为 61、60、63 个来源，
  估算输入为 10,206、10,185、10,198 tokens，主题覆盖均为 1.0；真实 embedding 耗时为
  4.94s、7.57s、8.42s。此前的 `forced_evidence_exceeds_budget` 已由关键信号分层选择修复，
  没有输出部分总结，也未切换 18020/8030/8031。
- 该结果只证明长会议证据包和 embedding 依赖已恢复，不代表完整长会 Facts 模型生成、事实支持率、
  行动候选质量或 Stage 3 capability barrier 已通过；这些仍需继续做真实生成和人工盲审。
- LaoJi 专属模拟器/真机 WorkManager 和 APK 运行验收；当前 `emulator-5560` 属于其他任务。
- GPU 候选首段/RTF、真实讲话人命名和未知人拒识。
- 旧 upload/ASR submit 的完整公开周期零调用。
- Stage 2 capability barrier、迁移/回滚、资源预算和生产切换。
- 真实部署端当前 prompt、worker、数据库和公网行为；本证据只证明隔离代码。
- 多样本人工事实支持率、行动候选质量、长会议真实证据包和设备投影仍未通过。
