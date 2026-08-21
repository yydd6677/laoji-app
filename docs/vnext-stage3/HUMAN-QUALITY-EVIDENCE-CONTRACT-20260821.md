# Stage 3 Facts/行动/Q2 独立人工质量证据合同（2026-08-21）

状态：`review contract and private templates complete; human judgments pending; Stage 3 not adopted`。

## 修复的证据缺口

原 Facts/行动和 Q2 私有包固定了候选输入、输出与待审字段，但每个包只有一个 `reviewer`，没有第二名
评审、分歧裁决、文件哈希绑定或确定性质量报告。因此它们是冻结的**来源包**，不能单独证明“独立人工
质量达到 95%”。

新增 `tools/vnext/stage3_human_quality_evidence.py`，将流程固定为：

```text
冻结的私有来源包（包含候选输出）
  -> 评审 A：只提交判断，不看自动通过状态/期望答案 ┐
  -> 评审 B：只提交判断，不看自动通过状态/期望答案 ┴-> 第三人逐条裁决
                                                            -> 聚合指标和哈希报告
```

这里的“盲”不是看不到待评候选输出，而是看不到自动化 pass/fail、期望答案、样本身份和另一名评审的
结论。评审必须看到来源和候选输出，才能判断事实、行动、回答和引用是否正确。

工具强制：

- 两名不同的中文母语真人独立评审，并声明未看到自动化结果；
- 第三名中文母语裁决者与两名评审均不同，裁决不得早于评审完成时间；
- 裁决文件精确绑定来源包、review A 和 review B 的 SHA-256；
- 两名评审判断一致时，裁决不能修改结论；判断不一致时不能写 `agree`；
- review ID、fact ID 和 action ID 必须与冻结来源包完整一致；
- 所有质量字段必须显式填写，模板中的 `null/false/空时间` 无法通过评分；
- 最终报告只包含计数、比率和四份文件哈希，不包含会议、问题、答案、事实、行动、引用或备注正文。

## 已生成的私有模板

来源包仍位于 Git 工作树外：

- Facts/行动：`/home/yydd/.cache/laoji-vnext/facts-human-review-20260821-r1.json`
- Q2：`/home/yydd/.cache/laoji-vnext/q2-human-review-20260821-r2.json`

它们的 SHA-256 仍分别为：

- `25de522aa617b098aec338303fa0e3d05a195ebbf3276bd13cd426c821b223f2`
- `081136b7d241abac30af98de0a2e561af899e2a21a18f1c32ca1f0fbee3dc0d1`

基于精确哈希生成的两评审/裁决模板位于：

- `/home/yydd/.cache/laoji-vnext/stage3-human-quality-20260821/facts-actions`
- `/home/yydd/.cache/laoji-vnext/stage3-human-quality-20260821/q2`

目录均为 `0700`，六份文件均为 `0600`；Facts/行动 10 行，Q2 27 行。模板故意保持未完成状态，
不能因生成模板而产生人工通过率。

需要重新生成时：

```bash
python3 tools/vnext/stage3_human_quality_evidence.py make-templates \
  --domain facts_actions \
  --source /受控目录/facts-source-pack.json \
  --output-dir /受控目录/facts-review

python3 tools/vnext/stage3_human_quality_evidence.py make-templates \
  --domain q2 \
  --source /受控目录/q2-source-pack.json \
  --output-dir /受控目录/q2-review
```

## 评分口径

Facts/行动报告确定性计算：概述准确率、事实来源支持率、事实实质准确率、certainty 正确率、冲突保留
率、重要遗漏率、严重错误率、行动真实性/具体性/负责人依据/期限依据/日程适配率和重复行动数。
所有正向比率至少 `95%`，重要遗漏率最多 `5%`，严重错误和重复行动必须为 `0`；没有事实或没有行动
时失败关闭，不能用空集合得到满分。

Q2 报告确定性计算：回答正确、完整、引用相关、拒答适当四项比率与严重错误率。四项比率均至少
`95%`，严重错误必须为 `0`。

评分命令示例：

```bash
python3 tools/vnext/stage3_human_quality_evidence.py score \
  --domain facts_actions \
  --source /受控目录/facts-source-pack.json \
  --review-a /受控目录/facts-review/review-a.json \
  --review-b /受控目录/facts-review/review-b.json \
  --adjudication /受控目录/facts-review/adjudication.json \
  --output /受控目录/facts-review/quality-report.json
```

Q2 使用同一命令，将 `--domain` 改为 `q2` 并替换对应路径。

## 证据边界

当前 10 个会议来源和 27 个问题已经用于候选开发、诊断和回归。上述合同能证明两名独立人工对这批
冻结候选输出的判断及裁决结果，不能把它们重新描述成“从未参与开发的未知来源 holdout”，也不能
替代公开零旧调用周期或 capability 人工采用。Stage 3 在真实评审、裁决和质量阈值完成前仍未退出。
