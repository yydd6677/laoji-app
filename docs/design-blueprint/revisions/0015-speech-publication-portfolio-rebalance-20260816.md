# 蓝图修订 0015：投入再平衡与语音文字优先发布

## 状态

- revision: `0015-speech-publication-portfolio-rebalance-20260816`
- status: `candidate`; **not adopted**
- parent: `0014-upload-u2-transfer-boundary-20260816`
- production/App/APK mutation: `none`

## 为什么从 U2 切换

U2 连续形成 adapter、fake、Android、SQLite、R2 guard 和独立审计多个候选，但仍没有真实
R2 或完整纵向链，用户可见生产收益为 0。0034 又被独立审计以 cleanup obligation 缺失
阻塞。已完成上传的 p50 为 8.204 秒，不能支持“上传是当前最高等待来源”；长期
registered/active/expired 滞留说明它仍是恢复与清理问题，但不应继续独占主线。

这不是按候选数量判断成熟度。U2 当前冻结：

- 保留 `scope + data_epoch + asset + generation` operation identity；
- 保留正式 asset 域单 owner、终态 CAS、tombstone 和 C2 cleanup obligation；
- 不修 0034、不执行真实 R2、不接 migration/API/Android；
- 只有真实按文件大小的尾延迟、失败率或清理滞留把 U2 重新证明为第一痛点，并获得外部
  写入授权后才重开。

## 新主线：M1-T

当前最高杠杆窄切片是“文字先于讲话人发布”，不是引入新 durable runtime 或替换 ASR
模型。完整路径审计见
[live speech publication route audit](../evidence/live-speech-publication-route-audit-20260816.md)。

### 继续保留

- 当前 Qwen3-ASR-1.7B / 8030；
- VAD source range、现有录音/导入、设备绑定、资产和转写 job owner；
- 当前文件 worker 已有的 batch checkpoint 与 provisional draft；
- 人工讲话人修正的优先级、原始 source segment 和引用血缘；
- C0 作为整链 rollback。

### 必须删除的等待边

1. `CAM++ ready -> VAD/ASR ready`；
2. `ASR text -> CAM++ cluster/identify -> realtime emit`；
3. `all speaker futures -> text closed/final text revision`；
4. `speaker backlog -> ready_to_stop`；
5. `task status success -> transcript fetch`；
6. `VAD segment == display sentence/paragraph`。

逻辑解耦不等于无界 GPU 并行。CAM++ 可继续单 worker/有界排队；过载只延迟或降级 speaker
patch，不能反压 text lane 或隐藏文字。

## 三条路线

| 路线 | 主要形态 | 当前决定 |
|---|---|---|
| C0 | VAD 后整段 Qwen；实时文字等 speaker；device dirty patch 拉 draft；account 只见 final | 生产回滚，不再扩张 |
| M1-T | 当前 Qwen + text/speaker lane + shared draft/final projection + display utterance | **下一隔离纵向候选** |
| G1 | Qwen vLLM streaming、Paraformer 2pass 或 sherpa-onnx 换槽 | M1-T 通过后再同 PCM 比较 |

G1 目前被资源和证据阻塞：GPU0 余量不足以并驻第二 ASR，候选 runtime 未安装，且没有同一
中文会议样本的 CER、稳定前缀、并发和 Windows 边界。不得把供应商 streaming 示例当作
老记达标。

## M1-T 最小架构

### Transcript lane

- 身份：`scope/data_epoch/meeting/asset/run/segment`；
- 顺序：run 内严格单调 `seq`，同 seq 必须字节等价；
- segment revision 单调，`stable_prefix_codepoints` 使用跨 Python/TypeScript/Kotlin 的
  Unicode scalar-value 合同；
- `text_closed` 只封闭文字，生成 content-addressed text revision；
- source segment 可以被 display projection 合并，但引用仍指向原 source。

### Speaker lane

- 对每个 source segment 最多提取一个 CAM++ embedding，聚类和登记匹配复用；
- 自动结果使用独立 `speaker_revision`，可迟到、失败、匿名或不可用；
- manual 继续由正式 `speaker_corrections/speaker_assignments` 拥有，永远覆盖自动显示；
- speaker patch 不改变 text revision、source range、summary stale 或 question snapshot
  的文字指纹。

