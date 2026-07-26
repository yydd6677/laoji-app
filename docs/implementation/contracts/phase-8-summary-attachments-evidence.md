# Phase 8 附件显式参与整理证据：ATT-01

状态：文字与照片附件的逐次选择、能力协商、任务身份、恢复重验、不可变图片快照和真实多模态请求格式已形成源码纵向切片。本文件只证明移动端源码、本机 deployment overlay、模拟器交互和轻量合同；目标服务当前仍未广告附件/图片能力，不代表真实视觉模型、真实账号、跨设备或 USB 真机已经完成。

## 产品与数据合同

- 选择整理模板后重新读取当前 scope/meeting 的附件；有附件才展示独立“选择附件”sheet。默认零选择，“取消”终止本次生成，“不使用”继续但不发送附件。分享页的附件勾选不会复用。
- 文字单条最多 2,000 字、合计最多 12,000 字；照片单张最多 25 MB、每次最多 4 张且合计最多 40 MB；混合选择总数最多 12。照片只允许登录账号选择 `synced`、无 pending operation 且具备 remote ID/revision、受支持 MIME、字节数和 SHA-256 的当前记录；游客照片严格关闭。
- 授权保存独立 request ID。文字保存稳定 ID、时间点、规范正文、SHA-256 和更新时间；照片保存本机附件 ID、远端 ID/revision、MIME、字节数、SHA-256 和更新时间，不保存本机路径。
- 授权与 Transcript、模板、历史参考共同进入 v6 input fingerprint，并完整写入 pending task。恢复或提交前重新读取 SQLite、重新请求 fresh capability 并逐字段核对；附件删除、正文/时间点变化、remote revision/MIME/大小/checksum/更新时间变化都会丢弃旧任务，不携带旧授权静默重提。
- 移动端发送文字前要求 fresh `summary_attachments_text`，发送照片前同时要求 fresh `meeting_attachments_v1 + summary_attachments_image`。旧缓存、旧服务、网络失败或 capability=false 都 fail closed；明确“不使用”不受该能力限制。
- 请求字段为 `attachment_authorization`。服务端重新规范正文、验证 SHA-256、去重并限制总量；授权完整进入任务 dedupe fingerprint、prompt 和 schema v2 的 `attachment_request_id`。客户端只接受 request ID 与本次授权相同的结果。
- 附件被标记为本场补充材料而非系统指令或 Transcript；服务端禁止为附件内容伪造 Transcript citation。有附件时禁用不接收额外上下文的 compact 路径，也不使用只检查转写的短问候确定性结果。
- 账号服务端对照片重新校验 owner、meeting、client ID、remote revision、时间点、MIME、大小、SHA-256 与 client update clock，再复制到请求独占的不可变任务快照。相同授权的 dedupe replay 清理本次多余副本；任务结束清理已用副本；进程中断残留由期限回收。
- CLI 支持可重复 `--summary-image`。Ollama 的最终 user message 使用真实 base64 `images`，OpenAI-compatible 使用 data-URI `image_url`；长 Transcript 的 Map 阶段仍只读 Transcript，图片只进入 Reduce。prompt 只记录图片序号，不以文件名或时间点冒充视觉理解。
- capability 只有在附件 schema 可查询且 `MEETING_SUMMARY_IMAGE_INPUTS_ENABLED=true` 时返回 `summary_attachments_image=true`。该开关必须由部署者在确认当前模型具备视觉能力后显式开启；源码存在不等于线上开启。

## UI 证据分类

组件：“选择附件”sheet

- Classification：LaoJi-only component；最近容器为会议详情中的飞书式 bottom sheet，不声称飞书 7.71.8 存在同名附件整理功能。
- `[SOURCE]`：复用 surface/mask/divider、52dp 标题栏、正文与次级文字层级、22dp checkbox、48dp/6dp Big Primary、固定错误槽和约 300ms 全高度进退场。
- `[PRODUCT]`：每次默认零选择；左侧“取消”、右侧“不使用”和底部“使用（N）”分别表达终止、空授权继续和明确授权。照片按 fresh capability 与同步当前性启用，不添加说明书式帮助段落。
- `[DEVICE]`：API 35、1080x2400 的 `emulator-5556` 上，文字附件 `00:42` 默认未选、照片 `01:28` 禁用；选中文字后按钮变为“使用（1）”。点击禁用照片没有改变选择；取消后重新进入恢复零选择。
- `[INFERENCE]`：文字/照片使用 36dp quiet icon slot；不可用照片保持 disabled 语义，是老记对既有附件类型和 Feishu 选择容器的组合。

## 轻量验证

### 文字附件历史基线

