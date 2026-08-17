# 候选 0009：日程草稿与语音水位合同证据

## 状态与范围

- status: `candidate; isolated-contract-tests; not adopted`
- observed: 2026-08-16 Asia/Shanghai
- 本证据只覆盖两个标准库隔离原型，不代表生产代码、服务、模型、设备或 APK 已修改。

## 原型位置

- 日程：`/home/yydd/LaoJi-candidates/schedule-semantic-draft-0001`
- 语音：`/home/yydd/LaoJi-candidates/audio-watermark-0001`

## 执行结果

```text
schedule-semantic-draft-0001: 8 tests, 8 passed
audio-watermark-0001:        6 tests, 6 passed
```

执行命令均为 Python 3：

```bash
PYTHONPATH=. python3 -m unittest discover -s tests -v
```

## 已证明的合同边界

### ScheduleSemanticDraft v1

- 只要有开始日期，创建草稿可以 complete；开始/结束钟点互不强制。
- 只有开始钟点而没有日期时，状态为 `needs_clarification`，不会被标记为可保存。
- 来源文本、字段 span、引擎和 revision 在适配时保留。
- clarification 只修改声明的字段，产生新的 draft revision 和 parent revision，不产生保存副作用。
- 旧 revision 的补充被确定性拒绝；查询操作不能被转换成可保存的 create。
- 字段差异按语义 slot 报告，不以最终标题相同掩盖日期或状态冲突。

### AudioWatermark v1

- segment revision 和 stage 只能前进；重复事件幂等，旧 revision 不覆盖新文字。
- stable 前缀不能被后续事件静默改写；final segment 封闭后不接受迟到正文。
- 讲话人以独立 patch 后到，不修改文字或时间轴。
- 跨 source 的相同 segment id 被拒绝，防止跨会议污染。
- stable 后到的 partial 只更新未稳定后缀，状态仍保持 stable。

## 未证明与下一道门

- 未调用 8030、Qwen、FunASR、CAM++、模型路由或真实 WebSocket；服务端 quick parser 仅在隔离工作树的项目 venv 中被只读调用。
- 未使用真实中文语料，不能报告准确率、CER、DER、首字 p50/p95、吞吐、显存或 CPU 改善。
- 未证明 TypeScript/Python/Android 之间的序列化兼容、网络断线恢复、SQLite 持久化或 UI 合并。
- 未证明把这些合同接入生产后能删除任何现有 owner；接入前仍必须先做只读 adapter replay，并保留 C0 回滚。

## 当前源码小回放（不等于质量评估）

在临时 `/tmp` 目录编译当前 `localScheduleParser.ts`，并用最小主题 stub
避免加载 UI 运行时后，记录了 8 条固定 reference/timezone 输入到
`/home/yydd/LaoJi-candidates/schedule-semantic-draft-0001/fixtures/`。
其中“明天下午三点半到五点开会”和“明天下午三点半开会到五点”都产生
`15:30 -> 17:00`，但路由仍为 `server_required`；“明天开会”产生只有开始日期的
`local_safe` 草稿；“下午三点开会”进入 `clarify`；“明天有什么安排”虽被路由为查询，
原始规则结果仍带有标题样式的“有什么”。这不是线上故障复现，也没有调用服务端，
但说明统一契约必须同时携带 intent/route 和 slots，不能只传一个看似完整的结果。

随后在服务工作树的项目 `.venv` 中只读调用 `parse_schedule_text_sync()`，同一
reference/timezone 下得到以下字段级差异（两边均走规则/quick，未触发模型）：

| 输入 | 手机记录 | 服务端记录 | 差异含义 |
|---|---|---|---|
| 明天下午三点半到五点开会 | 15:30-17:00，route `server_required` | 15:30-17:00，route `quick` | 字段相同但路由 owner 不同 |
| 明天下午三点开会 | 15:00，无结束时间 | 15:00-16:00 | 服务端隐式补时长，违反“只填开始也可”的可见语义风险 |
| 明天三点开会 | 03:00，`local_safe` | 时间为空并要求确认上午/下午 | 同一口语的安全性判定冲突 |
| 下午三点开会 | 15:00，无结束时间，`clarify` | 15:00-16:00，`quick` + 缺日期澄清 | 默认结束时间仍不一致 |
| 明天有什么安排 | 标题“有什么”，查询路由 | 标题“有什么安排”，quick | 查询不能携带可保存标题投影 |

单次服务端 quick 观测约 `0.38-35.82ms`，只是本机 warm 运行记录，不能作为
线上 p50/p95 或模型延迟结论。完整原始字段在两个 fixture，`paired_replay.py`
只做适配和差异报告。随后用 `run_server_quick_replay.py` 将模型调用替换为
失败 stub，8/8 输入仍完成 quick 解析，确认这组差异不是模型输出造成的。

## 决策

原型合同通过，候选仍保持 `not adopted`。下一步是用同一组脱敏输入分别适配当前本地结果、服务端结果和（仅隔离）外部时间/ASR候选，输出字段差异与延迟分解；未经该回放，不得修改生产路由或宣称速度/质量提升。

本轮已完成一组 Recognizers-Text 1.3.1 的隔离时间实体回放，脚本和边界说明在
`/home/yydd/LaoJi-candidates/schedule-semantic-draft-0001/RECOGNIZERS_REPLAY.md`。
它能保留“明天三点”的双候选和未解析的重复集合，支持 M1 的“不静默猜测”方向；
尚未把实体适配为可保存日程，也未测中文自然语料质量。
