# 飞书仿真重新审阅账本

更新日期：2026-07-17

## 状态规则

- `未审阅`：尚未形成源码闭包。
- `已取证`：源码与资源闭包完整，但尚未实现。
- `复审中`：已有实现，但旧完成结论已撤销，正在重新追踪源码闭包和逐页差异。
- `已实现`：实现已落地，尚未通过独立复审。
- `已关闭`：源码派生测试、运行证据和红队复审全部通过。
- 旧 `docs/current-work-goal.md` 中 UI、交互和技术栈相关的 `[x]` 均视为历史状态，不继承到本账本。

## 强制哨兵

| 证据 ID | 检查项 | 当前状态 | 关闭证据 |
| --- | --- | --- | --- |
| `CAL-TODAY-LOCAL-001` | “今天”按设备本地日期计算 | 已实现 | UTC 序列化已移除；TS 回归测试通过 |
| `CAL-ALLDAY-RANGE-001` | 全天事件完整覆盖最后一天 | 已实现 | Bridge 增加显式半开末日；TS/JVM 三日跨度测试通过 |
| `CAL-TIME-PRECISION-001` | 初始落点/起始手柄按默认时长取 15/30 分钟，移动/结束手柄固定 15 分钟；最终绝对时间对齐网格 | 复审中 | 红队发现实现按事件时长取起始精度且吸附 delta；非整点移动可产生错误时间，必须改生产算法并补运行测试 |
| `CAL-DRAG-PERMISSION-001` | 跨日、全天和只读事件不进入拖动 | 已实现 | `canMutateInDayView` 保护与 JVM 测试通过 |
| `CAL-DAY-PAGER-001` | 日期 Pager、日期头、全天区、时间轴分层 | 复审中 | 旧单一 Canvas owner 已删除，但红队确认只有时间轴 Pager；header/全天区不驱动横滑且没有连续进度联动 |
| `CAL-ALLDAY-EXPAND-001` | 全天区 3 行折叠、展开和 100ms 动画 | 复审中 | 静态折叠/展开通过；红队确认未按相邻页最大事件数稳定高度，普通翻日还错误折叠展开态 |
| `CAL-MONTH-EXPAND-001` | 月视图选中日展开及 350ms 行动画 | 复审中 | 七页详情和同行换日通过；红队确认关闭后高亮残留、详情错误渐隐，跨行/跨月/中断未验收 |
| `CAL-MONTH-EXPAND-HOST-001` | 宿主 snapshot 回写不销毁展开状态 | 阻断 | 2026-07-17 真机无法展开；新增生产式回写 androidTest 稳定复现 `expandedSelection=null` |
| `CAL-MONTH-001` | 一次滑动只改变一个月 | 复审中 | 静态三页步长通过；仍缺运行时快速滑动闭证 |
| `CAL-PICKER-HOST-001` | 全屏透明命中、月/日模式双态、拖拽和 200/150/100ms 完整转场 | 复审中 | 固定 298dp/系统 NumberPicker/确认草稿已删除；新 Host 曾通过 7 JVM + 3 API35，阴影尾区最终修正待重编译和红队 |
| `CAL-PICKER-WHEEL-TAP-001` | 年月 wheel 可见项点击停靠并提交 | 阻断 | 飞书 `WheelView.java:446-479` 明确支持；老记当前 `performClick()` 空实现，只能滑动 |
| `UI-CALENDAR-INDICATOR-001` | 50dp 视图条内单一模式入口 | 阻断 | 当前标题栏自创并排“月/日”双按钮；与飞书 `view_indicator.xml`、旧版单按钮及产品裁剪合同均不符 |
| `CAL-EDIT-TIME-001` | 编辑日期/时间使用全屏双端 wheel 子页 | 复审中 | 飞书源码闭包已补齐；当前仍调用系统 `DatePickerDialog/TimePickerDialog`，不得关闭 |
| `CAL-SEARCH-CLOSURE-001` | 搜索筛选裁剪与完整进退场 | 已取证 | 产品筛选已裁剪；当前退出直接卸载 |
| `CAL-DETAIL-CLOSURE-001` | 详情/编辑按能力裁剪后的完整页面闭包 | 已取证 | 当前页面只实现少量字段和简化区域 |
| `CAL-RESOURCES-001` | 语义资源、字体倍率和暗色范围 | 复审中 | 当前大量硬编码且只启用浅色 |
| `UI-SHELL-001` | 不存在同页重复录音/创建按钮 | 复审中 | 16 个注册路由 + 2 个 MainTabs 目的地已枚举；当前 APK 的游客主链及一次性账号/已完成会议数据态预检通过，真机仍待检查 |
| `UI-SHELL-002` | 主底栏 65dp/22dp/12sp/125ms | 已实现 | 源码闭包、原生几何与 Jest 合同已同步 |
| `UI-SHELL-RESELECT-001` | 当前日程 Tab 再次点击回到今天、滚到当前时刻且不重挂页面 | 复审中 | 飞书 `onSingleClick -> backToday -> DayInstanceLayout.backToday` 闭包已取证；Android 事件目前只重复设置同一 Tab |
| `UI-ANDROID-COMPOSITION-001` | 主页面只有一个导出原生根且不再白屏 | 复审中 | 当前候选 APK `192f01fd...71573` 已通过 API 35 路由、Tab、Home、强停和重复启动预检；同包真机白屏矩阵尚未执行 |
| `UI-ANDROID-DEVICE-ACCEPTANCE-001` | 当前 release APK 在真机完成 16 个路由、2 个 MainTabs 目的地及硬件行为验收 | 复审中 | 候选哈希已冻结并写入 `docs/android-device-follow-up.md`；USB 未枚举，真机尚未安装和生成 `base.apk` 证据 |
| `MIN-REC-STATE-001` | 停止后本地音频真实存在 | 已实现 | ForegroundService + journal + `fsync` + 原子 WAV；JVM 测试通过 |
| `MIN-REC-LAYOUT-001` | 录制页采用当前活动 Record V3 结构 | 已实现 | 旧表现层已删除；专用 ConstraintLayout/标题/页签/180dp 工具栏已落地，待真机与红队复审 |
| `MIN-REC-WAVE-001` | 录制波形使用 Record V3 几何与渐隐 | 已实现 | 3dp/3dp/3-29dp/50dp Canvas、30/15 FPS 插值、JVM 与 API 35 androidTest、独立红队通过；真机显示与真实录音待最终验收 |
| `MIN-REC-BRIDGE-001` | 会议录音电平不经 JS 高频往返 | 已实现 | session 原生 Flow 直达 Surface；JS snapshot 已移除 waveform；自动化边界已通过，真机真实录音待最终验收 |
| `MIN-REC-TRANSCRIPT-001` | 录制字幕不复用详情通用行 | 已实现 | 专用 RecyclerView adapter；20dp/14sp/16sp/28dp 合同 |
| `MIN-UPLOAD-001` | 断网上传可恢复且不丢会议 | 已实现 | WorkManager、加密凭据租约、幂等任务与内容 URI 流式上传 |
| `MIN-RECOVERY-ENTRY-001` | 活动录音从列表、主按钮和通知可恢复 | 已实现 | 行点击恢复、主按钮复用 session、通知 contentIntent 已落地 |
| `MIN-DETAIL-STATE-001` | 缺失会议不暴露编辑、分享和空菜单 | 已实现 | `available` 快照贯穿 TS/Kotlin；定向测试通过 |
| `MIN-DETAIL-PAGER-001` | 详情页使用分页并保留每页滚动状态 | 复审中 | 三个常驻页和单生命周期独立滚动已通过；红队确认生产 generation 恒为 0、重建不恢复且静默 Tab 存在乱序 |
| `MIN-DETAIL-STICKY-001` | 运行时音频头与页签使用 nested sticky，播放器保持底部兄弟节点 | 复审中 | 几何与核心上下消费通过；红队阻断 non-touch/强制收拢、生产播放器、动态失效与错误态完整行为 |
| `MIN-PLAYER-001` | 真实音频播放、倍速与前后 15 秒 | 复审中 | Media3 能力已测；播放器布局与交互重审中 |
| `MIN-PLAYER-RECOVERY-001` | 进程重启恢复来源、进度和倍速 | 已取证 | 当前播放位置未持久化 |
| `MIN-SPEAKER-001` | 发言人入口与权限边界真实可用 | 复审中 | speaker CRUD 已测；入口和页面相似度重审中 |
| `MIN-SPEAKER-VOICEPRINT-001` | 声纹上传主动同意、来电和音频焦点 | 复审中 | 主动同意已实现；来电/焦点合同尚未关闭 |
| `MIN-UPLOAD-STATUS-001` | 上传受阻状态不被“已完成”遮蔽 | 已实现 | 状态优先级 helper 与测试已落地 |
| `MIN-IMPORT-001` | 从本机导入媒体并进入处理 | 已取证 | 服务 API 可处理，Android UI 尚无入口 |
| `MIN-DETAIL-SEARCH-001` | 转写内搜索和定位 | 已取证 | 当前详情页无搜索入口 |
| `MIN-SUMMARY-ACTION-001` | 已有纪要时可重新生成 | 已取证 | 当前动作只在空态 Overlay 可见 |
| `MIN-DELETE-RECOVERY-001` | 删除会议同步取消 Work 与 journal | 已取证 | 当前后台任务清理不完整 |
| `UI-OVERLAY-001` | 错误/遮罩不推动核心按钮位置 | 复审中 | 全部覆盖层重新审阅中 |
| `UI-OVERLAY-WINDOW-001` | Overlay 由 Window 级单一宿主完整进退场 | 已实现 | 五类 Overlay 已由 Activity 唯一 owner 承载并通过 overlay smoke；待独立红队关闭 |
| `UI-TOAST-ROUTING-001` | Toast 路由与队列裁剪有明确边界 | 已关闭 | 三个生产入口、Activity 单槽 latest-wins、真实 registry 测试、API 35 运行证据和独立红队通过 |
| `UI-TOAST-WINDOW-001` | Toast 不导出 View Manager 且不使用系统 Toast | 已关闭 | Activity toast slot、静态禁用系统 Toast、R8 稳定类名、不可点击无障碍语义和独立红队通过 |
| `UI-TOAST-VISUAL-001` | Toast 几何、字号与圆角来自 UDToast 资源 | 已关闭 | 295dp/14sp/20-10dp/20-8dp/12 行合同、API 35 帧差和独立红队通过 |
| `UI-TOAST-LIFECYCLE-001` | Toast 计时、动画、后台和状态保存保护 | 已关闭 | 200ms alpha、显式 3/5 秒、默认 4 秒、resumed 门禁、Home 清理、重入超时和独立红队通过 |
| `UI-PRIVACY-001` | 锁屏和后台不泄漏 Dialog/语音内容 | 已实现 | Dialog 纳入 AppLock；后台清空；语音 blur/background 停止 |
| `UI-LOGIN-CONSENT-001` | 登录、注册、游客入口均要求主动勾选协议 | 已实现 | 可访问 checkbox 与提交 guard 测试通过 |
| `UI-NOTIFICATION-REFRESH-001` | 从系统设置返回刷新通知权限 | 已实现 | AppState active 重新读取与 Jest 测试通过 |
| `UI-TYPOGRAPHY-002` | 1.0/1.3/2.0 字体倍率不裁切 | 已取证 | 目前没有 Android 运行 fixture |
| `UI-FORM-002` | 日历保存三态 | 已取证 | 当前校验仍主要发生在点击之后 |
| `UI-ANDROID-RUNTIME-001` | 原生页面有 androidTest 运行证据 | 复审中 | 30 个组件 androidTest 通过；当前 release APK 已由 MainActivity/UIAutomator 跑完游客、认证会议/账号链和生命周期，API 35 的 16+2 预检完整；真机全路由仍缺 |
| `MIN-AUDIO-001` | PCM 不逐帧 Base64 过桥；强杀后录音可恢复 | 已实现 | AudioRecord 直接写文件与二进制 WS；边界门禁检查 Base64 |
| `MIN-ASR-001` | WebSocket 断线后拉取并补齐已持久化字幕 | 已实现 | 登录/游客均在撤销会话前拉取并合并稳定 ID 字幕 |
| `MIN-SUMMARY-001` | 纪要加载、重试和恢复状态一致 | 复审中 | 业务恢复已测；纪要表现层重审中 |
| `MIN-GUEST-001` | 游客总结网络边界与法律文案一致 | 已实现 | 隐私文案、游客总结和转写恢复合同已同步 |
| `UI-ROUTES-001` | 全部可达目的地有明确目标，无孤立路由 | 复审中 | 游客链 40 个检查点及一次性真实账号/已完成会议认证链 25 个检查点均通过，API 35 已覆盖 16+2；真机同包 16+2 尚未执行 |
| `UI-LEGACY-001` | Android 目标路由不再使用旧表现层 | 复审中 | 旧门禁只能证明文件边界，不能证明页面从源码重建 |
| `UI-DUP-001` | 同一页面无同义重复动作 | 复审中 | 会议行保留唯一详情入口，长按菜单已删除同义“查看详情”；14 项定向回归通过，仍需多状态整包检查 |
| `UI-TOKENS-001` | 浅色语义颜色、字号、圆角与 0.5dp divider | 复审中 | 飞书资源闭包完成；页面硬编码与字体倍率尚未清理 |
| `UI-FORM-001` | 保存三态、100dp 空态和 76x36 重试 | 复审中 | 源码闭包完成；日历保存三态等实现仍缺 |
| `UI-MOTION-001` | 语义触觉、转场和双系统 inset | 复审中 | Window owner、搜索/语音退出及动态 inset 已实现；其余页面动画和 Toast 待闭证 |

