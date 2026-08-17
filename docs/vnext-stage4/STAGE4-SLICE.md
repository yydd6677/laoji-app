# vNext Stage 4 日程来源切片

状态：`schema slice implemented in isolation; Stage 4 not adopted`。

本切片只闭合本机日程表的来源与 revision 元数据，不启用远端 graph producer、不开启 schedule
capability barrier，也不改变稳定版或生产服务。

## 已实现

- 新增连续迁移 `0045ScheduleMentionGraphVNext`，为既有 `local_schedule_events` 增加：
  `event_revision`、`draft_source_sha256`、`producer_revision`、`graph_schema_revision` 和
  `deleted_at_ms`。
- 旧设备升级时以 `event_revision=1`、`producer_revision=legacy-v1` 和
  `graph_schema_revision=mention-graph-v1` 回填兼容元数据；不伪造历史 Graph 或来源哈希。
- 本机 repository 写入与 upsert 在同一事务中保存事件 JSON 和这些元数据；旧事件仍按原 JSON
  投影读取。
- 增加 revision/source/deleted 查询索引，为后续 Graph validator、软删除和 stale action fence
  提供可查询边界。
- `CalEvent` 暴露可选的来源元数据，未接入 Graph producer 时保持兼容默认值。
- 新增 `meeting_search_documents_v45` 外部内容表和 `meeting_search_fts_v45` FTS5 索引；触发器
  保证文档增删改与索引同事务维护，查询仓储不再向旧 `meeting_search_fts` 写入新内容。
- 搜索重建、结果查询和 guest 回收站清理已统一切换到 v45 文档表 + FTS 索引；旧索引仍保留，
  仅作为回滚期间的只读资产。

## 验证

- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- `python3 -m compileall -q services/laoji-api/app`：通过。
- SQLite FTS5 外部内容增删探针：通过，新增内容可检索，删除后无残留命中。
- 迁移仅新增 0045，不改变 0040-0044 顺序；未安装到 APK、模拟器或服务器。

## 未完成

这不是 Stage 4 退出证据。MentionGraph recognizers/producer/validator/executor、ProjectionEnvelope、
服务端 v2 schedule route、自然语料 holdout 和 capability barrier 仍未采用；真实 Expo SQLite/Android
迁移回放和搜索性能门也尚未通过。
在这些门完成前，旧日程链路继续作为生产路径，不能删除旧 parser 或宣称 vNext 日程已上线。
