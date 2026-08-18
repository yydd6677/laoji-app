# Q2 citation relevance gate (2026-08-19)

状态：`isolated candidate; not production`。

## 问题

旧 Q2 grounding 只证明 `quote` 是当前 immutable source 的连续原文；模型仍可能引用一段完全真实、
但与回答和问题都无关的来源文字。对于会议问答，这会表现为“引用存在但答非所问”，不能用引用
匹配率 100% 掩盖。

## 实现

`services/laoji-api/app/services/vnext_question_reader.py` 增加确定性最小相关性门：

- 以回答分句为主要上下文，以问题为辅助上下文；
- 中文使用二字短语，数字/英文使用连续 token；
- 引用必须与回答或问题共享至少一个有效短语；
- 引用仍必须先通过原文、来源 ID、hash 和 UTF-8 范围 grounding；
- 相关性不足返回 `Q2_GROUNDING_INVALID`，不调用旧 Q0、不改写引用、不自动换来源；
- malformed/字符偏移导致的单字分句使用完整回答作为相关性上下文，但 byte grounding 仍严格校验。

该门是保守的确定性质量保护，不等同于人工语义相关性证明；完整人工相关率仍需独立 holdout。

## 验证

- Q2 reader：`16 passed`。
- Q2 reader + source stream + device API：`33 passed`。
- 新增回归：精确存在但与回答/问题无关的引用必须失败。
- Python compileall 和 `git diff --check`：通过。

生产 Q2、候选 capability、18020/8030 和公网流量未改变。

