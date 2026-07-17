# 老记 Android 原生平台架构合同

> 状态重置：旧实现结论仅作故障调查记录。新重建代码必须同时通过源码锁、证据 manifest、运行时 View 证据和独立行为测试，不能因符合本文件的抽象描述就宣称与飞书一致。

更新日期：2026-07-17

## 原则

技术栈由飞书源码闭包预先决定，不采用“先用 React Native，出现问题后再下沉”的方式。Android 高频交互、音频生命周期和飞书使用原生控件的完整页面由 Kotlin 承担；TypeScript 保留业务规则、数据仓库和低频 API 编排。

## 模块边界

目标本地 Expo 模块：`modules/laoji-native-platform`。

| 子系统 | Android 所有者 | TypeScript 所有者 | Bridge 边界 |
| --- | --- | --- | --- |
| 日历页面族 | 三页 ViewPager + 自定义 View/Canvas + 单一拖动层 | 事件 repository、默认时长设置与业务校验 | 事件快照、设置与语义操作 |
| 妙记录制和转写详情 | RecyclerView/分页容器/Canvas/原生动画 | 会议 repository 与总结 API | 会议快照与低频命令 |
| 录音与实时 ASR | AudioRecord + ForegroundService | 鉴权与服务配置 | 状态、部分/最终转写、文件结果 |
| 上传恢复 | WorkManager | 云端会议状态同步 | 持久任务状态 |
| 播放器 | Media3 ExoPlayer + MediaSessionService | 音频 URL/本地文件解析 | 播放状态和用户命令 |
| 主页面底栏与公共弹层 | 活动 Tab 原生根内部底栏 + Window 级弹层宿主 | 导航意图与业务确认 | 低频语义命令 |
| 账号和法律静态页面 | React Native | 原有 store/service | 无高频 Bridge |

Android 原生表现层覆盖日历页面族、年月选择、搜索、事件详情与编辑、妙记列表/搜索/录制/详情、播放器、发言人页面、主底栏、公共弹层和高频动画。账号与法律静态页面可保留 React Native，但必须依据 `UI-*` 证据整体重写。迁移期间允许旧页面仅作为未切换的 iOS 回退；Android 目标路由一旦切换，不得再引用旧 RN 表现层。

本地包内部拆为独立所有者：能力诊断、日历核心、日历页面、妙记 UI、录音会话、上传恢复、播放器、讲话人和公共 UI。各模块不得通过一个全局可变“大平台状态”互相耦合。

### 主 Tab 原生合成

`UI-ANDROID-COMPOSITION-001` 规定 Android `MainTabs` 任一时刻只能挂载一个导出的 Expo/Fabric 原生根。日历由 `CalendarHostView`、会议主列表由 `LaojiMinutesView` 作为完整活动页面 owner，并在各自 Kotlin 树内持有同一个 `LaojiNativeBottomBarView` 实现；TypeScript 只处理 `tabPress` 语义并替换活动根。禁止重新引入“导出主容器 + 导出活动内容 + 导出底栏”的同级或嵌套组合。

`UI-SHELL-001/UI-ANDROID-RUNTIME-001` 还要求自绘控件的语义 bounds 与真实触摸目标一致。`CalendarCreateFabView` 可保留 `160dp` 私有画布以绘制长按四分之一圆弧，但 TalkBack/UIAutomator 只暴露可点击的 `48dp` 加号屏幕范围；原生仪器测试必须从该语义范围中心注入触摸并收到 `create-menu`。路由驱动只将“可操作父节点 + 同名静态文字子节点”归一为一个目标，两个可操作同名节点仍视为歧义并失败。

`UI-SHELL-RESELECT-001` 规定当前 `Schedule` 已激活时再次点击日程 Tab，TypeScript 只递增一次性命令序号；活动 `CalendarHostView` 在原生树内关闭 QuickChoose 和临时草稿，将月 Pager、日 Pager、选中日及可见范围移动到设备本地今天，日视图时间轴滚到当前分钟附近，并回传正常范围事件。不得用 React `key`、卸载/重挂 Surface 或重新创建 store 模拟“回到今天”。

