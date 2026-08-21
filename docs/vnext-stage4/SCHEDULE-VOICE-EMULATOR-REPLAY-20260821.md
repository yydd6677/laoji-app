# Stage 4 语音日程真实音频回放（2026-08-21）

状态：`failed performance gate; isolated candidate; not adopted`。

## 边界

- 设备只使用 LaoJi 专属 `emulator-5562`；候选 APK 为 `1.1.42 (150)`。
- 音频来自现有真实会议视频的 6 秒中文讲话片段，经 Emulator gRPC 虚拟麦克风注入；没有把字幕、
  预设文字或测试答案直接写入应用。
- 该片段不是日程表达，因此五次均被 validator 正确收敛为“不是日程”；它只能验证采集和首文字延迟，
  不能替代自然日程 Draft 质量门。
- 生产 `18020/8030`、公网流量、GPU1、PCB 和其他服务均未改变。

## 结果

五次重复回放的原始机器可读结果见
[SCHEDULE-VOICE-EMULATOR-REPLAY-20260821.json](SCHEDULE-VOICE-EMULATOR-REPLAY-20260821.json)。

| 指标 | p50 | p95 | Stage 4 门限 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 按下到本机采集开始 | 69 ms | 125 ms | <= 100 ms | 未通过（1 次 125 ms） |
| 按下到首个转写文字 | 9018 ms | 9256 ms | <= 1500 ms | 未通过 |

另一次自然日程语音单次 smoke 已到达确认 Draft，停止到 Draft 为约 1.5 秒；单次结果不构成 p95
证据，因此没有写成退出门通过。

## 根因与选定收口方向

当前 schedule realtime WebSocket 只负责采集分片；服务端仍需等待 VAD 关闭完整语音段，再调用 8030
的批量 `/asr`，最后才发送 `transcript.completed`。这不是模型增量解码，首文字下限由“静音等待 +
整段批量推理”共同决定。继续缩短 VAD 静音会增加断句、漏掉句尾动作和标点抖动，不能作为选定方案。

Stage 4 采用的能力门因此明确为：8030 增加与 batch 并存的真正 streaming backend，使用同一
Qwen3-ASR 模型 revision 和单一 ASR owner；会话按增量状态处理 1–2 秒音频块，稳定文字仍通过现有
event ledger 持久化。backend 不可用时候选能力 fail closed，不静默退回当前假流式路径。

当前 GPU0 只有约 2 GiB 余量，GPU1 又不在本目标授权范围；不能在不影响生产/其他用户服务的情况下
启动额外 vLLM streaming 实例。因此本轮只冻结真实失败证据和实现边界，不部署 speculative backend，
Stage 4 仍阻断。

## 可复现工具

- `tools/vnext/inject_emulator_audio.py`：用 Android Emulator 官方 gRPC 音频流向虚拟麦克风注入 PCM WAV。
- `tools/vnext/replay_schedule_voice_emulator.py`：按可访问性标签完成打开、录音、停止、终态等待，并只从
  脱敏 audit 读取延迟，不依赖固定坐标或正文日志。

回滚只需卸载候选 APK/关闭候选 flag；没有数据库或生产服务变更。
