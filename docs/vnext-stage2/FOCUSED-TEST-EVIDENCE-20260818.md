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

结果：`119 passed in 3.92s`。

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
