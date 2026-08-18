# Stage 2 device-v2 实时转写候选回放（2026-08-19）

状态：`isolated candidate evidence; not adopted`。

## 边界

- 候选 API 使用 `127.0.0.1:18021`，候选 ASR 使用 `127.0.0.1:8031`；生产 `18020/8030`、公网、GPU1、PCB、Smart Meeting 和其他服务未修改。
- 输入为用户明确提供的会议视频样本的短 PCM 窗口；报告只保留 SHA-256、字节数、事件计数、revision、阶段耗时和清理状态，不保存正文、文件名、设备原始标识或 token。
- 回放客户端运行在服务器候选 Python 环境，使用正式 device-v2 注册、P-256 challenge/token、binding、WebSocket `realtime.chunk.v2` 和 `transcript.stream.v2` 协议。它不是 Android APK 运行时验收。

## 真实结果

### 有语音 + 网络中断恢复

报告：`realtime-probe-fdae675-reconnect.json`（候选服务器上的临时报告，已脱敏复制到本地验收记录）。

- 输入：320,000 bytes，10 个 1 秒分片。
- 第一个连接发送前 5 个分片后主动断开；第二个连接从服务端报告的第 5 个分片继续。
- 事件：2 个，其中 1 个 stable；最终事件序号 2，`outcome=text`。
- ASR revision：`7278e1e70fe206f11671096ffdd38061171dd6e5`。
- 总耗时：5,835 ms。
- binding purge：`confirmed`。

### 令牌刷新 + 网络中断恢复

报告：`realtime-probe-token-refresh-20260819.json`（仅哈希、字节数、事件计数、耗时和清理状态）。

- 输入：256,000 bytes，8 个 1 秒分片；第 4 个分片后主动关闭连接。
- 第二条连接使用同一设备 epoch、binding 和任务游标，但在重连前完成一次新的 P-256
  challenge/token exchange；旧 bearer 未写入报告或持久日志。
- 服务端从第 4 个分片继续，最终收到 2 个 stable 事件和 1 个 final 事件，结果为
  `outcome=text`，无重复分片。
- 总耗时：6,016 ms；binding purge：`confirmed`。

这证明候选服务的令牌刷新合同和实时游标恢复可以串联工作，但仍不是 Android 原生
录音线程的系统网络切换验收。

### 无语音成功结果

报告：`realtime-probe-fdae675-trimmed.json`。

- 输入：256,000 bytes，8 个分片。
- 事件：1 个 final，stable 数量 0，`outcome=no_speech`，`model_revision=no-asr-inference`。
- 总耗时：1,443 ms。
- binding purge：`confirmed`。

两次回放后候选 `/api/ready` 均为 `ready=true`，任务队列深度为 0，未留下候选 binding 的待清理状态。

## 代码变化

- `tools/vnext/probe_device_v2_realtime.py`：正式协议回放器，包含设备注册、分片时间轴校验、主动断线、游标重连、事件 ACK 和 purge。
- `services/laoji-api/app/api/device_v2_realtime.py`：为协议错误增加只记录错误类型/受限错误码的隐私安全诊断，不写入正文或原始标识。
- `DeviceV2RealtimeAsrSocket.kt`：Android 端把不足 1ms 的 PCM 尾部留在内存，下一帧合并；录音结束不发送无效零时长 wire frame，且不影响本机完整 WAV。
- 回放工具同样裁剪不足 1ms 的媒体尾部；该边界有单元测试覆盖。Android 工程 `:app:compileDebugKotlin` 通过。

## 仍未闭合

- 尚未在 LaoJi 专属 Android 设备上验证 WorkManager/录音线程的真实进程死亡、系统网络切换、token refresh、连续 stable/final 页面投影和本地 SQLite 恢复。
- 因此 Stage 2 capability barrier 继续关闭，生产仍使用稳定路径，不能删除旧上传或旧实时入口。
