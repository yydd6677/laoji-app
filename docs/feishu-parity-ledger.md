# 飞书仿真重新审阅账本

更新日期：2026-07-17

## 文档职责

本文件是飞书仿真唯一完成状态账本。源码事实见 `docs/feishu-source-map.md`，技术映射见 `docs/native-platform-architecture.md`；这里不复述旧版本实现，也不接受聊天结论、截图、构建成功或历史 APK 作为关闭依据。

机器状态块由 `evidence/feishu/manifest.json` 生成，禁止手工修改。完整能力范围由 `evidence/feishu/capability-inventory.json` 决定；尚未进入 manifest 的能力是“源码已锁定、实现尚未登记”，不是已完成，也不是缺少源码审阅。

<!-- BEGIN GENERATED FEISHU EVIDENCE STATUS -->

- Manifest phase: `source_closure_complete`
- Source inventory complete: `yes`
- Implementation inventory complete: `no`
- Release inventory complete: `no`
- `capability-inventory.json` 中尚未进入 manifest 的条目表示源码已锁定、实现尚未登记；不得据此宣称已实现或已关闭。

| 证据 ID | 模块 | 机器状态 | 决策 | 阻断数 |
| --- | --- | --- | --- | --- |
| `CAL-MONTH-EXPAND-HOST-001` | calendar | 已验证 | `keep` | 0 |
| `CAL-PICKER-WHEEL-TAP-001` | calendar | 已验证 | `keep` | 0 |
| `UI-ANDROID-COMPOSITION-001` | shell | 已实现 | `business_replace` | 1 |
| `UI-BOOT-READINESS-001` | shell | 已实现 | `business_replace` | 1 |
| `UI-CALENDAR-INDICATOR-001` | calendar | 已验证 | `business_replace` | 0 |
| `UI-SHELL-BOTTOM-MAIN-001` | shell | 已实现 | `business_replace` | 3 |
| `UI-SHELL-RESELECT-001` | shell | 已实现 | `keep` | 3 |

<!-- END GENERATED FEISHU EVIDENCE STATUS -->

## 状态规则

| 机器状态 | 含义 | 允许进入 Release |
| --- | --- | --- |
| 未进入 manifest | 源码能力已在 inventory 登记，实现尚未登记 | 否 |
| `sourced` | 源码闭包和产品决定齐全 | 否 |
| `implemented` | 当前实现已绑定证据，尚未完成运行验证 | 否 |
| `verified` | 当前输入的源码派生测试通过，尚未完成独立关闭 | 否 |
| `closed` | 源码、实现、测试、运行产物和独立复审闭环 | 是 |

任何输入文件、源码锁、产品决定、门禁脚本、测试报告或实现哈希变化都会使 proof 过期。关键调用顺序和声明的测试 symbol 也由静态门禁检查；旧文档中的 `[x]`、旧模拟器结果和旧真机结果不会自动迁移为当前状态。

## 源码库存

- 基线：飞书 Android `7.71.8`，APK SHA-256 由 `source-catalog.json` 锁定。
- 源码锁：278 个文件，包含 common-shell 31、calendar 112、minutes 69、account-static 8、resources 58。
- 负面锁：3 个被引用但解码包中不存在的动画资源。缺失正文的曲线不得推断为像素级事实。
- 能力库存：55 项，全部为当前 Release 必需项；其中 shell 14、calendar 19、minutes 21、account-static 1。
- 产品决策：keep 25、business_replace 27、delete 3。
- 源码引用完整性：55 个 ID 唯一，未知 source ref 为 0。

能力 ID 分区：

