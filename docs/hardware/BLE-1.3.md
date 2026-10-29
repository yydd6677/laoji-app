# BLE 1.3 通信协议

本文定义老记录音设备的BLE控制、事件、实时音频及文件传输。`LaoJi Test Board` 为参考固件的广播名；JSON使用UTF-8编码，不带BOM。用途与采集上下文见[硬件接口](README.md)。

## 1. BLE 基础参数

| 参数 | 当前值 |
| --- | --- |
| 设备广播名 | `LaoJi Test Board` |
| Service UUID | `9f7a0001-6d6f-4a6f-8a4b-6c616f6a6901` |
| Control RX UUID | `9f7a0002-6d6f-4a6f-8a4b-6c616f6a6901` |
| Control TX UUID | `9f7a0003-6d6f-4a6f-8a4b-6c616f6a6901` |
| Audio TX UUID | `9f7a0004-6d6f-4a6f-8a4b-6c616f6a6901` |
| CCCD UUID | `00002902-0000-1000-8000-00805f9b34fb` |
| Control RX 属性 | `Write`、`Write Without Response` |
| App 当前写入方式 | `Write With Response` |
| Control TX 属性 | `Indicate` |
| Audio TX 属性 | `Notify` |
| 首选 ATT MTU | `517` |
| 最大特征值长度 | `512 bytes` |
| 单次扫描时间 | `3200 ms` |

## 2. JSON BLE 分片头

只有 Control RX 和 Control TX 使用以下 6 字节分片头。Audio TX 不使用该分片头，一个 Audio TX Notify 就是一个完整音频帧。

| 偏移 | 长度 | 字段 | 类型 |
| ---: | ---: | --- | --- |
| 0 | 2 | `frame_id` | `uint16 little-endian` |
| 2 | 1 | `index` | `uint8` |
| 3 | 1 | `count` | `uint8` |
| 4 | 2 | `body_length` | `uint16 little-endian` |
| 6 | N | `body` | bytes |

约束：

- `frame_id`：`1..65535`
- `index`：`0..count-1`
- `count`：`1..255`
- 完整逻辑帧最大： **`min(48 * 1024, 255 * fragment_body_capacity)` bytes**
- MTU 517 时包长：`512 bytes`
- MTU 517 时正文：`506 bytes`

分片和逻辑帧容量按当前连接计算：

```text
fragment_body_capacity  = min(512, negotiated_att_mtu - 3) - 6
max_logical_frame_bytes = min(48 * 1024, 255 * fragment_body_capacity)
```

上述逻辑帧长度包括第 3.1 节的 8 字节 JSON 帧头。发送方必须保证完整逻辑帧不超过 `max_logical_frame_bytes`，并保证实际 `count` 不超过 255。MTU 不低于 202 时可承载完整的 48 KiB 逻辑帧。超出当前容量的报文不得截断发送。

同一 JSON 逻辑帧的全部分片使用相同的 `frame_id` 和 `count`。接收方按 `index` 从 0 开始重组；重组后的 `body` 是第 3.1 节定义的完整 JSON 帧。JSON 帧头只出现一次，不在每个 BLE 分片中重复。

## 3. JSON 帧与音频帧

Control RX/TX 和 Audio TX 使用不同的帧格式。所有多字节整数均为 little-endian。

### 3.1 JSON 帧

完整 JSON 帧由 8 字节帧头和 JSON UTF-8 payload 组成：

| 偏移 | 长度 | 字段 | 类型/当前值 |
| ---: | ---: | --- | --- |
| 0 | 1 | `major` | `uint8 = 1` |
| 1 | 1 | `minor` | `uint8 = 3` |
| 2 | 1 | `flags` | `uint8` |
| 3 | 1 | `reserved` | `uint8 = 0` |
| 4 | 4 | `payload_length` | `uint32`，JSON UTF-8 字节数 |
| 8 | N | `payload` | JSON UTF-8，长度必须等于 `payload_length` |

JSON 请求和事件的 `flags` 必须为 0。失败应答允许使用 `flags.bit1 = 0x02` 表示 `retryable`，并且必须与 JSON `error.retryable` 保持一致；其余位必须为 0。

Control RX 上的 JSON 是请求。Control TX 上包含 `ok` 字段的 JSON 是应答，不包含 `ok` 字段的是事件。每个应答必须回传原请求的 `command_id`，App 使用 `command_id` 匹配请求与应答。

发送方先组成一个完整 JSON 帧，再将整个帧作为第 2 节的分片 `body` 进行拆分。 完整 JSON 帧不得超过第 2 节按当前连接计算出的 `max_logical_frame_bytes`。

### 3.2 音频帧

每个 Audio TX Notify 都是一个完整音频帧，不使用第 2 节的 BLE 分片头。固定帧头为 20 字节：

| 偏移 | 长度 | 字段 | 类型/当前值 |
| ---: | ---: | --- | --- |
| 0 | 1 | `major` | `uint8 = 1` |
| 1 | 1 | `minor` | `uint8 = 3` |
| 2 | 1 | `kind` | `uint8` |
| 3 | 1 | `flags` | `uint8` |
| 4 | 4 | `stream_id` | `uint32`，非零 |
| 8 | 4 | `sequence` | `uint32`，非零 |
| 12 | 8 | `pcm_offset` | `uint64`，相对 WAV `data` chunk 的 PCM 字节偏移 |
| 20 | N | `pcm` | PCM bytes，长度由 Notify 实际长度减 20 得到 |

| `kind` | 含义 |
| ---: | --- |
| `0x10` | Live Audio，实时音频 |
| `0x11` | Stored Audio Data，录音读取或丢包补传 |

`flags.bit0 = 0x01` 表示当前音频流或请求范围的最后一帧；其余位必须为 0。`stream_id` 在一条流中保持不变，`sequence` 在每条流中从 1 连续递增，溢出后跳过 0。PCM 长度必须按音频 `block_align` 对齐。

音频帧没有 `payload_length`：

```text
PCM 长度 = Audio TX Notify 实际长度 - 20
```

MTU 517 且最大特征值长度为 512 bytes 时，一个音频帧最多携带 `512 - 20 = 492 bytes` PCM。最后一个数据帧可以少于 492 bytes；无 PCM 的结束帧总长度为 20 bytes。

音频 PCM 容量必须按当前连接动态计算：

```text
attribute_value_bytes = min(512, negotiated_att_mtu - 3)
pcm_capacity_bytes    = floor((attribute_value_bytes - 20) / block_align) * block_align
```

