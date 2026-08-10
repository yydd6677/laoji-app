# 老记服务最紧凑生产架构计划（状态版）

更新时间：2026-08-10。此文件是执行索引，不替代原始目标计划；状态以实时证据为准。

## 2026-08-09 续做最终对齐（当前权威状态）

本节覆盖本文中较早的同日记录；旧段落保留作审计历史，不应覆盖这里的当前值。

- 设备 epoch 清理加固（23:48 后）：发现独立 `summary_tasks_v2` 不受会议外键级联影响，且声纹识别日志未随设备 profile 删除；已部署精确 task-scope 清理、可恢复的声纹 cleanup outbox 和识别日志删除。启动时清除了 3 条历史临时 epoch 整理任务；公网真实临时设备回归返回 `summary_tasks_deleted=1`、`speaker_count=1`、`speaker_cleanup_pending=false`，证据见 [`docs/device-epoch-cleanup-hardening-20260809.md`](device-epoch-cleanup-hardening-20260809.md)。

## 2026-08-10 续做最终对齐（当前权威状态）

- 设备能力探测已去账号化：发现文件/视频导入原先会无令牌探测旧 `/api/laoji/capabilities`，现改为设备鉴权 `/api/device/v1/capabilities`，服务端能力响应包含媒体 MIME 与大小上限；无账号令牌的旧能力读取在缓存前直接 fail-closed。服务端重启后公网 ready 正常，临时设备能力读取与 epoch 清理通过，详见 [`docs/device-capability-accountless-audit-20260810.md`](device-capability-accountless-audit-20260810.md)。
- 设备失败源文件清理的竞态已收紧：回收线程现在在 `BEGIN IMMEDIATE` 写锁下重新确认最新任务，再删除文件并提交 `storage_path=NULL`；queued/running 重试不会被旧终态清理误删。服务器真实 SQLite/文件回归通过，部署后 `/api/ready` 仍 ready，证据见 [`docs/device-source-retention-race-hardening-20260810.md`](device-source-retention-race-hardening-20260810.md)。
- 整理任务原始输入留存边界已收口：历史 38 条非设备账号任务的 `request_json` 已在 SQLite 备份后脱敏（最大 49,727 字节降为 57 字节），代码改为只有 `device-*` 任务进入持久任务表；生成结果和状态保留。API 重启后 ready、队列、WAL 和完整性检查均正常，证据见 [`docs/summary-task-input-redaction-20260810.md`](summary-task-input-redaction-20260810.md)。
- 去账号化数据清理已完成：98 条旧账号会议、4,310 条旧账号转写、76 个旧账号资产、17 个账号、111 个会话、33 条远程日程和 8 个旧声纹 profile 已清理；当前设备 epoch 的 7 条会议和 230 条转写保留，95 个源音频文件删除。临时快照在公网 ready 与三库完整性复核后删除，详见 [`docs/legacy-account-data-purge-20260810.md`](legacy-account-data-purge-20260810.md)。
- 清理后的设备合同回归通过：全新临时设备注册/能力/日程解析分别 `201/200/200`，关闭 epoch `200`；关闭后临时设备的会议、资产、整理任务、质量候选和声纹数据均为 0。
- 旧运行时缓存复查后已删除服务器上的 ModelScope 缓存和旧 Whisper 启动脚本目录；现行进程、模型和服务不受影响，证据见 [`docs/compact-legacy-cache-cleanup-20260810.md`](compact-legacy-cache-cleanup-20260810.md)。
- 持久整理任务改造已做真实设备回归：公网分片上传、Qwen 转写 6 条文字、整理任务 `SUCCESS`、结构化结果读取和 epoch 清理均通过；关闭后临时会议/资产/转写/整理任务/源路径/声纹均为 0，证据见 [`docs/device-summary-persistence-smoke-20260810.md`](device-summary-persistence-smoke-20260810.md)。
- 8 月 10 日重启后的实时资源采样：GPU0 总占用 `27391/32607 MiB`，其中老记 API/ASR/Ollama 计算进程约 `16780 MiB`（API `566`、ASR `5128`、Ollama runner `2554+8532`）；其余为其他服务。GPU1 `31756/32607 MiB` 仍未触碰，四个目标 systemd 单元均 active，公网 ready/队列正常。

- 最新运行时复核：工作区 release `1.0.6` APK SHA-256 为 `86e9112bd978ccbaaa3a0d4359aa45f54135804c22e978a30b75e9701ec02a24`；源码、APK 入口和 TypeScript 门禁通过。当前 ADB 只有其他工作占用的 `emulator-5560`，老记专用 `emulator-5562` 离线，本轮没有跨越设备边界安装验证，真机验收继续按约定跳过。
- 讲话人删除队列加固后的 release 已重新生成：`versionName=1.0.6`、`versionCode=106`，APK SHA-256 为 `a3f16464453d13b83a334e9ffa7f543f4956162aa6d451151acc4f27af520d98`（2026-08-10 00:18）。构建时仅在进程环境临时注入服务器引导密钥和本机受保护签名属性；未写入源码、工作区或日志。`verify_device_primary_source.py`、`verify_compact_source_config.py`、`verify_compact_apk_config.py`、TypeScript 和 `git diff --check` 均通过。设备仍离线，未安装到 `emulator-5560` 或其他设备。
- 公网临时设备真实完成注册、能力、日程解析、会议绑定、两段分片上传、合并、转写和整理：转写任务 `completed`，整理任务 `success`，返回 `general@2`、结构化 schema `2` 和 Markdown；epoch 关闭返回 `200`，临时内容已清理。
- 服务器生产 `summary_tasks.py` 已从工作区补齐两处整理候选/引用修复，备份位于 `/home/zhong/laoji-service-platform/migration-baselines/compact-summary-candidate-fix-20260809-2327/`，当前 SHA-256 为 `50fc259088eb074ed7b3943958dcdcfe4b2accaf6f7b4c9525ec6faaa3dbbcb4`。API 有序恢复后四个 systemd 单元均 `active`，公网 `/api/ready` 仍为 `ready=true`，队列为 `0`。

