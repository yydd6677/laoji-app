# 老记紧凑生产架构验收记录

## 2026-08-09 混合并发最终补充（当前权威结论）

- 5 路设备鉴权公网 WSS 实时会议与 2 路真实 WAV 设备资产上传/转写同时运行；实时共收到 10 条最终文字，全部收到 `ready_to_stop`，无错误。
- 两个后台上传均 HTTP 200，转写任务均 `completed`，分别得到 5、4 条文字；资产 ID、任务 ID 均唯一，没有跨会议覆盖或同步冲突。
- 实时片段结束到结果的 p50/p95/最大延迟为 `1629.73/1846.47/2049.23 ms`，p95 低于 2 秒门槛。测试后的 `/api/ready` 仍为 ready，ASR/Ollama/持久任务队列和活动租约均为 0。
- 7 个临时会议、数据 epoch 和设备主记录已清理。完整证据见 [`compact-production-mixed-concurrency-20260809.md`](compact-production-mixed-concurrency-20260809.md)。
- 本节覆盖本文较早的 3.61169 秒、903.21 ms 等历史探针结论；历史数值保留用于审计，不再作为当前混合并发门禁状态。
- 公网安全边界也已复核：设备/地址响应 `no-store`，未授权设备和共享读取 fail-closed，ready/日志不含凭据或正文，环境密钥与 Tunnel token 为 `0600`；仅重启 API 后四项服务仍 ready。详见 [`security-boundary-audit-20260809.md`](security-boundary-audit-20260809.md)。
- 双设备隔离也已通过：A 设备只能读取自己的会议，B 设备读取或写入 A 的会议均为 `404/MEETING_NOT_FOUND`，错误 epoch/凭据分别为 `409/EPOCH_UNKNOWN` 与 `401/DEVICE_CREDENTIAL_INVALID`；临时身份和数据已清理。详见 [`device-isolation-audit-20260809.md`](device-isolation-audit-20260809.md)。
- 存量简体化迁移已完成：948 条历史转写及整理/分享生成字段经 OpenCC `t2s` 迁移，迁移后扫描字段变化数为 0；数据库行数和完整性不变。详见 [`simplified-data-migration-20260809.md`](simplified-data-migration-20260809.md)。
- 迁移后的资源采样：GPU0 `22962/32607 MiB`，老记 ASR/API/Ollama 进程与两个 Ollama runner 合计约 `16810 MiB`，GPU0 余量约 `9645 MiB`；GPU1 `31756/32607 MiB` 为其他服务；`/home` 剩余约 `517 GiB`。四项服务 active，ready/队列/活动租约正常。
- 生产活动源码已回同步工作区：设备 clarify、分片上传和设备 WebSocket 鉴权路由与活动版本一致；旧本地副本已备份，未重启生产服务。详见 [`production-source-sync-20260809.md`](production-source-sync-20260809.md)。
- 同步后的临时清理审计曾发现 1 条孤儿设备 epoch，已在备份后定点删除；当前三库 `foreign_key_check=0`、`integrity=ok`，生产 epoch 关闭逻辑未改动。详见 [`orphan-device-epoch-repair-20260809.md`](orphan-device-epoch-repair-20260809.md)。
- 设备原始音频留存边界已真实通过：转写完成后资产为 `processed`，服务器 `storage_path` 为空且原始文件不存在，生成转写仍可读取；临时设备数据已清理。详见 [`device-source-retention-audit-20260809.md`](device-source-retention-audit-20260809.md)。
- 当前权威移动端 release 仍为 `1.0.6`/versionCode `106`，最终 APK SHA-256 为 `f226843a3a53d59704dd2f1f01e9e395118f1f80921447fe3b2e57d00dd3fef4`，已覆盖安装于 `emulator-5562`。构建时临时注入有效设备注册引导密钥；启动出现 `device_service_ready`，guest 兼容日志已标记 `scope_kind=device-local` 与 `network_path=device-v1/none`。详见 [`device-scope-runtime-audit-20260809.md`](device-scope-runtime-audit-20260809.md)。
- 历史合同针对性测试在临时依赖和隔离 SQLite 中 `25 passed`；地址缓存与日程 ASR 旧断言已按当前设备化合同更新，完整历史 pytest 仍不宣称全量通过。详见 [`history-test-contract-20260809.md`](history-test-contract-20260809.md)。
- 设备失败源文件留存边界已通过补充验收：过期失败设备源按 24 小时 TTL 清理，后续任务、近期失败源和账号资产均隔离保留；生产现场无待清理项。详见 [`device-source-failure-retention-audit-20260809.md`](device-source-failure-retention-audit-20260809.md)。
- 重新构建的当前生产类 release `1.0.6`/`versionCode=106`（`APP_ENV=production-rehearsal`）SHA-256 为 `86e9112bd978ccbaaa3a0d4359aa45f54135804c22e978a30b75e9701ec02a24`；APK 内引导密钥长度 64，非开发配置缺少设备引导密钥会在配置阶段失败。由于当前只有 KataCR 占用的 `emulator-5560`，未将该包安装到其他工作设备。
- 本轮源码和验收文档已提交到本地 commit `7ad25e4` 并标记 `laoji-device-primary-freeze-20260809`，没有推送远端。