`hello.capabilities.storage.ble_audio_chunk_size_bytes` 与 `recording.audio.read` 成功应答中的 `transfer.chunk_size_bytes` 均不得超过上述 PCM 容量；实际 PCM 长度不得超过声明的分块上限，并须按 `block_align` 对齐，不要求每帧填满。

## 4. JSON 公共约定

### 4.1 请求公共字段

每个请求都必须包含：

```json
{
  "schema_version": 1,
  "op": "status.get",
  "command_id": "cmd-018f6ec0-b773-7f02-a11b-74d02b0b1c21"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema_version` | integer | 是 | 当前固定为 `1` |
| `op` | string | 是 | 操作名 |
| `command_id` | string | 是 | App 生成的唯一、安全、不重复命令 ID，用于去重和日志追踪 |

同一 `command_id` 的重试必须保持 `op` 和参数完全一致。设备已处理过该命令时，应返回原处理结果，不应重复执行有副作用的操作。

### 4.2 成功应答公共字段

```json
{
  "schema_version": 1,
  "op": "status.get",
  "command_id": "cmd-018f6ec0-b773-7f02-a11b-74d02b0b1c21",
  "ok": true
}
```

`schema_version`、`op`、`command_id`、`ok` 必须存在。应答的 `command_id` 必须等于对应请求的值；具体操作的结果字段直接放在根对象中。

### 4.3 失败应答公共字段

所有控制命令使用同一种失败结构：