## 16 个路由与 2 个 MainTabs 目的地

| 路由 | 当前组件 | 源码最近基线 | 静态复审结论 | 状态 |
| --- | --- | --- | --- | --- |
| `Login` | `LoginScreen.tsx` | 飞书登录 XML/输入流程 | 协议 guard 与主要几何已修；SSO/QR 等无服务能力已裁剪，仍需整页运行对照 | 复审中 |
| `Legal` | `LegalDocumentScreen.tsx` | About/Help/通用文章容器 | 业务文案为老记自有；About 几何和内容版本合同仍有差异 | 复审中 |
| `MainTabs` | `MainTabs.android.tsx` | `NavBottomTabBar/MainTabItemView` | 多导出 Fabric 根白屏已修，活动页改为单一原生根并内部持有底栏；五类 Window Overlay 已收口，字体倍率仍未关闭 | 复审中 |
| `Schedule` | `ScheduleScreen.android.tsx` + `LaojiCalendar` | 日历 Shell/月/日完整闭包 | 日视图 Pager、全天展开和月选中日展开已切到新原生 owner；年月 QuickChoose、跨行动画和完整换日手势仍在重建/复审 | 复审中 |
| `Meetings` | `MeetingListScreen.android.tsx` | Minutes Home V1/V2 | 搜索空态、恢复入口、状态优先级已修；媒体导入与完整转场缺失 | 复审中 |
| `EventDetail` | `EventDetailScreen.android.tsx` | Event Detail V2 | 仅保留老记支持字段合理，但当前页面区域和动效仍是简化闭包 | 复审中 |
| `AddEvent` | `AddEventScreen.android.tsx` | Edit Event container/zones | 日期/时间/重复可用；保存三态、权限模型和页面区域需重建 | 复审中 |
| `MeetingLive` | `MeetingLiveScreen.android.tsx` + Record V3 Surface | VC Record V3 | 旧录音表现层已删除重写；高频电平已改为 session 原生 Flow 直驱，JS 只接收停止摘要 | 已实现 |
| `Transcription` | `TranscriptionScreen.android.tsx` | Detail Pager + sticky player | 缺失会议态已修；详情已切为三页常驻 Pager、nested sticky 与外部播放器，正在独立复审及整包运行验收 | 复审中 |
| `SpeakerManager` | `SpeakerManagerScreen.android.tsx` | Voiceprint settings/speaker capability | 游客死路已移除；多人讲话人是老记产品扩展，页面仍需源码裁剪后重建 | 复审中 |
| `SpeakerEnrollment` | `SpeakerEnrollmentScreen.android.tsx` | VoicePrint dialog/upload | 主动上传同意已加；来电、audio focus 和底部 Sheet 形态未闭合 | 复审中 |
| `Profile` | `ProfileScreen.tsx` | Mine personal info | 头像 Sheet inset 已修；仍是 RN 页面换 token，未完成逐资源重写 | 复审中 |
| `ProfileField` | `ProfileFieldScreen.tsx` | 名称/手机号/凭据输入容器 | 老记字段能力已裁剪；输入容器和转场仍需逐页对照 | 复审中 |
| `Account` | `AccountScreen.tsx` | Settings/account container | 入口业务真实但不是飞书静态业务页；仅容器可仿真 | 复审中 |
| `ChangePassword` | `ChangePasswordScreen.tsx` | 凭据表单容器 | 老记真实 API 可用；保存三态与键盘/错误转场未闭合 | 复审中 |
| `NotificationSettings` | `NotificationSettingsScreen.tsx` | System permission/settings rows | 回前台刷新已修；系统权限与设置行需运行态闭证 | 复审中 |
| `AccountDeletion` | `AccountDeletionScreen.tsx` | Account center/form container | 无障碍标签已补；业务为老记 DELETE API，不能宣称飞书业务等价 | 复审中 |
| `Privacy` | `PrivacyScreen.tsx` | Settings container | 异步开关互斥已修；隐私业务为老记特有，页面仍需容器级重写 | 复审中 |

