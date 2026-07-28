# 候选版 V3 集中证据

状态：同一候选代码线已完成 V3 第 2 条“录制主链”和第 7 条中的同账号第二实例 pull/真实 409/412 选择；后续 MRK-01 又在两份独立 Android 模拟器数据上完成 Marker 新增、首次登录恢复、精确跳转和删除墓碑收敛。紧邻前一 Preview 完成稳定回溯包的游客日程、会议、录音和人工笔记保留升级。顶部当前包继续保留这些功能，并补齐 SUM-03 section 人工编辑、引用移除与可恢复 v36 覆盖；同一账号保留数据又完成双录音整批重转写、Summary lineage、正常软键盘、冷启动和分享/删除隐私只读检查。完整录制、账号恢复和来源跳转仍包含分轮证据；模拟器不能替代物理手机，当前 APK 尚未覆盖安装到 USB 真机。

## 候选身份

- APK：`android/app/build/outputs/apk/preview/app-preview.apk`
- 移动端代码内容基线：`81fe86d fix: preserve summary lineage during transcript reprocessing`
- 版本：`versionCode=104`，`versionName=1.0.0-source-preview`
- 构建时间：`2026-07-29 02:26:41 +08:00`
- 大小：`91,091,308` bytes
- SHA-256：`634999b97df998ab0ca7fd6ca09d91f6658f5962d1ab7265ab013722321b716c`
- `emulator-5556` 保留数据覆盖安装时间为 `2026-07-29 02:34:04 +08:00`；设备 `base.apk` SHA-256 与上述产物完全一致。
- 稳定回溯标签继续固定在 `stable-before-meeting-memory-roadmap -> cde96f9d5266961e380957893ecba39855aea39b`。

## 当前包：日程入口、录音处理与远端版本收敛

- `[DEVICE]` 只使用老记候选 AVD `emulator-5556`；KataCR 的 `emulator-5560` 未操作。账号作用域新建日程 `V3日程入口验证`，`sourceEventId=39`、occurrence 为 `2026-07-28`。
- 日程详情点击“开始记录”进入同名会议；返回日程后显示“继续记录，正在录音”，再次进入恢复同一原生录音服务，没有创建第二条会议。结束后生成 `04:09` 本机录音，日程动作变为“查看记录”，点击后仍打开同一 MeetingNote。
- 日程提醒通知的显式“开始记录”动作打开这条已结束的 `04:09` 记录；`laoji://calendar/occurrence?...&action=meeting&origin=widget` 也打开同一记录，`action=open` 只打开日程详情。三条动作期间没有新的 `meeting_create`；冷启动 canonical 审计始终为 4 条会议且 missing/extra/duplicate/context mismatch 全为 0。通知权限只为本轮验证临时授予，结束后已恢复为未授予。
- Quick Settings Tile 初始显示“会议录音 / 开始记录”；点击后创建临时会议并成功持续录音，系统 Tile 切为 active“录音中”，录音中再次点击返回同一录音而不新建第二条，结束后恢复 inactive“开始记录”。删除这条临时会议后默认列表仍为原有 3 条。
- 临时为 `emulator-5556` 配置设备 PIN 并开启“系统验证 / 启动时验证”后，Tile 点击先停在系统“解锁老记”凭据页；错误 PIN 期间没有 RecordingService 或新会议，正确 PIN 后才执行同一个持久 pending 目标并开始录音。任务结束后测试会议已删除、两项开关已关闭、临时 PIN 已清除，模拟器恢复无锁屏状态。
- 录音结束后页面曾短暂显示可重试上传状态，后台随后自动恢复；详情可见 5 段远端 final Transcript、`04:09` 播放器和 1 个讲话人。选择通用模板后约 2.5 秒形成 1 段“会议概述”，无行动项；这证明上传后的远端文字与整理链可达，不证明模拟器输入的识别质量。
- 冷启动时旧代码重复收到相同 `remoteRevisionId`，但服务器补齐的 RecordingAsset/job provenance 改变了本机 fingerprint，于是误插入第二个本地 revision，并触发 `transcript_revisions(meeting_id, remote_id)` 唯一约束。当前实现先按远端 revision ID 复用既有不可变版本，只补空的来源身份并保留既有 segment ID；正文、时间、说话人或既有来源身份若变化则拒绝覆盖。
- 修复包第一次运行只把 canonical revision 从 85 推进到 86 以补齐 provenance；随后强杀冷启动保持 revision 86，未再出现 `meeting_transcript_processing_failure`。04:09 音频、5 段文字、整理结果和播放器均保留，日志无 App FATAL、React Native 致命异常或 SQLiteException。
- 本轮没有 USB 设备；录音来自 Android 模拟器环境，不能替代真人、多讲话人、物理麦克风、弱网或长录音候选验收。

