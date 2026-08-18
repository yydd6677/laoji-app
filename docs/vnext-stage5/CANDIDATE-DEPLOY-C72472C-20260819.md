# vNext 隔离候选部署 c72472c（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：隔离 `127.0.0.1:18021`，cwd 为 `/home/zhong/laoji-vnext-candidate/releases/c72472c/services/laoji-api`。
- ASR：继续使用隔离 `127.0.0.1:8031`，未重启或修改。
- 生产 `18020/8030`、公网入口、GPU1、PCB、Smart Meeting 和其他服务未修改。
- 上一候选 `b4f84c9` 保留，可回滚。

## 本次恢复结果

- `/api/ready` 返回 `ready=true`，ASR/VAD/CAM++/Ollama/embedding/任务 worker 就绪。
- 启动恢复了 `2` 个过期 `running` purge，转为 `pending`，等待持有 purge secret 的设备重放；未伪造为已确认。
- 6 个历史 `retryable_failure` attempt 在父 Task 已终态的情况下被规范化为 `terminal_failure`。
- 候选数据库当前状态：`vnext_tasks=failure:2`、`vnext_task_attempts=terminal_failure:6`、
  `v2_purges=confirmed:3/pending:2`。
- 候选任务队列深度为 `0`；没有启用任何 capability barrier。

这次修复了任务/Attempt 终态不一致和进程中断 purge 卡死问题，但 pending purge 仍需设备凭据，不能进入删除门；
Stage 5 仍为 `safe_to_delete=false`。
