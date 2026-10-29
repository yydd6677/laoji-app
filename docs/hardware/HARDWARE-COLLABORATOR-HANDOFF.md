# 硬件协作者联调入口

## 基线与范围

- 稳定 App：1.3.2 / Android versionCode 315，arm64。公开[下载清单](https://laoji.cloud/downloads/android/latest.json)；本基线 APK [固定下载地址](https://laoji.cloud/downloads/android/laoji-1.3.2-315.apk)，46,007,111字节，SHA-256 `86b0b680f4f601299aefcb82edcc458d92770bbff9ee34b3296954fc23289a89`。
- 稳定源码：`master`；未完成的统一日程编辑在`develop`，不要求新板为它更换BLE帧或PCM格式。
- 固件参考：[`hardware/esp32s3-voice-memo/firmware`](../../hardware/esp32s3-voice-memo/firmware/README.md)，标识`laoji-recorder-2.2.0`；BLE版本仍为1.3。ESP-IDF版本、构建、板级引脚和测试命令以固件README为准。
- 这是第二块ESP32-S3语音备忘录测试板的实现，不是任意新板通用bin。新PCB需重新核对引脚、codec、存储、供电和按键；不能直接使用受旧板MAC/分区限制的刷写脚本。

## 接口合同

完整基础协议见[BLE-1.3.md](BLE-1.3.md)，机器约束见[JSON Schema](../../contracts/hardware/laoji-hardware-control-v1.3.schema.json)。该文档第17节是待讨论项，不应误作全部已生效要求。示例SSID、密码和token均为文档占位，不是可用凭据。

- GATT：一个服务、Control RX/TX与Audio TX；先订阅、`hello`协商，再校时和控制。
- 控制：6字节BLE分片头，加完整逻辑帧中的8字节JSON头；响应关联原`command_id`。
- 音频：独立20字节头加PCM；当前16kHz、单声道、PCM16 little-endian。按协商MTU计算容量，偏移绑定实际PCM来源，缺包不能重编号或补静音掩盖。
- 完整文件：BLE区间读取或Wi-Fi HTTP/Range；校验generation、范围、长度和PCM SHA后交接。WAV必须解析RIFF块，不能假设data恒从44字节开始。
- 基础录音、暂停/继续、停止、文件列表/元数据和接收是首轮必测。Wi-Fi能力须如实声明；不支持的电池/关机能力不虚报。

### 当前App已使用的会议/日程扩展

基础帧不变；以下内容是当前固件与App实际使用的接入合同，不应只凭原版BLE文档推断。

- `hello.capabilities.capture.purposes`声明`["meeting","schedule"]`，`button_gestures`为`long_meeting_double_schedule_v1`。待机长按800ms开始会议、双击窗口320ms开始日程；录制/暂停中短按暂停或继续、长按结束。上电按住及长按后的松手不得再触发一次。
- `capture.start`可带`purpose`；`capture.requested`、`capture.started`、`status`和录音元数据携带实际用途。`capture.started`/完整录音元数据还提供不可变`capture_id`、原始`created_epoch_ms`及IANA `time_zone`，不能用接收时间或文件名猜用途/身份。
- 用途随存卡文件持久化，改名/重连后保持。当前参考实现使用RIFF `ljct`块：payload 172字节，version=1、purpose 0=meeting/1=schedule，原始UTC毫秒、64字节NUL结尾时区、96字节NUL结尾capture ID。精确字节布局以[`capture_context.c`](../../hardware/esp32s3-voice-memo/firmware/main/capture_context.c)和共享测试为准；本实现新WAV头长224字节，旧无扩展WAV仍为会议。
- 日程只有可信录制时刻/时区时才能按原始时刻理解“明天”；无时钟保留日期待选。明确用途为日程但元数据损坏时不得静默变成会议。
- App接收后自动交接：会议进入会议处理；日程进入同一日程输入/编辑流程，由用户保存后才写日历。同一采集重收不应创建第二份业务记录。

### 可选扩展与兼容

- `recording.list(include_previews=true)`：可返回每页最多4项轻量预览；不支持时仍可返回文件名，接收前用`recording.get`取完整元数据。
- `hello.capabilities.capture.live_range_repair`：仅声明后启用`capture.audio.read/cancel`；精确合同见BLE文档第18节。不声明时使用原实时链路与结束后的完整来源校验，不伪造已支持能力。

## 首轮联调顺序

1. 扫描连接、hello、能力声明和校时；核对GATT与帧长度。
2. 手机与实体按键分别开始/暂停/继续/结束；断开BLE后板端仍正常存卡。
3. 实时PCM与最终存卡PCM同源，故意缺包后最终接收校验正确；未知讲话人/ASR效果不作为本轮传输协议通过条件。
4. 离线录音后连接，列表/元数据、中文改名、BLE完整读取与重复接收；原录音不被App暗删。
5. 声明Wi-Fi时验证授权、完整下载、Range续传、token到期/关闭及BLE恢复。
6. 长按会议与双击日程分别接入正确业务；改名/重连/重收后用途、采集ID、时间和幂等保持。

源码、合同测试通过与新PCB物理验收分别记录。Git不包含签名私钥、服务器/云端凭据、用户录音、设备私钥、Flash/NVS备份或JTAG内存；需要SDK与示例环境配置不等于需要这些机密。