更新时间：2026-08-09（Asia/Shanghai）

## 2026-08-09 最终运行对齐

- 当前实际 release APK 是 `1.0.6`/versionCode `106`，SHA-256 `3faf199d8db165d75a7c35d326c1b10eeeadd4850db91e3f7491a4d46368efab`（已由 `aapt`/哈希复核），已覆盖安装到 `emulator-5562`；本次启动无崩溃、`laoji_start_auth` 或未捕获异常。真机安装与验收按本轮要求跳过。
- 本轮客户端续做 release 仍为 `1.0.6`/versionCode `106`，最终 SHA-256 `9801f2baf787540477fcb971768975a0be47aac8441d4fcc09fe96c766fd2a6d`，已覆盖安装到 `emulator-5562`；最新启动耗时约 `404ms`，无 `FATAL EXCEPTION`、`laoji_start_auth` 或未捕获 React Native 异常。`emulator-5560` 未操作。
- `npx tsc --noEmit`、`git diff --check` 和 compact source 静态检查均通过。工作树继续保留既有脏改动，不自动提交或推送。
- `verify_device_primary_source.py` 与 release APK 的 `verify_compact_apk_config.py` 也通过，确认本机主数据合同和统一 `https://laoji.cloud` 入口未被本次构建回退。
- 设备问答/整理的旧 guest 回退已移除：无设备绑定或请求包含本机笔记/旧附件时只返回中文不可用状态，不再向旧兼容接口发送完整本机转写；静态门禁和当前 release 构建已覆盖此改动。
- 服务器四个目标单元均 active/enabled；公网 `/api/ready` ready，队列 0，ASR、生成、embedding、VAD/CAM++ 和三个 SQLite 数据库均健康。仅 18020/8030/21434 loopback 监听，公网入口只有 Cloudflare Tunnel。
- 实时资源采样：GPU0 `23,346/32,607 MiB`，其中老记 API/ASR/Ollama 约 `17,194 MiB`；GPU1 `31,756/32,607 MiB`，GPU1/PCB/其他用户服务未触碰。服务数据 `/home` 剩余约 `517 GiB`。
- 旧运行时审计已完成：活动进程、systemd、compact 运行源码/模型目录无旧 8002、18035、21436、VibeVoice、WhisperLiveKit 依赖。历史 docs/tests/兼容接口中的旧名称只作资料保留，不能据此判断仍有服务在运行。
- 当前仍未宣称通过的项目是：问答专题、真实声纹纵向质量、真机验收和完整历史 pytest 旧断言修订。实时+后台公网混合并发 p95 已由本页顶部的有效 WAV 证据通过。
- 网络对照：当前 Cloudflare Tunnel 使用 QUIC、边缘连接为 `lax01`；关闭代理访问 `/api/ready` 的 5 次总耗时约 `0.89–2.22 s`。这支持将实时尾延迟归因于公网路径诊断项，而不是把服务端推理错误地标成通过或失败。

### 2026-08-09 Tunnel A/B 与客户端热路径续做

