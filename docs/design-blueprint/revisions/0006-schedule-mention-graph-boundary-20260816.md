# 蓝图修订 0006：日程 Mention Graph 与 producer 反事实边界

## 状态

- revision: `0006-schedule-mention-graph-boundary-20260816`
- status: `candidate`; **not adopted**
- parent: `0005-natural-intent-and-owner-boundary-20260816`
- observed: `2026-08-16 Asia/Shanghai`
- production mutation: none

## 本轮推翻的假设

0005/研究 0009 将下一隔离候选写成
`joint intent/span encoder -> deterministic executor -> ScheduleSemanticDraft`。独立反事实复核确认：
flat operation/span 只能定位互相独立的片段，不能天然表达纠正新旧值、起止配对、时段限定、跨轮
补充、query/delete target 或多段 title。若 executor 再扫描完整原文补这些关系，就会重新造出
一套 parser，违背单 owner 和概念预算。

因此 flat joint encoder **不再是目标架构**，只保留为速度/简单句基线。完整论证见
[研究 0010](../research/0010-schedule-semantic-owner-counterfactual-20260816.md)。

## 新的候选边界

目标候选改为：

```text
Schedule Mention Graph
  -> relational joint encoder  -----+
  -> grounded structured decoder ---+-> one graph validator
  -> server model teacher/ceiling ---+-> one narrow executor
                                           -> ScheduleSemanticDraft
```

- relational encoder 是当前主要隔离候选，不是预设赢家；
- grounded structured decoder 必须使用完全相同的 graph、executor、train/dev/frozen test 与资源门；
- server model 只作 teacher、质量上界和 complex-only producer；
- 一次请求只能选择一个 producer，禁止字段级拼接和长期 fallback；
- C0 多 owner 链只作整链 rollback，不再新增词面分支；
- executor 只能解释已选择的单个 mention，不接收完整 raw text。

候选 graph 的最小概念是 source、operation、mention、relation、draft context、producer revision。
它不新增业务任务表、网络队列或 UI 状态 owner。

## 新证据

### 公共源监督

[候选 0015](../evidence/candidate-0015-joint-encoder-source-data-20260816.md)已建立可复现的
MASSIVE train/dev operation/span 预适配资产：1,648 条 active train、280 条 dev、3,000 个 source
spans；150 条 test 继续冻结，已知 semantic skeleton 泄漏已 quarantine。该资产不是 LaoJi gold，
也不含充分 relation/OOD/cross-turn 真值。

### Mention Graph 合同

[候选 0016](../evidence/candidate-0016-schedule-mention-graph-contract-20260816.md)以 26 项隔离测试证明
graph validator 可以在不让 executor 接触完整原文的情况下表达 correction/range/qualification/
cross-turn/query-delete/title composition，并对低置信和 OOD fail closed。fixture 不是模型或时间 parser，
因此没有质量收益声明。

## 当前 owner 删除门

任何 producer 进入 shadow 前必须证明最终可删除或旁路至少一项，进入默认前必须给出整组退出计划：

1. 客户端 `parseLocalScheduleText()` 的最终语义职责；
2. 客户端 `classifyScheduleParseIntent/Route()` 的最终 create/query/delete 正则；
3. 客户端 normalizer 对完整原文的 date/time/recurrence 二次扫描；
4. 服务端 intent preflight、quick/fallback parser 的最终语义职责；
5. 服务端模型后 full-text normalizer 的字段重算；
6. clarification 对完整旧 raw text/draft 的重新推断。

兼容期允许一个发布周期的 C0 整链 kill switch，不允许逐字段 fallback 长期存在。

## 当前不执行的工作

- 不下载、训练或部署 relational encoder/decoder checkpoint；
- 不用 150 frozen test、旧 parser 结果或 9B weak label 填 relation gold；
- 不修改生产 parser、API、APK、数据库、服务或模型；
- 不把合同测试、MASSIVE source agreement 或自动代理复标写成人工质量通过。

本轮曾创建隔离 Python/Transformers 环境，但在反事实研究推翻 flat 目标后、任何 checkpoint 下载
或加载前即停止，并清理了 158 MB 临时环境；该探针不占生产显存，也不改变服务器。

## 下一阶段顺序

1. 冻结 Mention Graph annotation schema、双人协议、relation/OOD/cross-turn split 和 adjudication；
2. 完成至少 120 条自然 frozen test 的两人复标；自动模型审阅只能缩小分歧队列；
3. 从独立自然来源补 relation、clarify/context edit、reject/OOD 和 operation target gold；作者化边界
   必须单列，不能冒充自然语料；
4. relational encoder 与 grounded structured decoder 在相同数据上竞争，server model 只作 ceiling；
5. 分别报告 operation/mention/relation/graph/Draft、silent-create、selective risk、延迟、RSS 和量化漂移；
6. 只有胜者能删除旧 owner、冻结集改善且目标真机首 Draft 更快，才设计 shadow API。

如果人工 relation 数据不足或 structured decoder 明显更优，停止保护 encoder 路线；不得把 relation
逻辑退回手写全文正则。

## 当前结论

0006 收紧而未采用新的 parser。它推翻 flat encoder 目标，冻结一个更能表达真实日程语义的 graph
合同，并把 producer 选择改为同合同反事实竞争。生产仍保持 C0；当前最大风险从“模型选得不够小”
转为“缺少可审计 relation/cross-turn/OOD 人工真值”。
