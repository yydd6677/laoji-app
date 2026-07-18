# 飞书 Android 7.71.8 源码功能图谱

更新日期：2026-07-17

## 权威边界

本文件只记录从飞书 Android 7.71.8 源码、资源和可识别原生边界中得到的事实，不记录老记“已完成”状态。实现状态由以下机器文件决定：

- `evidence/feishu/capability-inventory.json`：全量能力、产品决策、源码引用和初始阻断。
- `evidence/feishu/manifest.json`：已进入实现、验证或关闭阶段的能力。
- `evidence/feishu/source-lock.json`：权威源文件 SHA-256。
- `build/feishu-ui-ast-report.json`、`build/feishu-android-uast-report.json`：当前实现库存。

证据优先级固定为源码/资源/smali、飞书真机活动分支、老记真实业务合同、最终渲染。截图不能代替源码闭包。

## 基线库存

- 权威根：本机 `FEISHU_SOURCE_ROOT` 指向的飞书 7.71.8 解码目录
- APK：versionName `7.71.8`，versionCode `7710850`
- APK SHA-256：`3355a2a53543ae1a68fe10844b8ed9884fffa7d1eafdc6bf8622180e43631447`
- 当前源码锁：357 个文件，其中通用壳层 38、日历 164、妙记 75、账号静态容器 8、资源 72。
- 缺失资源负面锁：3 个。它们在代码或 style 中被引用，但解码包没有正文，禁止推断曲线。

同步与验证：

```bash
npm run sync:feishu-source-lock
npm run verify:feishu-source-lock
```

## 通用壳层闭包

### 主底栏

真实主链为：

`TabPageControllerV3 -> TabPageWidget -> TabBottomBar/TabBarController -> MainTabBarView/MainTabItemView`

关键事实：

- 主底栏高 65dp；默认图标 22dp、文字 12sp。
- 选中目的地变化时，图标缩放为 `1 -> 0.8 -> 1`，两段各 125ms；同 Tab 重选只分发 `onSingleClick()`，不重放选中缩放。
- 飞书底栏由 `TabPageWidget` 持续持有；老记采用已批准的单活动 Expo 原生根适配，因此目的地变化必须把递增命令交给新活动根完整播放一次，旧根不得先自行改选中态或留下半段动画。API 35 instrumentation 已双向替换生产 `CalendarHostView` 与 `LaojiMinutesView`，通过生产 `ScaleAnimation` 的 start/end 回调验证两段 125ms motion 均完成后才移除新根，并验证命令 `1/2` 只播放一次、重复命令和同 Tab 点击不重播；完整 React/Expo 事件驱动路径仍单独保留。
- 同一 tab 再次点击进入 `onSingleClick()`，由页面实现重选动作。
- `NavBottomTabBar` 只在 More/更多页由 `NavLauncherContainerFragment` 创建，不是主底栏权威。旧文档把它当作主链的结论作废。

源码：`maintab/view/TabPageControllerV3.java`、`TabPageWidget.java`、`view/bar/TabBottomBar.java`、`TabBarController.java`、`MainTabBarItemEventListener.java`、`maintab/export/BaseTabFragment.java`、`InterfaceC91823i.java`、`maintab/export/view/MainTabBarView.java`、`widget/tab/MainTabItemView.java`。

### 当前日程 Tab 重选

真实入口与总线为：

`TabBottomBar item click -> TabBarController -> TabPageControllerV3 same-key branch -> CalendarShellViewFragment.onSingleClick() -> CalendarShellViewModel.backToday -> CalendarShellInteractor.backTodayEvent`

关键事实：

