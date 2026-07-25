# Phase 8 会议组织与多场检索证据：ORG-01 标签和本机分源搜索

状态：用户标签与本机跨会议分源检索已形成游客/账号作用域隔离的本机纵向闭环；Folder、按人物聚合、模型主题聚合、账号跨设备标签同步仍未实现，因此 `ORG-01` 记为部分完成。本文件记录 migration v20、repository 事务、原生 Minutes 入口、模拟器实测和恢复边界，不把标题/标签样本外推成真实长 Transcript、Summary 或 Action 设备验收。

## 数据和检索合同

- migration v20 新增 `meeting_tags`、`meeting_tag_links` 和 `meeting_search_fts`。标签名在 scope 内按 NFKC、折叠空白和小写后的名称唯一；会议/标签关联同时携带 scope，并以复合外键阻止跨游客或账号关联。
- 标签创建、整组替换、改名、同名合并和删除都由 repository 事务执行。合并先以 `INSERT OR IGNORE ... SELECT` 转移关联，再删除源标签；删除标签只级联关联，不删除 MeetingNote、录音、文字记录、整理结果或人工笔记。
- 列表和设置面板的会议数只统计 `lifecycle <> deleted` 的会议；软删除记录不会继续抬高标签计数。标签操作不增加 MeetingNote root revision，也不改写 legacy/canonical 正文镜像。
- 页面只传导航会议 ID。用例先在同 scope 内解析 canonical ID；列表投影再把 canonical 结果安全映射回 legacy/remote 导航 ID，避免把 `legacy:{scope}:...` 暴露给页面或错误打开其他作用域。
- 多场索引只包含未删除会议的标题、标签、我的笔记、active Transcript、current Summary section 和 Action。每条命中保留 `source_kind/source_id/start_ms`，标题只用于结果展示；MATCH 明确限定 `content` 列，标题命中不会伪造一条“标签”或“事项”来源。
- Android 的 Expo SQLite 16.0.10 自带 SQLite 3.50.3，并以 `SQLITE_ENABLE_FTS5=1` 编译。三字符及以上查询使用 FTS5 trigram 子串 MATCH；一到两个 Unicode codepoint 的中文短词使用转义后的逐来源 `LIKE`，避免 trigram 对“验收”一类两字词静默无结果。LIKE 结果在 SQL 内截取有界上下文，不把整段长正文复制过 bridge。
- 索引在每个 scope 首次查询时事务性重建；repository mutation 通知会失效内存索引标记。查询本身不写用户正文，scope、deleted lifecycle 和 active/current revision 仍在每次检索 SQL 中复核。

## 页面和导航合同

- 原生 Minutes 搜索栏继续作为唯一跨会议搜索入口；React 只接收 query 并返回分源结果。输入框有焦点时不再用落后一轮的 React snapshot 覆盖 native EditText，快速连续输入不会丢字；清除动作先本地清空再同步状态。
- 搜索结果卡显示来源标签和摘要。Transcript 命中携带稳定 segment/source ID 与时间进入“文字记录”并定位；Summary、我的笔记和 Action 分别进入对应详情页，Action 保留独立 focus request identity；标题/标签进入会议详情。
- 会议卡长按增加“设置标签”，会议页更多菜单增加“管理标签”。设置面板支持创建和整组勾选保存；管理面板支持改名、同名合并和删除。
- 标签面板保存后先完成约 300ms 全高度退出，再关闭 Modal；父层刷新不再重启入场动画。危险删除先退出 React Native Modal，再显示 Activity 原生确认框，避免确认框不可见地落在 Modal 下方。

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

## 轻量验证与恢复

- `npx tsc --noEmit --pretty false` 与 `git diff --check` 通过。
- `:app:assemblePreview --parallel --max-workers=$(nproc)` 最终通过：627 tasks，59 executed、568 up-to-date，耗时 35 秒；没有恢复归档测试/门禁。
- 从 `codex-laoji-org01-pretest-20260725` 的 v19 保留数据覆盖安装，冷启动无应用 FATAL、SQLiteException、缺表、FTS 或 malformed query 日志。Debug 变体只用于停进程导出数据库；Python 3 的 SQLite 3.46.1 读取结果为 `user_version=20`、`quick_check=ok`、trigram schema 存在、FTS MATCH 可返回标题行。
- 原始未删除会议 `OccueneSmoke` 计数为 1。验收中创建并分配 ASCII 标签，冷启动仍显示；另建 `Beta`、改名为 `Gamma`、合并到已有标签后只剩一个标签；删除后 `meeting_tags/meeting_tag_links=0/0`，会议卡仍存在。
- 实测中发现并修复四个直接缺陷：快速输入丢字、标题命中伪造多个来源、保存后 sheet 被刷新打断而卡住、删除确认被 Modal 遮挡。修复后逐项重复相同动作，最终日志无应用崩溃或 SQLite 错误。
- 结束时再次恢复预试快照并覆盖安装最终 Preview。最终数据库仍为 `user_version=20`、`quick_check=ok`，原会议存在，标签和关联均为 0；模拟器页面没有验收标签残留。
- 当前统一交付 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-25 23:12:10 +0800`，大小 `90,501,044` bytes，SHA-256 `053e17677c5f0c56dd844f9a1b01d6deb023ccb3fd4949eb4e7dc208006da941`。已覆盖安装到 `emulator-5556`，`lastUpdateTime=2026-07-25 23:13:52`。

## 未完成边界

1. Folder 仍只保留需求门槛；当前没有真实大量会议证据支持加入文件夹，更没有树形权限模型。
2. 按稳定 speaker profile 的人物聚合和按用户标签/实验 topic 的主题聚合尚未实现；模型 topic 不得自动写成用户标签。
3. 标签当前是本机 scope 数据，没有账号 outbox、服务端 schema、跨设备合并或冲突处理，不能宣称账号同步完成。
4. 本轮没有向恢复后的常用模拟器注入 Transcript/Summary/Action 夹具；三类正文建索引和目标导航只到源码、TypeScript/Kotlin/Preview 合同，不记为设备点击实证。
5. 没有 USB 真机、深色模式、字体缩放、超大标签库或长 Transcript 性能证据；这些按轻量目标留到功能批次或候选版，而不是反向抹掉已完成的标签/标题纵切。