- 使用同一 Tunnel token 临时启动单连接 HTTP/2 进行 A/B，15 次串行 `/api/ready` 为 p50 `1.139s`、p95 `2.126s`、最大 `2.519s`；三轮五路并发最大 `1.538/2.068/2.851s`。结果没有稳定优于现有 QUIC，测试后已恢复 `cloudflared.service`，当前仍为 QUIC；没有留下临时进程、token 副本或配置改动。
- 移动端设备就绪证明现在有 60 秒内存缓存和并发请求合并；401/403、数据域关闭时会失效并重新注册。设备转写轮询对 404 和网络失败采用有界退避，避免失效绑定造成固定 15 秒轮询噪声；该逻辑不改变本机事实或重试终态。
- 日程复杂文本、补充追问和文件语音已切换到设备服务接口；远端新增 `/api/device/v1/schedule/clarify`，部署源码 SHA-256 为 `f8c6b8ead988de0447837807a9e5d97d4cee0ee3f328188370cde347d249d58d`，备份为 `backups/device-schedule-clarify-20260809-023713`。临时设备真实探针通过 `parse=200`、`clarify=200`、`parse-audio=200`，epoch 清理返回 `200`。

## 2026-08-09 续做验收（最新）

### 设备域冲突、SQLite 并发与实时优先级

- 账号删除触发器已改为只拦截 `data_epoch_id` 为空的账号会议。真实回归：旧账号删除墓碑存在时，设备会议插入和普通更新成功；设备会议被改回无 epoch、账号会议插入均得到 `account deletion in progress`；`PRAGMA foreign_key_check` 为空。
- 设备鉴权不再在每个请求中写 `last_seen_at`；分片落盘/合并通过线程池执行；设备会议删除和 epoch 关闭先清理旧表的非级联子行。使用真实 30 秒 WAV 在 loopback 完成上传、Qwen 转写 8 条文字、会议删除、epoch 删除，均成功；重复删除返回幂等的 epoch closed，而非内部错误。
- SSH 转发到同一 loopback origin 的五次实时会议与两条后台上传并发真实测试：五次均收到 `config`/`ready_to_stop`，段结束到最终文字 p95 `903.21 ms`；两条后台任务均 `completed`、各 8 条文字，`background_exit=0`。
- （历史探针）关闭本机 HTTP 代理、直接走公网 `laoji.cloud` 的早期测试曾得到实时 p95 `3611.69 ms`；该探针使用旧夹具/旧客户端，现已由顶部有效 WAV 混合负载重新测量并覆盖，不再作为当前门禁结论。

### 日程设备语音与服务重启

- 临时设备注册返回 201；日程 WebSocket 成功 open，并收到服务端 `config`、`ready_to_stop`，正常关闭后 epoch 删除返回 200；没有调用旧 guest session。
- 依次重启 `laoji-ollama.service`、`laoji-asr.service`、`laoji-api.service`。Ollama 预热后就绪；ASR 重启后真实 16 kHz WAV 请求返回 `200`、文本“嗯。”、`last_inference.success=true`；API、ASR、LLM、任务 worker 最终均 ready，队列深度为 0。

### 地址设备鉴权

- 初次探针发现设备凭据调用 `/api/location/reverse` 返回 401，定位为路由仍只识别旧账号 token。
- 已部署设备鉴权修复，备份为 `backups/location-device-auth-20260809-000326`。从公网 `https://laoji.cloud` 创建临时设备后，带 `Authorization: Bearer dv1...` 与 `X-Laoji-Data-Epoch` 调用真实高德服务返回 200，得到深圳市福田区地址；随后关闭 epoch 返回 200。

### 旧运行时审计

- `127.0.0.1` 仅监听 18020、8030、21434；旧 8002、18035、21436 无监听，VibeVoice/WhisperLiveKit 无进程或 compact 引用。
- Ollama 只有 `qwen3.5:9b` 与 `qwen3-embedding:0.6b`，ASR 模型只有 Qwen3-ASR-1.7B；没有发现属于老记目标且仍需删除的旧重资产。其他用户目录和服务未触碰。
- 重启后的最新资源采样：GPU0 22926/32607 MiB、GPU1 31756/32607 MiB；GPU1 仍明确不属于本计划。

### 任务中断恢复、媒体矩阵与并发

