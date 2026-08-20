# Summary V3 r5 稳定资源延迟分布（2026-08-20）

状态：`isolated candidate performance gate passed; Stage 3 not adopted`。

本轮在已部署的 `summary-facts-v3-chapter-r5` 上重新执行与 r4 完全相同的 10 份真实 SRT、每份
3 轮的 device-v2 source-stream 回放。未修改 Facts 提示词、事实协议、输出上限、样本内容或评测门，
也未切换生产 `18020/8030`、公网流量、GPU1、PCB、Smart Meeting 或其他用户服务。

## 候选身份与环境

- API：本机 `28023` SSH 隧道到隔离 `127.0.0.1:18023`；生产 API 未接入。
- handler / prompt / model：`summary-facts-v3-chapter-r5 / facts-v3-r15 / ollama:qwen3.5:9b`。
- Summary 证据选择使用相同 `qwen3-embedding:0.6b`，固定 CPU、`num_ctx=2048`；Q2 策略未改变。
- 开始时服务器 load average 为 `15.66/18.56/24.14`，运行中曾升至 `48.29/39.95/32.13`，结束后
  为 `44.12/53.90/44.48`；服务器有 112 个逻辑 CPU。没有暂停并发的其他项目，因此本报告不是
  专属空载基准，也不把外部负载波动从结果中剔除。
- GPU0 全程约 30,002 MiB used / 2,110 MiB free；GPU1 未调整。

## 权威报告

`stage3-full-source-latency-runtime-r5-stable-20260820.json`

- SHA-256：`06f4c2dbd4b35444daa569171743c5b4f339dfedc6bfb9121cf62c72c31eb570`；
- 30/30 成功，0 失败，所有任务均在 attempt 1 完成；
- 所有显示 Facts 引用逐字匹配当前不可变来源；
- 所有临时 binding/source/task 均 `purge-confirmed`；
- 30 条报告中的 handler、prompt、model revision 完全一致。

| 路径 | 次数 | p50 | p95 | 最大值 | 目标 | 结果 |
|---|---:|---:|---:|---:|---:|---|
| 单包且不超过一小时 | 24 | 15.368s | 35.498s | 35.603s | 20s / 45s | 通过 |
| 全部，含 6 个双章节长会 | 30 | 21.677s | 60.483s | 75.611s | 45s / 90s | 通过 |

两个超过一小时的来源均分为两个章节：78.2 分钟样本三轮为
`48.362s / 48.871s / 56.547s`，72.1 分钟样本为
`53.937s / 63.703s / 75.611s`。没有长度拒绝或任务级重试；该自动报告不把成功完成冒充人工
语义完整性证明。

## 与 r4 同输入对比

| 单包指标 | r4 | r5 | 变化 |
|---|---:|---:|---:|
| p50 | 21.724s | 15.368s | -29.3% |
| p95 | 58.925s | 35.498s | -39.8% |
| 最大值 | 63.671s | 35.603s | -44.1% |

r5 只改变 Summary embedding 的放置和上下文，不改生成模型或验证器。先前 35.5 分钟夹具的两次
smoke 已证明 CPU/GPU embedding 的选择与概述哈希、事实/行动数量和引用一致；本次分布进一步证明
30 条均保持引用完整，但不把模型输出的事实条数稳定性冒充人工语义等价性。

## 能关闭与不能关闭的门

本报告关闭 Stage 3 的暖态 Summary 单包 `20s/45s` 和长证据路径 `45s/90s` 性能门，并把 r5 从
“可行性能候选”提升为已测的隔离候选实现。

Stage 3 仍未退出，原因不再是 Summary 暖态延迟，而是：

- Facts 支持、重要遗漏和行动有效性仍缺独立人员盲审 `>=95%`；
- Q2 冷启动/混合负载和独立引用相关性门仍未完全闭合；
- attachment/epoch/binding 的剩余原生负向恢复组合与旧结果全量迁移仍缺；
- summary/question v1 的完整公开零流量周期和 capability barrier 未完成；
- Stage 2 纯 CPU ASR 性能门仍阻止全局候选按阶段顺序采用。
