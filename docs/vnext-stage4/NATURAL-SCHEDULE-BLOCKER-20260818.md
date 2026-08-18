# Stage 4 日程字段验收边界

当前可复用的自然中文资料有两类，但都不能直接给出 LaoJi 字段准确率：

1. MASSIVE `zh-CN` 自然语域资产（2166 条）有公共意图和翻译来源 span，但没有每行的
   LaoJi `reference_datetime`，也没有独立确认的标题、开始/结束时间、重复、提醒和澄清金标。
   已完成的 `schedule-model-route-smoke-20260818.json` 只报告 route/model 调用状态，不报告字段分数。
2. `LaoJi-candidates/natural-schedule-holdout-0001` 已生成 150 条盲审队列，并隐藏公共意图、
   slot 和解析观察；当前每条要求两名独立母语人工标注，尚无完成的双人 adjudication，因此不能
   把候选或模型评审升级为 human oracle。

已有 10k 控制集、旧 parser 输出和公共 MASSIVE slot projection 只能作为 deterministic boundary
或 source supervision，不能冒充自然字段 holdout。Stage 4 的准确率退出门保持关闭，直到完成
至少两人独立标注、冲突裁决和按 speaker/semantic-event 隔离的冻结集。

这不是代码失败，也不应通过把旧规则结果写回 `expected_fields` 来“补齐”证据；那会让被测
解析器给自己造金标。
