# Stage 2 Android v2 网络与进程恢复回放

状态：`candidate Android/runtime evidence; historical runtime/resource subset 19/20; quality-aware Stage 2 exit still open; not adopted`。

## 隔离边界

- Android：专属 `emulator-5562`，候选 `1.1.42 (150)`；已安装 APK SHA-256
  `56e1340ee464d571fc84df180d44b675e46fd553844fc05646b2de94472f7304`。
- API：隔离 `127.0.0.1:18031`，使用生产候选数据库的 SQLite backup 副本，未连接生产数据库。
- ASR：隔离兼容入口 `127.0.0.1:8031`，Qwen3-ASR-1.7B，`cuda:0`。
- media upload capability barrier 仅登记在隔离数据库副本；`18020/8030`、公网、GPU1、PCB、
  Smart Meeting 和 `emulator-5560` 均未修改。

## 网络中断与进程死亡

使用真实视频样本，经手机端先提取为 `3,021,419` 字节 M4A 后进入原生 WorkManager v2 上传。
在 logcat 确认 `MeetingUploadWorker` 已开始后撤除 `adb reverse`，使活跃上传失去网络；界面保持
“等待上传录音”，未伪装为完成。随后 force-stop 应用，恢复 reverse 并重新启动。

恢复后 30 秒内满足：

- 本机持久队列只处理一条待上传记录，最终 `uploaded=1, failed=0`；
- 服务端只有一个 upload session、一个 transcript task 和一次 succeeded attempt；
- transcript task 为 `success`、`outcome=text`，形成 `115` 个本机最终片段；
- 服务端产生 `116` 个事件（115 stable + 1 final），手机投影并 ACK 后事件载荷清零；
- 本机只有一个 active ready transcript revision，稳定片段键为空或重复的数量均为 0；
- 未知讲话人保持匿名，异步 speaker overlay task 独立成功。

本轮媒体内容 SHA-256 为
`39277804a20358e60da74fd1d06243747b7802769873391e821090134cc427af`；文档只记录哈希、字节数、
状态和计数，不记录正文、标题、人物或对象 key。

## NO_SPEECH 成功结果

另导入 3 秒静音 M4A（1,207 字节，SHA-256
`5be19ebe48ca48da4cbd1eac5924bb9ae4a33ce21799987aee406349e681c6c8`），通过同一原生 v2
WorkManager 链路完成：

- 一个 upload session、一个 transcript task、一次 succeeded attempt；
- task 为 `success`、`outcome=no_speech`、最终事件数 1；
- 手机状态为 `no_speech`，`error_code` 为空、`retryable=0`、片段数 0；
- 页面显示“未检测到人声”，不显示处理失败。

这里的空 `error_code` 是合同要求：`NO_SPEECH` 是成功内容结果，而不是可重试或永久错误。

## 数据库和资源收尾

- 两条新任务完成后，所有事件均已由客户端 ACK 并 purge；
- 三条候选测试 cleanup obligation 按正常 worker 逻辑处理，`confirmed=14`、未确认数 0；
- active upload session 0、active transcript task 0；
- SQLite backup integrity `ok`、foreign-key violations 0；
- 审计快照 SHA-256：
  `0ca4f94c917df09a80686b885536dd1efa6f3ff5823457750ce4dc9c1d8875de`。

只读 Android instrumentation `VnextStage2RuntimeAuditTest` 同时检查 owner、generation、远端 revision、
WorkManager executor、active revision、稳定片段键、NO_SPEECH 和 SQLite 完整性，结果 `2 tests, 0 failures`。

## Stage 2 退出门

将本轮 Android 证据与先前 10 分钟全局混合负载、30 条真实媒体回放、1 GiB R2 内存回放合并后，
`verify_stage2_exit_preflight.py` 的 20 个门中 19 个通过。性能和资源实测仍为：

- realtime stable p95 `1,844.9 ms`；
- import first stable p95 `3,291.1 ms`；
- import RTF p95 `0.128744`；
- API RSS 峰值 `1,179,660 KiB`，上传增量峰值 `13.65 MiB`；
- 老记进程总 RSS 峰值 `5.292 GiB`、CPU p95 `5.801` 核；
- GPU0 最低空闲 `2,110 MiB`、临时盘峰值 `0 GiB`。

唯一仍阻断的门是 `legacy_submit_zero_public_cycle`：尚未取得外部公开周期的旧 submit 零流量记录。
因此 Stage 2 的候选实现和隔离运行证据已闭合，但 capability 尚不能正式采用，旧链路也不能删除。

机器可读输入与结论：

- `stage2-exit-evidence-20260821.json`
- `stage2-exit-preflight-20260821.json`
