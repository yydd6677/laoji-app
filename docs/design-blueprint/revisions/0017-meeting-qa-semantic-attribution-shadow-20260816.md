# 蓝图修订 0017：会议问答语义归因影子路线

## 状态

- revision: `0017-meeting-qa-semantic-attribution-shadow-20260816`
- status: `superseded by revision 0018`; **not adopted**
- parent: `0016-speech-projection-atomic-seam-20260816`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## 本轮架构判断

Q2 的不可变证据、单次 attributed reader 和引用定位继续保留，但 0012/0013 当前结果合同不再
直接进入生产：

- source ID、quote、数字合法只证明 citation integrity，不证明语义支持；
- reader 空 clauses、漏答或引用被删不能投影成“会议没有足够信息”；
- Provider 只能拥有执行完成/失败，不拥有 answered/insufficient；
- prefix cache 只减少重复问题 prefill，不能修复 reader 理解。

生产 Q0 已达到整体替换门槛：5,803 行、16 套 prompt、至少 81 条固化答案路径，正常路径
多轮串行，静态可达 16 次 generation dispatch；外部 Provider 还可能在 scope 判定前收到会议
来源，queue timeout 后 job 仍可能迟到执行。Q0 冻结为整链 rollback，不再局部修补。

详见 [research 0022](../research/0022-meeting-qa-semantic-attribution-and-reader-challengers-20260816.md)。

## Q2-S 冻结合同

```text
MeetingEvidenceSnapshotV2
  -> complete or token-aware contiguous evidence
  -> exactly one attributed reader
  -> citation-integrity + requested-slot coverage validator
  -> typed content outcome + typed execution outcome
  -> one question-surface state owner
```

- snapshot 绑定 meeting/scope/epoch、canonicalization revision、transcript aggregate revision/hash、
  每个 source revision/hash、获授权 note/attachment 和总 digest；历史问答不是事实证据。
- reader 输出 `supported_answer / explicit_absence / abstained`、requested slots、逐 clause 来源、
  quote UTF-8 range。正常一次调用；只允许一次无证据结构修复。
- validator 只证明引用身份、范围、字节、授权、数字/时间/实体对齐和槽位覆盖；不声称 semantic
  entailment。任一 clause 无效时整体失败，不展示残余，不转 insufficient。
- Provider 只返回 completed/not-dispatched/timeout/cancel/unavailable/unknown/stale/policy 结果；
  网络、schema、队列和隐私失败永不变成会议无答案。
- meeting surface 只回答本场会议。general assistant 若保留，必须在读取/发送 evidence 前走独立
  产品入口；不能由同一模型事后分类。

## reader 与性能路线

当前 9B 单次 reader 只作冻结 baseline，不再调 prompt。27B 只作一次 teacher/ceiling 对照，
不预设为生产终态。新的长期主 challenger 是 1.7B--4B 中文专用 attributed reader：公开研究已
证明小型 context-grounded reader 可以专门训练引用和拒答，但现成 OCC-RAG 只有英语/俄语，
必须用独立中文数据和老记合同重新验证，不能直接替换。

meeting-prefix cache 是后置性能 challenger。稳定 prefix 必须把 ordered evidence 放在 question
之前，cache key 绑定 scope/epoch/snapshot/reader/runtime/prompt/schema/授权；value 不入业务库。
vLLM APC 或 llama.cpp cache/slot 都只是 runtime 选项，未过语义门前不切换服务。

## 当前隔离候选

`meeting-qa-natural-holdout-0014` 从 AISHELL-4 官方固定源构建 4 场、2,441 段自然普通话会议，
生成 20 条有据、10 条真缺失、5 条错误前提、5 条开放状态和 4 条追问草稿。来源和 gold 对
生产模块的 12/16 连续中文字符污染扫描均为 0；但独立复核尚未完成，当前
`promotion_eligible=false`，不能跑分或声称质量提升。

后续 evaluator 固定比较 no-evidence、full-context、retrieved-evidence 和 oracle-evidence，分别
归因 parametric guess、长上下文利用、retrieval 与 reader semantics。旧 implicit-28 继续只是
回归集。

## 采用时删除预算

切换 Q2-S 时从 active path 删除：

- meeting/general scope model 与所有 `_GENERAL_*` prompt；
- 23-function fast tuple、simple/high-confidence fixed answers、specific fact guards；
- strict verifier、evidence-focus model、transcript review、final editor、exact/single-slot、partial/
  enumeration recovery 和 excerpt fallback；
- 问答模块内 27 条样本 ASR 替换；需要的通用纠错迁到带版本/provenance 的 ASR normalization；
- invalid/provider failure -> insufficient 的投影和 provider-specific active branches。

保留 route、meeting/thread/request/ordinal 幂等、exact snapshot fingerprint、双端 citation
allowlist、折叠引用 UI 和一个发布周期的整链 Q0 rollback。不得把旧模块移动文件后继续调用。

## 下一门

1. 由未参与 reader/prompt 的评估者逐条复核自然 gold；未全审不晋级。
2. 建立四条件 evaluator 和 typed failure attribution，不调用私人会议或生产模型。
3. 组合 0012/0013 时删除其语义混淆，而不是再包一层 facade；完成一次实现和一次独立审计。
4. 只有语义门通过且获得资源窗口后，才选择最多两个 reader artifact 做同合同对照。
5. cache、extractive、NLI 任一失败只删除对应 challenger；不得回到 prompt 或样本修补。

U2 继续冻结，不执行真实 R2。speech 0008/0009/0010 当前形态继续否决，不回修。生产、设备、
模型和 GPU 保持不变；本修订用户可见收益为 `0`。

## 后续证伪结果

自然 gold 的首次独立复核将原草案 25 条接受、19 条拒绝并修订，最终 44 条冻结接受，但因
修订尚需第二人复核且逐 claim AND/OR 足够证据合同未建立，仍不允许跑分。四条件 diagnostic
0015/0016 连续两轮独立审计均被否决；主要原因不是 reader，而是 invocation、raw output、
deterministic score 和 human review 没有不可漂移地闭环。本修订的生产 Q2-S 方向保留为 blocked
target，评估实现由 [revision 0018](0018-meeting-qa-evaluation-provenance-pivot-20260816.md) 取代。
