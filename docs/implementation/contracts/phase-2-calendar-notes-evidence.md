# Phase 2 日程绑定与我的笔记证据

本文只记录可复核的轻量合同、构建结果和未决边界，不保存正文、账号、录音、数据库副本、截图、视频或设备序列号。

## 当前结论

Phase 2 尚未满足退出条件。NOTE-01 已从本机纵向路径扩展到账号人工笔记的窄云同步；CAL-01 也已形成第一条账号纵向闭环：本机 occurrence 唯一绑定、独立 outbox、能力探测、会议级 GET/PUT、按 occurrence 查询、乐观并发、跨设备安全附着、冲突保留和删除后 orphan 都已接通。日历详情、通知动作和 Widget 明确动作在没有本机关联时共用 occurrence 云端回查；已有本机关联仍保持离线可打开。游客迁移 journal 仍按创建、日程关联、人工笔记、文字记录、整理版本、行动项、录音和状态分别记账、分别重试；单个录音失败不会阻断其他阶段或下一场会议。

目标服务源码现有 `manual_notes_v2` 与 `occurrence_links_v2` capability、认证 GET/PUT、持久幂等结果和 revision precondition，并已与客户端协议同步；目标 18020/18035 服务未启动，所以新表未在目标数据库实例化，也没有真实鉴权请求、跨设备收敛或真实账号迁移证据。两个设备创建不同本机会议时，客户端现会保留本机会议和全部内容为独立记录，把原 occurrence 身份写入不可变 detached history，并为可读取或仍在录制的本机录音持久化恢复任务。已结束的录音通过原生流式复制加入日程当前关联的目标会议；来源 MeetingNote、来源 RecordingAsset 和原文件不移动、不删除。该闭环只有合成数据模拟器证据；多 RecordingAsset 的服务端上传、转写、跨设备下载仍未实现。

## 已实现合同

