# 研究 0017：会议 Answer Provider 与 reader 选择

## 状态

- status: `research candidate; not adopted`
- date: `2026-08-16 Asia/Shanghai`
- trigger: Q2 证据合同在短显式问题成立，但本地 9B 在完整证据下仍读不稳隐式口语
- production mutation: `none`

本研究不把“换大模型”当作既定答案。它先分开三个不同问题：证据是否召回、reader
是否理解问题与证据关系、Provider 是否可靠执行同一协议。

## 先修正现有评测含义

隐式 28 题的 `14/28` 与云端 `18/28` 不是准确率：

- `IMP-023` 的“未说明”被固定字符串误杀；
- `IMP-024..028` 的证据真正缺失，Q2 合同要求 insufficient，旧 gold 却要求 answer；
- `IMP-022` 只能回答“有截止要求但不能确认已经完成”，不能机械归为 yes/no；
- 旧 28 题已经参与 prompt 调整，只能降为回归集，不能继续叫 holdout。

仍可确认的本地 9B 直接语义失败至少有 7 个：上线钟点、口语预算、报价期限、测试
负责人、测试列表、旧方案停用状态和错误预算前提纠正。这些题走 complete reader，
所以不能归因于检索漏段。

后续冻结评测应分为：18 个直接有据、1 个显式未说明、5 个真正缺失和 4 个开放/状态
问题。分别报告首轮 claim support、validator 拦截率和最终用户安全结果。

## 当前资源约束

2026-08-16 只读现场：

- 服务器 112 CPU threads，约 62 GiB RAM，约 39 GiB available，swap 已用约 9.7 GiB；
- GPU0 RTX 5090 32 GiB，余量约 2.5 GiB；resident 9B reader约占 8.5 GiB；
- GPU1 RTX 5090 32 GiB，余量约 6.2 GiB，现有 32B 服务约占 21.8 GiB；
- GPU1、PCB 和其他用户服务不属于本候选可操作范围；
- Ollama `0.24.0`，reader 位于 loopback `21434`，当前 context 8192。

因此任何更强本地 reader 都不能在当前状态下与 9B 全 GPU 并驻。CPU offload 可作质量
预检，却不能提供有效的上线延迟结论。正式 reader 延迟对照需要单独获得一个不影响
现有服务的 GPU 时段；在此之前不得卸载 9B 或占用 GPU1。

## reader 路线比较

| 路线 | 一级来源事实 | 老记需验证的假设 | 当前判断 |
|---|---|---|---|
| Qwen3.5-27B Q4_K_M | 官方模型卡为 27B、Apache-2.0；官方自报 IFEval/IFBench/MultiChallenge 为 95.0/76.5/60.8；Ollama artifact 约 17 GB | 在完全相同证据、prompt、schema 和单次调用下，能否修复 7 个直接语义失败且不破坏拒答 | **下一主候选**；预计约 19--22 GiB VRAM，必须替换槽位测试，不能并驻 |
| Qwen3.5-35B-A3B Q4_K_M | 官方模型卡为 35B total/3B active；上述三项自报 91.9/70.2/60.0；Ollama artifact 约 24 GB | MoE 是否以较低 active compute 达到相同 reader 质量 | 权重显存约 26--29 GiB，且官方指令指标不优于 27B；不优先 |
| MiniCPM4.1-8B | 官方为中英、Apache-2.0、8B、64K，要求 `transformers>=4.56`，推荐非零温度 | 同尺寸跨家族是否更懂中文口语 | 可替换当前槽位，适合作为低成本旁证；采样建议与确定性 JSON 合同存在差异，不作主候选 |
| 9B LoRA/QLoRA/蒸馏 | ms-swift 官方支持 Qwen3.5 LoRA/QLoRA/GKD | 大量独立自然口语数据能否把问句到证据关系固化到 9B | 当前 28 题严重不足；先证明 teacher，再讨论训练；暂不进入 |
| 单次输出内显式语义结构 | 不增加模型调用；让同一输出先声明 requested attribute/evidence relation 再给 clauses | 中间结构是否改善当前 9B 口语映射 | 仍属于 schema/prompt 变更；最多允许一次预注册实验，不恢复开放式调 prompt |

