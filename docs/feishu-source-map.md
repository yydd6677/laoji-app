# 飞书 7.71.8 源码功能图谱

> 状态重置：本文件保留源码路径和调用闭包作为取证材料，但其中关于老记“已实现/已关闭”的旧描述不再具有完成效力。机器状态以 `evidence/feishu/manifest.json` 为准，飞书 7.71.8 源码与资源本身仍是最终设计依据。

更新日期：2026-07-17

## 权威声明

本文件取代旧 UI 完成结论，作为日历、妙记和通用界面重构的源码证据入口。飞书源码与资源只读保存于工作区外；本仓库仅记录相对路径、哈希、行为合同和老记实现映射，不复制第三方源码或资源内容。

证据使用顺序：Java/Kotlin/XML/资源与 smali -> 真机活动分支 -> 老记业务合同 -> 截图。每项实现和测试必须引用证据编号。

## 基线

- 飞书版本：Android 7.71.8（versionCode 7710850）
- APK SHA-256：`3355a2a53543ae1a68fe10844b8ed9884fffa7d1eafdc6bf8622180e43631447`
- Java 伪源码：132,028 个文件；smali：322,559 个文件；解码资源：21,515 个文件
- 已知限制：JADX 有 1,328 个反编译错误；对应功能必须下钻 smali 或使用真机 fixture，不得猜测

## 自动索引

使用以下命令生成确定性的源码清单、哈希、入口候选和资源反向引用：

```bash
python3 scripts/index_feishu_source.py \
  --source-root /path/to/base-feishu-7.71.8 \
  --output /tmp/feishu-source-index-v2.json \
  --include-smali
```

索引文件是本地审阅证据，不进入公开仓库；权威行为闭包和行号结论收敛到下表。

2026-07-16 首轮索引结果：

| 分区 | Java 文件 | 字节数 | 入口候选 | 清单 SHA-256 |
| --- | ---: | ---: | ---: | --- |
| 日历 | 3,358 | 32,208,944 | 573 | `6cc281aa06ebff8dd3bd50a44acba031e16ae9eed1e505ff5e276d1a7ef70675` |
| 妙记 | 3,144 | 30,610,066 | 284 | `8752dd63d9f950a051d65f4b4953caf0d478efcd432887dc6085e82d9a000a9c` |
| 通用 UI | 726 | 7,307,075 | 120 | `50ed0b58dc791774706aaab6f4ce2188ed056e03b3552aa71302f14793615fd2` |

V2 索引共建立 15,330 个符号、965 个入口依赖闭包和 5,343 个 Android 资源反向引用。smali 回退清单包含日历 8,816、妙记 2,914、通用 UI 2,231 个文件；索引文件 SHA-256 为 `16853d6c0db6cc3edc0c3176e666dbb579eb4073a15cf4d39167f449926fbb38`。索引只保存相对路径、哈希和关系，不复制第三方源码内容。

## 源码闭包

