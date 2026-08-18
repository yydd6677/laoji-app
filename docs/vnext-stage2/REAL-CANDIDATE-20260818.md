# Stage 2 隔离真实候选证据

状态：候选功能链路通过，Stage 2 仍未退出。生产 8030/18020、systemd、公网、APK、设备、GPU1、
PCB 和其他服务均未修改。

## 候选拓扑

- 服务器独立目录：`$SERVER_HOME/laoji-vnext-candidate`。
- ASR：`127.0.0.1:8031`，Qwen3-ASR-1.7B，revision
  `7278e1e70fe206f11671096ffdd38061171dd6e5`，强制 CPU。
- API：`127.0.0.1:18021`，独立 SQLite、音频目录和日志；R2、Silero VAD、中文 CAM++、任务 worker
  均在 `/api/ready` 报告 ready。
- R2：生产 bucket 的 `transient/` 隔离随机对象；所有探针对象最终删除，没有把凭据写入源码、
  报告或日志。

## 真实 v2 ASR 回放

样本 `39799065_da2-1-16.mp4`，媒体时长 360.107 秒：

- 8 秒单段：HTTP `/v2/asr/batch` 返回稳定 key/revision/source range，推理 10.370 秒。
- 完整回放：26 个 14 秒以内 item，首批 35.418 秒，总墙钟 118.940 秒，RTF 0.3303；26 个
  item 全部合同合法且 source range 连续覆盖至 360107ms。
- 上述为 CPU 候选合同与吞吐证据，不是生产首段预算证明。

回放工具为 `tools/vnext/replay_asr_v2.py`；默认报告不保存逐段正文，只有显式
`--include-items` 才保存 item。

## 设备 v2、R2 与文字事件

完整设备探针经过 P-256 注册、binding fence、预签名 PUT、verified asset、唯一 transcript Task、
R2 range decode、VAD、ASR v2、事件轮询、ACK 和清理：

- 源文件 19,188,136 字节，source SHA-256
  `085afae46e8b163df72230e97b3f1c1663a9b0b3516f7ecfb9d4ff9218e01999`。
- single PUT 完成后产生 115 个 stable event 和 1 个 final event；模型 revision 全程一致。
- 设备 ACK 到 sequence 116；总墙钟 335.148 秒。
- R2 另完成一次 29 字节 PUT/HEAD/GET/DELETE 探针，内容一致且最终 HEAD 不存在。
- ACK/purge 后的对象清理遵守最后一个预签名 URL 的 `not_before_epoch`；隔离时钟推进至到期点后，
  obligation 为 `confirmed`，upload session 为 `cancelled/consumed`。

脱敏报告见：

- `device-v2-r2-transcript-probe-39799065.json`
- `tools/vnext/probe_device_v2_upload.py`

## 尾索引媒体回归

初版通过 `ffmpeg -i pipe:0` 解码 R2 对象。尾部保存 `moov` 的 MP4/M4A 需要回跳，非 seekable
stdin 会产生零 PCM 且 ffmpeg 仍可能返回 0，导致有声媒体被误判 `no_content`：

- 30 秒 M4A：0 stable，4.655 秒错误结束为 no-content。
- 60 秒 MP4：0 stable，5.504 秒错误结束为 no-content。

生产路径已改为短期预签名 GET，让 ffmpeg 通过 HTTP Range 随机读取；不创建整份临时 WAV，
stderr 只取哈希且不记录签名 URL。合成测试仍可注入 bounded stdin。修复后同一 60 秒 MP4 产生
19 个 stable + 1 个 final，墙钟 68.882 秒。

前后报告：

- `device-v2-api-restart-probe-30s.json`
- `device-v2-api-restart-probe-60s.json`
- `device-v2-api-restart-recovered-60s.json`

## API 中断恢复

对完整 360 秒任务，在 run=`running` 且 event sequence=0 时终止候选 18021，再以同一 SQLite
重启：

- attempt 1 终态为 `lease_expired`；attempt 2 接管后为 `succeeded`。
- 同一业务 task 始终只有一行；task ID、binding generation、asset generation 和 source SHA 未变。
- 恢复后事件从 sequence 1 单调推进，最终仍为 115 stable + 1 final，没有第二个 final 或重复业务
  task。
