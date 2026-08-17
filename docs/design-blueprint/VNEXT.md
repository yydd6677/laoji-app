# 老记 vNext 全局架构基线

- status: `global development baseline; frozen for implementation`
- baseline release: `1.1.10 (118)`
- architecture revision: `vnext-1`
- scope: Android/React Native 客户端、`laoji-api`、`laoji-asr`、Ollama、R2
- excluded systems: GPU1、PCB、Smart Meeting 及同机其他用户服务
- production mutation during design: `none`

本文是老记下一阶段开发的唯一架构入口。历史蓝图、研究和候选只提供证据；与本文冲突时，
除非用户形成更新的明确决定，否则以本文为准。

## 1. 产品边界

老记是本地优先的中文日程与会议记忆工具。手机拥有用户业务数据；服务器只执行需要模型或
公网能力的短期任务；R2 只保存可回收的处理对象。vNext 保留 1.1.10 的用户能力，但不保留
账号同步、多套 owner、重复规则、样本补丁和串行模型调用等实现。

不可退化的用户结果：

- 日程可离线增删改查，文字和语音输入最终形成可确认草稿；
- 实时录音和导入媒体先在本机可见，网络失败不丢失原始资产；
- 文字记录尽早连续出现，讲话人结果可稍后增强且可人工修正；
- 整理、行动候选和问答引用可回到原始文字、笔记或授权附件；
- 标签、搜索、列表顺序、回收站、分享、主题和版本更新继续可用；
- 重新生成、重试、取消、页面重进和进程重启不得制造第二份当前真相。

### 1.1 当前能力覆盖

| 当前能力 | vNext 去向 |
| --- | --- |
| 日/周/月视图、日期跳转、搜索、重复日程、提醒、地点 | 本地 ScheduleRepository；视图和编辑能力保留 |
| 语音/文字新建、澄清、修改、删除日程 | Mention Graph 唯一合同；最终写入仍在本机 |
| 通知、即将开始提醒、桌面小组件和系统入口 | RETAINED；只读本机日程投影，不接远端数据 owner |
| 实时录音、暂停/继续、后台恢复 | native recorder + app-private MediaAsset；流程保留 |
| 音频/视频导入、音频提取、上传恢复 | MediaAsset generation + WorkManager/R2 |
| 播放、倍速、搜索、时间跳转、音频片段 | 本地 Transcript/MediaAsset；片段是本地派生资产 |
| 标记、附件、我的笔记、会议系列 | 本地 meeting aggregate；以 immutable SourceRef revision 参与生成 |
| 讲话人登记、匹配、人工修正、撤销 | 手机拥有登记/撤销；服务端只缓存加密 embedding，不留样本音频 |
| 整理、行动候选、四模板、编辑、版本历史 | Facts V3 + 本地投影/覆盖层；候选不覆盖既有 ActionItem |
| 本场待办：手动新建/编辑、负责人、截止、完成/删除、提醒、后续日程 | 本机 ActionItem 聚合；系统通知为可重建投影 |
| 会议问答、追问、引用跳转 | Q2 + 本地 thread/turn/citation |
| 标签、人物派生查看、列表手动排序、搜索、回收站 | 显式标签与本地 FTS；人物只来自 speaker overlay，不成为分类 owner |
| Markdown/文件/公开链接分享 | 本地默认；公开 artifact 明确授权、TTL、可撤销 |
| 标准蓝/绚彩、设置、帮助、隐私文书、应用锁 | RETAINED；统一 token 和 ProjectionEnvelope |
| 自动检查更新、下载和校验安装 | RETAINED；继续公开 manifest/hash/size 合同 |

## 2. 全局决策矩阵

| 领域 | 状态 | vNext 决策 |
| --- | --- | --- |
| 本机数据、设备、隐私、删除 | SELECTED | 手机 SQLite 是唯一业务真相；设备身份只授权远端任务；删除本机提交、远端异步清理 |
| 日程文字/语音解析 | STAGED | `ScheduleMentionGraph -> Validator -> Draft` 唯一合同；本机快速 producer，复杂输入只调用服务端模型 producer |
| 实时录音、导入、上传 | STAGED | 原始资产本机先落盘；原生 WorkManager 直传 R2；服务端 staging 校验后原子激活 |
| ASR 与讲话人 | SELECTED | VAD 后 ASR 与 CAM++ 分队列；文字优先发布，讲话人以可撤销 overlay 迟到更新 |
| Transcript、搜索、播放、笔记、附件 | SELECTED | 不可变 TranscriptRevision + 稳定 segment ID + 独立人工 overlay；本地 FTS5 搜索 |
| 整理、行动、模板、编辑 | SELECTED | MeetingFacts V3；候选只提供来源，本场待办由本机 ActionItem 聚合拥有；模板和编辑只在本地投影 |
| 会议问答 | SELECTED | Q2 单次 attributed reader；原始来源引用；无验证/编辑/恢复第二次模型调用 |
| 标签、分类、回收站、分享、更新 | RETAINED | 保留用户流程；数据全部本地权威；分类只按显式标签；当前更新校验合同继续使用 |
| 页面状态与 JS/native 投影 | STAGED | JS repository 拥有持久业务状态；native 拥有系统能力运行态和 surface 瞬时态；跨边界都带 revision envelope |
| Provider、任务、资源与可观察性 | SELECTED | 3 个业务进程；一个最小任务/attempt owner；领域 API 保持独立；禁止通用 DAG 拥有业务状态 |