状态栏 inset 由活动页面根消费，导航栏 inset 由内部底栏消费。Tab 切换后新挂载的根和底栏必须在 attach 时主动 `requestApplyInsets()`，不能依赖窗口首次分发。录制和会议详情复用 `LaojiMinutesView` 时底栏必须为 `GONE`，只有 `MinutesSurface.LIST` 显示主底栏。

### 日历原生组合

`CAL-DAY-PAGER-001` 要求单日页由日期头、全天区、三页日期 Pager、每页时间轴 Canvas 和独立手势层组成，禁止由一个 View 同时绘制日期头、全天区、事件、草稿并接管全部触摸。日期 Pager 只保留左/中/右三页，settle 后回中；日期头、全天区和时间轴共享页面进度与选中日，但各自保留滚动和无障碍所有权。相邻日程序化切换为 300ms Decelerate，不得逐帧跨 Bridge。

单日时间轴总高固定 1236dp，top/right/bottom padding 为 16/3/20dp，ruler 为 56dp；有效 1200dp 分为 24 个 50dp 小时段，只绘制 25 条 0.5dp 整点线。空白首次点击按 `snapshot.settings.defaultEventDurationMinutes` 创建临时块，再次点击临时块才进入编辑。`CAL-TIME-PRECISION-001` 固定移动与结束手柄为 15 分钟；初始落点和起始手柄按日历默认时长决定精度，默认时长小于 30 分钟时为 15 分钟，否则为 30 分钟；所有手势都吸附最终绝对时间，不吸附相对 delta。目标单日路由不得重新引入 Arrange 的 5 分钟分支。

`CAL-ALLDAY-EXPAND-001` 的全天区折叠为最多三行；溢出时是两个事件加“还有 N 项”，而不是三个事件。每行 25dp、chip 水平间距 3dp，展开 viewport 上限按整数行高乘 7.5 后截断，内容超过上限才由全天区内部纵向滚动接管；高度动画固定 100ms。横向手势仍属于日期 Pager，全天事件只响应点击。

`CAL-MONTH-EXPAND-001` 要求每个周行是独立 View，中间详情区是七页日事件 Pager。状态固定为 `None/Open/Close/OpenAfterClosed`：首次点击打开、同行换列只切详情页、换行先 350ms 关闭再 350ms 打开、再次点击同一日关闭。点击判定的 X/Y 阈值均为 20dp；选中行移动到顶部，后续行压到底部。外层月份仍为三页复用且一次手势只前进一个月。

月展开状态归当前 `MonthPageView` 所有。宿主在选日回调中同步回写 snapshot 时只能原位更新已绑定页面的数据，不得用 `notifyDataSetChanged()` 重建当前页并丢失 `expandedSelection`；事件数据刷新、React prop 回写和同月选择都必须让正在进行的 350ms 动画继续完成。

所有定时事件必须提供可点击的原生无障碍节点及真实屏幕 bounds，空白时间槽不伪造节点。ruler、事件时间、草稿时间与无障碍文案必须使用同一套系统 12/24 小时 formatter；使用系统设置代替飞书账号设置是已登记产品偏离，不能导致同页混合格式。

`CAL-PICKER-001/CAL-PICKER-HOST-001` 的快速选择仍属于 `CalendarHostView` 页面树，不迁移到 Window Overlay。宿主铺满日历内容区并消费透明剩余区域触摸；可见面板按内容测量，禁止固定为 298dp。外层开合四态使用最长 200ms 的剩余进度动画，内部日期/年月切态 150ms，日期行数高度变化 100ms；动画中反向操作必须从当前进度继续。

月视图点击标题直接进入年月态；日视图先进入日期态，并允许通过年月标题切换到五项 wheel。日期态在老记无农历分支使用 `32dp + 月行数 * 38dp`；年月轮为 1900-2100 年非循环、1-12 月循环、5项可见、48dp 行高、240dp 轮高和上下各8dp padding。wheel settle 立即提交选中日期并逐月裁到月末，不保留确定/取消草稿。关闭、重新打开和模式切换必须从已提交日期恢复。