- ACK 前 event 数为 116；ACK 后密文事件删除；两条到期 cleanup obligation 执行成功。
- 探针自身也已补充 `ConnectionResetError/OSError` 容错，API 短时不可达时继续轮询。

## ASR 推理中断恢复

在同一隔离 SQLite 和同一业务源上，ASR 8031 在离线推理中被强制终止一次，随后使用相同
固定 model revision `7278e1e70fe206f11671096ffdd38061171dd6e5` 重启。任务没有新建第二个
业务身份：第一次 attempt 记录 `TRANSCRIPT_CONNECTIONRESETERROR`，第二次在 ASR 尚未恢复时
记录 `TRANSCRIPT_URLERROR`，持久退避后第三次接管并成功完成。最终结果仍为 115 个 stable、
1 个 final，事件序列单调，ACK 成功。脱敏报告为
`device-v2-asr-interrupt-recovery-360s.json`。

这次验证同时修复了一个真实恢复缺口：8031 没有固定 revision 时此前仍会返回 ready，API
却会拒绝 `unresolved` 结果。候选 ASR 现在在 revision 未固定时拒绝启动，并在 `/ready` 报告
`not_ready`；部署模板明确要求填写固定 `QWEN_ASR_MODEL_REVISION`。

## 双上传与 realtime 优先级

同一设备同时 PUT 两个 3,174,969 字节的 60 秒 MP4，并各自提交一个 transcript Task：

- 两个真实 R2 PUT 墙钟分别为 2.204 秒和 2.077 秒。
- 两个 transcript 均为 `succeeded`，各产生 19 stable + 1 final；2 个 transcript Task 和
  2 个 `speaker.overlay.v2` Task 身份独立，无 binding/source 覆盖。
- 第一条 stable 后插入 8 秒 realtime 请求。ASR 日志顺序为 offline -> realtime -> offline，证明
  realtime 在当前不可抢占推理完成后先于后续离线批次运行。
- CPU 候选 realtime 墙钟 16.224 秒，其中 queue 9.074 秒、infer 7.137 秒；功能优先级通过，
  但它不满足生产 GPU 的 2 秒体验预算。
- 两份事件均 ACK，2 条对象清理义务执行成功。

脱敏报告和工具为 `stage2-concurrency.json`、`tools/vnext/probe_stage2_concurrency.py`。

## 1 GiB 上传内存上界

候选中使用 1 GiB 稀疏 WAV 走完整 128 片 multipart/R2 上传，session 最终为 `verified`，并创建
唯一 verified asset。API RSS 采样为 1,160,804--1,174,780 KiB，峰值增量 13.65 MiB；未生成
整份本地副本。该文件的尾部补零会让 ffmpeg 继续读取完整对象，无法代表真实长媒体，因此在
转写阶段主动取消并清理。脱敏结果见 `device-v2-r2-1g-memory.json`。这只关闭上传内存上界
疑问，未关闭完整 1 GiB 媒体转写门。

随后用合法 MP4 `free` padding atom 重跑同样的 1 GiB 链路：128 片上传、Range 解码和
`no_content` 成功终态均完成，产生 1 个 final 事件，ACK/purge confirmed。API RSS 峰值增量
为 4.29 MiB；详见 `device-v2-r2-1g-valid.json`。因此 1 GiB 完整媒体门现已关闭，前一份
WAV 只作为失败形态和内存上界的对照记录。

## 资源快照

完成完整回放后的 CPU 候选快照：

- ASR RSS：5,946,296 KiB；API RSS：1,155,844 KiB。
- 两进程合计约 6.77 GiB；API 单进程约 1.10 GiB，候选目录 28 MiB。
- 未产生完整 WAV 或媒体临时副本。
- 该快照不含共用的生产 Ollama runner，因此不能宣称完整 `<=8 GiB` 总 RSS 门通过。

## 尚未通过

1. Android WorkManager 网络中断和进程死亡恢复（源码合同已加强，但仍缺专属设备运行回放）。
2. GPU 候选首段/RTF、讲话人真实命名/未知拒识、真机/模拟器和 APK；CPU realtime 延迟不达标。
3. 旧 upload/ASR submit 连续一个完整公开周期为零，以及随后人工激活 capability barrier。

## 候选健康复核（2026-08-18）

- 隔离 API `18021` 曾出现端口监听但 HTTP 空回复，导入维护线程连续记录 `OperationalError`；这些只
  影响候选进程，不影响生产 `18020/8030`。只重启该隔离进程后，`/api/ready` 恢复 `ready=true`。
