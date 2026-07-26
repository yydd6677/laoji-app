# Phase 5 导入、Marker 与分享：分层分享本机纵向切片

状态：会议详情已从 `bundle/document/audio` 三选一改为内容级选择，形成安全默认、私人笔记二次确认、Marker/附件显式选择、文档/音频/ZIP 导出和最小审计的本机闭环。本文件记录轻量合同与模拟器实测，不代表可撤销分享链接、所有内容组合、物理真机或 Phase 5 退出条件已经完成。

## 当前范围

- Android 原生详情和通用详情复用同一个 `MeetingShareSheet`，按“基本会议信息 / 整理结果 / 行动项 / 文字记录 / 标记 / 附件 / 录音 / 我的笔记”八类内容逐项表达可用、选中和禁用状态。
- 每次打开重新计算安全默认：当前可用的基本信息、整理结果和行动项默认开启；文字记录、标记、附件、录音和我的笔记始终默认关闭。全部关闭时保留 48dp 提交槽位，但禁用“分享”。
- Marker 是独立内容 scope。用户显式选择后只导出按时间排序的时间点和用户标签；不因选择 Marker 暗中附带附近 Transcript。要包含文字记录必须另行勾选，删除后变为陈旧选择时以中文失败而不生成缺项文件。
- 基本信息只写标题、日期/时间和可选地点，不默认写参与人、内部处理状态、时长、token 或本机路径。
- 整理结果导出当前 active version；结构化结果排除 `action_items` section，旧 Markdown 回退会移除中文行动项 heading，避免与独立行动项重复。行动项只导出任务正文、状态、可选负责人和截止日期。
- 文字记录按时间、讲话人和正文生成纯文本；我的笔记按原文导出，提交前必须再次确认。确认框关闭后不保留勾选状态，下次打开恢复安全默认。
- 有文字内容且无录音时直接分享 UTF-8 `.txt`；只选录音时直接分享音频；文字内容与录音同时存在时生成 ZIP，并把文档、录音和 `share_manifest.json` 放入压缩包。
- 显式选择附件时，短文字/照片索引进入文档；只要包含照片就生成 ZIP，并复制应用私有原图。原图缺失会终止准备，不能让 manifest 声称已包含但产物实际漏图。
- 每次成功准备产物都生成 schema v1 manifest：会议 ID 的 SHA-256 前 16 位、导出时间、实际包含内容、Transcript revision 和 Summary version。manifest 不包含正文、access token、speaker embedding 或本机绝对路径。
- 直接文档或直接音频的 manifest 只作为 app-private sidecar 留在同一临时目录，不额外扩大系统分享内容；ZIP 中显式包含 manifest。
- 审计事件 `meeting_share_prepared` 只记录 `included_contents` 和 `artifact_kind`，不记录标题、正文、路径、会议 ID 或身份信息。
- 临时目录和 ZIP 使用既有 10 分钟清理合同：分享失败立即删除，分享完成后延迟删除，进程中断后由下次分享清理过期目录。
- 本机录音分享按 WAV、MP3、M4A、AAC、OGG、WEBM、FLAC 扩展名恢复对应 MIME，避免导入的非 WAV 文件被错误声明为 `audio/wav`。

## UI 证据分类

组件：分层分享 sheet

- Classification：LaoJi-only component，最近容器为 Feishu bottom sheet 与 Universe Design checklist/UDButton。
- `[SOURCE]`：沿用共享 surface/mask/divider/text/disabled/primary token；提交按钮使用 48dp Big Column、6dp radius、17sp regular，sheet 从完整测量高度以约 300ms 进出。
- `[PRODUCT]`：八类内容必须逐项授权；原始文字、Marker、附件、录音和私人笔记默认关闭；我的笔记需二次强调；用户未选择任何内容时不得提交。
- `[INFERENCE]`：八行 checkbox、标题栏关闭动作以及文字/音频/图片/ZIP 的组合规则是老记分享合同，不声称飞书 7.71.8 存在完全相同的会议分享页面。内容区在小屏可滚动，底部 48dp 主操作保持固定。

组件：私人笔记确认

