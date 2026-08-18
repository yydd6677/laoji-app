# vNext 隐私日志审计（候选工作树）

本审计只覆盖运行日志的内容边界，不改变生产服务、数据库或公网流量。

## 实施

- 新增 `services/laoji-api/app/privacy_logging.py`，只允许 capability、阶段、状态、字节数、哈希前缀、耗时、错误类型、计数和有限运行元数据。
- 整理 API、WebSocket ASR、日程 ASR、声纹、媒体转写、整理任务和服务遥测中的日志输出。
- 不再写入会议正文、转写片段、会议标题、讲话人姓名、文件名/路径、会议/任务/摘要/会话/声纹原始标识，异常日志也不输出原始异常文本或 traceback。
- 新增 `tools/vnext/verify_privacy_logs.py`。工具只读、跨 Linux/Windows，使用 AST 扫描 `services/laoji-api/app` 的 `print`/logger 调用；发现敏感变量插入即失败。

## 候选证据

执行环境：工作树 `.venv-vnext`，未连接生产端口。

```text
python3 tools/vnext/verify_privacy_logs.py --root services/laoji-api/app
privacy_log_findings=0

ENV=local PYTHONPATH=services/laoji-api .venv-vnext/bin/python \
  -m pytest -q tools/vnext/test_verify_privacy_logs.py
2 passed

python3 -m compileall -q services/laoji-api/app
git diff --check
```

全量 vNext 测试同样在隔离 venv 中执行：`515 passed`、`14 failed`。这 14 项失败属于已有候选分支的数据库环境、问答调用次数和旧模板断言，不涉及本次日志路径；因此不能作为本审计的通过证据，也没有据此修改无关功能。

## 边界

这只是静态候选证据，不代表生产日志已切换，也不代表 Stage 5 删除门通过。五个 capability barrier、legacy drain、旧客户端查询恢复和完整公开零流量周期仍未完成，旧链路、旧模型和旧环境继续保留。
