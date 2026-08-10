# 设备主模式可达入口审计（2026-08-10）

## 发现

上一轮已修复会议详情点击讲话人后的导航，但原生详情快照仍使用账号条件：

```ts
canManageSpeakers: Boolean(meeting && !isGuest && accessToken)
```

因此设备模式虽然能导航到本机讲话人页面，详情中的讲话人行仍可能被渲染为不可点击。这是一个用户可见的登录残留，不是服务器兼容接口问题。

同时，设备模式仍会根据通用 feature flag 打开“共享待办”能力。该功能是跨用户/跨设备协作，实际调用需要账号令牌；设备用户点击后只会得到“登录后才能共享待办事项”，属于错误的可达入口。

详情页的逐条讲话人修改还存在同类的“看得见但用不了”问题：无账号时不读取设备讲话人资料，`future_profile` 关联又被用例层拒绝。这样本机已采集的声纹不能用于当前会议的修正。

## 修复

- 会议详情的 `canManageSpeakers` 改为只要会议存在即可。`manageSpeaker` 回调继续按设备/账号选择对应服务，设备模式不上传姓名或账号凭据。
- `meetingActionCollaborationEnabled` 在设备模式要求同时存在账号模式和令牌；设备主模式不再显示共享待办入口，也不再进入只会失败的共享 sheet。账号兼容路径保留。
- 讲话人修改面板在设备模式读取 `fetchDeviceSpeakerProfiles`，账号模式仍读取账号资料。
- `future_profile` 关联只要求本机明确选择资料并勾选同意；设备模式将修正保存为本机 `local_only`，账号模式仍按原 outbox 同步。
- 静态门禁新增两条检查，防止未来重新把本机讲话人管理限制为登录，或重新暴露登录专属共享待办入口。

## 验证边界

- 这是入口可达性和状态快照修复，不宣称问答、真人声纹质量或真机验收完成。
- 按当前工作约定只使用 `emulator-5562` 做后续设备验证；不操作 `emulator-5560` 或 USB 真机。
- 本地 `APP_ENV=production-rehearsal` release 编译成功，候选包为 [`/home/yydd/LaoJi-stable-builds/laoji-v106-accountless-speaker-correction-20260810.apk`](/home/yydd/LaoJi-stable-builds/laoji-v106-accountless-speaker-correction-20260810.apk)，`versionName=1.0.6`、`versionCode=106`、SHA-256 为 `cceeb4723b10c6a008ec1df4e34d013fcea4ab8e09c734d3622cc9ab0bccc526`。`verify_compact_apk_config.py`、`verify_device_primary_source.py`、TypeScript 和 `git diff --check` 均通过；包未安装到任何设备。
