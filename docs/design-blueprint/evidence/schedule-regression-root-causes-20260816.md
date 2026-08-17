# 日程回归失败根因审计 2026-08-16

## 范围

本报告只读分析当前服务工作树的 `10` 个失败，不修改服务源码或测试，不把
失败修复前的状态写成已采用方案。失败总快照见
[schedule-quick-regression-20260816](schedule-quick-regression-20260816.md)。

## 逐类根因

| 失败组 | 现行代码证据 | 判断 | M1 处理方式 |
|---|---|---|---|
| 纠正前缀返回“ 不/想排 ” | `_extract_pre_correction_subject()` 在首个 `改成/改到` 前直接把 prefix 交给 `_extract_title_and_description()`；否定壳和“原来想排”没有被完全剥离 | 当前规则真实缺陷，不是测试噪声 | 用模型/实体 span 标记旧值与最终值，禁止从否定 prefix 猜标题；旧函数最终删除 |
| 纠正尾句日期被标题中的“周末”污染 | `_normalize_llm_result()` 对完整 raw text 调 `_parse_authoritative_date()`；“周末酒店房型确认”中的“周末”可先于“后天”被解析 | 规则重新扫描原文导致 title/date 串扰 | 只使用模型/时间实体提供的 date span；标题 span 不参与日期执行 |
| “工作日早餐预约”触发重复规则清空日期 | `_normalize_llm_result()` 直接在 raw text 上运行 `_parse_recurrence_rule()`，把标题词当 recurrence marker | 当前规则 owner 无法区分语义槽与标题词 | recurrence 只能来自明确 recurrence entity/span；不从标题词推断 |
| “本周五”纠正得到下一个周五而非上下文所需日期 | `_parse_authoritative_date()` 使用当前日期的 upcoming weekday 逻辑，未表达“刚才/原来”语境下的相对锚点 | 这是时间锚点合同缺失，不应靠再加正则解决 | Draft 携带 anchor、关系和用户确认 revision；无法判断时澄清 |
| surface title 优先级两个测试失败 | `_prefer_surface_title(model_title, surface_title)` 的参数语义、调用方和测试期望不一致；长度比较只看字符数 | 接口命名/参数 owner 已漂移 | Draft 以 source spans 和 title candidate 列表比较，不保留隐式长度启发式 |
| prompt 长度门失败 | `_SYSTEM_PROMPT_TEMPLATE` 当前约 2331 字符，测试要求 `<1800` | 现行 prompt 合同与测试门不同步；不是模型质量证明 | M1 把时间执行约束移出 prompt，模型只产候选 patch；重新定义 prompt 门 |

## 现场函数探针

同一服务工作树、固定 `2027-01-13` 参考时间的只读探针观察：

- `不是今天，改成10月3日晚上七点做项目汇报` 的 pre-correction subject 为 `不`；
- `原来想排这周六，改到周末下午一点预算评审` 的 pre-correction subject 为 `想排`；
- `不是1月15日，改成后天上午九点做周末酒店房型确认` 的 authoritative date 为
  `2027-01-16`，说明标题里的“周末”污染了相对日期；
- `原来想排4月29号，改到明天下午一点工作日早餐预约` 的 surface title 正确为
  “工作日早餐预约”，但后续 recurrence 规则仍可能把标题词当重复标记；
- `把刚才那个安全培训改成本周五下午三点` 的日期按 upcoming weekday 得到
  `2027-01-15`；测试期望取决于“本周”锚点合同，当前实现没有显式记录该合同。

这些结果支持“来源 span + 可执行时间语义”方向，但不支持直接替换生产规则；
它们也说明修复单个正则会继续增加隐式 owner。

## 处理决定

1. 现有失败集合保持为 M1 的硬门，暂不放宽测试，也不删除困难样本。
2. 若要恢复当前 C0，必须先明确哪些测试体现最新产品决定（例如开始日期单独
   保存、纠正锚点），再修复；不能盲目恢复旧快照。
3. 生产候选应优先实现只读 span/anchor adapter，再重新运行这些测试；在此之前
   不把 Recognizers 或模型输出直接接入保存路径。