```json
{
  "schema_version": 1,
  "op": "capture.start",
  "command_id": "cmd-capture-start-0001",
  "ok": false,
  "error": {
    "code": "storage_full",
    "message": "Not enough storage to start a recording",
    "retryable": true,
    "details": {
      "storage_free_bytes": 0,
      "required_bytes": 1048576
    }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `error.code` | string | 是 | 稳定的机器可读错误码 |
| `error.message` | string | 是 | 面向日志的英文说明，不用于业务判断 |
| `error.retryable` | boolean | 是 | 当前请求是否可按原参数重试 |
| `error.details` | object | 否 | 错误上下文；调用方必须容忍未知字段 |

失败应答的 JSON 帧 `flags.bit1` 必须与 `error.retryable` 保持一致。

### 4.4 空值、可选字段和未知字段

- 必填且当前没有值的字段使用 `null`，例如 `status.session_id`。
- 可选请求字段没有值时应省略，不发送空字符串代替。
- 接收方必须忽略未知 JSON 字段，以支持同一主版本内向后兼容扩展。
- ID、游标、generation 和 token 都是不透明字符串，不得解析其内部格式。
- 所有 `*_ms` 时间均为整数毫秒；`epoch_ms` 使用 Unix Epoch UTC。
- 所有 `*_bytes` 均为非负整数。

## 5. hello

`hello` 应在订阅 Control TX 后首先调用。成功前不应发送其他业务命令。

### 5.1 请求

```json
{
  "schema_version": 1,
  "op": "hello",
  "command_id": "cmd-018f6ec0-b773-7f02-a11b-74d02b0b1c21",
  "app": {
    "name": "laoji-android",
    "version": "1.4.0"
  },
  "supported_protocols": [
    {
      "major": 1,
      "minor": 3
    }
  ],
  "transports": [
    "ble"
  ]
}
```

### 5.2 成功应答

```json
{
  "schema_version": 1,
  "op": "hello",
  "command_id": "cmd-018f6ec0-b773-7f02-a11b-74d02b0b1c21",
  "ok": true,
  "protocol": {
    "major": 1,
    "minor": 3
  },
  "device": {
    "device_id": "esp32s3-94dea5a0ed30",
    "model": "PD-AILAMP-D01-test",
    "firmware_revision": "laoji-test-board-1.2.3",
    "hardware_revision": "PD-AILAMP-D01-observed"
  },
  "security": {
    "mode": "development_ble"
  },
  "capabilities": {
    "transports": [
      "usb",
      "ble",
      "wifi"
    ],
    "control": [
      "record_toggle",
      "record_pause_resume"
    ],
    "capture": {
      "live_stream": true,
      "local_storage": true,
      "codecs": [
        "pcm_s16le"
      ],
      "sample_rates_hz": [
        16000
      ],
      "channels": [
        1
      ]
    },
    "power": {
      "battery_status": false,
      "soft_shutdown": false
    },
    "storage": {
      "available": true,
      "range_resume": true,
      "ble_audio_read": true,
      "ble_audio_chunk_size_bytes": 492,
      "file_management": [
        "get",
        "list",
        "rename",
        "delete"
      ],
      "capacity_bytes": 8032092160
    },
    "wifi": {
      "bulk_transfer": true,
      "security_modes": [
        "development_http"
      ]
    }
  }
}
```

### 5.3 不支持协议版本

```json
{
  "schema_version": 1,
  "op": "hello",
  "command_id": "cmd-018f6ec0-b773-7f02-a11b-74d02b0b1c21",
  "ok": false,
  "error": {
    "code": "unsupported_protocol",
    "message": "No mutually supported protocol version",
    "retryable": false,
    "details": {
      "supported_protocols": [
        {
          "major": 1,
          "minor": 3
        }
      ]
    }
  }
}
```

## 6. 状态、时间与诊断命令

### 6.1 status.get

请求：

```json
{
  "schema_version": 1,
  "op": "status.get",
  "command_id": "cmd-status-0001"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "status.get",
  "command_id": "cmd-status-0001",
  "ok": true,
  "status": {
    "state": "ready",
    "session_id": null,
    "recording_id": null,
    "battery_percent": null,
    "storage_free_bytes": 8012345678,
    "pending_recordings": 2
  }
}
```

`status.state` 的取值为 `ready`、`recording`、`paused`、`finalizing`、`transferring` 或 `error`。设备不支持电量上报时，`battery_percent` 为 `null`。

### 6.2 time.sync

请求：

```json
{
  "schema_version": 1,
  "op": "time.sync",
  "command_id": "cmd-time-0001",
  "epoch_ms": 1787900000000,
  "time_zone": "Asia/Shanghai"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "time.sync",
  "command_id": "cmd-time-0001",
  "ok": true
}
```

`time_zone` 使用 IANA 时区名称。

### 6.3 diagnostics.ping

请求：

```json
{
  "schema_version": 1,
  "op": "diagnostics.ping",
  "command_id": "cmd-ping-0001"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "diagnostics.ping",
  "command_id": "cmd-ping-0001",
  "ok": true
}
```

## 7. 录音控制命令

以下示例使用同一个 `session_id`、`recording_id` 和 `stream_id` 展示完整录音生命周期。
session_id 用来标识“一次录音会话”，不是 BLE 连接 ID，也不是单条命令 ID。
recording_id 用来唯一标识一条已经创建的录音文件
### 7.1 capture.start

请求：

```json
{
  "schema_version": 1,
  "op": "capture.start",
  "command_id": "cmd-capture-start-0001",
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31",
  "audio": {
    "codec": "pcm_s16le",
    "sample_rate_hz": 16000,
    "channels": 1,
    "live_stream": true
  }
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "capture.start",
  "command_id": "cmd-capture-start-0001",
  "ok": true,
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31",
  "recording_id": "20260903_153000.wav"
}
```

应答表示启动请求已接受。实际开始采集以随后的 `capture.started` 事件为准。

`capture.start.audio.live_stream` 是手机主动启动录音时的明确选择。设为
`true` 表示本次录音需要实时 PCM，设为 `false` 或省略表示只保存本地 WAV。
设置为 `true` 前必须已经订阅 Audio TX Notify。

### 7.1.1 按键启动前协商

按下设备录音键后，设备暂不启动 ES7210，而是先发送 `capture.requested` 事件。
App 根据当前是否空闲回复以下命令；`request_id` 必须来自该事件：

```json
{
  "schema_version": 1,
  "op": "capture.request.resolve",
  "command_id": "cmd-capture-request-resolve-0001",
  "request_id": "key-4a21bc90",
  "live_stream": true
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "capture.request.resolve",
  "command_id": "cmd-capture-request-resolve-0001",
  "ok": true,
  "request_id": "key-4a21bc90",
  "live_stream": true
}
```

`live_stream: true` 表示手机空闲并需要同步，发送前必须订阅 Audio TX Notify；
`false` 表示只保存本地 WAV。设备等待最多 300 ms，然后才开始录音；未连接、
未完成 `hello`、断开或超时均默认只保存本地 WAV。录音开始后选择被锁定，后续
重新连接或订阅 Notify 都不会为本次录音恢复实时 PCM。

### 7.2 capture.pause

请求：

```json
{
  "schema_version": 1,
  "op": "capture.pause",
  "command_id": "cmd-capture-pause-0001",
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "capture.pause",
  "command_id": "cmd-capture-pause-0001",
  "ok": true,
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31"
}
```

状态切换完成后设备发送 `capture.paused` 事件。

### 7.3 capture.resume

请求：

```json
{
  "schema_version": 1,
  "op": "capture.resume",
  "command_id": "cmd-capture-resume-0001",
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "capture.resume",
  "command_id": "cmd-capture-resume-0001",
  "ok": true,
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31"
}
```

状态切换完成后设备发送 `capture.resumed` 事件。

### 7.4 capture.stop

请求：

```json
{
  "schema_version": 1,
  "op": "capture.stop",
  "command_id": "cmd-capture-stop-0001",
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "capture.stop",
  "command_id": "cmd-capture-stop-0001",
  "ok": true,
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31"
}
```

应答表示停止请求已接受。文件完成落盘、校验和生成后，设备发送 `capture.finished` 事件。

## 8. 通过 BLE 操作录音文件

本节所有 JSON 命令都通过 BLE 发送：请求写入 Control RX，成功或失败应答从 Control TX 返回。`recording.list/get/rename/delete` 不要求开启 Wi-Fi。BLE 的 `recording.audio.read` 只读取 WAV 中的 PCM，Wi-Fi HTTP 则下载设备端完整 WAV 文件。

录音文件操作以 `/disk` 中的实际文件为准，`generation` 根据文件修改时间和大小生成。参考固件可缓存已校验的元数据；缓存失效或文件变化时重新读取，不得用过期缓存替代文件版本检查。

### 8.1 recording.list

首次请求不携带 `cursor`，默认每页最多返回 32 个文件；也可以通过 `limit` 指定本页数量（范围 1..32）：

```json
{
  "schema_version": 1,
  "op": "recording.list",
  "command_id": "cmd-recording-list-0001",
  "limit": 32
}
```

后续请求携带上一次返回的 `next_cursor`：

```json
{
  "schema_version": 1,
  "op": "recording.list",
  "command_id": "cmd-recording-list-0002",
  "cursor": "32",
  "limit": 32
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "recording.list",
  "command_id": "cmd-recording-list-0001",
  "ok": true,
  "recordings": [
    "20260903_153000.wav",
    "20260903_153500.wav"
  ],
  "next_cursor": null
}
```

`recordings` 只返回文件对应的 `recording_id` 列表。`next_cursor` 为 `null` 表示没有下一页；否则将它原样作为下一次请求的 `cursor`。`limit` 范围为 1..32。需要 generation、文件大小和校验信息时，再调用 `recording.get`。

可选列表预览扩展：请求携带 `include_previews: true` 时，每页上限收敛为 4，同时返回 `previews` 数组。每项仅含 `recording_id / generation / file_bytes / duration_ms / created_epoch_ms`，只读取文件头，不计算 PCM 校验值。预览不是完整元数据，接收及变更操作前仍调用 `recording.get`，不能用预览提交音频。未请求扩展的旧命令不变；不支持扩展的固件仅返回文件名时，App 展示标题而不编造时长、大小或代际。

### 8.2 recording.get

请求：

```json
{
  "schema_version": 1,
  "op": "recording.get",
  "command_id": "cmd-recording-get-0001",
  "recording_id": "20260903_153000.wav"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "recording.get",
  "command_id": "cmd-recording-get-0001",
  "ok": true,
  "recording": {
    "recording_id": "20260903_153000.wav",
    "generation": "gen-00000001-7c9a",
    "container": "wav",
    "audio": {
      "codec": "pcm_s16le",
      "sample_rate_hz": 16000,
      "bits_per_sample": 16,
      "channels": 1,
      "local_storage": true
    },
    "samples": 160000,
    "audio_bytes": 320000,
    "file_bytes": 320044,
    "duration_ms": 10000,
    "checksum_sha256": "sha256:4e810e1f2bcd4fdc6e62a08b481c4d083b394765b26d13b50c1d54b70f50158c",
    "checksum_scope": "audio_payload",
    "created_epoch_ms": 1787900000000,
    "recovered": false
  }
}
```

录音不存在时返回 `recording_not_found`。该命令只读取元数据；WAV 中的 PCM 音频数据可通过 `recording.audio.read` 走 BLE 获取，完整 WAV 文件可通过第 10 节的 HTTP 接口获取。

### 8.3 recording.rename

请求：

```json
{
  "schema_version": 1,
  "op": "recording.rename",
  "command_id": "cmd-recording-rename-0001",
  "recording_id": "20260903_153000.wav",
  "expected_generation": "gen-00000001-7c9a",
  "new_recording_id": "客户访谈.wav"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "recording.rename",
  "command_id": "cmd-recording-rename-0001",
  "ok": true
}
```

`recording.rename` 直接重命名 `/disk` 中的录音文件。成功后旧 `recording_id` 失效，后续请求必须使用 本次请求中的 `new_recording_id`。`new_recording_id` 必须是合法的单个文件名，不允许包含 `/` 或 `\`，也不能与现有文件重名；目标已存在时返回 `recording_already_exists`。重命名不改变文件内容，因此 `generation` 保持不变。

### 8.4 recording.delete

请求：

```json
{
  "schema_version": 1,
  "op": "recording.delete",
  "command_id": "cmd-recording-delete-0001",
  "recording_id": "20260903_153000.wav",
  "expected_generation": "gen-00000002-91bd"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "recording.delete",
  "command_id": "cmd-recording-delete-0001",
  "ok": true,
  "recording_id": "20260903_153000.wav"
}
```

`expected_generation` 用于并发保护。generation 不匹配时返回 `resume_mismatch`，并在 `details.actual_generation` 中返回当前值。

当前文件协议只允许查询、下载、重命名和删除设备录音，不支持由 App 向设备上传、创建、覆盖或追加文件。未定义的文件操作返回 `unsupported_operation`。

### 8.5 recording.audio.read

该命令通过 BLE 读取 WAV `data` chunk 中的 PCM 音频数据，不传输 RIFF/WAV 文件头及其他容器 chunk。它既可用于获取全部 PCM，也可在实时录音结束后修复 App 丢失的音频区间。App 必须先订阅 Audio TX Notify；设备在 Control TX 成功应答被确认后，才开始发送 `kind = 0x11` 的 Stored Audio Data 帧。

从 PCM 开头读取到末尾：

```json
{
  "schema_version": 1,
  "op": "recording.audio.read",
  "command_id": "cmd-recording-audio-read-0001",
  "recording_id": "20260903_153000.wav",
  "expected_generation": "gen-00000002-91bd",
  "offset": 0
}
```

修复从 PCM 偏移 1280 开始丢失的一帧 640 字节音频：

```json
{
  "schema_version": 1,
  "op": "recording.audio.read",
  "command_id": "cmd-recording-audio-repair-0001",
  "recording_id": "20260903_153000.wav",
  "expected_generation": "gen-00000002-91bd",
  "offset": 1280,
  "length": 640
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "recording.audio.read",
  "command_id": "cmd-recording-audio-repair-0001",
  "ok": true,
  "transfer": {
    "transport": "ble",
    "recording_id": "20260903_153000.wav",
    "generation": "gen-00000002-91bd",
    "stream_id": 92837465,
    "offset_scope": "audio_payload",
    "offset": 1280,
    "length": 640,
    "total_audio_bytes": 320000,
    "chunk_size_bytes": 492,
    "checksum_sha256": "sha256:4e810e1f2bcd4fdc6e62a08b481c4d083b394765b26d13b50c1d54b70f50158c",
    "checksum_scope": "audio_payload"
  }
}
```

| 请求字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `recording_id` | string | 是 | 要读取的 WAV 录音 |
| `expected_generation` | string | 是 | 防止补传期间设备端录音发生变化 |
| `offset` | integer | 是 | 相对于 WAV `data` chunk 首字节的 PCM 偏移，首字节为 0 |
| `length` | integer | 否 | 本次最多读取的 PCM 字节数；省略表示一直读取到音频末尾 |

`offset` 必须位于 `0..audio_bytes-1`，并按 `audio.channels * audio.bits_per_sample / 8` 得到的 `block_align` 对齐。`length` 存在时必须大于 0 并按 `block_align` 对齐；实际返回长度为 `min(length, audio_bytes - offset)`。当前单声道 16-bit PCM 的 `block_align = 2`。

同一时间只允许一个 BLE 录音补传。录音或实时音频流活动时不允许启动 `recording.audio.read`，设备返回 `invalid_state`；补传期间调用 `capture.start` 返回 `busy`。

### 8.6 recording.audio.read.cancel

请求：

```json
{
  "schema_version": 1,
  "op": "recording.audio.read.cancel",
  "command_id": "cmd-recording-audio-read-cancel-0001",
  "stream_id": 92837465
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "recording.audio.read.cancel",
  "command_id": "cmd-recording-audio-read-cancel-0001",
  "ok": true,
  "stream_id": 92837465
}
```

取消成功后设备停止产生新的 Stored Audio Data 帧。传输已结束时使用相同 `stream_id` 重复取消也应成功；未知 `stream_id` 返回 `transfer_not_found`。

### 8.7 BLE 录音数据帧

录音 PCM 从 Audio TX 以独立音频帧发送，`kind = 0x11`。`stream_id` 等于 `recording.audio.read` 应答中的 `transfer.stream_id`，`sequence` 在本次流中从 1 连续递增。

每个 Notify 使用第 3.2 节的 20 字节音频帧头，`pcm_offset` 是本帧 PCM 首字节相对于 WAV `data` chunk 的偏移。PCM 长度由 Notify 实际长度减 20 得到，最大为应答中的  `transfer.chunk_size_bytes`，不得超过第 3.2 节的容量上限。音频帧不使用 BLE 分片头，也没有 `payload_length` 或 CRC 字段。

最后一个数据帧设置 `flags.bit0 = 1`，表示本次请求范围发送完毕，不一定表示整段录音末尾。

App 只接受 `pcm_offset` 与当前请求范围内期望偏移一致的数据块。偏移不连续或 `sequence` 跳变时，App 应先调用 `recording.audio.read.cancel`，再从最后一个已可靠落盘的 PCM 偏移重新调用 `recording.audio.read`。新请求会使用新的 `stream_id`，App 必须忽略旧流迟到的数据帧。

BLE 断开时传输自动终止，无需额外取消。重连后 App 重新调用 `recording.get` 检查 generation；未变化时可继续修复，发生变化时必须丢弃基于旧 generation 的 PCM 数据。

### 8.8 实时录音丢包修复

App 实时接收第 12 节的 `kind = 0x10` 音频帧，按 `pcm_offset` 写入临时 PCM 文件并记录缺口。收到 `capture.finished` 后，App 合并连续缺口，并对每个缺口调用 `recording.audio.read`。缺口较多时，建议从第一个缺口读取到音频末尾，以减少控制命令次数。

全部 PCM 补齐后，App 检查 `audio_bytes` 和 `checksum_sha256`，再根据 `container` 和 `audio` 参数生成本地 WAV 文件头。这样生成的 WAV 音频内容与设备录音一致，但容器头和设备端文件不要求逐字节相同；需要设备原始完整 WAV 时使用第 10 节的 HTTP 下载。

### 8.9 BLE 文件操作汇总

| 文件操作 | BLE 请求 | BLE 应答/数据 | 是否需要 Wi-Fi |
| --- | --- | --- | --- |
| 列出文件 | Control RX `recording.list` | Control TX JSON | 否 |
| 查询单个文件 | Control RX `recording.get` | Control TX JSON | 否 |
| 获取或修复 PCM | Control RX `recording.audio.read` | Control TX JSON + Audio TX `0x11` PCM | 否 |
| 按 PCM 偏移续传 | Control RX `recording.audio.read` + `offset` | Audio TX `0x11` PCM | 否 |
| 取消读取 | Control RX `recording.audio.read.cancel` | Control TX JSON | 否 |
| 获取原始完整 WAV | - | Wi-Fi HTTP 文件 | 是 |
| 重命名 | Control RX `recording.rename` | Control TX JSON | 否 |
| 删除文件 | Control RX `recording.delete` | Control TX JSON | 否 |

BLE 音频恢复闭环为：`recording.get` -> `recording.audio.read` -> 按 `pcm_offset` 写入临时 PCM -> 校验 `audio_bytes` 和 SHA-256 -> 生成 WAV。Wi-Fi 用于获取设备端原始完整 WAV 文件。

## 9. Wi-Fi 传输命令

Wi-Fi 是可选的完整 WAV 文件下载通道，不是文件管理或录音丢包修复的前置条件。设备不支持 Wi-Fi 或 App 不希望切换网络时，可以使用第 8 节的 BLE PCM 读取流程重建 WAV。

### 9.1 transport.wifi.offer

请求：

```json
{
  "schema_version": 1,
  "op": "transport.wifi.offer",
  "command_id": "cmd-wifi-offer-0001"
}
```

`transport.wifi.offer` 只负责开启 SoftAP 和临时 HTTP 文件服务，不绑定具体录音文件，因此不需要 `recording_id` 或 `expected_generation`。

成功应答：

```json
{
  "schema_version": 1,
  "op": "transport.wifi.offer",
  "command_id": "cmd-wifi-offer-0001",
  "ok": true,
  "wifi_offer": {
    "ssid": "LaoJi-a0ed30",
    "password": "example-only",
    "base_url": "http://192.168.4.1",
    "recording_base_path": "/recording/",
    "bearer_token": "b64url-token-value",
    "security_mode": "development_http",
    "certificate_sha256": null,
    "expires_epoch_ms": 1787900120000,
    "expires_in_ms": 120000
  }
}
```

指定录音的完整下载 URL 为  `base_url + recording_base_path + percent_encode_utf8(recording_id)`。编码时仅保留 ASCII 字母、数字和 `-._~`，其余字符按 UTF-8 字节进行百分号编码；空格编码为 `%20`，不是 `+`。HTTP 框架和业务代码合计只解码一次，再按第 8.3 节的合法单文件名规则校验，解码结果不得再次解释为路径。HTTP 请求携带 `Authorization: Bearer <bearer_token>`。SSID 密码和 token 属于敏感信息，不应写入普通日志。`expires_in_ms` 从应答生成时开始计算；绝对时间可信时同时使用 `expires_epoch_ms`。

### 9.2 transport.wifi.status

请求：

```json
{
  "schema_version": 1,
  "op": "transport.wifi.status",
  "command_id": "cmd-wifi-status-0001"
}
```

热点活动时的成功应答：

```json
{
  "schema_version": 1,
  "op": "transport.wifi.status",
  "command_id": "cmd-wifi-status-0001",
  "ok": true,
  "wifi": {
    "state": "client_connected",
    "ssid": "LaoJi-a0ed30",
    "device_ipv4": "192.168.4.1",
    "client_ipv4": "192.168.4.2",
    "expires_epoch_ms": 1787900120000,
    "expires_in_ms": 83214
  }
}
```

热点关闭时的成功应答：

```json
{
  "schema_version": 1,
  "op": "transport.wifi.status",
  "command_id": "cmd-wifi-status-0001",
  "ok": true,
  "wifi": {
    "state": "off",
    "ssid": null,
    "device_ipv4": null,
    "client_ipv4": null,
    "expires_epoch_ms": null,
    "expires_in_ms": 0
  }
}
```

`wifi.state` 当前可取 `off`、`starting`、`ready`、`client_connected` 或 `transferring`。状态查询不重复返回 `password` 和 `bearer_token`；App 丢失凭据时应重新调用 `transport.wifi.offer`。

### 9.3 transport.wifi.close

请求：

```json
{
  "schema_version": 1,
  "op": "transport.wifi.close",
  "command_id": "cmd-wifi-close-0001"
}
```

成功应答：

```json
{
  "schema_version": 1,
  "op": "transport.wifi.close",
  "command_id": "cmd-wifi-close-0001",
  "ok": true
}
```

无活动 Wi-Fi 传输时调用也应成功，以便调用方安全重试。

## 10. Wi-Fi HTTP 文件传输

### 10.1 传输流程

1. App 通过 BLE 调用 `recording.get`，保存 `generation`、`file_bytes`、`audio_bytes` 和 `checksum_sha256`。
2. App 通过 BLE 调用 `transport.wifi.offer`，设备开启 SoftAP 和临时 HTTP 服务。
3. App 连接 `wifi_offer.ssid`，使用  第 9.1 节定义的编码后 URL 访问录音文件。
4. App 可先发送 `HEAD` 获取文件长度和续传能力，再用 `GET` 或带 `Range` 的 `GET` 下载。
5. App 下载完成后按 `checksum_scope` 计算 SHA-256，并与录音元数据中的 `checksum_sha256` 比较。
6. 下载结束后 App 调用 `transport.wifi.close`。

所有 HTTP 请求必须携带：

```http
Authorization: Bearer b64url-token-value
```

Bearer token 对本次临时 HTTP 文件服务有效，可用于访问 `/recording/{recording_id}` 指定的录音文件，并在 offer 到期或 `transport.wifi.close` 成功后立即失效。

### 10.2 查询文件信息 HEAD

请求：

```http
HEAD /recording/20260903_153000.wav HTTP/1.1
Host: 192.168.4.1
Authorization: Bearer b64url-token-value
If-Match: "gen-00000002-91bd"
Connection: keep-alive
```

成功应答：

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: 320044
Accept-Ranges: bytes
ETag: "gen-00000002-91bd"
X-Recording-Id: 20260903_153000.wav
X-Checksum-SHA256: sha256:4e810e1f2bcd4fdc6e62a08b481c4d083b394765b26d13b50c1d54b70f50158c
X-Checksum-Scope: audio_payload
Connection: keep-alive
```

