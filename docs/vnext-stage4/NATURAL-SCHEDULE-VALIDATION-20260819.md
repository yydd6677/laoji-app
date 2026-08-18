# Stage 4 自然日程语料技术审计（2026-08-19）

状态：`corpus hygiene passed; human field gate remains closed`。

## 自动审计

使用 `natural-schedule-utterances` 技能的注册分布和来源审计，未改写任何用户句子：

| 输入 | 行数 | 结果 | 说明 |
| --- | ---: | --- | --- |
| `candidate-test-150-20260816.jsonl` | 150 | `passed` | 从嵌套 source/source_annotation 提升元数据后内存审计 |
| `annotation-queue-blind-150-20260816.jsonl` | 150 | `passed` | 跳过首行 annotation contract，保留 150 条盲审行 |

两份报告均为：`error_count=0`、`review_flag_count=0`、`oracle_error_count=0`、
`reject_ratio=0`。注册分布满足当前预算：裸命令比例 `0.4`，礼貌标记 `0.1467`，
中位长度 `11.5`、p90 `17`，p90 小句数 `1`，四槽堆叠 `0`，最高开头占比 `0.0733`。

原始 JSONL 的元数据是嵌套结构，直接调用通用 validator 会报“缺少 provenance”；本次只在内存中
将既有 source 字段映射到 validator 所需字段，没有生成或修改语料文件。首行 contract 也只作为
队列元数据处理，不作为一句用户话。

## 不能自动宣称的部分

- 150 条仍来自 MASSIVE 的 CC BY 公共本地化文本，不是第一方自然语音。
- `annotation-queue-blind` 的 `label_source` 仍是 `independent_model_review_not_human`；没有两名
  独立母语人工标注、冲突裁决和按 speaker/semantic-event 隔离的冻结集。
- 因此这次只关闭语料格式、注册预算和元数据映射问题，不提供字段准确率或自然度的人类金标，
  不关闭 Stage 4 capability barrier，也不切换默认 parser。