- 设备数据域闭环复核（2026-08-09 17:04）：通过 `https://laoji.cloud` 的全新临时设备真实完成注册 `201`、能力 `200`、日程解析 `200`、会议绑定 `201`、列表 `200`、删除 `200`、epoch 关闭 `200`；关闭后能力访问为预期 `409/EPOCH_CLOSED`。服务器 `local.db` 中该临时设备主身份保留 1 行（仅身份历史），epoch 为 `deleted`，会议、设备墓碑、删除 outbox、临时输入和质量候选均为 `0`。工作区已补回服务器正在运行的鉴权只读、旧子表清理和 epoch 控制行清理，`device_identity.py`、`device_v1.py`、`qwen_ws.py` 与服务器 SHA-256 分别为 `77196321e4faea84704861dc4bb64ca6a48b0e868aefd067225c76055ca98685`、`f8c6b8ead988de0447837807a9e5d97d4cee0ee3f328188370cde347d249d58d`、`b4b7a629bbd24bf147197992d2eef40b11b404e9c53e7f4f7e4da028b1ca9f3c`。新增设备合同门禁共 `9 passed`；移动端静态门禁、TypeScript 和服务端 Python 编译通过。完整历史 pytest 仍不宣称全量通过，因本机缺少生产测试依赖且历史断言存在已记录漂移。

- 本轮收尾审计（2026-08-09）：服务器四个常驻单元仍为 `active/enabled`，`127.0.0.1:18020/8030/21434` 和公网 Tunnel 健康检查均正常，三个数据库仍为 WAL、完整性和外键通过，ASR/LLM/任务队列均为空。审计目录中未发现旧 `8002`、`18035`、`21436`、VibeVoice 或 WhisperLiveKit 的运行进程、systemd `ExecStart` 或活动 compact 源码引用；模型和精简 venv 均被现行服务引用，因此未误删。清除了 5 个过期手工运行 PID 文件及 `laoji-18035.log`、`schedule-ollama-21435.log` 两个旧端口日志；未触碰现行日志、模型、数据库、Tunnel token、其他用户目录或历史迁移证据。复核资源为 GPU0 `22964/32607 MiB`、GPU1 `31756/32607 MiB`（GPU1 未触碰），老记 API/ASR/Ollama/cloudflared RSS 约 `753/2356/2500/45 MiB`，`/home` 可用约 `517 GiB`。
- 配置与构建门禁已前移：`app.config.js` 对非开发构建要求设备注册引导密钥至少 32 字符；使用服务器受保护运行环境临时注入密钥后，`APP_ENV=production-rehearsal` release `1.0.6`/`versionCode=106` 于 11:23 重建成功，APK SHA-256 为 `86e9112bd978ccbaaa3a0d4359aa45f54135804c22e978a30b75e9701ec02a24`，APK 内 `appEnv=production-rehearsal`、引导密钥长度 64，入口门禁通过。当前 ADB 只有其他工作占用的 `emulator-5560`，本包未安装到该设备；老记专用 `emulator-5562` 当前不在线，真机验收按约定跳过。
- 当前工作树已形成本地可回溯检查点：commit `7ad25e4`，tag `laoji-device-primary-freeze-20260809`。没有推送远端；未纳入提交的自然语料、问答专题和历史审计杂项继续保留为脏工作区内容，未删除或重置。
- 设备原始源失败留存边界已补齐：设备资产没有转写任务，或当前最新任务为超过 24 小时的终态时，由现有 retention loop 清除源文件；queued/running、后续新任务和账号资产不受影响。隔离 SQLite/临时文件回归通过，生产现场清理返回 `(0, 0)`；源码备份、哈希和约束见 [`docs/device-source-failure-retention-audit-20260809.md`](device-source-failure-retention-audit-20260809.md)。

