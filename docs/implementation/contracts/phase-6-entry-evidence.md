# Phase 6 快速入口证据：ENTRY-01 通知与 ENTRY-02 Widget/Tile

状态：ENTRY-01 已形成“默认点击查看日程 / 明确动作开始、继续或查看会议记录”的本机纵向闭环；ENTRY-02 已接通严格语义链接、最小日程投影、近期日程 Widget 和临时会议 Quick Settings Tile。顶部候选包又补齐 Tile 录音中 active 状态、重复点击返回同一录音，以及 Tile 在 App Lock 下先验证再执行 pending 目标。本文件记录轻量合同、源码映射和模拟器实测，不代表通知/Widget 的 App Lock 分支、真机/不同 ROM、服务端冲突裁决或 Phase 6 全部退出条件已经完成。

## ENTRY-01 当前范围

- 日程提醒注册 `laoji-event-reminder` category，提供一个中文系统动作“开始记录”。通知标题为“日程即将开始”，正文使用日程展示标题；空标题沿用日历展示层的 `(无主题)`，领域标题仍保持空字符串。
- notification data 为 version 3 event snapshot，保留 `eventSourceId + eventOccurrenceDate + notificationScope + fingerprint`，不写 meeting ID。Android action identifier 决定 `start-or-resume-meeting`，默认点击决定 `open-event`。
- `notificationNavigation.ts` 在执行业务动作前将 semantic intent、occurrence ref、scope、response key 和原通知 ID 持久化。旧 v2 pending event 缺 intent 时安全恢复为 `open-event`。
- `AppLockGate` 继续拥有 `navigationUnlocked`；锁未解除时只保存 pending target，不查询或创建 meeting。scope 不一致的旧通知被消费但不跨账号导航。
- `openOccurrenceMeeting.ts` 是详情页和通知共同调用的应用用例：先按 occurrence 查询，已有 ended/content 时查看详情，active/可恢复时继续，同一 occurrence 无记录时才创建并绑定。
- 后续 CAL-01 增量把通知动作与 Widget 明确动作接入账号 occurrence 回查：先恢复本机 orphaned link 并读取本机投影；已有本机会议直接沿用，只有本机无关联时才查询云端并安全附着，避免服务离线阻断已有记录。
- 同一 scope/occurrence 的进程内请求使用共享 Promise 合并；创建请求 ID 对正常 event ID 保持 `calendar:{sourceEventId}:{occurrenceDate}`，超长身份改用 SHA-256。游客 mutation queue 在持久化前按 `clientRequestId` 复用现有 meeting，并重新尝试影子落库/occurrence 绑定。
- `CreateMeetingOptions.entryPoint` 传到 canonical shadow；通知首次创建保存 `notification`，日程详情首次创建保存 `calendar_detail`。已存在会议不会因后续另一个入口被改写来源。
- 处理成功后按原 notification ID 主动移除系统通知，避免动作完成后留下可重复点击的过期卡片。默认点击仍只打开 `EventDetail`，不会创建会议。

## ENTRY-01 UI 证据分类

组件：日程系统通知与“开始记录”动作

- Classification：LaoJi-only capability extension；容器由 Android System UI 绘制，不使用应用内 UDButton 样式。
- `[SOURCE]`：Feishu 7.71.8 中文资源存在 `Lark_Event_Upcoming_Desc=日程提醒`，Minutes-calendar 分支存在录音提醒和 `MMWeb_MinutesCalendar_StartRecording_Button=开始录音`；没有源码证据证明飞书 Android 系统通知使用同一动作布局。
- `[PRODUCT]`：老记从 occurrence 提供明确“开始记录”入口；默认点击只查看日程，空白区域或普通通知点击不得隐式创建会议；用户可见术语不出现其他产品专有名称。
- `[DEVICE]`：`emulator-5556` 的 Android System UI 实际显示“老记 · now / 日程即将开始 / (无主题) / 开始记录”，动作保持系统触控和展开行为。
- `[INFERENCE]`：用单一 category action 把会前提醒连接到现有 occurrence 状态机；动作标签使用老记术语“开始记录”，不照搬飞书的专有录音提醒文案。

## ENTRY-01 轻量验证