`Schedule` 与 `Meetings` 是 `MainTabs.android.tsx` 的本地状态，不是 Root Stack 路由；表格为了产品目的地闭包仍单列两项。`Schedule` 内的日程语音层也不是独立路由；它已按 `UI-VOICE-001/UI-OVERLAY-WINDOW-001` 修复失焦、后台录音泄漏、IME 释放与完整退出动画。通知冷启动只进入 `EventDetail`。

## UI-ROUTES-001 运行覆盖审阅

- 整包绑定：当前候选 APK 为 `android/app/build/outputs/apk/release/app-release.apk`，SHA-256 `192f01fd279704157e990c7e9eae123d896d8291bd735fd5c4d190a14da71573`，大小 `82,096,332` bytes。路由预检安装前后和结束时均核对模拟器 `base.apk` 与该文件一致；后续生产源码变化会使该哈希立即作废。
- 测试层级：组件 androidTest 仍使用测试 Activity 直接实例化 View，只能作为组件门禁。新 `android-emulator-route-smoke.sh` 已改为真实启动 `MainActivity`，按唯一 accessibility 节点动态命中，并保存每个 checkpoint 的 UI 树、Activity/Window 和 logcat；helper 已验证重复节点拒绝、bounds、checkbox、崩溃扫描、APK 哈希与源码/Gradle 构建输入新鲜度。
- 运行状态：`/tmp/laoji-route-final-precheck-8` 在 API 35 上通过 40 个 MainActivity 检查点、Home/强停/三次重复启动、双向 Tab 组合、非空像素、崩溃扫描和最终哈希复核；`/tmp/laoji-overlay-final-precheck` 通过五类 Window Overlay、IME、重入和隐私恢复。模拟器只作为进入真机的预检证据。
- 认证闭包：`/tmp/laoji-account-route-final-precheck-2` 使用一次性真实账号，并在 App 专用会议 API 创建后将夹具状态确认到 `completed`，避免误入可恢复录音。25 个检查点覆盖 `Transcription`、`SpeakerEnrollment`、`ChangePassword`、`AccountDeletion` 及往返栈；运行前后均绑定同一 APK 哈希，结束后删除账号及其会议数据。至此 API 35 的 16+2 目的地预检齐全。
- 真机驱动：路由、组合和 Overlay 脚本默认拒绝物理设备；只有显式 `ALLOW_PHYSICAL_DEVICE=1` 才接受指定真机，并继续使用动态节点 bounds 和同包哈希。USB 未枚举时不得将该模式的存在记作真机通过。
- 当前未关闭缺陷：Android 重复点击当前“日程”Tab不会回到今天；日程时间编辑的新全屏双端 wheel 已实现但等待独立复审；会议标题编辑仍绕过统一 Window Overlay owner。会议行与长按菜单的同义“查看详情”已删除，等待整包多状态复验。
- 下一门禁：不再重建候选包；USB 恢复后先以 `scripts/android-device-install-verify.sh` 保留数据覆盖安装当前冻结 APK，校验 `firstInstallTime`、包 UID 和真机 `base.apk` 哈希，再在当前真机最终覆盖 16+2、普通页面、手势、进程恢复及 `docs/android-device-follow-up.md` 的全部硬件行为。模拟器认证夹具只复用为真机自动检查输入，不改变最终证据边界。

