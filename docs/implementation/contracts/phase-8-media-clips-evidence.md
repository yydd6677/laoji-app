# Phase 8 重要音频片段证据：CLIP-01 本机 WAV 与非 WAV 异步纵切

## 边界

- `[PRODUCT]` 来源保留为 Marker 或 active Transcript 选择，保存明确 `start_ms/end_ms`；默认带小缓冲，用户可按 capability 步长调整。
- `[PRODUCT]` 片段是派生资产。删除片段不修改原录音；永久删除会议时明确提示片段也会删除。
- `[SOURCE]` 飞书 7.71.8 没有与老记此流程相同的本机 PCM 裁切页，不能把该功能宣称为飞书原组件。
- `[INFERENCE]` 编辑页和片段列表使用会议详情同族 bottom sheet、52dp 标题栏、16dp 页边距、UD M 6dp 控件圆角、48dp 主按钮、固定错误槽和约 300ms 全高度进出场。

## 数据与恢复

- migration v23 新增 `meeting_media_clips`，以 `(meeting_id, scope_key)` 绑定 canonical MeetingNote；migration v30 增加 `export_mode`、远端 RecordingAsset/job 身份、尝试次数与远端更新时间。
- 每条记录锁定录音 asset ID、录音 checksum/更新时间、来源、范围、讲话人/文字快照和包含选择；Marker 删除只把来源 FK 置空，片段仍可用。
- 状态为 `pending -> ready/failed -> deleting`。进程中断后，pending 使用同一 clip ID 幂等恢复；deleting 继续清远端 job、本机文件后删行。
- 远端删除以 404 作为已完成，覆盖“服务端删除成功、移动端落库前中断”的重放；并发轮询不能把已经原生落盘的 immutable ready 行降回 pending/failed。
- 重试键以刚拉取的服务端 attempt 推导，避免本机旧 attempt 重放过期 retry；下载缓存使用固定安全文件名，不把远端 job ID 拼入本机路径。
- ready 行必须同时具有私有 WAV URI、文件名、字节数和完整 SHA-256；failed/pending/deleting 不伪装为可播放文件。
- 录音依赖可按 asset ID 计数；当前没有独立删除单个 RecordingAsset 的入口。永久删除整个会议会级联删行，并由 native artifact cleanup 删除片段目录。

## 本机导出

- `LaojiMediaClip` capability 返回本机 WAV 支持、最短/最长时长和调整步长。
- exporter 只接受应用私有目录内的 `file://` PCM WAV；解析 RIFF chunk，不假设 `data` 永远固定在 44 字节。
- 第一版只接受 16kHz、单声道、16-bit PCM。开始/结束按 PCM sample frame 对齐，以 64KiB 缓冲流式复制，重写 WAV header 并计算完整文件 SHA-256，不把整段录音解码进内存。
- 输出先写 `.part`、同步文件描述符再改名。数据库完成失败会删除已生成文件；重试使用确定性的 `<meeting>/<clip>.wav`。
- MP3/M4A/AAC/OGG/视频不伪装成本机可裁切；只在登录、会议与 RecordingAsset 均已同步且 fresh capability 声明支持时走服务端异步导出。

## 非 WAV 异步导出

- fresh capability 必须同时声明 `recording_assets_v2` 与 `media_clips_v1`，后者给出最短/最长时长、调整步长和固定 `audio/wav` 输出；缓存或 legacy capability 不开放入口。
- 移动端创建前重新拉取当前会议的远端 RecordingAsset，按 remote asset ID、client asset ID、上传状态和 SHA-256 对账。范围上限取本机与服务端时长的较小值，避免容器时长与 FFprobe 精确时长有几十毫秒偏差时提交越界任务。
- 服务端以稳定 client clip ID 和幂等键持久化 job，提供创建、查询/短轮询、可重试失败重跑、鉴权下载和删除；重复创建返回同一结果，不新增任务。
- worker 使用 FFmpeg 生成 16kHz、单声道、16-bit PCM WAV，先写临时文件再原子替换，持久化字节数与 `sha256:` 校验值。删除 job 只删除派生输出，不修改 RecordingAsset 源文件。
- Android 下载到独立缓存后，由原生模块流式校验期望字节数、完整 SHA-256、RIFF/WAVE 结构、PCM 参数和所选时长；通过后才以 `.part` + fsync + rename 保存到私有片段目录。下载或落盘失败不把 completed job 误当成重新转码，重试会先 GET 并重新下载。
- 删除先把本机行置为 `deleting`，随后删除远端 job 与本机文件；任一步中断都由恢复流程继续。片段 sheet 可见且存在 pending remote job 时每 2 秒轻量刷新，pending 也可主动删除。