| 证据 ID | 能力 | 入口与调用闭包 | 资源/状态 | 当前结论 |
| --- | --- | --- | --- | --- |
| `CAL-ROOT-001` | 日历入口与页面结构 | `CalendarMainLauncher` -> `CalendarShellViewFragment` -> 月/日 Fragment | Fragment + Presenter/View/Model | 已取证 |
| `CAL-MONTH-001` | 月视图与单月分页 | `MonthDiagramFragment` -> `MonthContainViewPager` -> `MonthDayPage` | 三页复用 Pager + 实例层 | 已取证 |
| `CAL-DAY-001` | 日视图刻度与创建区 | `SingleDayViewFragment` -> `DayInstanceLayout/View` | 25 条整点线；分钟映射 | 已取证 |
| `CAL-DAY-DRAG-001` | 临时块与事件拖动 | `C150860h` -> `AbstractC150857e` -> `C150854b/C150859g` | 单一拦截层；移动/结束手柄 15 分钟，起始手柄按时长取 15/30 分钟 | 已取证，旧 Arrange 分支引用已移除 |
| `CAL-ALLDAY-RANGE-001` | 全天事件日期边界 | `C155132d` -> 月实例跨度计算 | 含首尾日输入；内部半开区间 | 已取证并修复数据合同 |
| `CAL-DRAG-PERMISSION-001` | 事件拖动权限与跨度保护 | `EventInstanceViewHandler` -> editable/encrypted/webinar/span checks | 只允许可编辑单日定时事件进入拖动 | 已取证并修复保护条件 |
| `CAL-TODAY-LOCAL-001` | 今天的设备本地日期 | `Calendar`/设备时区状态 -> 日历 Shell | 不使用 UTC 序列化日期 | 已取证并修复 |
| `CAL-DAY-PAGER-001` | 单日页容器 | `SingleDayViewFragment` -> 日期 Pager/日期头/全天区/时间轴 | 多层原生容器与独立滚动状态 | 复审中；红队阻断三层连续进度和 header/全天横滑所有权 |
| `CAL-MONTH-EXPAND-001` | 月视图选中日展开 | `ViewOnTouchListenerC153853e` -> `C153854f` | 行展开/关闭/换行状态；350ms | 复审中；同行路径已测，关闭语义和跨行/跨月动画不成立 |
| `CAL-SPAN-001` | 跨日和重叠布局 | 全天/实例 drawable 闭包已定位 | Rust/混淆父类边界待 fixture | 已取证，待运行补证 |
| `CAL-PICKER-001` | 日期/年月快速选择 | `QuickChooseDatePanel` -> `QuickChooseDateComponent` -> `CalendarYearMonthPicker` | 月模式直接年月态；日模式日期/年月双态；wheel settle 即提交并裁月末 | 复审中；新双态/滚轮/即时提交已落地，最终修正待重编译及红队 |
| `CAL-PICKER-WHEEL-TAP-001` | 年月滚轮可见项点击 | UD `WheelView.onTouchEvent` -> `smoothScroll(CLICK)` -> `OnItemSelectedListener` | 按触点所在行计算偏移；短按与滑动都停靠并提交 | 阻断；当前自有 wheel 的 `performClick()` 未改变选中项，正在按源码修复 |
| `CAL-PICKER-HOST-001` | 快速选择宿主与转场 | `ShellView` -> 全屏 `QuickChooseDatePanel` -> drag bar/ValueAnimator | 四态开合、全屏透明命中、200/150/100ms 动画 | 复审中；新全内容区 Host/四态/拖动已落地，待最终运行闭证 |
| `CAL-SEARCH-001` | 日程搜索 | `CalendarSearchFragment` -> 搜索列表和分组行 | 原生输入、空态、滑入动画 | 已取证 |
| `CAL-SEARCH-CLOSURE-001` | 日程搜索筛选与进退场 | `CalendarSearchView` -> 时间/参与人/会议室筛选；Fragment transaction | 产品裁剪筛选；保留完整入退场 | 已取证，当前退出转场缺失 |
| `CAL-DETAIL-001` | 日程详情 | Detail Activity/Fragment -> 标题栏和信息行 | 滚动标题、编辑/删除语义 | 已取证 |
| `CAL-EDIT-001` | 日程编辑 | Edit Activity -> Container Fragment -> 时间/重复表单 | 日期必填、时间选填、RRULE | 已取证 |
| `CAL-EDIT-TIME-001` | 编辑日期与时间 | `TimeView` -> `EditMultiTimeFragment` -> `EditMultiTimeView` -> 两套 Wheel | 全屏子页；全天开关；开始/结束双列；日期轮或日期+时分轮；取消/完成 | 已取证，当前系统 `DatePickerDialog/TimePickerDialog` 必须删除重写 |
| `CAL-DETAIL-CLOSURE-001` | 详情与编辑页面区域 | V2 Detail Header/Body/Footer；Edit zones/permission | 按老记服务裁剪后的完整页面闭包 | 已取证，当前仅实现简化字段页 |
| `CAL-TIME-PRECISION-001` | 创建与调整吸附 | `AbstractC150857e.m514491a/m514492b/m514493c`；`C150854b/C150859g` 构造函数 | 初始落点与起始手柄按默认时长取 15 或 30 分钟；移动和结束手柄固定 15 分钟；最终绝对时间对齐网格 | 复审中；红队发现默认时长来源和绝对网格算法均接错 |
| `CAL-ALLDAY-EXPAND-001` | 全天区展开 | `AllDayInstanceLayout` | 3 行折叠、最高 7.5 行、100ms 高度动画 | 复审中；静态折叠已测，相邻页稳定高度和翻日展开态不成立 |
| `CAL-RESOURCES-001` | 日历语义资源与暗色 | `values/dimens/colors` 与 `values-night` | 页面不得散落硬编码颜色/尺寸 | 已取证，当前仅浅色且资源闭包不足 |
| `MIN-ROOT-001` | 妙记入口与列表 | `IMinutesApi` -> `MinutesListActivity` -> V1/V2 Fragment | Activity/Fragment/ViewPager2 | 已取证 |
| `MIN-SEARCH-001` | 列表与详情搜索 | 统一搜索入口；详情 `/minutes/api/find` | 两条独立搜索闭包 | 已取证 |
| `MIN-SEARCH-002` | 列表无匹配空态 | 妙记搜索结果状态 -> empty state | 有缓存但无匹配时显示明确空态 | 已取证并修复 |
| `MIN-REC-STATE-001` | 录制状态机与落盘 | Unified API -> OfficeSDK/legacy | 原生 RTC/AudioRecord + 前台服务 | 已取证 |
| `MIN-REC-LAYOUT-001` | 活动录制页结构与工具栏 | `ByteRTCMeetingActivity` -> VC Record V3 skeleton -> title/tab/subtitle/toolbar | ConstraintLayout；44/100/40/180dp 固定区 | 已取证并重写 |
| `MIN-REC-WAVE-001` | 活动录制波形 | Record V3 `MmAudioWaveBarView` | 3dp 条、3dp 间距、3-29dp 高度、50dp 边缘渐隐 | 实现与自动化预检通过；真机最终验收待完成 |
| `MIN-REC-TRANSCRIPT-001` | 活动录制字幕行 | VC subtitle Fragment -> normal/pure-content item | RecyclerView；20dp 水平边距；14/16sp；28dp 行高 | 已取证并重写 |
| `MIN-UPLOAD-001` | 上传、失败与恢复 | Opus 分片 -> 容量 24 队列 -> multipart/retry | VFS + 状态机 | 已取证 |
| `MIN-ASR-001` | 实时字幕与缺口补偿 | subtitle push -> sync/fetch | push-first + pull 补偿 | 已取证 |
| `MIN-SUMMARY-001` | 纪要状态与渲染 | SummaryRepo -> 原生 Markdown/FishBone | push、重试、网络恢复 | 已取证 |
| `MIN-DETAIL-001` | 详情页签与内容 | `MmDetailContainerFragment` + 原生控制层 | 动态音频头 + sticky 页签 + 分页内容 + 底部播放器 | 已取证 |
| `MIN-DETAIL-STATE-001` | 缺失会议详情状态 | 详情标题栏与内容状态控制 | 不存在时禁用编辑、分享和更多操作 | 当前产品合同已修复 |
| `MIN-DETAIL-PAGER-001` | 详情多页容器 | `MmDetailViewControl` -> 原生 ViewPager -> 六类页工厂 | 全部页常驻并保留独立滚动状态；老记裁为三页 | 复审中；单生命周期常驻成立，生产 generation/重建/Tab 竞态不成立 |
| `MIN-DETAIL-STICKY-001` | 详情粘性头部与页签 | `MmDetailStickyNavLayout` -> `NestedScrollingParent2` | 运行时头高折叠；Tab 固定；播放器是底部兄弟节点 | 复审中；核心上下消费成立，non-touch/强制收拢及生产播放器未闭证 |
| `MIN-PLAYER-001` | 播放器和进度控制 | `MmVideoControl` -> TTVideoEngine | seek/倍速/后台播放 | 已取证 |
| `MIN-SPEAKER-001` | 发言人与声纹入口 | SpeakerRepo -> 字幕长按 -> SetSpeakerInfo | 能力/权限条件化 | 已取证 |
| `MIN-SHARE-001` | 分享行为 | TitleBar -> Bear ShareParams -> CCM | 权限分享，不是 ACTION_SEND | 已取证 |
| `MIN-AUDIO-001` | 老记录音、落盘和音频 Bridge | Android AudioRecord/Service/journal/WS 闭包 | 二进制 PCM + 原子 WAV + 强杀恢复 | 已取证并实现 |
| `MIN-REC-BRIDGE-001` | 录音高频电平数据 | `MutableSharedFlow` -> `sample(80ms)` -> `Flow<Int>` -> `MMToolBarView` -> `MmAudioWaveBarView` | 原生 Flow 直驱；活动波形 30/15 FPS 插值 | 实现与自动化预检通过；真机录制待验收 |
| `MIN-RECOVERY-ENTRY-001` | 活动录音恢复入口 | 录音 session/list state/前台通知 | 行点击与主录音入口恢复现有 session | 当前产品合同已修复 |
| `MIN-UPLOAD-STATUS-001` | 上传失败状态优先级 | 上传状态机 -> 列表状态标签 | 受阻/待上传不得被已完成标签遮蔽 | 当前产品合同已修复 |
| `MIN-IMPORT-001` | 音频文件导入 | 妙记 media import workflow | 老记 API 已支持，Android 页面入口尚缺 | 已取证，未实现 |
| `MIN-DETAIL-SEARCH-001` | 详情转写搜索 | `MmSearchFragment/MmSearchControl` -> `/minutes/api/find` | 转写内查询与定位 | 已取证，未实现 |
| `MIN-SUMMARY-ACTION-001` | 纪要生成/重新生成 | SummaryRepo + summary action state | 有内容时仍可明确重新生成 | 已取证，当前入口不可达 |
| `MIN-DELETE-RECOVERY-001` | 删除与后台任务清理 | 记录删除状态与恢复任务 | 删除必须取消上传 Work 并清理 journal | 当前产品合同未闭合 |
| `MIN-PLAYER-RECOVERY-001` | 播放位置恢复 | mediaPlayback service/player state | 进程重启后恢复来源、位置与倍速 | 已取证，当前未持久化 |
| `MIN-GUEST-001` | 游客总结及数据边界 | 当前闭包已完成；飞书闭包审阅中 | 公开总结 API + 本地 task 恢复 | 当前侧已取证 |
| `UI-SHELL-001` | 导航、视图条、标题栏与 FAB | 日历/妙记活动入口和资源闭包已完成 | 50dp 视图条、44dp 标题栏、48dp FAB；长按扩展画布不扩大无障碍命中 | 已取证并补运行边界 |
| `UI-CALENDAR-INDICATOR-001` | 日历视图条与模式入口 | `view_indicator.xml` -> `ViewIndicator`；老记产品裁剪见基线合同 | 独立 50dp 条带；右侧只有一个 32dp 原控件，老记裁剪后作为月/日直接切换 | 阻断；当前错误地在标题栏并排显示“月/日”两个自创控件，必须删除 |
| `UI-SHELL-002` | 主底栏真实尺寸与按压反馈 | `NavBottomTabBar` -> `MainTabItemView` | 65dp、22dp 图标、12sp 文本、125ms 缩放 | 已取证并实现 |
| `UI-SHELL-RESELECT-001` | 当前日程 Tab 再次点击 | `CalendarShellViewFragment.onSingleClick` -> `backToday` event -> 月/日内容层 | 回到今天；不刷新、不重挂页面 | 已取证，老记 Android 尚未接入 |
| `UI-ANDROID-COMPOSITION-001` | Android 主 Tab 原生合成 | Calendar/Minutes 活动 Fragment 与 `NavBottomTabBar` 处于同一原生页面树 | 活动 Tab 单一顶层 owner；后挂载页面重新申请双系统 inset | 当前候选 `192f01fd...71573` 的 API 35 路由/组合预检通过；真机同包回归待完成 |
| `UI-OVERLAY-001` | Dialog、Sheet、Toast 与遮罩 | 角色、生命周期和状态保护已定位 | Dialog/BottomSheet/事件 host | 已取证 |
| `UI-OVERLAY-WINDOW-001` | Window 级 Overlay 所有权 | UDDialog/UDActionPanel/UDToast host | 完整入退场、inset、焦点和生命周期 | 五类 Overlay 已迁移并通过 API 35 预检；待真机与独立红队关闭 |
| `UI-TOAST-ROUTING-001` | UDToast 路由与队列 | `UDToast` builder -> 系统 Toast 或 `UDActionToastManager` | 系统/自管双路由；自管全局 FIFO | 已取证；老记纯文本单槽 latest-wins 为产品裁剪 |
| `UI-TOAST-WINDOW-001` | 自管 Toast 窗口所有权 | `UDActionToastManager` -> `WindowManager.addView` | application window、无 mask、不抢焦点 | 已实现 Activity owner 等价边界 |
| `UI-TOAST-VISUAL-001` | Toast 几何与视觉 | `ud_toast_layout.xml` -> `UDToastViewController` | 295dp、14sp、20/10dp、20/8dp 动态圆角 | 已实现并通过像素变化门禁 |
| `UI-TOAST-LIFECYCLE-001` | Toast 计时、动画和生命周期 | `UDToastViewController` + `UDActionToastManager` | 200ms alpha、4000/7000ms、stop/destroy 清理 | 已实现；后台清除且不恢复 |
| `UI-PRIVACY-001` | 锁屏与后台内容保护 | visible/resumed 消费门禁 | Dialog/语音层不得越过应用锁或后台泄漏 | 已取证并修复关键路径 |
| `UI-VOICE-001` | 日程语音层可见性 | 页面生命周期与录音 session | Tab blur/后台必须停止并丢弃临时录音 | 当前产品合同已修复 |
| `UI-MOTION-001` | 动画、触觉与系统 inset | 动画资源、振动工具和 inset 工具已定位 | 170ms FAB；语义触觉；双 inset | 已取证 |
| `UI-TOKENS-001` | 字体、颜色、圆角与分割线 | UD dimen 与日/夜颜色已反查 | 语义 token | 已取证 |
| `UI-FORM-001` | 表单、搜索和空错态 | 编辑/搜索/妙记资源闭包已完成 | 保存三态；100dp 空态；76x36 重试 | 已取证 |
| `UI-FORM-002` | 日历保存三态 | `SaveType` -> `EditMainViewModel` | enabled、disabled-with-feedback、fully-disabled | 已取证，当前未完整实现 |
| `UI-TYPOGRAPHY-002` | 字体倍率与固定容器 | 全局字体倍率、标题栏与列表资源 | 1.0/1.3/2.0x 不裁切不重叠 | 已取证，当前无运行 fixture |
| `UI-ANDROID-RUNTIME-001` | Android 运行时证据 | Android View/无障碍/动画测试闭包 | JVM 字符串检查不能替代 androidTest，MainActivity 模拟器预检不能替代真机最终验收 | 30 个 API 35 androidTest、40 个游客/生命周期检查点和 25 个认证检查点通过；真机全路由仍待执行 |
| `UI-ANDROID-DEVICE-ACCEPTANCE-001` | Android 真机最终验收 | `UI-ANDROID-COMPOSITION-001`、`UI-ANDROID-RUNTIME-001` 与 `docs/android-device-follow-up.md` | 冻结源码后只构建一份 release APK；先由物理设备专用安装门禁保留数据并校验首次安装时间、UID 与 SHA-256，再绑定小米真机上的白屏、16 个注册路由、2 个 MainTabs 目的地、交互、恢复、麦克风、音频焦点、通知、分享、TalkBack 与 OEM 渲染证据 | `scripts/android-device-install-verify.sh` 已有模拟物理设备执行测试；候选 `192f01fd...71573` 已冻结并通过 API 35 预检，USB 未枚举，真机尚未安装和核对 `base.apk` |
| `UI-LOGIN-CONSENT-001` | 登录法律协议主动确认 | 登录输入与提交 guard | 主动复选，未同意不提交 | 已取证并实现 |
| `UI-NOTIFICATION-REFRESH-001` | 系统通知权限回前台刷新 | 系统设置入口 -> resumed refresh | 返回页面立即读取真实权限 | 已取证并实现 |
| `MIN-SPEAKER-VOICEPRINT-001` | 声纹录入、互斥与用途同意 | VoicePrint dialog -> media mutex/call state/upload | 上传前主动同意；音频焦点与来电仍待闭合 | 部分实现 |
| `UI-ACCOUNT-PAGES-001` | 账号与静态页表现层 | 登录/Mine/设置/About/法律资源闭包 | 业务裁剪后逐页重写，不以换 token 代替 | 已取证，9 个 RN 页面复审中 |
| `UI-THEME-SCOPE-001` | 浅色/暗色产品范围 | values 与 values-night | v1 强制浅色；暗色不作为已实现能力 | 已取证并裁剪 |
| `UI-ROUTES-001` | 老记可达路由与后台任务 | 16 个注册路由 + Schedule/Meetings 两个 MainTabs 逻辑目的地；覆盖层/任务闭包已完成 | 两个前台 Service + WorkManager 上传 | 游客与一次性真实账号/已完成会议链均绑定当前 APK 通过，API 35 的 16+2 已齐；真机 16+2 尚待执行 |
| `UI-LEGACY-001` | 旧表现层和高频 JS 路径 | 全路由反向闭包已完成 | RN Animated/PanResponder/硬编码几何 | 已取证 |
| `UI-DUP-001` | 重复或孤立操作入口 | 16+2 目的地及页面动作闭包 | `Recording` 已删除；会议行负责打开详情，长按菜单只保留继续录音、重命名和删除 | 已实现，运行态复审中 |

