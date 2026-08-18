# Stage 2 上传成功回放顺序

状态：`implemented in isolated worktree; not activated`

本切片闭合了设备 v2 R2 上传在进程退出窗口中的恢复缺口。WorkManager 返回
`succeeded/uploaded` 时，JS 不再直接把 `device_operations` 推进为 `success`，而是先：

1. 校验远端资产 ID、远端 revision、资产代际和本机会议仍处于可写状态；
2. 在 SQLite canonical `recording_assets` 写入远端身份，并补齐转写来源关联；
3. 提升 canonical revision，清理兼容 AsyncStorage 资产条目；
4. 最后才将同一 `media.upload` operation CAS 推进为 `success`，并保存转写任务提示。

如果进程在第 2 步之后、第 4 步之前退出，下一次恢复仍会读取“资产已有远端身份但
operation 尚未终态”的 operation，完成最后一步；不会重新上传或生成第二个 operation。
如果 operation 已 `cancelled`，或已 `success` 且 canonical 资产已有远端身份，旧 registry 会被
终态资产代际过滤，不能重新提交；旧版本遗留的“success 但无远端身份”记录不会被吞掉，仍保留
兼容恢复入口。
缺少远端身份时保持非终态并记录脱敏诊断，不伪造成功。

证据：

- `python3 tools/vnext/verify_stage2_migrations.py`：通过，包含两阶段退出窗口回放；
- `python3 tools/vnext/verify_stage2_android_contract.py`：通过，包含 canonical-before-success 静态门；
- `npm exec -- tsc --noEmit --pretty false`：通过。

未验证：真实 Android WorkManager 杀进程/断网、真实设备 APK 迁移、服务端 capability barrier、
公开周期和 Stage 2 exit gate。此切片不启用生产 capability，也不删除旧上传链路。