`UI-CALENDAR-INDICATOR-001/CAL-PICKER-WHEEL-TAP-001` 固定两个结构边界：标题栏不得承载并排“月/日”控件；其下保留飞书 50dp 视图条，右侧只有一个 32dp 图标入口，按产品裁剪直接切到另一模式。年月 wheel 的任一可见非中心项可短按，按触点行计算目标并使用与拖动相同的停靠/提交链；`performClick()` 空实现不算支持点击。

`CAL-EDIT-TIME-001` 要求事件编辑的日期/时间修改进入同一个原生全屏子页，而不是 Android `DatePickerDialog`、`TimePickerDialog` 或 Window 弹层。子页固定包含标题栏、全天开关、开始/结束双列和内嵌 wheel；全天态使用开始/结束日期轮，定时态使用日期及时分轮，点击双列只改变当前编辑端，完成后一次性回写规范化起止值，取消则恢复进入前草稿。老记不提供时区和参与人本地时间，因此从飞书结构中删除这两个区域并收拢下方空间；不得以四个独立系统选择器替代相邻布局。

### Window 级 Overlay

`UI-OVERLAY-WINDOW-001` 规定 Android 临时页面不得再作为主原生根旁边的第二个 Expo/Fabric View。`WindowOverlayController` 在前台 Activity 的 `android.R.id.content` 下只建立一个 host，并在 host 内按固定 z-order 持有 page、sheet、dialog、toast 四个 slot。日历搜索、日程语音层、ActionSheet、Dialog 和 Toast 均由该 owner 直接实例化 Kotlin View；TypeScript 只调用 `presentOverlay/dismissOverlay` 并接收低频语义事件。

关闭搜索或语音层时，原生 View 必须先释放输入焦点、撤销待执行的键盘任务、隐藏 IME，再执行退出动画；ActionSheet/Dialog 的业务动作只能在原生关闭回调后执行。Dialog/Sheet 每次 attach 都重新申请 inset，导航栏 inset 到达后必须即时回写现有 Sheet padding，不能等下一次 render 才修正几何。所有 JS 快照在进入 Expo Kotlin converter 前必须递归移除 `undefined`，因为 Kotlin bridge 只接受明确的标量、集合、Map 或 `null`。

Toast 使用 `UI-TOAST-ROUTING-001/UI-TOAST-WINDOW-001/UI-TOAST-VISUAL-001/UI-TOAST-LIFECYCLE-001` 合同：Android 生产调用只走非导出的 Activity child，不使用 `android.widget.Toast`、RN overlay 或 action API；展示前必须为 resumed 且非 finishing/destroyed Activity；后台立即清除且不恢复；默认 4000ms，显式时长原样使用；200ms 纯 alpha 入退场；动态内容宽度不超过 295dp，14sp、20/10dp padding、单行 20dp/多行 8dp 圆角。底部位置使用导航栏与 IME inset 的较大值，并在系统键盘动画中原生更新；卡片消费内部点击、host 外部区域透传。同文案用 `presentationKey` 重新展示并重置 native timer。老记按真实纯文本调用裁剪飞书系统/自管双路由、action 和全局 FIFO，采用单槽 latest-wins；该偏离见下表。

### 活动录制页面

活动录制页以飞书当前实际入口的 VC Record V3 为技术基线，不再复用 `MinutesTitleBar`、详情页 `MinutesContentAdapter` 或旧 `LinearLayout` 录制页。`MinutesRecordingSurface` 只负责固定的 ConstraintLayout 区域和语义动作；`MinutesRecordingTranscriptAdapter`、`MinutesRecordingWaveformView` 与 `MinutesRecordingV3Contract` 分别拥有字幕行、Canvas 波形和响应式几何。业务状态仍由 TypeScript 快照提供，PCM、波形动画和滚动不得逐帧回到 React。

`MIN-REC-BRIDGE-001` 的目标数据边界为：`RecorderEngine` 发布带 `sessionId/sequence/normalized/peak/rms/durationMs/capturedAtElapsedMs` 的原生电平帧，进程内最新值 Flow 直接由可见且 attached 的 `MinutesRecordingSurface` 收集；重复数值也必须借助 sequence 发射，切换 session、隐藏或 detach 时取消 collector，重新 attach 时只重放当前 session 最新帧。WaveView 在约 10Hz 目标值之间自行按 30/15 FPS 插值，不注册重复 frame callback。低频 snapshot 保留 phase、标题、动作、字幕和错误，但移除 waveform；原生 elapsed 不得被较旧 JS snapshot 覆盖。停止结果一次性返回最后 160 个样本压缩出的 `audioBars`，保持现有持久化语义。

