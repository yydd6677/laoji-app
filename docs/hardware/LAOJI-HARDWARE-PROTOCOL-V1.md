# 老记外接录音设备协议 LJHW/1

状态：`selected`
当前协议：`major=1, minor=1`
参考实现：`PD-AILAMP-D01 + ESP32-S3 + INMP441 + MicroSD` 测试板

本文是手机与录音硬件的能力协议。测试板引脚、明文开发热点和 GPIO0 按钮限制不进入正式硬件假设。

## 1. 所有权和传输边界

- 设备拥有本机采集文件；手机拥有会议、日程和已接收媒体。
- USB 与 BLE 承载同一控制帧和可选实时 PCM；Wi-Fi 只传输控制面选中的不可变文件。
- 手机校验长度、generation、WAV 结构和 SHA-256，并原子保存后才发送 `recording.ack`。
- `recording.ack` 只标记“已接收”，绝不等同删除；删除必须显式调用 `recording.delete`。
- 手机连接不是录音存活条件。实时镜像断开后，设备继续写本地文件。
- 测试板允许 `development_usb`、`development_ble` 和显式 `development_http`；正式硬件必须使用配对身份与 `tls_pinned`。
- 普通日志不得记录正文、标题、热点密码、bearer token 或配对密钥。

## 2. 二进制帧

USB CDC、BLE 重组结果和可选安全字节流使用 32 字节小端头：

| 偏移 | 长度 | 字段 | 约束 |
| ---: | ---: | --- | --- |
| 0 | 4 | magic | ASCII `LJHW` |
| 4 | 1 | major | `1` |
| 5 | 1 | minor | 当前 `1` |
| 6 | 1 | kind | control request/response/event、live audio、file chunk、ack |
| 7 | 1 | flags | bit0 `final`、bit1 `retryable`，其余为0 |
| 8 | 2 | header_length | `32` |
| 10 | 2 | reserved | `0` |
| 12 | 4 | payload_length | 控制 `<=8192`，数据 `<=65536` |
| 16 | 4 | stream_id | 控制为0，媒体流非0 |
| 20 | 4 | sequence | 每个流严格递增 |
| 24 | 4 | correlation_id | request/response 对应 |
| 28 | 4 | payload_crc32 | IEEE CRC-32 |

接收端按 magic 重同步，拒绝主版本、长度、保留位、CRC 和序列错误。测试板使用的 ESP32-S3 HWCDC
在整帧恰为 64 字节端点整数倍时会额外发送一个帧外 `0x00`，用于形成 USB short packet；该字节不是协议
内容，通用解码器会像启动日志一样在下一个 `LJHW` magic 前丢弃。

BLE 完整帧外使用 6 字节小端分片头：`frame_id:u16`、`index:u8`、`count:u8`、`length:u16`。
单帧最多 48 KiB；控制使用 Indicate，实时音频使用 Notify。大文件不得经 BLE 分片传输。

## 3. minor 1 控制面

JSON 由 [Schema](../../contracts/hardware/laoji-hardware-control-v1.schema.json) 约束。

| 操作 | 作用 |
| --- | --- |
| `hello` | 返回身份、安全模式和真实 capability |
| `status.get` | 返回 `ready/recording/paused/finalizing/transferring/error`、容量和待接收数 |
| `time.sync` | 建立设备 monotonic 与手机 epoch 映射 |
| `capture.start/pause/resume/stop` | 控制同一设备本地会话 |
| `recording.list` | cursor/limit 分页返回 manifest，不传正文 |
| `recording.rename` | 修改展示标题，不改音频字节或 generation |
| `recording.ack` | 标记某 generation 已被手机完整接收 |
| `recording.delete` | 使用 expected_generation 幂等删除源对象 |
| `transport.wifi.offer/close` | 创建或关闭一次性大文件传输会话 |
| `diagnostics.ping` | 无正文链路诊断 |

修改、确认和删除都携带 `recording_id + expected_generation`。对象变化返回 `resume_mismatch`，手机不得把不同
generation 的片段拼在一起。`command_id` 为未来正式硬件的命令幂等键；测试板的对象操作本身已按 generation
幂等，正式控制器还应持久化近期命令结果。

## 4. 能力示例

