# Phase 8 会议组织与多场检索证据：ORG-01 标签、分源搜索与人物/主题聚合

状态：用户标签、本机跨会议分源检索、人物聚合、用户标签主题、current structured Summary 整理主题和账号标签目录同步均已形成纵向闭环，`ORG-01` 功能量完成并锁定。Folder 仍保留真实需求门槛，不因路线表存在而预建。本文件记录 migration v20/v28、只读派生查询、原生 Minutes 入口、账号 revision/outbox/冲突边界、模拟器夹具和恢复边界；不把单个模拟器加匿名 HTTP 第二写入方外推成双物理设备或 USB 验收。

## 数据和检索合同

- migration v20 新增 `meeting_tags`、`meeting_tag_links` 和 `meeting_search_fts`。标签名在 scope 内按 NFKC、折叠空白和小写后的名称唯一；会议/标签关联同时携带 scope，并以复合外键阻止跨游客或账号关联。
- 标签创建、整组替换、改名、同名合并和删除都由 repository 事务执行。合并先以 `INSERT OR IGNORE ... SELECT` 转移关联，再删除源标签；删除标签只级联关联，不删除 MeetingNote、录音、文字记录、整理结果或人工笔记。
- 列表和设置面板的会议数只统计 `lifecycle <> deleted` 的会议；软删除记录不会继续抬高标签计数。标签操作不增加 MeetingNote root revision，也不改写 legacy/canonical 正文镜像。
- 页面只传导航会议 ID。用例先在同 scope 内解析 canonical ID；列表投影再把 canonical 结果安全映射回 legacy/remote 导航 ID，避免把 `legacy:{scope}:...` 暴露给页面或错误打开其他作用域。
- 多场索引只包含未删除会议的标题、标签、我的笔记、active Transcript、current Summary section 和 Action。每条命中保留 `source_kind/source_id/start_ms`，标题只用于结果展示；MATCH 明确限定 `content` 列，标题命中不会伪造一条“标签”或“事项”来源。
- Android 的 Expo SQLite 16.0.10 自带 SQLite 3.50.3，并以 `SQLITE_ENABLE_FTS5=1` 编译。三字符及以上查询使用 FTS5 trigram 子串 MATCH；一到两个 Unicode codepoint 的中文短词使用转义后的逐来源 `LIKE`，避免 trigram 对“验收”一类两字词静默无结果。LIKE 结果在 SQL 内截取有界上下文，不把整段长正文复制过 bridge。
- 索引在每个 scope 首次查询时事务性重建；repository mutation 通知会失效内存索引标记。查询本身不写用户正文，scope、deleted lifecycle 和 active/current revision 仍在每次检索 SQL 中复核。

## 账号标签目录同步合同

- migration v28 新增 `meeting_tag_catalog_sync_state`，复用既有 `sync_outbox/sync_conflicts`，不改写 v20 标签表。账号 scope 的本机标签仍立即提交；创建、重命名/合并、删除和整组分配只触发后台目录同步，调度失败不能回滚用户已完成的本机操作。游客 scope 永不上传。
- 同步聚合是一个受 optimistic revision 保护的账号目录快照：标签保留本机生成的稳定 `client_tag_id`；分配在传输前把 canonical meeting ID 解析为已归属当前账号的远端 meeting ID。存在标签的会议尚无远端身份时任务保持 durable pending 并先请求根同步，禁止上传悬空关联。
- 客户端保存最后确认的本机快照和完整云端快照。生成新请求时，已知本机会议采用当前分配；尚未拉到本机的远端会议继续保留上次云端分配，避免一台只持有部分会议的设备用全量替换误删未知关联。每次 claim 冻结 request payload 与 idempotency key；进程中断重放同一 payload，不用新时钟伪装成另一项修改。
- 18020 新增 `meeting_tag_catalogs_v1`、持久 operation ledger 和 `GET/PUT /api/laoji/v1/meeting-tags`；capability 为 `meeting_tags_v1`。首次创建要求 `If-None-Match: *`，后续替换要求 `If-Match`；同一 idempotency key 只重放原结果，陈旧 revision 返回 412 与完整当前候选。服务端限制最多 100 个标签、每场 20 个标签和 5000 条非空会议分配，并重新验证 NFKC 名称唯一、标签引用和会议归属。
- 无本机目录状态且本机无标签时先拉云端，不能用空目录抢先覆盖另一设备；已有本机标签的旧安装先尝试创建，若云端已存在则进入冲突。推送完成后再拉取对账；拉取只在没有 pending/in-flight/blocked/conflict 时覆盖本机 v20 表。
- revision 冲突不做 last-write-wins。`sync_conflicts` 保存本机快照和远端完整候选；用户再次打开标签入口时只显示中文选择“保留本机 / 使用云端”。保留本机先接受最新远端 revision 为新基线，再由 outbox 重提当前完整本机目录；使用云端则原子替换当前 scope 的标签和可映射分配。两条路径均不触碰会议正文、录音、文字记录、整理结果或人物资料。

