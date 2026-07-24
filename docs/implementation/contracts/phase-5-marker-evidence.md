# Phase 5 导入、Marker 与分享：Marker 本机纵向切片

状态：Marker 的本机创建、对账、展示、定位、删除、显式转待办和最小披露文字分享已实现；本文件只记录轻量合同与模拟器冒烟，不代表 Phase 5 退出、真实录音链路或跨设备 Marker 同步已可用。

## 当前范围

- `MarkerRecord` 作为 `MeetingNote` 子实体保存在 canonical SQLite `markers` 表；创建、删除、读取和 Transcript 对账都约束当前 `scope_key` 与未删除 meeting，不读写旧 AsyncStorage Marker 副本。
- 创建使用安全 UUID，校验非负整数时间和可选标签；已知 primary recording 时长时拒绝越界。相同 ID 只允许完全相同的幂等结果，不允许覆盖另一条 Marker。
- 录音页传入 native recorder 的实际 `durationMs`。只有 `recording` / `paused` 可创建；`preparing`、`stopping`、`saving` 和失败态保留 44dp 槽位但禁用，暂停/停止控制的位置不因状态改变。
- 创建事务立即写本机 Marker，并在同一事务内尝试关联 active Transcript 中实际覆盖该时间点的 segment。静音空档不猜测最近段；active revision 后续变化时可重新对账。
- legacy meeting/session ID 统一通过 `findByNativeSessionId()` 解析 canonical meeting ID，避免详情 route 或录音 session ID 把 Marker 写到错误聚合。
- Minutes snapshot 升级到 v7。详情“文字记录”页即使没有 Transcript、只有 Marker 也能进入 ready 状态；Marker 按时间排序显示在搜索栏下方。
- 点击 Marker 优先定位已对账 segment，否则按时间距离定位可见段；存在可播放音频时同时 seek，无音频时只定位文字，不报播放器错误。
- 每条 Marker 使用“旗帜 + 时间 + 更多 + 删除”的稳定槽位。更多操作只提供“创建待办事项”和“分享标记文字”；创建待办要求用户显式填写内容，不把附近 Transcript 自动伪造成任务。
- Marker 待办是 meeting-global action，不依赖当前 Summary version。数据库 v9 增加 `source_marker_id` 外键和 partial index；同一事务校验 Marker 的 meeting/scope/time/segment，固化 `source_kind='marker'`、segment 和 time。静音 Marker 可以没有 segment，但仍以 `source_start_ms` 作为可展示、可 seek 的有效来源。
- 分享 payload 只含 `标记 mm:ss` 和一段附近 Transcript，不默认附带会议标题、完整 Transcript、笔记、整理结果或音频。
- 删除只移除 Marker，不删除 Transcript、Summary、行动项或录音；`ON DELETE SET NULL` 只清除行动项的 Marker link，meeting/segment/time/content 继续保留。页面先等 canonical transaction 成功，再即时刷新并显示中文 Toast。
- 当前 capability/API 没有已验证的远端 Marker 合同，因此只声明本机 canonical 能力，不创建伪远端同步状态。

## UI 证据分类

组件：录音页标记动作

- Classification：LaoJi-only component，最近容器为 capability-reduced Minutes Record V3 operation row。
- `[SOURCE]`：旗帜 glyph 来自飞书 7.71.8 `ud_icon_flag_outlined -> r/fcq.xml`；颜色使用共享 `primary` / `primarySoft` / `disabled` 语义，触控目标为固定 44dp。
- `[PRODUCT]`：入口无说明文字；录音中和暂停态可用，其他状态禁用但布局不移动；成功只给轻触觉与 `已标记 00:05` Toast。
- `[INFERENCE]`：旗帜入口固定在操作行左侧，保留中间暂停/停止组合的既有位置。飞书 7.71.8 没有已确认的同一 Android Marker 控件，不声称直接复刻。

组件：详情 Marker 时间条

- Classification：LaoJi-only component，最近容器为 Minutes 详情“文字记录”页和 Universe Design quiet action。
- `[SOURCE]`：沿用详情页 16sp/14sp 层级、`primarySoft`、6dp radius、44dp icon action 和共享 pressed/disabled 色；更多与删除都使用图标，不使用文字胶囊。
- `[PRODUCT]`：Marker 位于搜索与正文之间，点击定位、更多操作和独立删除；没有音频仍能使用，不新增说明书文案或独立底栏入口。
- `[INFERENCE]`：横向可滚动紧凑时间条及“旗帜 + 时间 + 更多 + 删除”组合是老记 Marker 所需，不声称飞书 7.71.8 存在相同详情条。