- 最新 ready 快照确认固定 ASR revision `7278e1e70fe206f11671096ffdd38061171dd6e5`、Qwen 9B、
  0.6B embedding、Silero VAD、CAM++、任务队列/lease、三库 WAL/完整性、R2 配置和 `467.899 GiB`
  磁盘余量均正常；ASR 8031 队列为空。生产服务、GPU1、PCB 和 Smart Meeting 未重启或修改。
- 该复核只证明隔离进程可恢复，不改变公开流量、systemd、APK 或生产服务；候选启动模板仍是下一次
  部署的唯一配置来源，手工命令不作为生产发布合同。

因此 Stage 2 保持 `in progress`，不得切生产入口或开始 Stage 3 默认采用。

## 晚间只读复核（2026-08-18）

此前通过 SSH 只读检查隔离端口：`8031` 与 `18021` 监听 loopback，旧候选两个 `/ready` 均为
`ready=true`。8031 固定 revision、CPU、队列为空；旧 18021 的模型列表、VAD、CAM++、任务 worker、
三库 WAL/完整性、R2 和磁盘余量均报告 ready，候选磁盘余量约 `467.17 GiB`。生产 `8030/18020`、
GPU1、PCB 和 Smart Meeting 未重启或修改。随后 readiness 修复候选按本节结果将 embedding 真实
推理失败正确报告为 not ready。

为取得 GPU 性能证据，临时在 GPU0 端口 `8032` 启动同 revision 的 ASR 进程并完成真实 1/2/4/8 秒
`/v2/asr/batch` 请求；随后停止该进程，端口关闭且 GPU0 显存恢复。结果与资源边界见
[GPU ASR candidate](GPU-ASR-CANDIDATE-20260818.md)。这不是常驻部署，也没有改变 8030 的公开入口。

## readiness 修复候选部署（2026-08-18）

- 将服务端候选包 `49b1acf` 解压到隔离版本目录，并只重启候选 API `127.0.0.1:18021`；旧
  `api-root` 保留为回滚目录，未重启生产 `18020`、ASR `8030/8031`、Ollama 或任何 GPU1/PCB
  进程。
- 新候选启动后真实 `/api/ready` 返回：`ready=false`、`generation_ready=true`、
  `embedding_ready=false`、`embedding_probe_error=embedding_probe_timeout`，探针耗时约 5 秒；
  任务队列 `queued=0/running=0`。
- 这证明 ready 现在检查真实 embedding 推理，而不是只检查 `/api/tags` 中的模型名字。候选没有
  接受业务流量，也没有激活任何 vNext capability barrier。
- 若需要回滚，停止 `49b1acf` 并从保留的旧 `api-root` 使用同一运行环境启动即可；本次切换未修改
  候选数据库和音频目录。

随后将仅修正文案的 `471d94f` 部署到新的隔离版本目录，`18021` 当前 cwd 为
`releases/471d94f/services/laoji-api`，旧 `49b1acf` 仍保留可回滚。真实 readiness 仍为
`ready=false`、`embedding_ready=false`、`embedding_probe_timeout`；这次部署没有改变阻断状态，
也没有接收业务流量。

## 2026-08-19 ASR 静音候选与 API 同步部署

- 真实重放发现旧 8031 对一秒全零 PCM 返回“嗯。”，因此 `0eae538` 在 ASR coordinator 增加
  RMS/峰值双门，静音不进入 Qwen，v2 返回 `no_speech`。
- `0eae538` 服务包已解压到隔离版本目录；8031 和 18021 均从该目录运行。API 使用候选 SQLite、
  CPU VAD/CAM++ 以及显式现有 CAM++ 权重路径，`/api/ready` 与 `/ready` 均返回 ready，队列为空。
- 相同全零 PCM 在 8031 返回 HTTP 200、`outcome=no_speech`、空文本、`text_state=stable`、
  `segment_revision=1`、`infer_ms=0`。生产 18020/8030 未重启或改动，GPU1、PCB、Smart Meeting
  和公网入口未触碰；旧 471d94f 目录保留用于隔离回滚。
- 这只闭合候选 ASR 静音合同；专属 Android 无语音/断网/杀进程回放、资源门和 capability barrier
  仍未通过，Stage 2 继续保持 `in progress`。
