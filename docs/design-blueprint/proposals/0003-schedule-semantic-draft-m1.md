# 提案 0003：ScheduleSemanticDraft M1 嵌入方案

> Producer 层已由蓝图修订 0006 收紧：flat intent/span encoder 不再是目标架构；
> `ScheduleSemanticDraft` 继续作为下游候选，但其上游必须先通过 Schedule Mention Graph
> validator，且 relational encoder 与 grounded structured decoder 需同合同竞争。

## 状态

- status: `candidate; architecture-only; not adopted`
- parent revision: `0005-natural-intent-and-owner-boundary-20260816`
- observed: 2026-08-16 Asia/Shanghai
- 目标：在不改变生产保存行为的前提下，验证一个共享日程语义合同能否删除跨端路由和默认值分叉。

## 现状边界

当前客户端 `src/services/api.ts` 的 `parseText()` 同时做三件事：

1. 调用 `parseLocalScheduleText()` 并根据 `classifyScheduleParseRoute()` 决定网络路由；
2. 把本地/远端字典归一化成旧 `ParseResult`；
3. 将 `ParseResult` 直接交给确认界面和保存映射。

服务端 `app/api/device_v1.py` 的 `/schedule/parse` 接收客户端路由状态，
`app/services/schedule_parser_service.py` 再自行决定 reject、quick、model、repair
和 fallback。`/schedule/clarify` 接收完整旧草稿和补充文本，结果没有一个跨端
`draft_revision`/source span 合同。

这不是单纯的“规则重复”；它让默认结束时间、上午/下午歧义、查询标题和补充语义
在不同 owner 中分别决定。M1 必须先把这些决定从旧 `ParseResult` 中抽出来，不能
直接把现有返回类型换一个名字。

## 目标合同

隔离阶段采用候选原型中的 `ScheduleSemanticDraft v1`：

```json
{
  "schema_version": 1,
  "source": {
    "text": "明天三点开会",
    "mode": "text|audio_transcript",
    "reference_datetime": "2026-08-16T10:00:00+08:00",
    "timezone": "Asia/Shanghai"
  },
  "source_id": "stable replay/source id",
  "intent": "create|query|delete|clarify|reject|context_edit",
  "route": "local_safe|server_required|preflight|clarify|operation|reject|quick|model|fallback",
  "slots": {
    "title": null,
    "start_date": null,
    "end_date": null,
    "start_time": null,
    "end_time": null,
    "time_period": null,
    "event_type": "once",
    "location": null,
    "recurrence": null,
    "reminder": null
  },
  "state": "complete|needs_clarification|operation|reject",
  "missing": ["start_date"],
  "spans": {"start_time": [{"text": "三点", "start": 2, "end": 4}]},
  "provenance": {
    "engine": "mobile-local|server-quick|server-model|recognizers",
    "engine_revision": "...",
    "draft_revision": 1,
    "parent_revision": null
  }
}
```

合同的保存边界是明确的：创建草稿只有开始日期必需；开始/结束钟点独立可空；
查询/删除是合法 `operation` 但永远不可保存，拒绝则是另一种状态；不确定的时间保留
候选或 `missing`，不得静默选值；clarification 只改变同一草稿的 revision。当前隔离
v2 合同已补齐上列 operation、route、recurrence/reminder 和 source identity，并完成
150 条 observed route 的 fail-closed 适配；但当前 parser 尚不产出可验证 span，所以
这仍是隔离合同，不是生产可保存实现。

## 隔离嵌入方式

### 1. 两个只读 adapter

在 `$CANDIDATE_ROOT/schedule-semantic-draft-0001` 继续维护：

- `mobile-local adapter`：把当前 `ParseResult + classifyScheduleParseRoute` 映射
  到 Draft，保留原始 route 和 `parse_source`；不重新解释日期。
- `server adapter`：把 `/schedule/parse` 或 `parse_schedule_text_sync()` 的字典映射
  到 Draft，保留 `route/model_attempted/fallback_used`；不在客户端再次清洗标题或
  默认结束时间。
- `recognizers adapter`：只映射时间实体、候选和 source span；没有标题/intent 时
  必须保持 `needs_clarification` 或 `incomplete`，不能伪造完整 Draft。
- `model span adapter`：模型只提出 operation、exact quote、occurrence 和 semantic
  field/role；本地确定性解析 start/end。不存在的 quote 被删除，唯一 quote 的错误
  occurrence 可归一为 1，重复 quote 不猜测。模型不得直接输出 canonical date 或保存值。

三个 adapter 输出 `field_diff()` 报告；任何冲突都进入报告，不选择“字段更多”的
一方作为真相。

