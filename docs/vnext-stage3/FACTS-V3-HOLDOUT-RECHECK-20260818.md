# Facts V3 长会议证据包回放复核

- status: `isolated candidate; not production`
- observed: 2026-08-18 Asia/Shanghai
- source: `/home/yydd/下载/会议视频样本` 的现有字幕窗口
- production mutation: `none`

## 变更

长转写在进入 embedding/MMR 之前按原始时间顺序做确定性连续片段打包：单片段最多
360 字符、30 秒；讲话人变化时断开。32 条以内的短会议保持原逐条来源身份。打包来源保存
首尾时间范围、内容哈希和可复现 source ID，模型引用仍经过原文匹配、数字/日期/负责人校验。

此前长会议的证据包包含大量极短字幕条目，虽然机械 topic coverage 为 100%，模型实际只
提炼出一个议题。打包后 `1377173065-1-160.srt` 从 230 个入模碎片降为 36 个连续片段，
estimated input 从约 10k 降到约 5k tokens，模型能同时看到议题、报价、纠正和最终结果。

另外增加了严格的根协议数组分隔符归一化：仅当模型在已知根键 `relations` 或
`action_candidates` 之前漏写 `facts`/前一数组的 `]` 时插入该分隔符，随后仍必须通过完整
JSON 和 Pydantic Schema 校验；不会修复字段、引用或语义内容，也不增加模型调用。

## 结果

报告：`facts-v3-real-holdout-recheck-20260818.json`

```text
8/8 passed
model calls: each case 1 or 2 (no template/second-round call)
paper/report/un/finance/survey/negotiation/equity/tender: all passed
```

覆盖的门包括：事实非空、弱主题覆盖、引用可验证、重复行动为零、宏观长期目标不得作为
高/中适配行动。报告只保存哈希、计数、覆盖和错误码，不保存样本正文，也不把样本内容写入
生产提示词或规则。

## 边界

这次回放关闭了此前的结构/证据包候选缺陷，但仍不是 Stage 3 capability barrier：事实支持率
和行动有效性尚需独立人工盲审，设备页面/任务恢复、旧链路排空、资源和生产切换仍未验收。
