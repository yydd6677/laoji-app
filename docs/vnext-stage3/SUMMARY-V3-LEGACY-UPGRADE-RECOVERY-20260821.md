# Stage 3 旧整理后台升级与跨进程恢复证据（隔离候选）

状态：`isolated candidate migration/recovery vertical passed; Stage 3 not adopted`。

本证据只关闭现有本机旧整理结果升级到 Facts V3 的 Android 纵向迁移与恢复缺口。候选 API 为
`127.0.0.1:18030`，设备只使用 `emulator-5562`；生产 `18020/8030`、公网、GPU1、PCB、
Smart Meeting 和其他用户服务均未修改或重启。

## 暴露并修复的真实故障

第一次回放使用 115 段的既有会议。后台升级已创建 Task 和 source stream，但客户端在发送第一个
source bundle 前失败，本机任务最终为 `failure/Error`，远端 Task 长期保持 `active` 且没有 Attempt。

根因不是会议长度或模型：旧 Android Transcript 的稳定 segment ID 可以接近 `source_id` 的 512 字符
上限，客户端原先又把完整 ID 拼进只允许 180 字符的 `item_id`，因此请求在本地 wire 校验阶段失败。
现在：

- `item_id` 是有界的 `类型 + ordinal/revision + 正文哈希前缀` 传输别名；
- 完整 Transcript/笔记/附件身份仍只保存在允许 512 字符的 `source_id`；
- 正文 SHA-256、来源 revision 和时间坐标保持不变，引用身份没有降级；
- 若本机保留的旧 Task 请求哈希与当前来源/传输 revision 不同，客户端只取消该确定性 Task，清空
  resume pointer，再从当前不可变来源创建新 Task；不会永久重试不可能成功的旧请求。

修复候选启动后，旧 Task
`vnext-summary:c94d724d-c4f4-4235-ada8-ee7a2f7de16e:69a00a5a35cdc191202817227840be08`
及其 source stream 被收敛为 `cancelled`，`cancel_revision=1`、Attempt 数为 0、checkpoint reservation
已释放。新 Task `...:be2665a1705fdbe6e3d7970ebc70635f` 只创建一次并成功；手机原子激活一个
Facts 文档和一个新 SummaryVersion，原版本仍可读，pending intent 为 0。

## 长会议进程中断恢复

第二轮使用另一条既有会议的 1,357 个稳定 Transcript segment。夹具先把原 15 份 Facts 和 summary
stage 复制进测试专用备份表，再从正式 Facts 表移除并登记一条真实 `pending` 升级任务；旧
SummaryVersion 和会议投影始终可读，业务表中没有影子会议或第二 owner。

客户端创建 Task
`vnext-summary:e2d63c79-6986-54fc-b044-185d0c5d9190:50067b5f17de2f85bbd5a5de8185ba0f`，
远端 Attempt 进入 `running/admitted` 后强制停止 App。服务端继续使用同一 Attempt 完成一次 Facts
生成；重新启动 App 后，客户端读取同一个 Task 和
`summary-stream:07a8a8f734f2683a6b3b7818efbb6156`，没有创建第二 Task/Attempt，并完成本机原子激活。

Release-target instrumentation 的结果：

- `testAuditSummaryV3UpgradeRecoveryFixture`：`OK (1 test)`；新版本数严格为 `原值 + 1`，原版本可读，
  当前指针指向新版本，Facts 与版本同事务关联，intent 为 0；
- `testRestoreSummaryV3UpgradeRecoveryFixture`：`OK (1 test)`；精确恢复原 15 份 Facts、15 个版本、
  current pointer、summary stage 和 `meeting.updated_at_ms`；
- `testAuditSummaryV3UpgradeState`：`pending/running/success/failure/eligible_missing/retry_exhausted` 均为
  0，`integrity_check=ok`、`foreign_key_check=0`；
- 测试 APK 和测试表均已删除，LatinIME 已恢复；主应用重新投影 7 条会议，仓储状态为 `consistent`，
  无崩溃。

## 回归与制品

- `npx tsc --noEmit`：通过。
- `verify_stage3_source_stream_contract.py`：通过。
- `verify_stage3_q2_android_contract.py`：通过。
- Summary V3、source stream、worker、device-v2 API、持久整理任务和旧版本读取聚焦回归：
  `107 passed`；仅有既有 asyncio/datetime deprecation 警告。
- `git diff --check`：通过。
- Release 候选：`1.1.41 (149)`，大小 `82,614,295` bytes，SHA-256
  `610017e03b725445894d83d5c63d3ea67ba401b7f590c1087b7dfd8589c4d0b3`，APK v2 签名验证通过。
- Release-target androidTest APK：`375,063` bytes，SHA-256
  `73875e474a1ca516dd0847b6738b3fbf6fe1248a7f813a0d68ec9ae4d8ab33e0`；验收后已从模拟器卸载。

## 尚未关闭的 Stage 3 门

该回放关闭旧结果后台升级的客户端提交、运行中进程死亡、完成结果恢复、单版本激活和精确回滚边界，
但不是生产采用证明。更新样本上的独立人工 Facts/行动/Q2 质量 `>=95%`、公开零旧链路周期和
capability barrier 仍未完成；因此 Stage 3、Stage 5 和生产切换继续关闭。