| 范围 | 当前合同 |
|---|---|
| 笔记事实源 | `manual_notes.content` 仅由用户编辑写入；纯文本、CRLF 归一化、最大 200000 UTF-16 code units |
| 保存事务 | 每次变化在 SQLite transaction 中校验 scope、meeting lifecycle 和 expected revision；相同内容是幂等成功，提交后 revision 单调递增 |
| Summary 失效 | 人工笔记实际变化后，只把当前 `ready` 结构化整理版本改为 `stale`；版本仍保持 current 和可读，不自动重新生成 |
| 自动保存 | 停止输入 400 ms 后保存；App 离开 active、离页、返回和结束录音前触发 flush；串行写会追赶到最新 draft |
| 云同步 | 账号保存与本机事务一起写入 `manual_note.upsert` outbox；只在实时 capability 为真时上传，创建使用 `If-None-Match: *`，更新使用 `If-Match`，陈旧 claim 可回收，重试保持同一请求快照和幂等键 |
| 拉取合并 | 详情/录制页进入及回前台执行会议级 GET；完全相同版本可安全附着，有本机待写或 unresolved conflict 时禁止静默覆盖，干净本机只接受单调云端 revision |
| 冲突保护 | 409/412 和拉取分歧均保存本机/云端候选并阻塞旧 outbox；状态槽显示“笔记同步冲突，点击处理”，用户明确选择本机或云端后才原子解决；本机 draft 始终先落盘且不会被 last-write-wins 清空 |
| 录音页 | 内容区为“我的笔记 / 实时文字”两个稳定页面；标题、位置、计时、波形和底部控制不随切页重建或移动 |
| 详情页 | 常驻五页 pager：我的笔记、文字记录、整理结果、讲话人、信息；每页独立保存滚动状态 |
| Snapshot | TS/Kotlin schema 同步为 v2；字段缺失使用安全默认值；notes generation 独立于其他页面 |
| 用户术语 | 当前相关 surface 使用“会议记录、会议录音、我的笔记、文字记录、整理结果、讲话人”；错误和状态均为中文 |
| 迁移 journal | v1 可恢复升级为 v2；旧 event 因 v1 未保存 cloud ID，会使用稳定 request ID 幂等重放并补齐映射 |
| 迁移分阶段 | create、occurrence、manual note、transcript、summary versions、actions、markers、status、audio 各有完成位和错误位；每阶段完成后立即持久化 journal |
| 日程关联迁移 | 先迁移全部日程，再使用 cloud event ID、cloud meeting ID 和原 occurrence date 在账号 scope 重建唯一 link；重试不重复绑定 |
| Occurrence 服务端身份 | 用户内 `(source_event_id, occurrence_date)` 唯一，且同一用户的一条会议根最多有一个 occurrence；两设备并发由数据库唯一约束和 409 当前 payload 裁决 |
| Occurrence 服务端写入 | `occurrence_links_v2` 控制认证 GET/PUT；创建使用 `If-None-Match: *`，更新使用 `If-Match`，写入保存 revision、单调客户端时间和持久幂等结果 |
| 计划快照 | 服务端首次创建时写入 `meeting_schedule_snapshots_v2`；后续更新只允许 link 元数据和 active/orphaned 状态变化，快照或 occurrence identity 分歧返回 409，绝不覆盖记录时计划 |
| Occurrence 上行 | 创建会议事务同时写独立 `meeting_occurrence` outbox；会议根取得 remote ID 后才 claim，陈旧 claim 可回收，重试固定请求快照，ACK 必须逐字段匹配本次 occurrence 和计划快照 |
| Occurrence 下行 | 日历详情先读本机并做增量云端查询；通知动作和 Widget 明确动作仅在没有本机关联时回查云端，避免离线时阻断已有会议。若本机还没有会议根，先刷新账号会议列表，再按 remote meeting ID 安全附着；缺失、陈旧、身份分歧分别处理 |
| 409/412 收敛 | 若冲突响应中的 current 仍是本次 occurrence、同一云端会议和同一不可变计划快照，则复用严格 parser 与下行 merge 安全 ACK；不同会议、身份或快照分歧仍进入 unresolved conflict，不因状态码直接覆盖本机资产 |
| 双会议保护 | 云端 occurrence 指向另一条本机会议、目标会议已有其他 occurrence、本机墓碑或计划快照分歧时写 unresolved conflict、阻塞旧 outbox并保留全部本机资产；真正双会议且目标已同步时，日历动作显示“处理关联”，其他无法安全自动处理的分歧继续阻止创建 |
| 双会议恢复 | 单一 SQLite 事务先把本机 link 与计划快照写入 `meeting_occurrence_detached_history`，并为当时所有可复制或仍在录制的 RecordingAsset 写入 `meeting_recording_merge_tasks`；随后完成旧 occurrence outbox、解除本机 link、附着严格匹配的云端 link 并解决冲突。目标会议、远端 payload、occurrence identity、快照或录音集合任一并发变化都回滚；本机 MeetingNote 及其全部内容继续独立保留 |
| 冲突录音恢复 | migration v19 持久化 source/target asset identity、来源快照、attempt、retryable/error 和 completed 状态。原生 MediaIngest journal 以 `copying -> prepared -> ready` 流式复制到目标会议独立目录；只有 SQLite 原子插入目标 RecordingAsset 并完成任务后才 acknowledge journal。进程在 rename、数据库提交或 acknowledge 前退出时，下一次启动从 journal 继续；失败只重试该录音，不删除来源文件或阻塞其他会议内容 |
| 多录音详情与分享 | 目标会议以同一播放器展示主录音和恢复录音；只有多于一段可播放录音时才显示 44 dp 固定选择槽，当前选择决定播放、时长和显式音频分享。恢复录音未上传时标记“仅本机”；永久删除目标会议时同时清理其导入目录，来源会议目录不受影响 |
| 删除与恢复 | 日程删除事务最终确认后，按 occurrence/following/series 把相应 link 标为 `orphaned` 并排队同步，不删除会议或快照；同 identity 日程重新出现并打开详情时，本机 link 恢复 active |
| 笔记迁移 | 非空游客笔记复制到账号 scope 的空笔记容器并标记 dirty；账号已有不同内容时拒绝自动覆盖 |
| 源数据保留 | 访客 AsyncStorage、SQLite sidecar 和录音文件均不因迁移完成而删除；声纹资料不进入迁移输入 |

## UI 证据说明

Component: 我的笔记编辑器与详情五 Tab

- Classification: LaoJi-only / capability-reduced Minutes surface。
- `[PRODUCT]`: 人工主稿与 AI 结果分离；录音页底部控制切页不动；所有术语和提示使用中文。
- `[SOURCE]`: 复用既有 source-mapped Minutes surface、text/divider/primary token 和原生 pager 容器；飞书 7.71.8 没有与老记人工笔记完全相同的组件，不声称直接复刻。
- `[DEVICE]`: 模拟器 1080×2400、420 dpi、手势导航下，五页可切换、输入和冷启动恢复通过；临时调整为 480 dpi 的 360 dp 等效宽度后五个 Tab 均完整可读，前三个核心 Tab 无裁切。
- `[INFERENCE]`: 16 sp 无卡片纯文本编辑器、固定 32 dp 状态槽、录音页双内容页和详情页 notes-first 顺序。
- `[INFERENCE]`: 远端冲突复用既有 Minutes 版本选择 sheet：12 dp 顶角、16 dp 页边距、6 dp 卡片/按钮、48 dp 单一提交动作及约 300 ms 全高度进退；飞书没有老记人工笔记云冲突的直接页面。
- Intentional deviation: 当前没有富文本工具栏、AI 渐变、保存按钮或持续“自动保存”提示。

