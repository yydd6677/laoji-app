# 候选 0017：语音增量 Artifact Flow 合同证据

## 范围

- 候选目录：`/home/yydd/LaoJi-candidates/speech-artifact-flow-0002`
- 状态：`candidate contract validated in isolation`; **not adopted**
- 未修改或重启生产服务，未读取录音、笔记或转写正文，未安装模型或依赖。
- 本证据只验证事件身份、状态单调性、乱序恢复、独立讲话人补丁和等待边的
  确定性合同，不验证 ASR/CAM++ 质量、真实延迟、GPU 资源或移动端体验。

## 本轮核对的现状

### 实时路径

`qwen_ws.py` 的每个 WebSocket 只有一个 `segment_worker`。一个片段先完成 Qwen
转写，再在发送 `transcript.completed` 前做讲话人处理：

- `extractor.extract(audio)` 先为匿名聚类提取 embedding；
- `_identify(speaker_engine, audio)` 又把原始音频交给识别引擎；识别引擎内部再次
  使用同一 extractor（`enhanced_engine.py:352-367`）；
- 讲话人投票完成后才发送文字。

源码边界：

- `/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend/app/api/qwen_ws.py:445-529`
- `/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend/app/api/qwen_ws.py:545-553`
- `/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend/app/asr/enhanced_engine.py:352-367`

因此当前实时等待图不是“ASR 与 CAM++ 并行”，而是：

```text
VAD close -> Qwen ASR -> CAM++ cluster -> CAM++ identify -> transcript.completed
```

这既让文字等待讲话人，又让有登记讲话人的片段重复提取 embedding。

### 离线导入

离线路径已经比实时路径更接近目标：CAM++ future 与 ASR batch 有有限重叠，ASR
每批完成后也会调用 partial callback。不能再把它描述成完全串行。但它仍在积压
超过阈值时等待 speaker future，并在全部片段完成后统一 `_assign_speakers()`、生成
final：

- `compact_transcription_service.py:740-833`
- `compact_transcription_service.py:844-905`

### 移动端投影

- Native parser 虽接受 `partial/delta/completed`，其 transcript identity 包含文字
  正文；同一片段文字变化会产生新身份，无法表达稳定 revision/watermark：
  `AudioProtocol.kt:270-304`。
- 导入草稿依赖 `DeviceMeetingCompletionProvider` 最快 750 ms 轮询，并按整份 items
  数组保存本地投影：`DeviceMeetingCompletionProvider.tsx:18-20,115-171,193-200`。

## 现场一致性

2026-08-16 08:29 Asia/Shanghai 对生产服务器做了第二次只读核对：

- `laoji-api`、`laoji-asr`、`laoji-ollama` 是 system unit，均为
  `active/running`；`systemctl --user` 会错误显示 inactive，后续审计不得混用作用域。
- API/ASR/Ollama cwd 分别为 compact-production backend、compact-production
  backend、compact-production。
- 18020 与 8030 都报告 ready；ASR 队列深度为 0，最近记录仍是历史 offline batch
  3、queue 12 ms、infer 587 ms，不能当作 p95。
- GPU0 使用 29558 MiB、空闲 2554 MiB；GPU1 只读观察且明确不操作。
- 部署中的 `qwen_ws.py`、`compact_transcription_service.py`、8030 `server.py` 与本地
  对应源码 SHA-256 完全一致：
  `49133d9b...`、`7d884407...`、`00bfad570...`。

## 候选合同

0002 原型把一个 VAD 闭段表示为不可变 `SegmentArtifact`，ASR 与 speaker 分支只引用
该身份：

```text
immutable segment artifact
  +-> bounded ASR branch -> partial/stable/final TranscriptRevision
  +-> bounded speaker branch -> one EmbeddingArtifact -> SpeakerPatch
                              \-> one local ProjectionReducer
```

合同包含：

1. `source_id + segment_id + artifact_revision + source range` 不可变。
2. transcript revision 只增不减；maturity 只能
   `partial -> stable -> final`；stable prefix 不得重写。
3. final 不换 segment identity，也不能被更高 revision 静默改写。
4. 每个 artifact 只接受一个 immutable embedding；聚类和登记声纹匹配必须复用它。
5. `SpeakerPatch` 可先于或晚于文字、可重复回放，但不能修改文字。
6. ASR 与 speaker 各有有界队列；speaker 满载只丢弃或延后增强，不占 ASR 容量。
7. 取消同时清空两条分支，取消后的迟到事件被拒绝。
8. 等待边独立记录；计算文字可见延迟不要求存在 `speaker_emit`。
9. reducer 可序列化恢复，重复、旧 revision 和跨来源事件不会覆盖当前结果。
10. stable prefix 以 Unicode scalar value/code point 计数；不做隐式 Unicode
    normalization，并拒绝孤立 surrogate。

## 验证结果

命令：

```bash
cd /home/yydd/LaoJi-candidates/speech-artifact-flow-0002
python3 -m unittest discover -s tests -v
```

结果：Python `27/27 passed`；共享 Unicode fixture 在 Node 24 与 Kotlin/JVM
2.1.20/JDK 21 上均为 `7/7`，三端另各自验证孤立 surrogate 被拒绝。

