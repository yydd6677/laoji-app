# 蓝图修订 0019：会议问答合同缝与评估包重置

## 状态

- revision: `0019-meeting-qa-contract-seam-and-eval-bundle-reset-20260816`
- status: `candidate`; **not adopted**
- parent: `0018-meeting-qa-evaluation-provenance-pivot-20260816`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## 本轮推翻的假设

0018 正确停止了第三个自制 monolithic harness，但仍有两个错误前提：

1. 把 Inspect 原生 `ModelEvent/ModelCall` 当成真实调用和修复身份已经闭合；
2. 把 Q2-E 评估门设为全部 Q2-S 架构工作的串行前置条件。

独立对抗审计已经实际绕过 0017 的调用、repair、derived log、condition map、blind export、
review history、scorer revision 和 citation coverage；另一独立蓝图审计还发现 fake reader
通过私有输出预知 gold claim ID，真实 reader 若沿用该协议只能泄漏 rubric。0017 因此冻结为
`fixture-only / rejected-for-Q2-E-proof`，详见 [candidate 0045](../evidence/candidate-0045-meeting-qa-inspect-microprobe-independent-rejection-20260816.md)。

Q2-E 仍阻止真实 reader 跑分，但不再阻止与模型质量无关的 Q2-S 数据/授权/取消合同研究。

## 两条并行路线

### Q2-E2：content-addressed EvalRunBundle

```text
PrecommittedRunPlan
  -> RawInvocationLedger
  -> DeterministicScoreOverlay
  -> LabelMaskedReviewPackage + isolated assignment
  -> AppendOnlyHumanReviewOverlay
  -> ConditionRevealOverlay
  -> EvalRunBundle root
```

- reader 输入只含问题、前序轮次、授权证据和生产 schema；不得含 gold claim ID、答案、
  forbidden claim 或 condition 标签。
- reader 输出只有稳定 clause ID、文本、引用和 typed content outcome。自动 scorer 不把 clause
  映射到 gold claim；该映射和语义支持归人工盲审。
- run plan 在调用前冻结随机 run UUID、case occurrence、evidence transform、provider/runtime/
  model/tokenizer/quantization/decoding 和 assignment policy。request ID 由 runner 外部产生并绑定
  run UUID；重跑不能复用。
- invocation digest 从实际发送的完整 messages、config、attachments、transport target 和
  policy grant 重算。repair 另有 request ID，并绑定失败 attempt 的 output/protocol digest、
  repair messages 和相同 provider/runtime contract。
- raw ledger 是唯一 output owner。后续 score/review/reveal 只保存父 raw digest 和 overlay，
  不复制可独立漂移的 ModelEvent/output。
- deterministic overlay 只判断 schema、scope/epoch/revision/content hash、UTF-8 quote range、
  数字/日期/实体原文对齐和实际调用状态；引用是否支持 clause、gold coverage 和 forbidden
  claim 由人工判断。
- review package 使用字段 allowlist；隐藏 model/baseline/candidate 标签不再称
  condition-blind。四条件以 counterbalance 分配给不同 reviewer，且 reviewer 不获得 private
  condition map 或未授权 artifacts。
- human overlay 追加 authenticated reviewer/assignment/reason/timestamp/history；修改不能覆盖
  初值。condition reveal 是最后一个独立 overlay。
- bundle root 绑定每一阶段的父 digest、源码 tree/revision、依赖 lock 和 artifact hash；任何
  替换都 fail closed。Inspect 只可作为 RawInvocationLedger 的可替换 runner，不是 trust root。

若最小 4-case fake 仍需要第二份 answer owner、gold ID 或平行 observation log，则删除 Inspect
challenger，直接使用更小的 append-only stage bundle；不再修 0017。

### Q2-C：生产合同缝，先于模型质量闭合

以下合同可以使用 deterministic fake reader 验证，不等待 Q2-E2，也不接生产：

- `MeetingEvidenceSnapshotRef` 必须绑定 scope/data epoch/meeting、transcript revision、笔记和附件
  授权 revision、ordered source content hash；明确正文是不可变副本还是可解析历史引用，不能
  指向可静默变化的 current row。
- `QuestionAttempt` 绑定 snapshot/policy/provider contract、generation、request ID、deadline 和
  cancel fence。timeout/cancel 后迟到完成只能留下执行审计，不能发布回答。
