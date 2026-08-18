# Stage 4 日程模型时间范围回放（2026-08-19）

状态：`isolated candidate evidence; production not changed`。

在候选 `6a80576` 的 `model_only=true` 路径上，对三条自然中文输入做真实 `qwen3.5:9b` 回放：

| 输入形态 | 结果 |
| --- | --- |
| `明天下午三点半到五点开会` | `2026-08-20 15:30-17:00` |
| `明天下午三点半开会到五点` | `2026-08-20 15:30-17:00` |
| `周五下午讨论项目进度` | `2026-08-21`，保留模糊下午时段，不臆造钟点 |

三条均为 `parse_source=local_llm`、`route=model`，没有 quick/fallback。第二条曾因模型压缩
非连续证据短语而丢失时间范围；当前 prompt 要求模型复制完整连续来源，归一化只解析已验证的
证据短语，不重新扫描原句。该回放不等于自然语料人工金标，也不打开 Stage 4 capability barrier。