- 日程解析合同修复已部署并重启 API：有日期无钟点现在明确为全天，单一开始时间补一小时结束，范围起点不再因当前月份滚到下一年，模型不再凭空保留未在原文出现的提醒，标题清理“刚才/刚刚”控制壳。日程质量 `65 passed`，包含本轮安全契约更新的精简生产针对性集合 `91 passed`；真实 HTTP 样本、源码哈希、备份和未完成边界见 [`docs/schedule-parser-contract-r1-20260809.md`](schedule-parser-contract-r1-20260809.md)。
- 整理模板的旧 revision 硬编码已收口：四个内置模板当前均为 revision `2`，测试改为读取当前 revision，`_preserve_contextual_structured_summary` 不再把 `1` 当作固定基线；当前模板回归 `8 passed`，扩展合同相关回归 `3 passed`。决定/行动项不再作为模板独立段，模型臆造键会被忽略；证据见 [`docs/summary-template-revision-r1-20260809.md`](summary-template-revision-r1-20260809.md)。
- Android release 构建已完成：`android/app/build/outputs/apk/release/app-release.apk`，当前实际文件为 `versionName=1.0.6`、`versionCode=106`、SHA-256 `3faf199d8db165d75a7c35d326c1b10eeeadd4850db91e3f7491a4d46368efab`（已用 `aapt` 和文件哈希复核）。已仅安装到老记专用 `emulator-5562`；`emulator-5560` 未操作。启动后无 `FATAL EXCEPTION`、`laoji_start_auth` 或未捕获 React Native 异常；其余同日 hash 为历史构建记录。
- 本轮续做后的 release 仍为 `1.0.6`/`versionCode=106`，最终 SHA-256 为 `9801f2baf787540477fcb971768975a0be47aac8441d4fcc09fe96c766fd2a6d`，仅覆盖安装到 `emulator-5562`。最新启动 `Displayed ... MainActivity ... +404ms`，未发现 `FATAL EXCEPTION`、`laoji_start_auth` 或未捕获 React Native 异常。
- 本轮再收紧兼容边界后重新构建的 release 仍为 `1.0.6`/`versionCode=106`，SHA-256 为 `14d5ac7a44c1aed06eb81c85b49ba0be506590defbae65256227c8e01a790937`，已覆盖安装到 `emulator-5562`。旧账号兼容 API 缺少令牌时在网络请求前失败；Android guest 运行路径静态检查禁止旧 guest session/guest-summary；guest 待上传录音支持详情页手动重试并仍走设备上传器；后台补全按本机转写 revision 继续拉取实时草稿的最终结果，并用本机匿名任务注册表区分 queued/running、completed 与 no_speech/failed，删除会议时清理该注册表。
- 本轮继续修复上传完成边界：转写任务提示写入失败不再阻塞已成功的设备上传，并兼容设备服务滚动升级的三种任务字段；release `1.0.6`/`versionCode=106` 已重新覆盖安装 `emulator-5562`，SHA-256 为 `814ed80ac55c698b5d1bce0a133d81e6f68e5969aa37e31e8baf512c6526ca34`。
- 发布验收补上设备注册引导密钥：上一包 APK 的 `deviceBootstrapKey` 实际为空，无法支持新安装设备注册；已从服务器受保护运行环境临时注入后重建并覆盖安装 `emulator-5562`。新包 `1.0.6`/`versionCode=106` SHA-256 为 `3faf199d8db165d75a7c35d326c1b10eeeadd4850db91e3f7491a4d46368efab`，启动后真实日志出现 `device_service_ready`，密钥未写入源码或工作区。
- `verify_compact_apk_config.py` 已增加引导密钥门禁：长度不足 32 的 APK 直接失败，防止以后再次生成无法注册新设备的构建。
- 实时 VAD A/B 已找到当前可接受的活动候选：会议段上限 4.5 秒、日程仍 6 秒。设备公网五路并发 p95 为 `1.661 s`，12 秒真实样本得到 3 条连续非空文字且无错误；候选源码与回滚备份记录在 `docs/qwen-vad-meeting-4500.md`。该结果降低了性能缺口，但不替代长时、多说话人和真机质量验收。
- 本地静态检查已通过：`npx tsc --noEmit`、`git diff --check`、`python3 tools/verify_compact_source_config.py` 均返回 0；未创建 Git 提交，也未推送远端。
- 本机主数据与 APK 入口静态检查也通过：`python3 tools/verify_device_primary_source.py`、`python3 tools/verify_compact_apk_config.py android/app/build/outputs/apk/release/app-release.apk` 均返回 0。
- 本轮追加检查：`npx tsc --noEmit`、`git diff --check`、`python3 tools/verify_device_primary_source.py`、`python3 tools/verify_compact_source_config.py`、`python3 tools/verify_compact_apk_config.py android/app/build/outputs/apk/release/app-release.apk` 均返回 0；未创建 Git 提交，也未推送远端。
- 设备主链路隔离已补强：问答和整理在设备绑定缺失、携带本机笔记或旧附件/续写请求时均不再回退到 guest 兼容接口，不会把本机转写发送到旧账号链路；现改为明确的中文不可用状态。对应源码检查和 release 构建均已通过。
- 服务器实时核对（2026-08-09）：`laoji-api.service`、`laoji-asr.service`、`laoji-ollama.service`、`cloudflared.service` 全部 `active` 且 enabled；老记仅监听 `127.0.0.1:18020/8030/21434`，Cloudflare Tunnel 转发到 18020，公网 `https://laoji.cloud/api/ready` 与 loopback 均为 `ready=true`，ASR/LLM/embedding/VAD/CAM++ 就绪，队列与活动租约均为 0，三库 WAL/完整性/外键检查通过。
- 混合并发最终验收已通过：5 路设备鉴权公网 WSS 实时会议与 2 路真实 WAV 设备资产上传/转写同时运行；实时共收到 10 条最终文字且全部正常排空，后台任务分别完成并得到 5、4 条文字，资产/任务 ID 唯一。实时片段结束到结果的 p50/p95/最大延迟为 `1629.73/1846.47/2049.23 ms`，p95 低于 2 秒门槛。临时 7 个会议、epoch 和设备主记录均已删除；完整证据见 [`docs/compact-production-mixed-concurrency-20260809.md`](compact-production-mixed-concurrency-20260809.md)。
- 公网安全边界复核和最小修复已完成：设备/地址响应统一 `no-store`，未授权设备、无效分享 token 和未授权共享读取均 fail-closed；ready 响应无 secret/token/password/正文/坐标；日志与最近 journal 未发现凭据正文；环境密钥和 Tunnel token 权限均为 `0600`。仅重启 `laoji-api.service` 后四项常驻服务和队列仍正常，证据见 [`docs/security-boundary-audit-20260809.md`](security-boundary-audit-20260809.md)。
- 双设备隔离验收已通过：设备 A 能读取自己的会议，设备 B 对该会议的读取和资产写入均为 `404/MEETING_NOT_FOUND`，B 的列表为空；错误 epoch 为 `409/EPOCH_UNKNOWN`，错误凭据为 `401/DEVICE_CREDENTIAL_INVALID`。临时会议、epoch 和设备主记录已清理，证据见 [`docs/device-isolation-audit-20260809.md`](device-isolation-audit-20260809.md)。
- 存量生成文本简体化迁移已完成：生产 `local.db` 中 948 条旧转写及整理/分享生成字段统一经过 OpenCC `t2s`；迁移后所有扫描字段稳定为简体，行数、WAL、完整性和外键均保持正常。迁移前备份及脚本记录见 [`docs/simplified-data-migration-20260809.md`](simplified-data-migration-20260809.md)。
- 当前资源复核（迁移后）：GPU0 使用 `22962/32607 MiB`，其中老记 ASR/API/Ollama 进程及两个 Ollama runner 合计约 `16810 MiB`，GPU0 仍有约 `9645 MiB`；GPU1 使用 `31756/32607 MiB`，属于其他服务未触碰。`/home` 剩余约 `517 GiB`、根分区约 `146 GiB`；四项 systemd 服务 active，ready/三类队列/活动租约均正常。
- `guest` 启动审计日志已完成语义核对：它是本机 SQLite 的历史兼容键，不是旧匿名网络会话。`meeting_audio_upload_queue_inspected` 明确标记 `scope_kind=device-local, network_path=device-v1`；录音恢复和 canonical JSON 镜像明确标记 `network_path=none`。设备整理/问答分支不回退 `guest-summary`/`guest-questions`，Android 运行路径不调用 `guest-sessions`。现场证据与不迁移 SQLite scope 的理由见 [`docs/device-scope-runtime-audit-20260809.md`](device-scope-runtime-audit-20260809.md)。
- 上述语义修复后的最终 release `1.0.6`/`versionCode=106` 已覆盖安装到 `emulator-5562`，APK SHA-256 为 `f226843a3a53d59704dd2f1f01e9e395118f1f80921447fe3b2e57d00dd3fef4`；构建时临时注入引导密钥，启动现场出现 `device_service_ready`、`scope_kind=device-local`、`network_path=device-v1/none`，未出现 `FATAL EXCEPTION`、`laoji_start_auth` 或旧 guest endpoint。
- 04:51 的服务器复核：四个单元仍 `active/enabled`，公网 DNS 返回 Cloudflare 地址，loopback 三端口未变，内外 `/api/ready` 均 `ready=true`；GPU0 `23192/32607 MiB`、GPU1 `31756/32607 MiB`，`/home` 剩余约 `516 GiB`，ASR 三类队列均为 0，仍接受新音频。
- 历史合同测试已在不修改生产精简环境的临时依赖目录中重跑：地址进程内缓存、统一日程 Qwen ASR、设备合同、安全、LLM、检索和存储准入针对性集合 `25 passed`。旧测试中要求 SQLite 地址缓存和旧 ASR 代理的 3 个失败已改成当前合同断言；完整历史 pytest 仍未全量执行，证据见 [`docs/history-test-contract-20260809.md`](history-test-contract-20260809.md)。
- 生产活动源码与工作区 server overlay 已同步：补回设备 `/schedule/clarify`、分片上传和设备 WebSocket 鉴权等已部署能力；同步前本地副本已备份，三个文件均已 Python 3 编译检查。证据见 [`docs/production-source-sync-20260809.md`](production-source-sync-20260809.md)。
- 同步后临时审计暴露并修复了 1 条由测试清理脚本留下的孤儿 `device_epochs` 行；修复前已备份，修复后完整性和外键检查恢复为 0，生产 `close_epoch` 路径未改动。证据见 [`docs/orphan-device-epoch-repair-20260809.md`](orphan-device-epoch-repair-20260809.md)。
- 设备原始音频临时留存验收已通过：真实 6 秒 WAV 转写完成后，资产变为 `processed`，`storage_path` 清空且服务器文件不存在，生成转写仍可读取；临时设备数据已清理。证据见 [`docs/device-source-retention-audit-20260809.md`](device-source-retention-audit-20260809.md)。
- 当前资源（服务器实时采样）：API RSS 约 1,516,968 KiB，ASR 约 2,401,940 KiB，Ollama 主进程约 104,548 KiB，生成/embedding runner 约 579,644/1,368,988 KiB，cloudflared 约 42,128 KiB；GPU0 使用 23,346/32,607 MiB，其中老记 API/ASR/Ollama 进程约 17,194 MiB；GPU1 使用 31,756/32,607 MiB，仍属于其他服务且未触碰。服务数据所在 `/home` 分区剩余约 517 GiB（根分区为另一挂载点，剩余约 146 GiB）。
- 旧运行时最终审计：当前进程、systemd `ExecStart`、活动 compact 源码和模型目录没有 8002/18035/21436、VibeVoice 或 WhisperLiveKit 的可调用依赖；模型仅为 Qwen3-ASR-1.7B、`qwen3.5:9b`、`qwen3-embedding:0.6b` 及 VAD/CAM++ 支持模型。历史文档、兼容 schema、测试和迁移备份中的旧字符串是审计资料，不是运行依赖，因此没有删除它们，也没有触碰其他用户目录。
- 因此本轮可以关闭“构建/部署/常驻服务/旧运行时审计/实时+后台公网并发门槛/日程解析合同/模板 revision”事项；整体仍不能标记为完全验收：真机验收按要求跳过，问答专题、真实声纹纵向质量和摘要引用等旧历史断言仍未完成。本文更早记录的 3.61 秒或 2.44 秒 p95 是旧客户端/旧探针的历史结果，由本节新的有效 WAV 混合负载证据覆盖，不再作为当前门禁结论。
- 公网性能缺口已有独立网络证据：当前 Cloudflare Tunnel 连接到 `lax01`、使用 QUIC；本机关闭代理连续请求 `/api/ready` 的总耗时约 `0.89–2.22 s`，因此 2 秒实时门槛受公网/Tunnel 路径显著影响，不能归因给 ASR 推理或 SQLite 锁。未擅自切换 Tunnel 协议，避免影响现有公网入口。
- （历史探针）本轮只读复核确认 `cloudflared.service` 当时以四条 QUIC 连接运行，UDP/TCP 预检均通过，未为追求 p95 擅自改协议或中断入口；其性能结论已由顶部有效 WAV 混合负载证据覆盖。
- 本轮补充了同一时刻 origin/Tunnel 对照：服务器 loopback `18020/api/ready` 五次为 `21–90 ms`，公网 `https://laoji.cloud/api/ready` 五次为 `428–758 ms`。这只能证明 Tunnel 增加了稳定网络开销，不能替代实时 WebSocket+后台上传的最终 p95，也没有据此改动生产配置。
- 本轮对真实设备 Bearer + 公网 WSS 做了 ASR 微批实验：单会话首段约 `1.1 s`；五路并发旧串行路径 p95 约 `2.87 s`。r1 条数微批曾降到 `2.26 s`，但会把长段合成过大批次；r2 放宽到 8 条后出现 19 秒音频批次、单次推理约 `1.99 s`，已撤销。当前活动版本为 r3：单 worker、微批最多 8 项且总音频不超过 14 秒，五路并发实测 p95 `2.44 s`，仍未达到 `2 s` 门槛但没有再出现超大批次。r4 的双 worker 实验使 6.3 秒段推理升至约 `2.3–2.5 s`，已回滚；实验备份留在服务器 `backups/asr-microbatch-20260809-r1..r4`。
- 本轮对 Tunnel 做了可回滚 A/B：临时停止 systemd 连接并以同一 token 单独运行 HTTP/2，15 次串行 `/api/ready` 为 p50 `1.139 s`、p95 `2.126 s`、最大 `2.519 s`；三轮 5 路并发最大分别为 `1.538/2.068/2.851 s`。结果没有稳定优于现有 QUIC，测试结束已恢复并确认 `cloudflared.service active`、初始协议 `quic`；没有持久化协议或 DNS 改动。
- 客户端本轮新增 60 秒设备就绪证明缓存和并发去重，避免每次实时录音重复注册/读取能力；设备鉴权失败或关闭数据域会主动失效缓存。设备转写轮询对 404/网络失败加入有界指数退避，避免已删除或尚未建立的远端绑定每 15 秒重复请求；前台仍会继续重试。该改动已通过 TypeScript/静态检查并随上述 APK 构建。此前“待下一版 APK 验证”的旧记录已由本页顶部最新 APK/混合并发证据覆盖。
- 日程解析的最后一条旧 guest 计算链路已切断：复杂文本、追问补充和文件语音现在统一调用设备 `/api/device/v1/schedule/parse`、`/schedule/clarify`、`/schedule/parse-audio`；远端新增设备 clarify 路由（源码 SHA-256 `f8c6b8ead988de0447837807a9e5d97d4cee0ee3f328188370cde347d249d58d`）并完成备份 `backups/device-schedule-clarify-20260809-023713`。临时设备真实测试返回 `parse=200`、`clarify=200`、`parse-audio=200`，随后 epoch 删除 `200`；API 重启后 ready/队列仍正常。

