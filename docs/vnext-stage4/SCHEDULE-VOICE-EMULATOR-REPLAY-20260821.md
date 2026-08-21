# Stage 4 语音日程真实音频回放（2026-08-21）

状态：`bounded preview implemented; two sealed 30-sample reports failed closed; host-audio injector remains unstable; isolated candidate; not adopted`。

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

回放工具随后把录音期间的停止键和关闭键改为录音前缓存的稳定坐标，避免把 `uiautomator dump` 的阻塞
误算成产品延迟。独立单次复验得到采集/首文字/Draft `50/1300/2375ms` 且 App、模拟器均保持运行；同一
RPC 连续三次的第二次仍未形成终态，继续被排除。这进一步确认正式 30 次门的阻断是 Emulator 36.6
虚拟麦克风跨 AudioRecord 会话失效，不是页面定位、服务失败或可以通过重复无效样本绕过的指标。

## 退出门边界

蓝图要求 p95 至少 30 个暖态样本，并在 10 分钟混合负载中同时存在 realtime ASR、上传、导入积压、
日程解析、问答和整理。Stage 4 预检现在只接受封存的 `schedule-voice-performance-v1`，同时校验
`sample_count>=30` 和完整混合负载类；因此上述 5+3 次只证明选定实现值得保留，不关闭正式门。

自然中文质量仍只接受第一方 opt-in、双母语盲审和裁决的 holdout。会议片段、TTS、公开语料和模板扩写
均不能晋级。Stage 4 继续保持未采用。

## 宿主音频 30 次补充回放

随后用临时 PipeWire/PulseAudio null sink 的 monitor 作为 Emulator 宿主麦克风，绕开已确认不稳定的
gRPC `injectAudio` 复用。回放使用开发包 `1.1.48 (156)`、`emulator-5562`、本机 reverse 和隔离
`18030/8031`，未触碰生产数据库、生产 handler 或公网流量。

开始这轮前发现并纠正了一个证据链错误：此前安装的公开配置 APK 的 `assets/app.config` 指向
`https://laoji.cloud`，而候选日志来自本机 reverse 后的 `18030`，两者不能拼成同一次纵向回放。
重新构建时强制重跑 JS bundle task，并验证包内 `apiBase=http://127.0.0.1:28121`、五个候选 flag 和
已安装 APK 哈希一致，之后才计入设备审计。

30 次同一日程 TTS 只用于暖态性能分布，不用于自然语言质量。结果为：

| 指标 | p50 | p95 | 门限 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 按下到采集 | 52ms | 97ms | <=100ms | 通过 |
| 按下到首文字 | 1322ms | 1398ms | <=1500ms | 通过 |
| 停止到 Draft | 2265ms | 3087ms | <=3000ms | 失败 |
| Draft 成功 | 28/30 | - | 30/30 | 失败 |

失败没有被排除：第 19 次收到有效音频和一个转写段，但 Graph 返回
`SCHEDULE_GRAPH_PROVIDER_UNAVAILABLE`；第 27 次 32 帧音频的 peak/RMS 均为 0，属于宿主注入瞬时
失效。第 25 次采集启动为 517ms；另有三个 Draft 样本超过 3 秒。相同规范文本随后直接调用候选 Graph
30 次，30/30 返回 200、来源哈希完全匹配，延迟范围约 1983--2218ms。因此当前证据只能说明：

- 采集与首文字选定实现达到目标；
- Draft 尾延迟和端到端成功率仍未达到退出门；
- 那次 503 需要用每次转写输入指纹继续区分 ASR 变化与模型结构输出，不能笼统归因为网络故障；
- 宿主 monitor 比 gRPC 稳定，但仍不是可忽略失败的正式注入基准。

提交 `05d6183` 的 600 秒全局混合负载已经独立覆盖 realtime ASR、上传、导入积压、日程解析、Q2
和 Summary，报告见 [全局混合负载](../vnext-global/GLOBAL-MIXED-LOAD-20260820.md)。它可以作为语音
envelope 的 mixed-load 旁证，但不能把上述失败的 30 次伪装为通过。

## 1.1.53/1.1.54 严格封存回放

候选随后补齐本机 AudioRecord 确认时间、转写 SHA-256、业务 Draft 合同 SHA-256 和音频时长审计；
`PREPARING` 不再把页面从 recording 切回 preparing，上一会话释放后会补充一次鉴权/WebSocket 预热。
回放工具不再在录音期间反复导出 UIAutomator 树，并用持续零值 keepalive 防止 PipeWire null sink 进入
idle。`1.1.53 (161)` 的 30 次暖态结果为：