`STAGED` 不表示路线待选。它表示目标结构已确定，但 vNext 第一阶段保留一个有期限的旧接口
适配器；适配器删除条件见实施文档。

## 3. 端到端拓扑

```text
Android / React Native
  Local SQLite + app-private media
      |-- schedule/events/tags/trash are local-only
      |-- immutable meeting/transcript/summary/question revisions
      |-- device_operations records remote intent, never business truth
      |
      +-- HTTPS/WSS: laoji.cloud
             |
       Cloudflare Tunnel
             |
       laoji-api 127.0.0.1:18020
          |-- device auth + domain APIs
          |-- SQLite task/attempt/artifact/upload/cleanup ledger
          |-- ffmpeg/VAD/CAM++ orchestration
          |-- provider admission and telemetry
          |
          +-- laoji-asr 127.0.0.1:8030  (Qwen3-ASR-1.7B)
          +-- Ollama 127.0.0.1:21434    (qwen3.5:9b GPU + 0.6B embedding CPU/on-demand)
          +-- Cloudflare R2             (staging audio, lifecycle deletion)
```

公网只暴露 `laoji.cloud`。`18020/8030/21434` 仅 loopback。客户端不保存模型端口、不选择
provider，也不直接接触 R2 长期凭据。

## 4. 唯一数据所有权

| 数据 | 权威所有者 | 服务器/R2 允许内容 | 删除语义 |
| --- | --- | --- | --- |
| 日程、重复规则、颜色类型 | 手机 SQLite | 复杂解析的加密临时输入和 Draft 输出 | 本机事务立即生效；临时载荷随任务删除 |
| 会议元数据、标签、顺序、回收站 | 手机 SQLite | opaque meeting binding、任务 revision/hash | 本机 soft delete；30 天或用户永久删除后清理 |
| 原始录音/导入音频 | 手机 app-private storage | R2 staging object，处理所需 TTL 内存在 | 用户删除前本机保留；R2 成功后 24 小时内清除 |
| Transcript | 手机不可变 revision | 任务期加密来源；可选保留生成 artifact | 新 revision 原子激活；旧 revision 保留到本机清理策略 |
| 讲话人自动结果 | 手机 speaker overlay | CAM++ embedding/cluster 仅任务期存在 | 可重新生成；不能覆盖人工 overlay |
| 声纹登记 | 手机登记状态和撤销 revision | 服务端可保存 device/epoch scoped 加密 embedding；不保存样本音频 | 手机撤销立即升 revision；服务端缓存异步删除且旧 revision 禁止匹配；orphan epoch 90 天无 token 活动后清理 |
| 人工讲话人修正、笔记、附件 | 手机 SQLite/私有文件 | 明确请求时的加密临时来源 | 本机删除权威；服务端载荷立即撤销并 TTL 清理 |
| 整理事实、行动候选、用户编辑 | 手机版本表 | 可选保留生成 artifact，不是用户真相 | 新版本不覆盖旧编辑；用户可删除本机版本 |
| 本场待办、负责人、截止与提醒 | 手机 `action_items` 聚合；系统通知仅是派生投影 | 生成时可返回带来源的候选，不保存可变待办副本 | 候选经用户采用后创建本机待办；编辑、完成、删除和提醒均以本机 revision 为准 |
| 问答历史与引用 | 手机 Q2 thread/turn/citation 表 | 可选保留当前请求结果用于恢复 | pending turn 可恢复；同 request replay；删除会议时随本机聚合删除 |
| 上传/任务执行状态 | 服务端任务 ledger | task、attempt、hash、计时、错误码 | 终态按 TTL 清理；手机只保存最后投影和 remote ID |
| R2 清理义务 | 服务端 cleanup ledger | opaque object key、upload ID、过期时间 | 不随会议级联删除；确认 HEAD 不存在后终结 |
| 公开分享 | 手机拥有分享选择；服务端持有 device/epoch/binding scoped 高熵 capability 与加密 payload | 明确选择的 Markdown/附件/音频，默认 TTL 7 天、上限 30 天 | 设备可撤销；binding/epoch purge 先 fence public read，再删 payload/R2，确认前 purge 不完成 |

服务器日志禁止正文、引用、问题、答案、会议标题、人物、文件名、坐标和 R2 key。日志只保存
capability、traffic class、revision、字节数、hash 前缀、阶段、耗时和错误码。

## 5. 共享合同，非共享业务

vNext 只共享五个技术合同：

