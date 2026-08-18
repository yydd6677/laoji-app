# vNext Stage 3 整理血缘切片证据

- status: `isolated candidate; not production`
- observed: 2026-08-18 Asia/Shanghai
- worktree: `/home/yydd/LaoJi-worktrees/vnext-implementation`
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
- 移动端新增 `deviceV2SourceStream.ts`，通过现有 Device V2 会话调用 source-stream 的 manifest page、
  chapter group、bundle/item、commit、读取和取消接口；所有请求先检查 `source_stream_v2` capability，
  响应按 `source.stream.v2` 和 binding/task fence 严格校验。该 client 尚未被整理 UI 调用，默认不会产生
  网络流量。

## 验证

- `PYTHONPATH=. ../../.venv-vnext/bin/pytest -q tests/test_summary_v3.py -k
  'document_and_task_success_commit_together'`：`1 passed`。
- v3 identity/status、immutable document 和 task stage 回归：`4 passed`。
- 完整 `tests/test_summary_v3.py`：`39 passed`。长会议样本现在确实超过
  10,240 token 预算；关键时间/纠正/负责人信号超预算时 fail-closed。
- `test_summary_v3.py`、`test_persistent_summary_tasks.py`、
  `test_summary_versions_v1.py` 在隔离 SQLite 下合计：`52 passed`（13 个既有
  `datetime.utcnow()` 弃用警告）。
- `npx tsc --noEmit`：通过。
- `python3 -m compileall -q services/laoji-api/app`：通过。
- `git diff --check`：通过。

## 尚未关闭的门

- LaoJi 专属模拟器/真机 WorkManager 和 APK 运行验收；当前 `emulator-5560` 属于其他任务。
- GPU 候选首段/RTF、真实讲话人命名和未知人拒识。
- 旧 upload/ASR submit 的完整公开周期零调用。
- Stage 2 capability barrier、迁移/回滚、资源预算和生产切换。
- 真实部署端当前 prompt、worker、数据库和公网行为；本证据只证明隔离代码。
