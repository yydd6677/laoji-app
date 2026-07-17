# 老记 Android 原生平台架构合同

更新日期：2026-07-17

## 文档职责

本文件只规定飞书 Android 7.71.8 源码到老记 Android 的技术映射、运行所有权和禁止边界，不记录页面完成状态。三份权威文档各司其职：

- `docs/feishu-source-map.md` 记录飞书源码事实和行为闭包。
- 本文件记录老记采用的技术原语、模块边界与允许偏离。
- `docs/feishu-parity-ledger.md` 记录唯一有效的实现、验证和关闭状态。

机器事实由 `evidence/feishu/source-catalog.json`、`source-lock.json`、`capability-inventory.json`、`manifest.json`、`deviations.json` 和 `product-scope.json` 提供。旧 APK、旧截图、旧模拟器运行和旧页面实现均不是架构输入。

## 构建来源

- 权威飞书基线：`feishu-android-7.71.8`。
- 重建分支必须从当前 worktree 解析 Node、Metro、Expo autolinking 和本地 Expo 模块，禁止解析到其他 LaoJi 工作区。
- 自有 Android 源码位于 `modules/laoji-native-platform`；生成的 `android/` 目录不是权威源。
- `UI-WORKSPACE-SOURCE-001` 在配置、预构建和打包阶段核对真实路径。来源不一致时构建立即失败，不允许以复制产物继续。

## 证据门禁

门禁按以下顺序收紧，后一层不能替代前一层：

1. **源码锁**：catalog 枚举闭包，lock 固定每个源文件 SHA-256，并锁定被引用但不存在的资源。源码变动使后续 proof 全部过期。
2. **能力库存**：`capability-inventory.json` 为每项能力登记证据 ID、模块、源码引用、产品决定和发布要求。未进入 manifest 只表示实现尚未登记。
3. **静态实现库存**：TypeScript AST 与 Kotlin UAST/Lint 枚举控件、listener、动画、路由和视觉常量。每个生产元素必须映射证据 ID；旧 UI 引用、未知证据和未批准偏离直接失败。
4. **运行 View 树**：instrumentation 检查真实节点层级、角色、尺寸、命中范围和 Evidence Tag。重复使用同一 ID 不能掩盖额外控件。
5. **行为 proof**：测试先由源码合同生成，再绑定实现输入、测试报告、环境和哈希。实现输入变化后必须重签，不能沿用历史通过。
6. **Release attestation**：release 要求所有可达能力关闭，并把源码 catalog、能力库存、manifest、报告和 APK 哈希写入 `parity-attestation.json`。安装入口拒绝过期或来源不一致的 APK。

Debug 允许 `sourced`、`implemented`、`verified` 等中间状态，但不允许未知元素。Release 只接受发布所需能力全部 `closed`、未批准偏离为零、旧表现层引用为零。

## 运行所有权

目标本地 Expo 模块为 `modules/laoji-native-platform`。Android 高频页面和交互由 Kotlin 拥有；TypeScript 只保留业务规则、repository、鉴权和低频网络编排。

| 子系统 | Android 所有者 | TypeScript 所有者 | Bridge 只允许 |
| --- | --- | --- | --- |
| 主壳层 | 活动目的地的单一原生根、内部底栏、标题栏、Window overlay | 导航意图、会话与业务确认 | 低频语义命令 |
| 日历 | ViewPager2、RecyclerView、自定义 View/Canvas、手势层、年月选择 | 事件 repository、通知和业务校验 | 事件快照与选择/创建/移动/缩放语义 |
| 妙记 | 列表、Record V3 页面、详情 Pager、sticky、播放器容器 | 会议 repository、总结和分享编排 | 状态、字幕、文件及用户动作 |
| 录音/ASR | AudioRecord、前台 Service、原生 WebSocket、文件 journal | 鉴权和服务配置 | partial/final 字幕、状态、停止结果 |
| 上传恢复 | WorkManager | 云端会议状态同步 | 持久任务状态 |
| 播放 | Media3、MediaSessionService | 音频来源解析 | 播放命令与低频状态 |
| 账号静态页 | React Native 可保留 | 老记 auth/profile/privacy API | 无高频数据 |

Android 主目的地任一时刻只能有一个导出的 Expo/Fabric 根。底栏位于该原生树内，不得作为第二个导出根；录制和会议详情隐藏主底栏。状态栏 inset 由页面根消费，导航栏 inset 由底栏或 Window overlay 消费。

## 通用壳层

`UI-SHELL-BOTTOM-MAIN-001` 以飞书真实主链 `TabPageControllerV3 -> TabPageWidget -> TabBottomBar -> TabBarController` 为依据；More 页的 `NavBottomTabBar` 不得再作为主底栏参考。老记只保留 `Schedule` 与 `Meetings` 两个目的地，这是 `DEV-LAOJI-TWO-TAB-SCOPE-001` 的批准替换。

`UI-SHELL-RESELECT-001` 要求当前日程 Tab 重选时由活动日历根回到设备本地今天并清理临时态，不允许用 React key、卸载 Surface 或重建 store 模拟。

`UI-OVERLAY-WINDOW-001` 规定 page、sheet、dialog、toast 由 Activity content 下的唯一 Window host 分层持有。Sheet 的 window dim 与正文入退场必须独立；键盘、系统栏和导航栏 inset 在宿主内实时处理。核心按钮几何不能因错误、字幕或提示出现而位移。

`UI-CALENDAR-FAB-001` 的短按、长按菜单、阴影、触觉与命中范围必须来自源码合同。老记语音创建属于 `DEV-LAOJI-SCHEDULE-VOICE-001`，只替换动作内容，不自创容器和 motion。