## 当前包：双录音文字重新生成与整理版本保护

- `[DEVICE]` 账号会议 `V3_CANDIDATE_SPOKEN` 已有 65.232 秒 primary 和 7.176 秒 imported secondary，两条均为远端 `uploaded`。最终 Preview 从“更多 → 重新生成文字记录”真实确认，不通过测试接口代替用户入口。
- `[SERVICE]` 18020 为两条资产创建全新 job `1d598abc-a1b2-440e-b5d5-42573a417aec` 与 `52bb8555-7b34-4b16-8ff2-b3ba853425ad`，共享 batch `b865e16d-12aa-49c0-82f9-38eb2569621a`，均以 `attempt=1` 完成。服务端 primary 20 段、secondary 2 段和 10 段历史无资产内容均保留。
- `[DEVICE]` 停机实读确认两条当前任务为 `reprocessed` 且 batch 相同，combined active revision 为 `reprocessed/ready`、共 32 段；旧任务完整进入 generation history。旧活动文字在整批完成前保持，整批完成后才切换 combined revision。
- 同正文的新 revision 曾使旧整理错误保持 `ready`，详情刷新还会把未声明 Transcript identity 的同一远端整理复制到当前文字版本。最终代码改为按 revision identity 失效整理，并按原锁定 revision 识别同一不可变整理；最终当前 Summary 与 processing stage 均为 `stale`，Summary version 数在刷新和重转写前后保持 7。
- 数据库 `quick_check=ok`、`foreign_key_check=0`。最终 Preview 强停冷启动后恢复“整理结果可更新”、两条录音和文字入口；日志无应用 FATAL、React Native 致命异常、SQLiteException、缺表或缺列。

## 当前包：人工内容、来源与默认隐私

- 保留账号数据覆盖安装后，应用正常读取既有会议、整理版本、行动项和播放器；v36 citation 覆盖列进入普通查询，冷启动无缺表/缺列或 SQLiteException。
- 现有 `V3_CANDIDATE_SPOKEN` 的通用整理版本含 `00:00/00:20/00:50` 三条 canonical 引用。编辑“决定”section 时移除 `00:00`，正文不变；页面立即只显示后两条并标记人工修改，强停冷启动后状态保持。
- “恢复生成内容”同时清除正文/引用人工覆盖；三条生成引用全部回归，section 人工标记清除。当前包完成两次恢复；首次旧进程状态曾出现一次通用失败，随后加入不含用户正文的 `meeting_summary_section_edit` 原因审计，新包冷启动与重复恢复均未再出现失败或审计事件。收口后已切回测试前的 03:00“访谈”当前版本。
- 标准 LatinIME 下，编辑层标题、正文、quiet-blue 引用 chip、条件式恢复操作、固定错误槽和 48dp 保存按钮均完整位于键盘上方；测试后恢复 ADB Keyboard。
- 分享选择页只读核对：默认开启“基本会议信息、整理结果、行动项”；“文字记录、标记、附件、录音、我的笔记、链接使用最新整理结果”全部关闭。随后取消分享，没有创建文件或链接。
- 同一账号会议的删除确认明确显示“移到回收站？”和“保留30天，期间可以恢复”；本轮点击“取消”，没有移动或删除会议。游客永久删除的实际成功/失败保护仍使用下文前一包证据。
- 本轮日志无应用 FATAL、React Native 致命异常、SQLiteException、SIGSEGV 或 SIGABRT。当前包尚未把 Summary 重生成保护、账号墓碑恢复或物理 USB 合并为同轮证据。