- Classification：LaoJi-only privacy confirmation，复用现有中文 App dialog。
- `[PRODUCT]`：只说明“我的笔记会原样写入分享文件”，不增加使用说明；取消不得打开系统 chooser，继续才开始准备产物。
- `[INFERENCE]`：确认发生在 sheet 完整退出后，避免 dialog 与 sheet 叠层；取消后需重新打开并重新选择，确保旧授权不被隐式保留。

## 轻量验证

- `npx tsc --noEmit --pretty false`：通过；包括本机非 WAV MIME 修复。
- `:app:compilePreviewKotlin`：通过，232 个 task，5 executed、227 up-to-date。
- `:app:assemblePreview`：通过，627 个 task，58 executed、569 up-to-date。
- 实际导入会议 `文件选择测试-01` 打开 sheet：只有“基本会议信息”默认勾选；录音可用但默认关闭，整理结果、行动项和文字记录因无内容而禁用。
- 默认提交实际打开 Android 系统 chooser，文件名为 `文件选择测试-01_会议资料.txt`；审计为 `included_contents=info`、`artifact_kind=document`。
- 显式勾选录音后实际打开 chooser，文件名为 `文件选择测试-01_会议资料_<timestamp>.zip`；审计为 `included_contents=info.audio`、`artifact_kind=archive`。
- 在详情“我的笔记”写入本机冒烟文字后，该项从禁用变为可用但不自动勾选。显式勾选并提交后，实际出现标题 `包含我的笔记？`、正文 `我的笔记会原样写入分享文件。` 和 `取消 / 继续分享`；选择取消未打开 chooser。
- 取消确认后重新打开 sheet：基本信息恢复开启，录音和我的笔记都恢复关闭，证明授权状态不跨打开保留。
- 关闭唯一默认项后，UIAutomator 显示“分享所选会议资料” `enabled=false`，按钮尺寸和底部布局不移动。
- sheet 静态截图无文字、复选框、提交按钮或导航栏重叠；本轮交互日志未发现应用 FATAL、`SQLiteException` 或 `no such column`。
- 附件分享夹具中“附件”可用但默认关闭；显式勾选后 chooser 打开 ZIP，审计为 `included_contents=info.attachments`。ZIP 中资料索引保留时间点/文件名，原图哈希与私有源文件一致，manifest 不含本机路径。
- Marker 增量通过 `git diff --check` 与 `npx tsc --noEmit --pretty false`；普通 Android 页面已接入真实 canonical Marker 数组，manifest 新增独立 `markers` scope。该增量尚未重新构建或制造设备夹具，不能把静态合同写成 chooser 实测。
- 原六类分享验证后曾加载 `codex-laoji-import-pretest-20260724`；附件增量验证后再次以匹配的 SwiftShader renderer 加载 `codex-laoji-att01-pretest-20260725`，再覆盖安装最终 Preview。最终只读数据库为 `user_version=21`、`quick_check=ok`、0 条 Marker、0 条附件，分享夹具未残留。
- 当前最终 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，大小 `90,527,844` bytes，SHA-256 `3954445001ea8a97429a129d46846f59a586f49032438d1161b7eb2eea84e923`。已覆盖安装到唯一设备 `emulator-5556`，包版本为 `1.0.0-source-preview`。

## 未完成边界

1. 当前只有 `emulator-5556`，没有 USB 真机；不同 ROM chooser、字体/密度、TalkBack、App Lock 和物理返回手势仍未验证。
2. 当前导入夹具没有整理结果、行动项或文字记录；这三项的默认分支和内容格式已做实现审计，但尚未在同一真实会议上逐项打开 chooser。
3. WAV 的默认文档与文字+录音 ZIP 已实测；MP3/M4A/AAC/OGG/WEBM/FLAC 的 MIME 修复只完成静态合同与 TypeScript 验证，尚未逐格式分享给真实接收应用。
4. 未执行八类内容的完整组合矩阵、10 分钟真实等待清理、分享中强杀或超大录音打包；这些按当前“轻测试、轻校验”目标后置。
5. Marker 已并入分层 sheet；可撤销分享链接仍属于 P2，尚未实现。同步感知删除仍是 Phase 5 后续纵切。
