# Stage 2 无语音结果兼容收敛

状态：`implemented in isolated worktree; not activated`

`DeviceMeetingCompletionProvider` 现在区分三种情况：

- 任务仍在 `queued/running` 或响应不完整：继续等待，不提前结束；
- 请求/服务端失败：保留原有失败和重试路径；
- 任务明确为 `completed`、响应完整且条目为空：按成功的 `no_speech` 内容结果处理，清除本机
  pending task，并将会议结束状态持久化，不显示“转写失败”。

这只修正兼容设备转写补全路径；v2 `no_content` 事件路径仍按事件游标、投影和 ACK 合同处理。
没有切换 capability、生产端口或 APK。

## 2026-08-19 真实静音复核

隔离 8031 使用一秒、16 kHz、signed-int16 的全零 PCM 调用严格
`/v2/asr/batch`，旧候选实际返回了文本“嗯。”和 `outcome=text`。这证明原先只有“空数组不调用
模型”的单测不足以覆盖真实静音，模型会在数字静音上产生短词幻觉。

新候选在统一 ASR coordinator 入队后、模型调用前增加保守的双门：RMS 不超过 `0.0005` 且峰值
不超过 `0.002` 才视为无语音；两个阈值均通过部署环境显式配置。静音项目不进入 Qwen batch，
v2 结果稳定投影为 `no_speech`，而超过门限的正常低音量仍进入同一个模型路径。

`0eae538` 候选随后部署到版本目录
`/home/zhong/laoji-vnext-candidate/releases/0eae538/services/laoji-asr`，只重启 loopback 8031。
对完全相同的一秒全零 PCM 重放后返回 HTTP 200、`outcome=no_speech`、空文本、
`text_state=stable`、`segment_revision=1` 和 `infer_ms=0`；18021 同时保持 `ready=true`。
旧 8031 源码目录仍保留，可通过停止候选进程并从旧目录显式启动回滚。生产 8030 未重启、未改源码、
未改端口，复核时仍以 `cuda:0` 和同一固定模型 revision 返回 ready。

证据：

- `python3 tools/vnext/verify_stage2_android_contract.py`：通过，包含无语音分支静态门；
- `npm exec -- tsc --noEmit --pretty false`：通过；
- `python3 -m compileall -q services/laoji-api/app services/laoji-asr tools/vnext`：通过。
- Stage 2/3/4 候选聚焦集合加入 ASR 服务测试后：`179 passed, 17 warnings`。

未验证：专属 Android 设备上的真实无语音录音、网络中断和进程死亡回放。