飞书录制中 AI 重点与实时总结需要老记当前没有的服务能力，因此不保留禁用按钮或假页签。工具栏左槽收拢为不可点击的真实录制/转写状态，第二页签删除；该偏离只改变产品能力，不改变 44/100/40/180dp 主结构和操作区响应式合同。

### 妙记详情页面

`MIN-DETAIL-PAGER-001/MIN-DETAIL-STICKY-001` 的纵向所有权固定为 44dp 标题栏、可用高度内的 Sticky 容器和底部 wrap-content 播放器。Sticky 内依次持有运行时测量的音频头、41dp 页签和常驻 Pager；播放器是 Sticky 的外部兄弟节点，不得把播放器本身做成折叠头，也不得固定整个播放器为 100dp。

音频头标题为 24sp，水平及顶部边距 20dp，副标题间距 6dp；折叠上限始终取头部 `measuredHeight`。向上嵌套滚动由父级先消费至头部完全折叠，再交给当前页；向下只有当前页到顶后才由父级展开。Pager 可用高按 `stickyHeight - 41dp - visibleHeaderHeight` 动态计算；20dp 只用于滚动方向累计通知，不得误作折叠阈值。

老记保留转写、纪要、发言人三个真实页签，每页拥有独立 RecyclerView 或 NestedScrollView，并设置三页离屏保留；页签往返不得清空列表实例、滚动位置、加载/错误状态。章节、内容、Clip 等无服务能力页从数据模型、适配器和布局中删除。现有分享、删除、生成总结、讲话人和 seek 语义接口保留，逐页状态通过向后兼容 snapshot 扩展进入原生层。

### 全量静态复审后的替换决定

2026-07-16 对 16 个 React Navigation 路由、2 个 MainTabs 逻辑目的地、5 个导出 View Manager、4 个非 View 原生函数模块、全部生产 Kotlin 和飞书日历/妙记/通用资源闭包重新静态审阅。以下所有者不得继续以局部样式修补关闭仿真任务：

运行闭包采用两层确定性驱动：游客驱动覆盖公开与本机数据路由；认证驱动通过 App 真实 API 创建权限为 `0600` 的一次性账号夹具，将会议状态确认到 `completed` 后覆盖会议详情、声纹、改密和删号路由，并在退出时删除账号及所属数据。两层在 API 35 上已覆盖 16+2，但只属于真机前置门禁；架构状态不得据此跳过同一 APK 的真机路由、OEM 合成和硬件生命周期验收。真机安装先由 `scripts/android-device-install-verify.sh` 独立完成保留数据覆盖安装、首次安装时间/UID 保持、设备 APK 哈希和冷启动检查；该入口拒绝模拟器、首次安装和任何清数据操作。