## UI-ANDROID-COMPOSITION-001 运行证据

- 根因：导出的 `LaojiNativeMainContainerView` 同时接收导出的活动内容 View 和导出的底栏 View；API 35 模拟器及小米真机均稳定出现仅最后一个底栏 display list 进入最终帧，日历/会议内容虽完成测量且存在辅助功能节点，像素仍为纯白。
- 实现：删除 `NativeMainContainerView`、底栏独立 View Manager 与对应 JS bridge；`CalendarHostView` 和 `LaojiMinutesView` 各自成为唯一导出活动根，并在 Kotlin 内部持有共享底栏。会议 recording/detail surface 隐藏主底栏。后挂载页面通过 `NativeSystemInsets.requestInsetsWhenAttached()` 重新获取状态栏和导航栏 inset。
- 构建快照：历史白屏修复包 `44b45a...4dd9` 已作废。当前唯一候选为 `192f01fd279704157e990c7e9eae123d896d8291bd735fd5c4d190a14da71573`，大小 `82,096,332` bytes；它已完成 API 35 预检，但尚未安装到当前真机。
- 运行：Google API 35 `google/sdk_gphone64_x86_64/emu64xa:15/AE3A.240806.036/12592187:user/release-keys`；`OUT_DIR=/tmp/laoji-composition-waveform-final INSTALL_APK=0 DEVICE=emulator-5554 TAB_CYCLES=6 scripts/android-emulator-composition-smoke.sh` 通过。覆盖冷启动、6 轮双向 Tab、个人资料返回、Home/恢复、强停重启、3 次重复启动、每个检查点的原生根、标题 inset、非空像素和 crash scan。
- Overlay：`OUT_DIR=/tmp/laoji-overlay-toast-owner-final-rerun INSTALL_APK=0 DEVICE=emulator-5554 scripts/android-emulator-overlay-smoke.sh` 通过。除搜索、Sheet、语音和 Dialog 原有路径外，验证 Toast 单 owner、正文节点 `clickable=false`、卡外打开输入、卡内点击不穿透、IME 出现时上移 `820px`、同文案 `1630ms` 后重入、重入后显示 `3000ms`、退场 `216ms`、Home 清理及编辑页恢复。计时来自不含用户文案的原生 monotonic 日志。安装使用 `adb install --no-streaming`，安装后 `base.apk` 与目标 APK 哈希一致。
- 像素：日历帧 `803` 种颜色、主色占比 `0.969182`；会议帧 `1389` 种颜色、主色占比 `0.932442`，两者内容 ROI 差异 `4.140212%`；搜索、会议菜单、语音、Toast 与 Dialog 帧也均通过对应像素阈值。运行过程未发现 FATAL、SIGSEGV、SIGABRT、React Native JS error 或 Expo Kotlin 类型转换错误。
- 绑定：两个历史 smoke 在运行前都读取模拟器安装的 `base.apk` 并与目标 APK 比较 SHA-256；`/tmp/laoji-overlay-toast-owner-final-rerun` 与 `/tmp/laoji-composition-waveform-final` 均绑定上述 `44b45...` 快照。后续源码已变化，必须重新构建并产生新哈希证据，不得把历史 smoke 外推到当前工作树。
- 异常留痕：`/tmp/laoji-composition-toast-zero-failure` 的六轮画面均通过，但首次个人资料 ADB 点击未生效；不计入通过证据。随后无 UI dump 的快速六轮和完整同脚本重跑均正常进入个人资料，未形成稳定产品复现，因此未据此修改主 Tab 架构。
- 红队：第一轮提出像素假阳性、弹层重挂载、覆盖缺口、静态门禁和证据同步五项阻断；逐项修复后第二轮曾同意关闭当时 APK 快照的 `UI-ANDROID-COMPOSITION-001`。由于源码随后继续变化且当前目标改为真机最终验收，该历史结论只作回归依据，不能关闭当前状态。
- 验收边界：当前目标以 USB 真机为最终运行基准，模拟器、JVM 和 androidTest 只作自动化预检。候选 `192f01fd...71573` 必须在真机读取相同 `base.apk` 哈希，并验证厂商 GPU、系统栏、三键/手势导航、完整路由、普通手势和进程恢复后，才能关闭运行相关状态。
- 集中清单：白屏、16 个注册路由、2 个 MainTabs 目的地、普通页面与业务行为、真实声学输入、音频中断、前台服务、通知回跳、TalkBack、OEM 渲染和真实分享统一收纳在 `docs/android-device-follow-up.md`。

