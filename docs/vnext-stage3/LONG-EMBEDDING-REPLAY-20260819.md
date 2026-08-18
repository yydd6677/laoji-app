# Stage 3 长会 embedding 证据包回放（2026-08-19）

状态：`candidate evidence; production not changed`。

## 回放边界

- 使用当前验收样本 `1437681208-1-192.srt` 的弱参考字幕，不将字幕正文写入生产 prompt、规则或源码。
- 回放运行在隔离 API release `d193dd2` 的同一 Python/Provider 配置中，实际调用候选 Ollama embedding 和生成模型。
- 输出报告只保留来源哈希、计数、覆盖率和耗时，不保存转写或模型正文。

## 结果

| 项目 | 结果 |
| --- | --- |
| 原始来源段 | `1946` |
| 时间连续打包段 | `163` |
| 纳入证据段 | `60` |
| 输入估算 | `10,185 tokens` |
| embedding | `true`，真实 `qwen3-embedding:0.6b` |
| 主题覆盖 | `1.0` |
| 选段比例 | `0.368098`，这是 MMR 选段比例，不是事实支持率 |
| Facts 模型调用 | `1` |
| Facts / action | `2 / 1` |
| 证据构建耗时 | `16,895.2 ms` |
| 生成耗时 | `22,841.8 ms` |
| 候选结果 | `passed=true` |

## 解释和未闭合门

这次回放证明超预算路径能够真实使用 embedding、保持 10,240 token 输入预算并完成一次结构化生成；
没有静默截断或第二个模型 owner。`source_coverage=0.368098` 是在预算内由 MMR 选择的来源段比例，
不能解释为逐段事实覆盖率。来源还是弱参考字幕而非完整 ASR，且尚无独立人工事实支持率、行动有效性、
引用相关性和 Android 页面恢复证据，因此不能关闭 Stage 3 capability barrier，也不能切生产。
