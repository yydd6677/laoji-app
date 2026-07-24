# Phase 3 文字精确回听：首个纵向切片

状态：搜索切片已完成模拟器验证；Draft/Final 完整性切片已实现并通过纯函数/编译契约，事务与真机集成验证仍进行中。本文不代表 Phase 3 退出。

## 范围

- `MINUTES_SNAPSHOT_SCHEMA_VERSION = 3`，TypeScript/Kotlin 同步增加 `active`、`searchRanges`、`selectedSearchMatch`、`revisionKind`，未知或非法值使用默认值并丢弃越界范围。
- `MinutesTranscriptSearchController` 在 Kotlin 页面内持有 query、匹配和选择；NFKC + `Locale.ROOT` lowercase，最多保留 1000 处，上一处/下一处循环。
- Transcript 使用 `ListAdapter + DiffUtil`。搜索变化通过 body payload 更新；播放段落变化只 payload 更新旧/新 active row，不再全量 `notifyDataSetChanged()`。
- 有有效 `sourceId + uri` 时，短按段落 seek 到 `startMs`；无有效音频时不发送 seek，并在固定底部状态槽显示“暂无可播放的录音”。
- 正文保留系统选择和复制；自定义“分享”只发送选中文字，并附该段讲话人和时间。

## UI 证据分类

组件：文字记录页固定搜索行

- Classification：capability-reduced direct component
- `[PRODUCT]`：工程指示 TRN-01 要求单场本地搜索、循环导航、精确范围高亮；query 不跨 RN bridge、不持久化正文。
- `[SOURCE]`：飞书 7.71.8 `mm_layout_detail_search.xml` 使用 48dp 搜索 host、36dp filler input、16sp query、6dp radius；`mm_view_search_bar.xml` 使用 14sp 计数和 22dp 上/下图标；`MmDetailSearchBar` 发出 `-1/+1` 导航语义。
- `[EMULATOR]`：`emulator-5556`，1080×2400、420 dpi、三键/手势配置值 2。输入 `abc` 实际匹配全角 `ＡＢＣ` 并显示 `1/1`；键盘显示时搜索栏、正文和底部状态无重叠；上一/下一循环后目标行 bounds 保持 `[0,924][1080,1239]`；长按正文出现系统选择与 Copy；无音频短按后未出现播放器/seek 控件，logcat 无应用 FATAL。
- `[DEVICE]`：真实手机上的拖选、ActionMode 自定义“分享”和 seek 误触录像仍待完成；模拟器证据不能替代这一项。
- `[INFERENCE]`：老记将输入、计数和循环导航放在同一固定 48dp 行；飞书当前分支的边界禁用被产品要求的循环语义替代。
- Intentional deviation：用户术语为“文字记录”，不展示飞书专有术语；不使用服务端字幕搜索 loading 动画，因为本切片完全本机同步执行。

组件：匹配与播放高亮

- Classification：capability-reduced Feishu surface
- `[SOURCE]`：飞书搜索输入使用 `primary_fill_transparent_02 = #26336df4`；字幕控制链由播放进度驱动当前内容定位。
- `[INFERENCE]`：普通匹配使用源 15% 蓝；当前选择使用同色 30% 以区分；当前播放段落使用 `primarySoft` 行背景。第一阶段没有词级 timing，因此不伪造逐词高亮。

## 可执行契约

临时 `/tmp` Kotlin contract 与生产 `MinutesState.kt`、`MinutesTranscriptSearchController.kt` 同编译运行，覆盖：

- 全角拉丁字母 NFKC、组合音符到原文 UTF-16 范围映射。
- 中文重复词数量、上一/下一循环。
- 1001 个匹配截断为 1000，并显示 `1/1000+`。
- `start <= position < max(end, next.start)` 的时间二分边界。
- 10000 段 synthetic 中文输入。

本机 JVM 单次结果：索引 39.363ms、首次搜索 0.893ms、10000 次导航平均 0.000148ms。它证明纯函数边界和桌面 JVM 预算，不替代 Android 真机 60 分钟样本性能/精度验收。

## Draft/Final 完整性切片