`HEAD` 应答没有响应 body。`ETag` 固定等于当前 recording generation。

`If-Match` 为可选请求头。App 已通过 `recording.get` 获得 generation 时建议携带它，以避免在查询或下载前文件版本发生变化；省略时设备直接处理请求发生时的当前文件版本。

### 10.3 完整下载 GET

请求：

```http
GET /recording/20260903_153000.wav HTTP/1.1
Host: 192.168.4.1
Authorization: Bearer b64url-token-value
If-Match: "gen-00000002-91bd"
Connection: keep-alive
```

成功应答头：

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: 320044
Accept-Ranges: bytes
ETag: "gen-00000002-91bd"
X-Recording-Id: 20260903_153000.wav
X-Checksum-SHA256: sha256:4e810e1f2bcd4fdc6e62a08b481c4d083b394765b26d13b50c1d54b70f50158c
X-Checksum-Scope: audio_payload
Connection: keep-alive

<320044 bytes file body>
```

### 10.4 Range 断点续传

假设 App 已可靠保存前 100000 字节，则从字节偏移 100000 继续请求：

```http
GET /recording/20260903_153000.wav HTTP/1.1
Host: 192.168.4.1
Authorization: Bearer b64url-token-value
Range: bytes=100000-
If-Range: "gen-00000002-91bd"
Connection: keep-alive
```

成功应答：

```http
HTTP/1.1 206 Partial Content
Content-Type: application/octet-stream
Content-Length: 220044
Content-Range: bytes 100000-320043/320044
Accept-Ranges: bytes
ETag: "gen-00000002-91bd"
X-Recording-Id: 20260903_153000.wav
X-Checksum-SHA256: sha256:4e810e1f2bcd4fdc6e62a08b481c4d083b394765b26d13b50c1d54b70f50158c
X-Checksum-Scope: audio_payload
Connection: keep-alive

