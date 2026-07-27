# Phase 6 重复会议系列记忆证据：SERIES-01

状态：重复会议的系列身份、最近一次已结束会议、最多三条决定、最多五条同系列未完成事项、可靠决定引用定位、来源跳转、用户明确选择后“带入我的笔记”，以及生成新整理结果时独立选择历史参考，已形成本机/线上纵切。migration v13 保持逐来源实体去重；Summary 授权使用独立 request identity，不复用笔记选择。目标 18020 已以真实账号、不同来源/目标会议完成决定型和行动型历史授权、未选内容隔离、引用隔离、幂等复用与冷启动持久读取；跨移动设备 action 更新仍是候选证据尾项。

## 当前数据与查询合同

- calendar origin 的唯一系列身份为 `calendar:{scope_key}:{sourceEventId}`。`calendarMeetingSeriesKey()` 是领域层唯一构造函数；occurrence 绑定时由 repository 重新推导，不信任调用方传入的旧裸 key。
- migration v10 把已有 `meeting_occurrence_links.series_key` 的空值、裸 source ID 和其他旧格式统一回填为规范 key。系列查询同时约束 meeting scope、link scope、active link 和 canonical key，不能跨游客/账号读取。
- 会前投影只在未来的重复 occurrence、展开 occurrence 或 recurrence exception 上加载。单次日程、已开始或过去 occurrence 不展示该区域；标题相似不会自动成系列。
- “上次会议”严格选择当前 occurrence 之前、同系列、最近一条 `lifecycle=ended` 的 meeting；先按 occurrence date，再按 ended/update time 和 ID 确定性排序。
- 决定只读取上次会议当前 active Summary 中 `decisions/commitments` section。人工编辑文本优先于生成文本；按真实换行拆条、去掉常见列表前缀、忽略空行，最多三条，并在领域投影中保留来源 meeting 与 citation identity/time。单条决定可保留该 section 的引用；多条决定只有在决定数与按 ordinal 排序的 citation 数相等时才一一映射，否则不提供伪精确定位。
- 未完成事项从当前 occurrence 之前所有已结束的同系列会议查询，不只限上一次会议。只返回 canonical `status=pending` 的原 action，按有截止时间优先、截止时间、来源 occurrence 和创建时间排序，最多五条；不会复制同名任务。
- 投影保留 canonical/legacy meeting ID、action ID、来源 segment ID 与 start time。详情页点击事项进入来源会议并按原 action ID 聚焦；在来源会议完成它后，下一次查询自然不再返回该事项。
- Calendar detail snapshot 同步升级为 v2，TypeScript 与 Kotlin 都拒绝把其他 schema 静默解释为当前形状。loading/error 使用中文固定槽和显式“重试”。
- “带入我的笔记”只接收用户在 sheet 中明确勾选的决定/事项 ID，默认不勾选。写入前重新查询同一 occurrence 的系列记忆并逐项校验 ID；已变化或消失的选择拒绝写入。
- 选择整理模板后，移动端重新按本场 meeting 的 occurrence 查询同一份系列记忆；无候选直接生成，有候选则打开独立的“引用上次会议内容”sheet。默认零选择；“取消”终止本次生成，“不引用”明确继续，笔记 sheet 的既有勾选不构成模型授权。
- 提交引用时再次查询 SQLite 并校验所选 ID。账号作用域必须把来源映射为归属当前账号的远端 meeting ID；缺少远端来源身份时拒绝授权。最多八项，授权 request ID、完整项目快照、模板和 Transcript 共同进入 v3 input fingerprint，并完整写入 pending task；恢复、任务丢失重提和结果校验沿用同一授权身份。任务入口区分“未提供 carry 参数”和“明确传入 null”，因此用户选择“不引用”会覆盖旧 pending 授权，不会因 nullish fallback 把历史内容重新带回。
- 登录与游客 Summary 请求均只发送本次明确授权的 `carry_forward`；服务端把 request ID 纳入去重指纹和 schema v2 结果。历史 JSON 被标记为背景而非本场 Transcript 证据，不得生成本场引用；账号端额外验证每个来源 meeting 都归当前用户，且禁止引用本场自身。
- 纯文字历史授权进入可控 4B JSON 路径；附件/图片授权仍走完整上下文管线。用户选中的历史项会以来源日期/标题进入各模板既有讨论类 section；未选项没有进入该投影的通道。与授权历史重叠的决定/待办若未被本场 Transcript 明确重新确认，在落库前确定性移除；历史独有文字所在 section 不携带本场引用。
- 用例先通过统一 occurrence 用例查找或创建目标会议，再按 scope 读取 canonical aggregate，以 revision CAS 保存人工笔记。已有笔记原文完整保留；来源块追加日期、会议标题、负责人和截止时间，不创建 action 副本，也不改变原 action 状态。
- migration v13 新增 `meeting_series_carry_imports`，以 `(target_meeting_id, source_kind, source_item_id)` 为主键，并保存来源会议、日期、标题、正文、负责人、截止时间、segment 与 start time 快照。目标会议删除时 ledger 级联删除；来源会议 ID 刻意不设外键，来源删除后已导入快照仍可解释人工笔记。
- 每个新选项先在与人工笔记 CAS 保存相同的 SQLite transaction 中插入 ledger；只把本次成功插入的决定/事项组成追加块。相同请求在进程内仍按 scope、occurrence 和排序后的选择 ID 合并；跨进程重试和部分重叠选择由逐项主键去重，ledger 与正文不会出现半提交。

