# Stage 2 校验媒体复用与 GPU0 导入性能回放

状态：`isolated candidate evidence; selected-architecture performance gate passed; adoption gates open`。

## 结论

Stage 2 的首段和整体 RTF 性能阻断已经在选定的 GPU0 架构上关闭，但 Stage 2 尚未退出、尚未采用。

- 设备完成 R2 上传后，API 本来就必须完整读取对象并核对长度和 SHA-256；候选现在将这一次已经读取的
  压缩媒体流写入私有、有界的临时缓存，事务提交后才原子发布给转写 worker，避免 ffmpeg 再次经公网
  Range 下载同一对象。
- R2 仍是可恢复来源。缓存缺失、损坏或超过容量时直接回到原 R2 解码路径，不改变 verified asset、
  Task、cleanup obligation 或幂等身份。
- 缓存不是整份 PCM/WAV：保存的是设备上传的压缩媒体，单对象上限 512 MiB、总上限 4 GiB，目录权限
  0700、文件权限 0600；成功/no-speech 后立即删除，失败/取消/崩溃残留由 active Task 扫描和一小时
  partial TTL 清理。
- 缓存只在 verified asset 与唯一 transcription Task 的数据库事务提交后可见；提交前文件保持随机
  `.partial` 名称，因此维护线程不能把尚无持久任务身份的有效媒体当作孤儿删除。

## 根因与否决实验

同一真实媒体的完整链路对照表明，先完成 R2 校验、再由 worker 第二次发起公开 Range 读取是首段延迟的
主要来源：R2/ffmpeg 路径首段约 12 秒、墙钟约 37 秒；同一已校验压缩文件本地解码首段 4.517 秒、
墙钟 27.756 秒、RTF 0.4626。

以下路线均未保留：

- 后续 VAD 片段从 4 秒放宽到 8 秒：30 条 CPU 回放首段 p95 11.486 秒、RTF p95 0.704，均退化。
- FP32 同模型：4 秒单条约 7.7–8.0 秒、batch 8 约 12.5–12.9 秒，峰值 RSS 约 13 GiB。
- BF16 inter-op=1：4 秒单条约 4.3–4.6 秒、batch 8 约 11.5 秒，无实质收益。
- 单 NUMA/物理核亲和：4 秒单条约 8.9–10 秒、batch 8 约 14.7–21 秒，明显退化。
- 两个 CPU 4-item 推理并行：约 15.4–15.8 秒，慢于单个 batch 8 且增加内存。
- 5 秒后续片段：早期真实样本 RTF 已达 0.588，按失败关闭原则提前停止。

因此纯 CPU 不是选定的生产 ASR 路线；默认 VAD 最大语音片段仍为 4 秒，单批总音频上限仍为 32 秒。

## 真实全链路回放

正式回放使用隔离 API、隔离 SQLite、隔离 R2 前缀和候选缓存，顺序处理 30 条由当前真实会议样本派生的
媒体。ASR 使用生产 GPU0 上已经常驻的同一 `Qwen3-ASR-1.7B`、同一模型 revision
`7278e1e70fe206f11671096ffdd38061171dd6e5`。为避免重启或替换生产 8030，只在 loopback 启动测试工具
`probe_v2_asr_compat_proxy.py`，把候选 v2 DTO 映射到现有 v1 batch；它不记录音频、文字或身份，也不是
生产依赖。

| 指标 | 结果 | 门限 | 结论 |
| --- | ---: | ---: | --- |
| 文本成功 | 30/30 | 30/30 | 通过 |
| 每任务单一 final | 30/30 | 30/30 | 通过 |
| 首段 p50 | 2.272 s | - | 观测 |
| 首段 p95 | 2.877 s | <= 8 s | 通过 |
| 首段范围 | 1.664–3.548 s | - | 观测 |
| 导入 RTF p50 | 0.110033 | - | 观测 |
| 导入 RTF p95 | 0.140411 | <= 0.5 | 通过 |
| 导入 RTF 范围 | 0.086210–0.145459 | - | 观测 |
| cleanup obligation | 30/30 | 30/30 | 通过 |

正式机器报告：

- 路径：`/home/zhong/laoji-vnext-candidate/stage2-cache-gpu-perf30-20260820.json`
- SHA-256：`934178deb41281528a7164d5751d2a8cb59fbc013fcd3626b4b61ce6c3700a74`

此前另有同配置 10 条预检：首段 p50/p95 为 1.938/4.015 秒，RTF p50/p95 为
0.110144/0.144933，10/10 文本、单 final 和清理均通过。两轮累计隔离数据库为 40 succeeded、
40 cleanup confirmed、0 未确认事件 payload、0 未消费 verified asset，缓存目录为空。

回放后测试桥、隔离 API 和 CPU 候选 ASR 均已停止；生产 18020/8030 未重启、未改配置、未切流量，
GPU1、PCB、Smart Meeting、其他服务和 `emulator-5560` 均未触碰。

## 仍然开放的退出门

本证据只关闭 Stage 2 的选定架构首段/RTF 性能项，不授权 capability barrier：

1. 需要将仓库中的正式 `/v2/asr/batch` handler 随候选 8030 部署并验证，测试桥不得进入生产拓扑。
2. 仍需 Android 网络/进程恢复、连续文字、NO_SPEECH、双上传+实时会议和讲话人质量的完整候选回放。
3. 仍需 CER/数字时间、未知讲话人、混合负载资源余量和隐私门。
4. 旧 upload/ASR submit 必须完成一个公开发布周期的零流量，随后才可持久激活 capability barrier。
