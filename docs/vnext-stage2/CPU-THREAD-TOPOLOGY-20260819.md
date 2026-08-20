# Stage 2 CPU ASR thread-topology check (2026-08-19)

状态：`isolated CPU evidence; topology rejected; no adopted runtime change`。

本报告保留 CPU 拓扑否决证据。选定 GPU0 架构的首段/RTF 后续结果见
[校验媒体复用与 GPU0 回放](VERIFIED-MEDIA-CACHE-GPU-20260820.md)。

## 实时边界

- 隔离 ASR `8031`：Qwen3-ASR-1.7B、固定 revision
  `7278e1e70fe206f11671096ffdd38061171dd6e5`、CPU；服务保持 ready，队列为空。
- 服务器为双路 Xeon Gold 6330，共 56 个物理核/112 个逻辑 CPU。PyTorch 2.11 默认 intra-op 与
  inter-op 均为 56；8031 affinity 为 `0-111`。
- GPU0 只剩约 `321 MiB`，GPU1 约 `6087 MiB` 可用，但 GPU1 属于明确禁止触碰的边界。生产
  `18020/8030`、PCB、Smart Meeting 和其他用户进程均未修改。
- 测量时另一个项目的 8-vCPU 模拟器正在持续运行，因此结果代表共享服务器混合负载，不是空机峰值。

## 同模型暖态对照

使用同一真实 60 秒媒体的第一个 4 秒语音 PCM，通过 `/v2/asr/batch` 做 5 次顺序调用；不保存文字。

- 当前 8031（56 线程、跨双路 CPU）：墙钟 `4317/3769/3211/3965/4761 ms`；范围
  `3.211-4.761s`。
- 临时 8032（只绑定 NUMA node 1 的逻辑 CPU，OMP/MKL 28 线程）：墙钟
  `6947/5461/4961/5574/4831 ms`；范围 `4.831-6.947s`。
- 28 线程/单 NUMA 方案在每次测量均未优于当前配置，因此不采用。8032、临时日志和 10 份临时
  JSON 已删除；8031 没有重启或改配置。

## 结论

4 秒模型调用本身的暖态尾部低于 8 秒，但这不能替代导入端到端 30 条门。旧导入回放 p95 的高值
包含 worker、VAD、R2 读取和共享 CPU 尖峰；该 CPU 路线未能取得 30 条
`first_stable_p95 <= 8s` 与 `RTF p95 <= 0.5`，因此被否决。选定 GPU0 路线仍须解决余量、正式 v2
handler 和混合负载采用边界。缩短首段到 2 秒会增加断句和上下文损失，不作为追求指标的默认改动。