## V3 第 1 条：稳定包游客数据保留升级（紧邻前一 Preview）

- 使用一次性 `LaoJi_Candidate_V34 / emulator-5554`，从清数据系统镜像安装稳定包 `/home/yydd/LaoJi-stable-builds/laoji-v104-calendar-personalization-20260726.apk`；设备 base.apk SHA-256 为 `e58df956924f5311e6594fbf645017ac066543eeb3fe8a3c1f5240bef27ea4bf`，与稳定归档一致。
- 在稳定包游客作用域创建 `V34_UPGRADE_FIXTURE` 日程；再从会议页完成一场 `03:16` 录音、本机保存和详情打开，并写入人工笔记 `V34_NOTE`。无音频窗口的 emulator 输入出现 PCM I/O 噪声，因此本样本只用于文件/数据保留，不证明麦克风音质或转写。
- 不清 App 数据，以 `adb install -r` 覆盖为当轮 Preview。设备 base.apk 变为 `6ed2b6c9…40b34080`，冷启动恢复 guest canonical owner，日志为 `meetings=1`、`canonical_revision=5`、mirror unchanged，未见 FATAL、React Native 致命异常、SQLiteException、缺表或缺列。
- 升级后月历仍显示原日程，会议列表仍有原 `新录音`；详情保留 `V34_NOTE`、总时长 `03:16`，播放器实测进入 `PLAYING` 并推进到 2,957 ms。应用私有 WAV 仍为 6,272,044 bytes。
- 用同签名 Debug 仅打开只读窗口检查升级后的私有库：`user_version=34`、`quick_check=ok`、`foreign_key_check=0`，1 条 MeetingNote、1 条 RecordingAsset、1 条 manual note，且 `meeting_marker_sync_state` 已存在。检查后重新覆盖安装当轮 Preview，SHA-256 再次逐字节一致并冷启动成功。
- 这条证据覆盖稳定包游客日程、会议、录音、人工笔记和 v34 additive migration；没有登录测试账号，也没有制造游客迁移 journal 或账号墓碑，因此不能单靠该轮写成 guest/user/tombstone/journal 全部完成。顶部当前包包含后续删除和迁移修复，但没有重新从稳定包执行覆盖升级，所以不能把前一 hash 的运行证据改写成当前 hash 单轮证据。

## 游客永久删除的物理清理闭环

- 修复前先读取稳定升级样本删除后的私有库：界面虽为“暂无会议记录”，但仍有 1 条 `meeting_notes` 删除墓碑、1 条 RecordingAsset 和 1 条 manual note；该 guest 根无远端 identity，且游客 retention cleanup 明确不处理它，因此旧行为与“永久删除”文案不一致。
- 在清 App 数据的 `LaoJi_Candidate_V34 / emulator-5554` 安装当轮删除候选 Preview `f89fd942…02a78b`，游客模式完成一场 `01:28` 本机录音、保存并进入详情，在“我的笔记”写入 `PURGE_NOTE`。无音频窗口仍有 PCM I/O 噪声，本样本只验证数据和文件生命周期。
- 从详情菜单选择“删除会议”，确认“永久删除本机会议”后返回空会议列表；没有“清理未完成”、删除失败、FATAL、React Native 致命异常或 SQLiteException。当前实现先保留 canonical tombstone、清理录音/缓存/通知，只有文件步骤全部成功才在一个事务中物理清除 guest 根及子对象，并强制重建 compatibility mirror。
- 同签名 Debug 只读检查确认 MeetingNote、RecordingAsset、manual note、Transcript、Summary、Action、Marker、附件、片段、问答、分享、FTS 搜索行、outbox 和 conflict 均为 0；私有录音目录没有音频文件，`user_version=34`、`quick_check=ok`、`foreign_key_check=0`。
- guest scope 的 `canonical_revision=8`、`legacy_mirror_revision=8`、`legacy_mirror_status=clean`，RKStorage 中没有会议、转写或总结兼容键；检查后重新覆盖当轮删除候选 Preview，设备 base.apk 与 `f89fd942…02a78b` 逐字节一致并冷启动仍为“暂无会议记录”。
- 安全失败分支另用一次性夹具把 RecordingAsset URI 注入为本地 Expo 实现确定拒绝的 `https://` scheme。确认删除后界面明确显示“会议已删除，清理未完成”；同签名 Debug 实读仍有 1 条 guest `deleted/deleted` tombstone、1 条 RecordingAsset 和 sentinel manual note，且没有 remote identity，证明文件失败没有越过物理 purge 边界。该库 `canonical_revision=14`、mirror revision 14、mirror clean、`quick_check=ok`、`foreign_key_check=0`。
- 这条证据覆盖游客本机永久删除的成功与文件失败保护路径；账号回收站、30 天保留和物理 USB 设备不由它替代。

