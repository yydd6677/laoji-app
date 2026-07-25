# Phase 8 附件显式参与整理证据：ATT-01

状态：文字附件的逐次选择、能力协商、任务身份、恢复重验和服务端文本上下文已形成纵向切片；照片在当前模型链中明确 fail closed。本文件只证明移动端源码、本机 deployment overlay、模拟器交互和轻量合同，不代表目标服务、真实模型、账号同步或 USB 真机已经完成。

## 产品与数据合同

- 选择整理模板后重新读取当前 scope/meeting 的附件；有附件才展示独立“选择附件”sheet。默认零选择，“取消”终止本次生成，“不使用”继续但不发送附件。分享页的附件勾选不会复用。
- 第一版最多选择 12 条文字附件，单条最多 2,000 字、合计最多 12,000 字。授权保存独立 request ID，以及每条附件的稳定 ID、`kind=text`、时间点、规范正文、`sha256` 和更新时间。
- 授权与 Transcript、模板、历史参考共同进入 v4 input fingerprint，并完整写入 pending task。恢复或提交前重新读取 SQLite 并逐字段/哈希核对；附件删除、正文变化、时间点变化或更新时间变化都会丢弃旧任务，不携带旧授权静默重提。
- 移动端在发送附件内容前要求 fresh `summary_attachments_text` capability；旧缓存、旧服务、网络失败或 capability=false 都停留在选择页并显示“附件暂时无法用于整理。”。明确“不使用”不受该能力限制。
- 请求字段为 `attachment_authorization`。服务端重新规范正文、验证 SHA-256、去重并限制总量；授权完整进入任务 dedupe fingerprint、prompt 和 schema v2 的 `attachment_request_id`。客户端只接受 request ID 与本次授权相同的结果。
- 附件被标记为本场补充材料而非系统指令或 Transcript；服务端禁止为附件内容伪造 Transcript citation。有附件时禁用不接收额外上下文的 compact 路径，也不使用只检查转写的短问候确定性结果。
- 当前 CLI/模型调用只有文本消息合同，没有可靠图片输入。能力因此明确 `summary_attachments_image=false`；照片在 sheet 中显示时间点和“暂不可用”，但不可勾选、不会上传，也不会把文件名解释为图片内容。

## UI 证据分类

组件：“选择附件”sheet

- Classification：LaoJi-only component；最近容器为会议详情中的飞书式 bottom sheet，不声称飞书 7.71.8 存在同名附件整理功能。
- `[SOURCE]`：复用 surface/mask/divider、52dp 标题栏、正文与次级文字层级、22dp checkbox、48dp/6dp Big Primary、固定错误槽和约 300ms 全高度进退场。
- `[PRODUCT]`：每次默认零选择；左侧“取消”、右侧“不使用”和底部“使用（N）”分别表达终止、空授权继续和明确授权。照片因能力不足禁用，不添加说明书式帮助段落。
- `[DEVICE]`：API 35、1080x2400 的 `emulator-5556` 上，文字附件 `00:42` 默认未选、照片 `01:28` 禁用；选中文字后按钮变为“使用（1）”。点击禁用照片没有改变选择；取消后重新进入恢复零选择。
- `[INFERENCE]`：文字/照片使用 36dp quiet icon slot，照片以 disabled 语义呈现，是老记对既有附件类型和 Feishu 选择容器的组合。

## 轻量验证

- `npx tsc --noEmit --pretty false`、`git diff --check` 与 Python `py_compile` 通过。
- 从实际服务端函数 AST 执行两个无落盘窄合同：附件正文/hash 校验通过，正文变化返回 409；附件 request/content 改变会改变服务端 fingerprint，有授权时 compact=false，prompt 包含正文和“不得伪造 Transcript 引用”约束。
- `:app:assemblePreview --parallel --max-workers=$(nproc)` 通过：627 tasks，59 executed、568 up-to-date，最终一轮 36 秒。
- 模拟器夹具包含一条文字附件和一条照片。UI tree 确认默认两个 checkbox 均未选、照片 `enabled=false`、提交按钮禁用；选中文字后只有文字 `checked=true`，按钮启用并显示“使用（1）”。
- 当前 18035 服务没有声明新能力。点击“使用（1）”后 sheet 保持打开并显示中文错误，没有进入 Summary POST；点击“不使用”后正常进入既有总结流程，随后只因当前会议服务不可达显示既有中文网络错误。
- 验证期间没有应用 FATAL、React Native exception、SQLiteException 或 IllegalStateException。
- 测试前 canonical DB 主文件/WAL/SHM 和 RKStorage/journal 已逐文件备份；恢复写回后的 SHA-256 分别为 `42ff97c95cc1bfdec2a1308048455b28a55be04d1ac66a846f725a807b4f5f93`、`63b56aa422452b0a1ed428deeb2914733e373a0c5b480516999852c581a23a0f`、`9fbd53a9519cb8954b91535bc61afa66288588a7fa4ceefefaea41ac05e5c1bd`、`b6794955bc10431175588d54942eee2b8c2b4fd3b1061bcab8d06ae906c76928`、`e3b0c44298fc1c149afbf4c8996fb92427ae41ac66a846f725a807b4f5f93`。冷启动回到原 `OccueneSmoke / 录音中断`，UI tree 不含附件夹具文本。
- 最终 APK 为 `android/app/build/outputs/apk/preview/app-preview.apk`，90,555,664 bytes，SHA-256 `f9eeb8194879594af5ff73028eee601bcc0ce0557ff9bd5df53db5be1ec620b4`；已覆盖安装到 `emulator-5556`，`lastUpdateTime=2026-07-26 01:25:47`。

## 服务端边界

- 本机 overlay 已更新 `api/app_meetings.py`、`summary_tasks.py` 和 capability 文件；最终 SHA-256 分别为 `71dd2fb2e791178fb5c14a02218d42e8a63eaf6250b00b03b39da1f806704e95`、`709878fd0f1948ecc5daa250c15570d8292a80144fde882dc39ce8bbc6c784f7`、`54c8ca5f67cb211791781e4a350f61862d6dbd4d30a2cceb538fd70da17a06d3`。
- 这些文件是 `/home/yydd/桌面/light_plan/server-work/summary` deployment overlay，不是运行服务。本轮 SSH 无非交互认证，未修改共享服务器目标工作区，也未启动或重启 18020/18035；因此没有真实模型输出、账号鉴权、线上 dedupe/恢复或跨设备证据。
- 照片视觉输入、附件账号同步和删除/冲突收敛仍属于 ATT-01 后续功能量；当前不得把文字附件闭环扩写为完整多模态附件整理。
