# 候选版 V3 集中证据

状态：同一候选代码线已完成 V3 第 2 条“录制主链”；顶部当前 Preview 又在两个全新、彼此独立的 Android 模拟器实例上完成录音保存/上传，并补齐第 7 条中的同账号第二实例 pull 与真实 409/412 用户选择。完整的“开始→暂停/继续→结束→详情播放”来自前一候选包，本轮当前 hash 没有重复播放器步骤；不能把两轮合写成当前 APK 单次全链。第 7 条的离线 outbox 重试仍引用此前分散证据，V3 第 1、3–6 条也没有在本轮重跑，因此不宣称七条均由一次集中验收完整覆盖。两个模拟器不能替代第二台物理手机，当前 APK 也尚未覆盖安装到 USB 真机。

## 候选身份

- APK：`android/app/build/outputs/apk/preview/app-preview.apk`
- 移动端代码内容基线：`b3ea399 fix: complete fresh-device canonical cutover`
- 版本：`versionCode=104`，`versionName=1.0.0-source-preview`
- 构建时间：`2026-07-27 19:25:13 +08:00`
- 大小：`91,009,536` bytes
- SHA-256：`ee24ffc2343f8edc52b1777ceff559e2aae82e39a2648ef2ae3719a8cdcc97e4`
- 稳定回溯标签继续固定在 `stable-before-meeting-memory-roadmap -> cde96f9d5266961e380957893ecba39855aea39b`。

## V3 第 2 条的隔离环境

本节完整录制/播放证据对应 SHA-256 为 `b8f710ad0f308cdc24237f395fa980735d2e635c35ad99b178cae5ede058b8ad` 的前一候选包。顶部当前包只改变 fresh account canonical cutover，并在后述双实例轮次重新完成录音结束、本机保存和上传，没有重复详情播放器步骤。

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

### Marker 边界

- A 端录制时创建的 Marker 没有出现在 B 的文字记录页；B 端能查看附件，是因为附件保留 `meeting + position_ms` 并从会议全局入口读取，而不是 Marker 已同步。
- 当前客户端 Marker 仍只有 canonical 本机事务，目标服务也没有已部署的 Marker schema/API/outbox/pull。工程指示第 12.7 节保留了 Marker 同步契约，因此这是独立的 MRK-01 剩余功能缺口，不能用本轮 ATT-01 结果抵消。

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

- `18020 /api/health` 返回 HTTP 200，`models_ready=true`。
- `18020 /api/laoji/capabilities` 返回 HTTP 200；根、RecordingAsset、行动项、QA、协作、片段、讲话人和 `meeting_attachments_v1` 均在线，`summary_attachments_image=false` 继续 fail closed。
- `18035 /api/laoji/capabilities` 返回 HTTP 404。
- 18020 仍为目标工作区进程 PID `2474395`；本轮未重启 18020/18035，只执行上述精确测试夹具清理。
- USB 真机当前断开；顶部当前 APK 没有新的 USB 安装或物理设备结论。

## 对完成状态的影响

- V3 第 2 条在同一候选代码线已有完整模拟器证据，顶部当前包又重跑了录音保存/上传；播放器步骤没有在当前 hash 重复，因此锁定功能主链，但不写成当前 APK 单轮全链。
- V3 第 7 条的第二实例 pull 和真实 409/412 选择已集中完成；离线 outbox 重试仍由此前分散证据支持，故不把第 7 条写成三项均在本轮重跑。
- V3 第 1、3–6 条仍是此前分散证据；当前 fresh-device APK 尚未安装到 USB 真机，前一候选包的 USB 保留数据/播放证据不能自动继承为当前包的物理设备证明。
- ATT-01 的对象层、线上服务及双模拟器新增/墓碑闭环已完成；真实图片理解仍因没有已确认视觉模型而关闭，物理 USB 仍待。
- Marker 本身尚未跨设备同步。由于工程指示明确保留 Marker 服务端同步契约，MRK-01 不能再仅写作“只差抽查”，应作为后续实现项。