## UI 证据分类

组件：未来重复日程详情中的“上次会议”信息分组

- Classification：LaoJi-only component；最近容器为 Calendar detail 的信息分组，不声称飞书 7.71.8 存在相同的跨会议记忆组件。
- `[SOURCE]`：沿用当前原生日历详情的 `CalendarPagePalette`、语义 divider、Calendar blue、正文/次级文字层级、pressed surface 和 44dp 触控槽；没有为该区域引入 Minutes 渐变或新的页面私有配色。
- `[PRODUCT]`：只在未来系列 occurrence 展示；最多三条决定和五条未完成事项；所有内容只读且可回到来源；完成的是同一 action，不把历史文本自动写入新会议。
- `[DEVICE]`：API 35、1080x2400 的 `emulator-5556` 上，“上次会议”、三条独立决定和两条未完成事项完整显示，没有卡片嵌套；来源日期、负责人和截止日期保持次级层级。
- `[INFERENCE]`：在既有提醒信息之后用全宽 divider 接一个无外框信息组、决定使用小蓝点、事项使用未完成圆环，是老记对 Calendar detail 信息层级的组合，不是飞书直接页面复刻。

组件：“带入我的笔记”选择 sheet

- Classification：LaoJi-only component；最近容器为飞书式 bottom sheet，不声称飞书 7.71.8 有相同的系列记忆导入功能。
- `[SOURCE]`：沿用 surface、mask、divider、正文层级、6dp Big Primary、固定错误槽和约 300ms 全高度进退场；没有引入页面私有渐变或装饰卡片。
- `[PRODUCT]`：决定和未完成事项默认均不选择；只有用户明确勾选并提交的内容进入人工笔记，原 action 继续保持同一对象。
- `[DEVICE]`：API 35、1080x2400 的 `emulator-5556` 上，选择一条决定和一条事项后进入“我的笔记”；进退场录像中 sheet 从完整高度进入和退出，背景详情页未上下跳动。
- `[INFERENCE]`：按来源会议分组并在每行显示日期与标题、底部使用全宽提交按钮，是老记对既有笔记写入语义的组合。

组件：“引用上次会议内容”独立授权 sheet

- Classification：LaoJi-only component；与“带入我的笔记”共用飞书式选择 sheet 容器，但授权对象和提交结果相互独立。
- `[SOURCE]`：共用 12dp 顶角、52dp 标题栏、64dp 选择行、22dp checkbox、48dp/6dp 主按钮、固定错误槽和约 300ms 全高度进退场；模板 sheet 完整退出后才开始查询和呈现下一层。
- `[PRODUCT]`：默认零选择；左侧“取消”不生成，右侧“不引用”明确生成但不发送历史内容，主按钮仅在选择后显示“引用（N）”。不增加解释性说明，不复用笔记授权。
- `[DEVICE]`：本批最新 Preview 已覆盖安装并完成冷启动/崩溃 smoke；恢复后的原始模拟器数据没有未来系列 occurrence 与可生成 Summary 的组合，因此本批未伪造新授权 sheet 的设备交互证据。
- `[INFERENCE]`：决定/未完成事项的分组和来源元数据沿用已验证的笔记选择 sheet；“不引用”作为标题栏显式继续动作，是为区分取消与零历史输入的老记语义。

