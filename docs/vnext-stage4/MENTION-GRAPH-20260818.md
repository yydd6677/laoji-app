# Stage 4 MentionGraph 隔离证据

状态：`isolated candidate`，未接入生产路由。

## 交付边界

`services/laoji-api/app/services/schedule_graph_service.py` 提供五个纯边界：

1. `recognize_schedule_mentions` 只返回原文中可定位的日期、时间段、钟点、标题、地点和修正片段，
   不把规范化后的 `2026-08-19` 或 `15:30` 伪造为用户引用。
2. `produce_schedule_graph` 同时保存 UTF-8 源正文的 `content_sha256`，让澄清后的同一 source_id
   能和本机 `draft_source_sha256` 对齐；它接收一个解析观察，生成 `ScheduleMentionGraph`，明确区分
   `local_safe` 与 `server_required`，并把缺日期归为 `incomplete/needs_clarification`。
3. `validate_schedule_graph` 重新核对所有 span 的字符边界、路由/状态一致性、complete 日期和
   revision 单调性，失败关闭。
4. `graph_to_draft` 以规范 JSON 生成 `ScheduleDraft.graph_sha256`，模板或 UI 不参与哈希。
5. `merge_schedule_clarification` 在现有 source_id 和 Draft 上合并补充，revision 从 1 单调到 2，
   不重新创建第二个独立 Draft owner。
6. `vnext_projection` 提供跨 native/JS 可复用的 ProjectionEnvelope 哈希、单调接收和 stale action
   fence；相同 revision 的不同 payload 会失败关闭。
7. `/api/laoji/v2/schedule/graph` 与 `/api/laoji/v2/schedule/graph/clarify` 作为默认关闭的候选
   wire route 存在；关闭时不会触碰 parser，开启时复用同一 Graph producer 和 clarification owner。

## 验证

- `PYTHONPATH=. ../../.venv-vnext/bin/pytest -q tests/test_schedule_graph_vnext.py tests/test_schedule_parser_quality.py`
  ：`89 passed`。
- `../../.venv-vnext/bin/python -m compileall -q app/services/schedule_graph_service.py`：通过。
- `PYTHONPATH=. ../../.venv-vnext/bin/pytest -q tests/test_vnext_projection.py tests/test_schedule_graph_vnext.py`：`12 passed`。
- `PYTHONPATH=. ../../.venv-vnext/bin/pytest -q tests/test_schedule_graph_route_vnext.py`：`3 passed`。
- 测试使用自然短句，如“明天下午三点半开会”，没有生成笛卡尔积语料，也没有把测试元数据放入用户句子。

## 尚未闭合

候选 route 尚未接入 device v2 或手机端；没有 capability barrier、真实模型强制运行、自然语料
holdout、Expo SQLite 回放或设备验收证据。旧日程 parser 仍是当前默认路径，不能把本切片称为
Stage 4 生产采用。
