# Stage 2 候选内存回放

状态：`candidate evidence; Stage 2 exit still blocked`。

## 候选部署

- API：隔离 `127.0.0.1:18021`，release `7f2b8e1`。
- ASR：隔离 `127.0.0.1:8031`，Qwen3-ASR-1.7B，CPU；生产 `18020/8030` 未重启或修改。
- GPU1、PCB、Smart Meeting、公网入口未触碰。

## 本次修改

`SpeakerEmbeddingExtractor` 现在使用 `torch.inference_mode()`，并在每个 CAM++
窗口完成后对 Linux glibc 做 best-effort `malloc_trim(0)`。Windows 路径跳过该调用，
不会改变业务结果。该修改针对长会议声纹异步 lane 的临时 tensor 和 allocator arena，
不改变 ASR、文字、引用或讲话人阈值。

## 真实候选回放

- 候选 API 重启后 RSS：约 `0.86 GiB`。
- 双上传 + 两个离线转写 + 一条 realtime：
  - 两个上传均成功，两个转写均 `19 stable + 1 final`；
  - realtime `outcome=text`，`queue_ms=6`，`infer_ms=5524`，完整回放 `123805ms`；
  - 回放后 API RSS：`967348 KiB`（约 `0.92 GiB`）。
- 10 次主动断线/重连/令牌刷新/事件重放/ACK/purge：
  - `10/10` 终态 `text`，每次至少 2 个 stable event；
  - 墙钟 p50 `6867.5ms`，p95 `7130ms`；
  - 回放后 API RSS：`1064564 KiB`（约 `1.02 GiB`），仍低于 `1228800 KiB` 的 API 峰值门。

报告文件：

- `stage2-concurrency-7f2b8e1.json`
- `realtime-7f2b8e1-repeat10.json`

候选数据库只读复核：SQLite integrity `ok`、foreign-key violations `0`、active task `0`、
pending cleanup `0`、realtime ledger `0`、chunk checkpoint `0`。候选 `/api/ready` 和
`8031 /ready` 均为 `ready=true`。

## 仍未通过的门

- GPU0 实测只有约 `143 MiB` 空闲，低于 Stage 2 要求的 `1 GiB`；候选 ASR 因此不能加载到 GPU。
- 本次 realtime 墙钟包含断线恢复流程，不能作为 Android 稳态首字或端到端 p95。
- 专属 LaoJi Android 的 APK、进程死亡、网络切换、页面投影去重、NO_SPEECH、真实连续转写和
  混合负载设备证据仍缺失。
- 旧公开 submit 零流量周期和 capability barrier 仍未激活。

因此该回放只证明候选内存增长得到控制和恢复链路可重复，不允许退出 Stage 2 或切换生产。