Component: 日历详情 occurrence 同步状态

- Classification: `[PRODUCT]` 用户自有 occurrence 动作合同，复用现有 Calendar 详情动作槽。
- `[PRODUCT]`: 本机/云端身份尚未安全收敛时主动作必须是 disabled“正在准备”，不得让日程空白区域或失败回调创建第二条会议。
- `[SOURCE]`: 沿用当前 Calendar 蓝色动作、固定高度和中文状态槽；本次没有新增尺寸、颜色、阴影或动效。
- `[INFERENCE]`: `日程关联待处理` 与 `会议记录正在同步` 是老记状态文案；飞书没有老记跨设备 occurrence 冲突的直接页面。

Component: 双会议日程关联处理 sheet

- Classification: LaoJi-only / user-owned conflict recovery。
- `[PRODUCT]`: 没有本机录音时用户明确选择“保留本机记录，使用云端关联”；有可恢复录音时主动作改为“保留并加入本机录音”。本机内容不得静默删除，日程空白区域仍不执行关联处理。
- `[SOURCE]`: 复用既有飞书风格 bottom sheet、UDButton 48 dp / 6 dp、16 dp 页边距、语义色和完整高度约 300 ms 进退；飞书没有与老记双会议冲突相同的业务页。
- `[INFERENCE]`: 两张只读会议卡说明本机记录和日程当前关联，单一主按钮提交事务；固定错误槽保证失败时按钮不位移。录音复制发生失败时，详情固定状态槽提供“加入/重试”，不把已完成的 occurrence 事务伪装成失败。
- Intentional deviation: 只安全复制本机录音；文字记录、整理结果、我的笔记和行动项继续属于来源会议，不自动拼接到目标会议。目标录音也不会在服务端多资产合同完成前伪装成已同步。

Component: 会议详情多录音选择

- Classification: LaoJi-only / capability-reduced Minutes 详情控件。
- `[PRODUCT]`: 来源会议和原文件必须保留；目标会议可播放每一段已加入录音，分享跟随用户当前明确选择。
- `[SOURCE]`: 沿用现有 Minutes 中性 page/primary-soft/text token、6 dp 半径、regular 字重和 44 dp 最小操作槽；飞书 7.71.8 没有与老记冲突录音恢复完全相同的控件，不声称直接复刻。
- `[INFERENCE]`: 36 dp 可见 chip 位于 44 dp 固定触控宿主，selected 只用蓝色文字和浅蓝背景表达，不加粗；pressed 状态不改变行高。只有本机副本的标签追加“仅本机”。
- `[DEVICE]`: 1080×2400、420 dpi 模拟器合成双会议中，第二段切换后总时长由 00:02 变为 00:03，可完整播放；分享 ZIP 中音频与当前第二段逐字节一致。来源会议仍显示原 00:03 录音并可播放。
- Intentional deviation: 当前不提供混音、拼接时间线、重命名录音或上传状态入口；这些属于后续 RecordingAsset 服务端合同，而不是在选择器中伪造。

## 已执行验证

