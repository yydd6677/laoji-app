# 候选 0016：Schedule Mention Graph v0 合同

## 状态与边界

- status: `isolated contract prototype; not adopted`
- observed: `2026-08-16 Asia/Shanghai`
- candidate root: `$CANDIDATE_ROOT/schedule-joint-encoder-0001`
- model/training/ONNX: none
- production mutation: none

研究 0010 否决 flat `operation + independent spans` 直接成为目标 owner：它无法表达范围配对、
时段限定、纠正替换、跨轮 patch、查询/删除目标和不连续标题。如果再由 executor 扫描完整原文
补关系，executor 会重新成为 parser。

候选因此保留 flat 合同作为被证伪基线，新增 `Schedule Mention Graph v0`：

```text
operation + exact mentions + field/role + relation whitelist + OOD score
        -> deterministic graph validator
        -> graph-only executor
        -> ScheduleSemanticDraft candidate
```

relation 白名单为 `qualifies/pairs_with/replaces/negates/targets/composes/refers_to`。validator
检查逐字来源、source revision、置信门、关系端点/形状、跨 source draft context、纠正闭合、
range 闭合、语义环、query/delete role 和 OOD 拒识。validated graph 只保留 source hash、
reference/timezone、mention text 与关系；executor 看不到完整 utterance。

## 合同验证

隔离标准库测试 `26/26 passed`，覆盖：

- correction final 通过 `replaces` 淘汰 old；
- `time_period -> time` 的 `qualifies`；
- start/end 必须显式 `pairs_with`，不按词序猜测；
- query/delete 条件只进入 filters，结果永不可保存；
- 跨 turn replacement 必须携带 `draft_id + revision`；
- 低 operation/mention/relation confidence 与高 OOD fail closed；
- 多段 title 必须形成单一 `composes` 链；
- title 中日期/重复词不再进入时间 executor；
- validated executor 不持有 raw source text。

测试 resolver 是显式 fixture，不是时间 parser；26/26 只证明合同拒绝边界，不证明自然中文质量、
模型能产出正确 graph、延迟、量化、Android offset 或 owner 可删除。

## 采用阻塞

1. relation/cross-turn/OOD/query target/delete target 尚无足够独立人工 gold；
2. 150 条自然候选尚未完成双人复标；
3. relational encoder 与 grounded structured decoder 尚未在同一 graph 合同上训练对比；
4. 未跑完整 graph exact、silent-create、selective risk、目标真机延迟/RSS/功耗和跨平台 offset；
5. executor 的真实单 mention date/time resolver 尚未证明能保持窄职责；
6. 当前六类生产语义 owner 均未删除。

因此当前决策是冻结合同、补人工关系真值，再让两个 producer 反事实竞争；不得为了尽快训练 flat
模型而把 relation 重新写成全文规则。