组件：历史决定的来源文字定位

- Classification：LaoJi-only 跨页面导航；目标容器沿用飞书文字记录列表，不声称飞书 7.71.8 有相同的会前决定入口。
- `[SOURCE]`：飞书 `mm_fragment_transcription.xml` 为 RecyclerView 保留 32dp 底部空间并设置 `clipToPadding=false`；`MmMeetingSubtitleViewControl`/`MmSubtitlesAdapter` 使用 `scrollToPositionWithOffset` 定位段落。老记继续沿用相同的列表与 offset scroll 家族。
- `[PRODUCT]`：有可靠 segment 映射时点击决定进入来源会议“文字记录”并定位；映射缺失或歧义时只进入来源“整理结果”，不得把 section citation 无条件复制给每条决定。
- `[DEVICE]`：API 35、1080x2400 的 `emulator-5556` 上，三条决定与三条 citation 一一映射。点击第二条后进入“文字记录”，目标 `01:16` 段从列表起点 y=720 开始显示；旧实现被列表末端钳制在 y=1705。最终截图中上一段没有残留在搜索栏下方，日志无 FATAL 或索引异常。
- `[INFERENCE]`：跨会议跳到末尾附近段落时，按当前可视高度临时增加尾部定位空间；普通浏览仍使用飞书来源的 32dp 底部空间。该空间是为满足老记来源定位合同，不是飞书直接值。

## 轻量验证

- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- 历史 compact/隔离增量使用 18020 实际进程环境执行 40 项 Summary/API 相关窄合同并通过，目标 Python 3.11 `py_compile` 通过。线上回滚前态为 `backups/20260728-history-compact-v6`。
- 9B 完整管线基线 task `4631376b-a5de-4b8a-a5f8-e98c6678effc` 用时 392.7 秒，暴露了历史文字与本场 citation 混在同一 section 的歧义。修复后决定+行动授权 task `10d44db3-65f9-4dba-8fde-a0e9b3da7710` 使用 4B 在 50.6 秒成功；只保留本场演示决定和周敏待办，方案乙只作背景，旧待办未被复制。
- 反向行动单项授权 task `1ac18bbf-dc8b-48ca-91c4-a9ecf2f23387` 在 53.0 秒成功，durable version `c7608cc4-eee4-4d4d-8ba1-b32fb9442048`。`王磊周三前完成安卓回归测试。` 完整进入来源背景行且 citation 为 0；未授权的方案乙/方案甲、游客入口、十五分钟、安卓优先、数据库迁移和张伟均未出现。唯一决定/行动来自本场，2 个 citation 均属于本场 8 段 Transcript。
- 以同一 request ID 重提返回 `reused=true` 且复用同一 task ID；18020 冷启动后 durable endpoint 仍返回同一 version/授权 ID/来源背景。最终 18020 PID `984809`，继承 34 项环境；18035 保持 PID `3293181`。
- 当前统一交付 APK 为 `android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-24 17:12:11 +0800`，大小 `90,121,368` bytes，SHA-256 `06b4225234b6b72de1a98355d3b0f95424563c43d6805c541c652ef399fa7c91`；已覆盖安装到 `emulator-5556`，`lastUpdateTime=2026-07-24 17:12:23`。冷启动进程存活，日志无应用 FATAL、React Native exception 或 SQLite/schema error。
- `:app:assemblePreview --parallel --max-workers=$(nproc)`：通过；627 个 task，59 executed，耗时 34 秒。
- 临时设备数据把原 `OccueneSmoke` 改为每周重复：2026-07-22 为已结束来源会议，2026-07-29 为未来 occurrence；来源 Summary 注入三条真实换行决定，并保留两条 pending action。UI tree 分别读到三条决定，而不是显示字面 `\n`。
- 在未来 occurrence 点击历史事项，实际进入来源会议的整理结果并精确聚焦原 action。把该 action 标记完成后返回未来日程，该项从“未完成事项”消失，证明 projection 使用同一个 canonical action，没有复制文本。
- 修复了伴随验证发现的入口冲突：`MediaImportIntentInbox.offer()` 现在只把 `content://`/`file://` 的 `ACTION_VIEW` 当媒体导入；`laoji://` 交给语义导航。合法 occurrence URL 从强停状态得到 `LaunchState: COLD`，页面直接进入 2026-07-29 日程详情，没有“无法导入”对话框。
- Activity 已运行时再次投递同一 URL，Android 明确报告 intent 已交给当前 top-most `MainActivity`。冷/热两份 UI tree 字节一致，仍显示同一三条决定和两条事项；清空后的 logcat 没有应用 FATAL、React Native exception、SQLite/schema error 或媒体导入错误。
- 在选择 sheet 中只勾选“验收前不恢复归档门禁”和“周二前整理验收清单”，进入“我的笔记”后正文为 `来自 2026年7月22日 · OccueneSmoke`，其下只包含所选决定与事项；事项保留“负责人：小陈；截止：2026年7月28日”。没有复制 action 对象。
- SQLite 中目标 occurrence 会议只有一份人工笔记，首次写入后 `revision=1`、来源块计数为 1；对同一完整选择重复提交后仍为 1。强停冷启动后正文仍存在；验收录像确认完整进退场未使详情页跳动，临时录像已按轻量工作区约束清除。
- v13 重叠选择实测分两次执行：第一次选择决定 A + 事项 B，第二次选择事项 B + 决定 C。最终 `meeting_series_carry_imports` 为 3 条，人工笔记 `revision=2`，事项 B 正文只出现一次；ledger insert 与 note revision 同事务提交。
- citation 长列表夹具含 18 段 Transcript、三条决定和三条一一对应 citation。数据库确认第二条决定绑定 `series-v13-segment-2`、`start_ms=76000`，不是早期记录中的 `00:06`。点击后原生页选中“文字记录”，最终目标 `01:16` 为第一条可见 row。
- v12→v13 真实迁移在模拟器导出库上得到 `PRAGMA integrity_check=ok`、`user_version=13`，ledger 表存在且初始为 0，原 `OccueneSmoke` 未丢失。
- 测试结束后使用同签名 Debug 变体停进程，逐个删除 `RKStorage-journal` 与 canonical DB 的 WAL/SHM，再写回原始 v13 主文件。设备内恢复后的 SHA-256 分别为 `25f9256641f239321af1b0b7c413c19e1d2b6e99886b154ebe5a120242edda65` 和 `42ff97c95cc1bfdec2a1308048455b28a55be04d1ac66a846f725a807b4f5f93`，恢复后只剩两份主文件。
- 恢复后的事件 JSON 明确为 `repeat: "once"`；数据库 `integrity_check=ok`、`user_version=13`、ledger 计数为 0。最终 Preview 冷启动只显示 `2026-07-22` 的原始活动日程 `OccueneSmoke`，`2026-07-29` 无日程，UI tree 与日志均不含系列夹具文本，且无应用 FATAL、React Native exception 或 SQLite/schema 错误。安装包为 `versionName=1.0.0-source-preview`、`versionCode=101`，`lastUpdateTime=2026-07-24 10:12:28`。

## 未完成边界

1. 当前没有 USB 真机；不同物理设备密度、字体缩放、深色模式、手势导航 inset、长文截断和触觉尚未验证。
2. 真实账号历史授权、利用/隔离、引用边界、幂等与冷启动已完成；尚未在当前恢复的模拟器数据上制造未来系列 occurrence 并重跑新授权 sheet 录像。
3. 多决定 citation 数量不等时会安全退回来源 Summary，不做模糊猜测。v13 之前已写入的纯文本来源块不能可靠反推 ledger；Summary 重生成若改变 section/item identity，语义相同的新决定仍可能被视为新来源实体。
4. recurrence exception、`following` segment 和服务端拆分新 source ID 的身份规则已由 key 设计支持，但本轮只实测普通周重复，没有做完整编辑矩阵。
5. 已使用真实测试账号和运行中 18020 完成不同会议来源归属与生成；跨移动设备 action 更新、并发冲突和远端 series identity 仍待候选抽查。非 Android 页面仍未接入该信息组。
6. 本轮遵循轻量工作区约束，没有恢复归档测试、门禁或压力矩阵；只执行类型检查、最终 Preview 构建、定向模拟器交互、数据恢复和崩溃日志检查。