- **Shell**：`UI-WORKSPACE-SOURCE-001`、`UI-BOOT-READINESS-001`、`UI-ANDROID-COMPOSITION-001`、`UI-SHELL-BOTTOM-MAIN-001`、`UI-SHELL-RESELECT-001`、`UI-TITLE-COMMON-001`、`UI-OVERLAY-WINDOW-001`、`UI-SHEET-DIM-INDEPENDENT-001`、`UI-TOAST-WINDOW-001`、`UI-STATE-EMPTY-ERROR-001`、`UI-TOKENS-001`、`UI-ICON-PRIMITIVES-001`、`UI-ROUTES-001`、`UI-LEGACY-001`。
- **Calendar**：`UI-CALENDAR-INDICATOR-001`、`UI-CALENDAR-FAB-001`、`CAL-ROOT-001`、`CAL-MONTH-STEP-001`、`CAL-MONTH-EXPAND-001`、`CAL-MONTH-EXPAND-HOST-001`、`CAL-MONTH-SPAN-001`、`CAL-DAY-COMPOSE-001`、`CAL-RULER-001`、`CAL-ALLDAY-001`、`CAL-DRAG-OWNER-001`、`CAL-DRAG-HANDLES-001`、`CAL-TIMEFORMAT-001`、`CAL-QC-STATE-001`、`CAL-PICKER-WHEEL-TAP-001`、`CAL-SEARCH-ROUTE-001`、`CAL-DETAIL-EDIT-001`、`CAL-REPEAT-RRULE-001`、`CAL-RES-LOCK-001`。
- **Minutes**：`MIN-ROOT-001`、`MIN-SEARCH-001`、`MIN-REC-LAYOUT-001`、`MIN-REC-STATE-001`、`MIN-REC-WAVE-001`、`MIN-REC-TRANSCRIPT-001`、`MIN-AUDIO-RETENTION-001`、`MIN-UPLOAD-QUEUE-001`、`MIN-UPLOAD-PAYLOAD-001`、`MIN-UPLOAD-RECOVERY-001`、`MIN-ASR-001`、`MIN-SUMMARY-001`、`MIN-DETAIL-PAGER-001`、`MIN-DETAIL-STICKY-001`、`MIN-PLAYER-001`、`MIN-PLAYER-RECOVERY-001`、`MIN-SPEAKER-VOICEPRINT-001`、`MIN-SPEAKER-SUBTITLE-EDIT-001`、`MIN-GUEST-SUMMARY-001`、`MIN-SHARE-FILE-001`、`MIN-SHARE-CCM-001`。
- **Account static**：`UI-ACCOUNT-PAGES-001`。

## 已解决的来源阻断

`UI-WORKSPACE-SOURCE-001` 的旧 P0 已解决：此前 `node_modules`、Expo autolinking 和本地模块可解析到其他 LaoJi 工作区，导致“当前分支源码”和“实际打包源码”不一致。当前 worktree 使用本地安装，Node、Metro、Expo 和 Gradle 来源审计均指向本 worktree；静态门禁和 attestation 已绑定来源报告。

这只关闭构建来源风险，不代表页面实现已关闭。任何再次出现的跨工作区解析都必须让配置、测试和 Release 同时失败。

## 当前阻断

### P0：先于页面重建

1. `UI-BOOT-READINESS-001`：挂载前配置异常、可见 loading、8 秒总等待上限、认证/导航诊断错误面和整棵运行树重试已实现；仍需 instrumentation 与同一候选 APK 的真机冷启动/进程恢复闭证，当前不能关闭。
2. `UI-LEGACY-001`：当前 TS AST 报告仍发现 208 个未映射错误，Android UAST/Lint 仍发现 726 个未映射错误；旧 Android 表现层与孤立 TSX 尚未清零。
3. `UI-ROUTES-001`：16 个 Root 路由和 2 个 MainTabs 目的地尚未逐项绑定源码容器、转场、恢复和 View 树合同。
4. 三个 pilot proof 已使用当前源码锁、manifest、AST/UAST/workspace 报告和 API 35 模拟器 40 项合并 instrumentation 重新签发，其中包含隐藏日/月 owner 不受重选驱动及模拟 React 即时/运行中快照反馈不截断 motion 的原生宿主回归用例；后续任一输入变化仍会立即使其过期。

### P1：通用壳层

- 当前日程 Tab 重选已改为活动 Calendar 原生根同步处理，不再经过 React 序号或 Bridge prop；QuickChoose 保持展开并同步今天，`when (mode)` 只驱动当前月/日 owner。独立红队发现 React 日期/范围反馈会以新 generation 快照截断单日 motion；现已改为同目标反馈只重绑数据/session，并新增首帧、100ms 中间态和最终态回归测试。单日 300/250ms motion、远距离目标相邻页起点、同日草稿/活动手势清理、隐藏 owner 不变、同月普通点击状态机、非 idle 丢弃和跨月最终展开今天均有定向测试；完整 React/Expo-to-native instrumentation 与月视图跨页/先收后移精确时序仍未关闭。
- 主底栏已重建为 65dp 原生内容区、独立物理像素 divider、22dp `ImageView`、12sp `TextView`、真实 selected 语义和仅图标 125+125ms motion；目的地替换活动根时由单调命令在新根完整播放，旧根保持受控状态。现有 component 与单根 instrumentation 尚未真实替换 Calendar/Minutes 两个 Android 根，不能作为“跨根恰好播放一次”的闭环证据；最终图标路径、真实根替换测试和真机 TalkBack 尚未关闭。
- Sheet dim 与正文入场动画仍耦合。
- 日历 FAB 缺少源码阴影与短按两段 motion。
- Profile sheet、Minutes 标题 dialog 和撤销 banner 仍绕过统一 Window owner。
- Native、Calendar 和页面局部 token 分裂，浅色版本仍残留暗色分支。
- Minutes 标题动作和 FAB 仍使用 OEM `android.R.drawable`。