## 2026-08-09 续做证据（以此覆盖同名旧状态）

### 设备绑定、并发与清理补充

- 修复账号删除触发器的设备域误拦截：`data_epoch_id` 非空的设备会议不再被同数字的旧账号删除墓碑阻断；无 epoch 的账号会议仍保持阻断。真实 SQLite 回归为“设备插入/普通更新通过、设备切回无 epoch 被阻断、账号插入被阻断”，外键检查通过。远端源码/数据库备份在 `backups/account-deletion-device-trigger-20260808-171154`。
- 设备鉴权热路径改为只读，不再每个分片/轮询请求更新 `last_seen_at`；WAL 只在 schema 初始化时设置，避免并发请求争用 SQLite 写锁。设备分片写入及合并移到线程池，设备会议删除先清理旧表的 `transcript_lines`、`meeting_segments`、`period_summaries`、`final_summaries`，epoch 关闭同时清理设备幂等和删除 outbox。远端备份分别为 `backups/device-auth-readonly-epoch-cleanup-20260808-173003`、`backups/device-upload-nonblocking-20260808-172508`、`backups/device-delete-child-cleanup-20260808-173202`。
- loopback/SSH 转发的五次实时会议 + 两条后台上传真实并发测试通过：实时段结束到首条文字 p95 为 `903.21 ms`，后台两任务均完成，会议删除和 epoch 清理成功，未留 active 临时设备；服务端队列恢复为 0。
- （历史探针）关闭本机代理后经 `https://laoji.cloud` 的早期同一测试曾得到实时 p95 `3611.69 ms`；带本机代理的结果无效，不纳入验收。该旧尖峰已由本页顶部有效 WAV 混合负载重新测量并覆盖。