## 日历原生重建运行证据

- 实现：`CalendarHostView` 已切换到 `SingleDayCalendarView`；旧 `DayGestureOverlayView.kt` 已删除。日期头、全天区和三页时间轴分别拥有 View/滚动/无障碍职责；月视图每个周行独立，选中日详情由七页 Pager 持有。
- 门禁：`audit:android-native` 检查 5 个原生日历合同并禁止旧单 Canvas owner 文件重新出现；Jest 回归会临时重建旧文件并确认门禁失败，防止只靠人工约定。
- JVM：`:laoji-native-platform:testReleaseUnitTest` 共 `81/81` 通过，覆盖全天 3 行/7.5 行合同、三页日期绑定、月展开状态和 15/30 分钟吸附数学。
- Android：API 35 `LaoJi_API_35` 上 `connectedReleaseAndroidTest` 共 `3/3` 通过，其中日历 `2/2` 验证分层 owner、折叠/展开、25 条刻度、虚拟无障碍点击、默认 30 分钟两次点击创建、七页月详情、同行换日不重排及再次点击收起；另 `1/1` 为活动录音回归。
- 独立红队：基础测试通过后仍发现四项高风险和三项中风险，包括三层翻页不联动、相邻全天高度缺失、默认时长与绝对网格算法错误、取消手势残留、月关闭语义和无障碍缺口；四项日历哨兵已退回“复审中”。
- 证据边界：现有运行结果只证明已覆盖的基础路径，不证明源码行为成立；修复必须新增左右翻日/回中、相邻全天高度、非整点移动与双端 resize、cancel/detach、月跨行/跨月/关闭高亮测试。本轮模块测试尚未生成新的整包 APK 哈希。

