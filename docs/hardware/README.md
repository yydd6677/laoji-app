# 硬件接口

老记通过 BLE 控制外接录音设备并接收实时 PCM，通过 BLE 或可选 Wi-Fi 通道接收完整录音。设备采集与手机录音共用后续业务流程，不另建一套会议或日程数据。

## 合同与实现

- [BLE 1.3 协议](BLE-1.3.md)：GATT、控制分片、事件、PCM 和文件传输。
- [JSON Schema](../../contracts/hardware/laoji-hardware-control-v1.3.schema.json)：可执行的消息约束。
- [ESP32-S3 参考固件](../../hardware/esp32s3-voice-memo/firmware/README.md)：板级配置、构建、模块和测试。

基础控制使用6字节BLE分片头及8字节JSON帧头；音频使用独立20字节头。当前音频格式为16kHz、单声道、PCM16 little-endian。容量按实际ATT MTU计算，不依赖固定20ms音频包。

## 连接与传输

订阅 Control TX 和 Audio TX 后调用 `hello` 协商能力，再校时或发起采集。命令用 `command_id` 关联响应，音频用 `stream_id`、序号和源PCM偏移关联原录音。

完整接收需核对 generation、范围、长度和 `audio_payload` SHA-256，再原子交接。HTTP下载偏移针对完整文件；BLE偏移针对WAV data块中的PCM。WAV按RIFF块解析，不假设头长恒为44字节。

BLE、Wi-Fi和本地存储能力必须如实声明。未声明的可选扩展不启用；断开BLE不会隐式终止板上存卡录音。USB在参考固件中用于调试和刷写，不是手机音频传输接口。

## 会议与日程用途

支持两种用途的设备在 `hello.capabilities.capture.purposes` 声明 `["meeting","schedule"]`，`button_gestures` 为 `long_meeting_double_schedule_v1`。

| 状态 | 手势 | 行为 |
| --- | --- | --- |
| 待机 | 长按800ms | 开始会议录音 |
| 待机 | 双击，窗口320ms | 开始日程语音 |
| 录制或暂停 | 短按 | 暂停或继续 |
| 录制或暂停 | 长按 | 结束录音 |

上电按住或长按后的松手不得触发另一条操作。用途不从内容或录音时长猜测。

`capture.start` 可传 `purpose`；采集事件、状态和最终元数据提供实际用途。`capture_id` 是不可变采集身份，`created_epoch_ms` 与 IANA `time_zone` 用于解释相对日期。文件改名或接收时间不能替代采集身份和原始时刻。

参考固件将上下文写入 RIFF `ljct` 块：

| payload偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 1 | 版本1 |
| 1 | 1 | 用途：0为meeting，1为schedule |
| 2 | 2 | 保留 |
| 4 | 8 | 原始UTC毫秒，little-endian；0表示未知 |
| 12 | 64 | NUL结尾时区 |
| 76 | 96 | NUL结尾capture ID |

payload共172字节，参考实现的完整WAV头为224字节。编码与边界见 [capture_context.c](../../hardware/esp32s3-voice-memo/firmware/main/capture_context.c)。没有扩展块的旧WAV按会议处理；明确日程但上下文损坏时不得静默改为会议。时钟未知时日期保持待选，不能按接收当天猜测“明天”。

接收校验后，会议进入会议记录，日程进入日程输入流程；日程仍需用户保存。同一采集重复接收不得创建第二份业务记录。

## 安全与适配范围

当前参考固件使用 development BLE/HTTP，不等于具备生产级配对或端到端加密。Wi-Fi密码与token每次offer更新，不应写入日志。

新的PCB需要核对供电、引脚、codec、存储和按键。参考刷写工具有特定板型和分区保护，不应作为任意设备的通用刷写器。新设备需实测控制、实时/最终音频一致性、断连恢复、文件校验及声明支持的可选能力。
