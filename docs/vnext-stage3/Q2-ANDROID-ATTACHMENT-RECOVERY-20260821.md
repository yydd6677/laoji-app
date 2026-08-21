# Stage 3 Android Q2 附件来源与跨快照恢复证据（隔离候选）

状态：`isolated candidate vertical slice passed; Stage 3 not adopted`。

本证据只覆盖 Q2 的当前笔记/显式附件来源、同一远端 Task 恢复及附件变化后的失败关闭。候选 API 为
`127.0.0.1:18030`，设备仅使用 `emulator-5562`；生产 `18020/8030`、GPU1、PCB、Smart Meeting 和
其他用户服务均未修改或重启。

## 实现边界

- 旧 Q1 仓储拒绝写入附件引用，避免新来源类型穿透旧表和旧 wire history。
- Q2 仅接受本次显式选择的文字附件；来源进入 immutable snapshot 和 source stream，显示引用可回到
  `附件 · mm:ss`。未选附件不进入请求。
- turn 持久保存设备 epoch、会议 binding、笔记 revision 和附件选择哈希；最终回答写入前在同一个本地
  SQLite 事务中重新核对 transcript、笔记、附件 active revision、immutable 正文及正文 SHA-256。
- 会议问答打开时先收敛该会议所有 `queued/running` Q2 操作，再选择当前来源指纹的 thread。来源变化
  后不可达的旧 thread 会成为 `failure/Q2_EVIDENCE_CHANGED`，不会永久悬挂为 running，也不会把旧回答
  投影到当前会话；若远端 Task 仍 active，会先尽力调用同一 device-v2 cancel 接口清理 Task/source stream。
- source stream 的网络、408、429 和 5xx 保留同一 Task 供恢复；确定性 4xx/校验失败才终止，不建立第二
  个隐式 owner。

## 正向回放

在股权会议 SRT 夹具上创建文字附件并显式勾选，问题“附件中要求最终结果不能覆盖什么？”得到一条附件
依据回答。页面展开引用后显示附件来源和逐字正文。强制停止并重新打开应用后，答案从本机 SQLite 恢复，
候选服务器仍只有一条 Task、一次 Attempt，没有重复 reader 调用。

## 负向时序

1. 创建唯一 Q2 问题并绑定确定性 Task；先停止客户端，确认远端尚无 Attempt。
2. 恢复附件正文并重新进入同一 pending turn，远端出现第 1 次 Attempt，状态为 `running/admitted`。
3. Attempt 出现后约 0.06 秒强制停止客户端，并通过独立 androidTest APK 修改附件可见正文；immutable
   revision 保持原值，用于模拟聚合正文与不可变来源分叉。
4. 远端 Task 在约 7 秒内成功，返回一条严格附件引用；没有创建第二条 Task 或第二次 Attempt。
5. 安装带修复的 release 候选并重新进入会议问答。会议级 pending scan 将旧操作收敛为
   `failure/Q2_EVIDENCE_CHANGED`；对应 turn 的 `answer/completed_at` 均为空，本地 clause/citation 为 0。
6. instrumentation `testQ2ChangedAttachmentResultRejected` 断言上述状态、零 clause 和数据库完整性；随后
   `testRestoreChangedAttachmentContent` 安全恢复附件正文，两项均为 `OK (1 test)`。

## 回归与制品

- `npx tsc --noEmit`：通过。
- `verify_stage3_source_stream_contract.py`：通过。
- `verify_stage3_q2_android_contract.py`：通过。
- compact Python 3.12 环境中的 Q2 reader、Task recovery、source stream 和 device-v2 API：
  `90 passed`；pytest 配置只有一条不影响结果的 `asyncio_mode` 未识别警告。
- `git diff --check`：通过。
- 候选 APK：`1.1.38 (146)`，SHA-256
  `20f13b59c1d1d188904e2e840fd1773ac0b4a795939a25327665257a5e12cdc9`。
- androidTest APK SHA-256：
  `da0d809d149eb951990e64b57c7878dffd6cf7127427410282a1d2f32f984a56`。

## 仍未关闭的 Stage 3 门

该切片没有证明 Stage 3 已退出。更新样本的独立人工事实支持率、行动质量、Q2 回答与引用相关性
`>=95%`，完整 Android 来源恢复矩阵、capability barrier、旧结果迁移和公开零旧链路周期仍需单独完成。