- 只有当前 Calendar Fragment 处于 `RESUMED` 时才分发；切换目的地不属于重选。
- `backTodayEvent` 的闭包包含 QuickChoose、月视图和单日视图；飞书依靠活动 Fragment/Lifecycle 与当前模式决定实际消费者。老记单原生根必须同步更新 QuickChoose，再只驱动 `MONTH` 或 `DAY` 中当前活动的一个 owner，隐藏 owner 不得被改写。
- QuickChoose 同步把选择日和页月改为设备本地今天，但不关闭面板，也不改变面板展开态。
- 单日分支现场读取当前时间，清理 `DayInstanceLayout` 自己的拖动态；横向回今天为 300ms，纵向回当前分钟为 250ms，两者可以重叠。`PositionedViewLayout.m230509i()` 在目标超过一页时先把位置钳到目标相邻页，再执行同一段 300ms 动画，因此远距离跳转的视觉起点是“目标相邻页”，不是原始日期。
- 月分支使用普通“点击今天”状态机：同日已展开则收起、其他行已展开则先收后开；跨月有相邻/非相邻六态，收起约 350ms、分页约 200ms，底栏进度分别为 400/750ms。
- 同 Tab 重选不发全局 `clearDragEvent`，也不清月缓存或取消既有加载任务。把“关闭 QuickChoose、统一清空所有临时态”作为重选合同属于错误推断。

老记的同 Tab 点击由当前 Calendar 原生底栏在派发语义事件前同步执行；React 不再维护重选序号，也不通过 prop、重挂载或跨 Bridge 往返驱动该动作。原生日期/范围事件仍会促使 React 回写新 generation 快照；若 300/250ms 回今天 motion 尚在运行，单日 owner 只更新绑定数据和 session，并保留 Pager 进度、日期头、全天区和纵向 animator，不能以普通无动画 rebind 截断飞书 motion。跨月返回今天会等待中心月页完成 rebind 后再执行最终展开，避免只换月份而没有落到今天的半完成状态。

该行为闭包锁定 92 个源文件，覆盖主底栏活动 Fragment 选择、共享 Service/RxEvent、QuickChoose、单日 Pager/滚动、sticky clone 与时间尺清理，以及月视图状态/分页/延迟调度；三日、列表和会议室分支因产品范围删除而明确排除。

### 标题栏家族与日历视图条

`CommonTitleBar` 是一个可配置的底层容器，不是所有页面共享的统一标题栏。它的闭包为：构造器属性读取 -> 44dp intrinsic 高度与子节点初始化 -> `IActionTitlebar.Action` 物化 -> 单次 tag/listener 绑定 -> 自定义测量和布局。Java 反编译错误地丢失了部分 `addAction` 布局参数，因此默认 `WRAP_CONTENT x MATCH_PARENT` 和垂直居中以 `CommonTitleBar.smali` 为准。

通用容器事实：

- 全屏常量为 44dp、bottom sheet 常量为 56dp；56dp 由外部父布局或 bottom-sheet 高度插值 owner 选择，不是构造器自动模式。另有运行 gate 可把 intrinsic 高度改成 60dp，静态源码不能证明当前产品分支命中。
- 主标题 18sp、左右 action 17sp、副标题 12sp；默认字体 family 和 weight 继承主题，只有调用方显式设置才加粗。
- 源码 dp helper 对每个正尺寸独立执行 `density * dp + 0.5` 后取整；不能先合并多个 dp 再换算，也不能直接截断。TextView 没有关闭 Android 默认 font padding。
- 左图标 normal/small 为 24/20dp。默认左外边距 15dp；纯图标右侧也是 15dp，有文字时为 8dp。右 action 默认 start/end padding 为 9/15dp，因此 24dp 图标形成 48dp槽；small helper 为 44x20dp，但必须由调用方显式使用。
- 中心标题由实际测量的左右可见宽度决定：空间足够时物理居中，冲突时向占位较小的一侧移动；`isCenterAlways` 才按左右最大宽度做对称避让。固定 96dp 边距不是源码行为。
- divider 是一物理像素且默认隐藏。源码只在 `isCenterAlways` 分支可靠地布局它，其他模式不能外推为可见分隔线合同。
- `Action` 只有文字、图标、背景、padding、tag 和点击回调，没有 enabled/loading/saving 字段；禁用、保存中和反馈由调用业务层决定。日历保存三态分别使用 B600 `#1456F0`、B200 `#C2D4FF` 和 N500 `#8F959E`。
- 日历的 `DebouncingTextAction` 和 `DebouncingClickListener` 各自保存最后接收时间；只有间隔严格大于 1000ms 才再次执行。该门禁属于具体 callback，不属于 `CommonTitleBar`：编辑取消/保存、时间完成和详情右侧 action 使用门禁，时间取消与详情返回仍是普通点击。