## 游客显式迁移、录音唯一身份与长任务恢复

- `[PRODUCT]` 游客数据只在用户点击“立即合并”后复制到账号，游客源数据和源文件继续保留，声纹资料不迁移。此前自动提示错误地要求相邻的 `guest -> authenticated`，但真实登录必经 `guest -> signed_out -> authenticated`；当前实现改为每个新认证会话检查一次待迁移资料，模拟器实际流程自动显示“1 条会议记录、1 份录音、1 份我的笔记”，没有静默合并。
- 旧版本曾以迁移专用 `guest-migration:<meeting>:primary` 直接上传，同时正常上传队列又用本机 RecordingAsset ID 注册，形成两个主录音身份和 409。当前迁移本身不再充当第二个 uploader：新录音只交给既有持久上传注册表；旧 journal 若已经直接上传，则按精确旧 client ID 查询并认领相同云端资产，不覆盖账号中不同的主录音，也不删除游客文件。
- 旧冲突夹具在账号 `user:84` 上完成安全认领。云端 RecordingAsset `bb4ad11a-c7bd-494a-a8f1-d65847bf1510` 与本机资产建立 immutable remote link；详情播放器同时按 client ID 和 remote ID 去重，只显示一段 `01:05` 录音，不再出现“录音 1 + 录音 2·仅本机”。`V3KEEP` 在覆盖安装、退出登录、游客/账号切换和冷启动后仍存在。
- 另以全新临时账号 `user:85` 从同一游客源执行一次首次合并。云端只产生会议 `bd2a8b2e-4cf7-4a62-a48d-5cb6711e9399` 和一个主录音 `c1e02462-6361-44fa-843e-4a2532f0a874`；其 `client_asset_id=08918917-d553-41f5-b8ff-0e8e27bb6de9` 与本机 SQLite RecordingAsset ID 完全一致，且不是迁移专用 ID。服务端为 `uploaded`、2,087,502 bytes、65,232 ms；本机 scope 只有一个 RecordingAsset、没有 `guest-migration:%` 资产 ID，pending 上传键已清空，WorkManager 只有一个 `user:85` 上传任务并以相同 UUID 成功结束。
- 全新合并后退出账号再次进入游客模式，源会议、`01:05` 录音和 `V3KEEP` 仍完整；重新登录原账号后账号副本也完整。临时账号随后通过正式账号删除合同清理：删除 1 条会议、1 个会话，`cleanup_pending=0`，没有留下活动测试任务。测试凭据未写入仓库或证据文档。
- 本轮音频是十段中文 TTS 拼接，不是真人会议。真实 RecordingAsset 转写任务 `9f023f53-12d1-4cc1-a1d5-772fc1a8ca24` 连续失败于 VibeVoice 推理阶段的 `NVML_SUCCESS == ... nvmlInit_v2_()` 断言；为验证下游而通过测试 API 导入的十段文字明确属于“期望文字夹具”，不能算 ASR 成功。基于该夹具，搜索“赵敏”显示 `1/1` 并定位高亮，点击对应段准确跳到 `00:13`，播放器继续正常推进，三名合成讲话人可见。
- Summary task `7bbedf3e-d72f-44e1-bd7c-d67eed55bbaf` 是前一部署的真实失败样本：页面在服务端仍运行时不再伪装超时，保留数据覆盖安装后可从持久 task ID 恢复；服务端最终在旧精简/完整路径的 120/600 秒预算耗尽后返回 FAILURE，App 才把 Summary 单独收敛为可重试失败。该样本继续证明运行态与真实失败分流，但不再代表当前 Summary 服务仍被相同超时阻塞。
- 目标 18020 修复“有正文但最新重试失败时隐藏稳定 final Transcript”的状态合同后，真实 `general@1` task `06b9ae52-581a-4847-8604-5f9b3be431e7` 在约 92.3 秒后成功；durable final version 为 `10f1af3f-ef92-4a23-ae08-8164eede3dde`。Summary 仍严格绑定 active final Transcript，录制中、活动 queued/running task 或空正文失败都没有被放宽。
- 该结果包含 3 条决定、7 条待办和 9 个通过 canonical segment 校验的引用，没有被拒引用。`00:00`、`00:20`、`00:50` 三个引用在模拟器分别切到正确文字段，并把播放器定位到 `0 ms`、`20,712 ms`、`50,904 ms`；这证明本场结构化内容、行动项来源与引用跳转，但上游十段文字仍是测试 API 导入夹具，不能改写成自动 ASR 成功。
- 同签名 Debug 停机实读确认 active final Transcript 10 段、Summary `ready`、1 个版本、3 个 section、9 个引用和 7 个 action；`quick_check=ok`，`foreign_key_check` 无输出。冷启动后 canonical revision 保持 `23`，重复 durable 响应记录 `meeting_summary_shadow_write status=unchanged`，没有覆盖当前版本或重复推进处理阶段。
- 当前代码通过 `npx tsc --noEmit --pretty false`、`git diff --check` 和一次完整 `assemblePreview`；APK 保留数据覆盖安装 `LaoJi_Candidate_V34 / emulator-5554`，设备 `base.apk` 与顶部构建产物逐字节一致。冷启动 resumed，页面不再显示旧失败；无 App FATAL、React Native 致命异常、SQLiteException、SIGSEGV 或 SIGABRT。同签名 Debug 只用于停机实读，随后已恢复同一 Preview。当前没有 USB 真机。
- 初次 `one_on_one@1` 真实任务在旧 9B/2048-token 完整管线跑满 600 秒并 ReadTimeout；无历史/无附件的非默认模板现改走 4B 动态 JSON schema 精简路径，历史/附件授权仍保留完整管线。修复后 1:1、项目同步、访谈分别在 113.6、136.2、135.4 秒成功并形成独立 durable version；项目样本未编造空风险段。
- 定向四段访谈游客 task `0a62ea84-809f-40fd-b6bb-267b1c3dc012` 又在 157.6 秒生成主题、受访者观点、证据摘录和后续问题，四类分别有 `2/1/1/1` 个 canonical 引用且行动项为 0。账号 durable 访谈版本已被当前 Preview 冷启动激活，UI 显示模板内容与待办；这仍是导入/合成 Transcript，不是自动 ASR。