官方通用 benchmark 只用于选择值得实测的候选，不能外推为老记准确率：

- [Qwen3.5-27B model card](https://huggingface.co/Qwen/Qwen3.5-27B)
- [Qwen3.5-9B model card](https://huggingface.co/Qwen/Qwen3.5-9B)
- [Qwen3.5-35B-A3B model card](https://huggingface.co/Qwen/Qwen3.5-35B-A3B)
- [MiniCPM4.1-8B model card](https://huggingface.co/openbmb/MiniCPM4.1-8B)
- [ms-swift](https://github.com/modelscope/ms-swift)

## Answer Provider 能力边界

新增的不是通用 Inference Gateway 或第二任务 owner，而是会议问答内部的窄接口：

```text
MeetingAnswerRequest
  request_id
  evidence_snapshot_digest
  prompt_revision + schema_revision
  deadline
  privacy_class
  evidence payload

MeetingAnswerProviderCapabilities
  tokenizer + context budget
  strict_schema_canary
  model/provider/transport revision
  cancellation + finish reasons + retry semantics

MeetingAnswerOutcome
  answered | insufficient_evidence | invalid_output
  provider_unavailable | stale_snapshot
```

关键语义：

- 网络失败、超时或未知执行结果不能投影为“会议未提及”；
- 正常一次逻辑生成，只允许同 Provider 的结构修复；
- 未知执行结果不得静默跨 Provider 重放；
- 云端只允许公开、合成或本次明确授权的证据，不能默认外传 transcript/note；
- 每个 `provider + model + transport + schema` 独立过冲突 canary；
- provider 切换不创建第二份问题历史或事实 owner；
- 输出始终回到同一 quote/revision/number/absence validator。

## 预注册的 27B 对照

除 model artifact 外保持以下全部不变：

- 当前冻结 evidence snapshot；
- 当前通用 prompt，不增加样本或改写口语词；
- 当前 JSON Schema、`temperature=0`、8K context；
- `/api/generate` 和单次正常调用；
- 不启用 embedding、normalization、第二 verifier 或 thinking；
- 记录模型 artifact/hash、量化、runtime、源代码/prompt/schema/matrix hash。

采用前的最低门：

1. 修正回归集：18/18 直接有据通过，显式未说明通过，5/5 真缺失返回 insufficient，
   4 个开放/状态题人工复核；
2. 已知 7 个直接口语失败全部修复，核心显式 8/8 不回退；
3. 至少 40 条未参与开发的独立自然口语：20 有据、10 真缺失、5 错误前提、5 状态/
   开放；有据正确率至少 90%，真缺失幻觉为 0；
4. 引用越界、quote 不匹配、无支持数字和无支持 absence claim 都为 0；正常题一调用、
   零 repair；
5. 独占 5090、8K、并发 1 的候选门为 median <=5 s、p95 <=8 s、max <=12 s；
6. 非零温度路线的 7 个缺陷和 10 个真缺失至少重复 3 个 seed。

## 停止条件与队列

- 不继续 dense：四题支持 segment 已全部召回，但 reader只答对一题；真实长会议出现
  evidence recall miss 前不重开 reranker。
- 不继续开放式 prompt 调整：两轮预算已耗尽。
- 不把 qwen3.7-flash 当 teacher 或默认 Provider：当前有真实质量错误、TLS失败和隐私边界。
- 不在旧 28 题上直接 LoRA，不用 CPU offload 延迟宣称上线性能。
- 若冻结的一次 27B reader 对照仍不能同时通过有据与拒答门，停止 Q2 当前组合并切换到
  上传 U1；不创建第三种问答补丁拓扑。

本研究只确定下一可证伪实验，不批准下载、卸载、重启、GPU1 使用或生产接入。
