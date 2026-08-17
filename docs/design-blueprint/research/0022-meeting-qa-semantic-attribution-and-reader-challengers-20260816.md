# 研究 0022：会议问答语义归因与 reader 变革路线

## 状态

- status: `research preserved; evaluation implementation superseded by research 0023; not adopted`
- date: `2026-08-16 Asia/Shanghai`
- production/service/database/App/APK/device/GPU/model mutation: `none`
- private meeting or production model use: `none`

本研究承接 Q2 的不可变证据和单次 reader，但纠正“引用合法等于答案有据”“reader 拒答等于
证据不足”“前缀缓存会改善理解”三个错误前提。目标不是再给 5,803 行生产模块加一层 facade，
而是先把检索、reader 语义、引用完整性、provider 执行和重复 prefill 五类结果分开，再决定
应替换哪一层。

## 生产基线为什么必须替换

本地生产工作树的 `app_meeting_question.py` 为 5,803 行，SHA-256
`6d175316fd30b72490873fb0c59832320cc7df705b9462568636ae91cb75ea40`。独立静态/纯 mock
审计得到：131 个顶层函数、576 个 `if`、15 个模型调用点、16 套 prompt；至少 81 条
样本或领域固化答案路径，另有 27 条问答层 ASR 字面修复。固定分支可 0 调用返回；普通
meeting 问题可达 4 次，两项枚举可达 6 次，静态最坏路径可达 16 次 generation dispatch，
没有整条问答的统一 deadline。

更严重的不是行数：

- unified call 在 scope 判定前已经携带 meeting sources。全局 Provider 若切到外部服务，普通
  问题也可能先外发会议正文，当前没有逐请求隐私授权；
- Provider queue 等待超时不会取消 job，调用方收到 timeout 后 worker 仍可能发送请求；
- account/guest provider 错误统一为 502，device 又会把非 mapping、非法 citation 和空引用
  投影成 evidence insufficient；
- 完整短会议仍先请求 embedding，embedding 不可用可使本不需要检索的请求失败；
- source allowlist 只证明引用属于本场会议，不证明引用支持答案。

生产 Q0 因而只保留为整链 rollback，不再接受 prompt、样本 repair、guard 或 fallback 增量。

## Q2-S 的五维结果

```text
immutable MeetingEvidenceSnapshotV2
  -> complete context or token-aware contiguous windows
  -> one selected attributed reader
  -> citation-integrity + requested-slot coverage validation
  -> typed content result + typed execution result
  -> one question-surface state owner
```

### Evidence sufficiency

评测真值区分 `supported / explicit_absence / true_missing / open_or_state / ambiguous`。运行时
只能报告输入是完整快照还是检索子集，不能把 reader 空输出或 validator 拒绝改名为
`true_missing`。

### Reader semantics

reader 负责口语同义、所问属性、主体、时态、纠正、多项 coverage 和追问指代。正常请求只
允许一次语义生成；结构损坏且 Provider 明确完成时，最多一次同 Provider 的无证据 JSON
修复。引用错误、漏槽、语义拒答都不触发第二个 semantic pass。

### Citation grounding

确定性 validator 只拥有 source/scope/epoch/revision/hash、UTF-8 quote byte range、授权、重复、
数字/时间/单位/具名实体对齐和 requested-slot coverage。它不拥有 semantic entailment。任一
clause 无效时整个回答是 `invalid_grounding/incomplete`，不能删除失败 clause 后展示残余，也
不能投影为 insufficient。

### Provider execution

Provider 只返回 `completed / not_dispatched / timed_out / cancelled / unavailable /
unknown_dispatch / stale_request / policy_denied` 等执行事实。删除 0013 中 Provider 对
`ANSWERED/INSUFFICIENT_EVIDENCE` 的 ownership。外部授权必须由可信 policy issuer 绑定 exact
evidence digest、provider、用途和期限；调用方自报字段不是授权。

### Repeated prefill

prefill 是 `hit/miss/stale/evicted/unsupported` 性能状态，不是业务状态。缓存 key 至少绑定
scope/epoch/meeting、snapshot digest、reader/tokenizer/runtime/transport/quantization、prompt/schema
和授权；value 只能是可删的 provider-native opaque KV/prefix handle，不入业务 DB，不保存回答。

## 前沿路线核对

### Prefix cache

- vLLM 官方 Automatic Prefix Caching 明确适用于“同一长文档反复提问”，只减少 prefill，
  不减少 decode。参考 2026-08-16 读取的
  [官方文档](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/)；对应仓库观察提交
  `4d2a68d64d9e05921ed5c4099146e768a92d71d5`。
- llama.cpp server 的 `cache_prompt` 会比较公共前缀，只处理未见 suffix；官方同时警告不同
  batch size 可能造成非位级一致，并提供 slot save/restore/erase。参考
  [server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)，观察提交
  `b94041a98ec86e29e63b02decd29175d6820b2a1`。

因此稳定序列必须显式为 `system/prompt + schema + ordered evidence | prefix boundary |
thread context + question`。问题放在来源之前的当前 JSON 形状无法复用长会议前缀。缓存只在
reader 语义过门后验证；失败时删除缓存，不否决已通过的 reader。

### Fine-grained attributed reader

