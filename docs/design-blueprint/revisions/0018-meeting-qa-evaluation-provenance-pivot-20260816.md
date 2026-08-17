# 蓝图修订 0018：会议问答评估血缘转向

## 状态

- revision: `0018-meeting-qa-evaluation-provenance-pivot-20260816`
- status: `candidate`; **not adopted**
- parent: `0017-meeting-qa-semantic-attribution-shadow-20260816`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## 本轮推翻的假设

0017 正确要求分离语义、引用、检索和 Provider 执行，但错误地把“四条件归因 harness”当作一
个可直接补齐的程序。0015 和 0016 连续两轮独立审计失败，证明增加 schema、hash 和测试仍会
形成自报闭环：真实 invocation、raw output、确定性校验和人工语义裁决必须拥有不同 artifact，
之后才能 join。

因此：

- 0015/0016 均冻结为 rejected counterexample；
- 不建立第三个自制 monolithic diagnostic；
- Q2-S 生产 reader 不撤销，但在 Q2-E 评估血缘过门前保持 blocked；
- 当前最优先工作从“组合 0012/0013 reader”改为最小 Inspect AI micro-probe。

详见 [research 0023](../research/0023-meeting-qa-evaluation-log-and-blind-adjudication-20260816.md)、
[candidate 0042](../evidence/candidate-0042-meeting-qa-diagnostic-0015-independent-rejection-20260816.md)
和 [candidate 0043](../evidence/candidate-0043-meeting-qa-diagnostic-0016-independent-rejection-20260816.md)。

## Q2-E 冻结边界

```text
blind run plan
  -> authoritative raw evaluation log
  -> deterministic offline scores
  -> blinded human clause/coverage adjudication
  -> condition reveal and failure attribution
```

- raw output 是唯一回答 owner；scorer 和 reviewer 不得另交一份可漂移 answer。
- 每个 invocation 的 provider/reader/runtime/prompt/schema/repair identity 与 request ID 都进入
  raw event；整个 run request ID 唯一。
- deterministic scorer 只拥有可程序证明的 schema、来源、byte range、数字/实体对齐、调用和
  evidence recall；semantic support 归盲审。
- human rating 是 adoption gold；自动/模型评分只作开发信号。review 初值和后续编辑都保留
  provenance，不允许静默覆写。
- condition/model identity 在人工裁决前隐藏，防止 baseline/candidate 和 oracle/full 标签影响
  判断。
- attribution join 只消费 raw、deterministic、human 三类已闭合 artifact；不生成 aggregate
  accuracy 掩盖关键失败。

## 当前自然 gold 状态

AISHELL-4 候选仍为 4 场、2,441 段、44 条。第一次独立复核没有全放行：原草案 25 条接受、
19 条因范围、前提、证据或状态问题被拒并修订；最终 44 条 frozen/accepted。为避免 reviewer
修订后自我晋级，`promotion_eligible=false` 继续保留，等待第二人复核 19 条修订。

此外，50 个 supported claim 的引用列表还不是 retrieval truth；必须另行标注每个 claim 的
AND/OR sufficient-evidence sets。没有该合同不能把裸 source-ID 并集当 retrieval recall。
详见 [candidate 0041](../evidence/candidate-0041-meeting-qa-natural-holdout-review-20260816.md)。

## 概念与删除预算

新增的概念仅限隔离评估域：Inspect task、raw eval log、deterministic scorer、blind review 和
condition map。它们不进入 App、生产 API、业务数据库或模型服务。

删除/冻结：

- 0015 的 identity/observation/report 实现；
- 0016 的 custom manifest/observation/report 实现；
- 任何由调用方填写 `citation_integrity/claim_coverage/semantic_success` 后直接参与归因的接口；
- 在人工裁决前暴露 condition、model 或 baseline/candidate 名称的评测输出。

保留为 requirement fixtures：full/no/oracle 构造、source content hash、逐 claim AND/OR、
execution/protocol 枚举和已复现反例。

## 下一门

1. 第二人复核 gold 修订和 retrieval requirements；未晋级不得跑 reader。
2. 隔离安装固定 revision 的 Inspect，不进入生产环境。
3. 仅用 4 case + fake provider 证明原始输出、attempt、离线评分、盲审 edit history 和源码 revision
   的闭环；不是质量测试。
4. 独立审计通过后，才为当前 9B 单次 reader 建真实 adapter 并运行 44x4；27B、小 reader、
   prefix cache、生产模型、私人会议和 GPU 继续冻结。
5. 若 micro-probe 不能在一个日志 owner 内完成，删除 Inspect challenger，重新做框架选择；不回
   到第三个自制 harness。

本修订没有用户可见收益，不修改生产、服务、数据库、App、APK、设备或 GPU。

## 当前执行结果

隔离 `meeting-qa-inspect-microprobe-0017` 已用固定 Inspect 0.3.258 和 deterministic fake
ModelAPI 从空生成目录完成第一次全链自测：16 sample、17 个全局唯一 request、1 次 repair，
raw/offline-scored/reviewed 三份日志独立，2 个 citation 与 4 个 coverage 负控被捕获，1 次审阅
纠正保留两位 fixture reviewer 的历史；scorer 反例 `5/5` 通过。它仍是 self-test，下一步必须
独立对抗审计，不能接真实 reader。详见
[candidate 0044](../evidence/candidate-0044-meeting-qa-inspect-provenance-microprobe-20260816.md)。
