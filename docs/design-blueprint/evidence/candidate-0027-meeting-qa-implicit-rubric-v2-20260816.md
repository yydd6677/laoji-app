# 候选 0027：会议问答隐式口语评测口径 v2

## 状态

- candidate: `/home/yydd/LaoJi-candidates/meeting-evidence-qa-0012/eval_contract_v2.py`
- result: `contract self-tested; semantic review incomplete`
- adoption: **not adopted**
- production mutation: `none`

旧隐式 28 题把“回答中是否出现固定词面”当准确率，并要求真正缺失的信息也输出
“未提及”。它既误杀正确拒答，也可能放行带引用的错误答案。本候选只修评测含义，
不修改 prompt、reader、生产代码或结果文件。

## 新分组

| 分组 | 数量 | 合同 |
|---|---:|---|
| 直接有据 | 18 | 必须回答并引用当前证据；机器不判语义正确，交独立人工 |
| 显式未说明 | 1 | 必须回答“未说明”，且 quote 本身逐字写明未说明 |
| 真正缺失 | 5 | 必须 insufficient 且无引用，不强迫生成“未提及”句 |
| 开放/状态 | 4 | 禁止强制 yes/no 或“最先”；全部人工审阅 |

旧 28 题已用于 prompt 调整，只能作为回归集，不能重新命名为 holdout。

## 可执行结果

源码哈希：

```text
5570d86653f49d44872c98739883f5f66cc4024a4fb73d262f63f0c4b6e80599  eval_contract_v2.py
d2a9c1243948c2796e3dd8fecce74aef13a28ed087b69232975cf4a9ca86827b  tests/test_eval_contract_v2.py
```

Q2 候选当前合计 `21/21` 单元合同通过；其中 rubric 自测 `6/6`。对历史
`q2-generate-r12-implicit-28cases-20260816.json` 执行 v2：

- 15 项进入人工语义审阅；
- 5 项机器安全通过；
- 8 项合同失败；
- 25 项没有 repair 或已记录 validation issue，但“clean primary”不能替代语义正确。

8 个合同失败包括六个机器可见的直接有据拒答、一个旧开放状态异常和一个旧真正缺失
异常。另有“测试归谁跟进”虽然形式为有引用 answer，人工已确认语义错误，所以它留在
人工组而不会被机器误判通过。这正是 v2 不再输出单一准确率的原因。

## 下一门

- 独立 reviewer 完成 18 个直接有据和 4 个开放/状态题的语义判定；
- 新增至少 40 条未参与开发的自然口语作为真正 holdout；
- 冻结代码、prompt、schema、matrix、model/runtime artifact hash 后再跑 9B/27B；
- 同时报告首轮 claim support、validator 拦截、最终安全、模型调用和延迟；
- 不得用修正 gold 提高旧结果的“准确率”，也不得删除失败题。

本候选只修复测量工具，不构成会议问答产品改进。