1. `DayGestureOverlayView` 已删除；`SingleDayCalendarView` 现由日期 Pager、日期头、可展开全天区、时间轴、独立拖动层和虚拟无障碍代理组成。纯 Canvas 只保留时间/重叠绘制，不再拥有整个页面或全部触摸；静态门禁禁止旧文件回归。
2. `CalendarYearMonthPanel` 及其固定 298dp/确认草稿实现已删除；当前为全内容区 QuickChoose 宿主、日期/年月双态、透明命中、拖动条和 ValueAnimator 状态机。15dp 阴影尾区已按源码从拖动高度排除，待重编译和独立复审后关闭。
3. 标题栏内自创的并排“月/日”控件违反 `UI-CALENDAR-INDICATOR-001`，必须删除；视图模式入口重建为独立 50dp 视图条中的单一尾部控件。
4. `CalendarEditPageView` 的系统 `DatePickerDialog/TimePickerDialog` 必须删除，并按 `CAL-EDIT-TIME-001` 重建为全屏双端日期/时间 wheel 子页；该项未完成前编辑页不得关闭。
5. `MinutesDetailSurface` 的旧单 RecyclerView 实现已整体替换为 ViewPager2、每页独立滚动容器、`NestedScrollingParent2` sticky audio-header/tab 和底部播放器兄弟节点；summary/transcript/speaker 数据行已按页面职责拆分，旧通用详情 Adapter 已删除。独立复审发现生产 generation、进程重建、non-touch 边界、Tab 乱序和播放器整包路径仍需修复，当前不得关闭。
6. Dialog、ActionSheet、日历搜索、语音层和 Toast 已重建为 Activity/window 级单一 Overlay owner；RN Toast 与 `android.widget.Toast` 生产分支已删除，Toast 已补 resumed/finishing/destroyed 展示保护。
7. `MinutesRecordingWaveformView` 与 `SpeakerWaveformView` 的静态绘制可保留，输入合同改为 Recorder 原生 Flow 直驱和 View 内插值；100/120ms 电平事件不得再经过 JS state -> 完整 snapshot -> native prop 往返。

账号与法律页继续允许 React Native，但“共用标题栏 + 换语义色”不算重写完成。登录、资料、账号、通知、删除、隐私、法律共 9 个普通 RN 页面必须逐页建立飞书最近容器证据、明确老记业务裁剪，并完成字体倍率、键盘、错误态和完整进退场验证。

## 禁止路径

- Android 日历和会议最终可达路由不得保留嵌套 `PanResponder`。
- 原始 PCM 不得以 Base64 逐帧发送到 JavaScript。
- 原生绘制和拖动不得逐帧更新 React state。
- 录音文件落盘、上传恢复和播放器不得依赖页面组件仍然挂载。
- Android 生成目录保持可再生；自有 Kotlin 代码必须位于受 Git 跟踪的本地 Expo 模块或配置插件中。
- 原生页面的飞书相似度不得只由 Jest 字符串检查、JVM 纯数学或构建成功关闭；关键 View 必须有 androidTest/UIAutomator 行为证据。
- Android 主 Tab 不得同时挂载两个导出的 Expo/Fabric 原生视图；内部底栏不得再次注册为独立 JS View Manager。

## 音频持久化合同

- AudioRecord 直接向原生 WebSocket 发送二进制 PCM，同时写入带会话 journal 的临时文件；原始帧不进入 JavaScript。
- 正常停止时补全 WAV 头、`fsync` 并原子改名为完成文件，然后才发出 `localSaved`。
- App 启动和录音 Service 恢复时扫描 journal 与临时文件，按实际 PCM 长度修复 WAV 头并重新登记，不能截断同名旧文件。
- ForegroundService 拥有录音生命周期；WorkManager 拥有网络约束、上传重试和重启恢复；页面卸载不影响两者。
- TypeScript 不再接收会议录音的连续电平；只接收部分/最终转写、低频状态、停止时一次性的 `audioBars` 和文件 URI，不等待带固定超时的 native stop URI。实时 ASR 与讲话人采集的既有电平消费者在分别迁移前继续保留。

## 迁移顺序

1. 建立模块、编译 smoke 和 JS 空壳接口。
2. 迁移共享音频运行时及本地文件合同。
3. 删除并重建日视图组合容器与年月 QuickChoose 宿主，再切换对应 Android owner。
4. 删除并重建妙记详情 Pager/sticky 容器，并补详情搜索、媒体导入和任务清理。
5. 完成 Window owner 的 Toast 迁移和原生 Flow 波形数据合同，并由静态门禁阻止回退到 JS 高频路径。
6. 逐页重写账号/法律静态表现层，删除 Android 旧表现层和旧音频桥。
7. 保留 iOS 功能回退，执行 Android release 与跨设备验收。

## 偏离登记

偏离飞书使用的技术原语前，必须在此记录对应证据 ID、飞书方案、偏离原因、替代方案和等价验收。