- `npx tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过。
- `:app:assemblePreview --parallel`：通过；627 个 task，59 executed、568 up-to-date。
- 验证前保存模拟器快照 `codex-laoji-entry01-pretest-20260724`。基线冷启动 repository audit 为 `legacy_meetings=1`、`projected_meetings=1`、`context_mismatches=0`。
- 通过正常手动新建页创建空标题临近日程，15 分钟提醒因已过计划提醒点而在约 1 秒后触发。System UI 和 `dumpsys notification --noredact` 均确认标题、空标题占位、一个“开始记录”action 和 `actions=1`。
- 实际 notification body 只含 event occurrence/snapshot/scope/fingerprint，未含 meeting ID。默认和 action 使用同一通知对象但不同 response key。
- 首次点击“开始记录”进入对应 `MeetingLive` 并触发自动开始；当前会议服务不可达，页面以既有中文“暂时无法连接老记服务，请检查网络后重试。”停止在可恢复失败态。日志只有一次 `meeting_create_shadow_write status=completed`。
- 同一系统通知动作再次点击后没有第二次 shadow create。强停冷启动 audit 为 `legacy_meetings=2`、`projected_meetings=2`、`context_mismatches=0`，即基线一条加本次一条，而不是三条；回到日程详情显示“继续记录”。
- 补充通知移除后，把同一 occurrence 改到新的临近时间再次触发提醒。点击动作直接回到同一失败可恢复会议，没有创建日志，处理后 `dumpsys notification` 不再含老记日程提醒。
- 再次修改提醒并点击通知正文，页面只打开同一 `EventDetail`，显示空标题、修改后的时间和“继续记录”；没有创建日志，通知随后移除。
- 验证完成后加载测试前快照，再覆盖安装最终 Preview。临时日程、失败会议、通知和临时授权均已消失；`POST_NOTIFICATIONS` 恢复为 `granted=false`。最终冷启动 audit 回到 `legacy_meetings=1`、`projected_meetings=1`、`context_mismatches=0`，无应用 FATAL、`SQLiteException` 或 `no such column`。
- 最终 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-24 04:23:21 +0800`，大小 `89,914,399` bytes，SHA-256 `44981a4ac0125ac39383cf87b09f2e4758e34e9f7a6d314d512c9ba424192fa0`。已覆盖安装到唯一设备 `emulator-5556`，`lastUpdateTime=2026-07-24 04:28:02`。

## ENTRY-01 未完成边界

1. 当前没有 USB 真机；不同 ROM 的通知展开/动作、物理设备后台限制、触觉、字体缩放和通知权限首轮引导尚未验证。
2. 顶部候选包已用系统设备凭据完成 Tile -> App Lock -> pending -> 创建/录音；notification -> App Lock -> occurrence 的设备任务仍未单独执行。
3. 顶部候选包已由同一 occurrence 的通知显式动作和 Widget ended 分支打开既有记录，但通知首次开始并持续录音、active recording 通知继续仍没有集中设备样本。
4. 当前账号和 occurrence 运行服务已有单设备证据；两台物理设备同时创建及真正不同会议的 409 后本机音频合并仍未完成。
   客户端已经能在 409/412 的 current 严格匹配同一会议和不可变快照时自动收敛；真正不同会议仍只保留冲突和资产，尚无用户恢复界面。
5. 本轮按当前目标没有恢复归档测试、做通知投递压力矩阵或执行快速连点录音 session 压测；重复 response、稳定请求 ID和最终计数已做轻量验证。

## ENTRY-02 当前范围

- `app.config.js` 固定自有 scheme `laoji`。`semanticLinks.ts` 只接受两个精确路由：`laoji://meeting/new?origin=quick_tile`，以及带唯一 `sourceEventId + occurrenceDate + action=open|meeting + origin=widget` 的 occurrence 路由。
- parser 拒绝错误 scheme/host/path、用户名密码、端口、fragment、未知参数、缺失/重复参数、非法公历日期、控制字符、超长 event ID 和超过 2048 字符的 URL。Android intent filter 只声明 `meeting/new` 与 `calendar/occurrence`，但查询参数仍由 JS 白名单再次裁决。
- 通知、Widget 和 Tile 都先持久化同一种 pending navigation，再等待 scope、navigation ready 和 `navigationUnlocked`。锁未解除时不查询 occurrence、不创建会议；无效链接不写 pending target。
- JS 构建 version 1 `UpcomingEventsProjection`：当前 scope 下未来 24 小时、最多 5 个 occurrence，仅含 ref、显示标题、开始/结束时间、全天标志、meeting action、更新时间、过期时间和隐藏标题标志。描述、地点、Transcript、Summary、笔记、录音 URL 与 meeting ID 均不进入 Widget 投影。
- 原生 `SystemEntryProjectionStore` 对 JSON 顶层和每个 item 做字段集合相等校验，同时校验 schema、scope、数量、排序、日期、时间、action 和最长 24 小时生命周期；通过后写入私有 `SharedPreferences` 并刷新 Widget。
- App Lock 开启时显示“锁屏隐藏标题”开关，默认开启。当前采用保守语义：`appLockEnabled && hideWidgetTitles` 时 Widget 在所有启动器场景隐藏标题，不声称能判断屏幕当前是否真正锁定。
- Widget 使用 `RemoteViewsService` 列表；整卡打开老记，条目正文打开 occurrence 详情，右侧动作走统一的开始/继续/查看记录用例。空投影显示“未来 24 小时没有日程”，过期或缺失投影显示“打开老记查看”。
- Tile 只唤起 Activity，不在后台直接开麦。inactive 显示“开始记录”；原生 recorder 处于 preparing/recording/paused 时显示 active/“录音中”，点击仍只回到 `MeetingLive`，不直接 stop。录音状态变更请求 Tile 刷新，刷新失败不影响录音服务。