<220044 bytes partial file body>
```

偏移量以完整 HTTP 文件 body 的第 0 字节为起点。设备当前只需支持单个 byte range；多段 Range 请求返回 `400 Bad Request`。如果 `If-Range` 与当前 generation 不一致，设备返回完整文件的 `200 OK`，App 必须丢弃旧临时文件并重新下载。

### 10.5 HTTP 错误 JSON

 GET 错误响应使用 `application/json; charset=utf-8`，结构与 BLE 错误一致，并增加 HTTP 操作名 `recording.download`。HEAD 的错误响应不发送 body。 以下 JSON 示例适用于 GET。

token 无效或已过期：

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Connection: close
```

```json
{
  "schema_version": 1,
  "op": "recording.download",
  "ok": false,
  "error": {
    "code": "unauthorized",
    "message": "Bearer token is invalid or expired",
    "retryable": false
  }
}
```

录音不存在：

```http
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Connection: close
```

```json
{
  "schema_version": 1,
  "op": "recording.download",
  "ok": false,
  "error": {
    "code": "recording_not_found",
    "message": "Recording does not exist",
    "retryable": false,
    "details": {
      "recording_id": "20260903_153000.wav"
    }
  }
}
```

`If-Match` 指定的 generation 已变化：

```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/json; charset=utf-8
ETag: "gen-00000003-d42e"
Cache-Control: no-store
Connection: close
```