- `npx tsc --noEmit --pretty false`、`git diff --check` 与 Python `py_compile` 通过。
- 从实际服务端函数 AST 执行两个无落盘窄合同：附件正文/hash 校验通过，正文变化返回 409；附件 request/content 改变会改变服务端 fingerprint，有授权时 compact=false，prompt 包含正文和“不得伪造 Transcript 引用”约束。
- `:app:assemblePreview --parallel --max-workers=$(nproc)` 通过：627 tasks，59 executed、568 up-to-date，最终一轮 36 秒。
- 模拟器夹具包含一条文字附件和一条照片。UI tree 确认默认两个 checkbox 均未选、照片 `enabled=false`、提交按钮禁用；选中文字后只有文字 `checked=true`，按钮启用并显示“使用（1）”。
- 当前 18035 服务没有声明新能力。点击“使用（1）”后 sheet 保持打开并显示中文错误，没有进入 Summary POST；点击“不使用”后正常进入既有总结流程，随后只因当前会议服务不可达显示既有中文网络错误。
- 验证期间没有应用 FATAL、React Native exception、SQLiteException 或 IllegalStateException。
- 测试前 canonical DB 主文件/WAL/SHM 和 RKStorage/journal 已逐文件备份；恢复写回后的 SHA-256 分别为 `42ff97c95cc1bfdec2a1308048455b28a55be04d1ac66a846f725a807b4f5f93`、`63b56aa422452b0a1ed428deeb2914733e373a0c5b480516999852c581a23a0f`、`9fbd53a9519cb8954b91535bc61afa66288588a7fa4ceefefaea41ac05e5c1bd`、`b6794955bc10431175588d54942eee2b8c2b4fd3b1061bcab8d06ae906c76928`、`e3b0c44298fc1c149afbf4c8996fb92427ae41ac66a846f725a807b4f5f93`。冷启动回到原 `OccueneSmoke / 录音中断`，UI tree 不含附件夹具文本。
- 最终 APK 为 `android/app/build/outputs/apk/preview/app-preview.apk`，90,555,664 bytes，SHA-256 `f9eeb8194879594af5ff73028eee601bcc0ce0557ff9bd5df53db5be1ec620b4`；已覆盖安装到 `emulator-5556`，`lastUpdateTime=2026-07-26 01:25:47`。

### 照片多模态源码候选

- 移动端 `npx tsc --noEmit --pretty false` 与 `git diff --check` 通过；overlay 的 `ollama_client.py`、`main.py`、`map_reduce.py`、`summary_tasks.py`、`app_meetings.py` 和 capability 文件通过 `python3 -m py_compile`。
- 窄合同直接拦截两种 provider 的 HTTP 请求体：Ollama user message 含真实 base64 `images`，OpenAI-compatible user content 含 `data:image/jpeg;base64,...`；没有使用文件名替代图片字节。
- 指纹合同确认同一原始图片授权与增加服务器临时 `snapshot_path` 后的授权得到相同 dedupe fingerprint；快照合同确认流式前置 SHA-256/大小校验、受管目录复制、过期孤儿删除和请求目录清理。
- Preview 以全 CPU 并行构建通过：627 tasks，59 executed、568 up-to-date，39 秒。APK 为 `android/app/build/outputs/apk/preview/app-preview.apk`，90,961,888 bytes，SHA-256 `b8f710ad0f308cdc24237f395fa980735d2e635c35ad99b178cae5ede058b8ad`。
- 设备列表仅有 `emulator-5556`。APK 以保留数据方式覆盖安装，`versionCode=104`、`versionName=1.0.0-source-preview`、`lastUpdateTime=2026-07-27 00:37:09`；冷启动进入 `MainActivity`，进程存活，日志没有 FATAL、React Native exception、SQLiteException 或 IllegalStateException。真机已断开，因此没有 USB 结论。
- 实时 18020 capability 仍为 `summary_attachments_text=true`、`summary_attachments_image=false`，且响应没有 `meeting_attachments_v1`；18035 对该 capability 路径返回 404。故本候选只验证 fail-closed 启动，不存在可诚实执行的线上照片选择或真实视觉模型任务。

## 服务端边界

- 本机 overlay 的关键 SHA-256 为：`api/app_meetings.py` = `3436541dfc0fa9f9d80dce26bd0c2afd853114af2b49285ee5fda06e545fe3dd`，`summary_tasks.py` = `c4716f00b0c9f6a64429c55cbd0ad21935dfbaf1d728116047134d3b449e9541`，`backend/app/api/app_meeting_v2.py` = `dba5793ce690462e59198bc5e4d3d4cc6c5537c430140be56999ef2acf102dc5`，`meetingsummary/main.py` = `375d282655641e269b6b4af1cb3dbb8e8b50eb2620405bab6711e396cffb2da2`，`map_reduce.py` = `b4bdbc630334d9d86dd3df81d58c516891f93e1b85f18aaf0751558dcf274bfe`，`ollama_client.py` = `e83f4c466e430b85ef19123cd09741b260d03744f40a4c9e74ee301c21748739`。
- 这些文件是 `/home/yydd/桌面/light_plan/server-work/summary` deployment overlay，不是运行服务。对已知 `zhong@183.36.243.124` 的非交互 SSH 认证仍返回 `Permission denied (publickey,password)`；未猜密码、未修改共享服务器目标工作区，也未启动或重启 18020/18035。
- 因此已完成的是照片多模态的移动端与服务端源码纵切；服务端同步、开关启用、真实视觉模型输出、真实账号/跨设备、USB 真机仍未完成，不能扩写为线上多模态闭环。