- 日程语音设备 WebSocket 临时设备直连已通过：注册 201、WebSocket open、服务端下发 `config` 与 `ready_to_stop`、正常关闭 1005，随后 epoch 删除 200；过程中没有旧 guest session。
- `laoji-ollama.service`、`laoji-asr.service`、`laoji-api.service` 均已各自有序重启并恢复。ASR 重启后调用真实 16 kHz WAV 返回 `200` 和文本“嗯。”，`/api/ready` 的 `last_inference.success=true`；API/LLM/任务队列恢复为 ready/0。
- 位置服务发现并修复设备鉴权遗漏：`/api/location/reverse` 现在接受设备 Bearer + `X-Laoji-Data-Epoch`，同时保留账号及游客/IP 限流。部署前备份为远端 `backups/location-device-auth-20260809-000326`；重启后从公网 `https://laoji.cloud` 用临时设备真实高德反向解析成功，返回深圳市福田区地址，epoch 已清理。
- 旧 8002、18035、21436、VibeVoice、WhisperLiveKit 的监听、进程和 compact 部署引用均无命中；模型清单只有 Qwen3-ASR-1.7B、`qwen3.5:9b`、`qwen3-embedding:0.6b`。未删除其他用户目录，未把小型历史说明备份冒充重资产。
- （历史 8 月 8 日构建）release `1.0.6` 的 SHA-256 为 `301a1983b9dbc27693315d5d528d173d36784630608ef934d418b271e9178849`；当前构建以本文顶部“最终对齐”中的工作区文件和哈希为准。
- 本次续做仍没有宣称真机、多媒体全格式、超过一小时音频、声纹纵向样本、问答专题和完整历史 pytest 全部通过；实时/后台并发 p95 已由本页顶部有效证据通过。
- 五种媒体格式短样本矩阵已真实通过：从同一 30 秒会议片段生成 WAV、M4A、MP3、MP4、WebM，经公网设备分片上传和 Qwen 转写后每种均得到 8 条文字，任务状态均为 `completed`。
- 两条不同会议同时上传并转写（WAV + M4A）已通过：两条任务均 `completed`、各有 8 条文字，墙钟约 47.47 秒、最慢约 45.01 秒；没有同步冲突或跨会议覆盖。该证据不等于“实时会议 + 后台上传 p95”门槛通过。
- 真实中断恢复已补齐：ASR 重启任务由 `attempt=1` 恢复到 `attempt=2` 完成；API 转写重启同样由 `attempt=1` 恢复到 `attempt=2` 完成并返回 8 条文字；整理任务重启前为 `STARTED`，重启后为 `SUCCESS`，结果为结构化文档且只有一份任务。
- 长音频已真实通过：使用样本目录中真实 4690 秒视频截取的 3660 秒（61 分钟）M4A，15.0 MB，经分片上传后转写完成，1051 条文字，最大结束时间 3,660,608 ms，覆盖率约 100.02%；临时资产、任务和 epoch 已清理。
- 上传阶段重启已真实通过：先上传 9 片中的 3 片，重启 API 后重放前 3 片并补齐其余分片，complete 的 SHA/大小校验通过，转写完成并返回 8 条文字。
- Ollama 中断恢复已真实通过：整理任务重启前为 `STARTED`，重启 `laoji-ollama.service` 后最终为 `SUCCESS`；API/ASR/LLM 队列回到 0。