```json
{
  "protocol": { "major": 1, "minor": 1 },
  "capabilities": {
    "transports": ["usb", "ble", "wifi"],
    "control": ["record_toggle", "record_pause_resume"],
    "capture": {
      "live_stream": true,
      "local_storage": true,
      "codecs": ["pcm_s16le"],
      "sample_rates_hz": [16000],
      "channels": [1]
    },
    "power": { "battery_status": false, "soft_shutdown": false },
    "storage": {
      "available": true,
      "range_resume": true,
      "file_management": ["list", "rename", "delete", "acknowledge"]
    },
    "wifi": { "bulk_transfer": true, "security_modes": ["development_http"] }
  }
}
```

App 只按 capability 展示功能，不能按 model 猜测。测试 profile 的 `development_http` 只允许已识别的
ESP32-S3 测试板与 `192.168.4.1`；未知或正式设备不能复用该放行条件。

## 5. 录音对象

测试板对象为 16 kHz、16-bit、单声道 PCM WAV：

- 录制中写 `<id>.part`，每 5 秒刷新 WAV 头和文件系统；
- 正常结束先封口并同步，再原子改名为 `<id>.wav`；
- 重启发现 `.part` 时按偶数字节截点修复 WAV，重算 hash，标记 `recovered=true`；
- manifest 包含稳定 ID、generation、标题、创建时间、文件长度、时长、确认状态和恢复状态；
- SHA-256 的 `checksum_scope=audio_payload`，即 WAV 44 字节头之后的 PCM。手机本机保存后另计算整文件 hash。

8 GiB 卡的测试 profile 以 32,000 bytes/s 写入，约 115 MB/小时；实测 4 MHz SPI 写入 324 KiB/s。
正式硬件可声明 Opus，但不能在未声明时由 App 推断或强制。

## 6. Wi-Fi 大文件会话

`transport.wifi.offer` 绑定一个 recording generation，返回短时 SSID、随机 WPA2 密码、base URL、path、
一次性 bearer、security mode 和过期时间。服务端要求 bearer 与可选 `If-Match`，返回 `ETag=generation`、
`Accept-Ranges: bytes`、稳定 `Content-Length` 和严格 `Content-Range`。

测试板只允许非录音态开启 AP，并且每次 offer 只暴露一个对象。完成传输后短暂保留控制窗口，随后自动关闭。
正式硬件要求 `tls_pinned`：随机热点凭据和证书 pin 经加密 BLE 控制面交付，禁止固定密码与普通 HTTP。

## 7. S2 与电源边界

测试板 S2 是低有效 GPIO0，同时是启动绑带脚，因此不能作为可靠“开机键”，也没有已验证的硬件电源锁存：

- 空闲长按约 2 秒：开始独立录音；
- 录音或暂停时短按：暂停/继续；
- 录音或暂停时长按约 2 秒：结束并封口；
- 长按动作在达到阈值时触发，不等待松手；
- 结束后回到可连接待机，不宣称物理关机；开机/复位时按住 S2 可能进入下载模式。

正式硬件应把录音键放在普通 GPIO，把长按关机交给独立电源域，再按 capability 声明 `soft_shutdown`。

## 8. App 状态和接收

```text
disconnected -> connecting -> handshaking -> ready
ready -> recording <-> paused -> finalizing -> ready
ready -> transferring -> ready
```

实时镜像在 App 私有目录边收边写；BLE/USB 中断只封口手机已收到的部分，板端完整文件继续存在。设备文件接收
使用 Android 临时网络而不改变全局网络 owner，支持 `.part` 续传。只有 generation、Range、长度、WAV 和 hash
全部通过后才原子进入现有会议导入入口。

## 9. 当前测试板实证

- ESP32-S3 rev 0.2；USB `303a:1001`；麦克风 `WS=9/SCK=10/SD=11`。
- MicroSD：`CS=5/MOSI=6/CLK=7/MISO=15`，Kingston 8 GB，实际约 7.48 GiB。
- 两轮 SD 读写与麦克风并发写卡通过；1 MiB 写 324 KiB/s、读 388–389 KiB/s。
- minor 1 固件已通过真实开始、暂停、继续、结束、manifest、重命名、SHA 和 ack。
- USB 64-byte endpoint 终止问题修复后，连续 30 次 576-byte manifest response：30/30，最大约 152 ms。
- Wi-Fi 完整 GET=200、Range GET=206，96,684 bytes、Content-Range 与 audio payload SHA-256 均匹配。

这些数据只证明当前测试板功能，不外推正式 PCB 的续航、射频、存储寿命、掉电电路或量产安全。