## 日历源码证据

- `CAL-ROOT-001`：`java-sources/com/p325ss/android/lark/calendar/impl/features/calendarview/CalendarMainLauncher.java:49`、`.../main/fragments/CalendarShellViewFragment.java:215`、`.../MonthDiagramFragment.java:25`。主入口是主 Tab Fragment，不是独立 Calendar Activity。
- `CAL-MONTH-001`：`.../month/MonthDiagramView.java:294`、`.../month/view/MonthContainViewPager.java:30,86`。Pager 固定 left/center/right 三页，翻页后只重绑一个邻月，因此一次手势只推进一个月。
- `CAL-DAY-001`：`.../daysview/common/widget/DayInstanceView.java:207,232`。时间轴绘制 25 条整点线并按全天分钟数映射；飞书源码不支持“可见 30 分钟网格”这一旧假设。
- `CAL-DAY-PAGER-001`：`.../daysview/singleday/fragment/SingleDayViewFragment.java:67,83` -> `SingeDayView.java:286,348-399,468` -> `SingleDayHeaderView.java:180-269` + `SingleDayInstanceLayout.java:16-70`。时间轴先作为全屏层加入，日期头、全天区、展开箭头和阴影随后覆盖；日期 Pager、全天区和时间轴共享位置进度，但各自保留 View 与滚动所有权。日期头内部 `DayWeekIndicator.java:67` 使用循环 ViewPager2，页面由 `DayHeaderPage.java:155` 创建七个等宽日期项。
- `CAL-DAY-DRAG-001/CAL-TIME-PRECISION-001`：`java-sources/pd3/C150860h.java:182-203` 独占一次 down/move/up；`AbstractC150857e.java:227,237-248,301-312,412-420` 固定移动和结束手柄为 15 分钟，并将最终绝对位置吸附到网格；`C150854b.java:126-147` 与 `C150859g.java:156-178` 以日历默认时长小于 30 分钟时取 15，否则取 30。此前引用的 Arrange 5 分钟分支不属于目标单日路由，已从合同移除。
- `CAL-ALLDAY-EXPAND-001`：`.../singleday/view/AllDayInstanceLayout.java:122-155,345-402` 按相邻页最大事件数稳定高度，折叠最多 3 行、每行 25dp，展开 viewport 上限为 7.5 行即 187.5dp，真实内容超高后由内部纵向滚动承接；高度动画为 100ms。`AllDayInstanceView.java:297` 证明溢出时三行实际为两个事件加“还有 N 项”，全天事件只点击、不进入长按拖动。
- `CAL-MONTH-EXPAND-001`：`java-sources/re3/ViewOnTouchListenerC153853e.java:746-810` 定义 `None/Open/Close/OpenAfterClosed` 四态：首次点击打开、同行换列只换详情页、换行先关后开、再次点击同一日关闭；`C153854f.java:631-640` 为每段 350ms `AccelerateDecelerateInterpolator`。选中行移到顶部，后续行压到底部，中间由七页日详情 Pager 填充；换行是两段约 700ms。`MonthContainViewPager.java:31-53,88-117` 只负责外层三个月复用，跨月时若已展开先等待 350ms 关闭。
- `CAL-SPAN-001`：`.../daysview/threeday/view/WeekAllDayInstanceLayout.java:252,402`、`.../instancelayer/calendareventlayer/MonthAllDayInstanceDrawableData.java:13`。数据与 drawable 闭包成立；跨周、跨月和非全天跨日的最终圆角/切分仍需运行 fixture。
- `CAL-PICKER-HOST-001`：`CalendarShellViewFragment$onBind$1.java:32` 把主标题点击交给 `ShellView.m231444i()`；`ShellView.java:285,377,395` 按 `CLOSED/OPENING/OPENED/CLOSING` 开合并将面板以 `MATCH_PARENT x MATCH_PARENT` 最后加入 Shell。透明剩余区域和 drag bar 都消费触摸；`QuickChooseDatePanel.java:167,215,259` 按剩余进度计算最长 200ms 动画，拖动使用 rawY、系统 touch slop 和 `[-height,0]`，松手按移动方向完成，不使用速度或半高阈值。
- `CAL-PICKER-001/CAL-PICKER-WHEEL-TAP-001`：`QuickChooseDateComponent.java:122,365,691` 定义日期/年月双态及四个内部转场，150ms 切态、100ms 日期高度调整，并同步 alpha、可点击性、标题颜色和箭头 0-90 度旋转。`CalendarYearMonthPicker.java:87` 使用五项可见的 UDTimePicker；`oe3/C148748a.java:69` 定义 1900-2100 年非循环轮和 1-12 月循环轮，中心 17sp、外围 14sp。`com/larksuite/component/universe_design/timepicker/impl/base/WheelView.java:446-479` 在抬手时按触点所在可见行计算 `mOffset`，短按执行 `smoothScroll(CLICK)`，停靠后由 `OnItemSelectedListener` 立即提交；没有“确定/取消草稿”。日号逐月裁到月末，关闭后从已提交日期重建。
- 快速选择资源：`quick_choose_date_component.xml:6` 给出 16dp 顶/左距、14sp 年月标题、22sp 图标、32dp 星期栏和年月区上下 8dp；日期态高为 `32dp + 月行数 * 38dp`（老记裁掉农历后的分支）。`WheelView.java:170` 给出 5 个可见项、每项 48dp，即 240dp 轮高，加 padding 后年月区 256dp。`quick_choose_date_panel_layout.xml:26` 另含 28dp drag bar、2dp 顶距、15dp 阴影尾区和 0.5dp divider；256dp 不是完整面板固定高度。
- `CAL-SEARCH-001`：`.../search/fragment/CalendarSearchFragment.java:131,240,318`。
- `CAL-DETAIL-001`：详情 Activity/Fragment、标题栏和信息行闭包见自动索引中的 `calendar` 入口依赖图。
- `CAL-EDIT-001`：`.../events/edit/EditEventActivity.java:194`、`.../events/edit/EditEventContainerFragment.java:81`、`.../feature/repeat/CustomRruleListGenerator.java:68`。
- `CAL-EDIT-TIME-001`：`TimeView.java:181-197` 在开始或结束区域被点击后把 `EditMultiTimeFragment` 作为全屏子页加入编辑容器，不调用 Android 系统日期/时间 Dialog。`fragment_choose_multi_time.xml:2-77` 定义标题栏、全天开关、开始/结束容器及上下各 20dp 的内嵌 wheel 区；`EditMultiTimeView.java:156-185,188-196` 同时预建全天日期轮和定时时间轮，并使用“取消/时间/完成”标题栏；`EditMultiTimeView.java:268-284,412-443` 根据全天态切换两套轮。定时轮来自 `HourMinuteWheelTime`，日期轮来自 `AllDayWheelTime`；开始/结束选择仍由 `EditFragmentTimeContainer.java:262-293` 的双区域命中控制。老记裁掉飞书的时区与参与人本地时间区域，但不得用 `DatePickerDialog/TimePickerDialog` 替代整个子页。
- `CAL-DAY-001` 时间边界：`.../arrange/arrangetime/ArrangeModel.java:272` 和 `ArrangeView.java:1118` 将次日 `00:00` 正规化为 1440 分钟并显式扩展跨日终点。
- 单日时间轴固定 1236dp，padding 为 `0/16/3/20dp`、ruler 为 56dp，见 `DayInstanceLayout.java:630`；`DayInstanceView.java:225` 只画 25 条 0.5dp 整点线。空白点击先创建默认 30 分钟临时块，再次点击才进入编辑（`DayInstanceLayout.java:693`）；相邻日程序化切换使用 300ms Decelerate（`PositionedViewLayout.java:291`）。
- `DayInstanceAccessibility.java:36` 为每个定时事件创建具备真实屏幕 bounds 与点击 action 的虚拟节点，空白半小时槽不创建节点。12/24 小时格式由飞书账号设置流驱动，UNKNOWN 才回退系统；老记只使用系统设置属于已登记产品偏离，但同一页面不得混用两套格式。
- 日历动画：单日全天区高度 100ms；月视图每段行动画 350ms；拖动选择条 150ms；搜索子页使用 `slide_right_in/out`。对应 `AllDayInstanceLayout.java:345-402`、`C153854f.java:631-640` 与 `CalendarSearchFragment.java:248`。