## ENTRY-02 UI 证据分类

组件：近期日程 Widget

- Classification：capability-reduced Feishu Calendar surface；右侧会议动作是 LaoJi-only capability extension。
- `[SOURCE]`：飞书 7.71.8 `calendar_appwidget_info_medium.xml` 使用 `widget_min_width_medium=300dp`、`widget_min_height_medium=110dp`、一小时更新、横纵 resize 和 home-screen category；`widget_calendar_medium_layout_v2.xml` 为左侧星期/日期/品牌、右侧 `ListView`；`widget_default_padding=15.23dp`。`widget_calendar_item_layout_other.xml` 的条目有 4dp 底间距、加粗标题及时间/描述槽。
- `[PRODUCT]`：老记只投影未来 24 小时最多 5 条，不暴露会议正文；occurrence 正文只查看日程，明确按钮才开始/继续/查看会议记录；App Lock 下默认隐藏标题。
- `[DEVICE]`：API 35、1080×2400、density 420 的 `emulator-5556` 上，4×2 Widget 已实测空态、有数据态、标题/时间/左竖条、开始记录、继续记录、条目正文点击和动作点击。选择器使用真实 layout preview，不再退化为应用图标占位。
- `[INFERENCE]`：老记把飞书右侧事件列表缩减为标题+时间，并增加 64dp 的会议动作槽；空态、过期态、隐私标题和中文加载项是老记合同，不声称为飞书原样分支。

组件：会议录音 Quick Settings Tile

- Classification：LaoJi-only Android system entry。
- `[SOURCE]`：本轮没有飞书 7.71.8 页面或资源证据支持同一 Tile，不作飞书来源声明。
- `[PRODUCT]`：快捷入口必须经过 Activity、App Lock 和现有录音页；录音中点击只返回当前录音，不提供容易误触的 stop。
- `[DEVICE]`：`emulator-5556` 的快速设置实际显示“会议录音 / 开始记录”和麦克风图标；顶部候选包点击后创建 `entryPoint=quick_tile` 的临时会议并成功持续录音，Tile 同步切为“录音中”。录音中再次点击返回同一录音，结束后恢复“开始记录”。
- `[DEVICE]`：临时开启 App Lock 并配置系统设备凭据后，Tile 点击先进入系统“解锁老记”凭据页；错误凭据期间没有创建会议或启动录音服务，正确凭据通过后才执行同一个 pending 目标并开始录音。
- `[INFERENCE]`：active/subtitle/stateDescription 遵循 Android Tile 状态语义；录音中点击不停止、App Lock 前不创建会议均已由当前候选包的模拟器任务实测，物理设备与不同 ROM 仍不能由此替代。

## ENTRY-02 轻量验证