[LongCite](https://arxiv.org/abs/2409.02897) 用 45k 训练数据让 8B/9B 模型在单次输出中产生
细粒度引用，说明“单 reader 同时回答和引用”是可训练能力；它的英文长上下文 benchmark
不能外推中文会议质量。

2026 年的 [OCC-RAG](https://arxiv.org/abs/2606.00683) 更直接挑战“必须换更大通用模型”：
它在 Qwen3 0.6B/1.7B base 上用约 325 万条 context-grounded QA 做专门训练，输出来源分析、
引用、answerable/unanswerable 和答案。官方模型卡只标注英语、俄语，未证明中文、会议口语、
ASR 噪声或老记协议，不能直接下载替换；但它使“1.7B--4B 中文专用 attributed reader，
27B 只作 teacher/ceiling”成为比“27B 直接常驻生产”更值得长期验证的主 challenger。

专用小 reader 的训练集必须与 adoption holdout 分离：使用不同 AISHELL-4 train meeting、公开
中文 evidence QA 和独立生成的 hard negatives，训练 source-grounded answer、显式拒答、错误
前提和状态；test meeting、用户私人会议和本轮 gold 永不进入 prompt 或训练。没有独立数据、
teacher 和资源预算前，本路线只是 target hypothesis。

### Evidence-utilization diagnosis

[2026 ONCU 研究](https://arxiv.org/abs/2606.06758)指出答案分数、retrieval recall 和 citation
overlap 不能说明模型真正利用了证据，并提出在同题、同模型、同 prompt 下比较 no-evidence、
full-context、retrieved-evidence 和 oracle-evidence。老记采用该四条件诊断，但不采用论文指标
作为产品分数：

- no evidence 高分暴露 parametric guess 或测试泄漏；
- oracle 通过、full 失败是长上下文利用问题；
- oracle 通过、retrieved 失败是 retrieval 问题；
- oracle 也失败是 reader semantics 或问题/gold 问题。

### Extractive、reranker 与 NLI

extractive 只允许作为同合同 reader slot 或离线 gold-span 召回诊断，不得成为命中关键词就返回
的第二 fast path。Qwen3-Reranker-0.6B 官方支持 100+ 语言和 32K，但现有四个失败题已召回支持
证据，故当前不增加 reranker 常驻模型。NLI 首轮只作离线 claim-support 排序；若不能替换其他
semantic pass，就不进入线上正常路径。

## 自然中文 holdout 候选

隔离目录：

`/home/yydd/LaoJi-candidates/meeting-qa-natural-holdout-0014`

AISHELL-4 是 211 场、4--8 人、120 小时的真实普通话会议语料。OpenSLR 对数据标注
CC BY-SA 4.0；GitHub baseline 的 Apache-2.0 只是代码许可，不能混用。本候选只下载官方 HF
镜像上固定 revision 的四个 TextGrid，不下载音频：

- 4 场、2,441 段，生成正文约 920 KiB；
- source bytes、segment text、稳定 source ID 和 corpus 全部有 SHA-256；
- 保留停顿、重复、不完整语法与跨讲话人重叠，只移除 `<sil>` 等标注符；
- 构建/校验合同 `4/4` 通过；44 条 gold 草稿由 20 条有据、10 条真缺失、5 条错误前提、
  5 条开放状态和 4 条追问组成；本研究形成时 `accepted=0`，后续首次独立复核修订 19 条并将
  44 条冻结接受，但第二人复核和 AND/OR evidence contract 未完成，故仍为
  `promotion_eligible=false`；
- 生产模块对全部 transcript/gold 的连续 16 字和更严的 12 字污染扫描均为 0。

这仍不等于独立 adoption evidence。问题尚待未参与 prompt/reader 的代理逐条复核；公开会议
也不能冒充真实用户自然流量。Q0 含泛化停车 fast branch，故将来 Q0 对照要单列
`baseline_domain_contamination`，不能用该类题证明 Q0 泛化。

## reader 路线组合

| 路线 | 质量潜力 | 速度/资源 | 当前决定 |
|---|---|---|---|
| Q0 多轮 9B | 样本分支掩盖真实能力，无法归因 | 中位约 24 秒，调用 0--16 次 | 冻结 rollback |
| 当前 9B 单次 attributed reader | 合同简单；完整证据仍有口语语义失败 | 短合成约 2 秒级 | baseline，不再调 prompt |
| 27B 单次通用 reader | 可作强 teacher/ceiling | 不能与当前 9B 并驻，生产成本高 | 获得资源窗口后可做一次预注册对照 |
| 1.7B--4B 中文专用 attributed reader | 可能同时提升 grounding、拒答与速度 | 需要大规模独立训练数据和 teacher | **长期主 challenger** |
| prefix cache + 已过门 reader | 只改善同 snapshot 后续问题 | 额外 KV 内存和 runtime 约束 | 性能 challenger，语义门后实施 |
| extractive/NLI/reranker 并联 | 能诊断特定失败 | 增加模型、状态和串行等待 | offline/same-slot only |

## 下一证伪门

1. 独立复核 44 条 gold；任何错误引用、错误“缺失”或不自然问题保留反例并修正，未全审不得
   晋级。
2. 实现四条件 evaluator 和 typed failure attribution，但不调用生产模型。
3. 对 0012/0013 做组合候选时，必须修复 empty clauses -> insufficient、invalid clause 删除后
   假成功和 Provider 内容语义 ownership；不能只 import 两个候选再包一层。
4. 语义门通过后再建立 prefix adapter；不切换 Ollama/vLLM/llama.cpp，不下载模型，不动 GPU。
5. 若两个预注册 reader 都失败，停止 Q2 当前组合；不做第三轮 prompt、dense、NLI 或样本 repair。

## 后续证伪

四条件比较本身继续保留，但“先写一个 typed attribution harness”已被两轮独立审计证伪。
0015 未绑定真实证据条件；0016 仍允许真实输出与审阅结果漂移，并让 coverage/citation 自报。
后续不再修第三版，改用 raw evaluation log、deterministic offline scorer、blinded human
adjudication 和 condition reveal 四阶段。详见
[research 0023](0023-meeting-qa-evaluation-log-and-blind-adjudication-20260816.md)。