## 人物和主题聚合合同

- 聚合是现有 MeetingNote/Transcript/Summary/标签数据的只读派生，不新增表或 migration。每次查询都从 `meeting_notes.scope_key` 和 `lifecycle <> deleted` 重新限定作用域；人物只读取 `transcript_revisions.is_active = 1` 的段落，不读取 inactive 历史版本，也不把 `speaker_cluster_id` 当跨会议身份。
- 人物优先按稳定 `speaker_profile_id` 聚合。一个 profile 内允许部分段落仍带匿名显示名：只要同一 profile 至少存在一个真实姓名，匿名段仍计入该稳定人物的发言段数；若整个 profile 没有可显示姓名，则不暴露 opaque profile ID，也不虚构人物标题。
- 没有 profile 时，只对 NFKC 后精确姓名做 scope 内临时聚合，不做大小写折叠、模糊相似或同音合并，并明确投影为“未确认”。`Speaker 1`、`说话人 1`、`讲话人 1`、`发言人 1`、泛化“讲话人/发言人/说话人”和 unknown 值统一由领域分类器过滤。
- 每个人物返回 profile/临时 key、会议数、发言段总数，以及每场会议的 canonical ID、可导航 ID、标题、录制时间和段数。repository 复用既有 legacy/remote 导航映射，页面不会拿 canonical 内部前缀错误打开其他 scope。
- 用户主题继续只从用户明确创建并分配的 `meeting_tags` 派生，且只包含未删除会议。
- 独立 `meetingAutomaticTopicsV1` flag 开启时，整理主题只读取 MeetingNote 当前指向、状态为 ready/stale 的 Summary version，并只接受 `kind='topics'` 的 section；`user_text` 非空/显式空白都优先于生成文本，保持既有用户编辑保护。SQL 只跨 bridge 读取每 section 前 8000 字符，单场最多接受 12 个主题。
- 整理主题逐行 NFKC、折叠空白和小写后形成稳定 identity；拒绝空白、40 字以上、控制字符、首尾结构括号、泛化“主题/讨论主题”等标题和同场重复项。它使用 `source='summary'`，与 `source='user_tag'` 的标签主题保持独立，即使显示名相同也不创建、改名、合并或覆盖 `meeting_tags`。

## 页面和导航合同

