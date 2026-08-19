# Stage 3 Facts V3 进程恢复与单任务证据（隔离候选）

## 结论

Facts V3 的本机恢复身份已从包含模板、标题和日期的旧整理指纹，收敛为只包含转写、当前笔记和本次
授权附件的来源指纹。模板只是同一事实文档的本地投影；切换模板或页面重建不再清除正在运行的远端
任务，也不会为同一代来源创建第二个模型任务。后台旧结果升级在前台整理开始后立即让出，并在事实
文档已经落地时直接结清队列项。

状态仍为 `isolated candidate evidence; not adopted`。本轮没有激活 capability barrier，没有修改生产
`18020/8030`、GPU1、PCB、Smart Meeting、真机或公网流量。

## 修复前根因

修复前，服务端 Facts V3 的任务输入不含模板，但 Android 的 pending-task 恢复指纹仍使用旧 v2
整理身份，其中含模板、标题和日期。应用被强制停止后，模板投影或页面状态恢复可能使本机判定 pending
任务不匹配，清除原 task ID，再以相同来源提交确定性任务。隔离数据库留下了两个输入 SHA-256 完全
相同的历史任务：随机 generation `1ce2db…` 和确定性 generation `40c928…`。两者都成功，说明数据
激活围栏阻止了损坏，但重复消耗了一次完整模型生成。

## 实现边界

- `meetingSummaryFactsInputFingerprint` 只覆盖转写稳定 ID、正文、起止位置、讲话人标签，当前笔记
  revision/正文，以及授权附件的 ID、revision、位置、类型和内容哈希；不包含模板投影。
- Facts V3 pending task 必须是当前会议槽位内、以 `vnext-summary:` 开头的 durable task，恢复时保留
  原 task ID；服务端仍用完整来源 SHA-256 和 binding/task fence 拒绝跨来源或跨会议误接续。
- 前台整理从准备到本地激活持有 interactive-work guard；后台迁移在真正发起远端生成前再次检查该
  guard，并在当前会议已有不可变事实文档时把 pending/failure upgrade row 原子结清为 success。
- 本机激活仍重新计算来源指纹并核对 active transcript 和 manual-note revision；来源变化只丢弃迟到
  结果，上一份可用整理保持可读。

## 真实 Android 进程中断回放

夹具为专用 `emulator-5562` 上的 `vNext 验收夹具·股权会议（SRT参考）`，包含 1,357 个稳定转写
片段。候选通过隔离 API `127.0.0.1:18023` 和隔离 CPU ASR `127.0.0.1:8031` 运行。

1. 点击“重新整理”后，手机持久化任务
   `vnext-summary:e2d63c79-6986-54fc-b044-185d0c5d9190:be9803088c1a75b27dd49e524233279f`。
2. 在 task status 已落盘、模型尚未完成时强制停止 App，再冷启动。
3. 重启后页面继续轮询完全相同的 task ID，上一份可用结果继续显示，状态为“正在整理会议记录”；
   没有创建确定性替代任务。
4. 该任务只存在 1 个 attempt，创建于 `2026-08-19T21:01:26.733240Z`，终止于
   `2026-08-19T21:03:05.706691Z`，最终为 success。服务端该会议的 summary task 总数只从 6 增到
   7；相同来源 SHA-256 的历史计数只增加这 1 条。
5. 完成后 Android 版本历史只新增一个当前版本，重新整理按钮恢复可用；无 SQLite、React 或未处理
   异常。模板切换仍不产生网络请求。

## 构建、回归与未通过指标

- 候选版本：`1.1.28 (136)`，APK SHA-256
  `3a4557aa98de1ce59d7e57ba4d6187b3b240a2ef1b0e616245cba43b094b66ed`；仅用于隔离候选验证。
- TypeScript、Stage 3 source-stream/Q2 Android 静态合同和 `git diff --check` 通过。
- Facts V3、chapter merge、source stream、Task lifecycle、summary worker 和 Q2 reader 聚焦回归：
  `118 passed`。
- 本次任务从创建到终止耗时约 `98.97s`，attempt 耗时约 `96.32s`。单次样本不能代表 p95，但它已
  超出证据包路径 p95 `<=90s` 的退出目标，因此是非通过证据，不得据此宣称 Stage 3 延迟达标。

## 尚未满足的 Stage 3 退出门

- 仍需补齐转写变化、附件授权/版本变化和提交/本地激活中断的组合恢复矩阵。
- 更新会议样本的独立人工盲审尚未证明事实支持率、行动质量和 Q2 回答/引用相关性达到 95%。
- 长会生成延迟仍需定位并形成足够样本分布；当前真实回放已出现超过 90 秒的任务。
- 旧结果后台迁移的全量恢复、公开零 v1 流量周期和 capability barrier 均未完成。
- Stage 2 纯 CPU ASR 的首段和 RTF 性能门仍未通过，因此全局候选不能采用。