日历主 UI 闭包排除 `com.haibin.calendarview`、MaterialCalendarView、Google Material DatePicker、protobuf 实体和消息卡片旁支；未发现它们作为主 Tab 月/日视图渲染入口。

## 老记当前实现证据

- `UI-ROUTES-001`：`src/navigation/index.tsx` 注册 16 个 Root Stack 路由；`Schedule` 与 `Meetings` 是 `MainTabs.android.tsx` 内的两个逻辑目的地，不是 React Navigation 路由。`Recording` 已删除。`AuthStore`、`EventsStore`、`MeetingsStore` 承担 repository/coordinator 职责，应保留业务合同而不是连同页面重写。
- `UI-ROUTES-001` 运行门禁：`scripts/android-emulator-route-smoke.sh` 真实启动 `com.laoji.app/.MainActivity`，从 accessibility 节点实时 bounds 计算点击位置，保存逐 checkpoint UI 树/Activity/Window/logcat，并在安装前后和结束时绑定 release APK SHA-256；任何生产源码、Gradle、Manifest、依赖或配置文件晚于 APK 都拒绝运行。候选 `192f01fd...71573` 已在 API 35 跑完游客登录、Schedule/Meetings、日程创建/详情、MeetingLive 失败态、SpeakerManager、Profile/ProfileField、Account、NotificationSettings、Privacy、Legal 及 Home/force-stop/重复启动共 40 个检查点。`scripts/android-account-route-smoke.sh` 再以权限为 `0600` 的一次性真实账号夹具和服务端确认 `completed` 的会议，通过 25 个检查点补齐 Transcription、SpeakerEnrollment、ChangePassword 与 AccountDeletion，清理时删除账号及所属数据。API 35 的 16+2 预检至此完整；脚本仅在显式 `ALLOW_PHYSICAL_DEVICE=1` 时接受真机，真机 16+2 仍未关闭。
- `UI-LEGACY-001`：Android 活动日历与会议路由已切入本地 Expo 模块；旧 `DayTimelineView`、`QuickDatePanel`、通用会议页面只允许作为 iOS 回退，Android 门禁不得引用。当前原生日视图、年月面板和会议详情虽已脱离 RN 高频手势，仍因容器结构偏差列入整体替换。
- `MIN-AUDIO-001`：旧 `react-native-live-audio-stream` Base64 PCM 路径已从 Android 目标依赖移除；当前由 `LaojiRecordingService` 直接写入 WAV、发送二进制 PCM，并由 journal/WorkManager 处理恢复。会议可见电平也已按 `MIN-REC-BRIDGE-001` 留在原生进程内。
- `MIN-REC-BRIDGE-001`：飞书 RTC 音量从 `MmRecordingEngine.java:2311` 进入 `MmAudioRecorderV2.java:148` 的零 replay `MutableSharedFlow`，`MmRecordingSession.java:2864` 过滤成功值并明确 `sample(80ms)`；`MMToolBarView$subscribeVolume$1.java:55` 在主线程收集并只在 started 状态送入 WaveView。`MmAudioWaveBarView.java:629-707,804` 使用最多 10 项待处理队列、目标周期峰值、`0.2/0.08` attack/decay 和余弦插值，非低端机 30 FPS、低端机 15 FPS；`MmAudioWaveIdleController.java:55` 的 16ms 只属于 idle 分支，不能写成活动波形主周期。录音状态另由 StateFlow 承载，不能与音量 Flow 混写。
- 老记现行链路由 `RecorderEngine.kt:453-478` 把最高 10Hz 的电平写入按 session 隔离的 `RecorderLevelHub`；`MinutesRecordingSurface.kt:438-480` 只在可见、attached 且 recording 时收集当前 session 最新帧，暂停、隐藏、切换 session 或 detach 均取消 collector。`MinutesRecordingWaveformView.kt:18-229` 在 View 内完成最多 10 项待处理峰值、`0.2/0.08` attack/decay、余弦插值和 30/15 FPS 自调度；低频 snapshot 已移除 waveform，旧 JS level state 已删除。停止结果由 `RecorderEngine.kt:607-615,714-749` 一次返回最后 160 个样本压缩出的 `audioBars`，成功、可恢复失败和重复 stop 共用同一摘要。只有 `AudioPurpose.MEETING` 停止 JS level emit，日程语音与讲话人采集的既有低频消费者仍保留。
- `MIN-UPLOAD-001` 当前侧：`MeetingUploadWorker` 拥有网络约束、幂等重试和进程恢复，页面 detached Promise 不再是 Android 上传生命周期所有者。
- `MIN-GUEST-001`：`src/services/api.ts:651` 将游客转写发送给 guest-summary 服务，`meetingSummaryTasks.ts:4` 本地恢复任务最长 55 分钟；法律文案不能再声称游客会议完全不离开本机。
- `UI-DUP-001`：Android 会议详情只保留一个会议文档分享入口；旧 `RecordingScreen` 已删除。会议行点击是唯一详情入口，Android 与 iOS 回退页的长按菜单已删除同义“查看详情”，只保留继续录音、重命名和删除；组件回归通过，仍需在最终 16+2 整包矩阵检查各状态下不存在重复动作。
- `UI-ANDROID-COMPOSITION-001`：旧 `MainTabs.android.tsx` 同时导出主容器、活动内容和底栏三个 Fabric/Expo 所有者；API 35 模拟器与小米真机均出现内容 View 已测量、辅助功能节点存在、但最终帧只合成最后一个底栏的稳定白屏。当前 `MainTabs.android.tsx` 任一时刻只挂载 `CalendarHostView` 或 `LaojiMinutesView` 一个导出原生根；两个根在 Kotlin 内部复用 `LaojiNativeBottomBarView`，`NativeMainContainerView` 及其注册和 JS bridge 已删除。候选 `192f01fd...71573` 已通过 API 35 非空像素、内容 ROI、返回、Home、强停和重复启动预检；最终关闭仍必须由同一文件在真机执行等价矩阵。
- `UI-OVERLAY-WINDOW-001`：`WindowOverlayController` 在 Activity `android.R.id.content` 下建立唯一 host，搜索、语音、ActionSheet、Dialog 和 Toast 均为其内部 View，不再注册为独立 View Manager。Toast 生产调用只保留日程编辑、资料字段和改密表单的真实纯文本反馈；原生日程页通过低频 `feedback` 语义事件交给窗口 owner，仓库内不再存在 `android.widget.Toast` 生产路径或 Android Toast action API。展示前拒绝 finishing、destroyed 或非 resumed Activity，后台立即清除且不恢复；定位取导航栏与 IME inset 的较大值，并随 `WindowInsetsAnimationCompat` 原生更新。同文案由 `presentationKey` 重新展示并重置计时；卡片使用不可点击、不可聚焦且不进入无障碍树的触摸消费容器，只有正文是 polite live region，Activity host 的卡外区域保持透传。生产 `WindowOverlayEntryRegistry` 执行 latest-wins 和 stale-owner 拒绝移除。`scripts/android-emulator-overlay-smoke.sh` 已覆盖目标 ROI 帧差异、唯一 overlay class、Toast Home 清理、IME 上移、卡内/卡外命中、同文案重入、单调时钟 3 秒计时、约 200ms 退场、基线恢复、搜索 IME、Sheet 恢复、语音输入、Dialog 隐私关闭和 bridge/crash 扫描。JS 快照仍先经 `nativeValues.ts` 递归去除 `undefined`。
- 当前应保留的合同：账号/游客隔离、重复事件 identity、冲突与通知协调、缓存和编辑/删除 journal、会议 checkpoint/finalizer、上传错误分类、总结 fingerprint/task 恢复、音频 URL 安全校验、分享与删除清理。

