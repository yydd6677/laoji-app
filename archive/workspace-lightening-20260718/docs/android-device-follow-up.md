# Android 真机最终验收清单

更新日期：2026-07-17

本清单是当前目标的最终运行门禁。模拟器、JVM、单元测试和 androidTest 必须先通过，用于快速回归和跨 API 预检；但页面结构、业务接口、普通手势、进程恢复和真实硬件行为均以当前 USB 真机上的同一份 release APK 作为最终结论。

## 当前候选包

- 候选文件：`android/app/build/outputs/apk/release/app-release.apk`
- SHA-256：`192f01fd279704157e990c7e9eae123d896d8291bd735fd5c4d190a14da71573`
- 大小：`82,096,332` bytes
- 自动预检：游客 MainActivity 路由与生命周期共 40 个检查点通过；一次性真实账号/已完成会议夹具的认证链再通过 25 个检查点，API 35 上已覆盖 16 个注册路由与 2 个 MainTabs 目的地。组合、Window Overlay、TypeScript、120 个 Jest suite/914 个测试、JVM、30 个 androidTest、56 个 Python 测试、Expo Doctor、依赖/发布边界/原生边界/飞书证据和 APK 策略均通过。
- 证据边界：API 35 预检绑定上述哈希；进入真机安装步骤时 USB 设备未枚举，因此尚未读取真机 `base.apk`，下表所有 `DEVICE-*` 项仍保持未通过。
- 真机脚本必须显式设置 `DEVICE=<serial> ALLOW_PHYSICAL_DEVICE=1`；默认仍拒绝物理设备，避免误清数据。先保留现有数据覆盖安装完成升级白屏矩阵，再决定是否以 `RESET_APP_DATA=1` 执行游客首装路由。
- 第一步固定运行 `DEVICE=<serial> scripts/android-device-install-verify.sh`：它拒绝模拟器、拒绝首次安装且不含 `pm clear`，只有覆盖安装后 `firstInstallTime`、包 UID 未变化，设备 `base.apk` 与候选哈希一致且冷启动无致命日志时才通过。

| 复核 ID | 对应证据 | 最小操作 | 通过条件 |
| --- | --- | --- | --- |
| `DEVICE-APK-IDENTITY-001` | `UI-ANDROID-RUNTIME-001` | 从当前冻结源码构建 release APK，记录 SHA-256，覆盖安装后读取设备 `base.apk` 校验哈希 | 真机安装包与待验收产物完全一致；不依赖 Metro/Expo Go；后续全部证据绑定该哈希 |
| `DEVICE-COMPOSITION-001` | `UI-ANDROID-COMPOSITION-001`、`UI-MOTION-001` | 冷启动日程和会议；双向切换 Tab；进入子页返回；Home/恢复；强停重启；重复启动三次 | 日历和会议内容每次均可见；无白屏、空白内容、播放倒退符号闪烁、异常残影或系统栏遮挡；logcat 无致命异常 |
| `DEVICE-ROUTES-001` | `UI-ROUTES-001`、`UI-LEGACY-001`、`UI-DUP-001` | 按账本逐一进入 16 个注册路由和 2 个 MainTabs 逻辑目的地，覆盖正常、空、加载、失败和恢复状态 | 每个目的地可达、可退出、无旧表现层或重复同义入口；返回栈、状态恢复和目标动作符合合同 |
| `DEVICE-INTERACTION-001` | `CAL-DAY-PAGER-001`、`CAL-MONTH-EXPAND-001`、`MIN-DETAIL-001`、`UI-OVERLAY-WINDOW-001` | 验证月/日切换、年月选择、跨日条、时段创建与拖动、事件详情编辑、会议列表/录制/详情/播放器及全部弹层 | 点击、拖动、吸附、分页、展开收起、IME 与 Overlay 在真机触摸和帧合成下稳定；无手势丢失、布局跳动、点击穿透或遮挡 |
| `DEVICE-ACOUSTIC-001` | `MIN-REC-STATE-001`、`MIN-ASR-001`、`UI-VOICE-001` | 首次授权后分别用真人说话创建日程、录制会议；暂停再恢复并停止 | 权限流程明确；首句、最终转写和本地 WAV 均产生；停止后可播放，临时态不串到另一入口 |
| `DEVICE-AUDIO-INTERRUPT-001` | `MIN-SPEAKER-VOICEPRINT-001`、`MIN-PLAYER-001` | 录音、声纹录入和播放期间触发来电或其他媒体抢占 | 不并发占用麦克风；中断状态可理解；返回后按合同恢复或明确要求重试，播放控制与系统状态一致 |
| `DEVICE-FGS-001` | `MIN-REC-STATE-001`、`MIN-RECOVERY-ENTRY-001` | 会议录制中锁屏、回桌面，再从前台通知和 App 入口返回 | 厂商系统持续显示前台通知；录音不因页面卸载丢失；两个入口恢复同一 session，不新增重复会议 |
| `DEVICE-NOTIFICATION-001` | `UI-NOTIFICATION-REFRESH-001`、`UI-ROUTES-001` | 首次请求通知权限；创建短时提醒；在前台、后台和冷启动状态点击通知 | App 内权限状态与系统一致；提醒实际到达且只到达一次；点击进入正确事件详情 |
| `DEVICE-TALKBACK-001` | `UI-ANDROID-RUNTIME-001`、`CAL-DAY-PAGER-001`、`UI-OVERLAY-WINDOW-001` | 开启 TalkBack，遍历主底栏、月/日历、事件、QuickChoose、录音、详情和所有 Window Overlay | 焦点顺序与视觉层一致；隐藏层不可达；时间轴事件可点击；关闭弹层后焦点回到触发项；无重复或空语义节点 |
| `DEVICE-OEM-RENDER-001` | `UI-ANDROID-COMPOSITION-001`、`UI-MOTION-001` | 在手势导航和三键导航下各执行冷启动、双向 Tab、前后台、返回和重复启动 | 不再白屏或闪烁；状态栏、导航栏、IME 与底栏不重叠；厂商 GPU 下动画无残影 |
| `DEVICE-SHARE-001` | `MIN-SHARE-001` | 向至少一个真实聊天或文件应用分享会议文档和完整资料包 | 文档、转写、总结和录音按所选范围附带；接收端可打开；不存在纯文本回退或失效 URI |

## 执行边界

- 不做长时间稳定性测试；每项只执行一次正常路径和一次关键中断路径。
- 当前 USB 真机上集中覆盖安装同一份已通过自动化预检的 release APK，并记录 APK SHA-256、设备型号、Android 版本和导航模式；不得把测试 APK 或不同源码构建的 APK 混入该轮验收。
- USB 临时断开不暂停代码开发和模拟器预检，但当前目标保持未完成；恢复连接后从未通过项续测，不得把“等待真机”改写成“不阻塞完成”。
- 失败项回到对应证据编号重新实现；通过前保持“真机验收未通过”，不得用模拟器截图、构建成功、字符串检查或单次人工主观描述关闭。
- 真机操作优先使用可重复 ADB/UIAutomator 脚本、View 层级、像素检查与 logcat；必须依赖真人感知的声学、触觉、TalkBack 和分享结果单独记录人工结论。
- 物理设备模式与模拟器使用同一动态语义命中、源码新鲜度和 APK 哈希实现；脚本通过不代替真人声学、触觉、TalkBack、导航模式和接收端分享结论。