```json
{
  "schema_version": 1,
  "op": "recording.download",
  "ok": false,
  "error": {
    "code": "resume_mismatch",
    "message": "Recording generation does not match",
    "retryable": false,
    "details": {
      "expected_generation": "gen-00000002-91bd",
      "actual_generation": "gen-00000003-d42e"
    }
  }
}
```

Range 起点超出文件末尾：

```http
HTTP/1.1 416 Range Not Satisfiable
Content-Type: application/json; charset=utf-8
Content-Range: bytes */320044
Cache-Control: no-store
Connection: close
```

```json
{
  "schema_version": 1,
  "op": "recording.download",
  "ok": false,
  "error": {
    "code": "range_not_satisfiable",
    "message": "Requested byte range is outside the file",
    "retryable": false,
    "details": {
      "file_size": 320044,
      "requested_start": 400000
    }
  }
}
```

### 10.6 下载完成与文件校验

HTTP `200` 或 `206` 只表示本次网络传输成功。App 应检查以下条件：

- 最终文件长度等于 `recording.file_bytes`。
- SHA-256 与 `recording.checksum_sha256` 相同。
- 校验覆盖范围严格遵循 `recording.checksum_scope`。
- 本地文件已原子落盘，不再只是缓存或临时文件。

当前 `checksum_scope = audio_payload`，因此 HTTP 下载完整 WAV 后，App 必须按 RIFF chunk 结构找到 `data` chunk，并只对其中的 PCM bytes 计算 SHA-256；不得假设 WAV 头固定为 44 字节。

若网络中断，App 保留已经落盘的前缀字节，重新获取 `wifi_offer` 后使用相同 generation 和 Range 继续下载。generation 已变化时必须删除旧临时文件并从 0 开始。

## 11. 事件

事件使用第 3.1 节的 JSON 帧，通过 Control TX 发送。事件没有 `command_id` 和 `ok` 字段；Control TX 上不包含 `ok` 的 JSON 即为事件。事件只描述已经发生的状态变化；控制命令成功应答不能替代对应事件。

### 11.0 capture.requested

设备录音键被按下且 App 已连接并完成 `hello` 时发送：

```json
{
  "schema_version": 1,
  "op": "capture.requested",
  "request_id": "key-4a21bc90",
  "source": "device",
  "timeout_ms": 300
}
```

该事件表示设备正在等待本次按键录音的同步选择，尚未开始采集。App 应在
`timeout_ms` 内发送 `capture.request.resolve`；未及时回复时设备自动开始本地
录音，并且本次录音不发送实时 PCM。

### 11.1 capture.started