真实路由分家：

- 日历主标题由 60dp MainTab host、`CalendarTitleProxyNewImpl`、`C6926a` 和 `widget_tab_title_container.xml` 提供，不属于 `CommonTitleBar`。
- 日历搜索走通用 SearchActivity 链路，也不复用日历主标题或 `CommonTitleBar`。
- 普通日历编辑的 `EditTitleBar` 继承 `CommonTitleBar`，只显示“取消/保存”，没有中心标题；Mail 邀请分支才有中心标题。`SaveType` 的三态在 ViewModel 中决定保存、提示或 no-op，Action 本身仍会分发，且不存在“保存中”标题动作。
- 日历时间页直接把 `CommonTitleBar` 配置为“取消/时间/完成”；重复结束页同样使用 Common 容器。
- 日历详情的 `EventTitleViewV2` 是透明特化：20dp 返回/关闭图标，标题位于 secondary-left，右侧 action 为 44dp槽和20dp图标，并按 action 实宽动态给标题避让。标题颜色由 `C8480a` 的日历色索引映射，默认索引为 B700 `#0442D2`；浅色 icon tint 是 static black `#000000`，不能把标题色直接套给图标。
- 妙记主列表是 60dp MainTab 标题；妙记详情是自有 44dp `MmDetailTitleBar`；独立录音是 44dp top bar 加最小 100dp/24sp 标题区；讲话人标记是 50dp 标题栏加 8dp bottom margin。它们均不能因外观相近而改用 `CommonTitleBar`。

日历 `ViewIndicator` 仍是标题下方独立 50dp band，尾部只有一个 32dp 入口。飞书的单一入口打开完整视图集合；老记删除多日历、三日和列表后，将同一入口业务替换为月/日直接切换。

源码：`CommonTitleBar.java/.smali`、`CommonTitleBarConstants.java`、`IActionTitlebar.java`、`C115153a.java`、`TitleBarIconSize.java`、`AbstractC146331f.java`、`AbstractViewOnClickListenerC146329d.java`、`EditTitleBar.java`、`SaveType.java`、`EditMainViewModel.java`、`EditMultiTimeView.java`、`EventTitleViewV2.java`、`C8480a.java`、`CalendarTitleProxyNewImpl.java`、`NewMmMainTabFragment.java`、`MmDetailTitleBar.java`、`MmRecordingFragment.java`、`MmSpeakerMarkView.java`、`ViewIndicator.java`、`view_indicator.xml`。

### Dialog、Sheet 与 Toast

- `UDActionPanelBuilder` 使用 bottom gravity 和 full width。
- `UDDialog` 拒绝在 finishing/destroyed Activity 上展示。
- Sheet dim 由 Window 独立持有；退出正文为 300ms translate+alpha。
- `UDToast` 在 action、显式时长或 dismiss listener 条件下进入自管窗口，否则走系统 Toast。
- 自管 Toast 不抢焦点、无 dim、由 `UDActionToastManager` FIFO 管理；视觉为最大 295dp、14sp、水平/垂直 padding 20/10dp、单行/多行圆角 20/8dp、200ms alpha。

源码：`UDDialogController.java`、`UDActionPanelBuilder.java`、`UDToast.java`、`UDActionToastManager.java`、`UDToastViewController.java`、`ud_toast_layout.xml`。

