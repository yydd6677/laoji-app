# vNext Stage 4 日程来源切片

状态：`schema slice implemented in isolation; Stage 4 not adopted`。

本切片闭合本机日程表的来源与 revision 元数据，并提供默认关闭的 device-v2 Graph 候选；不开启
schedule capability barrier，也不改变稳定版或生产服务。

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
- 新增隔离的 `schedule_graph_service`：将单次解析观察投影为 `ScheduleMentionGraph`，记录
  来源日期/时间/标题/地点片段、意图、路由和 producer revision；`validate_schedule_graph` 对所有
  片段做原文边界校验，并拒绝无开始日期的 complete 图。
- `graph_to_draft` 以规范 JSON 计算稳定哈希；`merge_schedule_clarification` 在原 Draft 上合并
  补充答案，保留 source_id 并单调递增 `draft_revision`，不把补充当成新的独立日程输入。
- 新增隔离的 `vnext_projection` 工具，统一 ProjectionEnvelope 的 canonical payload hash、同一
  surface 的 entity/view revision 单调接收规则，以及 action 的 epoch/entity/surface 精确 fence。
- `app/laoji/router.py` 增加默认关闭的 `/v2/schedule/graph` 和 `/v2/schedule/graph/clarify` 候选
  路由；启用时只接收结构化 Graph，关闭时稳定返回 `SCHEDULE_GRAPH_V2_DISABLED`，不改变旧 `/parse`
  路由或 capability barrier。
- 移动端新增独立 `scheduleGraphV2.ts` client；它校验 schema、source SHA-256、原文片段和 revision，
  并改为只经 device-v2 鉴权调用。`api.ts` 只有在 APK 构建标志
  `EXPO_PUBLIC_SCHEDULE_GRAPH_V2_CANDIDATE=1` 和服务端 `schedule_graph_v2=true` 同时成立时才选择
  Graph；稳定构建不会多做 capability 探测。Graph Draft 的澄清沿用同一 source/revision，不回退为
  独立输入。
- device-v2 增加 `/schedule/graph`、`/schedule/graph/clarify` 和 `schedule_graph_v2` capability；服务端
  未显式设置 `LAOJI_VNEXT_SCHEDULE_GRAPH_ENABLED=1` 时路由与能力均 fail-closed。
- Graph 的 `content_sha256`、producer revision、schema revision 和 draft revision 已贯穿两套语音确认页
  与两套详细编辑页并写入本机日程；用户后续编辑在 guest/device-primary CRUD 中单调递增
  `eventRevision`，不会因进入详细编辑而退化成 `legacy-v1` 来源。
- 新增 `meeting_search_documents_v45` 外部内容表和 `meeting_search_fts_v45` FTS5 索引；触发器
  保证文档增删改与索引同事务维护，查询仓储不再向旧 `meeting_search_fts` 写入新内容。
- 搜索重建、结果查询和 guest 回收站清理已统一切换到 v45 文档表 + FTS 索引；旧索引仍保留，
  仅作为回滚期间的只读资产。
- Native Calendar/Minutes 快照现在可携带 `ProjectionEnvelope`；CalendarHost 对无效、缺失、乱序或
  跨 entity/surface 的投影直接拒绝，拖拽 mutation 会回传当前 projection fence。Minutes parser/reducer
  使用同一 revision/hash fence，native action 会回显当前 envelope；旧版无 envelope 快照仍兼容。
- 新增 `src/native/projectionEnvelope.ts`，以 `expo-crypto` 对规范化 payload 生成真实 SHA-256；Calendar
  和 Minutes snapshot builder 接受预先生成的 envelope，不在 native 侧重新计算正文哈希。
- 新增默认关闭的 `nativeProjectionEnvelopeCandidate` 旗标和 `useNativeProjection` 协调器；日历、会议
  详情、实时录音三个页面在候选开启时从本机 epoch、页面实例和快照内容生成 envelope，哈希尚未完成时
  暂不让 native 混用新正文和旧 fence。
- `0045` 同阶段新增 `native_projection_checkpoints`，只保存 revision/hash fence；repository 在事务中
  接受新 revision、幂等复用同 revision 同 hash，并拒绝旧 revision 或 revision/hash 冲突。三个页面会在
  生成 envelope 前恢复各自 `calendar/recording/transcript` surface 的 checkpoint，进程重启后不再从
  revision 1 重新开始。候选旗标仍默认关闭。

## 验证

- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- `npx tsc --noEmit`：通过；隔离后端 vNext/Graph/Projection/Task/Upload/Realtime 聚焦测试：`40 passed`。
- `android/gradlew :laoji-native-platform:compileDebugKotlin`：通过。新增 projection fence 的 Kotlin
  编译已验证；未进行 Android 设备运行时验收。
- `python3 -m compileall -q services/laoji-api/app`：通过。
- SQLite FTS5 外部内容增删探针：通过，新增内容可检索，删除后无残留命中。
- `python3 tools/vnext/verify_stage4_migration.py`：通过；在临时 SQLite 文件上重复执行 v45 列升级和
  SQL，保留旧 v20 FTS，写入 12,000 条搜索文档并验证插入/更新/删除触发器、生命周期过滤、完整性
  和外部内容查询；本机暖态搜索 p95 约 `9ms`。工具只依赖 Python 标准库，Linux/Windows 均可运行。
- `python3 tools/vnext/verify_projection_checkpoint.py`：通过；覆盖首次接受、同 revision 幂等、旧 revision
  拒绝、新 revision 提升及 SQLite 关闭重开后的恢复。
- `PROJECTION-ANDROID-REPLAY-20260818.md`：在 `emulator-5562/LaoJi_API_35` 的旧数据库上安装候选
  APK，真实完成 0045 迁移、calendar checkpoint 写入和强停/重启恢复；修复页面早于本机 epoch 初始化
  的外键时序后，revision 从 3 单调到 6。此证据仍只覆盖 ProjectionEnvelope 候选，不是 Stage 4 退出。
- 迁移仅新增 0045，不改变 0040-0044 顺序；未安装到 APK、模拟器或服务器。

## 未完成

这不是 Stage 4 退出证据。MentionGraph 的 device-v2 候选已接入解析/澄清 owner，但默认关闭；
ProjectionEnvelope 目前完成了 native Calendar/Minutes 接线、三个页面的默认关闭生成器和本机 checkpoint
owner，尚未启用 device/surface identity 的真实候选流量，也未跨 capability barrier。服务端 capability barrier、自然语料 holdout 和真实
Expo SQLite/Android 全局迁移回放、真实页面重建和搜索性能门仍未通过；ProjectionEnvelope 的
`emulator-5562` 回放仅证明候选切片的本机 owner 和重启 fence。
在这些门完成前，旧日程链路继续作为生产路径，不能删除旧 parser 或宣称 vNext 日程已上线。