## 2026-08-08 本轮补充（以此覆盖前文同名旧状态）

- 设备整理的 `retain_generated_result` 已从“只改幂等键”改为真实留存策略：关闭时只在 `summary_tasks_v2` 保留任务元数据和最多 24 小时结果正文，过期清理只清正文；开启时结果不设该过期时间。设备整理不再写 `final_summaries` 或 `summaries/final` 文件。
- 本机删除会议后会立即写入只含会议 UUID 的设备删除 outbox；删除不等待网络，联网/回到前台时自动幂等清理远端临时绑定，失败按退避重试。
- 本机删除讲话人时姓名立即从本机映射移除，匿名声纹删除进入独立 outbox；列表先隐藏待删除项，服务端删除由启动/前台 drain 幂等重试。
- 讲话人删除 outbox 已改为严格持久写入；本机存储失败会向用户报告未排队，不再静默吞掉清理提示，证据见 [`docs/device-speaker-outbox-hardening-20260810.md`](device-speaker-outbox-hardening-20260810.md)。
- 讲话人列表增加本机匿名 profile 缓存，在线结果只做刷新；断网时不再因服务端列表失败而丢失本机讲话人入口。
- 设备问答默认不写账号兼容问答表；开启质量改进后才把不含原问题、姓名和转写正文的匿名答案/引用 ID写入 `device_quality_candidates`，默认 TTL 30 天。清理循环同时清理设备候选和过期整理正文。
- 服务器已执行真实设备整理探针：关闭/开启各成功返回 `SUCCESS`，前者 `expires_at` 已设置、后者未设置，二者均未新增 `final_summaries`；临时设备与会议已清理。
- 已安装开发依赖仅用于测试，测试结束后已从生产 compact venv 移除；运行环境未新增 Whisper/VibeVoice/Gradio/Celery/Redis 等旧依赖。
- （历史 8 月 8 日构建）release `1.0.6` 的 SHA-256 依次为 `7ce37b4c2267e540b55d4452f08fd647fff5029b4941917647984904a548a9ec` 与 `9cee1b3395f6d885fd1b6769f0f3234b0a53b07e69d57e6a10c61714e6e6655d`；当前安装包以本文顶部“最终对齐”中的工作区文件和哈希为准。
- `emulator-5562` 断网验证：本机新建、保存、打开、删除日程成功，删除后显示本机撤销入口；会议列表、设置、质量开关和版本信息可用；无崩溃。真机仍按用户要求跳过。
- 服务器定向合同/任务测试 `15 passed`；完整历史 pytest 为 `281 passed / 48 failed`，失败集中在此前模板 revision、问答审查次数和旧日期规则断言，不能视为本轮留存改造失败，也不能宣称全量通过。
- 实时审计显示老记只监听 `127.0.0.1:18020/8030/21434`，Cloudflare Tunnel active；旧 8002/18035/21436、VibeVoice/WhisperLiveKit 进程和 compact 目录引用均未发现。`SMART-MEETING2*` 等其他用户目录和进程不在本计划范围，未触碰。
- 设备会议删除接口已在删除数据库行前安全回收设备资产路径，远端部署备份为 `device-delete-source-20260808-195523`；仅重启 `laoji-api.service` 后 `/api/ready` 仍正常，未重启 ASR/Ollama。
- 实时 WebSocket 已从旧 guest session 切换到设备 Bearer + `X-Laoji-Data-Epoch`；会议开始前建立设备会议绑定，日程语音使用未落库的设备短期 session。模拟器真实会议录音已在服务器看到设备绑定和 Qwen WebSocket accepted，未出现 guest-sessions 请求。
- 隧道下的中等 WAV multipart 上传曾真实超时；现已部署设备分片 PUT/complete 服务端合同，并将客户端分片大小调整为 512 KiB。模拟器真实收到 6 个分片（均 200）、complete 200、transcription 202，最终队列上传成功；无人声样本的转写任务按预期以 `no_speech` 失败，不是上传失败。