| 证据 ID | 飞书方案 | 老记方案与原因 | 等价验收 |
| --- | --- | --- | --- |
| `CAL-MONTH-001` | 旧三页 `InfiniteViewPager` | 使用受支持的 ViewPager2 实现固定三页复用，避免引入过时私有 Pager | 任意速度手势一次只跨一月；回中不闪烁或丢状态 |
| `CAL-DAY-PAGER-001` | 日期头使用大范围循环 ViewPager2，时间轴使用自有 PositionedViewLayout 并共享 position progress | 使用固定左/中/右三页 ViewPager2，settle 后无动画回中；保留独立日期头、全天区、时间轴和共享进度，不复制专有容器 | 双向连续翻日、300ms 程序化切换、三层日期一致、回中不闪烁、每页临时态和滚动同步的 androidTest |
| `UI-CALENDAR-INDICATOR-001` | 50dp `view_indicator` 中单一尾部入口打开包含多日历与四种视图的侧栏 | 老记明确裁掉多日历、三日和列表视图；保留同一 50dp 容器与单一尾部图标，点击后直接在月/单日间切换 | 视图树只有一个模式入口；每次点击只切一次；模式恢复、QuickChoose 关闭和 TalkBack 标签正确 |
| `MIN-UPLOAD-001` | 未发现业务 WorkManager 调用 | 使用 WorkManager 保证老记在系统杀进程后的上传恢复；属于可靠性增强，不宣称飞书复刻 | 进程死亡、重启、断网恢复、重复入队和登出隔离测试 |
| `MIN-REC-STATE-001` | 正常个人录制使用飞书 RTC，local/offline 使用 AudioRecord | 老记没有飞书 RTC 服务，采用源码中同类的 AudioRecord 分支并连接现有 Qwen PCM WebSocket | 后台、锁屏、重连、字幕补偿和真实人声测试 |
| `MIN-REC-LAYOUT-001` | Record V3 工具栏左槽为 AI 重点，页签可包含实时总结 | 老记没有录制中 AI 重点和实时总结服务；删除第二页签，左槽显示不可点击的真实状态 | 不出现占位能力；主结构、按钮尺寸、响应式分支、错误覆盖和录音生命周期保持源码合同 |
| `MIN-UPLOAD-001` | 16kHz Ogg/Opus 分片并由专用 multipart 服务上传 | 老记服务没有飞书分片协议；当前使用可强杀修复的 16kHz mono PCM16 WAV，并由 WorkManager 流式上传完整文件 | WAV 头/长度、1GB 限制、强杀修复、断网重试与播放 |
| `MIN-PLAYER-001` | TTVideoEngine | 专有引擎不可复用；最终使用单一 Media3 依赖实现相同 seek、倍速、后台和 audio focus，切换时移除 Android expo-av 播放路径，避免双 ExoPlayer | 依赖树唯一、行为脚本和后台播放测试 |
| `UI-ANDROID-COMPOSITION-001` | Activity/Fragment 的同一 Android View 树持有活动页面和 `NavBottomTabBar` | Expo/Fabric 不能复用飞书宿主；由每个活动 Tab 的唯一导出原生根在 Kotlin 内部持有共享底栏，避免多导出 View 在模拟器和厂商设备只合成最后一个 display list | 候选 `192f01fd...71573` 已通过 API 35 非空像素、单根、Tab 和生命周期预检；仍须在真机通过同包 Tab 循环、返回、前后台、强停重启和重复启动后关闭 |
| `UI-TOAST-ROUTING-001` | 普通反馈走系统 Toast；action/显式时长/dismiss listener 走 Activity Window 全局 FIFO | 老记仅有三个路由内纯文本反馈入口；删除 Android action API，统一走 Activity child 单槽 latest-wins，避免 OEM 系统 Toast 差异和无产品价值的跨路由队列 | 静态与 API 35 先验证唯一 owner、卡内/卡外命中、IME 动画、同文案重入、Home 清理、单调时钟超时、200ms 退场、页面恢复与 crash scan；真机验证触摸、IME 和 OEM 合成后关闭 |

Android 目标路由已移除 `expo-av` 播放和 `react-native-live-audio-stream` 录音依赖。`audit:android-native` 强制只允许一个 `ExoPlayer.Builder` 所有者和一个 Media3 版本；iOS 继续使用 `expo-audio` 回退。