1. `EntityRevision`：`device_epoch + entity_id + revision + content_sha256`。
2. `SourceRef`：来源类型、稳定 ID、revision、正文 hash、精确 UTF-8 范围。
3. `TaskAttempt`：task、attempt、lease、幂等根、取消 revision、provider request ID。
4. `ProjectionEnvelope`：entity revision、view revision、surface instance 和 payload hash。
5. `ContentOutcome`：服务正确完成但无普通 artifact 或受证据限制的 typed success。

日程 Draft、上传 session、Transcript、MeetingFacts 和 AnswerEnvelope 保持领域类型，不进入一个
通用 JSON 业务模型。共享 owner 只拥有排队、attempt、取消、恢复和终态提交，不拥有领域内容。

### 5.1 设备身份、会议绑定与来源传输

- App 在 Android Keystore 生成不可导出的 P-256 设备密钥。首次登记是公开匿名注册，不把共享 secret
  放入 APK，也不声称 challenge 能证明“官方客户端”。60 秒单次 challenge、设备签名、按 IP/全局
  注册配额和自适应 proof-of-work 只用于防重放与资源滥用；新设备不能读取任何既有 device/epoch 数据。
  后续用 auth challenge + 设备签名换取绑定 device/epoch/key/token revision 的 15 分钟 bearer；密钥
  轮换要求当前 bearer 与旧/新密钥双签名，私钥丢失时创建新 device/epoch，不伪造旧身份。epoch 登记时
  同时注册只可清理该 epoch 的 purge capability，供离线清除后删除日程任务、声纹缓存和会议任务。
- 认证挑战端点不要求已有 bearer：`bootstrap/challenges`、`bootstrap/complete`、`auth/challenges` 和
  `auth/tokens` 只接受一次性 challenge、所需设备签名、注册 proof-of-work/配额（仅 bootstrap）、
  设备/IP 限流和单次消费；`auth/keys/rotate` 要求当前 bearer 与旧/新密钥双签名。其它 HTTP/WSS
  端点均要求与 device/epoch/revision 匹配的有效 bearer。额外例外只有下述单用途 purge capability 与
  第 11 节公开分享 redeem；二者权限互不复用，均不能列举 binding 或创建任务。
- 本机创建会议时同时生成随机 UUID v4 `binding_id` 和随机 128-bit `binding_generation`；同一
  device epoch 内 generation 永不复用，并在本机事务分配单调 `binding_epoch_seq`；服务端不得生成、
  推断或替换它。`binding_revision` 从 1 开始，
  是单调 64-bit binding 状态栅栏；`cancel_revision` 从 0 开始，只在 binding 级取消或 purge 前递增。
  删除后的 generation 只能作为 tombstone，同一 `binding_id` 不得重新创建。所有上传、转写、整理和
  问答必须显式引用并校验 active binding 的 generation、binding revision 与 cancel revision。native 在
  epoch/binding 提交前先生成并持久化 256-bit purge secret，只把 capability ID 与 secret hash 发给服务端；
  因而响应丢失可用同 request/hash 幂等重放。凭据不进入 JS、业务 SQLite 或普通 SecureStore；本机
  离线清除后它只可继续执行对应 epoch 或 binding generation 的远端清理。
- 移入回收站只改本机；永久删除或 30 天到期先持久本机 purge intent，再 fence binding/task，并由
  canonical `PurgeJournal -> PurgeObligation` 幂等清理 generic/legacy task store、payload、artifact、
  share、upload 和 R2。确认清理并超过所有迟到凭据窗口后，binding tombstone 压缩到 epoch 的
  `last_binding_seq` high-water；旧 seq 永远拒绝，避免逐 binding tombstone 无界保留。跨库清理只能由
  同一 purge ID 推进，不能用“已发出删除请求”冒充完成。
- 整理和问答的 Transcript、当前笔记及本次授权附件只通过 HTTPS `GenerationSourceEnvelopeV1`
  source stream 合同传输。短会一个 chapter；长会按确定性章节顺序上传、验证、生成 checkpoint 并
  立即删除已消费正文，不在任务创建前暂存整场。单 bundle 上限 16 MiB，单 chapter group 上限
  128 MiB；per-device/global outstanding bytes 与 group 数在创建时原子预留。整体 fingerprint 绑定
  分页章节清单并用滚动 Merkle accumulator 收敛，不设总章节数上限；每页和同时未消费页/stream
  均有配额。每项带 immutable revision/locator/hash；图片先在本机形成带 hash 的提取文本，否则明确
  排除。服务端 AES-256-GCM 暂存，成功、永久失败、取消立即删除，最长 TTL 24 小时；不得从旧服务器
  mirror、summary 或历史 answer 重新装配来源。协议限制 descriptor/并发驻留量，不设置会议时长拒绝门。

### 5.2 能力合同矩阵