## 目标架构

| 进程/入口 | 目标职责 | 当前状态 |
| --- | --- | --- |
| Cloudflare Tunnel（公网） | `laoji.cloud` 的 HTTPS/WSS，转发到 API | 已启用并实测 |
| `laoji-api` | 账号兼容层、设备、日程、会议、上传、整理、问答、分享、地址、持久任务 | `127.0.0.1:18020` 运行中 |
| `laoji-asr` | Qwen3-ASR-1.7B，实时/日程/离线统一入口 | `127.0.0.1:8030` 运行中 |
| Ollama | `qwen3.5:9b` 生成 + `qwen3-embedding:0.6b` embedding | `127.0.0.1:21434` 运行中 |

原计划中的 Nginx 仍在主机运行，但当前 Tunnel 直接转发 18020；其他主机服务不属于老记迁移范围，不触碰。

## 分阶段状态

### 阶段 0：冻结与可回溯

状态：部分完成。

- 已保留 release APK、版本号、SHA-256、设备样本会议 ID 和服务器备份。
- 当前工作树有大量既有脏改动，禁止 `reset`、`clean`、覆盖或自动提交。
- 数据库完整性、服务 cwd、核心进程和模型路径已核对。
- 本轮留存边界修复已提交为 `3925285`、`f9a26a7`，仅在本机分支保留、未推送；既有未跟踪质量语料和审计杂项继续保留。

### 阶段 1：统一 ASR 与分片上传

状态：核心链路、已选媒体/恢复矩阵和实时+后台公网并发门槛均完成；问答专题、声纹纵向质量和真机验收按当前范围延期。

- 8030 保留兼容接口并提供统一批处理能力。
- 客户端在隧道环境使用 512 KiB 原生二进制分片（服务端允许上限 4 MiB）；服务端按片原子落盘，complete 时按序合并、校验大小和 SHA-256，再原子提交。
- 失败可使用同一上传 ID 和幂等键重试。
- 真实 MP4 样本已经完成 5 片上传、Qwen 转写和 115 条文字记录拉回。
- 新增实时会议设备 WebSocket 与中等 WAV 分片真实闭环已通过模拟器；无人声录音任务得到明确 `no_speech` 终态。
- WAV、M4A、MP3、MP4、WebM 短样本、61 分钟长音频、上传中断恢复、双后台并发以及 5 路实时+2 路后台公网混合负载均已有真实证据。