## 妙记源码证据

- `MIN-ROOT-001`：`java-sources/com/p325ss/android/lark/integrator/minutes/MinutesApiImpl.java:716` -> `dg5/C129895a.java:35` -> `.../module/list/base/MinutesListActivity.java:218`。远程 FG 决定 V2 `MmHomeContainerFragmentV2` 或 V1 `MmMainTabFragment`，两条均真实可达。
- `MIN-SEARCH-001`：`.../p446mm/utils/MmJumpOpenSearchUtil.java:31` 打开统一列表搜索；详情搜索由 `MmSearchFragment/MmSearchControl` 调 `/minutes/api/find`（`.../net/api/C95647c.java:984`）。
- `MIN-REC-STATE-001`：`MinutesApiImpl.java:706` -> `MmRecordingApplinkControl.java:117` -> `MmUnifiedRecordingApiImpl.java:1779`。Office 状态定义在 `.../statemachine/MmRecordingSessionState.java:10`；正常个人录制走 RTC，local/offline 分支才使用 `AudioRecordExternalAudioSource.java:153`。这是生命周期与能力证据，不再被当作当前手机录制页面的布局证据。
- `MIN-REC-LAYOUT-001`：当前手机入口落在 `ByteRTCMeetingActivity` 的 VC Record V3 分支。`java-sources/com/p325ss/android/p523vc/common/utils/VCPreloadLayoutIdUtils.java:104` 返回 `vc_fragment_mm_ui_skeleton2`；该布局的 `decoded-resources/res/layout/vc_fragment_mm_ui_skeleton2.xml:32-164` 固定 44dp 顶栏、最小 100dp 标题区、40dp 页签和 154dp 基础底栏，`java-sources/c87/C7986j.java:85-103` 在当前个人 AI 记录开关路径将底栏改为 180dp。
- `MIN-REC-LAYOUT-001` 标题与控制：`decoded-resources/res/layout/mm_layout_record_title_bar_3.xml`、`mm_layout_record_title_name_3.xml:1-101`、`mm_layout_record_toolbar_bar_3_new.xml:6-101` 分别给出左尖括号返回图标与 44dp 命中区、24sp 标题/14sp 时间、26dp 计时、56dp 波形容器、32dp 波形和 78x44dp 操作按钮。`mm_bg_record_toolbar_secondary_btn_3.xml`、`mm_btn_record_status_pause_3_new.xml` 与 `mm_bg_record_toolbar_stop_btn_3.xml` 均使用 100dp 胶囊圆角；`java-sources/com/p325ss/android/lark/p446mm/module/recordv3/MMToolBarView.java:1509-1612` 定义 402dp 与 600dp 两个响应式分支。
- `MIN-REC-WAVE-001`：`.../recordv3/wavebar2/MmAudioWaveBarView.java:673-704,805-880` 使用 3dp 条宽、3dp 间距、4dp 侧边、3-29dp 高度、五条一组和 `N900_50`，布局两端另有各 50dp 渐隐层。老记只接收归一化电平，不复制飞书代码或资源。
- `MIN-REC-TRANSCRIPT-001`：`decoded-resources/res/layout/vc_mm_subtitle_fragment.xml:2-98` 使用 20dp 水平内边距的 RecyclerView 与回到底部浮层；`vc_mm_subtitle_normal_item.xml` 使用 20dp 头像、14sp 讲话人/时间、3dp 分隔点及 16sp/28dp 正文。录制页不得复用详情页的通用内容行。
- `MIN-UPLOAD-001`：`.../foundation/utils/cache/file/MmRecordFileHelper.java:29` 保存 Ogg/Opus 分片；`.../core/service/upload/MmRecordingUploadService.java:364` 使用容量 24 队列、成功后删分片，并按线性/指数退避重试且封顶 30 秒。legacy 默认 3 秒 Opus 分片。
- `MIN-ASR-001`：`.../repo/subtitle/MmRecordingSubtitleRepo.java:1173` 同时监听 push 并提供 `fetchSubtitles/syncAndFetchSubtitles` 补偿，不能仅依赖一次 WebSocket 连接。
- `MIN-SUMMARY-001`：`.../repo/summary/MmRecordingSummaryRepo.java:131` 负责纪要 push、重试和网络恢复；普通纪要布局 `decoded-resources/res/layout/office_sdk_mm_fragment_recording_summary_feishu.xml:8` 使用 NestedScrollView + 原生 Markdown TextView。
- `MIN-DETAIL-001`：`.../p446mm/module/detail/MmDetailContainerFragment.java:917,1219` 注册详情控制器并加载 `mm_detail_container.xml`。资源 `mm_detail_container.xml:28-86,153` 的纵向所有权为 44dp 标题栏、Sticky 容器、底部 `MmAudioToolBar`；播放器不是 Sticky 子 View。录制中、Podcast、视频、Text-only、AI、评论、Clip 和翻译分支不属于老记音频详情目标。
- `MIN-DETAIL-PAGER-001`：`.../detail/main/MmDetailViewControl.java:2236,2312` 初始化原生 ViewPager、将 offscreen limit 设为页数并在 200ms 后设置初始页；`ef5/C131182b.java:156` 与 `C131183c.java:65` 闭合页适配器和六类工厂。字幕页使用 `mm_fragment_transcription.xml` 的 RecyclerView，纪要页使用 `mm_fragment_detail_summary_audio.xml` 的 NestedScrollView，发言人页使用 `mm_fragment_speaker_timeline.xml` 的独立 RecyclerView。老记删除无服务能力的章节/内容/Clip 后仍必须使用三个常驻 Page View，不能向同一 Adapter 换数组。
- `MIN-DETAIL-STICKY-001`：`MmDetailStickyNavLayout.java:91-129,187-297` 只接收纵向嵌套滚动，向上先把父偏移消费到运行时测得的头部高度；向下只有当前页不能继续向上滚动时才展开头部，偏移夹在 `0..headerMeasuredHeight`。Pager 高度为 `stickyHeight - 41dp tab - visibleHeaderHeight`；20dp 只是滚动方向累计通知阈值，相关更新条动画 200ms，不是折叠高度。
- 音频头 `mm_detail_audio_header.xml:6` 为 wrap-content、24sp 标题、20dp 水平/顶部边距和 6dp 副标题间距；播放器 `mm_detail_audio_toolbar.xml:2` 为 wrap-content、32dp 底部 padding、48dp 控制区及 80x48dp 播放键。反编译资源不足以静态推出工具栏最终总高，老记不得继续固定为 100dp，应按内容和系统 inset 测量。
- `MIN-PLAYER-001`：`.../p446mm/module/player/MmVideoControl.java:592` 封装 TTVideoEngine，支持直链/HLS、seek、倍速、静音跳过和 mediaPlayback Service；`newplayer` 只是 UI 控件层。
- `MIN-SPEAKER-001`：`MmRecordingSpeakerRepo` 订阅 speaker push；`.../record/speaker/MmSpeakerMarkViewModel.java:785` 在能力和权限满足时提交 `SetSpeakerInfo`。
- `MIN-SHARE-001`：`.../detail/titlebar/MmDetailTitleBarViewControl.java:365` -> `integrator/minutes/C82790k.java:17` -> CCM 权限分享。老记没有 CCM 服务，不能复刻其协作语义。
- 主录制页面采用 slot 化 ConstraintLayout、字幕 RecyclerView、底部工具栏和自绘 `MmAudioWaveBarView`；当前老记只提供录制中的“文字记录”，因此删除没有真实实时总结能力的第二页签并按相邻源码收拢。Office SDK 录制布局仍存在于 APK，但不是本次实际手机入口的页面基线。