## 妙记详情原生重建运行证据

- 实现：详情根固定为 44dp 标题栏、权重 Sticky 容器和底部 `WRAP_CONTENT` 播放器兄弟节点；Sticky 内按运行时测量持有音频头、41dp 页签和 ViewPager2。旧 `MinutesContentAdapter/MinutesContentRow` 已删除。
- 页面：转写、纪要和发言人各有独立 RecyclerView 或 NestedScrollView，三个实例常驻；逐页 `phase/message/generation` 由兼容 snapshot 合同提供，切 Tab 不覆盖其他页状态。
- JVM：全模块 `93/93` 通过。Android：API 35 详情 `4/4`、全模块 instrumentation `10/10` 通过，验证几何所有权、独立实例/滚动/状态、嵌套滚动消费和低频 Tab action。
- 证据边界：androidTest 使用可注入的最小播放器 owner，避免 library 测试 APK 缺少 app 级 MediaSessionService 声明；生产默认仍使用真实 `MinutesPlayerView`，release 构建通过，但必须再由整包详情路由 smoke 和独立红队确认，当前不关闭两项证据。
- 独立红队：生产快照未传真实逐页 generation，Surface/Tab/滚动无重建恢复，non-touch 惯性边界未验证，静默 Tab 有旧回调竞态；测试播放器绕过真实 MediaSession，动态 unavailable 仍可从已开弹窗保存，错误条遮挡首行、总结重试语义错误且无音频缺少明确反馈。两项已退回“复审中”。
- 门禁：`audit:android-native` 现检查 6 组详情所有权/状态/运行合同，并用反向 Jest 拒绝 `MinutesContentAdapter/MinutesContentRow` 回归；门禁不替代上述行为修复。