组件：Marker 操作 sheet 与来源时间

- Classification：LaoJi-only component，复用现有详情 action sheet 和 quiet source action。
- `[PRODUCT]`：转待办必须由用户填写任务正文；分享默认最小披露；删除 Marker 后待办仍可见并显示固化的来源时间。
- `[INFERENCE]`：静音 Marker 没有可定位 segment 时，来源按钮仍按时间存在；有音频则 seek，无音频只切到文字页，不猜测不存在的 Transcript 段。

## 轻量验证

- `npx tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过。
- `:app:compilePreviewKotlin`：通过。
- `:app:assemblePreview`：通过。
- 录音失败态模拟器冒烟确认 Marker 按钮禁用，44dp 槽位仍在，暂停/停止控制没有位移；无应用 FATAL。
- 当前会议服务返回 HTTP 502，无法启动真实录音，因此没有把创建 Toast、触觉、录音中/暂停态实际写入记为已验证。
- 通过同签名 Debug 的临时只读窗口注入一条脱敏 Transcript 和 `00:05` Marker，再覆盖安装 Preview。详情页实际显示紧凑 Marker 条；点击时间区域不误删，无音频时不报错。
- 点击独立删除图标后，Marker 条即时消失并显示中文 Toast `已删除标记`。随后只读提取 SQLite：夹具 `markers` 计数为 0，脱敏 `transcript_segments` 计数仍为 1，证明删除落盘且未级联伤及 Transcript。
- 真实模拟器完成 v8 -> v9 迁移：`user_version=9`、`PRAGMA quick_check=ok`、`PRAGMA foreign_key_check` 无输出；原有 meeting/action/marker 数量未减少，新增列、partial index 和 `ON DELETE SET NULL` 外键均存在。
- Marker 更多操作实际打开两个命令；系统分享 chooser 实际显示 `标记 00:05` 和单段脱敏文字，没有出现会议完整资料。action-only “整理结果”页在没有 Summary version 时仍显示待办和安静的 `生成整理结果` 命令。
- 数据夹具删除 Marker 后，SQLite 结果为：Marker 计数 0、Transcript 计数 1、待办正文 `marker-action-smoke` 保留、`source_kind='marker'`、`source_marker_id=NULL`、`source_segment_id='fixture-v9-segment'`、`source_start_ms=5000`。页面继续显示待办及 `来源 00:05`。
- 静音 Marker 的无 segment 边界完成静态合同检查：snapshot v7 输出 `hasSource=true`、空 `sourceSegmentId` 和保留的 `sourceStartMs`；Kotlin 以 `hasSource` 而不是 segment 非空决定是否显示来源。该边界未重新注入模拟器数据，不能记为运行时验证。
- 模拟器原始 canonical DB 与 AsyncStorage 分别以 SHA-256 `86dbf15c30689881010f2270cf5cc7c45c24960afcab251ddf86369834377a03`、`f8840cc8c03cd3a1c9a5f1a26cf97640aa28e13dfe891f7f3049557022ac2d39` 恢复；设备反向提取结果逐字节相同。恢复后 action/marker/synthetic Transcript 计数均为 0，SQLite `PRAGMA quick_check` 为 `ok`。
- 临时截图、数据库和 Debug 提取物只保留在 `/tmp/laoji-marker-action-v9-20260724`，未写入轻量主树。
- 当前可安装 Preview：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-24 01:14:21 +0800`，大小 `89,836,331` bytes，SHA-256 `7eb935f07863dbe2460a3fb1d0f32be001e2a35bb0c44080532d7a5202e16109`。已覆盖安装到唯一设备 `emulator-5556`，包版本为 `1.0.0-source-preview`；冷启动进程存活，日志无应用 FATAL、`SQLiteException` 或 `no such column`。

## 未完成边界

1. 当前没有 USB 真机；Marker 的真实触觉、录音中连续时间、暂停停点、系统字体/密度和手指遮挡仍缺真机复核。
2. 会议服务 502 阻塞真实录音创建与带有效音频 seek；只验证了无音频 Transcript 定位和删除。
3. 没有已验证的 Marker v2 服务端 endpoint/capability；账号 Marker 目前只保存在本机，不宣称跨设备同步。远端 action payload 不发送仅本机有效的 Marker ID。
4. 文件/系统分享摄取与分层分享的首个本机纵切已后续完成，见 `phase-5-media-import-evidence.md` 和 `phase-5-layered-share-evidence.md`；同步感知删除仍未完成，格式穷举、2GB 文件和强杀矩阵仍按当前轻验证目标后置。