- `npx tsc --noEmit --pretty false`：通过。
- `./gradlew :app:compilePreviewKotlin --parallel --max-workers=$(nproc)`：通过。
- `./gradlew :app:assemblePreview --parallel --max-workers=$(nproc)`：通过；包含 lint vital、R8 和四 ABI native build。
- `git diff --check`：通过。
- 服务端人工笔记隔离候选：`tests/test_manual_notes_v2.py` 与既有 action 窄合同合计 `5 passed`。
- 服务端目标源码同步后复跑同一组窄合同：`5 passed`；部署前旧文件已备份到 `backups/20260724-manual-notes-v2-v1`，18020/18035 未启动。
- 服务端 occurrence 隔离候选：`tests/test_occurrence_links_v2.py` 为 `2 passed`；覆盖 create/replay/lookup/orphan、用户内唯一冲突、快照不可变和账号隔离。
- 服务端目标源码同步后复跑 occurrence 窄合同：`2 passed`；6 份部署文件与 overlay SHA-256 逐项一致，旧文件备份位于 `backups/20260724-occurrence-links-v2-v1`，18020/18035 未启动。
- 模拟器保留数据覆盖安装：PackageManager 返回 `Success`，随后冷启动无应用进程 FATAL。
- 详情页五个 pager 页面真实渲染；输入临时笔记后切换到文字记录再返回，内容保持。
- 输入后强制停止 App 并冷启动，已落盘内容恢复；随后清除临时内容并再次冷启动，确认测试正文未遗留。
- 480 dpi 的 360 dp 等效宽度下五个 Tab 边界依次连续且最后一项未超出屏幕；验证后已恢复模拟器原 420 dpi。
- 当前模拟器原有 `OccueneSmoke` 数据存在 legacy/repository lifecycle mismatch 1；canonical read 默认关闭，界面使用 legacy 事实源。本项是预存测试状态，不计作 NOTE-01 通过证据，也未通过清数据掩盖。
- 新 Preview 保留数据覆盖安装后，旧 `OccueneSmoke` occurrence 可从月视图进入详情并显示“继续记录”；详情原生 root/surface 正常，crash/SQLite migration log scan 为空。Preview 为不可调试包，未直接导出数据库核对 v15 列，因此这只证明升级冷启动与旧 occurrence 读取路径没有显性失败。
- 加入 migration v16 后再次保留数据覆盖安装；冷启动 repository audit 为 `status=consistent`、`legacy_meetings=1`、`projected_meetings=1`、`context_mismatches=0`，且无 migration、SQLite、外键或启动异常。当前 Preview 不可调试、模拟器 adbd 也不能 root，因此没有直接导出数据库证明 detached-history 表结构；真实冲突事务仍按未设备验证记录。
- migration v19 合成双会议夹具完成一次真实恢复：第一次来源 WAV header 被启动恢复修正后，复制结果与数据库旧 checksum 不符，任务按设计进入可重试失败；修正夹具 checksum 并重装 Preview 后，启动恢复从原生 journal 完成同一任务，没有绕过校验。
- 临时切换同签名 Debug 只用于读取合成数据库与文件，核对任务为 `completed`、目标恰有 primary + secondary、secondary 使用独立复制 URI、来源 primary 和来源文件仍存在，且 `.media-ingest-v1.json` 已在数据库提交后 acknowledge。随后重新安装 Preview，并恢复 `codex-laoji-recmerge-pretest-20260725` 快照。
- 目标详情实测切换第二段后时长为 00:03、完整播放无崩溃；系统分享器生成 `info.audio` ZIP，解包音频 checksum 与第二段及来源录音一致、与 00:02 主录音不同。来源会议返回后仍可播放原录音。
- Preview 重装、强停和冷启动后目标仍显示两段录音；临时夹具验证结束后已恢复测试前快照，原有 `OccueneSmoke` 数据和界面恢复，未保留合成会议。
- 最终交付 bundle 强制重生成；APK 内 `assets/app.config` 直接核对 canonical read/write、账号根写和账号上传写均为 `false`。默认包覆盖安装后冷启动无 FATAL、SQLite 或 migration 异常。

## 当前安装包

- 路径：`android/app/build/outputs/apk/preview/app-preview.apk`
- 包名：`com.laoji.app`
- 版本：`1.0.0-source-preview`（versionCode 101）
- 大小：90447420 bytes
- SHA-256：`fd810cfd5115a5a69d79729afa79d48d9493669edc0fe4b2760aaff8fd6dca7d`
- 构建时间：`2026-07-25 21:51:27 +0800`
- 安装状态：已在 `emulator-5556` 恢复测试前快照后保留数据覆盖安装；PackageManager `lastUpdateTime=2026-07-25 21:52:02`。默认能力冷启动、原数据列表和 crash/SQLite migration log scan 均通过。当前 `adb devices` 没有 USB 真机，因此尚未安装到手机。

## 未决项与停线边界

1. 人工笔记与 occurrence v2 已进入目标源码但运行服务未启动；当前只能声明源码合同和客户端闭环，不能声明线上 capability、鉴权读写或跨设备同步成功。结构化 Summary version 和 marker 的线上 v2 capability 仍未确认。
2. 游客迁移 v2 已有恢复 journal 和本机账号作用域实现，但没有可用测试账号的真实服务端任务证据；在完成 event/meeting 幂等响应、单音频失败重试、退出重进和 link 回查前，不得宣布迁移验收通过。
3. 人工笔记冲突候选选择已实现，但尚未用两个真实账号设备制造并解决一次 409/412。Occurrence 双会议的本机独立保留、detached history、可恢复录音复制、多录音播放与当前录音分享已用合成模拟器闭环；真实双设备制造、线上 occurrence 响应和目标服务多 RecordingAsset 上下行仍未完成。
4. USB 真机未连接，录音页键盘/inset、切页视频、停止录音前 flush 和覆盖安装仍需真机复核。
5. 普通包仍未完成 scope-wide canonical cutover；本次最终 Preview 已确认 canonical read/write、账号根写和账号上传写继续关闭。
6. 通知和 Widget 的无本机关联回查、同会议 409/412 安全收敛及不同会议恢复已有客户端代码路径，但目标服务停止期间不能形成真实鉴权、冲突响应、跨入口或跨设备运行证据。
