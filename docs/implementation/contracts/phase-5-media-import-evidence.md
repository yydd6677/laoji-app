# Phase 5 导入、Marker 与分享：媒体导入纵向切片

状态：音频/视频文件选择、Android 系统分享、app-private 摄取、新建会议记录、加入已有会议、多 RecordingAsset 上传和逐资产转写已经形成移动端与目标 18020 的纵向闭环。本文件分别记录源码、模拟器和线上 HTTP 证据；它们不代表 USB 真机、第二台移动设备或全格式兼容矩阵已经完成。

## 当前范围

- 列表底部保留 64dp operation host，并提供“上传 + 录音”双入口。上传入口发出 `importMedia` semantic action；导入中维持 44dp 控件边界、显示固定进度槽并禁用重复点击。
- 文件选择使用 `MeetingMediaPickerContract` 发出 Android `ACTION_OPEN_DOCUMENT`。远端实时 capability 未明确声明视频时只请求 `audio/*`；本次 fresh capability 明确列出视频 MIME 后，chooser 才加入 MP4、WebM、MOV 和 MKV。进入确认页前通过原生 ContentResolver 读取真实文件名、MIME、大小和修改时间。
- config plugin 为 `MainActivity` 生成 `ACTION_SEND`、`ACTION_SEND_MULTIPLE` 和 `ACTION_VIEW` 的 `audio/*`/`video/*` intent-filter，并在 cold-start `onCreate` 与 hot-start `onNewIntent` 调用同一持久 inbox。分享进来的视频仍必须再次取得 fresh remote capability；旧缓存、网络失败或服务未声明时 fail closed。
- inbox 最多保留 8 个待处理 Intent，按到达顺序消费。30 秒重复窗口使用小写 scheme/authority 与解码后的 path/query 形成规范 URI 身份；Provider 的 size/lastModified 不参与该短窗口身份，避免等价 URI 因编码或临时 grant 差异绕过去重。
- 每次只接受一个媒体 URI。多选、缺文件、不可读和不支持类型进入独立中文错误状态；确认、返回、无效分享和积压 Intent 不互相覆盖。
- Native `MediaIngestor` 将 URI 以 128KiB buffer 流式复制到 `filesDir/meeting-audio/imports/{meetingId}/`，不经 JS/base64。复制同时计算 SHA-256，使用 `.part`、文件 `fsync`、原子 rename、目录 `fsync` 和 `.media-ingest-v1.json` journal。
- 已知大小在复制前检查 10% 加 16MiB headroom；JS 当前上限为 1GiB，native 硬上限为 2GiB。复制后校验字节数，并用 `MediaMetadataRetriever` 拒绝无音轨或无法读取时长的文件。
- Native allowlist 开放 WAV、MP3、M4A/AAC、OGG、WebM、FLAC 音频和 MP4、WebM、MOV、MKV 视频；`MediaMetadataRetriever` 在复制后继续验证真实音轨和时长，无音轨视频不会生成会议记录。视频是否出现在入口由本次实时服务 capability 决定，而不是由扩展名单独决定。
- `copying/prepared/ready` journal 支持原子改名中断恢复。文件复制成功而业务落库失败时保留 ready journal，用户可重试或稍后由启动恢复；不得用取消动作删除可能已被 SQLite 引用的音频。
- 新建路径用稳定 meeting/asset ID 创建统一 `MeetingNote + RecordingAsset`，来源分别为 `file_import/share_intent` 与 `imported`，asset 初始为 `local_ready`，会议 `mode='offline'`。已有会议路径通过 `AttachImportedMeetingMediaUseCase` 在一个 canonical SQLite transaction 中验证 scope、目标生命周期、capture 状态和 asset identity，再插入 primary/secondary RecordingAsset、推进 capture/upload、使旧整理结果 stale、推进 canonical revision 并同步 legacy mirror；任一步失败整笔回滚，不移动或覆盖既有正文，也不猜测旧 Transcript 属于新录音。
- 文件复制成功但目标随后消失时保留 native ready journal 和持久 draft，重新打开确认页选择保存位置；只有 SQLite 成功后才 acknowledge journal/Intent token。账号会议随后恢复 RecordingAsset v2 上传与逐资产转写发现，旧 Summary AsyncStorage task 同时清理。
- 列表卡片使用安静的蓝色“已导入”状态；导入会议复用现有“我的笔记 / 文字记录 / 整理结果 / 讲话人 / 信息”和播放器，不复制第二套详情页。
- 文件选择和系统分享统一进入 `MeetingImportSheet`。默认“新建会议记录”时显示真实文件名/大小、可编辑标题、录制日期、录制时间和可选关联日程；“保存到”可切到近期非录音中的会议，选择后隐藏新建专属字段，主动作改为“加入”。日程已有会议时仍明确拒绝 occurrence 重绑，用户应改用“保存到”选择该会议。
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
- `[PRODUCT]`：只展示真实文件、保存目标，以及新建时需要的标题、录制时间、可选日程和提交/取消动作，不增加使用说明；错误、警告和状态全部为中文，多选明确提示“一次只能导入一个会议录音文件。”
- `[INFERENCE]`：sheet 使用 52dp 标题栏、6dp input/row/按钮圆角、48dp 主按钮和固定错误槽；新建模式上限 620dp，选择已有会议后的精简模式上限 348dp，不为被隐藏的标题/时间/日程保留大块空白。Android 键盘显示时按真实可用高度收缩，标题栏和主按钮保持可见，隐藏后底部 inset 归零。

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
- 实时 capability 开启后，Android chooser 同时显示 MP4 和 WAV；`IMP视频验证.mp4` 的确认页显示视频图标、真实文件名和大小。新建后既有 MediaSession 读取约 2 秒音轨，无崩溃或 SQLite 缺表/缺列。
- 再选择 `IMP追加录音.wav`，经“保存到 → IMP视频验证 → 加入”后，详情显示“录音 1 / 录音 2”，第二条实际播放到约 3 秒并进入逐资产文字处理。最后的 348dp 精简面板重新构建后在同一模拟器复核，只保留文件、保存目标、固定错误槽和加入按钮。
- 验证后把 `IMP视频验证` 移入既有 30 天回收站，并删除 Downloads 中两份测试媒体；账号会议按既有保留合同不绕过回收站物理删除。活动列表不再显示该测试会议。
- 最终 Preview：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-26 11:24:27 +0800`，大小 `90,781,316` bytes，SHA-256 `e34435e05b02f97b5a7c5a411351ba9a5f65bd2293364c764b77dc530cae6e91`。`assemblePreview` 627 tasks、74 executed，通过后已覆盖安装到唯一设备 `emulator-5556`，versionCode 104；日志未发现应用 FATAL、`SQLiteException`、`no such table` 或 `no such column`。

## 目标服务与真实 HTTP 证据

- 目标工作区：`/home/zhong/laoji-service-platform/smart-meeting-ai/backend`；只重启 18020，18035 和旧 8020 未替换。部署前备份为 `/home/zhong/laoji-service-platform/backups/20260726-media-import-video-v1`。
- 当前进程：18020 PID `353426`，18035 PID `3293181`。当前文件 SHA-256：`app_meeting_v2.py=54e244c81d1bd1f3c024721e7b6eb3ab2865a04beca2747c9b3bde541873186c`、`app_recording_v2.py=710216d36b06397d12b28e89a05378b3969263a2e5883b6cc7efc76d72fd74cc`、`meetings.py=16e1a202ac4e5dfe57a744bce3ef3a4be4f5511bca529520ca7c22a333b6f851`。
- 实时 `/api/laoji/capabilities` 返回 1GiB 上限及七种音频、四种视频 MIME。MP4/WebM/MOV/MKV 通过 ffmpeg 显式选取第一条音轨并转为 16kHz、单声道、16-bit PCM；无音轨真实失败。
- 纯音调 MP4 已验证上传、认证下载 SHA-256 对账和音轨抽取，转写因没有可识别文字而失败；服务日志确认已得到 `32768 samples / 16000 Hz`，不是容器解析失败。含真实中文语音的 MP4 又完成 capability、注册、流式上传、下载对账和逐资产转写，job 首次 attempt 即 completed；服务端测试会议随后软删除。

## 未完成边界

1. 当前没有 USB 真机；系统 chooser、不同 ROM 的 ContentProvider、App Lock、字体/密度和真实大文件性能仍缺物理设备验证。
2. 七种音频和四种视频的完整设备/服务组合矩阵、0 字节、伪装扩展名、权限撤销、2GiB 拒绝、复制中强杀和长期上传中断仍后置；单个 WAV 与两个 MP4 证据不能外推为所有编码器和 ContentProvider 均兼容。
3. 标题、时间、可选 occurrence 和已有会议显式加入已实现；语言选择仍缺服务端可消费合同，不展示无效控件。
4. 第二台移动设备恢复新增 secondary、同一账号长期离线后重试和 USB 真机仍未验证；分层分享见 `phase-5-layered-share-evidence.md`，删除/保留语义见 `phase-5-deletion-semantics-evidence.md` 与 `phase-5-retention-cleanup-evidence.md`。
