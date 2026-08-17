# 老记生产管线组合指标 2026-08-16

## 范围与方法

- status: `observed; production read-only metadata audit`
- observed at: `2026-08-16 18:11 CST`
- service: `laoji-api.service`, active PID `366740`
- cwd: `/home/zhong/laoji-service-platform/compact-production/backend`
- database: SQLite `local.db` opened with `mode=ro`
- logs: systemd journal，只读取 endpoint、状态、耗时和空客户端元数据标记

本审计没有读取问题、答案、转写、笔记、会议标题、文件名、坐标或 R2 key，也没有修改、
重启或触发任何服务、任务、数据库、对象、模型或设备。p95 使用有序样本的线性插值；小
样本只用于否证“当前已经足够快/稳定”，不表示生产 SLO。

## 现场资源

| 项目 | 观察 |
|---|---:|
| `laoji-api` RSS | 824,716 KiB，约 805 MiB |
| GPU0 | 29,566 / 32,607 MiB，观察时利用率 0% |
| GPU1 | 25,949 / 32,607 MiB，仅观察，禁止操作 |
| 根分区余量 | 83 GiB |
| `/home` 余量 | 472 GiB |

这些是瞬时值，不能当峰值预算。GPU0 只余约 3 GiB，不支持未经隔离预算再常驻一个完整
reader 或 streaming provider。

## 上传与资产

| 指标 | 结果 |
|---|---:|
| R2 session 状态 | completed 36 / active 3 / expired 7 |
| completed 建立到完成 | p50 8.204 s / p95 81.753 s |
| asset 状态 | processed 42 / registered 10 |
| registered 滞留年龄 | 81.07 至 148.74 小时 |
| 3 个 active session 大小 | 118.6 / 240.4 / 311.4 MiB |

完成样本的 p50 不支持“上传仍是当前最高延迟来源”；但长期 registered 资产和 active/expired
session 仍证明恢复与清理 owner 没有闭合。两者不能相互抵消：U2 的生命周期合同应保留，
但当前没有证据让它继续独占下一轮蓝图。

## ASR

| 指标 | 结果 |
|---|---:|
| transcription jobs | completed 26 / failed 15 |
| failed error | `no_speech` 15 / 15 |
| completed 端到端时间 | p50 55.599 s / p95 335.196 s |
| 有音频时长样本的 realtime factor | n=20，p50 0.161 / p95 0.386 |

已完成离线 ASR 的计算速度相对音频时长不慢，但这组数据库终态无法测量首个 partial、
stable 或 final 片段何时到达，也无法证明用户报告的“多数文字最后一起返回”已解决。
`no_speech` 是内容终态，不应与基础设施失败混成同一种用户结果。

## 整理

| 指标 | 结果 |
|---|---:|
| summary tasks | success 51 / failure 16 |
| failure 分类 | `CompactSummaryError` 10 / `SUMMARY_EVIDENCE_INCOMPLETE` 6 |
| success 端到端时间 | p50 28.106 s / p95 93.653 s |

成功耗时不能掩盖 16 个终态失败。当前数据没有人工质量标签，不能由任务 success 推导整理
正确；但失败分类足以把整理可靠性保留在优先队列。

## 会议问答

本次 API 进程启动后，journal 中有 7 个 `POST .../questions` 200 响应：

- min 3.764 s
- p50 22.493 s
- p95 29.499 s
- max 31.833 s

这是小样本，而且可能包含自动化请求；它只能否证“当前问答已经是低等待链路”。结合
生产源码中可达的样本答案分支和正常路径至少两次模型调用，问答同时存在质量污染、串行
复杂度和用户等待三类架构问题。

## journal 污染边界

近七天 `laoji-api` journal：

- 总行数：217,400
- `service_request_timing`：208,504
- `client_metadata={}`：209,298

日志没有设备/人工/自动化来源标签，且历史上执行过大量回放与自动化验证。不得用这些
计数计算真实用户流量、成功率、准确率或 p50/p95 SLO。后续真实体验比较必须使用隔离
canary、非私人公开/合成输入、明确 `traffic_class` 和 provider/model/prompt revision。

## 对组合优先级的影响

1. U2 保留 C2 cleanup obligation 和单 owner 设计，但冻结当前 0034；没有授权时不执行
   真实 R2。
2. 问答在同一问题上同时命中样本分支、多轮模型串行、上下文漂移和 20 秒级等待，应优先
   建立无样本污染的证据原生 reader 纵切。
3. ASR 下一步先补首 partial/stable/final 的可重复测量；数据库 realtime factor 不能替代
   用户感知延迟。
4. 整理保留真实失败专题；不能因 v3 schema 或 task success 就宣称质量闭合。