| 能力 | 输入与输出 | 版本/幂等根 | 取消与恢复 | 主要错误/内容结果 |
| --- | --- | --- | --- | --- |
| 文字日程 | text + time context -> MentionGraph -> Draft | text hash + context + graph/producer revision | 本地同步；远端 producer 可取消，同 request replay graph | OOD、需要澄清、模型不可用、输入过期 |
| 语音日程 | buffered PCM -> partial/final text -> 同一日程合同 | voice session + audio chunk sequence + ASR revision | 本地缓冲补发；断线从最后 ack sequence 恢复 | 麦克风拒绝、网络离线、ASR busy；NO_SPEECH 为内容结果 |
| 媒体上传 | MediaAsset generation -> verified remote asset | device epoch + asset + generation + size/hash | WorkManager/server probe 续传；取消后 cleanup obligation | STORAGE_LOW、UPLOAD_EXPIRED、OBJECT_VERIFY_FAILED |
| 实时/导入 ASR | stable audio ranges -> text segment patches/final revision | asset generation + source ranges + ASR model revision | 段检查点恢复；取消不删除已提交稳定段 | decode/provider 错误；NO_SPEECH 为零段 final 成功结果 |
| 讲话人 | VAD ranges + scoped voiceprints -> speaker overlay | transcript revision + CAM++/profile revisions | 独立任务恢复；撤销 profile fences late result | unknown/low-confidence 是匿名结果，不是失败 |
| 整理 | source manifest + encrypted sources -> Facts V3 | source fingerprint + schema/prompt/model revisions | pack/章检查点；取消保留上一结果；失败 pack 自动新 attempt | protocol/input 错误；EVIDENCE_INCOMPLETE 为 limited 结果 |
| 行动候选 | Facts V3 action facts -> provenance candidates | summary version + fact/source IDs | 随 summary 原子保存；采用后创建独立 ActionItem | negated/completed/broad 作为低适配或不显示 |
| 本场待办 | candidate/manual/marker -> ActionItem -> optional schedule | action ID + revision + provenance | 本机 CAS 编辑、完成、删除；通知从待办重建 | 负责人/期限可空；提醒权限或过期是可操作结果 |
| 会议问答 | authoritative snapshot + question + prior refs -> cited answer | snapshot/view/question/task/attempt/provider revisions | 同 task replay；自动重试新 attempt，用户重试新 task；拒绝 late commit | citation/provider 错误；未提及/无法确认是内容结果 |
| 分享 | local projection + explicit selection -> file/token | content hash + share revision + TTL | token 可撤销；本地文件不依赖服务端恢复 | unsupported format、expired/revoked token |
| 更新 | public manifest -> verified APK install | versionCode + APK SHA-256 + size | 下载可重试；安装由系统确认 | manifest、network、hash、signature/version mismatch |

所有网络能力用互斥的 typed ErrorEnvelope 或 ContentOutcome；客户端不根据中文 message 决定重试、
覆盖或状态跃迁。

### 5.3 Task、Attempt 与 ContentOutcome

Task 拥有不可变 logical generation 和唯一终态结果；Attempt 只拥有一次租约执行。Task 状态固定为
`active/success/failure/cancelled`。Attempt canonical state 只允许
`queued/running/succeeded/retryable_failure/terminal_failure/cancelled/lease_expired`，执行 phase 只允许
`queued/admitted/running/committing`；schema、数据库、API 和移动端投影不得再定义近义枚举。重试
时间字段统一为 `next_retry_at`。

每个 Task 总计最多 3 个 Attempt（初次 + 最多 2 次自动重试），退避固定为 `5s/30s`；不设第三个
自动退避或 generic `retry_wait` 状态。自动重试只增加 Attempt。用户对 terminal `failure`
执行 retry，或对 terminal `success` artifact 执行 regenerate，都创建带 predecessor 的新 Task generation；
失败重试只走 `POST retry`，成功结果重新生成只走 `POST regenerate`，active Task 返回 409，旧 Task
永不复活。客户端为每次 original/retry/regenerate 生成新的 `generation_id`；同 generation 的网络重放
收敛到原 Task，同 request ID/hash 只读 replay，同 ID 不同 hash 返回 409。worker publication 必须同时 CAS current attempt、
lease/cancel revision、active epoch、binding generation 与 generation revision。

Task 的 result envelope 是终态 replay 的唯一 owner。`result_kind=artifact` 时只引用不可变 artifact
locator；`result_kind=content_outcome` 时保存 ContentOutcome。`generated_artifacts` 只是 locator 与
完整性索引，不得再保存 result kind、outcome 或承担 replay 决策。

`ContentOutcome` 只表示 Task 成功但没有普通 artifact 或受证据限制，唯一代码为 `NO_SPEECH`、
`EVIDENCE_INCOMPLETE`、`ANSWER_NOT_STATED`、`ANSWER_CANNOT_CONFIRM`。普通 artifact 使用
`result_kind=artifact` 和唯一 `result_artifact_id`，不属于 ContentOutcome。ContentOutcome 不触发
自动重试，也不与 ErrorEnvelope 共存。
ErrorEnvelope 至少覆盖 `BINDING_REQUIRED`、`BINDING_PURGING`、`SOURCE_ENVELOPE_INVALID`、
`SOURCE_ENVELOPE_TOO_LARGE`、`PROVIDER_BUSY`、`PROVIDER_UNAVAILABLE`、`PROVIDER_TIMEOUT`、
`CITATION_INVALID` 和 `INTERNAL_TERMINAL`；客户端按 code 和 `retry_after_ms` 处理，不按中文文案猜测。

