# 老记语音文字发布路径审计 2026-08-16

## 状态与边界

- status: `observed; source and production-hash audit; not adopted`
- mobile source: `/home/yydd/LaoJi-worktrees/feishu-source-driven`
- service source: `/home/yydd/LaoJi-service-worktrees/compact-production-v3`
- production mutation/model invocation/private audio access: `none`

本审计区分“服务端已计算文字”“某 API 能读取 draft”“手机当前源码会拉取”和“已发布
APK 实际包含该行为”。这四层不能互相替代。

## 路径矩阵

| 路径 | 服务端文字何时存在 | 当前可见出口 | 结构结论 |
|---|---|---|---|
| 实时会议 | VAD 闭段后，单 worker 等 8030 整段 ASR | CAM++ 聚类和身份识别全部结束后才发 `transcript.completed` | 文字被 speaker 阻塞 |
| 实时日程 | VAD 闭段后，单 worker 等 8030 整段 ASR | 不做 speaker 识别，但初始化仍要求 CAM++ 就绪 | 无 speaker 业务需求仍被支持模型 ready 绑定 |
| 文件导入 device/guest | 每个 ASR batch 后、speaker settle 前写 provisional draft | device transcript GET 可读 draft；dirty 手机源码约 750 ms 拉取 | 服务端已部分增量，APK 是否包含未验证 |
| 文件导入 account | 同样持续写 provisional draft | account `/{meeting_id}/transcripts` 只查 canonical `TranscriptLine` | 账号只能等 final 原子提交 |

### 实时

`qwen_ws.py` 为每个连接建立一个 `segment_queue` 和一个 `segment_worker`。worker 顺序是：

```text
VAD close
  -> 8030 整段 Qwen ASR
  -> CAM++ anonymous cluster embedding
  -> enrolled identity identify
       -> 内部再次 CAM++ embedding
  -> transcript.completed
```

有登记讲话人时，同一音频可能做两次 embedding。文字已经存在后仍要等待二者；stop 又
等待同一 worker drain，所以 `ready_to_stop` 也被 speaker 尾部拖住。

`ModelManager` 把 VAD 和 CAM++ 同列为 required；任一个失败都会抛出
`VAD 或中文声纹模型未能加载`。因此即使日程 purpose 不启用 speaker recognition，也不能
在 CAM++ 不可用时只提供语音转文字。

### 文件导入

`compact_transcription_service.py` 在每个 ASR batch 后先保存 checkpoint，并通过 partial
callback 发布不带 speaker 的行；只有随后才结算 speaker future。它已经证明 text/speaker
可以分离，不能把整个文件 worker 描述为完全串行。

但仍存在四个等待边：

1. speaker backlog 超过上限会阻塞后续 batch；
2. partial callback 同步等待 draft DB commit，最长 15 秒；
3. final text 一定等待全部 speaker future；
4. overlap deduplication 与全局 speaker assignment 后才形成 canonical turns。

device API 能在 job active 时读取 `MeetingRecordingTranscriptDraftV1`；account API 的
`get_app_meeting_transcripts` 只查询 `TranscriptLine`，即使 draft 已存在也不可见。

## 手机与发布边界

当前 dirty 工作树中的 `DeviceMeetingCompletionProvider.tsx` 已把：

- job running 时直接跳过；
- 固定 15 秒轮询；
- 只保存 final

改成 running 时拉 provisional、active 约 750 ms 轮询和 draft/final 区分。该文件仍是
未提交修改，且本轮没有核对候选 APK、公开 APK 或真机安装版本；不得把它写成用户已经
获得连续文字。

该 Provider 只在 `mode === guest` 运行。账号侧 `requestMeetingTranscriptCompletion` 有
多个调用点，但当前树没有 `subscribeMeetingTranscriptCompletion` 的消费方；这只能写成
源码缺口，不能推导线上所有账号任务都不会完成。

## 分句与标点

当前一个 VAD segment 会直接成为一条 transcript 行。会议配置按约 650 ms 静音或最长
4.5 秒强制闭段，每一块独立送入 Qwen；模型容易给每块补句号。服务端虽产生
`segment_reason`，Android parser 没有保留它，UI 无法区分自然句尾与 `max_speech` 强制切块。

因此“少句号”不能只改 silence 参数。source segment 是识别/引用边界，display utterance
应是单独的确定性投影；它可把连续的强制时长块显示为一段，但不能改写 source IDs、时间
或引用。任何去标点规则都必须只作用于 display projection，不能污染 canonical evidence。

## 下一候选边界

保留当前 Qwen/8030、VAD、录音、鉴权和资产 owner，建立窄 M1-T：

- text lane 在 ASR 后立即发布 unknown speaker；
- speaker lane 复用同一个 embedding，迟到 patch；
- text closed 不等待 speaker closed；
- account 与 device 从同一个 draft/final projection 读取；
- transcript cursor 直接驱动可读文字，task status 只表达错误/恢复；
- source segment 与 display utterance 分离；
- CAM++ 不再是 schedule/text lane ready 的硬依赖。

首次候选只证明结构等待边删除和协议/repository 映射；不换 Provider、不改生产、不声称
CER、DER 或用户延迟达标。完整 streaming Provider 只有在该边界用当前 Qwen 通过后才做
同 PCM 换槽对照。

## 测量合同

用公开 CAM++ 示例 WAV 构造短句、1 分钟和 30 分钟非私人样本；实时回放按 20 ms PCM
等速发送。只记录 trace/segment、音频长度、文字长度/hash 和单调时钟：

`capture -> vad_emit -> provider_enqueue/start/end -> text_emit -> draft_commit -> client_observe`

speaker 独立记录 `enqueue/start/end/patch`。分别报告：

- 首个 partial/stable/final；
- 文件首 draft、text closed、speaker closed；
- text 在总任务 25%/50%/75% 时的可见比例；
- 1/2/4 并发的 queue、GPU、CPU、RSS；
- speaker 慢、DB 慢、断线和重启。

当前 C0 没有 partial，必须如实记为 `N/A`。预注册阈值不是通过证据：partial p95
不高于 1.5 秒、stable p95 不高于 2 秒；质量还需 CER、关键术语和 DER 单独通过。

