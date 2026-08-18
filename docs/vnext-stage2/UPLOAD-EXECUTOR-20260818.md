# Stage 2 上传执行句柄切片

状态：`implemented in isolated worktree; not activated`

迁移 `0046DeviceUploadExecutor` 为 `device_operations` 增加：

- `executor_kind`：当前白名单只有 `workmanager`；
- `executor_id`：原生 WorkManager 的真实 work UUID；
- executor 唯一索引和待上传 operation 查询索引。

设备 v2 R2 入队顺序现在是：本机 binding/epoch -> `media.upload` operation ->
`recording_assets.upload_operation_id` 绑定 -> WorkManager 入队 -> 保存真实 workId。guest/device 的
`listPendingMeetingAudioUploads` 优先从 `device_operations + recording_assets` 重建，旧 AsyncStorage
registry 仅作为未迁移记录的兼容补集。

回滚边界：0046 只新增列和索引，不删除旧 registry；关闭 canonical read 后仍可使用旧路径。终态
operation 不重开，同一资产代际不会因旧 workId 丢失而生成第二个业务 operation。

证据：

- `python3 tools/vnext/verify_stage2_migrations.py`：通过，包含 0046 列、索引、句柄持久化和迁移重放；
- `python3 tools/vnext/verify_stage2_android_contract.py`：通过；
- `npm exec -- tsc --noEmit --pretty false`：通过。

未验证：Android WorkManager 真实进程死亡/断网回放、旧版本升级到 0046 的真实 APK 迁移、服务端
capability barrier 和公开周期。
