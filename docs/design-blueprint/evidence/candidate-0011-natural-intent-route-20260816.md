# 候选 0011：自然日历意图与路由边界

## 状态与范围

- status: `observed; isolated public-corpus replay; not adopted`
- observed: `2026-08-16 Asia/Shanghai`
- source: AmazonScience/MASSIVE `zh-CN`, calendar scenario, CC BY 4.0
- adapter: `/home/yydd/LaoJi-candidates/natural-schedule-holdout-0001`
- production code, service, device, database and APK: unchanged

本证据回答的是“当前解析器先把一句话送到哪条路”，不是“模型或整套产品的自然语言
准确率”。MASSIVE 是 crowd-localized 助手文本，不是老记用户日志、自然语音或
speaker-held-out 数据；其 source intent 可以用于候选筛选，但尚未经过独立老记字段
复标。

## 资产审计

`massive-zh-calendar-natural.jsonl` 共 2,166 行，ID 和文本均唯一：

| source intent | rows |
| --- | ---: |
| `calendar_set` | 1,038 |
| `calendar_query` | 733 |
| `calendar_remove` | 395 |

manifest 中 natural asset 的 SHA-256 为
`1f2c154b3e6b5098d2478d55a17d01c83ee19bd5423f6a43779acf97cbab49a`，
实测匹配。现有 validator、register profile 和 register self-test 均通过；这只证明来源、
语域和格式门通过。资产没有 `reference_datetime`、timezone、独立 `expected_fields`、
speaker 或 semantic-event 分组，因此不能据此报告相对日期、字段 F1 或 speaker-held-out
质量。validator 的 oracle error 为 0 是因为 oracle 没有执行，不是字段全部正确。

## 隔离回放

从 source `test` 分区中排除任一 `slots_score=0` 的行，按 source intent 确定性抽取
150 条，每类 50 条。原文、source ID、分区、license、annotated slots 均原样保留；
没有改写、slot 替换或笛卡尔扩展。

默认 `quick-observe` 模式把任何模型调用替换为立即失败 guard，因此可以准确区分：

- quick 完成；
- 意图 preflight；
- 已尝试模型后进入 fallback；
- 未调用模型。

结果：

| source intent | current observed intent | count |
| --- | --- | ---: |
| create | create | 50 |
| query | query | 2 |
| query | create | 48 |
| delete | delete | 38 |
| delete | create | 12 |

50 条 create 候选中，38 条由 quick 返回非空结果；其余 12 条尝试模型后，因为隔离
guard 而 fallback 到空结果。总计 `model_attempted=12`、`model_success=0`、
`fallback_used=12`。这里的 0 个模型成功是实验设计，不是模型失败率；真实模型没有
被调用。

完整候选与报告：

- `/home/yydd/LaoJi-candidates/natural-schedule-holdout-0001/candidate-test-150-20260816.jsonl`
- `/home/yydd/LaoJi-candidates/natural-schedule-holdout-0001/candidate-test-150-report-20260816.json`

150/150 均因来源未提供逐行锚点而标记 `oracle_unavailable`，所有相对日期得分被保留
为空。`intent_match=90/150` 只能描述当前 source-intent 对 current classifier 的诊断
矩阵，不能称为老记最终自然语言准确率。

## 回归失败重新分组

同一隔离服务工作树重新执行仍为 `81 passed, 10 failed`，但 10 个失败不是同一性质：

- 6 个当前产品缺陷：纠正前缀残留成标题、标题中的日期词污染日期槽、标题中的
  `工作日` 污染 recurrence。这些影响 non-model-only 正规化路径和音频解析，应保留为
  公共路由硬门。
- 2 个 stale/private-helper 测试：`_prefer_surface_title(model_title, surface_title)`
  的参数在测试中反传，另一个 anagram 期望超出 helper 合同。应改成 source-span 集成
  测试，不能为通过旧断言而改生产行为。
- 2 个候选边界：`本周五` 的过去/未来锚点和隐式一小时结束时间尚无 adopted 产品
  合同；prompt 长度测试仍期待旧 canonical-field schema，而当前 prompt 已转向 evidence
  phrase 且内部 owner 描述冲突。两项都需要先定 schema/anchor 合同。

因此，`81/91` 不能作为候选通用质量分，也不能要求 Recognizers 比较先迎合两个 stale
helper 断言；六个真实行为缺陷仍不能被放宽。

## 对 M1 的影响

`ScheduleSemanticDraft v1` 的 8/8 合同测试仍有效，但合同范围不足：

1. `route` 必须表达 `model` 和 `fallback`；不能只表达 local/server/quick。
2. query/delete 是有效但不可保存的 operation，不能统一压成 `reject`。
3. join key 必须是 `source_id/replay_id`，不能按 text 拼接。
4. recurrence、reminder、纠正 old/final role 和 anchor 必须进入语义合同。
5. title/date/time/recurrence span 必须互斥执行；标题中的“周末/工作日”不能再次被
   日期或重复规则扫描。
6. intent routing 是共享语义的一部分，不能在时间实体适配器之外保留一套最终
   create/query/delete 正则 owner。

首轮 150 条只能作为复标候选。下一道门是双人独立标注并冻结至少 120 条（每类至少
40 条），每行增加自身 reference/timezone、expected intent/fields、clarification、
semantic event group 和 review state；reject/clarify 另建真实来源 safety split，不能
从 MASSIVE calendar intent 强行改写。

## 决策

继续 M1 隔离方向，但将范围从“共享时间/字段草稿”扩大为“共享意图、证据 span、锚点、
草稿 revision 和真实路由 telemetry”。仍不授权修改生产 parser、`src/services/api.ts`
或保存链路。只有独立复标 holdout、六个行为硬门和删除旧 owner 计划同时闭合后，才
允许设计 shadow adapter。