## V3 第 2 条的隔离环境

本节完整录制/播放证据对应 SHA-256 为 `b8f710ad0f308cdc24237f395fa980735d2e635c35ad99b178cae5ede058b8ad` 的前一候选包。顶部当前包继续包含后续 fresh account canonical cutover 与 Marker 账号同步；后述分轮证据完成录音结束/本机保存/上传和 Marker 跳转，`f89fd942…02a78b` 删除候选又完成游客录音保存/永久删除，但顶部当前 hash 没有把完整详情播放器步骤全部重跑。

- 使用 AVD `LaoJi_CAL_EDIT_RT`、序列号 `emulator-5558`，以 `-read-only -no-snapshot-save` 启动；安装候选 APK 后清空该临时实例的 App 数据并进入游客模式。主模拟器 `emulator-5556` 的既有会议和数据未修改。
- Android Emulator 的 headless QEMU 不提供可用 PulseAudio 驱动，因此改用 `-qt-hide-window` 的完整 QEMU，并将输入/输出接到临时 PipeWire/Pulse null sink。录制期间注入两段不同幅度的纯音，用于证明采集、分贝波形和播放器读取的不是固定占位数据。
- 该输入只适合验证本机音频链，不是人声样本，不用于证明转写、讲话人识别或真实麦克风质量。

