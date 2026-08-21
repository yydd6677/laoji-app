# Stage 4 语音日程真实音频回放（2026-08-21）

状态：`bounded preview implemented; preliminary latency evidence; formal 30-sample/mixed-load gate open; isolated candidate; not adopted`。

## 边界

- 设备只使用 LaoJi 专属 `emulator-5562`；有效回放对应候选 APK `1.1.44 (152)` 和隔离 API
  `127.0.0.1:18030`。
- 第一组音频来自现有真实会议视频的 6 秒中文讲话片段；它不是日程表达，只能验证采集和首文字延迟。
- 第二组是临时 TTS 生成的“明天下午三点半到五点开项目复盘会”，只用于完整 Draft 性能和替换协议，
  不是自然日程质量证据，也不进入 holdout。
- 生产 `18020/8030` 的进程、配置和公网流量没有改变。候选复用 8030 已常驻的同一 Qwen3-ASR revision，
  不启动第二个 ASR 模型，不触碰 GPU1、PCB 或其他服务。

## 实现

旧路径必须等 VAD 闭段后才调用 ASR，真实会议片段的 5 次基线首文字 p95 为 `9256ms`。候选保留同一
VAD 和 final 闭段合同，只为日程语音增加只读快照预览：

- 有效讲话达到 `640ms` 后允许首个 snapshot，此后间隔至少 `1600ms`；
- 同一时刻最多一个 preview 在途，单会话硬上限为 4 次；
- preview 和 final 使用相同 `revision_key=schedule:<start_ms>`，Android/TypeScript 按稳定 ID 原位替换；
- final 永远是权威结果，迟到 partial 不得覆盖 final；partial 不持久化；
- preview 失败不发终态错误、不污染 final；最终 VAD 静音阈值和会议 ASR 分段均未缩短。

这不是模型级增量解码，也不伪称“真正 streaming decoder”；它是同一 ASR owner 内有界、可替换的
低延迟预览，不增加第三 owner、fallback 或常驻资源。

## 有效结果

真实会议讲话片段的 5 次结果见
[SCHEDULE-VOICE-PREVIEW-REAL-AUDIO-5RUN-20260821.json](SCHEDULE-VOICE-PREVIEW-REAL-AUDIO-5RUN-20260821.json)：

| 指标 | p50 | p95 | 目标 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 按下到本机采集开始 | 42 ms | 43 ms | <=100 ms | 5 次初步通过 |
| 按下到首个转写文字 | 1298 ms | 1490 ms | <=1500 ms | 5 次初步通过 |

节拍正确的完整日程 TTS 3 次结果见
[SCHEDULE-VOICE-PREVIEW-SCHEDULE-3RUN-20260821.json](SCHEDULE-VOICE-PREVIEW-SCHEDULE-3RUN-20260821.json)：

| 指标 | p50 | p95 | 目标 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 按下到本机采集开始 | 40 ms | 43 ms | <=100 ms | 3/3 初步通过 |
| 按下到首个转写文字 | 1272 ms | 1481 ms | <=1500 ms | 3/3 初步通过 |
| 停止到 Draft | 2320 ms | 2513 ms | <=3000 ms | 3/3 初步通过 |

回放后直接关闭语音浮层，不进入 AddEvent，不保存日程。测试工具曾因缓存同名“取消”坐标误入详情并
保存两条隔离测试日程；两条均已通过正常 UI 删除，工具现只缓存页面内位置不变的无歧义控件。

## 未计入的 30 次尝试

Android Emulator 36.6.11 的虚拟麦克风存在工具级限制：

- 一个 gRPC 音频流跨多次 AudioRecord 会话复用时，后续任务可被接收成全静音或截断；服务端脱敏日志
  显示过 `86` 帧、`137600` 字节但有效语音观察为 `0`，因此这些不是产品质量样本；
- 改为每次录音独立 `injectAudio` RPC 又在约第 5 次稳定触发 Emulator 的
  `AudioStreamCapturer` SIGSEGV，崩溃的是模拟器进程，不是老记 App。

两批无效尝试均被排除，未写入机器证据，也不据此判定产品通过或失败。工具恢复为不反复开关 RPC 的
持久流版本，供单次/小批 smoke 使用；正式性能门仍需另一条可靠音频注入方式或真机完成。

## 退出门边界

蓝图要求 p95 至少 30 个暖态样本，并在 10 分钟混合负载中同时存在 realtime ASR、上传、导入积压、
日程解析、问答和整理。Stage 4 预检现在只接受封存的 `schedule-voice-performance-v1`，同时校验
`sample_count>=30` 和完整混合负载类；因此上述 5+3 次只证明选定实现值得保留，不关闭正式门。

自然中文质量仍只接受第一方 opt-in、双母语盲审和裁决的 holdout。会议片段、TTS、公开语料和模板扩写
均不能晋级。Stage 4 继续保持未采用。

## 可复现工具和回滚

- `tools/vnext/inject_emulator_audio.py`：生成 Emulator gRPC stub 并注入 PCM WAV；小批回放复用单流，
  避免已确认的 Emulator 重开流崩溃。
- `tools/vnext/replay_schedule_voice_emulator.py`：按可访问性标签操作，使用脱敏 audit 统计延迟，成功后
  直接关闭浮层且不写业务数据。
- `tools/vnext/test_schedule_transcript_revision.cjs`：验证 partial/final 同稳定 ID 替换和迟到 partial 围栏。

包含上述实现和隐私安全失败分类的候选 APK 已递增为 `1.1.45 (153)`，大小 `82616399` bytes，
SHA-256 为 `b45617219d84c55a4286cc71acb5ee9a27257ccbc89e2ae4ec24d366dd93a906`；已覆盖安装到重启后的
`emulator-5562`，保留原数据启动成功且没有 crash/blank-screen。它只指向本机 reverse 后的隔离
`18030`，未发布、未安装真机、未切公网。

回滚只需卸载候选 APK、关闭候选 flag 或恢复上一版 `qwen_ws` handler；没有 schema、生产数据库或生产
服务变更。