## 6. 日程

```text
typed text / final voice text
  -> local fast producer (only high-confidence ordinary forms)
       or server structured model producer (complex/clarification)
  -> ScheduleMentionGraph
  -> one mobile validator
  -> ScheduleDraft
  -> explicit user confirmation
  -> local_schedule_events transaction
```

- 本机和服务器不再各维护一套业务规则。服务端复杂解析直接输出 Mention Graph，不再运行 quick
  parser、旧规则或模型后全文字段重算。
- 本机快速 producer 与服务端模型使用同一 JSON Schema。一次输入只选择一个 producer，禁止
  字段级拼接和静默 fallback。
- clarification 请求携带原 Draft/Graph revision 和用户补充，返回更高 revision；补充不能作为
  一条独立新日程解释。
- Draft 无副作用。开始日期是最低可保存信息；标题可使用用户原表达生成的本地默认值，结束
  时间、地点、提醒和重复均可为空。
- 语音按下即写本地环形缓冲；WSS 未就绪时继续收音，连接后补发，界面不显示阻塞式“正在连接”。

## 7. 录音、导入与上传

```text
capture/import -> app-private MediaAsset -> optional local audio extraction
  -> UploadGeneration -> WorkManager single/multipart PUT -> R2 staging
  -> server HEAD/hash/size verification -> atomic asset activation
  -> one transcription TaskAttempt
```

- 视频在手机提取音轨后上传；不上传视频画面。提取失败保留原文件并给出可重试错误。
- `<32 MiB` 可使用 presigned single PUT；更大对象使用 5 MiB 非末 multipart part。
- 单个远端资产最大 `1 GiB`；每 device 最多 2 个、全局最多 4 个未完成上传，R2 outstanding reservation
  每 device `<=2 GiB`、全局 `<=4 GiB`。超单对象返回 413，超会话/字节水位返回 429，不签发 presign。
- WorkManager 唯一名为 `device_epoch + asset_id + generation`；prune 后通过服务端 probe 恢复，
  不把 WorkRequest UUID 当业务身份。
- staging key 每次 operation 唯一。完成、取消、过期和永久删除都创建独立 cleanup obligation；
  reservation 覆盖未完成 part、最后 presign 窗口、待消费 verified asset 和 cleanup；只有
  abort/delete/HEAD 证明不存在后才释放，不能被会议级联删除。R2 lifecycle 24 小时是兜底，不替代 ledger。
- 手机保留源资产直到用户删除。空间不足只停止新云端上传并保留本地待处理，不自动删正常录音。

## 8. ASR、讲话人与 Transcript

```text
audio decode -> VAD segments
                  |-> realtime-priority ASR batches -> text segment patches
                  +-> lower-priority CAM++ batches -> cluster/speaker overlays
text EOF -> immutable final TranscriptRevision
speaker completion -> overlay revision (does not replace text revision)
manual correction -> manual overlay with expected transcript revision CAS
```

- 实时会议、日程短语音、导入长音频的优先级依次降低；后台任务在段边界让出 GPU。
- 实时会议先落本机录音，再以 binding/asset/session identity 和单调 chunk sequence 发送；服务端只在
  音频已 durable spool 或文字 stable/final 后 ack。stable event 使用持久 event sequence；断线、API
  重启或 15 分钟 token 到期时，客户端换 token 后从 chunk/event cursor 续接，旧连接不得延长失效授权。
- ASR 断句由 VAD/语义标点合同控制：partial 不强加句号，稳定边界才提交标点；UI 不把每个网络包
  渲染成新句。
- 文字片段一旦稳定立即发布。CAM++ 不能阻塞文字；声纹未知或低置信时保持匿名，不强行命名。
- segment ID 由 asset generation、源时间范围和 ASR revision 稳定生成。重转写产生新 revision，
  旧 revision 不原地覆盖。
- 搜索使用手机 FTS5，索引 transcript、笔记、Facts 和问答；播放跳转只使用原始 segment/time。
- `no_speech` 是成功分析后的内容结果，不显示为“处理失败”。

## 9. 整理、行动候选与模板

短/中会议使用一次 `MeetingFactsDocumentV3` 结构化生成。超过输入预算的会议按确定性的时间和
主题边界分章，每章只调用一次事实生成，最后由代码合并同源事实、冲突组、关系和行动候选；
不生成递归中间摘要，也不再调用模型写第二份模板总结。

```text
authoritative sources -> evidence pack/chapter packs
  -> facts-v3 generation (one call per pack)
  -> schema + exact-source verification
  -> deterministic document merge
  -> local general/1:1/project/interview projections
```

- overview 对短会由模型输出；长会由证据分数、主题覆盖和时间顺序确定性选取确认事实生成，避免
  无来源的第二次模型综合。
- 行动候选完全由模型语义产生，代码只校验来源、否定/已完成状态、重复和日程适配字段；不使用
  关键词否决。用户确认后才创建日程。