- ASR 中断恢复：设备转写任务重启前为 `running/attempt=1`，ASR 重启后最终为 `completed/attempt=2`，数据库中保留一份完成结果。
- API 转写中断恢复：任务重启前为 `running/attempt=1`，API 重启后最终为 `completed/attempt=2`，同一会议返回 8 条文字，没有第二条任务或资产。
- 整理中断恢复：同一设备整理任务重启前为 `STARTED`，API 重启后为 `SUCCESS`；结果含概述、结构化文档和模板版本，任务表只有一条成功记录。
- 30 秒真实媒体矩阵：WAV、M4A、MP3、MP4、WebM 均经公网设备分片上传和 Qwen 转写通过，每种得到 8 条文字并正常清理临时 epoch。
- 双任务并发：同一设备同时上传 WAV 与 M4A 到两个会议，均 `completed`、各 8 条文字，墙钟约 47.47 秒，未出现同步冲突、跨资产覆盖或队列残留。此项不替代实时录音与后台上传 p95 验收。
- 长音频：真实 3660 秒（61 分钟）M4A 任务 `completed/attempt=1`，产生 1051 条文字，最大结束时间 3,660,608 ms，覆盖率约 100.02%；服务端临时资产、任务和设备 epoch 均已清理。
- 上传中断恢复：9 片上传先完成 3 片，API 重启后前 3 片重放、其余补齐，complete 返回成功并通过 SHA/大小校验，随后转写 `completed`、8 条文字。
- Ollama 中断恢复：整理任务在 `STARTED` 时重启 `laoji-ollama.service`，同一任务最终 `SUCCESS`；服务恢复后 `/api/ready` ready、生成/ASR/任务队列均为 0。

## 2026-08-08 增量验收（最新）

### 设备实时语音与隧道分片增量

- （历史 8 月 8 日构建）移动端 release 1.0.6（SHA-256：`301a1983b9dbc27693315d5d528d173d36784630608ef934d418b271e9178849`）覆盖安装到 `emulator-5562`；当前构建以本记录顶部“最终运行对齐”为准。
- 模拟器会议录音真实顺序为：设备注册 201 → 设备会议绑定 201 → `/ws/meeting/{id}/qwen` accepted → Qwen session ready → 正常关闭；服务器日志没有 `/api/laoji/meetings/guest-sessions`。
- 一段约 3 MiB 的模拟器 WAV 通过 6 个 512 KiB 分片上传：分片均 200，complete 200，转写提交 202；客户端出现 `content_uploaded` 和 `transcription_submitted`，队列上传成功。该录音无有效人声，任务最终 `no_speech`，这是内容结果而非传输失败。
- 期间仅重启 `laoji-api.service` 以加载 WebSocket/分片路由，未重启 ASR、Ollama、GPU1 或其他用户服务；`/api/ready` 仍 ready，队列为空。
- 分片 complete 的丢响应重试保护随后补齐；最新服务端备份为 `/home/zhong/laoji-service-platform/compact-production/backend/backups/device-chunk-idempotency-20260808-233936/`，部署后 `/api/ready` 仍 ready、ASR/任务队列均为 0。

### 设备留存策略

- `summary_tasks_v2` 已新增 `retain_generated_result` 与 `result_expires_at`；关闭质量改进时任务正文最多保留 24 小时，清理只清正文、保留任务状态；开启时结果不设置该 TTL。
- 设备整理 worker 不再写入 `final_summaries` 或 `summaries/final` 文件；设备问答默认不写 `meeting_question_*` 账号兼容表，开启开关才写入匿名 `device_quality_candidates`，候选 TTL 30 天。
- 本机会议删除已接入只含会议 UUID 的持久 outbox；删除不等待网络，回到前台或下次启动时按幂等接口清理设备服务绑定，失败按退避重试，不恢复已删除的本机记录。
- 本机讲话人删除同样先清除姓名映射并隐藏列表项，匿名声纹 ID 进入持久删除 outbox；本轮只完成源码合同检查，尚未用真实声纹样本做服务端删除纵切。
- 讲话人列表已增加本机匿名 profile 缓存，在线列表用于刷新、断网回退本机缓存；本轮未把该回退冒充真实声纹识别质量验收。
- 通过公网对临时设备做了真实整理探针：关闭和开启两种模式均 `SUCCESS`、`GET /summary` 为 200；关闭模式 `expires_at` 已设置，开启模式未设置；两种模式均未新增 `final_summaries`。临时 epoch/会议已清理。

### 最新移动端