```json
{
  "schema_version": 1,
  "op": "capture.started",
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31",
  "recording_id": "20260903_153000.wav",
  "stream_id": 182736451,
  "source": "device",
  "audio": {
    "codec": "pcm_s16le",
    "sample_rate_hz": 16000,
    "bits_per_sample": 16,
    "channels": 1,
    "local_storage": true
  }
}
```

`source` 固定为 `device`，表示录音由设备主动发起并通过事件通知 App。

### 11.2 capture.paused

```json
{
  "schema_version": 1,
  "op": "capture.paused",
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31",
  "source": "device"
}
```

### 11.3 capture.resumed

```json
{
  "schema_version": 1,
  "op": "capture.resumed",
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31",
  "source": "device"
}
```

`capture.paused` 和 `capture.resumed` 的 `source` 固定为 `device`。

### 11.4 capture.finished

```json
{
  "schema_version": 1,
  "op": "capture.finished",
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31",
  "recording_id": "20260903_153000.wav",
  "generation": "gen-00000001-7c9a",
  "stream_id": 182736451,
  "source": "device",
  "reason": "device",
  "samples": 160000,
  "audio_bytes": 320000,
  "file_bytes": 320044,
  "duration_ms": 10000,
  "checksum_sha256": "sha256:4e810e1f2bcd4fdc6e62a08b481c4d083b394765b26d13b50c1d54b70f50158c",
  "checksum_scope": "audio_payload"
}
```

`source` 和 `reason` 固定为 `device`。`audio_bytes` 是 WAV `data` chunk 中的 PCM 字节数，`file_bytes` 是包含 RIFF/WAV 头和其他 chunk 的完整存储文件大小。`checksum_scope = audio_payload` 表示 SHA-256 只覆盖 PCM，不包含容器头或元数据。

### 11.5 capture.interrupted

```json
{
  "schema_version": 1,
  "op": "capture.interrupted",
  "session_id": "ses-018f6ec0-cf42-79c4-8c39-7ab351a8dd31",
  "reason": "storage_failed"
}
```

`reason` 当前可取 `storage_failed`、`audio_failed`、`device_reset` 或 `internal_error`。中断后 App 应调用 `status.get` 和 `recording.list` 恢复状态，不得假定录音文件一定不存在。

### 11.6 transport.wifi.state_changed

设备的 Wi-Fi 状态发生变化时发送：

```json
{
  "schema_version": 1,
  "op": "transport.wifi.state_changed",
  "state": "client_connected",
  "client_ipv4": "192.168.4.2",
  "reason": null
}
```

`state` 取值与 `transport.wifi.status.wifi.state` 相同。进入 `off` 时 `client_ipv4` 为 `null`，`reason` 可取 `app`、`expired`、`client_disconnected` 或 `internal_error`；其他状态的 `reason` 为 `null`。

### 11.7 transfer.finished

```json
{
  "schema_version": 1,
  "op": "transfer.finished",
  "transport": "ble",
  "recording_id": "20260903_153000.wav",
  "generation": "gen-00000002-91bd",
  "stream_id": 92837465,
  "start_pcm_offset": 1280,
  "sent_audio_bytes": 640,
  "total_audio_bytes": 320000,
  "reason": "completed"
}
```

`reason` 可取 `completed` 或 `internal_error`。取消读取不发送该事件。`completed` 只表示设备已完成本次 PCM 请求范围的发送；App 仍须独立检查全部缺口、`audio_bytes` 和 SHA-256。

## 12. 实时音频

| 参数 | 当前值 |
| --- | --- |
| `kind` | `0x10` |
| `codec` | `pcm_s16le` |
| 采样率 | `16000 Hz` |
| 位深 | `16-bit` |
| 声道 | `1` |
| 字节序 | little-endian |
| 普通帧 PCM |  按第 3.2 节计算；MTU 517 时为 `492 bytes` |
| 普通帧采样数 | `246` |
| 普通帧时长 | `15.375 ms` |
| `stream_id` | 来自 `capture.started.stream_id` |
| 音频帧头 | 第 3.2 节的 20 字节帧头 |
| 结束帧 | 只有音频帧头，`flags = 0x01` |

每个 Audio TX Notify 使用第 3.2 节的独立音频帧格式。 普通实时帧的 PCM 上限按第 3.2 节计算；MTU 517 时最多携带 492 bytes PCM，即 246 个 `pcm_s16le` 单声道采样。最后一个数据帧可以少于当前连接的 PCM 上限，但必须按 `block_align = 2` 对齐。

实时帧与 `kind = 0x11` 补传帧使用同一个 PCM 偏移空间。App 按音频帧头中的 `pcm_offset` 写入临时 PCM 文件；偏移跳变时记录缺口，录音结束后通过 `recording.audio.read` 修复。实时流的 `sequence` 从 1 连续递增。

结束帧沿用相同 `stream_id`，没有 PCM，Notify 总长度为 20 bytes，`flags.bit0 = 1`。最终权威的 `samples` 和 `audio_bytes` 以来自设备完成落盘后的 `capture.finished` 为准。

## 13. 公共对象定义

### 13.1 recording

