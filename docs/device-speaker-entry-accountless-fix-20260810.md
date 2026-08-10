# 讲话人入口去账号阻断修复（2026-08-10）

## 发现

服务层已经有完整的设备/epoch 讲话人能力：`fetchDeviceSpeakerProfiles`、`registerDeviceSpeaker`、`supplementDeviceSpeaker`、`renameDeviceSpeaker` 和删除 outbox 都在无账号模式下工作；`SpeakerManagerScreen` 与 `SpeakerEnrollmentScreen` 也会根据 guest/device 状态选择设备服务。但会议详情的 `manageSpeaker` 入口仍弹出“登录后管理讲话人”，使已实现的设备声纹功能无法从实际会议页面进入。

## 修复

- 无账号且点击已知讲话人：直接打开本机 `SpeakerEnrollment` 详情，可补录、改名或删除。
- 无账号且点击未知讲话人/管理入口：直接打开本机 `SpeakerManager`。
- 保留账号模式原有账号讲话人入口和兼容 API；没有改变姓名映射、匿名 profile、音频临时上传或删除 outbox 的数据边界。
- `verify_device_primary_source.py` 新增静态门禁，禁止回归到“登录后管理讲话人”并要求两个设备入口存在。

## 验证

```text
python3 tools/verify_device_primary_source.py                  PASS
npx tsc --noEmit                                               PASS
git diff --check                                                PASS
python3 tools/verify_compact_apk_config.py android/...apk     PASS
```

使用服务器受保护环境临时注入设备引导密钥后，release 构建成功：

- APK：`/home/yydd/LaoJi-stable-builds/laoji-v106-device-speaker-entry-20260810.apk`
- `versionName=1.0.6`，`versionCode=106`
- SHA-256：`e164815ce15bf24c947029856d9623e7408f2f517026556fb287ed4822934e37`

公网设备服务烟测（临时设备、无账号）：注册 `201`、读取 `/api/device/v1/speakers` `200`（当前资料数 `0`）、读取能力 `200`、关闭 epoch `200`；临时设备没有留下会议、资产或声纹资料。

本轮没有安装到 `emulator-5560` 或 USB 真机；老记专用 `emulator-5562` 当前离线，功能仍需要后续设备验收。
