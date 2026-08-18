# Stage 5 删除门只读审计

工具：`tools/vnext/audit_stage5_deletion_gate.py`

该工具只读扫描候选工作树、显式提供的候选 SQLite 和 Linux 运行时状态；不会删除文件、修改数据库、
停止进程或调用会改变 systemd 状态的命令。Windows 上跳过 Linux `/proc`/systemd 检查并明确报告
运行时证据缺失。

## 当前候选快照

最新隔离候选复核见 [2026-08-19 candidate audit](DELETION-GATE-CANDIDATE-20260819-R2.md)，候选运行部署见
[fb268c8 deployment](CANDIDATE-DEPLOY-FB268C8-20260819.md)。

报告：`docs/vnext-stage5-deletion-audit-20260819-fb268c8.json`

- `production_mutation=false`
- `deletion_performed=false`
- `safe_to_delete=false`
- 候选数据库已提供；五个 capability cutover 仍为空，不能证明任何能力已激活
- 生命周期审计为 `pending`：6 个 retryable attempt、2 个 running purge；上传、转写和 R2 清理没有未完成状态
- 活动源码引用：`291` 个命中（锁文件和通用 `Q0` 标记已排除；仍包含兼容 handler、旧协议和旧 owner；这不是删除授权）
- 当前只读运行时扫描到一个 `cloudflared` 进程，位于工作区之外的 phone bridge 目录；未停止
- 完整公开周期证据缺失，不能把“当前没有用户”推断为一个已验证公开周期

## 必须全部满足的删除前证据

1. `media.upload`、`transcript.realtime`、`summary`、`question`、`schedule` 五个 capability
   都有持久 activation、legacy submit closed、reader removal marker 和证据哈希记录。
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

旧媒体写入路由的静态合同可单独复核：

```text
python3 tools/vnext/verify_legacy_submit_guards.py
```

该探针只检查 `device_v1` 的 `/assets` 写入路由是否调用旧提交门，不会启用或关闭任何能力。
