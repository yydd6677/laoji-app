# Stage 2 无语音结果兼容收敛

状态：`implemented in isolated worktree; not activated`

`DeviceMeetingCompletionProvider` 现在区分三种情况：

- 任务仍在 `queued/running` 或响应不完整：继续等待，不提前结束；
- 请求/服务端失败：保留原有失败和重试路径；
- 任务明确为 `completed`、响应完整且条目为空：按成功的 `no_speech` 内容结果处理，清除本机
  pending task，并将会议结束状态持久化，不显示“转写失败”。

这只修正兼容设备转写补全路径；v2 `no_content` 事件路径仍按事件游标、投影和 ACK 合同处理。
没有切换 capability、生产端口或 APK。

证据：

- `python3 tools/vnext/verify_stage2_android_contract.py`：通过，包含无语音分支静态门；
- `npm exec -- tsc --noEmit --pretty false`：通过；
- `python3 -m compileall -q services/laoji-api/app services/laoji-asr tools/vnext`：通过。

未验证：专属 Android 设备上的真实无语音录音、网络中断和进程死亡回放。