## MIN-REC-BRIDGE-001 运行证据

- 实现：`RecorderLevelHub` 按 session 保存带 sequence 的最新帧和最后 160 个样本；会议目的不再向 `RecorderEventBus.LEVEL` 发射，日程语音与讲话人用途保持原合同。`MinutesRecordingSurface` 在可见、attached、recording 三条件同时成立时收集，暂停、隐藏、切换和 detach 会取消 collector；`MinutesRecordingWaveformView` 自行执行 30/15 FPS 插值。
- 边界：`MeetingLiveScreen.android.tsx` 已删除 `addNativeRecorderLevelListener` 与连续 level state；`nativeMinutesSnapshots.ts` 和原生 snapshot 类型不再包含 waveform；停止成功、可恢复失败和重复 stop 均复用一次性 `audioBars`。
- 自动化：`npx tsc --noEmit` 通过；Jest `113/113` suites、`858/858` tests；Python `56` tests 与 `11` subtests；Kotlin release JVM `49/49`。`audit:android-native` 新增 6 段 `MIN-REC-BRIDGE-001` 生产/测试合同并通过。
- Android：`connectedReleaseAndroidTest` 在 API 35 `LaoJi_API_35` 上 `1/1` 通过，真实挂载 Surface 验证当前/错误 session、原生计时、波形、暂停、恢复、session 切换和 detach。模拟器未冒充真实麦克风、音频焦点或厂商前台服务验收，这些列入集中真机复核。
- 独立复审：红队直接核对生产 Flow、停止摘要、instrumentation XML、APK 哈希链和静态门禁，确认当时实现边界无高/中风险。该结论保留为自动化预检证据，不再直接关闭 `MIN-REC-BRIDGE-001`、`MIN-REC-WAVE-001` 的当前真机运行状态；instrumentation 的 processor 结果也不外推为 OEM 绘制一致性。