Token、图标、空错态和标题栏分别由 `UI-TOKENS-001`、`UI-ICON-PRIMITIVES-001`、`UI-STATE-EMPTY-ERROR-001`、`UI-TITLE-COMMON-001` 约束。v1 仅浅色是批准偏离，但暗色残留分支不得影响浅色资源；OEM `android.R.drawable` 不承担产品图标。

## 日历平台

日历 Android 根接收规范化事件快照，只发出选日、创建、打开、移动和缩放语义，不直接写 repository。

- 月视图采用三页复用，一次手势只跨一个月；周行、选中日展开和跨日连续条各有独立 owner。
- 单日视图由日期头、全天区、三页日期 Pager、时间轴 Canvas、事件层和独立拖动层组合。可见标尺为 25 条整点线；默认时长与 15/30 分钟吸附属于不同合同。
- 年月 QuickChoose 位于日历页面树内，具有日期/年月双态、可点击 wheel、拖动和中断可逆动画。
- 标题下方保留 50dp view indicator，尾部只有一个模式入口。月/日两种模式直接切换属于 `DEV-CALENDAR-VIEW-SCOPE-001`，不得重新引入并排模式按钮或二级选择菜单。
- 详情、编辑、重复、搜索使用各自源码闭包；老记删除参会人、会议室、飞书会议联动等无能力区域后必须重新收拢布局，不保留占位。
- 一周从周日开始是 `DEV-CALENDAR-WEEK-START-001`；系统 12/24 小时格式必须贯穿标尺、卡片、详情、编辑和搜索。

日历高频拖动、分页进度、Canvas 绘制和动画不得逐帧跨 Bridge。原生层只能回传最终语义结果或节流后的可访问状态。

## 妙记平台

妙记依据飞书源码动态能力页而不是“固定三 Tab”假设。老记按真实能力动态组装转写、纪要和发言人内容；章节、Clip、Podcast、CCM 和无服务 AI 控件删除。

- Record V3 页面拥有录音状态、波形、字幕列表和操作区；状态固定为 `idle -> preparing -> recording <-> paused -> localSaved -> uploading -> processing -> ready/failed`。
- AudioRecord 同时写本地 journal/WAV 并向 Qwen ASR 发送 PCM。正常停止先补全头、`fsync`、原子改名，再发布 `localSaved`。
- 录音电平由原生进程内 Flow 直达可见波形；PCM、连续 level、逐帧波形和滚动进度不得经过 JS Bridge。讲话人采集也必须遵守同一高频边界。
- WorkManager 持有上传重试与进程恢复；页面卸载不能终止录音、文件落盘或上传。
- 详情由动态 Pager、每页独立滚动容器、sticky audio header/tab 和底部播放器兄弟节点组成。播放器恢复必须包含来源、位置、倍速和原播放状态。
- 老记保留真实声纹采集/管理，但删除字幕逐段讲话人改写。`lineId` 不得被丢弃后错误路由到全局声纹 CRUD。
- 分享只提供真实文件：会议文档、转写、总结和录音；CCM 协作权限语义不映射为系统分享。

Qwen ASR、老记总结、WAV/WorkManager、Media3、游客总结和系统文件分享均为已批准业务替换。WAV 作为恢复与上传载体已经批准；上传完成后保留多久、用户删除与系统清理的统一保留策略仍由 `MIN-AUDIO-RETENTION-001` 阻断，策略批准前不能关闭该能力。

## 账号与静态页

账号页可继续使用 React Native，但必须按 `UI-ACCOUNT-PAGES-001` 整体重建容器、标题栏、滚动、表单、错误态、键盘和转场。登录、访客、资料、改密、通知、删号、隐私和法律内容使用老记真实业务；飞书 SSO、QR、组织目录和更新入口删除。该模块只能宣称“飞书容器合同 + 老记业务替换”，不能宣称账号业务等价。

## 禁止路径

- Android 目标路由引用旧日历、旧会议或旧公共表现层。
- 一个主目的地同时挂载多个导出原生根。
- `PanResponder`、React state 或 JS Bridge 承担日历逐帧拖动和动画。
- PCM、连续录音 level、讲话人采集 level 或波形逐帧进入 JavaScript。
- 页面组件拥有录音文件、上传任务或播放器生命周期。
- 无 Evidence Tag 的控件、listener、动画、视觉常量或可达路由。
- 用截图、字符串测试、构建成功或旧 APK 运行代替源码闭包和当前输入 proof。
- 用禁用按钮、空页面或同义重复入口保留无服务能力功能。
- 用未批准偏离补写反编译缺失的动画、JNI 或动态模块行为。

## 模块关闭顺序

1. 关闭证据基础设施与 workspace 来源。
2. 关闭启动 readiness、主底栏、标题栏、Window overlay、FAB、token、图标和通用状态。启动阶段必须先渲染 125dp 状态槽和有界恢复面，配置验证不得在 Error Boundary 外抛出。
3. 关闭日历 Shell、月视图、QuickChoose、单日组合、全天区、拖动、搜索、详情和编辑。
4. 关闭妙记列表、搜索、Record V3、音频/上传/ASR、详情 Pager、播放器、声纹、总结和分享。
5. 关闭账号与法律静态页。
6. 枚举全部 16 个 Root 路由和 2 个 MainTabs 目的地，删除 Android 旧表现层，再执行跨 API/密度/字体/导航预检。
7. 仅在所有 release 必需项关闭后生成同一哈希的真机候选并验收。

任何新偏离必须先写入 `evidence/feishu/deviations.json`，包含源码方案、偏离原因、替代合同和批准依据；在批准前保持阻断。
