# Stage 4 mobile schedule owner boundary (2026-08-19)

状态：`candidate-only; default off`。

## 本次闭合

- 客户端在本地完成一次 route/intent admission 后，只有复杂 `create/clarify` 才会请求
  MentionGraph candidate；`local_safe` 草稿继续走本机快速路径。
- `query/delete/reject` 不会被 Graph candidate 当作模型创建请求接管。
- 构建开关开启但 device-v2 未声明 `schedule_graph_v2` 时，复杂请求直接返回
  `parser_unavailable`，不会静默落回旧 `/parse`。
- 候选 Graph 草稿的澄清在能力失效时 fail-closed；旧草稿若没有 Graph，则先建立原始来源
  Graph，再通过 Graph clarify 合并补充，不把补充文本单独解析成新日程。

## 真实修改

- `src/services/scheduleGraphRouting.ts`：纯函数准入合同。
- `src/services/api.ts`：复杂解析/澄清的 owner 顺序和能力 fence。
- `tools/vnext/verify_schedule_graph_mobile_owner.py`：源代码顺序和 fail-closed 静态门禁。

## 验证

- `python3 tools/vnext/verify_schedule_graph_mobile_owner.py`：全部检查通过。
- `python3 tools/vnext/verify_schedule_graph_owner.py`：全部检查通过。
- `npx tsc --noEmit --pretty false`：通过。
- `PYTHONPATH=. .venv-vnext/bin/python -m pytest -q tests/test_schedule_graph_vnext.py tests/test_schedule_graph_route_vnext.py tests/test_device_v2_schedule_graph_api.py`：`18 passed`。
- Python compileall、`git diff --check`：通过。

## 未改变的边界

候选构建开关和服务端能力仍默认关闭，生产 `/parse`、旧 parser、旧 `/clarify`、稳定 APK、
18020/8030 和公网流量均未改变。该证据不能替代真实 Android 语音/页面回放、模型质量 holdout、
全局 SQLite 迁移和 capability barrier；因此不代表 Stage 4 已退出或可以删除 legacy 路径。