## 整体替换边界

| 当前文件/所有者 | 不允许继续局部修补的原因 | 目标结构 |
| --- | --- | --- |
| `DayGestureOverlayView.kt`（已删除） | 日期头、全天区、时间轴、拖动和无障碍曾压在单一 Canvas | 已切换为日期 Pager + header + expandable all-day + timeline + drag owner + virtual a11y；门禁禁止旧文件回归 |
| `CalendarYearMonthPanel` 与 picker host（旧实现已删除） | 固定 298dp NumberPicker、延迟确认草稿、无双态/透明命中/拖拽/退出动画 | 已切为全内容区 QuickChoose 宿主、日期/年月双态、即时提交 wheel 和 ValueAnimator 状态机；待重编译和红队关闭 |
| `MinutesDetailSurface.kt`（旧实现已替换） | 单一 RecyclerView 换 adapter，无法保留逐页滚动；固定 100dp 播放器违背 wrap-content 资源 | 已切为 ViewPager2 + 每页独立滚动 + NestedScrollingParent2 sticky audio-header/tab + 底部 WRAP_CONTENT 播放器兄弟节点；待红队关闭 |
| Toast 旧路径（已替换） | 旧 `FeishuToast` 与 `android.widget.Toast` 曾分散在 RN/原生页面 | 已纳入 Activity/window owner；统一状态保护、计时、insets、R8 可观测名和退出回调 |
| 波形数据合同 | 每 100/120ms 经 JS state 和完整 snapshot 回传 | Recorder 原生 Flow 直驱波形、自调度插值，仅低频语义事件进 TS |

## 产品裁剪

所有裁剪必须记录飞书源码入口、老记缺失的服务能力和删除后的布局收拢证据。没有真实能力的入口不得以禁用按钮或占位页保留。

| 飞书能力 | 源码证据 | 老记服务差异 | 处理结果 |
| --- | --- | --- | --- |
| 会议章节 | `MIN-DETAIL-001` 原生章节控制层 | 当前会议 API 不返回章节 | 删除章节 Tab、数据模型和 seek action，剩余三栏等分收拢 |
| CCM 权限协作分享 | `MIN-SHARE-001` | 老记没有 CCM 文档与权限服务 | 替换为系统文件分享：会议文档、完整资料包和真实录音 |
| 飞书 RTC 个人录制 | `MIN-REC-STATE-001` | 老记使用 Qwen PCM WebSocket | 采用飞书 local/offline 同类 `AudioRecord` 原语并加前台服务 |
| 字幕级讲话人改写 | `MIN-SPEAKER-001` | 老记只有声纹 CRUD，无逐段 speaker API | 删除逐段改写；保留真实声纹管理和识别标签 |
| 多日历、周视图及飞书会议联动 | `CAL-ROOT-001` | 第一版产品明确只保留月/日与老记会议模块 | 从目标路由删除，按相邻源码重新分配标题栏和内容空间 |
| 暗色主题 | `UI-THEME-SCOPE-001` | 当前发布配置固定浅色，尚未建立全页面暗色资源与运行验收 | v1 明确只支持浅色；暗色 token 不作为已实现能力，后续整页闭证后再开放 |
| UDToast 双路由与全局 FIFO | `UI-TOAST-ROUTING-001` | 老记当前三个真实入口均为路由内纯文本校验，不存在并发 action/loading Toast 产品能力 | 统一走 Activity owner 单槽并 latest-wins；保留飞书视觉、计时、动画和生命周期合同，不调用 OEM 系统 Toast |