- 原生 Minutes 搜索栏继续作为唯一跨会议搜索入口；React 只接收 query 并返回分源结果。输入框有焦点时不再用落后一轮的 React snapshot 覆盖 native EditText，快速连续输入不会丢字；清除动作先本地清空再同步状态。
- 搜索结果卡显示来源标签和摘要。Transcript 命中携带稳定 segment/source ID 与时间进入“文字记录”并定位；Summary、我的笔记和 Action 分别进入对应详情页，Action 保留独立 focus request identity；标题/标签进入会议详情。
- 会议卡长按增加“设置标签”，会议页更多菜单增加“管理标签”。设置面板支持创建和整组勾选保存；管理面板支持改名、同名合并和删除。
- 标签面板保存后先完成约 300ms 全高度退出，再关闭 Modal；父层刷新不再重启入场动画。危险删除先退出 React Native Modal，再显示 Activity 原生确认框，避免确认框不可见地落在 Modal 下方。
- 账号目录发生 revision 冲突时，不在已打开的 sheet 下叠第二个窗口；入口先使用现有 Activity 对话框给出“保留本机 / 使用云端 / 取消”，解决后再打开原标签 sheet。没有新增同步说明页、英文错误或常驻状态徽标。
- 会议列表更多菜单新增且只新增一个“分类查看”入口，不增加底栏、Agent 或团队权限入口。页面以“人物/主题”双标签展示派生组；人物行显示会议数和明确的“段发言”计数，临时姓名显示“未确认”；主题标题旁用安静的“用户标签/整理主题”徽标说明来源，组内会议行可直接进入原会议详情。

## UI 证据分类

组件：会议标签设置/管理 sheet

- Classification：LaoJi-only；最近容器是现有飞书式 Minutes bottom sheet，不声称飞书 7.71.8 具有相同标签能力。
- `[PRODUCT]`：只使用老记术语；标签不修改会议正文；删除必须明确说明会议内容不会删除；不增加说明书式引导。
- `[SOURCE]`：复用既有 Universe Design surface/mask/divider、12dp 顶角、52dp 标题栏、36dp Middle action、48dp Big Primary、6dp radius、44dp 图标触控目标和约 300ms sheet motion。
- `[DEVICE]`：API 35、1080x2400、420 dpi、navigation mode 2 的 `emulator-5556` 上，设置面板可创建并保存标签，卡片冷启动后保留；管理面板可改名、合并和删除。删除确认实际显示在上层窗口，确认后会议卡仍在、标签行消失。
- `[INFERENCE]`：标签计数、checkbox 列表和改名/删除操作是老记对既有 sheet/UDButton 家族的组合，不是飞书直接页面复刻。

组件：跨会议分源搜索结果

- Classification：现有 Minutes 搜索容器的 LaoJi capability extension。
- `[PRODUCT]`：结果必须说明命中来源；Transcript 能回到原时间；全库问答不因索引存在而自动开放。
- `[SOURCE]`：搜索栏继续使用当前 Minutes 原生标题栏几何、中文 placeholder、44dp 返回/清除动作和既有卡片版式，没有新增底栏或 Agent 入口。
- `[DEVICE]`：一次性输入 `Acceptance` 完整保留并只返回“标签”来源；输入 `Occ` 只返回一条“标题”来源，不再同时伪造标签结果。trigram 中间子串 `uene` 和两字符 LIKE 子串 `ne` 都命中 `OccueneSmoke`，来源仍各只有一条“标题”。
- `[INFERENCE]`：在封面卡中用克制的来源标题与 snippet 表达搜索结果；未用临时数据实测 Transcript/Summary/Action 目标页，因此这些来源的点击只记源码和编译合同。

组件：分类查看人物/主题页

- Classification：LaoJi-only；最近容器是既有 Minutes 标题栏、双标签和中性列表层级，不声称飞书 7.71.8 存在同名聚合能力。
- `[PRODUCT]`：人物身份边界由稳定 profile/精确临时姓名决定；匿名簇不得伪装成真实人物；用户标签与整理主题来源必须可见且互不改写；不增加底栏或说明书式文案。
- `[SOURCE]`：复用既有 44dp 标题栏、16sp 常规标签、蓝色选中指示、neutral page/surface/divider、44dp 以上触控目标和中性会议列表，不使用 Minutes AI 渐变或新的页面局部色板。
- `[DEVICE]`：API 35、1080x2400、420 dpi 的 `emulator-5556` 上，菜单入口、空人物/空主题、三个有效人物、一个用户主题、两个整理主题、标签切换和会议详情跳转均实际显示；匿名编号、重复整理主题、泛化标题和损坏结构行没有形成组。静态截图检查标题栏、标签指示、来源徽标和列表没有首帧位移。
- `[INFERENCE]`：圆形首字头像、标签/文档图标、来源徽标、组内会议层级和“段发言”措辞是老记对既有列表/标签家族的组合；没有声称是飞书直接页面复刻。

