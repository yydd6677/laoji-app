# Stage 4 public natural source supervision (2026-08-19)

状态：`source supervision only; field_promotion_eligible=false`。

## 手机 admission

`tools/vnext/evaluate_schedule_mobile_intent.cjs` 在临时目录转译并调用真实
`classifyScheduleParseIntent()`，不复制一套测试分类器。输入为 150 条 MASSIVE zh-CN 日历语料，
报告只保存 source ID 和 utterance SHA-256，不保存正文。

- intent exact：`144/150 = 96%`，超过本次来源监督最低值 95%；
- delete：`50/50`；create 源标签 `47/50`；query 源标签 `47/50`；
- 6 条差异中包含明显的源标签/语义冲突，例如带“取消所有会议”的语句被源数据标成 create；候选
  保持 delete，不为追求标签分数改写产品语义。

报告：`natural-schedule-mobile-intent-20260819.json`。

## 隔离 Graph source/span 回放

`tools/vnext/evaluate_schedule_graph_source_supervision.py` 将同一 150 条的 source intent 当作调用方
admission 直接送入隔离 `/api/laoji/v2/schedule/graph`，用于观察 owner、来源哈希、span 和失败关闭；
它不是最终手机路由的端到端准确率。

- `134/150` 返回结构化 Graph；query `50/50`、delete `50/50`、create `34/50`；
- 134 个成功结果的 source SHA-256 和所有返回 span 边界均为 `134/134` 精确；没有 complete Graph
  缺少 start date；
- 成功创建中 22 条使用 `server-model`，12 条由 recognizer 形成 clarification/complete；
- 成功请求 p50 `18.3ms`、p95 `1956.3ms`，不含 16 个 HTTP 503；
- 16 个 503 全部来自 source 标为 create、但正文只有“这个事件/此日期/这件事”等缺失当前指代或
  独立事项内容的公共助手句。候选路由没有取得可验证 observation，Graph 按既有合同失败关闭，没有
  伪造可保存日程；同批相邻模型创建请求正常完成，因此不能把这组结果简单解释成服务整体宕机，也
  不能把这些句子当作有效 LaoJi 创建样本强求成功。
- source slot span recall 为 `78.4615%`；MASSIVE slot 只用于来源表面监督，不能替代 reference datetime、
  canonical date/time 或完整字段人工金标。

报告：`natural-schedule-graph-source-supervision-20260819.json`。

## 结论

这批证据证明了自然语域下的 admission 基本边界、操作零模型路径、模型创建路径、来源原文约束和
失败关闭。它没有满足蓝图的自然日程质量门；Stage 4 仍需要至少 30 条独立双人标注和裁决的 LaoJi
field holdout，并需字段完全正确率 >=95%、日期/时间/操作关键字段召回率 >=98%、错误保存为 0。
