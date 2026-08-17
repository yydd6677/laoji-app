# 蓝图修订 0012：会议 Answer Provider 与 reader 边界

## 状态

- revision: `0012-meeting-answer-provider-reader-boundary-20260816`
- status: `candidate`; **not adopted**
- parent: `0011-portfolio-rebalance-and-meeting-qa-boundary-20260816`
- production change: `none`

## 本轮重新审视的问题

0011 选择 Q2 证据原生单次 reader，是为了删除样本答案、多轮模型和 summary 事实回退，
而不是为了证明当前本地 9B 必须保留。本轮真实模型结果支持拓扑，却同时反证当前 reader
组合：短显式核心能一次生成带逐字引用的答案，完整证据下的隐式中文口语仍频繁拒答。

因此不能把 Q2 整体升为 validated，也不能因 9B 失败而恢复多轮 verifier/editor。新的
边界是：保留证据与验证合同，冻结 prompt，单独比较 reader 与 Provider 执行能力。

详见 [candidate 0024](../evidence/candidate-0024-meeting-evidence-qa-contract-20260816.md)、
[candidate 0025](../evidence/candidate-0025-meeting-qa-provider-resource-boundary-20260816.md) 和
[research 0017](../research/0017-meeting-answer-provider-reader-selection-20260816.md)。

## 保留、质疑和废弃的假设

### 保留

- 当前会议事实必须来自同一不可变 transcript/note/authorized attachment snapshot；
- 短会议优先完整证据，只有超预算才检索；
- 正常一次结构化 reader，结构损坏最多一次有界 repair；
- source revision、逐字 quote、数字和显式缺失由代码确定性验证；
- invalid clause fail closed，同时保留质量告警，不能伪装成模型成功。

### 质疑

- 当前 `qwen3.5:9b + prompt/schema + generate transport` 能否承担自然中文会议 reader；
- 一个 Provider 名称是否足以表达 context、schema、取消、超时、未知执行结果和隐私能力；
- 云端模型在合成集更强是否足以抵消网络、隐私和错误拒答风险。

### 废弃或暂停

- prompt 第三轮调整：预算耗尽；
- Q3 dense 当前进入：支持证据已召回，reader 仍拒答，且增加约一秒等待；
- 把网络故障返回为 insufficient；
- 静默本地到云端 fallback；
- 用旧 `14/28`、`18/28` 机械分数声明准确率；
- 把评测结果文件名中的 `cpu` 当硬件遥测，或把 CPU offload 延迟当上线延迟。

## 目标切片

下一隔离候选是窄的 `MeetingAnswerProvider`，不是全局 Inference Gateway：

```text
immutable MeetingEvidenceSnapshot
  -> MeetingAnswerRequest(request/evidence/prompt/schema/deadline/privacy identity)
  -> one capability-qualified reader call
  -> deterministic evidence validator
  -> answered | insufficient_evidence | invalid_output
     | provider_unavailable | stale_snapshot
```

它是无状态执行边界，不拥有问题历史、任务恢复、会议事实或 UI 状态。采用时必须替换
当前问答模块内 provider-specific 分支和错误投影，而不是再包一层 facade。

Provider 必须声明 tokenizer/context、strict-schema canary、model/transport revision、
finish reason、cancel 和 retryability。未知结果不跨 Provider 静默重放；云端只能处理
公开、合成或本次明确授权的证据。

## reader 选择

冻结合同后的第一主对照为 `Qwen3.5-27B Q4_K_M` 替换当前 9B reader 槽位：除 model
artifact 外，不改证据、prompt、schema、temperature、8K context、transport 和调用次数。
这只测试 reader 容量是否为 7 个直接口语失败的根因。

现场 GPU0 余量约 2.5 GiB，27B 不能与 9B 并驻；GPU1 和现有 32B 服务不在本轮授权范围。
因此本修订不批准下载、卸载或抢占。CPU offload 只能作质量预检，不能形成延迟采用证据。
MiniCPM4.1-8B 可作同槽位旁证，35B-A3B 和训练/蒸馏均后置。

## 评测合同重建

旧隐式 28 题已参与 prompt 调整，降级为回归集。下一冻结点必须记录候选代码、prompt、
schema、matrix、model artifact 和 runtime digest，并修正 gold：

- 直接有据、显式未说明、真正缺失、开放/状态问题分组；
- 首轮 claim support、validator 拦截和最终用户安全分别报告；
- 不要求对真正缺失的信息生成“未提及”句子；
- 截止要求不等于事项已完成；最终选择不等于无人反对；
- 新增至少 40 条未参与开发的自然口语并由独立 evaluator 审查。

当前候选目录不在 Git，且宽集结果早于当前源码修改，因此现有文件不能直接组成
promotion artifact。

## 采用与停止门

`validated` 前必须同时满足：

- 7 个已知有据口语失败全部修复，核心显式 8/8 不回退；
- 新自然集有据正确率至少 90%，真缺失幻觉为 0；
- 所有显示引用与当前 snapshot 100% 对应；
- 正常一调用、零 repair；provider failure 与 insufficient 严格分离；
- 长会议、follow-up、笔记冲突、恶意来源、真实 tokenizer 和进程恢复通过；
- 同输入 Q0/Q2 速度、质量、资源和故障面独立对照；
- 实际删除固定答案、scope model、normal verifier/editor/recovery 的预算可兑现。

若一个冻结的更强 reader 对照仍不能同时通过有据与拒答门，停止 Q2 当前 reader 组合；
不继续 prompt、dense 或第二模型补丁，转入上传 U1 owner 收敛。若长会议以后出现真实
evidence-recall miss，才重新开启 reranker/late chunking。

## 其他队列

- upload U1 仍是下一系统级队列，不因 Q2 研究无限延期；
- speech 只闭合 D0/DBOS 对称审计，不再创建新 runtime；
- schedule 先建立人工 Mention Graph gold；
- summary 保持 v3 lineage/atomic commit，未接真实 adapter 前不增加 task owner；
- mobile/UI 只在真实纵向接入时验证一个状态 owner，不为候选增加第二状态栏。

## 当前采用状态

Q2 证据拓扑、MeetingAnswerProvider、27B reader 和所有评测结果均为 candidate/research。
没有新方案 adopted；生产代码、服务、数据库、模型、APK、设备和公网均未改变。
