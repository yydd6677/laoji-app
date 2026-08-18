# vNext 聚焦后端测试证据

## Stage 2/3/4 聚焦集合

执行目录：`services/laoji-api`。

命令：

```bash
PYTHONPATH=. ../../.venv-vnext/bin/python -m pytest -q \
  tests/test_device_v2_api.py \
  tests/test_device_v2_identity.py \
  tests/test_device_v2_realtime_api.py \
  tests/test_vnext_upload_store.py \
  tests/test_vnext_import_transcription.py \
  tests/test_vnext_realtime_pipeline.py \
  tests/test_vnext_realtime_store.py \
  tests/test_vnext_speaker_overlay.py \
  tests/test_summary_v3.py \
  tests/test_summary_v3_chapter_merge.py \
  tests/test_vnext_question_reader.py \
  tests/test_vnext_source_stream_store.py \
  tests/test_vnext_summary_worker.py \
  tests/test_vnext_task_store.py \
  tests/test_vnext_vad_initialization.py
```

历史结果：`119 passed in 3.92s`。

在加入当前候选的录音资产、存储准入、设备 v2 说话人接口、日程 Graph 路由和完整 Summary V3
任务集合后，使用项目专用 `.venv-vnext`、临时 SQLite 和 `ENV=local` 重新执行，结果为：

```text
159 passed, 17 warnings in 3.88s
```

本次命令覆盖的文件集合见本文件下方“候选重检命令”，结果仍只证明隔离候选，不代表生产切换。

该结果覆盖 device-v2 上传身份、R2 session、实时事件、来源流、Facts V3、Q2 reader、任务租约、
讲话人 overlay、VAD 初始化和恢复存储；它仍然不替代 Android 进程死亡/断网运行回放、GPU 性能或
公开 capability 周期。

## 全量回归边界

在临时 SQLite（`DATABASE_URL=sqlite+aiosqlite:////tmp/laoji-vnext-full-tests.sqlite`）下运行：

```bash
DATABASE_URL=sqlite+aiosqlite:////tmp/laoji-vnext-full-tests.sqlite \
SECRET_KEY=test-secret-key-012345678901234567890123 \
ENV=development PYTHONPATH=. ../../.venv-vnext/bin/python -m pytest -q tests
```

最新结果：`493 passed, 10 failed, 246 warnings`。

10 个失败不能被报告为通过。当前失败集中在：

- 旧 `app_meeting_question` 多轮/旧路由调用次数、旧 prompt budget 和旧分组断言；
- 旧模板 revision=1 断言，而当前模板合同已升为 revision=2；
- 旧 summary 两轮生成分支、账号迁移和旧访谈模板 fallback 断言。

已处理的测试合同漂移包括：当前候选部署路径、实时 VAD 参数、录音资产单测的容量隔离，
以及未知会议引用的 fail-closed 回归。剩余失败属于旧兼容路径，需在对应 capability barrier
和 legacy drain 完成后逐项更新或删除，不能通过恢复旧 owner、第二轮模板调用或引用兜底来消除。

这些失败尚未作为 Stage 2 退出证据，也没有通过放宽验证或恢复第三个业务 owner 来处理。需要在
后续兼容审计中逐项判断是更新过时测试合同，还是修复真实的稳定版兼容回归。

## 候选重检命令

```bash
ENV=local DATABASE_URL='sqlite+aiosqlite:///:memory:' \
../../.venv-vnext/bin/python -m pytest -q \
  tests/test_vnext_*.py \
  tests/test_summary_v3.py tests/test_persistent_summary_tasks.py \
  tests/test_recording_assets_v2.py tests/test_storage_admission.py \
  tests/test_device_v2_api.py tests/test_device_v2_realtime_api.py \
  tests/test_device_v2_speaker_api.py tests/test_schedule_graph_vnext.py \
  tests/test_schedule_graph_route_vnext.py --disable-warnings
```

该命令在 2026-08-18 的候选分支通过 `159` 项。直接从系统 Python 或不提供
`DATABASE_URL` 会在收集阶段失败，不能与代码回归混为一谈。

本次重检还覆盖 embedding provider 超时归一：长会议 evidence builder 将底层 HTTP 超时转换为
`SUMMARY_EVIDENCE_INCOMPLETE/embedding_unavailable`，summary worker 可以按既有任务策略重试，
不会向 API 泄漏 `requests.ReadTimeout`。长会议 embedding 默认批量为 16、单批超时 45 秒，均受
代码内上下界约束；可通过 `SUMMARY_V3_EMBED_BATCH_SIZE` 调整，但不能绕过 provider 或启用词法
静默降级。

## 真实候选语义回放

- Q2 reader：`docs/vnext-stage3/q2-real-holdout-resume-20260818.json`，真实
  `qwen3.5:9b`，27 条问题全部通过；包括正常回答、未提及、部分字段、来源冲突和引用校验。
- Facts V3：`docs/vnext-stage3/facts-v3-real-holdout-resume-20260818.json`，真实
  `qwen3.5:9b`，9 个主题窗口全部通过；正常路径每条使用 1 次模型调用，报告不保存样本正文。

两份报告均明确标记 `candidate_only=true`，字幕只是弱参考，不能作为生产 prompt、规则或
样本专用补丁，也不能替代人工事实支持率、行动质量、长会议覆盖和 Android 回放门。
