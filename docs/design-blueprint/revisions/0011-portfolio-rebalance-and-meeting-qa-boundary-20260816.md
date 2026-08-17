# 蓝图修订 0011：投入再平衡与会议问答边界

## 状态

- revision: `0011-portfolio-rebalance-and-meeting-qa-boundary-20260816`
- status: `candidate`; **not adopted**
- parent: `0010-durable-owner-symmetric-gates-20260816`
- production change: `none`

## 为什么改变下一项优先级

0007 至 0010 连续聚焦 speech durable owner，约占全部 revision 正文的 46%。
这段工作正式否决了平行 ledger、M1-O 和 Restate 长 exclusive 形态，具有价值；
但继续新增 speech runtime 候选已经违反蓝图的投入平衡目标。

蓝图代理最初建议把上传 owner 收敛作为下一项，因为 AppStorage pending registry、
SQLite upload stage 和 Native WorkManager 同时表达上传状态。该方向保留为第二队列。
随后生产只读审计发现会议问答存在更直接的用户质量和速度根因：样本固定答案位于
生产业务模块并在模型前可达，正常路径又串行调用多个模型阶段，近期 11 个请求中位
耗时约 24.1 秒。会议问答因此提升为当前第一变革问题。

详见 [生产现场审计](../evidence/live-meeting-question-audit-20260816.md) 和
[研究 0016](../research/0016-evidence-native-meeting-qa-20260816.md)。

## 被否决或收紧的假设

- 否决“固定答案有引用校验，所以可以作为通用快速路径”。引用存在不证明回答普适。
- 否决“多轮生成、验证、编辑越多，质量必然越高”。当前真实延迟和补丁规模反证该假设。
- 否决在会议问答内继续隐式承载通用知识助手；它引入 scope owner 和额外模型调用。
- 否决按字符数声明完整上下文。预算必须以实际 tokenizer 和 resident context 为准。
- 收紧 summary 的角色：它可以辅助导航和概览，但不能替代直接证据支撑具体事实。
- 保留 embedding 作为可交换检索适配器；不预设专用 reranker、late chunking 或 GraphRAG。

## 当前选择

Q2 `Evidence-native Meeting Reader` 成为下一隔离候选：

```text
immutable meeting evidence snapshot
  -> complete reader when it fits
  -> otherwise hybrid contiguous-window retrieval
  -> one structured answer generation
  -> deterministic source/revision validation
  -> cited answer or fail-closed
```

正常请求只允许一次模型调用，JSON 结构损坏可修复一次。模板整理、聊天历史和生成摘要
都不能成为无来源事实。我的笔记默认进入当前会议证据，但必须带 revision/hash，引用时
明确显示来源。历史问答只用于解析代词和意图，不成为事实证据。

## 概念与删除预算

Q2 允许新增：一个不可变问答证据合同、一个自适应 reader、一个结构化回答合同。

Q2 采用时必须删除或隔离出生产路径：

- 生产样本 fast repair 和固定答案；
- meeting/general scope model；
- normal-path strict verifier；
- transcript-only review、final editor、exact-slot repair 和 recovery generation；
- 以 summary 文本替代原始来源的事实回退。

如果候选只是在现有 5,826 行模块前再加 router，自动否决。

## 组合顺序

1. 冻结 Q0 为整链 rollback，不再添加样本或关键词分支。
2. 用公开/合成证据建立 Q2 合同与污染扫描，不使用私人会议训练或外部上传。
3. 使用现有真实样本的脱机副本做 held-out 对照；样本内容只存在评测资产。
4. 分别报告 evidence recall、citation support、claim support、abstention、follow-up、
   model calls 和 latency，不用一个总通过率掩盖失败。
5. 独立评估通过后才设计真实 API/repository adapter；未采用前不改生产。
6. Q2 两轮失败则停止，比较 Q3 dedicated reranker/late-chunking，不做第三轮补丁。

## 其他队列

- speech：D0、DBOS 完成一次对称独立审计后选择或全部阻断；不创建 D3。
- upload：U1 `RecordingAsset + upload stage` 单业务 owner、WorkManager 只负责执行，
  作为下一队列；必须删除 pending registry、持久状态标签和重复重试 owner。
- schedule：先完成人工 Mention Graph gold，再比较 producer，不新增架构名词。
- summary：保留 v3 lineage/atomic commit 待真实 adapter，不再增加平行 task owner。
- mobile speech projection：真实 repository 仍不满足候选 0005 的独立 cursor/overlay
  假设，保持 `BLOCK integration`。

## 当前采用状态

没有新方案 adopted。生产问答、上传、speech、日程和 summary 均保持当前运行版本。
本修订只改变权威研究和候选顺序，不授权服务、数据库、APK、真机或公网变更。
