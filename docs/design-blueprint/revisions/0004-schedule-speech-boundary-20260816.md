# 蓝图修订 0004：日程语义与语音水位边界

## 状态

- revision: `0004-schedule-speech-boundary-20260816`
- status: `candidate`; **not adopted**
- parent: `0003-summary-lineage-and-concept-boundary-20260816`
- observed at: `2026-08-16 Asia/Shanghai`
- evidence: read-only source replay plus isolated contract prototypes; no production mutation

## 触发原因

0003 收紧了整理结果的血缘和任务提交边界，但蓝图仍把日程和语音列为待研究
问题。对同一 reference/timezone 的 8 条输入进行手机规则与服务端 quick 只读
回放后，确认重复 owner 已经造成可见语义分叉：

- 手机对“明天下午三点开会”不给结束时间，服务端 quick 默认补到 16:00；
- 手机把“明天三点开会”解析成 03:00 并走 `local_safe`，服务端要求确认上午/下午；
- 手机和服务端对“明天有什么安排”的标题投影不同；
- 两端都未调用模型，差异来自规则、路由和默认值，而不是模型随机性。

实时语音也存在类似边界：移动端已能解析 partial/delta 事件，但服务端当前
在 VAD 闭段后调用 8030，并只发送 `transcript.completed`；离线管线则按批次
flush，讲话人增强与文字发布没有一个统一的水位合同。

详细调用图、外部路线比较和回放限制见：

- [日程语义流水线比较 0007](../research/0007-schedule-semantic-pipeline-comparison-20260816.md)
- [语音前沿方案 0008](../research/0008-speech-pipeline-frontier-options-20260816.md)
- [隔离合同证据 0009](../evidence/candidate-0009-schedule-draft-watermark-20260816.md)
- [当前 quick 回归快照](../evidence/schedule-quick-regression-20260816.md)
- [ASR provider 现场审计](../evidence/live-asr-provider-audit-20260816.md)

## 本修订保留的产品边界

1. 日程开始日期可以单独保存；开始/结束钟点互不强制。服务端或模型不得静默
   注入用户没有表达的结束时间。
2. “补充”是同一草稿 revision 的字段 patch，必须保留原文和来源；二次确认前
   不产生日历保存副作用。
3. 查询、删除、否定和纯聊天不能被投影成可保存 create，即使规则提取出了日期
   或标题样式的词。
4. 文字达到稳定水位即可展示；讲话人是可撤销、可迟到的增强层，不得阻塞文字，
   也不得因识别失败回滚已稳定文字。
5. 最终 canonical transcript、整理和问答只读取已封闭的 final 来源；draft 水位
   只能用于用户可见进度，不得伪装成最终证据。

## 候选方向

### M1：共享语义契约和增量水位（当前隔离首选）

- 以 `ScheduleSemanticDraft v1` 统一 source text、reference/timezone、intent、
  route、slots、missing、source spans、engine revision 和 draft revision。
- 本地和服务端 parser 先作为只读 adapter；共享的是可验证合同和执行语义，不是
  把两份规则代码复制一遍。
- clarification 只提交字段 patch；时间计算由可执行、受限的语义执行器完成，模型
  只能提出候选而不能直接写日历。
- 以 `AudioWatermark v1` 统一 segment id、source range、revision、partial/stable/
  final 和 speaker patch；实时、离线先共用事件合并合同，再比较 provider。
- 不新增第二套 task/lease/retry owner，不增加常驻模型；M1 首先在隔离回放中证明
  能删除重复路由/状态边，不能只增加 envelope。

### R2/G1：替换时间/ASR组件（第二阶段对照）

- Recognizers-Text、SCATE/normit、FunASR Paraformer streaming、Qwen 原生
  streaming 只作为隔离 adapter。
- 外部 README、论文、英文/通用语料、示例 chunk 和模型卡不能直接转化为老记
  中文质量或速度结论。
- 许可证、权重、运行时、Windows、显存和时间戳能力必须在同一输入上闭合后，才
  能提出迁移设计；在此之前不删除现有 parser、8030 或 fallback。

## 概念预算和否决条件

- M1 最多新增一个日程草稿合同、一个语音水位合同和只读 adapter；不得新增第二
  个 durable task、第二个 source truth 或第三套规则路由。
- 如果接入后仍需要手机规则、服务端规则、外部规则各自做最终判定，M1 自动否决。
- 如果 stable 文字必须等待 CAM++、完整音频或全局整理任务，M1 自动否决。
- 如果候选只是改变 UI 文案、扩大 stop timeout、缩短静音阈值或增加重试，而没有
  降低端到端等待边和状态 owner 数量，不算架构收益。
- 任一候选出现日期/时段/结束时间隐式变化、跨会议 segment 污染、稳定前缀回滚、
  最终 CER/DER 回归或资源峰值超限，保持 C0。

## 实施顺序（仍为隔离阶段）

1. 用已记录的手机/服务端结果完成 `ScheduleSemanticDraft` 双 adapter 回放，按
   字段、route、intent、澄清和默认值输出差异；不发网络请求。
2. 用相同 PCM 构造 C0 `completed` 事件基线，再在隔离进程比较 Qwen streaming
   和 Paraformer streaming；记录首个 completed/stable、最终 CER、speaker DER、
   queue wait、GPU/CPU 和取消恢复。
3. 在 Linux 与 Windows clean 环境执行纯合同、序列化和故障回放；外部模型只在
   隔离环境下载，写出版本、hash、许可证和删除路径。
4. 只有 M1 能证明至少删除一组旧 owner 且所有硬门通过，才创建生产纵向切片；否则
   只保留蓝图和 C0 修复，不接入候选。
5. 生产纵向切片仍须遵循 0003 的整理结果单 owner、revision CAS 和原子提交门禁，
   不能因为日程/ASR 改造而另起任务账本。

## 当前结论

0004 是蓝图方向修订，不是实施完成声明。它把“共享语义 + 增量水位”选为下一
个隔离验证方向，同时明确外部组件替换的证据和资源门槛。当前生产行为、APK、
服务器端口、模型和数据库均保持不变。