- 模板不参与生成；切换模板不联网、不创建版本。用户编辑保存为模板覆盖层，不修改共享事实。
- 任意长度会议都可处理。单章失败只重试该章；所有章成功前继续显示上一可用结果，不提交部分
  文档冒充完整整理。

### 9.1 本场待办

`action_candidates` 是不可变生成来源，不是可变待办 owner。用户采用候选、从标记创建或手动新建
后，均写入同一个本机 `ActionItem` 聚合；它独立支持编辑内容、负责人和截止时间，完成、恢复、
删除、系统提醒以及“创建后续日程”。整理重新生成只能增加新候选，不能覆盖既有 ActionItem。
账号与跨设备协作不进入 vNext；旧协作分享仅作历史只读并在 Stage 5 删除，本地导出仍可显式包含
待办。系统通知只保存可从 ActionItem revision 重建的 ID，不成为第二状态 owner。

## 10. 会议问答

采用 Q2：当前会议的 authoritative snapshot、一次 attributed reader、确定性 grounding 和 owner
原子提交。Generated summary 不是事实来源；历史回答正文也不是事实来源。

- 每个回答 clause 拥有 `all_of` SourceRef；引用必须解析到当前来源 revision 和 UTF-8 原文范围。
- 正常路径只有一次 semantic provider call；无 scope classifier、verifier、editor、repair、recovery
  或 Q0 静默 fallback。
- 正向问题可使用 selected evidence。`not_stated/status_open` 只有完整会议可进入上下文时才能给出；
  超预算会议返回“无法从完整会议确认”，不能用 top-k 未召回推断未提及。
- 通用知识问答不属于会议问答。跨会议来源、旧 snapshot、撤销来源和迟到 attempt 均拒绝提交。
- 同一终态 Task replay 不再次调用 provider；自动重试才在 active Task 内增加 attempt，用户重试
  创建新 Task generation。

## 11. 本地组织、分享与更新

- 主题分类退化为显式用户标签；整理事实和关键词不得自动成为分类目录。人物页保留为本机
  speaker overlay 的派生视图，不建立第二套持久人物分类 owner。
- 长按普通会议只提供取消/移入回收站；回收站内才提供恢复/永久删除。
- 默认分享生成本地 Markdown；音频、附件和公开链接必须用户逐项选择。公开分享 token 有 TTL、
  可撤销且不授予原会议访问权。公开链接由 device bearer 创建/撤销；读取只接受 256-bit share
  capability，不接受 device bearer，也不能列举或访问原会议。链接把 secret 放在 URL fragment，落地页
  只通过 body 兑换，Nginx/服务端 URL 日志不接触 secret。会议永久删除或 epoch purge 先令读取
  返回 410，再删除分享 payload/R2；公开内容的字节只经撤销感知的 API 网关返回，不签发可绕过
  该栅栏的对象 URL。公开分享不能脱离 binding generation 的清理栅栏。
- 保留当前 `latest.json + versionCode + SHA-256 + byte size + verified APK install` 更新合同。每次
  发布同时递增 `version/name` 和 `versionCode`，旧 APK 不覆盖。

## 12. 页面与状态投影

JS/TypeScript repository 是持久业务状态 owner。Kotlin 独占 recorder、player、WorkManager、媒体
选择/提取等系统能力运行态，以及 tab、滚动、焦点、输入、搜索和 viewport 等 surface 瞬时态；
这些状态通过检查点或 action 投影到 JS，但 native 不维护第二份 meeting/transcript/summary/task
业务生命周期。

每个跨边界 snapshot/action 使用：

```text
ProjectionEnvelope {
  deviceEpoch, entityId, entityRevision,
  viewRevision, surfaceInstanceId, payloadSha256, payload
}
```

旧 envelope 直接丢弃。页面不得从中文状态文案反推业务状态。固定导航、标题和选择栏不因加载、
错误或任务状态出现而移动；状态附着在内容标题附近或既有行内，不预留永久空白。

AsyncStorage 只允许非敏感偏好、短期 UI state 和更新检查时间；业务正文、可恢复任务、设备密钥和
删除义务分别只能进入 SQLite、SecureStore 或 native system capability journal。

重新生成时继续显示上一份结果；状态只单调前进。页面重进从 repository 恢复同一 operation，
不通过组件 mount/unmount 创建任务或清除状态。

### 12.1 用户可见水位

| 水位 | 用户立即看到 | 后续替换规则 |
| --- | --- | --- |
| 采集/选择完成 | 本机会议、标题、媒体信息和真实准备阶段 | 不等待远端 binding；失败不移除会议 |
| queued/admitted/busy | 标题行尾显示当前 operation 的短状态和 retry-after | 同 operation 单调推进；不新增列表项或永久占位行 |
| 上传中 | 已传/总字节与可取消状态 | ack 单调增加；重进读取同一 generation |
| 首个稳定 ASR 段 | 文字记录立刻追加，可播放已知时间范围 | partial 原位更新；stable 后不因 speaker 结果重写文字 |
| text final | final TranscriptRevision 原子激活 | 旧 revision 仍可供已生成结果/历史引用读取 |
| speaker overlay | 姓名逐段补上 | 只改 overlay，不重建 transcript tab 或播放器 |
| summary/QA running | 上一整理继续可读；问题以 pending turn 显示 | 新结果一次原子插入；失败保留上一结果并显示独立错误 |
| 首次整理/讲话人失败 | 首次整理使用固定 skeleton；讲话人失败只在讲话人入口说明 | 不把 Transcript、其他 tab 或整场会议标为失败 |
| retryable_failure（UI 可显示“等待重试”）/cancel_requested | 保留当前结果与 operation identity，显示下一次尝试/取消中 | 不回退 phase；新用户重试创建新 generation |
| regenerate success | 新不可变版本成为 current | 用户编辑和旧版本保留；模板切换只改本地投影 |

