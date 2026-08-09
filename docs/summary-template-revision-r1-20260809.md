# 整理模板 revision 合同对齐（2026-08-09）

当前四个内置整理模板（`general`、`one_on_one`、`project_sync`、`interview`）的生产 revision 均为 `2`。旧测试把 revision 固定写成 `1`，在模板已经升级后会把正常调用误报为“版本不可用”。

本轮处理：

- 测试夹具改为从 `SUMMARY_TEMPLATES[template_id]["revision"]` 读取当前版本；未知版本仍用“当前版本 + 1”验证必须失败。
- `_preserve_contextual_structured_summary` 不再硬编码旧的 general revision `1`，改为读取当前 general 模板 revision，避免所有正常 general 整理被错误当成上下文续写。
- 模板不再暴露独立 `decisions`/`action_items` 段；测试改为确认这些模型臆造键不会投影到当前固定结构，决定按现有正文段落承载。

证据：

- `test_summary_task_parsing.py -k template`：`8 passed`。
- `test_app_meeting_contract_extension.py -k "template_identity or structured_sections or carry_forward_uses_context"`：`3 passed`。
- 活动 `app_meetings.py` SHA-256：`8a531c9e48a05e0ec41aa0fb1262f60b796ad60a6354d5c8ce42a7e2b914dd5b`。
- 活动模板测试 SHA-256：`f1e634439bc74424f8c34a5c1d098bba67474c0661f600bd16a4e0648ccc19e7`；活动扩展测试 SHA-256：`4405ff01b33f0d475b603653962ad77eeca90da643f87fa3cbe5081c3feabc0a`。
- 修改前回滚副本位于服务器 `compact-production/backups/20260809-summary-revision-r1/`。

这轮没有修改问答模型、引用检索或摘要生成链路；问答专题和其余旧引用断言仍按用户决定延期。
