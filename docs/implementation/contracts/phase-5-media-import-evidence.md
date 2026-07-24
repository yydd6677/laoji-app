# Phase 5 导入、Marker 与分享：媒体导入本机纵向切片

状态：音频文件选择、Android 系统分享、专用导入确认页、app-private 摄取、统一会议落库和现有详情播放器已形成本机闭环。本文件记录轻量合同与模拟器实测，不代表服务端处理、视频导入或 Phase 5 退出条件已经完成。

## 当前范围

- 列表底部保留 64dp operation host，并提供“上传 + 录音”双入口。上传入口发出 `importMedia` semantic action；导入中维持 44dp 控件边界、显示固定进度槽并禁用重复点击。
- 文件选择使用 Expo SDK 54 `File.pickFileAsync(..., 'audio/*')`，由 Android `ACTION_OPEN_DOCUMENT` 返回 URI；进入确认页前通过原生 ContentResolver 读取真实文件名、MIME、大小和修改时间。
- config plugin 为 `MainActivity` 生成 `ACTION_SEND`、`ACTION_SEND_MULTIPLE` 和 `ACTION_VIEW` 的 `audio/*` intent-filter，并在 cold-start `onCreate` 与 hot-start `onNewIntent` 调用同一持久 inbox。
- inbox 最多保留 8 个待处理 Intent，按到达顺序消费。30 秒重复窗口使用小写 scheme/authority 与解码后的 path/query 形成规范 URI 身份；Provider 的 size/lastModified 不参与该短窗口身份，避免等价 URI 因编码或临时 grant 差异绕过去重。
- 第一版只接受一个音频 URI。多选、缺文件、不可读和不支持类型进入独立中文错误状态；确认、返回、无效分享和积压 Intent 不互相覆盖。
- Native `MediaIngestor` 将 URI 以 128KiB buffer 流式复制到 `filesDir/meeting-audio/imports/{meetingId}/`，不经 JS/base64。复制同时计算 SHA-256，使用 `.part`、文件 `fsync`、原子 rename、目录 `fsync` 和 `.media-ingest-v1.json` journal。
- 已知大小在复制前检查 10% 加 16MiB headroom；JS 当前上限为 1GiB，native 硬上限为 2GiB。复制后校验字节数，并用 `MediaMetadataRetriever` 拒绝无音轨或无法读取时长的文件。
- 当前开放 WAV、MP3、M4A/AAC、OGG、WEBM、FLAC 音频。视频 MIME 尚未注册或声明支持。
- `copying/prepared/ready` journal 支持原子改名中断恢复。文件复制成功而业务落库失败时保留 ready journal，用户可重试或稍后由启动恢复；不得用取消动作删除可能已被 SQLite 引用的音频。
- 业务层用稳定 meeting/asset ID 创建统一 `MeetingNote + RecordingAsset`，来源分别为 `file_import/share_intent` 与 `imported`，asset 初始为 `local_ready`，会议 `mode='offline'`。成功后才清 journal 和 Intent token，再进入既有详情与 MediaSession 播放器。
- 列表卡片使用安静的蓝色“已导入”状态；导入会议复用现有“我的笔记 / 文字记录 / 整理结果 / 讲话人 / 信息”和播放器，不复制第二套详情页。
- 文件选择和系统分享统一进入 `MeetingImportSheet`。确认页显示真实文件名/大小、可编辑标题、录制日期、录制时间和可选关联日程；日程选择在同一 sheet 内切页，已有会议的 occurrence 明确拒绝，不自动覆盖或伪造合并。
- 确认后的 `scopeKey/title/recordedAtMs/calendarContext` 先写 `meetingMediaImportDrafts:v1`，再开始复制。复制成功后强杀可从 native ready journal 与持久 draft 恢复；draft 作用域不匹配时阻止跨账号落库。
- 当前处理链没有语言字段或已验证的服务端请求合同，因此确认页不展示无效“语言”控件。语言选择要等上传/转写合同能真实消费并持久化该字段后再实现。

## UI 证据分类

组件：会议列表导入入口

- Classification：capability extension，最近容器为 Feishu Minutes 的底部 operation host。
- `[SOURCE]`：Feishu 7.71.8 `mm_home_layout_operation_bottom.xml` 使用上传与录音双入口、64dp host、44dp 操作高度、16sp 标签和 16dp glyph；老记沿用该几何和共享 Minutes token。
- `[PRODUCT]`：入口面向老记会议录音，用户可从文件选择或其他 App 分享导入；用户可见术语保持“会议记录 / 会议录音”，不出现飞书专有名词。
- `[INFERENCE]`：老记将来源产品的上传入口映射成本机摄取，具体能力并非声称来自飞书；“已导入”是老记来源状态。

组件：导入确认与错误提示