- （历史 8 月 8 日构建）APK SHA-256 依次为 `7ce37b4c2267e540b55d4452f08fd647fff5029b4941917647984904a548a9ec` 与 `9cee1b3395f6d885fd1b6769f0f3234b0a53b07e69d57e6a10c61714e6e6655d`；当前安装包以本记录顶部“最终运行对齐”为准。
- 已覆盖安装到 `emulator-5562`；构建时从服务器受保护环境注入设备注册引导密钥，源码、日志和工作区没有该密钥。
- 启动日志出现 `device_service_ready`，无 `FATAL EXCEPTION`/`laoji_start_auth`。
- 断网实测本机新建、保存、打开、删除日程，删除后显示撤销入口；会议列表、设置页、质量开关（默认关闭）和版本信息（1.0.6）可用。

### 服务与资源实时核对

- `https://laoji.cloud/api/ready` 当前 `ready=true`，队列深度为 0，三套数据库 WAL/完整性通过，磁盘约 516 GiB 可用。
- 设备删除文件清理修复已部署到 `laoji-api.service`：部署前源码备份在 `/home/zhong/laoji-service-platform/compact-production/backend/backups/device-delete-source-20260808-195523/`；重启后公网就绪状态仍为 `ready=true`，任务队列为 0，API cwd 与目标 compact 目录一致。
- 仅老记端口 `127.0.0.1:18020/8030/21434` 监听，Cloudflare Tunnel 为唯一公网入口；旧 8002/18035/21436、VibeVoice/WhisperLiveKit 进程未发现。
- GPU0 总占用约 24.2 GiB，其中约 17.7 GiB 为老记 API/ASR/Ollama；GPU0 仍有约 7.7 GiB，GPU1/PCB/其他服务未触碰。GPU1 的其他服务不计入老记资源预算。

### 测试边界

- 服务器定向合同/任务测试 `15 passed`；完整历史 pytest 为 `281 passed / 48 failed`，失败是既有模板 revision、问答审查调用次数和日期规则断言漂移，不能写成全量通过。
- 真机、问答专题和完整声纹纵向质量仍按原验收记录列为未宣称通过；多格式/一小时长音频矩阵、混合并发 p95 和三服务逐阶段重启已有对应真实证据。本轮不把模拟器通过替代真机通过。

这份记录只写已经在当前工作区、当前服务器或 `emulator-5562` 上看到的证据。没有实际执行的项目不会标记为通过。

## 当前拓扑

| 组件 | 当前实况 | 结论 |
| --- | --- | --- |
| Cloudflare Tunnel | `cloudflared.service` active，origin 为 `http://127.0.0.1:18020` | `https://laoji.cloud` 可访问 |
| laoji-api | `127.0.0.1:18020`，单 uvicorn worker | 运行中 |
| laoji-asr | `127.0.0.1:8030`，Qwen3-ASR-1.7B | 运行中 |
| Ollama | `127.0.0.1:21434`，生成与 embedding 由同一服务提供 | 运行中 |
| Nginx | 主机 80 端口仍由现有站点使用 | 不在当前 Tunnel 请求路径中，未改动其他站点 |

Cloudflare Tunnel 已承担公网 TLS/WSS 入口，因此当前实际路径是 `Cloudflare -> cloudflared -> 127.0.0.1:18020`。原计划中“由 Nginx 接收公网 HTTPS”的形态没有被强行套用；这不是 Nginx 配置验收通过，而是明确记录的部署差异。

## 已通过的垂直切片

### 1. 统一服务就绪状态

公网请求：`GET https://laoji.cloud/api/ready`

最近一次真实返回：

- `ready=true`
- ASR：`Qwen3-ASR-1.7B`，队列深度 0，最近一次推理成功
- LLM：`qwen3.5:9b`，embedding：`qwen3-embedding:0.6b`，队列深度 0
- VAD/CAM++：ready
- 任务 worker：无排队、无活动租约
- main/schedule/speaker 数据库：WAL、完整性检查通过、外键违规为 0
- 磁盘剩余约 516 GiB，当前接受新音频
- 高德 Web 服务配置已加载

### 2. 设备上传与转写

真实样本：`/home/yydd/下载/会议视频样本/39799065_da2-1-16.mp4`