## V3 第 2 条：录制主链

1. 从空会议列表点击“录音”后进入“新录音”页面，系统中 `LaojiRecordingService` 以前台服务运行，录音计时持续推进。
2. 暂停后主按钮变为继续图标，计时停在 `01:41`；继续后计时恢复。注入测试音时，底部波形从近似静音的短柱变为随幅度变化的高低柱，随后回落。
3. 点击停止先显示中文“结束录音？”确认框；确认后录音服务退出，本机提交成功并进入同一会议详情，没有闪退或把会议标成失败。
4. 详情播放器显示总时长 `02:22`。首次播放时 MediaSession 为 `PLAYING`、位置 `5,938 ms`；随后可暂停。拖到接近结尾后位置为 `126,201 ms`、buffered 为 `142,600 ms`，再次播放推进到 `129,211 ms`，证明不是只播放文件开头。
5. 录制过程抓取了 `88.518 s`、`1080x2400` 的临时屏幕录像，覆盖录制、暂停、继续及停止确认；录像和诊断截图经检查后不提交二进制，保持轻量工作区。
6. 本轮日志未发现应用进程的 `FATAL EXCEPTION`、React Native 致命异常、`SQLiteException`、Media3/ExoPlayer 播放错误或保存阶段错误。系统镜像中 Google 消息组件的旧 SQLite 探测噪声不属于 `com.laoji.app`，未误归类为老记缺陷。

## V3 第 7 条与 ATT-01 的双实例集中验收

- 使用两个独立清数据 AVD：`LaoJi_V3_Account_A / emulator-5560` 与 `LaoJi_V3_Account_B / emulator-5562`。两端安装的 `base.apk` SHA-256 都为 `ee24ffc2343f8edc52b1777ceff559e2aae82e39a2648ef2ae3719a8cdcc97e4`，并登录同一测试账号；保留游客夹具的 `emulator-5556` 没有启动或改写。
- 两个 fresh account scope 都先完成 shadow import，再出现 `canonical_projection_ready`、`meeting_db_write_cutover status=active` 和 `mirror_status=clean`。为此修复了两个新设备边界：远端已声明有 Transcript、但正文尚未下载时保留可用状态；canonical 读取切换成功后立即取得写所有权并写兼容镜像。
- A 端安全结束约 `08:03` 的遗留录音，没有强停进程或清数据；保存没有闪退，WorkManager 上传成功。B 端在显式云端刷新后拉到同一会议。模拟器没有有效人声，后续“文字处理失败，可重试”是静音输入导致的转写结果，不是录音保存或上传失败。
- A 端新增唯一文字附件 `V3_A2B_1943`，上行诊断为 `meeting_attachment_sync pushed=1`；B 端从会议全局入口看到 `附件（1）` 及相同正文。A 删除后上传墓碑，B 再同步后变为“暂无附件”。这证明附件对象的新增、pull 与删除收敛，不证明图片整理或视觉模型。
- A 端把会议标题更新为 `V3_A_REMOTE`；B 在陈旧 revision 上保存 `V3_B_LOCAL` 后明确显示“会议同步冲突”。版本选择页同时显示本机/云端候选；选择“使用云端版本”后标题收敛为 `V3_A_REMOTE`，冲突状态消失。
- B 将测试会议移到回收站后，A 在显式刷新中拉到同一 tombstone，并显示 30 天可恢复状态。验收结束后，服务端按标题、账号与会议 ID 三重匹配物理清理这一条测试会议、15,481,644-byte 录音、失败转写任务、附件墓碑及操作记录；只减少一条 Meeting，剩余引用为 0，文件已删除，`PRAGMA quick_check=ok`。
- 本轮没有重新断网制造 outbox 重试；V3 第 7 条中的该分支仍使用此前持久 outbox/恢复证据。这里的“第二实例”是两台独立移动模拟器，不是第二台物理手机。

### MRK-01 后续双实例收敛

