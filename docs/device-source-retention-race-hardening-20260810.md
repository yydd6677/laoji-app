# 设备失败源文件并发清理加固（2026-08-10）

## 发现

设备源文件回收线程先在事务外选出“超过 24 小时的失败/终态资产”，随后才删除文件并更新数据库。若用户在这段窗口内提交新的转写重试，旧清理可能删除新任务要读取的同一 `storage_path`。

## 修复

- 每个候选资产现在在独立 `BEGIN IMMEDIATE` 写事务中重新读取资产、会议和最新转写任务状态。
- 只有仍然属于同一设备 epoch、路径未变化、最新任务仍为过期 `failed/completed` 或没有任务时才继续。
- 数据库写锁保持到文件 unlink 和 `storage_path=NULL` 原子提交完成；新的转写重试不能在旧清理删除文件的过程中提交。
- 重新确认失败/被新任务取代的候选只跳过，不误报为清理失败；文件删除异常则事务回滚并保留路径供后续重试。

## 证据

- 服务器备份：`/home/zhong/laoji-service-platform/compact-production/backend/backups/device-source-retention-race-hardening-20260810-0001/meeting_retention_service.py.before`。
- 当前部署源码 SHA-256：`568f14e7c2f03ffce9d96446d668deb90a574184fc348688870fca90c499f84b`。
- 服务器真实 SQLite/音频目录回归：过期失败资产被清理并清空路径；同时存在 queued 最新任务的资产返回未清理且源文件仍在。临时会议、资产、任务和文件已删除。
- 部署后仅重启 `laoji-api.service`；公网 `/api/ready` 仍为 `ready=true`，ASR/LLM/任务队列为 0，三库 WAL/完整性/外键检查正常。

## 边界

该修复只解决失败源文件的并发生命周期，不把“真实多人声纹质量”或真机验收计入完成；原始音频仍按成功立即清理、失败最长 24 小时的策略执行。
