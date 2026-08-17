# 候选 0012：ScheduleSemanticDraft v2 合同

## 状态与范围

- status: `candidate; isolated-contract-and-adapter; not adopted`
- observed: `2026-08-16 Asia/Shanghai`
- prototype: `/home/yydd/LaoJi-candidates/schedule-semantic-draft-0002`
- input: candidate 0011 public localized route replay, 150 rows
- production code, service, device, database and APK: unchanged

## 合同变化

v1 的 8/8 测试保留，但不足以表达自然路由证据。v2 增加或收紧：

- stable `source_id` 和每个 clarification source turn；
- `create/query/delete/clarify/reject/context_edit` operation；
- query/delete/context_edit 使用合法且不可保存的 `operation` state；
- `preflight/operation/quick/model/fallback/reject` 等真实 route telemetry；
- recurrence、reminder、逐来源 reference datetime/timezone；
- `value/correction_old/correction_final/intent_control` span role；
- span 必须逐字匹配当前 source，同一字符范围不能同时执行为 title 和 date/
  recurrence 等不同字段；
- clarification 只追加 source turn 和显式字段 patch，使用 draft revision CAS；
- 完整 create 的每个非空可执行字段必须有 `value` 或 `correction_final` span。

最后一项是必要的 fail-closed 修正。第一版 v2 适配曾把 23 条没有 parser span 的结果
标成 complete；这只是在旧字典外包一层 schema。修正后，缺少字段证据的旧结果降为
`needs_clarification`，不会伪装成可保存候选。

## 验证结果

纯合同测试：`11/11 passed`。覆盖：

- 只有开始日期时可保存，结束钟点不被默认注入；
- query/delete operation 与 reject 分离；
- model success 与 failed-model fallback telemetry 分离；
- exact span、cross-field overlap、逐来源相对时间锚点；
- recurrence/reminder 保留；
- clarification source lineage、revision CAS 和 correction role。

把 candidate 0011 的 150 条 route observation 适配为 v2：

```text
adapted_rows: 150
contract_errors: 0
operation: create 110, delete 38, query 2
route: quick 38, fallback 12, preflight 60, operation 40
state: needs_clarification 110, operation 40
```

完整报告：

- `/home/yydd/LaoJi-candidates/schedule-semantic-draft-0002/natural-route-drafts-150-report-20260816.json`
- `/home/yydd/LaoJi-candidates/schedule-semantic-draft-0002/natural-route-drafts-150-20260816.jsonl`

150 条全部能被合同无损表示，但这不是 150 条解析通过。当前 parser observation 没有
source spans，MASSIVE 也没有逐行 reference datetime；因此 110 个 observed create 全部
被 v2 fail-closed 为待确认。public source annotation 只保留在 Draft 旁边，绝不注入成
“当前 parser 已产生的证据”。

## 设计含义

1. v2 证明一个合同可以同时表达意图误路由、模型尝试、fallback 和不可保存 operation，
   不再把它们压成一个 reject/null。
2. v2 尚未证明当前 parser 能生成可靠 span；因此不能直接进入 shadow API。
3. 若下一步只是从 full raw text 用旧正则补造 span，owner 数没有减少，M1 自动否决。
4. 下一候选必须比较一个真正的 span producer + 单一 executor：title span 不进入时间/
   recurrence 执行，correction old 永不覆盖 final。
5. 只有独立标注 holdout 提供 reference/expected fields 后，才能判断 fail-closed 是正确
   拒绝还是过度澄清，当前不能把 110 条待确认当作产品目标。

## 决策

保留 v2 为下一轮 adapter/replay 合同，仍为 `not adopted`。不修改生产 parser，也不把
v2 的字段数当作架构收益；真正的采用门仍是删除至少一个旧 owner、六个真实 hard case
通过、自然冻结集提升和端到端等待边不增加。
