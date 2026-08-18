# Stage 4 MentionGraph owner boundary (2026-08-19)

状态：`candidate-only; default off`。

## 本次闭合

- `/api/laoji/v2/schedule/graph` 和 `/api/device/v2/schedule/graph` 都显式调用
  `parse_schedule_text(..., model_only=True)`；模型返回空观察时返回 503，不生成不完整的伪 Graph。
- 请求携带 `client_intent`。Graph producer 只消费这个 admission decision 或测试注入的 observation，
  不再调用旧 `classify_schedule_intent`。
- `produce_schedule_graph` 缺少 observation 直接拒绝，消除了旧 `parse_schedule_text_sync` 的隐式同步
  fallback。澄清请求把原 Graph 来源和补充合并成一次 model-only 输入；Graph 只接收该 observation，
  复用 source_id 并递增 revision，不再调用旧 `apply_schedule_clarification`。

## 证据

- `tests/test_schedule_graph_vnext.py`、`tests/test_schedule_graph_route_vnext.py`、
  `tests/test_device_v2_schedule_graph_api.py`：`16 passed`。
- `npx tsc --noEmit --pretty false`：通过。
- Python compileall、`git diff --check`：通过。
- `python3 tools/vnext/verify_schedule_graph_owner.py`：通过；四个候选路由均包含
  `model_only=true`，Graph service 无旧 parser/intent/clarification 调用，schema 与移动端均透传
  `client_intent`。

## 边界

这只是重复 owner/隐式回退审计的候选闭合，不是 Stage 4 采用或退出证据。Graph capability、真实模型质量、
自然日程人工金标、Android/Expo SQLite 恢复和 v1 public zero-cycle 仍未完成；生产 `/parse` 和旧 parser
保持不变，不能删除任何 legacy capability。
