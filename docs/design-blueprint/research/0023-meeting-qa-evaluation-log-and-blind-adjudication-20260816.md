# 研究 0023：会议问答运行日志与盲审评估链

## 状态

- status: `research candidate; not adopted`
- date: `2026-08-16 Asia/Shanghai`
- production/service/database/App/APK/device/GPU/model mutation: `none`
- private meeting or production model use: `none`

## 为什么必须重新定义问题

Q2 的生产方向仍是不可变证据、单次 attributed reader 和确定性引用校验，但连续两个自制
四条件 harness 都被独立审计否决：

- 0015 依赖调用方自报 identity，把语义、引用和 coverage 合成一个 success，并丢弃主要 gold；
- 0016 增加哈希和 AND/OR 证据合同后，真实调用、真实输出和真实复核仍未闭环：同一输出可冒充
  四种条件，审阅答案不必等于 Provider 输出，coverage/citation 仍可自报，repair 还可逃出共同
  identity。

这不是再补字段的问题。错误前提是把 generation、确定性验证、人工语义判断和归因报告放进
一个 LaoJi 专用文件，就能靠更多 schema 获得可信评测。第三轮同形状补丁被禁止。

## 三条路线比较

| 路线 | 复现与审计 | 复杂度 | 决定 |
|---|---|---|---|
| 继续补 0016 | 两轮反例已证明容易形成自报闭环 | 字段和测试继续增长 | 拒绝 |
| 自研三进程 runner/scorer/reviewer | 可以闭合，但仍要自建日志、恢复、离线重评分和审阅历史 | 高 | 仅作反事实 |
| Inspect AI 日志骨架 + 老记 scorer + 盲审 | 复用稳定 sample、原始 output/event、离线评分和 provenance；只自研领域合同 | 中 | 首选隔离 challenger |

这里的 Inspect 是英国 AI Security Institute 维护的开源评估框架，不是生产依赖。2026-08-16
观察官方仓库 HEAD `286163f12aa627af22051bd95321bc6404e237ae`。官方文档表明：

- eval log 的 sample 保存 input、output、target 和 score，并可逐条增量读取；
- `--no-score` 可先生成不可混入评分结论的运行日志，`inspect score` 再离线评分；默认生成新的
  `-scored` 日志，append 模式保留旧 score；
- retry 不覆盖原日志，并依赖稳定唯一 sample ID 复用已完成样本；
- score edit 保存完整历史、author/reason provenance，并在 event log 留下审计轨迹。

参考：

- https://inspect.aisi.org.uk/eval-logs.html
- https://inspect.aisi.org.uk/scoring-workflow.html
- https://github.com/UKGovernmentBEIS/inspect_ai/tree/286163f12aa627af22051bd95321bc6404e237ae

Inspect 不会自动证明老记答案正确，也不是防篡改存储。它只替代我们已经两次做错的运行日志、
恢复和离线评分骨架。运行目录仍要 content-addressed，并保存框架、task、scorer 和 adapter 的
源码哈希；每次评分输出新文件，不覆盖 raw log。

## Q2-E 目标评估链

```text
frozen corpus + gold + retrieval requirements
  -> run-plan compiler (stable blinded sample IDs)
  -> Inspect task --no-score
  -> authoritative raw .eval log
  -> deterministic offline scorer
  -> blinded human adjudication
  -> condition-key reveal + attribution join
```

### 1. Run-plan compiler

- 一条 gold 产生 `no/full/retrieved/oracle` 四个 sample；公开 ID 只含随机 blind key，不暴露
  condition、模型或期望结果。
- 私有 condition map 单独保存，直到所有人工裁决完成才解封。
- 四条 sample 共用 exact reader/provider/runtime/tokenizer/quantization/decoding；evidence payload
  不靠标签，而是作为真实 input/attachment 进入 log。
- `full` 等于完整有序快照，`no` 为空；answerable 的 oracle 由逐 claim AND/OR 合同选定，
  true-missing 的 oracle 必须是完整会议。

### 2. Authoritative raw log

- Provider adapter 只向 Inspect 返回真实 raw structured output；不再创建第二份可独立填写的
  `answer_sha256`。
- request ID、每次 invocation、repair 原因、prompt/schema、finish reason、usage、execution 和
  protocol event 都进入 sample log。request ID 在整个 run 唯一。