## 轻量验证与恢复

- `npx tsc --noEmit --pretty false` 与 `git diff --check` 通过。
- `:app:assemblePreview --parallel --max-workers=$(nproc)` 最终通过：627 tasks，59 executed、568 up-to-date，耗时 35 秒；没有恢复归档测试/门禁。
- 从 `codex-laoji-org01-pretest-20260725` 的 v19 保留数据覆盖安装，冷启动无应用 FATAL、SQLiteException、缺表、FTS 或 malformed query 日志。Debug 变体只用于停进程导出数据库；Python 3 的 SQLite 3.46.1 读取结果为 `user_version=20`、`quick_check=ok`、trigram schema 存在、FTS MATCH 可返回标题行。
- 原始未删除会议 `OccueneSmoke` 计数为 1。验收中创建并分配 ASCII 标签，冷启动仍显示；另建 `Beta`、改名为 `Gamma`、合并到已有标签后只剩一个标签；删除后 `meeting_tags/meeting_tag_links=0/0`，会议卡仍存在。
- 实测中发现并修复四个直接缺陷：快速输入丢字、标题命中伪造多个来源、保存后 sheet 被刷新打断而卡住、删除确认被 Modal 遮挡。修复后逐项重复相同动作，最终日志无应用崩溃或 SQLite 错误。
- 人物/主题切片再次通过 `npx tsc --noEmit --pretty false`、`git diff --check` 和 `:laoji-native-platform:compileReleaseKotlin`。最终增量 `:app:assemblePreview --parallel --max-workers=$(nproc)` 通过：627 tasks，59 executed、568 up-to-date，耗时 36 秒；没有恢复归档测试/门禁。
- 人物夹具使用一个 active final Transcript：稳定 profile“林晓”有 2 段，其中一段仍显示 `Speaker 1`；无 profile 的“王敏”和 override“陈静”各 1 段并显示“未确认”；profile-less `Speaker 2` 与“说话人 3”均未形成组。用户标签“研发周会”形成 1 个主题；四类可见会议行均打开 `OccueneSmoke` 详情。
- 夹具前数据库为 v21、`quick_check=ok`。测试后没有用模糊删除回滚，而是把原始 DB/WAL/SHM 三文件原位恢复；设备与本机备份 SHA-256 分别一致为 `42ff97c9…f5f93`、`63b56aa4…3a0f`、`9fbd53a9…e5c1bd`。最终页面回到原会议列表，夹具 Transcript/标签不在常用模拟器数据中。
- 整理主题增量不新增 migration。纯归一化合同覆盖 Markdown bullet/编号/任务、NFKC 去重、泛化标题、JSON/孤立结构括号、链接/行内样式和 12 项上限；最小 SQLite 夹具确认只读取 current ready/stale、同 scope、未删除会议的 `topics` section。
- 保留数据上临时安装 Debug 变体后，canonical 审计仍为 `consistent`、账号 revision/mirror=`51/51`。夹具为“新录音”添加 current `topics` section 和一个用户标签：页面显示“研发周会 / 用户标签”、“AI 助手 / 整理主题”和“客户反馈 / 整理主题”；重复“客户反馈”只保留一组，`## 主题` 与损坏 JSON 行被拒绝，整理主题会议行实际返回“新录音”详情。
- 验证后按 DB/WAL/SHM 三文件恢复，设备读取 SHA-256 与未打开的备份逐一一致：DB `8891db34699c046466b7b3bdbb876496ed2f2b0e6c7a3a17482e71c0e571158e`、WAL `4643aec0f99d1ce554ed7c26effdca8952acabaf64d34e3f7bd47a1c88a3bf7e`、SHM `deac3b694f15d59ad18a6a1db1805d1d6ad699aa3a13ed588412b5360f27517a`；恢复后 repository audit 再次为 `consistent`，活动账号会议仍为 3 条。
- 账号目录服务候选基于运行中 18020 的精确源哈希而非较旧 overlay。一个聚焦 async SQLite 合同覆盖 missing/create/replay/update/stale-412/跨账号拒绝，另一次临时 schema helper 安装确认两张 additive 表和 foreign-key check；候选路径为 `/home/zhong/laoji-service-platform/candidates/20260726-meeting-tags-v1`，部署前备份为 `backups/20260726-meeting-tags-v1`。
- 部署后 capability 实际返回 `meeting_tags_v1=true`。真实测试账号通过 HTTP 完成 revision `0→1→2`、同请求幂等重放和陈旧 `If-Match: 1` 返回 412；用于验收的服务端 catalog/operation 行随后删除，最终 GET 回到 `exists=false/revision=0`。
- 普通 Preview 在 `emulator-5556` 把账号“移动端同步验收”分配到“新录音”，后台日志为 `pushed=1/pulled=true`，远端 revision 1 的标签名和 meeting remote ID 对账一致。随后匿名第二写入方把云端推进到 revision 2，本机另改名称后没有覆盖云端：v28 中形成 `meeting_tag_catalog/catalog local=1 remote=2 unresolved`，对应 outbox 为 `blocked/revision_conflict`。
- 验收前 DB/WAL/SHM 哈希已记录；但对本机备份执行 `sqlite3 quick_check` 时，SQLite 在备份目录把 WAL checkpoint 进主文件并移除了旁文件，因此最终不是三文件字节级恢复。恢复的是逻辑等价的 v27 checkpoint：`quick_check=ok`、标签/标签冲突均为 0；随后最终 Preview 正常迁移到 v28。冷启动审计为 `consistent`，活动账号会议仍为 3、canonical/mirror=`53/53`，无 FATAL、SQLiteException、缺表或 malformed 日志。服务端夹具也恢复为 `exists=false/revision=0`。
- 当前统一交付 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-26 12:39:10 +0800`，大小 `90,821,408` bytes，SHA-256 `1d9c596bbda41077ecfc9e65f06adb104a24d1187b389161c6273144bc4817dd`。构建为 627 tasks、63 executed、564 up-to-date，耗时 49 秒；已覆盖安装到 `emulator-5556`，`versionCode=104`、`lastUpdateTime=2026-07-26 12:45:49`。

## 未完成边界

1. Folder 仍只保留需求门槛；当前没有真实大量会议证据支持加入文件夹，更没有树形权限模型。
2. 账号标签目录同步的功能纵切已经完成；证据覆盖同一模拟器和匿名 HTTP 第二写入方，不等于第二台移动设备持续离线后往返。冲突选择对话框有源码/编译合同和底层 durable conflict 证据，本轮没有再次制造夹具去点击两种按钮。人物仍是当前账号本机 active Transcript 的派生视图，不是另一套跨设备 profile 仓库。
3. 整理主题复用已经存在的结构化 Summary，不是独立的全库 topic 模型或聚类任务；没有 `topics` section 的会议不会被猜测分类。真实模型主题质量仍随 SUM 候选抽查，不阻止只读聚合功能完成。
4. 搜索中的 Transcript/Summary/Action 目标页仍只有既有源码/编译边界；本轮夹具只为主题聚合和普通会议详情跳转，不补写成三类搜索来源的设备点击证据。
5. 没有 USB 真机、深色模式、字体缩放、超大人物/主题库或长 Transcript 性能证据；这些按轻量目标留到功能批次或候选版，而不是反向抹掉已完成的本机聚合纵切。