```json
{
  "recording_id": "20260903_153000.wav",
  "generation": "gen-00000001-7c9a",
  "container": "wav",
  "audio": {
    "codec": "pcm_s16le",
    "sample_rate_hz": 16000,
    "bits_per_sample": 16,
    "channels": 1,
    "local_storage": true
  },
  "samples": 160000,
  "audio_bytes": 320000,
  "file_bytes": 320044,
  "duration_ms": 10000,
  "checksum_sha256": "sha256:4e810e1f2bcd4fdc6e62a08b481c4d083b394765b26d13b50c1d54b70f50158c",
  "checksum_scope": "audio_payload",
  "created_epoch_ms": 1787900000000,
  "recovered": false
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `recording_id` | string | 录音文件名；执行 `recording.rename` 后随文件名一起变化 |
| `generation` | string | 根据录音文件修改时间和大小动态生成的文件版本；重命名不更新该值 |
| `container` | string | 当前固定为 `wav` |
| `audio` | object | 实际录音格式 |
| `samples` | integer | 每声道 PCM 采样数 |
| `audio_bytes` | integer | WAV `data` chunk 中的 PCM 总字节数，也是 BLE 音频偏移的上限 |
| `file_bytes` | integer | 完整 WAV 存储文件的总字节数，也是 HTTP Content-Length |
| `duration_ms` | integer | 有效录音时长，不含暂停时间 |
| `checksum_sha256` | string | `sha256:` 加 64 位小写十六进制摘要 |
| `checksum_scope` | string | 当前固定为 `audio_payload` |
| `created_epoch_ms` | integer | 录音开始时间 |
| `recovered` | boolean | 是否由设备启动恢复流程找回 |

### 13.2 wifi_offer

```json
{
  "ssid": "LaoJi-a0ed30",
  "password": "example-only",
  "base_url": "http://192.168.4.1",
  "recording_base_path": "/recording/",
  "bearer_token": "b64url-token-value",
  "security_mode": "development_http",
  "certificate_sha256": null,
  "expires_epoch_ms": 1787900120000,
  "expires_in_ms": 120000
}
```

## 14. 错误码

| code | 常见场景 | 默认可重试 |
| --- | --- | --- |
| `unsupported_protocol` | `hello` 没有共同协议版本 | 否 |
| `unsupported_operation` | `op` 未实现或能力未开启 | 否 |
| `invalid_state` | 当前状态不允许该操作 | 否 |
| `busy` | 设备正在处理互斥任务 | 是 |
| `capture_unavailable` | 音频采集硬件或服务不可用 | 是 |
| `storage_full` | 存储空间不足；清理空间后可重试 | 是 |
| `resume_mismatch` | `expected_generation` 与当前 generation 不一致 | 否 |
| `recording_not_found` | 指定录音不存在 | 否 |
| `recording_already_exists` | 重命名的目标文件名已经存在 | 否 |
| `transfer_not_found` | 指定 BLE 音频传输不存在；已知且已结束的传输按第 8.6 节取消仍成功 | 否 |
| `invalid_range` | BLE PCM 读取的 offset 或 length 越界或未按 block_align 对齐 | 否 |
| `unauthorized` | HTTP bearer token 无效或已过期 | 否 |
| `range_not_satisfiable` | HTTP Range 超出文件边界 | 否 |
| `internal_error` | 未分类内部错误 | 是 |

generation 冲突示例：

```json
{
  "schema_version": 1,
  "op": "recording.rename",
  "command_id": "cmd-recording-rename-0001",
  "ok": false,
  "error": {
    "code": "resume_mismatch",
    "message": "Recording generation does not match",
    "retryable": false,
    "details": {
      "recording_id": "20260903_153000.wav",
      "expected_generation": "gen-00000001-7c9a",
      "actual_generation": "gen-00000002-91bd"
    }
  }
}
```

未知操作示例：

```json
{
  "schema_version": 1,
  "op": "device.unknown",
  "command_id": "cmd-device-unknown-0001",
  "ok": false,
  "error": {
    "code": "unsupported_operation",
    "message": "Operation is not supported",
    "retryable": false,
    "details": {
      "operation": "device.unknown"
    }
  }
}
```

## 15. 命令与事件汇总

| op | 请求参数（不含公共字段） | 成功应答字段（不含公共字段） | 后续事件 |
| --- | --- | --- | --- |
| `hello` | `app`、`supported_protocols`、`transports` | `protocol`、`device`、`security`、`capabilities` | - |
| `status.get` | - | `status` | - |
| `time.sync` | `epoch_ms`、`time_zone` | - | - |
| `diagnostics.ping` | - | - | - |
| `capture.request.resolve` | `request_id`、`live_stream` | `request_id`、`live_stream` | `capture.started` |
| `capture.start` | `session_id`、`audio`（`live_stream` 可选） | `session_id`、`recording_id` | `capture.started` 或 `capture.interrupted` |
| `capture.pause` | `session_id` | `session_id` | `capture.paused` |
| `capture.resume` | `session_id` | `session_id` | `capture.resumed` |
| `capture.stop` | `session_id` | `session_id` | `capture.finished` 或 `capture.interrupted` |
| `recording.list` | `cursor`（可选）、`limit`（可选） | `recordings`、`next_cursor` | - |
| `recording.get` | `recording_id` | `recording` | - |
| `recording.rename` | `recording_id`、`expected_generation`、`new_recording_id` | - | - |
| `recording.delete` | `recording_id`、`expected_generation` | `recording_id` | - |
| `recording.audio.read` | `recording_id`、`expected_generation`、`offset`、`length`（可选） | `transfer` | `transfer.finished` |
| `recording.audio.read.cancel` | `stream_id` | `stream_id` | - |
| `transport.wifi.offer` | - | `wifi_offer` | `transport.wifi.state_changed` |
| `transport.wifi.status` | - | `wifi` | - |
| `transport.wifi.close` | - | - | `transport.wifi.state_changed` |

| HTTP 操作 | 作用 | 成功状态 | 相关事件 |
| --- | --- | --- | --- |
| `HEAD /recording/{recording_id}` | 查询长度、generation 和续传能力 | `200` | - |
| `GET /recording/{recording_id}` | 下载完整文件 | `200` | - |
| `GET` + `Range` | 断点续传 | `206` | - |

| BLE 录音数据 | 通道 | 音频 kind | 帧格式 |
| --- | --- | --- | --- |
| `recording.audio.read` 数据流 | Audio TX Notify | `0x11` | 20 字节音频帧头 + 当前连接动态 PCM |

## 16. 可选扩展：实时短范围恢复

本扩展复用BLE 1.3基本帧；仅在 `hello.capabilities.capture.live_range_repair` 存在时使用。当前源码实现声明 `max_bytes=32768`、`retention_bytes=262144`，缺少能力时按原实时链路和结束后完整校验工作。

| 操作 | 请求 | 成功应答 |
| --- | --- | --- |
| `capture.audio.read` | `session_id`、原实时 `stream_id`、偶数 `offset`、正偶数 `length`（不超过声明上限） | `transfer`：`transport=ble`、`session_id`、`source_stream_id`、新的 `stream_id`、`offset_scope=audio_payload`、`offset`、`length`、当前 MTU 的 `chunk_size_bytes` |
| `capture.audio.read.cancel` | 回读 `stream_id` | 同一 `stream_id`；当前或最近已结束的回读可取消 |

数据仍用原 20 字节音频头，kind `0x11`、独立序号从 1、绝对源偏移，最后一帧 FINAL。源必须是同一活动/暂停的实时 capture，且整个请求仍在环形缓存内；不支持已结束/被覆盖/未来范围，返回 `source_range_unavailable`，不填静音、不改时间轴。只允许一个最多 32 KiB 的不可变快照与发送任务；发送绝对期限 2 秒，取消/断开/停止后释放。手机最多缓存 128 KiB/512 帧，缺口 3 秒内未恢复就封住有效前缀，结束后沿原完整来源链恢复。该扩展不增加逐包 ACK、录音文件身份或新的会议状态 owner。
