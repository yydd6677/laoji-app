# Android v2 historical transcript polling fix (2026-08-19)

状态：隔离候选验证通过；未切换生产。

## 根因

`DeviceMeetingCompletionProvider` 在 guest 模式下把“没有本地转写任务且没有文字”当作待完成
转写。旧会议记录通常同时满足这两个条件，于是每轮都调用旧的
`GET /api/device/v1/meetings/{id}/transcript`。旧 device-v1 凭据已不再可用，因而出现重复的
`401 DEVICE_CREDENTIAL_INVALID`，并可能覆盖会议详情中的当前状态。

## 修复

远端补全轮询现在只由本机持久 `device_operations` 中的 pending transcript task 触发：

- v2 upload/import/realtime 在提交成功后登记 task，并通过订阅立即唤醒 provider；
- task 为 failure、success 或 cancelled 时不再轮询；
- 无 task 的历史本地会议不再回退到 v1 transcript endpoint；
- v2 task 的事件拉取、稳定/最终文字投影和 ACK 逻辑不变。

这不是通过吞掉 401 实现的，而是移除了错误的任务发现条件。新任务仍可在进程重启后由本机
持久 operation 恢复。

## 证据

- `npx tsc --noEmit --pretty false`：通过。
- 候选 release APK 重新构建成功：`./gradlew :app:assembleRelease --no-daemon`，版本
  `1.1.14 (122)`。
- APK 覆盖安装到 LaoJi 专属 `emulator-5562` 后，会议列表仍能打开，既有有声导入
  `laoji-vnext-speech-60s` 的文字记录可读，显示 19 个稳定片段及最终内容。
- 清空 logcat 后观察 20 秒，未出现 `device_v1_http_start`、`DEVICE_CREDENTIAL_INVALID`
  或旧 transcript 轮询；无 task 的历史记录不会再产生网络请求。
- 服务端候选 `v2-transcript-0f546f...` 仍为 `success`，17 个事件全部 ACK，说明该修复未
  改变 v2 结果投影。

生产 `18020/8030`、GPU1、PCB、公网入口及 `emulator-5560` 均未修改。
