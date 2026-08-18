# ASR v2 完整视频回放复核（2026-08-19）

状态：`isolated candidate evidence; not production`。

样本：`39799065_da2-1-16.mp4`，无字幕，媒体时长约 360.107 秒。通过隔离服务器 `8031` 的
`/v2/asr/batch` 回放，ffmpeg 直接输出 16 kHz 单声道 PCM，没有生成中间 WAV。

## 严格结果

报告：`asr-v2-full-replay-39799065-strict-20260819.json`。

- 分片：26 个，每片最多 14 秒；请求批大小 8。
- 音频覆盖：360,107 ms；返回源范围覆盖：360,107 ms。
- 首批结果：30,747 ms；总墙钟：107,854 ms；RTF：0.2995。
- 返回文字项：26；无语音项：0；唯一 item ID：26。
- 模型 revision：`7278e1e70fe206f11671096ffdd38061171dd6e5`，全程一致。
- `contract_validated=true`：每个返回项均通过 schema/contract revision、稳定 ID、稳定 segment key、
  segment revision、`stable` 文本状态、源时间范围、outcome/text 一致性校验。

回放工具现在会在报告前拒绝重复/缺失 ID、时间范围漂移、模型 revision 变化、非法 outcome、未闭合
的稳定段和文字状态不一致；这比此前只统计返回数量的探针更严格。单测
`tools/vnext/test_replay_asr_v2.py` 当前 `8 passed`。

## 边界

这是隔离 CPU 候选的 ASR 合同和吞吐证据，不是生产首段延迟、GPU 资源或 Android 连续投影验收。
仍缺专属 LaoJi 设备的网络/进程恢复、实时 p95、完整视频进入 Facts/Q2、讲话人质量和 capability
barrier；生产 `8030/18020`、公网、GPU1、PCB 和其他服务未修改。

