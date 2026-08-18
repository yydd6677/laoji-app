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

结果：`486 passed, 16 failed, 237 warnings`。

16 个失败不能被报告为通过。当前失败集中在：

- 旧 `app_meeting_question` 多轮/旧路由调用次数和旧引用兜底断言；
- 旧模板 revision=1 断言，而当前模板合同已升为 revision=2；
- 旧 summary 生成分支、旧 compact 拓扑静态规则、账号迁移和旧 recording-assets 兼容断言；
- 一项旧实时 VAD 策略和一项旧访谈模板 fallback 断言。

这些失败尚未作为 Stage 2 退出证据，也没有通过放宽验证或恢复第三个业务 owner 来处理。需要在
后续兼容审计中逐项判断是更新过时测试合同，还是修复真实的稳定版兼容回归。