- 正常一次调用；仅首轮明确 `completed + invalid_schema` 才有一次 repair。两次 attempt 各自
  保留结果，归因不得只看 final。
- raw log 完成后计算 tree SHA-256，连同 Inspect/task/adapter revision 写入只读 manifest。

### 3. Deterministic scorer

- scorer 直接读取 raw output，不接受调用方另交 response。
- 它只拥有 schema、source/scope/revision/hash、quote byte range、数字/时间/实体原文对齐、
  invocation 次数和 evidence-set recall。
- coverage 先从 raw clause 的 claim/slot 声明重建；只有对应 claim 的足够证据集合实际被该
  clause 引用时才算 citation-grounded，不能由一个布尔值自报。
- protocol、dispatch/policy、orchestration、transport、citation 和 coverage 分别追加 score；
  不计算语义正确率，也不把错误删空后称为 insufficient。

### 4. Blinded human adjudication

- reviewer 只看到问题、前序轮次、raw answer、允许来源和 gold rubric；看不到模型、condition、
  baseline/candidate 名称或自动 score。
- 按 atomic clause 记录 `supported/unsupported/forbidden`，按 gold claim 记录 coverage，并单独
  判断 `answer/explicit absence/abstain` 是否语义正确。
- review assignment manifest 在开始前冻结，同一 case 的四条件尽量由同一 reviewer 裁决；
  变更通过 score-edit provenance 追加，不覆写初始结论。
- 自动 evaluator 只能作开发提示。Attributed QA 的公开研究把 human rating 视为系统评估
  gold standard，并指出实例级自动指标仍有明显噪声，因此当前不以 LLM judge 替代晋级盲审。
  参考 https://arxiv.org/abs/2212.08037 。

### 5. Attribution join

所有 raw、deterministic 和 human score 完成后才解封 condition map：

- no-evidence 语义正确：`parametric_guess`；引用是否有效另报；
- oracle 语义失败：`reader_semantics`；
- oracle 通过而 full 语义失败：`long_context_utilization`；
- retrieved 缺逐 claim 足够证据：`retrieval_insufficiency`；
- retrieved 证据足够但语义失败：`reader_semantics`；
- 任一条件的无支持/禁止 claim：`unsupported_hallucination`；
- execution、protocol、citation、coverage 永远保留独立结果。

仍不输出一个 aggregate accuracy。先看阻断维度和逐 case 诊断；速度只在语义、隐私和引用门
通过的 reader 之间比较。

## Inspect 不能替老记解决的部分

- `.eval` 文件可写，不是密码学签名；必须保留 tree digest、只读目录和非覆盖评分约定。
- 框架不知道会议 scope、source revision、引用 byte range 或 AND/OR evidence；这些仍是老记
  custom task/scorer 的职责。
- log viewer 不是现成盲审产品；condition/model 隐藏和 assignment manifest 需要最小适配层。
- 不把 eval framework 引入 `laoji-api`、APK 或生产 Python 环境；它属于隔离开发环境。

## 下一证伪门

1. 冻结 0015/0016，不再 patch 或复用其 report implementation。
2. 对自然 gold 的 19 条修订做第二人复核；另行审阅 50 个 claim 的 AND/OR 足够证据合同。
3. 只用 4 个非私有 case 和 deterministic fake provider 建立 Inspect micro-probe，证明 raw output、
   attempt、unique request、offline score、blind score edit 和源码哈希可追溯。
4. 由未参与实现的代理攻击“同输出冒充四条件、coverage 自报、错误引用、repair 身份漂移、
   review 被改写”五类反例。
5. micro-probe 通过后才接本地 reader adapter；仍不调用生产模型、私人会议、27B 或 GPU。

若 Inspect micro-probe 仍需再造一套平行日志/状态所有者，则删除该 challenger，并重新评估现成
eval 框架或更小的 append-only artifact 方案；不得返回第三个 monolithic harness。

## 首个 micro-probe 状态

`meeting-qa-inspect-microprobe-0017` 已改用框架原生 custom `ModelAPI`，不再用自写 InfoEvent
冒充调用记录。Inspect 自动保存 `ModelEvent/ModelCall`；offline scorer 直接读取
`ModelOutput.completion`，逐 claim coverage 由 clause 声明和实际足够证据集合交叉计算。16 条
blind sample 的自测链闭合，但尚未独立审计，故研究决定仍是 candidate。