- Classification：LaoJi-only component，最近容器为 Feishu bottom sheet、UD input 和 UDButton；不声称来源产品存在相同导入页。
- `[PRODUCT]`：只展示真实文件、标题、录制时间、可选日程和提交/取消动作，不增加使用说明；错误、警告和状态全部为中文，多选明确提示“一次只能导入一个会议录音文件。”
- `[INFERENCE]`：固定高度 sheet 使用 52dp 标题栏、6dp input/row/按钮圆角、48dp 主按钮和固定错误槽；日程选择在同一 sheet 内切页。Android 键盘显示时按真实可用高度收缩，标题栏和主按钮保持可见，隐藏后底部 inset 归零。

## 轻量验证

- `npx tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过。
- `:app:compilePreviewKotlin` 与 `:app:assemblePreview`：通过；最终 assemble 共 627 个 task，59 executed、568 up-to-date。
- Android 文件选择器实际选择 `文件选择测试-01.wav`：确认框读取真实文件名，成功后详情标题为 `文件选择测试-01`；MediaSession 播放到约 1608ms 且 `error=null`，列表显示“已导入”。强停重启后 repository audit 为 `consistent`。
- 最终 Preview 从系统“文件”真实冷启动分享 `系统分享测试-02.wav`：确认框显示正确文件名，导入后进入标题为 `系统分享测试-02` 的统一详情。
- 冷启动导入完成数秒内，以同一 Downloads document 的 `raw:` 编码变体重发；页面保持详情且没有新增确认框，验证规范 URI 去重覆盖 acknowledgment 后窗口。
- 老记进程存活时从系统“文件”分享 `热启动分享测试-03.wav`：`onNewIntent` 路径显示正确确认框，导入后播放器显示 `00:03`。
- 系统“文件”同时选中两个 WAV，chooser 明确显示 `Sharing 2 files`；选择老记后只显示中文提示“一次只能导入一个会议录音文件。”，没有进入摄取。
- 两次有效分享后强停重启：`meeting_db_repository_read` 为 `status=consistent`、`legacy_meetings=3`、`projected_meetings=3`、`context_mismatches=0`，证明多选拒绝和重复 Intent 未创建额外会议；日志无应用 FATAL、`SQLiteException` 或 `no such column`。
- 专用确认页在 `emulator-5556` 实际显示 `文件选择测试-01.wav`、`50 KB`、标题、文件修改日期/时间和 `OccueneSmoke` 候选；日期和时间行分别打开 Android 原生 DatePicker/TimePicker。
- 标题键盘态实测发现 React Native Android `KeyboardAvoidingView` 在 `keyboardDidHide` 后残留底部偏移，导致标题栏越界和应用底栏外露。最终实现使用全屏遮罩与 Android 显示/隐藏分离的 keyboard inset：键盘态标题栏、输入框和 48dp 主按钮均可见，隐藏键盘及取消系统日期选择器后 sheet 恢复到屏幕底部。
- 选择已绑定的 `OccueneSmoke` 后点击“导入”，固定错误槽显示“该日程已有会议记录，请选择其他日程或不关联。”；未调用 native ingest，未新增会议。
- 验证后取消确认页并删除 Downloads 测试 WAV。最终冷启动审计为 `legacy_meetings=1`、`projected_meetings=1`、`context_mismatches=0`，日志无应用 FATAL、`SQLiteException` 或 `no such column`，模拟器未留下测试会议。
- 最终 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-24 03:52:35 +0800`，大小 `89,910,667` bytes，SHA-256 `45b8a5c0dc8e93d30a2f42a57da00f1c085556f3af773c19bedf2cd3bb85f433`。已覆盖安装到唯一设备 `emulator-5556`，包版本为 `1.0.0-source-preview`。

## 未完成边界

1. 当前没有 USB 真机；系统 chooser、不同 ROM 的 ContentProvider、App Lock、字体/密度和真实大文件性能仍缺物理设备验证。
2. 当前配置的会议服务端口不可达，本机导入后尚未接通 recording asset 服务端上传、转写、整理和独立失败重试；本切片只保证本机资产、详情与播放。
3. 视频尚未开放。七种音频格式的完整矩阵、0 字节、伪装扩展名、权限撤销、2GB 拒绝、复制中强杀和上传中断仍未执行，不能把单个 WAV 冒烟外推为格式全量通过。
4. 标题、时间和可选 occurrence 关联已实现；语言选择仍缺服务端可消费合同，已有会议只支持拒绝并重选/不关联，尚无显式合并流程。
5. 账号作用域的远端同步与真实账号迁移未验证；分层分享见 `phase-5-layered-share-evidence.md`，本机删除语义见 `phase-5-deletion-semantics-evidence.md`，远端 tombstone/soft-delete/回收站仍待服务端实证。