- 上述 ATT-01 轮次中 A 的 Marker 确实没有出现在 B；这条历史观察只证明当时附件凭自身 `meeting + position_ms` 恢复，不是 Marker 已同步。后续 MRK-01 以独立纵切补齐服务端 schema/capability/owner API 和移动端 v34/outbox/pull，未把附件结果改写成 Marker 证据。
- 使用 `LaoJi_Marker_A / emulator-5554` 与 `LaoJi_Marker_B / emulator-5556` 两个独立 AVD，两端安装 SHA-256 均为 `d80254b3d920de318742f453137bd4607e9d82fc7f8d6910e54090a8db64f7e0` 的同一 Preview 并登录同一测试账号。A 在录音中创建 02:33 Marker，服务端保存 active revision 1。
- 清数据后的 B 首次登录时 Marker 首轮因会议根尚未落库而看到 0 个会议；账号会议根恢复后 provider 自动重跑，随后拉取 4 个会议并显示 02:33 Marker，不需要第二次重启。为此修复了 canonical owner 冷启动提前返回，以及根/Marker 首轮竞态。
- B 点击 Marker 后播放器从 00:00 精确跳到 02:33。A 删除后服务端变为 deleted revision 2，B 回前台后 Marker 消失；两端未见应用 FATAL、React Native 崩溃或 SQLiteException。
- 收口时数据库 operation 数继续增长，反向证明 synced tombstone 被 repair 逻辑重复入队。最终代码将修复条件限定为“尚未 synced 的删除状态”，实际修复 SQL 窄检查通过。该轮最终 Preview 已在两个模拟器保留数据覆盖安装，设备 base.apk 均与 `6ed2b6c9…40b34080` 一致，冷启动进程存活且未产生新的服务端 Marker operation。
- 测试会议按账号、标题和会议 ID 精确物理清理：Meeting 总数从 45 回到 44，Marker/operation 回到 0，13,360,044-byte 录音、失败转写任务和空目录均删除；`quick_check=ok`，历史 7 条既有外键异常未增加。这里仍是两个模拟器，不是两台物理手机。

## 前一候选包的 USB 真机增量

以下记录对应 SHA-256 为 `b8f710ad0f308cdc24237f395fa980735d2e635c35ad99b178cae5ede058b8ad` 的前一候选包，不是本文件顶部的 fresh-device 修复包。

- 真机为 Xiaomi `23013RK75C`、Android 15，ADB 序列号 `825f509d`。安装前 App 同为 v104，但 `lastUpdateTime=2026-07-26 20:10:56`；系统中没有活动录音服务。
- 使用 `adb install -r --no-incremental` 保留数据覆盖安装成功。安装后的设备 `base.apk` SHA-256 为 `b8f710ad0f308cdc24237f395fa980735d2e635c35ad99b178cae5ede058b8ad`，与候选文件逐字节一致；`firstInstallTime` 未改变，`lastUpdateTime=2026-07-27 09:04:20`。
- 真机冷启动 `MainActivity` 成功，`TotalTime=746 ms`。原有日程、会议列表和登录态均保留，证明本次覆盖安装没有清空用户数据；这不是从稳定标签 APK 开始的完整 migration 证明。
- 为避免污染正式登录账号，本轮没有创建会进入同步队列的新测试录音。改用一条现有 `16.3 s` 会议做只读播放：UI 进度推进至 `00:04`，MediaSession 为 `PLAYING`、position `2,813 ms`、buffered `16,300 ms`；文字记录当前段同步高亮，随后可通过媒体命令暂停。设备日志没有应用 FATAL、React Native、SQLite 或 Media3 播放异常。
- 因此 USB 已补齐候选包一致性、保留数据启动和现有录音播放证据；“真机新录音开始→暂停/继续→保存”仍未执行，不能由模拟器完整录制链或既有文件播放替代。

### 附带日历真机回归