### Read projection

- device 与 account 必须消费同一 draft/final service，而不是两个结果定义；
- transcript endpoint 直接返回 cursor/snapshot；task endpoint 不再是读取文字的前置；
- provisional -> final 需要显式 replacement lineage，允许 overlap 去重或合法重分段；
- 客户端按 scope/meeting/local asset/remote asset 完整约束，不能只用单列外键。

### Display utterance

VAD segment 继续是 source/evidence 边界，不能为了观感修改。另做本地、可重建的 display
utterance：保留 `segment_reason`，仅对 `max_speech` 等强制切块做连续展示，不把模型每块
句号直接解释为自然句尾。display 合并不改变 canonical text、时间或引用。

## 旧候选处理

`mobile-speech-projection-0005` 当前形态被 candidate 0037 阻塞：

- UTF-16 `length/slice` 冒充 codepoint；
- cross-meeting asset/cursor 可通过外键；
- 新 manual overlay 与正式 correction/assignment 成为第二 owner；
- 不能表达 provisional 到 final 的合法 replacement。

保留 text/speaker revision 分离、manual 优先和 generation/run cursor 这些合同；下一候选
直接适配真实 repository，不在 0005 内继续修。

## 旁线与后续队列

### 会议问答

Q2-S 保留为第二队列：不可变 evidence snapshot、一次结构化 reader、确定性引用和 typed
outcome。生产固定答案和多轮模型链仍是必须删除的目标，但当前 9B 有七类完整证据口语
失败，真实自然 holdout 未闭合。只允许 shadow，不在本轮切生产或下载 27B。

短会议记 `reader=1, embedding=0`；长会议若启用 dense，必须诚实记
`reader=1, embedding=1`，不能把它宣传为一次神经推理。summary 不再作为事实源。

### 整理与日程

- 整理：先做 transcript/source fingerprint 与 task/result 原子提交的窄正确性切片；
- 日程：保留 10 个已知回归并补人工 graph gold，不继续堆正则或用回归通过率冒充自然质量。

## 下一候选

建立一个隔离的生产形状 adapter，不接生产：

1. 复用真实 transcript/speaker schema，先证明不新增 manual owner；
2. 实时 fake provider 返回 text 后立即 emit，slow/failing speaker 只产生迟到/降级 patch；
3. 文件 partial 被 account/device 同一 service 读取，final replacement 带 lineage；
4. Android/TS reducer 复用 candidate 0017 Unicode fixture，拒绝旧/乱序/跨 meeting；
5. 同一 embedding 同时供 cluster/identity；
6. source segment 与 display utterance 分离；
7. 记录等待边和概念删除量。

若该候选仍需第二 task owner、整份新 transcript ledger 或第三套 manual speaker 表，立即
否决；不得用通用 Artifact/DAG 名称掩盖重复状态。

## 验收与停止门

- 当前 Qwen 下，speaker 延迟/失败对 `text_emit` 和 `text_closed` 的影响为 0；
- account/device 对同一 draft/final 的 source IDs、文字、revision 和 completeness 一致；
- duplicate/old/gap/cross-meeting/cross-epoch/合法 replacement 全部 fail closed 或明确
  refetch，不静默覆盖；
- stable Unicode 跨三端一致；emoji、组合字符、ZWJ 和孤立 surrogate 纳入硬门；
- 首 partial/stable/final、draft commit/client observe 和 speaker patch 分别计时；
- 公开样本等速回放 30 warm/3 cold、1/2/4 并发；预注册 partial p95 <=1.5 秒、
  stable p95 <=2 秒，但未实测前不得写成收益；
- CER、关键术语、DER 与标点/展示段落人工复核独立报告；
- 同一假设最多两轮；未减少至少三条等待边或仍新增第二 owner 时停止 M1-T 当前组合。

## 用户可见收益

本修订仍未修改生产、App 或 APK，当前用户可见收益记为 `0`。它改变的是主线、停止门和
下一候选边界，不把源码发现写成已经交付。

