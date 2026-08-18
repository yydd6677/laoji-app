# Facts V3 r8 完整回放

状态：`isolated candidate evidence; not adopted`。

## 本轮通用修复

- 生产提示词版本从 `facts-v3-r7` 升为 `facts-v3-r8`：分章节/分阶段证据至少覆盖主要章节或议题，
  不只摘取人物介绍或局部事项。
- 生成 schema 对单次调用收紧为最多 12 条事实、16 条关系、6 条行动候选；持久 Facts V3 合同
  仍保持 40/48/10 上限。
- 对 provider 在输出预算边界截断的最后一个不完整 root-array item 做结构性丢弃，并关闭可选 root
  数组；不补写事实、不修改引用正文。
- 对模型误放在 fact 对象内部的 `facts/relations/action_candidates` 容器做确定性清理，根级字段仍
  由严格 Pydantic 校验拥有。

## 回放结果

使用 `/home/yydd/下载/会议视频样本` 当前快照的 9 个字幕窗口，字幕只作弱参考，不进入生产 prompt、
规则或源代码。隔离 Ollama 使用真实 `qwen3.5:9b`。

| 指标 | 结果 |
| --- | ---: |
| 用例 | 9 |
| 通过 | 9 |
| 失败 | 0 |
| 正常路径模型调用 | 每例 1 次 |

机器可读报告：`facts-v3-r8-full-final-20260819.json`。

这不是人工事实支持率或行动有效性结论，也不关闭 Stage 3 capability barrier；仍需长会议完整来源
流、人工盲审、Android 页面恢复和 legacy drain。