- `[SOURCE]` 当前候选中的 `f333039` 将上方日期栏实现为独立的按周 `ViewPager2`，下方时间轴保留按日 Pager；这对应飞书 `DayWeekIndicator` 与单日时间轴不同的手势所有者。
- `[DEVICE]` 在同一 USB 真机分别对两处执行约 `1.2 s` 左拖，并各抓取 24 张连续屏幕帧。时间轴拖动从 7 月 27 日切到 28 日，日期栏保持在 7 月 26 日至 8 月 1 日这一周，只移动选中态；日期栏拖动则整排切到 8 月 2–8 日，保持星期偏移选中 8 月 3 日，下方时间轴随后切换。
- 两组采样均未出现白帧、空页、错误日期重绑或选中态回跳；检查后已恢复 7 月 27 日的月视图。这里只证明一次单向真机手势，不扩写为快速连续滑动、跨周往返或所有刷新竞态的穷举验证。

## 当前外部边界

- `18020 /api/health` 本轮实时返回 HTTP 200、`asr_provider=qwen3-asr`、`models_ready=true`，VAD 与两份 CAMPPlus 状态均为 true；这证明健康响应，不替代真人转写质量。
- `18020 /api/laoji/capabilities` 本轮实时返回 HTTP 200；根、RecordingAsset、行动项、QA、协作、片段、讲话人、附件和 Marker 均在线，`summary_attachments_image=false` 继续 fail closed。`transcript_reprocess_v1=true` 已随当前 overlay 部署，移动端重新生成文字记录入口按 fresh capability 开放。
- 18020 的 OpenAPI 已实时确认创建转写、查询任务和重试三个 RecordingAsset 路由存在；运行文件 SHA-256 与持久 overlay 均为 `dd96d3a907db6b3ffa5a50355892aaa1367d6d9abb146550c3c02ffdc65623a1`。真实账号已从当前 APK 创建一条新 job，65.232 秒 RecordingAsset 在约 5 秒后首次尝试完成；20 段该资产文字更新，10 段无资产身份的旧夹具保留，旧整理结果及冷启动读取未被覆盖。
- `18035 /api/laoji/capabilities` 返回 HTTP 404。
- 18020 已实时确认从 `/home/zhong/laoji-service-platform/smart-meeting-ai/backend` 运行；只替换 `app_meeting_v2.py` 并重启 18020，18035 PID `533940` 未变化。替换前文件保存在服务器 `backups/20260729-transcript-reprocess-capability-v1`。
- USB 真机当前断开；顶部当前 APK 没有新的 USB 安装或物理设备结论。

## 对完成状态的影响

- V3 第 2 条在同一候选代码线已有完整模拟器证据；顶部当前 hash 又以日程 occurrence 完成开始、离开后继续、结束、04:09 保存、详情、远端文字和整理结果，但没有重跑暂停/继续按钮分支，因此仍不写成当前 APK 单轮全链。
- V3 第 1 条已由紧邻前一 hash 补稳定包游客保留升级并实读 v34 数据库；顶部当前 hash 没有重跑覆盖升级，但已补 guest/user 数据、迁移 journal 和两边源数据保留。账号墓碑与物理设备窗口仍待，不写成一次全覆盖。
- V3 第 7 条的第二实例 pull 和真实 409/412 选择已集中完成；离线 outbox 重试仍由此前分散证据支持，故不把第 7 条写成三项均在本轮重跑。
- V3 第 4 条当前包补齐 section 正文/引用人工覆盖、冷启动保留与恢复，但未在同轮重跑 Summary 重生成和同步冲突保护。第 5 条已有导入 Transcript 的非平凡整理、引用跳转和行动项来源，当前包又实测引用移除/恢复；它仍不是可判断真人识别质量的样本。第 6 条当前包确认安全分享默认值和账号回收站文案，实际账号墓碑/恢复仍沿用前轮证据。当前 APK 尚未安装到 USB 真机，前一候选包的 USB 保留数据/播放证据不能自动继承为当前包的物理设备证明。
- ATT-01 的对象层、线上服务及双模拟器新增/墓碑闭环已完成；真实图片理解仍因没有已确认视觉模型而关闭，物理 USB 仍待。
- MRK-01 的本机、服务端和双独立模拟器功能纵切已完成；仍缺物理双机、USB 与长离线抽查，不能把双 AVD 写成物理跨设备完成。