妙记主闭包排除豆包宿主、Podcast、硬件同步、本地文件导入、Bear 文档插件和飞书会议 feed；这些能力虽有真实入口，但不属于老记“新建个人会议记录”的产品范围。

## 老记服务器实时合同

2026-07-16 只读核验活动进程：会议与日程后端 cwd 均为 `$LAOJI_SERVICE_PLATFORM/smart-meeting-ai/backend`，端口为 18020/18035，Qwen3-ASR 本机服务为 8030。部署机上的真实根目录只记录在服务器协作审阅文档，不进入公开移动端仓库。

- `app/api/qwen_ws.py:210-454`：会议和日程使用 `/qwen` 路由；输入必须是偶数字节 PCM16，零长度二进制帧触发 VAD flush，完成后返回 `ready_to_stop`；服务端持久化会议 `transcript.completed`。
- `app/api/ws_auth.py:20-105`：登录态使用 Bearer，游客使用 `X-Guest-Session-Token`；query token 只作兼容，原生新实现只发送 Header。
- `app/api/app_meetings.py:42,180-260,515-580`：允许 `.wav/.mp3/.m4a/.aac/.ogg/.webm/.flac`，上传先写 `.part` 再原子替换，按用户目录隔离；默认单文件上限 1GB。
- `app/api/app_meetings.py` 与 `app/services/guest_meeting_session_service.py`：游客会话可在撤销前按 token 拉取已完成字幕；字幕使用稳定 ID、TTL 清理和分页，不设置每小时/句数/字符产品限额。2026-07-16 真实 Qwen 音频探测确认 WebSocket final 与恢复接口返回一致。