- `npx tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过。
- `:app:assemblePreview --parallel --max-workers=$(nproc)`：通过；627 个 task，88 executed、539 up-to-date。
- Manifest merge 确认两个受限 deep-link intent filter、Widget provider、受 `BIND_REMOTEVIEWS` 保护的 list service，以及受 `BIND_QUICK_SETTINGS_TILE` 保护的 Tile service。
- 首次加入 Widget 后，真实空态显示星期、日期、“老记”和“未来 24 小时没有日程”；整卡点击可唤起老记。测试中通过正常手动新建流程创建当天 10:00-10:30 的临时日程 `Entrydget`。
- 有数据态第一次验证暴露了真实缺陷：item XML 使用 RemoteViews 不允许的裸 `View`，启动器持续显示英文 `Loading...`。已改为允许的 `TextView` 竖条并增加中文自定义 loading layout；重装后标题、10:00、左竖条和“开始记录”正常渲染，logcat 不再出现 `Class not allowed to be inflated android.view.View`。
- 点击条目正文实际进入 `Entrydget` 日程详情，任务 Intent 为 `action=open&origin=widget`；没有创建会议。点击右侧“开始记录”进入同名 `MeetingLive` 并只产生一次 `meeting_create_shadow_write status=completed`。服务不可达后 Widget 自动更新为“继续记录”；再次点击回到同一失败可恢复记录，清空后的 logcat 没有第二次 create。
- 用 ADB 向当前 Activity 投递合法 occurrence URL，页面进入对应日程详情。随后投递同 URL 加 `extra=1`、Quick Tile URL 加 `extra=1`、以及重复 `origin` 参数，页面均保持详情且没有会议创建日志，证明 query 白名单在真实 intent 分支生效。
- Widget 选择器原先因缺少 `previewLayout` 显示应用图标占位；补充真实 layout preview 和静态中文预览值后，选择器可展示日期/空态构图。运行时日期和状态仍由 provider 覆盖。
- 模拟器测试前已保存快照 `codex-laoji-entry02-pretest-20260724`。验证完成后加载快照并覆盖安装最终 Preview；临时 `Entrydget` 日程及其失败会议已消失，原始 `OccueneSmoke` 保留。最终冷启动 audit 回到 `legacy_meetings=1`、`projected_meetings=1`、`context_mismatches=0`，无应用 FATAL、`SQLiteException` 或 RemoteViews inflate 错误。
- 最终 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-24 05:27:38 +0800`，大小 `89,935,956` bytes，SHA-256 `e23ebadc121257d35698b59c9b48b96443f13daacda5a05cf3f6d3932bae0184`。已覆盖安装到唯一设备 `emulator-5556`，`lastUpdateTime=2026-07-24 05:29:02`；最终 Widget 空态、选择器 preview 以及 Tile“会议录音 / 开始记录”再次实测通过。
- 顶部候选 APK `8756696f…e74d33b5` 在 `emulator-5556` 上补充运行 Tile：inactive 点击后生成一条 `02:54` 录音，Android 记录前台麦克风 service，系统 Tile 显示“会议录音 / 录音中”；第二次点击没有产生第二条会议，结束后 Tile 回到“开始记录”。测试会议经正常删除路径移除后，默认列表仍只有原有 3 条会议。
- 同一候选包临时为该 AVD 配置设备 PIN 并开启“系统验证 / 启动时验证”。Tile 点击后错误 PIN 阶段没有 RecordingService；正确 PIN 后 pending 目标创建并开始一条录音。结束和删除测试会议后，两项隐私开关恢复关闭，临时 PIN 清除，`locksettings get-disabled=true`，默认列表仍为原有 3 条。
- 两轮补充任务均未出现 App FATAL、React Native 致命异常或 SQLiteException；模拟器持续波形会令 `uiautomator dump` 等待 idle 超时，因此录音中页面使用系统 service 状态和截图取证，未把该超时归为应用缺陷。

## ENTRY-02 未完成边界

1. 当前没有 USB 真机；不同 ROM 的 Widget cell/span、选择器 preview、RemoteViews 列表滚动、Tile 展开层、字体缩放和后台限制尚未验证。
2. Tile 的 App Lock/pending 顺序已完成系统设备凭据正反分支；Widget/通知的相同门禁仍未做设备任务。“锁屏隐藏标题”开关会随 App Lock 出现且默认开启，但尚未在真实 Launcher 锁屏场景抽查标题投影。
3. Tile 的 recording active、录音中点击返回同一录音、停止后 inactive，以及 Widget 的 ended“查看记录”均已有当前候选包证据；paused 状态的 Tile 外观尚未单独采样。
4. 过期投影有独立原生分支，但本轮没有改系统时钟等待 24 小时；真实跨日、时区变化和夏令时行为仍需后续设备任务。
5. 当前账号 scope 的 occurrence/Widget 已有单设备运行证据；账号切换中的 pending 处理、两设备 occurrence 冲突和后端 409 合并仍缺物理设备任务。
6. 本轮遵循轻量工作区约束，没有恢复归档测试、门禁或压力矩阵；只执行了类型检查、最终 Preview 构建、定向 intent/Widget/Tile 设备任务和崩溃日志检查。