## 入口与导出内容

- Marker 更多操作增加“生成音频片段”。
- 文字记录保留系统文字选择；选择操作栏增加“生成音频片段”，draft/realtime 段不开放。
- 编辑页在提交前明确显示范围、时长以及“包含讲话人/包含文字”，没有说明书式辅助文案。
- 会议更多动作中的“音频片段”列出 ready/failed 状态，支持来源定位、重试、系统分享和独立删除。
- 未选择讲话人/文字时直接分享 WAV；选择任一文字元数据时分享 WAV 与 `片段信息.txt` 的 ZIP，信息文件包含范围和用户选择的字段。

## 当前证据

- TypeScript、Kotlin 编译和 v23/v30 SQLite 约束、Marker 解绑、会议级联与远端状态约束属于本机源码证据。
- `[DEVICE]` `emulator-5556` 从 v22 覆盖升级到 v23 后，Marker 菜单、编辑页与片段列表可见；实际生成 `00:05–00:15` 的 10 秒 WAV。输出为 320044 字节，RIFF/data 长度、数据库 byte size 与完整 SHA-256 一致；来源定位回到文字记录并 seek。删除确认的跨 Modal 层级问题在该轮被发现并改为先退出 sheet 再展示确认框。
- 保留数据覆盖安装后，v30 `PRAGMA quick_check=ok`；15 条会议、4 条 active meeting、11 条 RecordingAsset 均保留，五个新增列存在，未出现 migration/SQLite/FATAL 错误。
- 目标 18020 的真实账号合同分别用 M4A 与 MP4 覆盖：首次创建为 202、幂等重放为 200，最终均输出 16kHz/单声道/16-bit PCM WAV；字节数、SHA-256、3 秒时长一致。204 删除后 GET 为 404，源 RecordingAsset 的字节与 SHA-256 前后不变，job 归零。
- `[DEVICE]` 模拟器的已同步 MP4 会议从 Marker 进入编辑页。旧导入资产保存的裸 64 位 SHA-256 已兼容并规范化为 `sha256:`；本机记录时长 2452ms、服务端 FFprobe 时长 2420ms 时，编辑范围收敛为服务端边界，任务成功完成并由 Android 原生校验落盘。ready 行可定位回 00:01、打开系统分享选择器并生成 WAV + 信息 ZIP；删除 ready 与先前 failed 行后，本机 `meeting_media_clips=0`、服务端该 RecordingAsset 的 job=0，原 MP4 仍可播放且源文件 SHA-256 与数据库一致。
- 该轮清理测试会议时稳定复现详情页离场崩溃。Preview R8 映射把先后出现的 `o7.k1`、`o7.X1` 精确还原为讲话人和文字记录 adapter；两个页面都长期挂载在详情 pager，删除时清空行与默认 RecyclerView 移除动画竞态。关闭这两个内部列表的装饰性 item animator 后，同一路径再次恢复并移入回收站，10 秒内无 FATAL，root outbox 正常排空。
- 最终收尾通过 `npx tsc --noEmit --pretty false`、`git diff --check` 和 Preview 全构建（627 tasks）。APK 为 `versionCode=104`、`versionName=1.0.0-source-preview`，SHA-256 `187c068e315e3ec5875ef3270c0c38f9aa893340c24d6d668619b8b663f433ff`；已覆盖安装到 `emulator-5556`，冷启动未出现 AndroidRuntime/ReactNativeJS fatal。
- 收尾时 18020/18035 已不再监听，因此没有把此前真实账号合同误报为当前在线状态，也没有重复部署或重启共享服务。

## 尚未宣称

- 片段文件与 job 当前是派生资产，不做跨设备片段目录同步；另一设备仍可从已同步源录音重新生成。
- 尚未做第二台移动设备或 USB 真机抽查；当前设备证据是 `emulator-5556`。