## 通用 UI 源码证据

- `UI-SHELL-001/UI-SHELL-002`：日历视图条 `view_indicator.xml` 固定 50dp，但它不是主底栏。主底栏闭包为 `CalendarTabPageConfig.java:194` -> `NavBottomTabBar.java:281` -> `MainTabItemView.java:249`，真实 item 高 65dp、图标 22dp、文字 12sp、按压缩放 125ms。`fragment_calendar_append_event.xml` 定义 48dp FAB；老记长按圆弧可使用更大的私有绘制面，但 TalkBack/UIAutomator bounds 和短按命中必须保持 48dp。妙记详情/录制标题栏固定 44dp。
- `UI-CALENDAR-INDICATOR-001`：`decoded-resources/res/layout/view_indicator.xml:2-42` 明确视图条是独立的 50dp 容器，尾部只有一个 `sidebarEntrance` 32dp 控件；`ViewIndicator.java:173-215` 只绑定该单一尾部入口。飞书原入口通往被产品裁掉的侧栏，老记依据 `feishu-calendar-baseline-contract.md` 将其改为月/日直接切换，但必须保留“单一控件”结构。旧版老记 `src/screens/ScheduleScreen.tsx:362-385` 也只有一个 `calendar-toggle-view`；标题栏并排“月/日”没有任何源码或产品合同依据。
- `UI-SHELL-RESELECT-001`：`CalendarShellViewFragment.java:693-697` 的 `onSingleClick()` 只在页面 resumed 时调用 `handlePageSwitch(true,true)`；`CalendarShellViewFragment.java:1035-1045` 将“前后都是日历 Tab”解释为 `CalendarShellViewModel.Action.backToday()`；`CalendarShellViewModel.java:873-879` 再向 `CalendarShellInteractor` 发布 `backToday` 事件。月/日内容层订阅同一事件并移动逻辑日期，不销毁 Fragment；`SingeDayView.java:220-225` 随后调用 `DayInstanceLayout.java:211-215`，把今天的时间轴滚到当前时刻。老记应以一次性低频命令传给活动 `CalendarHostView`，同时关闭临时 QuickChoose/草稿、跳到设备本地今天并滚到当前分钟；禁止通过 React `key` 强制重挂整页。
- `UI-ANDROID-COMPOSITION-001`：飞书日历由 `CalendarMainLauncher` 进入 Calendar 主 Tab Fragment，妙记由 `MinutesListActivity` 进入 V1/V2 Fragment，底栏由 Activity/Fragment 的同一 Android View 树持有；不存在多个跨框架导出 View 竞争同一主页面的结构。老记不复制飞书宿主代码，但保持“一个活动页面树、一个底栏 owner”的等价合同。
- `UI-OVERLAY-001`：Dialog 明确 secondary/primary/destructive 角色；Sheet 在 Fragment state 已保存时拒绝展示。`MmHomeContainerFragmentV2$subscribeData$1.java:122` 只在页面 visible/resumed 时消费 loading/plain/success 反馈。
- `UI-TOAST-ROUTING-001/UI-TOAST-WINDOW-001`：`.../universe_design/toast/UDToast.java:229-353` 总会构造带 UD View 的系统 Toast；builder 仅在 action、正时长或 dismiss listener 且 Context 可解出 Activity 时进入 `UDActionToastManager.java:48-69,308-319` 的自管 FIFO。自管分支由 `C43662c.java:92-110` 使用 `WindowManager.addView`，参数为 `WRAP_CONTENT`、application window、`FLAG_NOT_FOCUSABLE`，无 mask。老记没有同时可达的 loading/action Toast 产品入口，因此统一使用 Activity child 单槽并 latest-wins，避免重新引入 OEM 系统 Toast 不确定性。
- `UI-TOAST-VISUAL-001`：`decoded-resources/res/layout/ud_toast_layout.xml:9-57`、`values/dimens.xml:2897-2904` 和 `values/styles.xml:10065-10078` 共同给出最大 295dp、14sp 常规体、20/10dp padding、action 最大 75dp、1dp divider 与最多 12 行；`UDToastViewController.java:52-76,84-111` 在单行使用 20dp 圆角、多行使用 8dp 圆角并按 action 实测宽度压缩正文。
- `UI-TOAST-LIFECYCLE-001`：`UDToastViewController.java:256-286` 的入退场均为 200ms 纯 alpha；`UDToast.java:245-278` 的自管默认时长为 4000ms，长时长为 7000ms。`UDActionToastManager.java:155-319` 在 stop/destroy 立即移除当前 Activity 项且不保存恢复。老记保留相同时序与“后台清除、不恢复”，并额外以 resumed/finishing/destroyed 门禁拒绝保存状态后的新展示。
- `UI-FORM-001`：搜索空错态合同为 100dp 插画、14sp 描述和 76x36dp 重试按钮；表单保存分为 enabled、disabled-with-toast 和 fully-disabled 三态。飞书日历搜索吞错、妙记提醒失败只写日志属于负面证据，不复制。
- `UI-TOKENS-001`：`decoded-resources/res/values/dimens.xml:2852` 给出 26/24/20/17、16/14、12/10sp 字号，2/4/6/8/10/12dp 圆角和 0.5dp divider；`values/colors.xml:28` 与 `values-night/colors.xml:3` 给出日夜语义映射。
- `UI-MOTION-001`：`p446mm/utils/C95695e0.java:33` 定义日历拖动 80ms、妙记长按 100ms、章节/摘要 20ms、倍速 50ms和空间不足 500ms触觉，并提供 API 26 回退；`lark/insets/WindowInsetsUtils.java:181` 分别消费状态栏与导航栏 inset。
- 两项资源缺口 `slide_left_right/slide_right_left` 和 `mm_layout_home_filter_item_my` 只有 `public.xml` ID，无 XML 本体；动画曲线和筛选布局必须用真机 fixture 补证，不能从相邻资源猜测。

