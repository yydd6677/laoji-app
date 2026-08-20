# Stage 3 Summary/Q2 隔离混合负载证据（2026-08-20）

状态：`isolated candidate concurrency slice passed; Stage 3 not adopted`。

本轮只验证 Stage 3 内部的两路 Summary 与 Q2 竞争，不把它冒充 vNext 规定的完整十分钟混合负载。
生产 `18020/8030`、公网、GPU1、PCB、Smart Meeting 和其他用户服务均未切换；候选使用本机
`28023` 隧道连接隔离 `127.0.0.1:18023`，ASR 仍为隔离 `8031`。

## 修复内容

1. Question source stream 不再预留 Summary 的 `2 x 4 MiB` checkpoint；旧 active question reservation
   在读取时缩为 1 字节生命周期哨兵。Question source 完成后 manifest 立即 compact 并释放 manifest
   reservation，但加密来源保留到成功、失败或 TTL 清理，以维持重试和幂等。
2. LLM Provider 在后台任务之间增加 1 秒有界交互让出；后台 Ollama 生成改用流式传输，Q2 到达时可
   中止当前可恢复 Summary attempt。Summary 以 `SUMMARY_BACKGROUND_PREEMPTED` 立即从不可变来源和
   checkpoint 重试，不写部分结果。
3. Summary 和 Q2 embedding 统一为 `qwen3-embedding:0.6b`、CPU、`num_ctx=2048`。Summary batch
   从 64 降为 8，使交互请求可在批次间进入；不增加 GPU runner，也不挤出 9B generation runner。
4. `q2-reader-v2` 要求先选逐字引用再写原子分句。服务器把模型并列长句拆成独立 claim，逐项检查
   数字、否定极性、字面覆盖和当前来源；只删除无依据子项，不生成替代事实。ASR 跨行事实最多绑定
   两条精确来源；概述仅允许两条强字面来源共同支撑，不适用于具体事实。
5. Summary 和 Q2 对转写采用相同的 360 字/30 秒证据单元。新增进程内共享 embedding LRU，只保存
   model/options-scoped SHA-256 和归一化向量，不保存正文、问题、回答、文件名或设备身份。十个真实
   SRT 的 Summary/Q2 单元文本一致率为 `100%`，长样本不再重复编码同一来源。

## 失败链与最终结果

三个报告均不保存转写、问题、答案或引用正文：

| 报告 | 功能 | 重叠 Q2 p95 | 结论 |
|---|---:|---:|---|
| `stage3-mixed-summary-q2-20260820.json` | 9/10 | 14.670s | 一条 `Q2_GROUNDING_INVALID`，拒绝 |
| `stage3-mixed-summary-q2-v2-20260820.json` | 10/10 | 16.992s | 引用修复，但性能超门，拒绝 |
| `stage3-mixed-summary-q2-v2-cache-20260820.json` | 10/10 | 12.897s | 本 Stage 3 并发切片通过 |

最终报告 SHA-256：

`970f122f75502efdb80fb44541791cdfb37743559208f979857f852ea4c4b956`

最终报告从 API 进程重启后的冷缓存开始，5/5 pair 均形成一条 Q2 与另一条 Summary 的真实时间重叠：

| 指标 | 结果 |
|---|---:|
| 完整纵向流 | 10/10 |
| 失败 | 0 |
| Summary p50 / p95 / max | 48.438s / 84.231s / 85.525s |
| 所有 Q2 p50 / p95 / max | 9.889s / 12.429s / 13.271s |
| 实际重叠 Q2 p50 / p95 / max | 10.991s / 12.897s / 13.271s |
| Summary 与 Q2 显示引用逐字匹配 | 100% |
| Q2 同 request 重放 | 10/10 完全一致 |
| binding/source/task 清理 | 10/10 confirmed |

曾失败的 `30528111540-1-192.srt` 在最终回放成功，模型宽泛长句只保留被当前转写强证据支撑的
主题和结果；无依据例子不会因共享“温度”等短词而通过。该人工点验只证明这一个回归样本，不替代
独立盲审相关率。

结束时服务器 load average 为 `9.80/14.48/15.27`；候选 API RSS 约 `740 MiB`。GPU0 为
`30004 MiB used / 2108 MiB free`，GPU1 为 `26025 MiB used / 6087 MiB free`，两张卡均未因本轮调整。

## 已关闭与仍开放

本证据关闭：

- Stage 3 内两路 Summary/Q2 的容量死锁和 manifest reservation 泄漏；
- Q2 到达时被下一条后台 Summary 长时间占用的调度回归；
- 相同来源在 Summary 后被 Q2 重复 embedding 的性能回归；
- 该 10 流真实字幕集合上的功能、精确引用、重放和清理回归。

本证据不关闭：

- vNext 规定的至少 30 个暖态问答样本和完整十分钟 ASR/上传/日程/整理混合负载；
- Facts、重要遗漏、行动和 Q2 引用相关性的独立人工盲审 `>=95%`；
- attachment/epoch/binding/commit 的剩余原生进程中断矩阵和旧结果全量迁移；
- summary/question v1 的公开零流量周期与 capability barrier；
- Stage 2 纯 CPU ASR 的首段与 RTF 性能阻断。

因此 Stage 3 仍为隔离候选，不能采用、切生产或进入 Stage 5 删除。