覆盖：artifact 身份冲突、partial/stable/final、旧事件、同 revision 冲突、stable
前缀改写、final 关闭、单次 embedding、讲话人早到/迟到/重放、跨来源、乱序显示、
重启恢复、取消、两条有界队列、独立等待边、source/range 派生且与 job 无关的
36 字符 segment identity、不输出正文的跨平台 C0 PCM 回放客户端，以及中文、emoji、
组合字符、ZWJ 序列、suffix 修订和 normalization 差异的跨语言前缀合同。

资产 SHA-256：

- `README.md`: `6da06c77601c0938a9e2b27a37ace75ba05f3635429e17420b3ec7dc114e3415`
- `artifact_flow.py`: `7de1591845a852ad75fbba797763219593da613e3aa44bf53a092d8fc78ac654`
- `contract_errors.py`: `3b22bda2124baee35127eee992d25f52554054c89c866892032ceca3e6563024`
- `c0_replay.py`: `b0595c873b1aa35e32b35dbb65f0eade6d130c80e8e6467f054b8113df619556`
- `unicode_contract.py`: `9517df437a4797f191138df946f65938843403bbb8021f98ee3519560af5f6cc`
- `unicode_contract.ts`: `7c3ec419ed5e37877e89883b06d8438559dee3b2e3cd7760b94da81e195a36b8`
- `UnicodeContract.kt`: `e70a26f344f315dc90377675c76730774feec35c5a522b431850cdb34808e9d3`
- `unicode_watermark_fixture.tsv`: `beafea05b0fa83745dbf9a12eb395a0551f0f8b890994fe3b92f42737b4e632e`
- `tests/test_artifact_flow.py`: `13ef2b0c08fa0764dede8ccf3e0ea3e5657d6c6e04d81e0db418b1ac82499dfe`
- `tests/test_c0_replay.py`: `d7517523d9b1e5edc695c38e494d3ea4948c3bc362c631dac631a6a47258d734`
- `tests/test_unicode_contract.py`: `91fdf7ad733414105df2c4a09436bdc06616a9a3ef72f3c3e4451566321fa662`

### C0 暖态窄回放

为避免接触用户会议，只使用生产目录中 CAM++ 模型自带的三段中文示例 WAV，管道
转换为 16 kHz PCM 后调用当前 8030 `/asr?priority=realtime`。没有写临时音频、没有
保存或展示识别正文；只保留长度和时间指标：

| 样本 | 音频 | queue | inference | SSH 内端到端 |
|---|---:|---:|---:|---:|
| speaker1_a | 3715 ms | 12 ms | 578 ms | 692 ms |
| speaker1_b | 4907 ms | 12 ms | 383 ms | 489 ms |
| speaker2_a | 5312 ms | 12 ms | 313 ms | 419 ms |

这三次只证明当前 Qwen 8030 在空队列、暖态、短而干净的模型示例上，单次推理不是
数秒级尾部。它们不经过实时 VAD、WebSocket、CAM++、持久化或 Android，不能代表
首字延迟、p50/p95、会议噪声质量或用户感知。冻结期间不重启模型，所以没有 cold
结果。当前实时文字仍至少要额外等待 VAD 闭段和两次 CAM++ 提取路径。

## C0 / M1 / G1 当前判断

| 路线 | 本轮结论 |
|---|---|
| C0 继续维护 | 唯一生产可用 provider；保留为回滚和真实基线，但当前协议无法提供 stable watermark，实时文字被讲话人阻塞。 |
| M1 最小有界流水线 | 协议合同已在隔离中通过；不增加常驻模型即可先消除重复 embedding 和讲话人等待边，是下一实现候选。尚未证明真实速度和质量。 |
| G1 provider 替换 | Qwen vLLM streaming / Paraformer 仍只做同 PCM 回放候选。当前显存和依赖不支持直接常驻第二 provider，不能预设其胜出。 |

这不是采用 M1 的决定。它只说明 M1 已经具有比 0001 watermark 更完整、可被真实
回放证伪的边界；模型/provider 的选择仍开放。

## 下一门禁

1. 在隔离副本中加入 `capture/vad_emit/provider_enqueue/provider_start/provider_end/
   transcript_emit/speaker_emit` 单调时钟，不改生产服务。
2. 选取同一组脱敏 PCM，先回放 C0，分解 VAD 等待、8030 队列、推理、重复
   embedding、发送和客户端观察延迟；至少 3 次 warm、1 次 cold。
3. 串行加载候选 provider 做同 PCM 对照，避免把两个 ASR 同时常驻造成的显存竞争
   误当成 provider 性能。
4. Android adapter 必须用服务端 `segment_id/revision/maturity`，不得继续用文字正文
   派生 identity；先做离线协议 fixture 和断线/乱序恢复，再接 UI。
5. 用真实中文样本报告 CER/关键字段 exact-match、稳定前缀回滚率、讲话人 DER、
   首个 partial/stable/final p50/p95、资源峰值。没有这些证据不得修改生产路由。