## 独立红队结论

- 飞书订阅系统 12/24 小时状态并动态生成 25 个标签：`SingeDayView.java:428`、`DayTimeRulerView.java:255`。老记标尺已读取系统制式，但事件块、详情、搜索和编辑仍未统一格式化，保持复审中。
- 飞书默认时长由设置驱动，代码缺省 60 分钟；用户设备活动设置为 30 分钟。老记采用设置字段并将初始值设为 30，不写死渲染逻辑。
- `DayInstanceLayout.java:387,693` 证明拖动由全宽覆盖层统一接管；当前多个 PanResponder 结构不能保留。
- `mm_view_speed_picker.xml` 定义 `0.5/0.75/1/1.25/1.5/2/3x`；播放器迁移必须完整支持七档。
- `MmSubtitlesAdapter.java:1322` 与 `MmEditSpeakerProxy.java:350` 证明飞书支持字幕级发言人编辑；老记当前服务没有对应 API，因此只保留真实的声纹管理和识别标签，不伪造逐段编辑。
- 遮罩与底部按钮的静态所有权已对齐，但仍须用 UIAutomator 对错误、确认框、键盘和遮罩前后的按钮 bounds 做运行闭证。

## 关闭规则

“关闭”必须同时具备源码路径与行号、资源或状态定义、活动分支证据、老记差异、实现路径和可执行测试。旧截图、旧 `[x]`、测试数量或构建成功均不能单独关闭源码证据。
