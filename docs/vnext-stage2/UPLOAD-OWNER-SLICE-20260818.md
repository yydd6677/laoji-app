# Stage 2 上传 owner 切片

状态：`implemented in isolated worktree; not activated`

本切片修复了设备 v2 R2 上传的一个 owner 缺口：原生 WorkManager 虽然使用稳定 operation ID，
但此前只把 operation ID 放在 JS pending registry，没有在本机 `device_operations` 中创建并和
`recording_assets.asset_generation` 建立外键式语义绑定。

现在的顺序是：

1. 设备 v2 R2 入队前确认本机 binding/epoch；
2. 在 SQLite `device_operations` 创建或幂等复用 `media.upload` operation；
3. 在同一本机数据库事务中将 operation 绑定到对应录音资产代际；
4. WorkManager 入队；成功回放时将 operation 单调推进到 `success`。

如果资产已经绑定其他 operation、epoch 或输入校验值不一致，入队直接失败关闭，不会静默覆盖。
旧 legacy/recording-assets-v2 路径没有被切换；服务端 barrier、真机回放和失败终态同步仍未完成。

## 证据

- `python3 tools/vnext/verify_stage2_android_contract.py`：通过（静态源合同）。
- `npm exec -- tsc --noEmit --pretty false`：通过。
- 未验证：Android 进程杀死/断网恢复、真实 R2、GPU、服务端公开周期和 capability barrier。