固定 tab、标题、日期、播放器和用户滚动位置在水位推进时保持不动；只有用户主动导航才改变页面。

## 13. Provider、任务和资源

- `laoji-api` 内只有 `LlmProvider`、`EmbeddingProvider`、`AsrClient` 三个技术适配器。
- 业务模块只能通过 provider 接口；静态检查禁止直接访问 Ollama/8030 或云端 SDK。
- 调度优先级：实时 ASR > 日程语音/解析 > 会议问答 > 用户主动整理 > 导入 ASR > 后台迁移。
- Ollama 维持 `MAX_LOADED_MODELS=2`、`NUM_PARALLEL=1`；禁止静默切换到其他端口或模型。
- 9B 与 ASR 使用 GPU0；0.6B embedding 默认 CPU/按需运行，不占用新的常驻 GPU model slot。
- 默认 provider 是本地 9B；显式配置的云端 provider 只能作为部署选择，不能在请求失败时自动
  外传会议内容。
- 不增加 Redis、Celery、PostgreSQL、Neo4j、Chroma、DBOS 或 Restate 常驻依赖。

资源硬预算：

| 项目 | vNext 上限/保留 |
| --- | --- |
| 老记 GPU0 常驻显存 | `<=16 GiB`；不新增 GPU model，调度前要求整卡至少 `1 GiB` 安全余量 |
| GPU1 | `0` 老记新增占用；不修改现有进程 |
| laoji-api RSS | 暖态 `<=1.2 GiB`，1 GiB 上传时额外 RSS `<=128 MiB` |
| 老记进程总 RSS | 混合负载峰值 `<=8 GiB`，按 API、ASR、Ollama runner 完整进程树统计 |
| 老记 CPU | 1 秒采样 p95 `<=16` 个逻辑核，30 秒内短峰值 `<=24`；线程池显式设上限 |
| Android 上传额外内存 | 与文件大小无关，峰值 `<=64 MiB` |
| 服务端临时盘 | 流式解码且不生成整份 WAV；单任务 `<=512 MiB`、全局 `<=4 GiB`，终态后 10 分钟内清理 |
| R2 staging | 单资产 `<=1 GiB`；每 device/global active upload `<=2/4`，outstanding reservation `<=2/4 GiB`；HEAD absent 后释放 |
| 公开分享 | 每 device/global active share `<=32/128`，引用或复制 payload `<=8/32 GiB`；单项沿用 1 GiB 资产上限，TTL 最长 30 天 |
| 整理/问答 source | active stream `<=2/8`、未 compact page `<=2/4`、manifest bytes `<=8/16 MiB`、未消费 group `<=2/4`、payload `<=256/512 MiB`（device/global）；每 Task 两个 `<=4 MiB` 滚动 checkpoint 槽，checkpoint `<=16/64 MiB`（device/global） |
| cleanup/purge ledger | active rows `<=4096/16384`（device/global），序列化 `<=64 MiB`；硬门只停新远端 admission，义务不丢弃 |
| 常驻业务进程 | `laoji-api + laoji-asr + Ollama`，不增加第四个业务进程 |
| 正常录音存储 | 用户删除前永久；低于 40 GiB 告警，低于 20 GiB 拒绝新云端上传 |

准入由 `laoji-api` 在提交 provider 前原子取得 capability slot；Ollama、ASR 和 CAM++ 不被描述为
可跨进程抢占。CAM++ 归属 `laoji-api`，默认 CPU/有界 worker；若部署探针明确配置 GPU0，也必须
计入同一 `16 GiB` 老记峰值预算。若整卡安全余量不足，任务保持 admitted 前排队并返回可观察的
busy 状态；不得抢占 GPU1、PCB 或其他用户服务。

队列必须有界：每 device 最多 2 个、全局最多 4 个实时会话，每个实时会话未 ack 音频不超过 2 秒；日程交互队列最多 4 个，问答与用户主动
整理共享队列最多 8 个，导入/迁移后台队列最多 32 个。超过水位返回 typed busy 与
`retry_after_ms`，同时停止接纳新的后台工作；不得在内存中建立第二个无界等待队列。实时 ASR
到达时，后台工作在当前 VAD/生成块边界让出，不承诺跨 Ollama/ASR 进程硬抢占。

