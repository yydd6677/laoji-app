# Stage 2 候选 ASR RTF 回放

状态：`candidate evidence; Stage 2 exit still blocked`。

隔离 `8031` 使用 Qwen3-ASR-1.7B CPU 对真实 `restart-60s.mp4` 进行 10 次完整 v2 batch
回放。每次将媒体解码为 5 个 14 秒 PCM 项，服务端合同校验、稳定 ID、源时间范围和
`text/no_speech` 状态全部通过。

- RTF p50：`0.46055`
- RTF p95：`0.4729`，低于 Stage 2 的 `0.5` 门
- 每次 5/5 项均返回文字，模型 revision 固定
- 证据：`asr-v2-r2f-60s-20260819.json`

该探针把 60 秒放入一批，所以首个 HTTP 结果 p95 为 `28378ms`；这不是实际导入管线的
VAD 12 秒 flush，也不作为 `first_segment_p95_ms <= 8000` 的通过证据。真实手机、R2
导入、VAD flush 和首段端到端计时仍需专属 Android 设备回放。
