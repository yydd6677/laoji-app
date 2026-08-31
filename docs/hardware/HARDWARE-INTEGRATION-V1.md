# 老记外接录音设备实施基线

状态：`test-board local storage + USB/BLE live + Wi-Fi bulk implemented`

## 当前垂直链

```text
ESP32-S3 microphone
  -> MicroSD crash-recoverable WAV (device owner)
  -> optional USB/BLE live PCM mirror

phone connects by USB or BLE
  -> LJHW/1 hello/status/list/manage
  -> selected recording authorizes temporary Wi-Fi AP
  -> Range download + generation/WAV/SHA verification
  -> app-private atomic pending WAV
  -> existing MeetingMediaImportProvider
  -> RecordingAsset -> upload -> ASR -> summary/Q2
```

外接设备没有自己的会议表、同步表或云端任务链。手机接收完成后的录音继续复用当前会议媒体入口。

## 已实现

1. 固件将 SD 本地文件作为录音 owner；手机连接只决定是否同步镜像实时 PCM，断开不停止板端录音。
2. S2：空闲长按 2 秒开始，录音时短按暂停/继续，长按 2 秒结束；测试板不伪装物理关机。
3. WAV `.part` 检查点、正常原子封口、启动恢复、PCM payload SHA-256、稳定 generation 和分页 manifest。
4. 设备文件可列出、重命名标题、标记已接收、按 generation 删除；接收不隐式删除。
5. 测试板临时 WPA2 AP、随机密码和 bearer、单对象 HTTP、ETag 与 Range；录音时拒绝 bulk。
6. Android 原生 `HardwareRuntime` 仍是唯一状态 owner，新增暂停/继续、设备文件列表、管理和 Wi-Fi 接收。
7. Android 下载使用 `WifiNetworkSpecifier` 与指定 `Network`，不把临时热点设为进程全局网络；测试明文 HTTP
   仅能进入已识别测试 profile 的 raw-socket adapter，不能放宽应用全局 cleartext 策略。
8. 下载使用确定性本机 ID 与 `.part`，验证 generation、ETag、Content-Range、长度、WAV 头和 SHA 后原子提交；
   随后尽力 ack。中断保留可续传片段，不产生半成品会议录音。
9. 界面分开显示“设备中的录音”和“待加入会议的录音”；设备项提供接收、重命名、删除，实时镜像仍直接进入
   待加入会议区。

## 测试板真实边界

- 主板 `PD-AILAMP-D01`，ESP32-S3-WROOM-1 rev 0.2；不是正式 PCB。
- 麦克风 `WS=GPIO9`、`SCK=GPIO10`、`SD=GPIO11`。
- MicroSD `CS=GPIO5`、`MOSI=GPIO6`、`CLK=GPIO7`、`MISO=GPIO15`，4 MHz。
- S1 是复位；S2 是 GPIO0 启动绑带键。开机/复位时按住可能进入下载模式。
- 当前没有已确认的电源锁存、可控 LED、电池计量或安全芯片。
- 测试 profile 为 PCM WAV 与 `development_http`。正式产品不可照搬其功耗、容量和安全模式。

## 正式硬件适配点

正式硬件沿用 LJHW/1 capability，不要求 App 按型号分支：

- 使用随机稳定设备身份、BLE LE Secure Connections、物理配对确认与可撤销信任；
- 大文件使用 `tls_pinned`，证书 pin 和临时热点凭据只经已加密控制面交付；
- 可声明 Opus、本地索引数据库、电池/容量、普通 GPIO 录音键和独立电源控制；
- 保留 generation、Range、hash、ack 与显式 delete 语义；
- 掉电恢复不得覆盖已有可用对象，存储满时停止新录音但保留旧文件；
- Wi-Fi、BLE 和 USB 继续共享一个控制 owner，不能复制会议导入或持久任务状态机。

Android 中 `tls_pinned` 已保留协议分支但会失败关闭；正式样机到位后实现证书 pin adapter，而不是让正式设备
落入测试明文放行。

## 仍需用户参与的实物验收

- 直接用 S2 完成一次长按开始、短按暂停/继续、长按结束；
- 在手机通过 BLE 连接时用 S2 开始，确认实时镜像与 SD 完整文件同时存在；
- 录制中物理断开 BLE，确认板端继续并可稍后接收完整文件；
- 录制中按 S1 复位，确认 `.part` 被恢复并标记；
- 真机首次接收时确认 Android 临时 Wi-Fi 系统授权。

以上需要物理按键或系统授权，自动探针不能代替。USB 控制、SD/WAV、文件管理、完整与 Range Wi-Fi 下载已由
自动化真板探针验证。