### 启动加载与恢复态

- `CalendarLoadingView` 明确拥有 loading panel、error panel、retry action 三种状态，不以 `null` 或永久空白表达初始化。
- `view_calendar_loading.xml` 的 loading/error 视觉槽均为 125dp；状态正文为 14sp；错误正文上间距 10dp；重试动作最小宽 76dp、上间距 16dp。
- 错误插图通过浅色与夜间资源分支提供。老记 v1 只启用浅色，并依据结构重建语义图形，不复制飞书专有插图。
- `CommonUiContainer` 提供 header/content/footer 和可启用 footer action；老记将其容器合同用于配置、账号、存储和导航启动失败的业务替换。

源码：`CalendarLoadingView.java`、`view_calendar_loading.xml`、`illustration_empty_negative_load_failed.xml`、`CommonUiContainer.java`。

### 状态、Token 与 OEM 原语

- 日历和妙记都区分 loading、empty、error、retry，不使用永久空白视图代表初始化。
- 妙记空错态图为 100dp，描述 14sp，重试按钮 76x36dp。
- 权威主色为 `#1456F0`，pressed 为 `#0442D2`；divider 使用资源透明度，不以页面常量猜测。
- 阴影在 API 28 前切软件层，触觉在 API 26 前后分支，Insets 使用 AndroidX 状态栏/导航栏类型。
- 产品 chrome 使用打包图标；`android.R.drawable` 只能作为平台语义参考，不能承担最终视觉。

## 日历闭包

| 能力 | 源码闭包 | 行为事实 | 产品处理 |
| --- | --- | --- | --- |
| 入口与模式 | `CalendarMainLauncher -> CalendarShellViewFragment -> ShellView` | 飞书可装载单日、列表、月、三日 | 只保留月和单日，登记偏离 |
| 月分页 | `MonthDiagramModel -> MonthContainViewPager` | 左/中/右严格对应 -1/0/+1 月，settle 后回收 | 保留 |
| 日期展开 | `ViewOnTouchListenerC153853e -> C153854f` | 状态为 Open/Close/OpenAfterClosed；同行切页、换行先关后开、同日再点关闭 | 保留 |
| 跨日条 | `C155132d -> C153854f` | 先裁剪到当前周，再以起始列、跨度和占用层连续绘制 | 保留 |
| 单日组合 | `SingeDayView -> SingleDayHeaderView + AllDayInstanceLayout + DayInstanceLayout` | 日期头、全天区、时间轴和事件层有独立所有权 | 保留 |
| 时间轴 | `DayInstanceView + DayTimeRulerView` | 25 条整点线覆盖 00:00 到 24:00；不是 30 分钟可见网格 | 保留 |
| 默认时长/吸附 | `AbstractC150857e + C150859g` | 默认创建通常 30 分钟；移动和结束柄 15 分钟；开始柄按默认时长取 15/30 | 拆成独立合同 |
| 拖动所有权 | `DayInstanceLayout -> C150860h` | 一个覆盖事件区的 owner；顶部/底部手柄调整起止，正文移动整体 | 保留 |
| 全天区 | `AllDayInstanceLayout` | 折叠最多三行，可展开；内部滚动与横向翻日分离 | 保留 |
| QuickChoose | `QuickChooseDatePanel -> QuickChooseDateComponent -> CalendarYearMonthPicker -> WheelView` | 外层四态；日期/年月双态；可见行点击和滚动都 settle 并提交 | 保留 |
| 搜索 | `CalendarSearchFragment -> CalendarSearchView` | 输入、筛选、结果、空态、详情跳转和 transaction | 按老记能力裁筛选 |
| 详情/编辑 | `EventDetailContainerFragment -> EditEventActivity -> SaveProcess` | 创建/编辑分流，时间、重复、删除和保存状态有独立 owner | 删除参会人/会议室等无能力区域 |
| 重复 | `RepeatView -> RepeatViewModel -> ChooseRepeatEndFragment` | RRULE、自定义间隔、星期与结束条件；重复截止页使用 CommonTitleBar、支持拖动和速度判定的 UDSwitch、7 行循环年月日滚轮 | 老记保留基础预设，完整自定义间隔/星期仍待重建 |