- 约 360 秒、19.19 MB、H.264/AAC、48 kHz 双声道。
- 通过 Cloudflare Tunnel 走 4 MiB 分片上传：5 个分片均返回 200，complete 返回 200。
- 服务端资产：`bf2fa2df-350f-40ae-864f-3e4d196c04d7`，`upload_state=processed`。
- SHA-256 校验为 `sha256:085afae46e8b163df72230e97b3f1c1663a9b0b3516f7ecfb9d4ff9218e01999`。
- Qwen 转写任务：`43dcf35f-b60f-4a2c-bd23-8b7599f59793`，`status=completed`。
- 服务端生成 115 条文字记录，模拟器文字记录页已拉回真实文本。

### 3. 整理结果

真实会议：`51165ea0-c78d-4906-80d4-a4ff26c2df19`

- 任务：`04fa8abf-35ad-4c64-83b0-ec9c2df9146e`。
- `status=success`，尝试次数 1，耗时约 43 秒。
- 结果为结构化文档，模板 `general`、revision 2。
- 模拟器显示“概述”正文，未显示 JSON、单独“决定”模块或重复的“代办事项”。该样本没有足够明确的行动承诺，因此候选代办事项为空是有效结果，不代表链路失败。
- 从整理结果页返回列表，再重新打开该会议，结果仍可恢复，证明本机镜像没有只停留在页面内存。

### 4. 幂等与资产一致性

服务端 SQLite 真实查询结果：

- 该会议只有 1 个设备资产，且只有 1 个 `processed` 资产。
- 该会议只有 1 条成功的 `summary_tasks_v2` 记录。
- 该任务的 dedupe key 计数为 1；没有重复任务或后写结果覆盖现有结果。
- 资产、转写任务、整理任务的会议 ID 一致。

### 5. 客户端稳定性

- release APK：`android/app/build/outputs/apk/release/app-release.apk`。
- 当前版本：`1.0.6`（versionCode 106）。
- 已安装到 `emulator-5562`（`LaoJi_API_35`），应用数据保留。
- 当前 logcat 未发现 `FATAL EXCEPTION`、React Native 未捕获类型错误或 `laoji_start_auth`。
- `emulator-5560` 属于其他工作，不在本次验收范围内。

## 明确未验收或延期项目

这些项目不能因为上述切片成功而自动视为完成：

1. 会议问答专题测试与质量升级按用户决定延期；现有根因审计保留，但本记录不宣称问答已通过。
2. 五种短媒体格式、两段短视频路径和 61 分钟长音频已通过；更长原始视频的额外质量复核不作为当前闭环完成的必要条件。
3. 上传阶段续传、转写阶段 API/ASR 重启、整理阶段 API/Ollama 重启以及公网实时录音与后台上传的 p95 压力门槛均已有真实通过证据。
4. loopback/SSH 转发的早期 p95 `903.21 ms` 和关闭代理直连公网的历史 p95 `3611.69 ms` 仅作审计对照；当前有效 WAV 混合负载公网 p95 为 `1846.47 ms`。
5. 说话人已登记、未知说话人拒识、撤销和人工修正的完整真机样本验收仍待补做。
6. 服务器虚拟环境没有安装 pytest，本轮服务器 pytest 不能执行；不能把“未执行”写成“通过”。
7. 迁移前残留已处理：`1ec866b0-6df7-444e-9cfa-62d4d0dc940c` 是空的失败测试记录，已通过应用删除并在服务器完成定点清理；清理前快照保存在 `/home/zhong/laoji-service-platform/compact-production/backend/backups/compact-orphan-1ec866-20260808/`。`35db3b69-4b35-479e-97e3-8f248227743b` 已经自动重试并成功处理，未删除成功数据。
8. 旧 VibeVoice/8002/21436 等重资产最终审计已完成：当前老记运行树、systemd、活动 compact 源码/模型目录没有可调用旧依赖；历史说明、测试和迁移备份保留为审计资料，其他用户目录不触碰。
9. 资源预算的当前静态采样已满足老记目标：GPU0 总用量 23,346 MiB，其中老记 API/ASR/Ollama 进程合计约 17,194 MiB（低于 22 GiB）；GPU1 已用 31,756 MiB，GPU1/PCB 未触碰。公网并发压力下的资源峰值未单独验收。

## 验收结论

当前已经形成可用的“设备注册 → 分片上传 → Qwen 转写 → 客户端文字记录 → Qwen 整理 → 本机恢复”的真实闭环，公网入口和三项核心常驻服务也已工作。整体紧凑生产架构仍为“部分完成”，剩余工作集中在延期的问答/声纹质量、真机验收和可选的历史 pytest 断言更新。
