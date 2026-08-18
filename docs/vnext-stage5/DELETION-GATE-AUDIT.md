# Stage 5 删除门只读审计

工具：`tools/vnext/audit_stage5_deletion_gate.py`

该工具只读扫描候选工作树、显式提供的候选 SQLite 和 Linux 运行时状态；不会删除文件、修改数据库、
停止进程或调用会改变 systemd 状态的命令。Windows 上跳过 Linux `/proc`/systemd 检查并明确报告
运行时证据缺失。

## 当前候选快照

最新隔离候选复核见 [2026-08-19 candidate audit](DELETION-GATE-CANDIDATE-20260819.md)。

报告：`docs/vnext-stage5-deletion-audit-current-20260818.json`

- `production_mutation=false`
- `deletion_performed=false`
- `safe_to_delete=false`
- 未提供候选数据库，因此 capability cutover 和 legacy task 状态为未知
- 活动源码引用：`304` 个命中（包含兼容 handler、旧协议和旧 owner；这不是删除授权）
- 当前只读运行时扫描到一个 `cloudflared` 进程，位于工作区之外的 phone bridge 目录；未停止
- 完整公开周期证据缺失，不能把“当前没有用户”推断为一个已验证公开周期

## 必须全部满足的删除前证据

1. `media.upload`、`transcript.realtime`、`summary`、`question`、`schedule` 五个 capability
   都有持久 activation、legacy submit closed 和 reader removal 记录。
2. 每个 legacy capability 的完整公开周期由外部运行记录证明；数据库中的累计 submit count
   不能替代该周期证明。
3. 活动源码引用归零，或已明确移入版本化 compatibility handler；历史文档和测试夹具不计入活动引用。
4. 候选数据库的 queued/running/legacy lease、purge journal、R2 cleanup obligation 和旧客户端
   task ID 查询已完成恢复审计。
5. 进程 cwd、开放文件、systemd unit、公开 capability 和资源预算审计无未知归属项。

任何一项缺失都保持 `safe_to_delete=false`。Stage 5 物理删除尚未执行，也不能在 Stage 2–4
退出门通过前执行。

## 使用

```text
python3 tools/vnext/audit_stage5_deletion_gate.py \
  --database <candidate-sqlite> \
  --json-out docs/vnext-stage5-deletion-audit-<timestamp>.json
```

`--database` 必须是隔离候选副本；工具通过 SQLite read-only URI 打开，不接受生产数据库写入。