### P1：日历

- 月展开的跨行、跨月和动画关键帧尚未闭环；跨日连续条缺少 View 树几何证据。
- 日期头、全天区、时间轴和事件层的同步 Pager motion 尚未闭环。
- 标尺、默认时长、创建吸附和 resize 吸附仍需拆分验证；`dragPrecisionMinutes` 当前是死合同。
- 月展开和部分 snapshot 路径仍强制 `HH:mm`，未统一系统 12/24 小时格式。
- QuickChoose 完整动画/恢复、搜索缺失动画正文的处理、详情/编辑、完整 RRULE 和资源 token 尚未关闭。

### P1：妙记

- Record V3 活动分支、录音状态映射和真机生命周期尚未关闭。
- 音频保留策略未获批准；WAV 修复、时长和大文件 fixture 未闭环。
- WorkManager kill-process、凭据租约、幂等上传和 tombstone 矩阵未闭环。
- ASR 断线补拉 fixture、总结失败/重试/游客边界 fixture 尚未完成。
- 详情 generation、进程重建、Tab 竞态、独立滚动和 non-touch sticky 惯性尚未关闭。
- 播放器保存了 `wasPlaying` 却未应用恢复策略；完整 MediaSession 与音频焦点尚未验证。
- 讲话人采集 level 仍高频经过 JS；字幕长按产生 `lineId` 后错误落入全局声纹 CRUD，必须删除误导路径。
- 系统文件分享仍缺物理分享目标和 URI 权限 fixture；CCM 负面路由证据尚未登记。

### P1：账号静态页

九个可达 React Native 账号/法律页面尚未完成 TS AST 证据映射。它们必须使用飞书容器、标题栏、表单、键盘、状态和转场合同，同时保留老记真实账号业务。

## 模块关闭顺序

1. **证据基础设施**：同步 catalog/lock/inventory/manifest、重建 TS AST/UAST/workspace 报告、重签 pilot proof；静态门禁通过，Release 门禁应因真实未关闭项继续失败。
2. **启动与通用壳层**：先关闭白屏 readiness，再关闭主底栏、重选、标题栏、overlay、Sheet、FAB、token、图标和通用状态。
3. **日历**：Shell -> 月分页/展开/跨日条 -> QuickChoose -> 单日组合/全天区/标尺 -> 创建/拖动/缩放 -> 搜索 -> 详情/编辑/重复。
4. **妙记**：列表/搜索 -> Record V3 -> 音频落盘/上传/ASR -> 详情 Pager/sticky -> 播放器 -> 总结/游客 -> 声纹 -> 分享与删除负面能力。
5. **账号静态页**：登录、法律、资料、账号、改密、通知、删号和隐私逐路由关闭。
6. **全路由与 Release**：未映射元素、未批准偏离、缺失源码闭包、阻断项和旧表现层引用全部为零后，才生成同一哈希的真机候选。

每个模块开始编码前必须提交“保留/删除/业务替换/必要偏离”清单；实现者不能修改源码派生测试期望来迎合当前代码。独立红队发现任一哨兵漏审时，对应分区整体退回，不只修单点。

## 验收边界

- 静态几何目标误差不超过 2dp，动画关键时序不超过一帧，首次触摸反馈不超过 50ms。
- 高频日历交互、PCM、录音 level 和波形不得逐帧跨 JS Bridge。
- API 26/30/33/35、密度、字体倍率、手势/三键导航和小米真机属于最终矩阵；模拟器只作候选前预检。
- 当前不安装中间 APK，不推送 GitHub。只有全部 Release 能力关闭后才覆盖安装一次同一哈希的真机候选。
