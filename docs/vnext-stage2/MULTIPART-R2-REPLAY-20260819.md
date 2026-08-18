# Stage 2 multipart R2 回放（2026-08-19）

状态：`candidate evidence; production not changed`。

在隔离 `18021/8031` 上使用同一真实会议视频的有效 MP4 前缀构造 `33,554,432` bytes 候选对象，
文件仅存于本机 `/dev/shm`，不进入工作区或生产。对象超过 32 MiB 单片阈值，因此强制走 8 MiB
multipart 合同；回放完成后内存文件已截断为 0 bytes。

| 项目 | 结果 |
| --- | --- |
| 上传模式 | `multipart` |
| 分片 | `4 x 8 MiB` |
| 上传后任务 | `succeeded` |
| 稳定/最终事件 | `115 / 1`，final 为最后序号 |
| ACK | 通过 |
| purge | `confirmed` |
| 模型 revision | `7278e1e70fe206f11671096ffdd38061171dd6e5` |
| 墙钟 | `287015 ms`，隔离 CPU 候选，不作为生产延迟承诺 |

这次关闭了 multipart 直传、分片合并、转写事件、ACK 和 purge 的候选证据缺口。仍缺 LaoJi
专属 Android 设备的 WorkManager 断网、杀进程、token refresh、本地投影和 capability barrier，
所以不切生产、不删除旧链路。