| 指标 | 结果 | 门限 | 状态 |
| --- | ---: | ---: | --- |
| Draft 成功 | 30/30 | 30/30 | 通过 |
| 转写/Draft 精确哈希种类 | 1/1 | Draft 1 | 通过 |
| 按下到本机采集 p95 | 104ms | <=100ms | **失败 4ms** |
| 按下到首文字 p95 | 1431ms | <=1500ms | 通过 |
| 停止到 Draft p95 | 2322ms | <=3000ms | 通过 |

该报告完整保留 135ms 和 104ms 两个录音启动离群值，没有改阈值或删除样本，封存文件为
[1.1.53 语音性能报告](SCHEDULE-VOICE-PERFORMANCE-1.1.53-20260821.json)，报告 SHA-256 为
`sha256:47aed0369cbad0318763fc3646486bc448fda0beec9becbdbe664cd03ee1384e`。

对启动路径的检查发现每次按下后仍通过 RN bridge 重查一个已经授予的录音权限。`1.1.54 (162)` 将
权限状态在页面可见/App 恢复时预热，并在权限弹窗后更新缓存；安装后的冷样本仍单独记录为
`101/1513/1895ms`，其后四个暖样本为 51--63ms 采集和 1239--1339ms 首文字。

但 `1.1.54` 正式 30 次不能证明通过：只有 `27/30` 到达 Draft，采集/首文字/Draft p95 为
`882/1977/2722ms`，出现 5 种转写和 4 种 Draft 合同。第 9/22 次的采集启动为 1060/882ms；Android
时间线同时出现 Emulator ranchu Audio HAL `pcm_writei I/O error`、AudioFlinger 线程迟建和系统服务
563ms slow dispatch。第 27/29 次虽然 AudioRecord 正常启动并产出 31/32 帧，但 peak/RMS 为 `2/0`，
证明宿主注入再次整段掉为数字静音。所有失败仍保留在
[1.1.54 语音性能报告](SCHEDULE-VOICE-PERFORMANCE-1.1.54-20260821.json)，报告 SHA-256 为
`sha256:d592ed29209dd42cd6a315df7a410ca20d98613f3b7ebee487decd08b063af6e`。

因此不能把 1.1.54 的长尾全部归因于权限缓存改动，也不能把 Emulator/宿主故障样本从统计中删除。
当前事实是：常规暖路径已稳定在约 40--70ms 采集、1.2--1.4s 首文字，但这套 host monitor 仍不能
提供可靠的 30 次退出证据。下一次正式门必须使用不会在 AudioRecord 会话间丢流的真机/硬件回环，或
先把模拟器 Audio HAL 注入故障独立关闭；在此之前语音门保持 blocked。

为防止“30 个样本但部分失败”仍被误收，新增 `schedule-voice-performance-v1` 封存器；Stage 4 预检
现在除 lineage、样本数、混合负载和三个 p95 外，还强制检查 30/30 Draft 与唯一 Draft 合同。

本轮还暴露并修复了真实 UI bridge 缺陷：`CalendarEditPageView` 在 Expo 的 `ComponentActivity`
context 下会静默丢弃取消/保存等所有 action。候选现在无条件派发 bridge action，并提供只用于测试的
listener/disable 开关；静态门 `verify_calendar_edit_action_bridge.py` 已接入 Stage 4 聚合预检。连续回放
已经证明成功草稿可以退出 AddEvent 并返回日历，而不是依赖坐标误点。

## 可复现工具和回滚

- `tools/vnext/inject_emulator_audio.py`：生成 Emulator gRPC stub 并注入 PCM WAV；小批回放复用单流，
  避免已确认的 Emulator 重开流崩溃。
- `tools/vnext/replay_schedule_voice_emulator.py`：按可访问性标签操作，使用脱敏 audit 统计延迟，成功后
  直接关闭浮层且不写业务数据。
- `tools/vnext/test_schedule_transcript_revision.cjs`：验证 partial/final 同稳定 ID 替换和迟到 partial 围栏。

包含录音启动审计、权限预热和证据封存门的最新候选 APK 已递增为 `1.1.54 (162)`，SHA-256 为
`b5be820474cb27047ce42e7749dbcb27b30784cf50e588695f78b381674ce963`；已覆盖安装到
`emulator-5562`，保留原数据启动成功且没有 crash/blank-screen。它只指向本机 reverse 后的隔离
`18030`，未发布、未安装真机、未切公网。

回滚只需卸载候选 APK、关闭候选 flag 或恢复上一版 `qwen_ws` handler；没有 schema、生产数据库或生产
服务变更。
