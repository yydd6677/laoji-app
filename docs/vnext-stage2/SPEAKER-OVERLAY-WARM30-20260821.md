# Stage 2 speaker overlay 30 次暖态回放（2026-08-21）

状态：`performance gate passed; candidate-only; not adopted`。

## 回放边界

- 候选 API：隔离 `127.0.0.1:18030`；ASR：隔离兼容入口 `127.0.0.1:8031`。
- 输入：真实会议视频中截取的 6 秒、16 kHz 单声道 PCM，正文不写入报告或日志；来源仅保留
  SHA-256 `806ac994…ab5e6e` 和字节数。
- ASR revision 固定为 `7278e1e70fe206f11671096ffdd38061171dd6e5`；CAM++ revision 固定为
  `campplus-zh-3388cf5fd3493c9ac9c69851`。
- 每轮等待 `session.complete` 后再轮询独立 speaker overlay，随后执行 binding purge；30 轮结束后执行
  epoch purge。报告只保留状态、计数、模型 revision、时延和哈希，不保留文字、姓名、label 或原始 ID。

机器可重算报告为 [speaker-overlay-warm30-20260821.json](speaker-overlay-warm30-20260821.json)，
原始探针报告 SHA-256 为 `f70f8be4…1666ab1`。

## 结果

- `30/30` overlay 为 `succeeded`，assignment 数量范围为 `1–2`；每轮至少先形成 1 个 stable 文字事件，
  final outcome 全部为 `text`。
- overlay 相对文字完成的 p50/p95/max 为 `479.6/629.6/702.5 ms`，明显低于 `30 s` 预算。
- `30/30` binding purge 为 `confirmed`，epoch purge 为 `confirmed`。
- 回放后候选库 integrity 为 `ok`、外键违规为 `0`，active task、speaker input、active speaker run 和
  realtime checkpoint 均为 `0`；realtime/speaker 两个加密 spool 也均为 `0` 文件、`0` 字节。

退出预检现在要求 overlay 时延证据至少 30 条，避免单样本关闭 p95 门。合并该报告后，质量感知
Stage 2 预检为 `20/28`，剩余 8 项不再包含 overlay 性能。

## 运行日志隐私复验

首轮报告暴露了一个与业务 logger 无关的缺口：Uvicorn 通过 `uvicorn.error` 输出 WebSocket 原始路径，
使随机 session ID 出现在候选进程日志，即使 `uvicorn.access` 已关闭。候选修复在
`app/privacy_logging.py` 安装协议路径过滤器，并新增 `tools/vnext/verify_runtime_privacy_log.py` 动态门。

修复后的 `c9b158d` 候选重新完成一次真实转写、overlay、binding/epoch purge。外层进程日志和应用 Tee
日志分别为 57/52 行，两份动态扫描均为 `runtime_privacy_log_findings=0`，原始 API 协议路径计数为 0。
业务的有界 `service_request_timing` 仍保留。随后对隔离候选根目录执行同一模式扫描，精确删除 17 份
含原始 API 路径的历史候选日志（4,002,360 字节），复扫剩余命中为 0；JSON/Markdown 证据和当前脱敏
日志均保留。生产 `18020/8030` 未修改。

## 未关闭范围

这份证据只关闭 speaker overlay 的暖态时延、独立完成和清理门，不证明讲话人识别质量。Stage 2 仍需
第一方双人盲审/裁决的 ASR 与讲话人质量、一个完整公开零旧提交周期、正式 8030 v2 handler 和 capability
人工采用；在这些条件满足前不能停止旧链路或进入 Stage 5 删除。