匿名 device 还受持久 token bucket：日程解析每分钟 30 次、burst 4；source stream、问答与主动整理合计每分钟 6 次、
burst 2；同时上传最多 2 个。global 队列门仍在 device 配额之后执行，设备不断重试不能占用无限资源。

cleanup/purge 未压缩元数据每 device/global 最多 `4096/16384` 行、序列化总量 `<=64 MiB`。达到 75%
先合并同 epoch/binding 的义务；只有逻辑 store 删除且所有 R2 object/multipart HEAD/list 均确认不存在后
才可压缩。达到硬门只停止新的远端 bootstrap/binding/task/upload/share admission，本机录音、日程、删除与
purge 重试继续工作，绝不丢弃义务或阻塞本机清除。

## 14. 用户体验和质量预算

| 能力 | 验收目标 |
| --- | --- |
| App 启动 | 暖启动 p95 `<=0.8s`，冷启动 p95 `<=2.0s`，首帧不白屏 |
| 手动日程 | 本地保存/更新 p95 `<=100ms` |
| 语音日程 | 按下后 `<=100ms` 开始本地采集；首文字 p95 `<=1.5s`；停说后 Draft p95 `<=3s` |
| 日程质量 | 严格自然 holdout 字段完全正确率 `>=95%`；日期/时间/操作关键字段召回率 `>=98%`；错误保存率 `0` |
| 文件选择/返回 | 选择器启动 p95 `<=500ms`；选择后 `<=300ms` 进入会议详情并显示真实阶段 |
| 上传 | 有效吞吐达到同网络裸 PUT 的 `>=80%`；断网/杀进程后自动续传且不重复资产 |
| 实时转写 | 稳态文字端到端 p95 `<=2s`；partial 不产生频繁假句号 |
| 导入转写 | 有声样本 RTF p95 `<=0.5`；上传完成后首段 p95 `<=8s` |
| ASR 质量 | 真实中文会议字符错误率 CER 中位数 `<=8%`、p95 `<=18%`；数字/时间专集准确率 `>=95%` |
| 讲话人 | 不阻塞文字；final text 后 speaker overlay p95 `<=30s`；已登记样本 attribution F1 `>=90%`；未知人强行命名率 `0` |
| 整理 | 单 pack p50 `<=20s`、p95 `<=45s`；不超过 1 小时的长会端到端 p95 `<=90s`；更长会议不设长度拒绝门，每新增 chapter p95 `<=45s` 且至少每 5 秒更新进度；事实人工支持率 `>=95%` |
| 整理引用 | 显示引用解析和原文匹配率 `100%`；重复行动 `0` |
| 问答 | 暖态 p95 `<=15s`；显示引用原文匹配 `100%`、人工相关率 `>=95%` |
| UI 稳定 | 状态出现不移动固定控件；无重复 loading、文字截断、跨页状态分歧 |
| 隐私 | 正文日志命中 `0`；成功/永久失败后临时载荷删除，最迟 TTL `24h` |
| 恢复 | 已确认本机写 RPO `0`；进程重启后任务可查询 p95 `<=5s`、自动续跑 p95 `<=30s`；每 task 总计 3 attempts（初次 + 2 次自动重试），退避 `5s/30s` |

测量统一使用带 `traffic_class`、输入 revision、provider/model/prompt revision 的隔离回放。日程质量
只计算独立自然 holdout；ASR 按参考转写 Unicode 归一化后计算 CER；讲话人按说话时长加权。p95
至少 30 个暖态样本，冷启动另报。交互延迟和资源 p95 统一在 10 分钟混合负载中测量：1 路实时
会议 ASR、1 个持续上传、1 个导入 ASR backlog、每分钟 1 次日程解析、每 2 分钟 1 次问答、每 5 分钟
1 次用户整理；后台迁移仅在余量中运行。单能力空载结果另报但不能替代混合负载门。上述指标是目标，
不是当前已通过的事实。

这些是 vNext 验收目标，不是当前已实现性能。

## 15. 兼容性边界

- Android/React Native 使用生成的 TypeScript/Kotlin 合同；服务端使用同一 JSON Schema 生成
  Pydantic 类型。Schema 是权威，禁止三端手抄后漂移。
- 业务代码不依赖 Linux 绝对路径、shell 管道或 systemd；文件路径通过配置和 `pathlib`/平台 API。
- systemd、Cloudflare Tunnel 和 GPU 配置只在 `deploy/linux`；数据迁移和测试工具必须可在 Linux
  与 Windows 使用 `python3`/Node 运行。
- v1 API 只保留一个已发布周期的显式 adapter；客户端 capability 明确选择 v1 或 v2，不能在一次
  请求中静默降级。

## 16. 架构完成定义

本基线已经选定所有开发关键路线。实施阶段仍需验证性能、质量和迁移门禁，但不得重新选择数据
所有权、领域边界、上传拓扑、Transcript 版本模型、Facts V3、Q2 或三进程服务拓扑。若真实证据
证明任一选定路线不可行，必须形成新的全局 revision，说明对其他领域和删除计划的影响；不得在
局部添加第三个 owner、fallback 或长期兼容层。
