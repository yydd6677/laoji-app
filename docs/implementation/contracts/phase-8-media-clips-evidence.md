# Phase 8 重要音频片段证据：CLIP-01 本机 WAV 纵切

## 边界

- `[PRODUCT]` 来源保留为 Marker 或 active Transcript 选择，保存明确 `start_ms/end_ms`；默认带小缓冲，用户可按 capability 步长调整。
- `[PRODUCT]` 片段是派生资产。删除片段不修改原录音；永久删除会议时明确提示片段也会删除。
- `[SOURCE]` 飞书 7.71.8 没有与老记此流程相同的本机 PCM 裁切页，不能把该功能宣称为飞书原组件。
- `[INFERENCE]` 编辑页和片段列表使用会议详情同族 bottom sheet、52dp 标题栏、16dp 页边距、UD M 6dp 控件圆角、48dp 主按钮、固定错误槽和约 300ms 全高度进出场。

## 数据与恢复

- migration v23 新增 `meeting_media_clips`，以 `(meeting_id, scope_key)` 绑定 canonical MeetingNote。
- 每条记录锁定录音 asset ID、录音 checksum/更新时间、来源、范围、讲话人/文字快照和包含选择；Marker 删除只把来源 FK 置空，片段仍可用。
- 状态为 `pending -> ready/failed -> deleting`。进程中断后，pending 使用同一 clip ID 幂等重试；deleting 继续清文件后删行。
- ready 行必须同时具有私有 WAV URI、文件名、字节数和完整 SHA-256；failed/pending/deleting 不伪装为可播放文件。
- 录音依赖可按 asset ID 计数；当前没有独立删除单个 RecordingAsset 的入口。永久删除整个会议会级联删行，并由 native artifact cleanup 删除片段目录。

## 本机导出

- `LaojiMediaClip` capability 返回本机 WAV 支持、最短/最长时长和调整步长。
- exporter 只接受应用私有目录内的 `file://` PCM WAV；解析 RIFF chunk，不假设 `data` 永远固定在 44 字节。
- 第一版只接受 16kHz、单声道、16-bit PCM。开始/结束按 PCM sample frame 对齐，以 64KiB 缓冲流式复制，重写 WAV header 并计算完整文件 SHA-256，不把整段录音解码进内存。
- 输出先写 `.part`、同步文件描述符再改名。数据库完成失败会删除已生成文件；重试使用确定性的 `<meeting>/<clip>.wav`。
- MP3/M4A/视频没有伪装成本机可裁切；仍等待 RecordingAsset v2 服务提供异步导出。

## 入口与导出内容

- Marker 更多操作增加“生成音频片段”。
- 文字记录保留系统文字选择；选择操作栏增加“生成音频片段”，draft/realtime 段不开放。
- 编辑页在提交前明确显示范围、时长以及“包含讲话人/包含文字”，没有说明书式辅助文案。
- 会议更多动作中的“音频片段”列出 ready/failed 状态，支持来源定位、重试、系统分享和独立删除。
- 未选择讲话人/文字时直接分享 WAV；选择任一文字元数据时分享 WAV 与 `片段信息.txt` 的 ZIP，信息文件包含范围和用户选择的字段。

## 当前证据边界

- TypeScript、Kotlin 编译和 v23 SQLite 约束/Marker 解绑/会议级联窄合同属于本机源码证据。
- `[DEVICE]` `emulator-5556` 从 v22 覆盖升级到 v23 后，Marker 菜单、编辑页与片段列表可见；实际生成 `00:05–00:15` 的 10 秒 WAV。输出为 320044 字节，RIFF/data 长度、数据库 byte size 与完整 SHA-256 一致；来源定位回到文字记录并 seek。删除确认的跨 Modal 层级问题在该轮被发现并改为先退出 sheet 再展示确认框。
- 未部署异步导出服务；不得宣称 MP3/M4A/视频、账号同步或跨设备片段已完成。