### 阶段 2：统一会议资产与恢复

状态：设备资产、删除通知、恢复和旧运行时审计完成；没有发现属于老记且仍需删除的旧重资产，其他用户目录不在范围内。

- 设备会议、RecordingAsset、转写任务均按设备 ID + data epoch 隔离。
- 服务端不覆盖已有可用 Transcript；任务和资产状态可查询。
- 设备删除通知由移动端本机 outbox 持久保存；本地删除、回收站删除和永久删除均先完成本机状态，服务端清理由前台/启动 drain 负责，不再把网络失败作为用户删除失败。

### 阶段 2 补充证据

- `35db3b69-4b35-479e-97e3-8f248227743b` 已由旧队列重试成功并保留；空的失败测试记录 `1ec866b0-6df7-444e-9cfa-62d4d0dc940c` 已从应用和服务器定点清理，清理前快照保存在服务器备份目录。

### 阶段 3：持久整理任务与模板输出

状态：真实样本通过。

- `summary_tasks_v2` 保存任务、租约、检查点和 dedupe key。
- 真实任务 `04fa8abf-35ad-4c64-83b0-ec9c2df9146e` 成功完成，重开页面可恢复。
- 输出已归一为结构化文档：概述、必要的关键讨论和候选行动项；不再输出独立“决定”模块或 JSON。
- 同一输入的 dedupe key 只有一条任务；强制重新生成仍然是新任务，这是预期语义。
- API/ASR/Ollama 在上传、转写和整理阶段的中断恢复均已有真实现场证据；重复任务与结果降级未出现。

### 阶段 4：统一 LLM Provider 与问答

状态：基础服务已统一，问答专题延期。

- 生成和 embedding 均走 21434；`/api/ready` 能报告两种模型和队列状态。
- 交互/后台队列存在，当前空闲。
- 会议问答的引用收纳、答非所问和百条以上样本评估按用户决定延期；不能标记为已验收。

### 阶段 5：设备化入口与移动端

状态：完成当前可用闭环，设备留存策略已补齐。

- 移动端默认统一使用 `https://laoji.cloud`，WSS 从同一基址派生。
- 设备注册、data epoch、分片上传、转写、整理和恢复已接入 release APK 1.0.6。
- 真实样本已在 `emulator-5562` 完成；真机验收按用户要求跳过。

### 阶段 6：公网入口与资源隔离

状态：入口和旧运行时审计完成；其他用户服务不纳入清理。

- `cloudflared.service` enabled/active，公网 `/api/ready` 返回 ready。
- 18020、8030、21434 均只监听 loopback；Tunnel 是唯一老记公网入口。
- Cloudflare 负责 TLS，当前不需要另行修改其他站点的 Nginx 规则。
- 实时进程/systemd/监听审计未发现上述旧服务；compact 运行树只保留 Qwen-ASR、Ollama 两个目标模型和三项 systemd 服务。历史删除证据仍以服务器迁移基线为准；不得删除 `SMART-MEETING2*` 等其他服务资产。

### 阶段 7：最终验收与发布

状态：部分完成；设备切片、日程 WebSocket、三服务重启健康恢复、地址设备鉴权、媒体矩阵、持久任务恢复和公网实时+后台并发 p95 已通过，问答/声纹质量和真机验收仍延期。

剩余工作（不重复已完成项）：

1. 实时+后台公网并发 p95 已达到计划门槛；后续性能工作可作为长时 soak 或真实多人样本优化，不再阻塞本计划的混合并发验收。
2. 按用户决定继续延期会议问答专题和真实声纹纵向质量验收；真机验收继续跳过。
3. 可选地继续更新历史 pytest 中与问答审查次数、引用收敛和旧摘要结构不一致的断言；模板 revision、日程日期规则、地址缓存和统一 ASR 的旧断言已按当前合同收口，这不是当前设备主数据闭环的运行时阻塞。

## 当前资源基线

以服务器实时检查为准：

- laoji-api：单 worker，监听 18020。
- laoji-asr：单服务，监听 8030。
- Ollama：监听 21434，当前有两个 runner（生成与 embedding）。
- Cloudflared：约 44.7 MiB 常驻内存，active 超过两天。
- 最近一次进程采样：API RSS 约 1.66 GiB，ASR RSS 约 0.49 GiB，两个 Ollama runner RSS 约 0.43 GiB/1.85 GiB，Ollama 主进程约 96 MiB。
- 最近一次 GPU 采样：GPU0 24,122/32,607 MiB，GPU1 31,756/32,607 MiB；GPU1 与 PCB 等其他服务不在本计划范围内。
- 磁盘剩余约 516 GiB；服务就绪且没有队列积压。

GPU 显存、旧模型删除清单和完整资产体积必须在删除审计阶段重新采集，不能用历史估算代替实时值。

## 不可声称完成的条件

以下任一项未完成时，整体计划只能写“部分完成”：问答专题未验收、真实声纹纵向质量未验收、真机验收被跳过、或摘要/问答历史断言尚未更新。实时+后台公网并发 p95、媒体矩阵、任务重启恢复、旧运行时审计、公网入口健康状态、日程解析合同和模板 revision 不再列为未完成项。
