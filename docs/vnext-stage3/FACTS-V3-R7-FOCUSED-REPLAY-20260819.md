# Facts V3 r7 聚焦回放

状态：`isolated candidate evidence; not adopted`。

本次只调整了生产提示词的通用语义约束，并将提示词版本从 `facts-v3-r6` 升为
`facts-v3-r7`。没有加入会议标题、人物、行业、字幕原文、few-shot 或样本专用规则。

新增约束：实验结果、性能/指标变化、已完成工作、算法能力描述和结论性陈述默认归为
`conclusion/context`；只有来源明确表达仍需由人或团队执行的有限下一步，才可归为
`action` 并生成行动候选。

## 回放边界

- 输入：`/home/yydd/下载/会议视频样本` 当前快照的两个字幕窗口。
- 字幕只作弱参考，正文不写入报告、源代码或生产提示词。
- Provider：隔离 Ollama `qwen3.5:9b`。
- 正常路径每个用例 1 次模型调用；本回放没有结构修复调用。

## 结果

| 用例 | 结果 | 模型调用 | 备注 |
| --- | --- | ---: | --- |
| `paper` | `PASS` | 1 | 性能提升不再被误生成为中等适配行动 |
| `energy-planning` | `PASS` | 1 | 保留有限 UI 交付候选并通过来源校验 |

机器可读报告：`facts-v3-r7-focused-20260819.json`。

这不是人工事实支持率或行动有效性结论，也不关闭 Stage 3 capability barrier；仍需独立
人工盲审、长会议完整来源流、Android 页面恢复和 legacy drain 证据。
