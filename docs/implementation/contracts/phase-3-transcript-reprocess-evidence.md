# Phase 3 文字记录重新生成证据

## 产品与交互边界

- `[PRODUCT]` 重新生成只面向已登录、已同步且已有稳定文字记录的会议。当前文字记录始终保留，新结果只能形成新的不可变版本。
- `[INFERENCE]` 飞书 7.71.8 没有与老记逐 RecordingAsset 重转写相同的入口。入口复用会议详情“更多”动作层与既有 UD 风格确认框，不宣称为飞书原生功能。
- 用户动作名为“重新生成文字记录”；确认文案只说明会创建新版本并保留当前内容，不添加说明书式辅助文字。
- 入口同时受本机 feature flag 和本次远端 `transcript_reprocess_v1=true` 控制。缓存、legacy 响应、探测失败、游客会议、未同步会议或没有稳定文字时均不展示可执行入口。

## 本机任务与版本语义

- migration v31 为当前逐录音转写任务增加 `request_kind`、`request_generation`、`request_batch_id` 和 `source_transcript_revision_id`，并增加 generation 历史表。
- 同一批多段 RecordingAsset 共用 batch ID；每段录音使用新的 client request 和 idempotency identity。旧当前任务先归档，再原子重置为 durable pending，进程退出后仍由既有完成 provider 恢复。
- 只有当前会议全部逐资产任务均为 completed，combined Transcript 才会进入 canonical 保存。完成前旧 active Transcript 保持可读。
- 完整结果保存为 immutable `reprocessed` revision。相同正文的不同远端 revision 仍获得不同本机 revision identity，避免把两次生产任务折叠成一次。
- 明显更短、空或覆盖范围退化的结果不得替换当前 active revision；可保存的较差候选保持非活动，任务收敛后阶段回到 ready，不形成无限“补全中”。
- 新版本激活时既有 Summary 进入 stale；旧 Summary 继续锁定其原 Transcript revision，不把引用静默重指向新段落。

## 服务端源码边界

- 服务端不新增平行处理 API。既有 `POST /api/laoji/v2/recording-assets/{asset_id}/transcriptions` 已允许 completed RecordingAsset 使用新的 request identity 创建新 job，并拒绝同一资产同时存在两个 active job。
- capability 仅在 RecordingAsset schema 可读时声明 `transcript_reprocess_v1`。持久 sparse overlay 同步完整 `app_meeting_v2.py`、`app_recording_v2.py`、RecordingAsset model/service、retention service 与 model registry，并显式挂载 `app_recording_v2` router。
- worker 对具体 RecordingAsset 的成功重转写先取得非空结果，再在同一数据库事务替换该资产的服务端 TranscriptLine；失败或空结果保留此前稳定文字，不删除其他资产的段落。
- combined transcript revision 纳入每段资产最新 completed job 的 result revision，移动端据此区分正文相同但生产批次不同的结果。

## 当前证据

- 最新 Preview APK：`versionCode=104`、`versionName=1.0.0-source-preview`、90,897,208 字节，SHA-256 `65a954fb6d9455399824084c4b0fffbe22b7d0fc45bfa0789d2c3b2e29817fad`。
- `emulator-5556` 在覆盖安装前的真实数据库为 `user_version=30`、`quick_check=ok`；覆盖安装并冷启动后为 `user_version=31`、`quick_check=ok`，`foreign_key_check` 为空。
- v31 四个新增列和历史表存在。迁移前后 15 条会议、15 条人工笔记、11 条 RecordingAsset、4 条逐资产转写任务、2 个 Transcript revision、2 个 Transcript segment 及关键同步行数一致。
- Preview 冷启动为 `LaunchState: COLD`，主 Activity 正常 resumed；AndroidRuntime、ReactNativeJS、SQLite migration 未出现 fatal。
- TypeScript、Preview 整包和 diff whitespace 属于本批轻量收口；未恢复已归档的全量门禁或测试体系。
- 持久服务端 overlay 的七个 Python 文件通过语法编译，六个完整来源文件与 `/tmp/laoji-media-clips-v1-server` 候选逐字节一致；overlay 的 `__pycache__` 与 `.pytest_cache` 已清理。

## 尚未宣称

- 当前 18020/18035 没有监听，因此没有真实账号的新 job、combined Transcript、截断候选和重启恢复运行证据。
- 当前只有 `emulator-5556`，没有第二台移动设备或 USB 真机证据。
- 服务恢复后只需补单/多 RecordingAsset 新 job、旧版本保留、全批完成、截断不覆盖、同请求重放和重启恢复；不重做 v31 数据平面或 UI 入口。