- 删除、编辑、附件撤权或 device epoch 变化生成新的 policy/snapshot revision，并使旧结果成为
  `historical/revoked/stale`，不能伪装成当前证据回答。
- typed result 分开 `content outcome`、`execution`、`protocol`、`citation integrity`、`policy` 和
  `publication eligibility`；provider failure 或 validator failure 永远不投影为 evidence
  insufficient。
- 发布 barrier 在同一 owner 上 CAS exact attempt/snapshot/policy revision；问答页面只消费一个
  current pointer，旧成功结果在新请求期间仍可读。

这条 seam 只允许建立隔离 schema、状态机和 fault fixture。没有真实 repository adapter、迁移、
独立审计和删除预算前，不得接生产。

## 数据成熟度不再用一个布尔值

自然 AISHELL-4 候选拆成四个独立状态：

- `source_readiness`：四场公开人工转写已 pin/hash；
- `gold_readiness`：44 条人工问题不是自然用户问题；首审修订 19 条、二审拒绝 1 条、第三人
  接受其收窄修订，当前 44/44 accepted；
- `retrieval_readiness`：50 claim/54 sufficient set 的 AND/OR 草案已绑定，仍待独立语义审阅；
- `query_scope_readiness`：只覆盖四场窄领域、人工 TextGrid，不覆盖生产 ASR、笔记/附件、撤权、
  编辑、删除或自然用户问法，保持 insufficient。

`promotion_eligible=false` 继续保留，但不再让它掩盖具体未闭合维度。首次真实 reader 输出产生
后，这 44 条降级为 development diagnostic；另建未见 adoption set。

## 当前执行结果

- Inspect 0017 clean snapshot 可重跑，机制控制通过；独立篡改审计判为 BLOCK。
- gold validator 现真实执行 Draft 2020-12 schema；发现并修复 `NAT-030` 7 条 evidence 超上限
  和 `NAT-014` 漏引 `够` 的问题。
- 第二人对首轮 19 条修订给出 `18 ACCEPT / 1 REJECT`；`NAT-024` 按建议收窄后由第三人读取
  完整 716 段会议并接受，gold 当前 44/44 accepted。
- sufficient-evidence 草案为 50 claim、54 set、4 个 OR claim、7 个 complete-meeting claim；
  complete-meeting sufficiency 从实际 ordered snapshot 重算，不接受调用方自报 digest。
- gold/contract/构建测试当前 `12/12` 通过；这只证明机械合同，不是语义通过率。一次本地
  Claude Opus 5/max、非 fast 的 retrieval contract 审计连续两次达到五分钟工具上限，未返回
  结论；随后四个会议分片的并行编排在约十分钟内也没有返回任何分片文本并被终止，不能计为
  独立审阅。后续改用 Codex 独立分片代理，不再重试同一 MCP 形状。

## 概念与删除预算

新增概念限于隔离候选：`EvalRunBundle` 五个 overlay、`MeetingEvidenceSnapshotRef`、
`QuestionAttempt` 和 publication fence。实现候选必须证明它们替换而非叠加现有 Q0 owner。

冻结/删除候选：

- 0017 的 private fake-output answer owner、gold claim ID reader 输出、full copied derived logs、
  blacklist blind verifier 和 mutable condition join；
- “ModelCall 存在即真实 transport 已证明”“source ID 命中即语义支持”“去掉标签即盲审”的声明；
- Q2-E 未完成所以 snapshot/policy/cancel contract 也不能研究的串行门。

生产 Q0 仍只作整链 rollback；本修订不删除生产文件或迁移数据。

## 下一门禁

1. 独立逐 claim 审阅 50 个 AND/OR sufficient set；任何修改必须重新绑定 gold digest 并再审。
2. 用 4 个公开 fixture 建 Q2-E2，reader 不见 gold ID，所有 derived stage 是 raw parent overlay；
   独立攻击通过前不接真实 9B。
3. 并行建立 Q2-C fake contract seam，覆盖 edit/delete/revoke、timeout/cancel late result、policy
   revision、crash recovery 和 current-pointer CAS。
4. 两条门禁闭合后才运行当前 9B 的 44x4；27B、小 reader、prefix cache、生产模型、私人会议、
   GPU 和服务继续冻结。

本修订没有用户可见收益，也没有修改生产、服务、数据库、App、APK、设备或 GPU。
