# Stage 2 GPU realtime candidate replay

状态：`candidate evidence; Stage 2 exit still blocked`。

## 运行边界

- 隔离 API：`127.0.0.1:18021`。
- 隔离 ASR：`127.0.0.1:8031`，临时使用 GPU0；生产 `18020/8030` 未重启或修改。
- 模型：Qwen3-ASR-1.7B，revision `7278e1e70fe206f11671096ffdd38061171dd6e5`。
- 样本：候选目录真实 speech PCM，报告只保存 SHA-256、字节数、事件计数和耗时，不保存正文。
- 30 次回放复用一个 device/epoch，binding sequence 单调递增；每次拥有独立 meeting binding、task、
  realtime session，并在终态 ACK 后执行 binding purge。

## 结果

- 30/30 终态为 `text`。
- 每次至少产生 1 个 stable event；无重复 final event。
- 30/30 `purge_state=confirmed`。
- 完整断线恢复回放墙钟：p50 `6371ms`，p95 `7929ms`。
- 该耗时包含上传 chunk、主动断开、重连、事件重放、终态提交、ACK 和 purge，不能冒充稳态首文字
  p95；它证明了连续多次恢复不会丢失文字或跨 binding 覆盖。

## 单段暖态 ASR

同一隔离 GPU ASR 进程上，对真实 speech 的 1 秒窗口执行 30 次 `/v2/asr/batch` 单段 realtime 请求：

- 墙钟 p50 `106ms`，p95 `142ms`；模型推理 p50 `91ms`，p95 `127ms`；队列 p95 `12ms`。
- 30/30 返回 `outcome=text`，模型 revision 一致。

这项结果说明 GPU0 上的单段模型调用满足实时预算方向，但不等于 Android 端到端稳态 p95，也不覆盖
讲话人 overlay、网络传输和真实设备采集。Stage 2 仍必须完成专属 Android 进程死亡/网络切换证据、
混合负载资源门、未知/已登记讲话人质量和旧流量零周期后，才能激活 capability barrier。

## 资源与回滚

测量期间 GPU0 临时 ASR 进程约占 4.98 GiB 显存；测量完成后应停止该临时候选进程，恢复 GPU0
余量。GPU1、PCB、Smart Meeting、生产服务和公网入口均未触碰。候选 release 可通过
`/home/zhong/laoji-vnext-candidate/releases/8c3559f` 回溯，生产回滚基线仍是 `1.1.10 (118)`。
