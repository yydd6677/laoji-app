# 候选数据库实时只读排空审计

状态：`candidate read-only evidence; no remote mutation`。

## 数据来源

- 从候选服务器只读复制 `/home/zhong/laoji-vnext-candidate/api-realtime-speech.db` 到本地临时路径。
- 审计脚本只读取复制品；没有写回候选数据库，也没有重启候选或生产服务。
- 机器可读报告：`DELETION-GATE-CANDIDATE-20260819-LIVE-READONLY.json`。

## 现场结果

- 数据库完整性正常，包含 82 张候选表。
- `vnext_tasks` 仍有 1 条 `active` 任务。
- `vnext_task_attempts` 仍有 1 条 `running` attempt；复制时其租约已超过当前时间，仍需候选 worker 的恢复扫描处理。
- 上传、转写、purge 和 cleanup obligation 当前没有待处理计数。
- 五个 capability barrier 都未激活、关闭或登记旧 reader removal proof。
- 活动旧引用仍为 291 个，公开零流量周期和旧客户端查询恢复证据缺失。
- `safe_to_delete=false`，没有执行任何删除。

该结果比“未提供数据库”更具体，但仍不能授权 Stage 5 删除；候选任务排空、旧 reader 证明和公开周期
必须由候选运行态及发布流程继续闭合。