基础重复类型在“永不截止”首次切换为具体日期时，以事件开始日为基准生成源码默认值：每天加 1 个月、每周加 3 个月、每月加 1 年、每年加 5 年。具体截止日早于事件开始日时，完成动作切换为禁用色并显示错误；取消和完成都由各自 1000ms 日历防连点 listener 持有。该页面通过 `EditFragmentController` 的水平分支进出，但 `slide_right_in/out` 正文在解码包中缺失，因此只能锁定路由所有权，不能从静态源码宣称动画曲线精确一致。

重复范围不是一个简单的显示/隐藏布尔值：普通重复实例的 `THIS_EVENT` 显示但禁用 Repeat 与 RepeatEnd，并把 Repeat 文案显示为“不重复”；已有例外实例的 `THIS_EVENT` 才整体隐藏；`FUTURE_EVENTS/ALL_EVENTS` 可编辑规则，但隐藏空 RRULE 选项。飞书年份滚轮虽只列出 1900..2100，却可能保留并提交越界原值；老记拒绝这种显示/提交分叉，该差异必须通过 `DEV-CALENDAR-DATE-RANGE-SAFETY-001` 审批，不能宣称为源码等价。

日历强制纠偏：

1. 12/24 小时制必须贯穿 ruler、月展开、搜索、详情和编辑；同页不得混用固定 `HH:mm`。
2. “30 分钟网格”不是源码事实。可见刻度、默认时长和手势吸附必须使用三个证据 ID。
3. 搜索引用 `slide_right_in/out`，但解码包缺少动画正文；不能宣称曲线精确一致。
4. 多日历、三日、列表、飞书会议联动、参会人、会议室和完整时区产品面属于已批准删除或业务替换。

## 妙记闭包

### 入口、列表与搜索

`MinutesApiImpl -> C129895a -> MinutesListActivity`

- 列表 Activity 和路由在 Manifest 中可定位。
- 列表搜索由 `MmJumpOpenSearchUtil` 进入统一搜索。
- 详情内搜索最终调用 `/minutes/api/find`，与列表搜索是两个独立闭包。

### Record V3 与录音状态

活动录制分支为：

`MmUnifiedRecordingApiImpl -> MmRecordingSession -> IVCApi/VCApiImpl -> MMRecordHostManager -> MMMeetingHostHelper -> MMToolBarView`

- Record V3 host 在源码中可达，不是“缺失动态模块”。
- 飞书同时存在 OfficeSDK/legacy 和运行时 feature gate；只读到 V3 类不能证明实际分支。
- start/pause/resume/stop 的公开合同和合法状态转换由 `InterfaceC150923a`、`MmRecordingSessionStateMachine` 给出。
- 飞书使用专有 RTC/Ogg-Opus 分片；老记用 AudioRecord、WAV、Qwen ASR 和 WorkManager，必须按业务替换验收，不能宣称 enum 或 codec 等价。

### 音频、上传与恢复

- 本地 Ogg/Opus 分片和生命周期：`MmRecordFileHelper`、`MmRecordingAudioPersistent`。
- 前台服务和恢复：`MinutesForegroundService`、`MmAudioRecordingServiceV2`。
- 上传队列、删除和重试：`MmRecordingUploadService`、`MmRecordingUploadTask`、`MmRecordingRetryPolicy`。
- 飞书存在保存、不保存和强制保存决策，并在特定上传后清理分片。老记必须另行批准自己的本地 WAV 保留策略。

### 实时字幕与纪要

