# 蓝图修订 0005：自然意图与解析 owner 边界

## 状态

- revision: `0005-natural-intent-and-owner-boundary-20260816`
- status: `candidate`; **not adopted**
- parent: `0004-schedule-speech-boundary-20260816`
- observed at: `2026-08-16 Asia/Shanghai`
- evidence: public localized holdout candidate plus isolated regression triage
- production mutation: none

## 触发原因

0004 将日程首选方向收敛为 `ScheduleSemanticDraft + 可执行时间语义`，但默认把意图
识别当成已有前置能力。自然日历候选回放否定了这个前提：当前 classifier 在 50 条
source query 中只识别 2 条，在 50 条 source remove 中识别 38 条，其余 60 条均进入
create。即使时间实体完全正确，错误的 operation 仍可能把查询或删除投影成创建草稿。

这不是最终准确率结论：候选尚未独立复标，且没有逐行时间锚点。但它足以证明
intent/operation 不是 M1 外围的“简单正则”，而是与 source span、anchor、draft state
一起受版本控制的语义 owner。

详细证据见 [候选 0011](../evidence/candidate-0011-natural-intent-route-20260816.md)。

## 本修订收紧的边界

1. `create/query/delete/clarify/reject/context_edit` 是互斥 operation；query/delete 是
   有效但不可保存状态，不等于 reject。
2. operation、title、date/time、recurrence、reminder、correction old/final 都必须来自
   可追溯的 source span 或显式 draft context。一个 span 不能同时作为标题和可执行日期。
3. 相对时间必须携带该行自己的 reference datetime 和 timezone。缺少锚点时只能保留
   surface phrase/候选，不能按运行当天写 oracle 或保存值。
4. 默认结束时间不是解析事实。只有原文、明确产品默认或用户确认才能产生 end；候选
   合同尚未 adopted 前不得用旧一小时默认作为回归真相。
5. 模型、quick、fallback 和 reject 必须以真实 telemetry 区分；失败模型后的规则结果
   不能计为模型成功。
6. 自然 public holdout、deterministic boundary 和 safety split 分开报告，不得把 10k
   作者化集合、MASSIVE 本地化文本或模型 stub 混成一个“真实通过率”。

## M1 重新定义

M1 仍是当前隔离首选，但 `ScheduleSemanticDraft v1` 只保留为合同原型。下一版 adapter
必须在不增加第二个业务 owner 的前提下补齐：

- stable `source_id/replay_id`；
- operation state，而非 query/delete -> reject；
- `quick/model/fallback/operation/reject` route 与模型尝试 telemetry；
- recurrence/reminder 和 source span；
- correction old/final role、draft anchor/revision；
- 一个纯 span-to-slot executor，禁止 normalizer 再扫描完整 raw text。

这不是要求立刻创造一个更大的 schema。概念预算仍为一个日程语义合同和一个执行器；
若增加字段后旧 classifier、手机规则、服务端规则和 normalizer 仍各自作最终判定，M1
自动否决。

## 回归门重新处分

当前 `81 passed, 10 failed` 改为以下门，而不是笼统要求“91/91 后才研究”：

- 六个真实行为缺陷：保留为 C0/M1 hard gate，并扩展到 text model-only 与 audio
  non-model-only 公共路径。
- 两个 stale helper 测试：删除错误参数假设，改写成 source-span 集成门。
- `本周X`/默认时长：先采用明确 anchor 和 end-time 产品合同，再写断言。
- prompt：先版本化 prompt + adapter schema，以 token、首次合法结构率和 latency
  预算验收；不再用与当前 schema 不一致的 `<1800 chars` 单门。

不得通过删除六个真实失败、放宽 source evidence 或把 fallback 计为 model success 来
恢复绿色结果。

## 下一阶段

1. 对 150 条 test 候选执行独立双人标注，冻结至少 120 条；补充每行 reference、
   timezone、expected fields、clarification 和 semantic event group。
2. 修正隔离 Draft adapter 的 route/state/recurrence/reminder/source identity，不改生产。
3. 以六个真实缺陷建立 span executor hard cases；标题 span 不进入 date/recurrence 执行。
4. 用同一冻结输入比较 C0、M1 executor、Recognizers temporal candidate 和真实 model
   route；分别报告 quick/model/fallback、latency 和字段证据。
5. span producer 只输出 exact quote + occurrence，由执行器确定性定位字符范围；当前
   9B 的 28.5 秒/30 条整批结果不进入无条件首路径，另行比较低延迟专用 encoder 与
   9B complex-only route。
6. 下一隔离实现选择 joint intent/span encoder + deterministic executor；raw
   Qwen3-0.6B 和无中文 checkpoint 的 GLiNER2 multi-v1 均不采用，9B 只保留
   complex-only/teacher 候选。
7. 只有 M1 同时减少至少一个现有 owner、通过冻结 holdout 和六个 hard gate，才提出
   shadow API；否则保持 C0 并重新比较 G1。

## 当前结论

0005 不采用新 parser，也不宣布 M1 有质量收益。它纠正了“意图路由已经解决”和“10 个
失败同质”的错误前提，并把下一阶段收敛为独立标注、span 执行器和 owner 删除证明。
生产 APK、服务、模型、数据库与网络均保持不变。
