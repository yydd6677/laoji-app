# Stage 4 语音日程采集顺序切片

状态：`isolated native candidate; not adopted`。

## 变更

`modules/laoji-native-platform/android/.../RecorderEngine.kt` 的 realtime 启动顺序由：

```text
创建 realtime socket -> 创建 AudioRecord -> 开始本机录音
```

改为：

```text
创建 journal/AudioRecord -> 进入 RECORDING -> 启动录音线程 -> 异步建立 realtime socket
```

录音线程在 socket 尚未 ready 时把 PCM 放入已有有界 pending 队列；连接成功后按原顺序 flush。
连接失败只标记可恢复的 ASR 故障，本机 WAV 和 journal 仍然保留，停止时沿用现有本地音频恢复路径。
这没有新增第二个录音 owner、WebSocket owner 或服务器 fallback。

## 回滚边界

- 候选 APK 未发布，稳定版仍使用原 native handler。
- 回滚只需切换回上一份 APK/native handler；不需要数据库迁移，也不修改生产服务。
- 8030、18020、8031、18021 和公网入口均未因本切片重启或切流量。

## 证据

- `python3 tools/vnext/verify_schedule_voice_capture_order.py`：通过，确认本机采集线程位于
  realtime socket 启动之前，并保留有界队列和连接失败本地保留路径。
- `android/gradlew :laoji-native-platform:compileDebugKotlin --no-daemon`：成功。
- 该切片尚未替代专属 LaoJi Android 设备上的冷启动、断网、首帧延迟和杀进程回放，不能作为
  Stage 4 退出或生产采用证据。

2026-08-21 已在专属 `emulator-5562` 通过 gRPC 虚拟麦克风完成 5 次真实中文音频回放；本机采集启动
p50/p95 为 `69/125ms`，首文字 p50/p95 为 `9018/9256ms`。采集路径已接近门限但仍有一次超标，首文字
明显不合格。证据和根因见
[语音日程真实音频回放](SCHEDULE-VOICE-EMULATOR-REPLAY-20260821.md)，因此本切片仍未退出。