### 2. Shadow 回放，不新增生产 API

第一阶段不改 `/schedule/parse` 合同，也不让手机上传新字段。回放 runner 读取：

- 脱敏文本、reference datetime、timezone；
- 当前手机规则结果和路由；
- 服务端 quick/model-only 的已有结果或隔离执行结果；
- 可选 Recognizers 实体。

输出 Draft、字段差异、耗时、模型是否调用和默认值变化。原文不出本机，报告只保留
哈希、字段、span 和错误码。

### 3. 只有通过后才设计生产双轨

若 M1 回放证明能消除差异，再按以下顺序嵌入：

1. 服务端新增内部 shadow 入口，返回 Draft envelope；旧 `/schedule/parse` 继续作为
   兼容投影，不能新增第二套业务判定。
2. 客户端 `parseText()` 先消费 Draft，再由一个纯函数投影到旧 `ParseResult`，确认
   UI 和保存层暂不改；投影必须携带 `draft_revision`，不丢 `missing/spans`。
3. clarification 传 `draft_revision + patch`，服务端返回新 Draft；旧 `current` 字典
   只作为兼容输入，不能继续成为长期真相源。
4. 对真实自然 holdout 和回归集通过后，才把 Draft 作为默认内部模型，并删除客户端
   “本地是否允许远端”的最终路由门禁；本地只提供低延迟候选。

## 明确的删除目标

M1 不是在旧链路外面包一层 facade。进入生产候选时必须删除或旁路至少一组：

- 客户端 `classifyScheduleParseRoute()` 中决定最终语义的正则分支；
- 服务端 quick parser 对同一输入的第二次日期/时间解释；
- `normalizedParseResult()` 中按原文再次补 `time_period`/默认值的隐式逻辑；
- clarification 以完整旧 `ParseResult` 重新推断而非 patch 的路径。

如果这些 owner 仍同时存在，M1 只能保持 shadow，不得宣称架构简化。

## 迁移、回滚和兼容

- 旧客户端继续收到旧 `ParseResult` 投影；新 Draft 仅通过能力位或 shadow header 读取。
- Draft 不写日历、不修改现有事件表；保存仍由旧确认界面执行。
- 每个 Draft 记录 source text hash、reference/timezone、engine revision 和 parent
  revision；服务器不可用时保留本地候选和明确的需补充状态。
- 回滚只需关闭 shadow/能力位并停止读取 Draft；不需要回滚数据库或删除用户日程。
- 若字段差异、自然 holdout 或延迟门失败，删除 candidate adapter，不修改生产 parser。

## 验收门

### 语义

- 当前 8 条 paired replay 的 route、intent、slots、state 差异全部可解释；不能有
  未报告的默认结束时间或时段静默选择。
- 当前 schedule 回归的六个真实行为缺陷必须归零；两个反传 private helper 测试改为
  source-span 集成门；`本周X`/默认时长和 prompt schema 先完成 adopted 合同再断言。
  当前 `81 passed, 10 failed` 不能被当成同质分数或笼统阻塞外部只读比较。
- clarification 的 stale revision、跨时区、DST、查询/删除和重复规则均有字段级
  回放；二次确认前没有保存副作用。

### 性能与资源

- 分开报告 local candidate、server quick、server model、audio ASR 四段延迟；不能
  用 Recognizers 的 warm microbenchmark 替代端到端指标。
- M1 不增加常驻模型、任务 owner 或服务器显存；外部时间库只在 CPU 隔离运行。
- 现有 9B span-text-r2 的单批 30 条 wall time 为 28.5 秒，不能进入日程创建首结果的
  无条件路径；raw Qwen3-0.6B 同输入只有 6/29 source-intent agreement，亦被否决。
  下一隔离候选为 joint intent/span encoder + deterministic executor，9B 仅保留
  complex-only/teacher route。

### 隐私和恢复

- shadow 报告不含原文、文件名、地点、人名或音频；只保留哈希、字段和错误码。
- 进程中断、重复请求和 stale clarification 不得覆盖新草稿；Draft 版本可重放。

## 当前决策

提案保持 `candidate; not adopted`。v2 合同、Recognizers 时间实体探针和 150 条
public localized 路由回放已经暴露 intent owner 与 adapter 缺口，但尚不足以授权修改
`src/services/api.ts`、服务端 parser 或生产 API。下一项是对 150 条候选独立复标并冻结
至少 120 条，同时实现隔离的 span producer + 单一 executor；
不能把未经复标的 `90/150` 诊断数当成质量基线，也不能跳过六个真实行为缺陷直接切换。