- `transcriptCompleteness.ts` 统一计算最大时间、NFKC 后非空 code point 和非空段数；只在两项显著回退或时间/文字极端回退时判定候选明显截断。分段合并本身不构成拒绝。
- Transcript API 新增 snapshot 读取，兼容数组旧响应；若 envelope 声明 `is_complete/complete/final` 或 transcript status，则归一为 `complete/incomplete/unknown`。当前线上是否实际返回明确声明仍未验证。
- `MeetingsStore.saveCachedTranscript` 对录音 checkpoint、会后同步和详情刷新使用同一判定；被拒绝的候选不覆盖 legacy cache，但仍交给 canonical mirror。
- transaction 新增 active revision 连同 segments 的同事务读取。mirror 在同一 transaction 保存候选 final、决定是否切 active 并更新 transcript stage；较短 final 保存为 inactive，active draft 与 UI 可读内容保留。
- canonical projection 现投影 `isFinal/revisionKind`；详情在不打开全局 canonical list read 的情况下读取单场 active revision。stage 为 `finalizing` 时固定信息槽显示“文字记录仍在补全”。
- 旧 `mergePersistedMinutesTranscript` 的远端+本机混合 final 已删除；会后同步在 draft 与服务端候选之间选择完整 revision，不再拼出没有来源身份的混合版本。

临时 TypeScript runtime contract 直接转译并执行生产纯函数，覆盖：明显截断 final 拒绝、合并分段 final 接受、显式 incomplete 的丰富 draft 接受但保持补全、空响应保留已有内容、NFKC code point 和服务端声明解析。`npx tsc --noEmit` 与 `git diff --check` 已通过；临时 contract 已删除。

## 后台播放返回生命周期切片

- `[PRODUCT]`：后台播放离开详情后继续；返回同一会议时，详情的异步音频加载暂态不得删除 MediaSession source、恢复位置或当前播放态。
- `[SOURCE]`：详情播放器继续使用现有 Media3 `MediaSessionService`、500ms position 发布和 source metadata；本切片不改播放器几何、颜色或飞书映射。
- `[INFERENCE]`：详情页只绑定/隐藏本页 toolbar，不拥有全局 MediaSession 的清空权。显式账号 scope 切换，以及 `retainForBackground=false` 的最后一个 surface detach，仍可清空 source。
- `MinutesPlayerView.bindSource(null)` 不再向 controller 发送 clear；这覆盖 React 在本地/云端录音异步解析前先给出 `playerSource=null` 的真实挂载顺序。
- controller 对完全相同的 desired source 幂等；失败后的相同 source 仍允许重试。相同 `sourceId + storageScope` 但 URI、headers、title 或过期时间变化时仍发送更新，由 service adapter 在当前位置替换 media item 并保留播放态；不同录音从 0 切换。
- source callback 必须同时匹配 desired generation 与 active dispatched generation。storage scope 使旧 source 失效时立即释放旧 in-flight 标记，旧结果不得清除新错误或永久阻塞 pending play/seek/rate。

临时 Kotlin contract 与生产代码同 module 编译运行，覆盖：完全相同 source 不重复发送、失败 source 可重试、同录音换签名 URL/headers 可保位、不同录音或 scope 不保位、stale generation 被拒绝，以及恢复位置映射到正确 Transcript 段；结果为 `PASS`，临时入口已删除。`compileReleaseKotlin`、TypeScript 和 Preview 整包构建通过。Preview 已覆盖安装 `emulator-5556`，会议列表及原始失败记录页面无应用 FATAL；模拟器当前没有有效录音，不能把这次 smoke 记作真实后台播放返回证据。

## 尚未完成

- Draft/Final 的真实 SQLite 事务注入与重启恢复录像；reprocessed 的生产入口尚未接入。
- 服务端稳定 completeness 字段和 revision identity；当前移动端只能兼容解析可选声明并在缺失时本机 fail-safe。
- 真实 10/30/60 分钟中文会议的随机 20 段 seek 误差。
- 连续跨 100 段、带有效录音的后台播放返回、长按拖选/自定义分享不误触 seek 的真机视频。
- 深色模式对应 token；当前产品仍只承诺现有浅色主题。

## 模拟器数据还原

搜索验证使用的 synthetic Transcript 已清除。恢复前备份的 `RKStorage`、canonical DB、WAL、SHM、journal 五个文件逐一按 SHA-256 回写一致，随后重新安装 Preview APK；会议列表只剩原始失败记录，不再含 synthetic 封面/转写。设备侧中转目录已删除。