- `RecordingSubtitleData` 包含 partial/final、时间和 speaker 字段。
- `MmRecordingSubtitleRepo` 组合 push、同步补偿和 fetch。
- `MmSummaryStatus`、`MmRecordingSummaryEntity`、retry helper 和 reconnect helper 定义纪要处理、成功、失败和恢复。
- 老记 Qwen ASR 与总结服务是业务替换；测试必须覆盖 partial、delta、completed、断线补拉、生成中、失败、retry 和断网恢复。

### 详情、播放器与讲话人

- 飞书详情页不是固定三 Tab。`C131182b/C131183c/MMDetailTabFragmentType` 按能力和数据动态组装转写、纪要、章节、发言人、信息和剪辑页面。
- Sticky 所有权由 `MmDetailStickyNavLayout` 提供；音频头先折叠，再交给当前页滚动。
- 播放器闭包为 `MmVideoControl -> TTVideoEngine wrapper -> MmServiceClient/MmVideoService`。
- 发言人逐段编辑使用 `paragraphId`、cluster 更新、进入锁、10 秒 heartbeat 和过期状态；老记没有对应服务 API，必须删除逐段改写入口。
- 声纹采集和管理是不同能力，可按 `VideoChatSettingVoicePrintDialogFrame` 容器做真实业务替换。

### 分享

- 飞书标题栏 CCM 分享是协作权限语义，不等于系统 `ACTION_SEND`。
- 飞书也存在真实文件下载后通过 `MmFileExternalShareHelper` 分享的闭包。
- 老记删除 CCM，保留会议文档、完整资料包和录音文件的系统文件分享。

## 账号与静态页面

- 登录容器：`LoginRegisterBaseActivity/Fragment -> CommonUiContainer`。
- 协议未确认时，飞书先弹确认，再勾选并提交。
- Mine、ProfileSetting、SettingPage 和 About 均使用通用标题栏与滚动容器。
- 老记保留自身注册、登录、访客、资料、改密、通知、删号、隐私和法律内容。
- 飞书 SSO、QR、组织目录、软件更新、认证和营业执照入口删除。

这些页面只能宣称“容器和交互仿真 + 老记业务替换”，不能宣称飞书账号业务等价。

## 负面证据

| 路径/能力 | 状态 | 约束 |
| --- | --- | --- |
| `ud_translate_from_bottom.xml` | absent | style 有引用，但正文缺失；不得从退出动画推入口曲线 |
| `slide_right_in.xml` / `slide_right_out.xml` | absent | 搜索只保留资源 ID；精确曲线不可静态闭合 |
| 入站 deep link | 老记不可达 | 无 VIEW/BROWSABLE intent-filter 和 Intent 解析；作为产品排除，不做假入口 |
| 飞书固定三 Tab | 错误命题 | 详情页动态组装；老记三页只是能力裁剪结果 |
| 飞书主底栏等于 NavBottomTabBar | 错误命题 | 主链是 TabPageControllerV3/TabPageWidget/TabBottomBar |
| 字幕逐段讲话人编辑 | 老记无 API | 删除入口；不得用全局声纹 CRUD 洗白 |

## 审阅闭包

本轮只读审阅覆盖：

- 飞书：calendar view/search/detail/edit、maintab、Universe Design dialog/toast/shadow/timepicker、Minutes list/record/recordv3/detail/player/speaker/share、passport/mine/profile/settings/about 和相关 layout/value/animator。
- 老记：16 个 Root 路由名、2 个 MainTabs 目的地、70 个 TSX、全部生产 Kotlin 页面、录音/上传/播放后台任务、Window overlay、通知与分享。
- 当前日程 Tab 重选：92 文件完整行为闭包，包含三个消费者、生命周期门禁、sticky/时间尺清理、300/250ms 单日 motion 与月视图六态/主线程延迟。

任何新实现必须先在 `capability-inventory.json` 找到证据 ID，再从 `source-lock.json` 取得权威文件；没有这两步的 UI 代码不进入实现阶段。
