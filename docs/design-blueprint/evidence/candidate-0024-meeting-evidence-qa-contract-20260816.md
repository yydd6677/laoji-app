# 候选 0024：会议问答证据合同与短会议边界

## 状态

- candidate: `$CANDIDATE_ROOT/meeting-evidence-qa-0012`
- result: `contract self-tested; short synthetic core independently reviewed`
- adoption: **not adopted**
- production mutation: `none`
- private meeting use: `none`

该候选落实了 revision 0011 的最小 Q2 切片。它不是生产接口，也没有任务、数据库、
移动端或迁移适配器。生产服务、模型常驻状态、APK 和真实会议数据均未改变。

## 当前冻结点

本轮记录的源码哈希为：

```text
b33ce3eb76e1ac44bfd18d287c7cf152808ccb7e9c6984a6785b230bfd185562  evidence_qa.py
7b935df0fb21c875f421aa12a7965e9b830efb4c28a664bafdb8b88607e70acc  eval_matrix.py
```

当前候选包含：

- transcript revision/hash、片段来源、时间和讲话人标签组成的不可变快照；
- 短输入完整 reader，长输入 BM25、可注入 dense、RRF 和相邻窗口；
- 本次快照 source ID 动态写入结构协议；
- 模型只输出带 `source_id + verbatim quote` 的 clauses；
- `answer/insufficient` 由代码投影，避免第二状态 owner；
- 正常严格一次调用，只有结构损坏允许一次有界 repair；
- repair 不携带原证据包；
- 来源、逐字 quote、数字和显式缺失声明的确定性校验；
- 无效 clause 删除并保留 `validation_issues`，不再把整次请求变成服务异常；
- 生产 prompt 对评测源码执行 16 个连续中文字符污染扫描。

本轮重新执行 Python 编译、`15/15` 单元合同和污染扫描，全部通过。

## 模型证据如何解释

核心短会议结果
`q2-generate-r7-quotes-8cases-20260816.json` 使用本地 `qwen3.5:9b`：

- 8 题严格 8 次模型调用，无 repair；
- 中位 `2.13 s`，最大 `4.33 s`；
- 旧机械评估为 `5/8`；
- 独立语义、引用和拒答复核为 `8/8`。

机械门的三项误判不是候选成功率提升：它们分别要求固定词面、要求对未知反对者强行
回答，以及不能接受“未说明”和“没有说明”的同义表达。独立复核另指出一句把“给我”
投影成“给记录者”存在轻微角色措辞风险；后续 UI 应保留原称谓或写“给笔记作者”。

显式负面与真正缺失边界探针的用户可见安全结果为 `6/6`，每题一次调用；首轮模型
直接生成干净 clause 为 `5/6`，另一次 unsupported absence 被确定性 validator 删除并
安全投影为 insufficient。两项指标必须分报。这些结果只覆盖短、合成、完整证据输入。
它们证明 Q2 合同可进入下一门，不证明真实会议问答已经可用。

## 宽集暴露的阻断

`r11` 的 26 题和 `r12` 的 28 题均早于当前源码最后修改，只能作为历史诊断：

- `r11` 机械 `23/26`，包含一个旧 validator 异常和两个错误 gold；
- `r12` 机械 `14/28`，其中一些“失败”其实是正确拒答，但至少口语化时间、预算、
  报价期限、测试负责人/列表、旧方案停用和预算纠错在完整证据下仍有真实失败；
- 两轮普适 prompt 调整未消除该边界，按反局部优化规则禁止第三轮继续堆 prompt。

当前最重要的证伪是：这些失败发生在完整短会议证据路径，不是只由检索丢段导致。

## 未通过的采用门

- 没有真实长会议、真实口语或私人会议评估；
- 没有 follow-up 代词、恶意来源、跨 revision 并发和进程恢复；
- 适配器仍按字符保守估 token，未接真实 Qwen tokenizer；
- 没有同输入、同源码冻结点的生产 Q0 与 Q2 独立全链对照；
- quote 和数字验证不等于语义蕴含；
- 没有 API、持久任务、repository、UI、迁移和整链 rollback；
- 隐式口语 reader 质量仍 BLOCK。

## 决策

保留并推进的是不可变证据、单次结构化 reader 和确定性来源校验合同，不是当前 9B、
当前 prompt 或当前 BM25/dense 组合。Q2 只能升到“下一架构门候选”，不能标为
`validated` 或 `adopted`。

下一步停止改 prompt，比较 reader 能力与 Provider 合同；任何新路线都必须复用同一
证据快照、引用和 fail-closed 门，不能用第二模型验证器掩盖 reader 上限。
