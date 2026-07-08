# 客户端实时 ASR 接口 - 使用说明

## 目录

- [概述](#概述)
- [服务地址](#服务地址)
- [接口总览](#接口总览)
- [命令行测试流程](#命令行测试流程)
- [实时麦克风监听测试脚本](#实时麦克风监听测试脚本)
- [说话人声纹注册](#说话人声纹注册)
- [浏览器客户端 PCM 转换要点](#浏览器客户端-pcm-转换要点)
- [常见问题](#常见问题)


## 概述

本系统提供实时会议语音识别接口，供客户端接入会议录音、麦克风、系统音频或电话流。

和“上传完整音频文件，然后轮询任务结果”的接口不同，当前项目使用 **WebSocket 实时推流**：

```text
客户端持续发送 PCM 音频帧
        ↓
后端实时 ASR 识别
        ↓
后端持续返回转写句子
        ↓
会议结束后客户端发送结束帧
        ↓
客户端调用总结接口，稍后查询会议总结和转写结果
```


---

## 服务地址

### 后端主服务

```text
http://183.36.243.124:8020
ws://183.36.243.124:8020
```

如部署 HTTPS / WSS，请使用部署方提供的安全地址：

```text
https://<域名或IP>:<端口>
wss://<域名或IP>:<端口>
```

### 端口说明

| 服务 | 端口 | 客户端是否直接访问 | 说明 |
| --- | --- | --- | --- |
| 后端主服务 | `8020` | 是 | REST API 和实时 ASR WebSocket |
| 前端页面代理 | `5179` | 可选 | 浏览器页面入口，非接口测试首选 |
| Qwen ASR 内部服务 | `8030` | 否 | 后端内部调用；Qwen 模式依赖它启动 |

---

## 接口总览

### 实时 ASR WebSocket 接口

| 接口 | 协议 | 作用 |
| --- | --- | --- |
| `/ws/meeting/{meeting_id}/funasr` | WebSocket | FunASR 实时中文识别，推荐优先测试 |
| `/ws/meeting/{meeting_id}/whisper` | WebSocket | Whisper 实时识别，转写质量较高，延迟可能更大 |
| `/ws/meeting/{meeting_id}/qwen` | WebSocket | Qwen 近实时识别，依赖服务端 `8030` 微服务 |

### REST 辅助接口

| 接口 | 方法 | 作用 |
| --- | --- | --- |
| `/api/health` | `GET` | 检查后端和模型状态 |
| `/api/meetings` | `POST` | 创建会议，获取后端生成的 `meeting_id` |
| `/api/meetings/{meeting_id}` | `GET` | 查询会议基本信息 |
| `/api/meetings/{meeting_id}/transcripts` | `GET` | 查询会议转写结果 |
| `/api/meetings/{meeting_id}/downloads/transcript` | `GET` | 下载 Markdown 转写文档 |
| `/api/meetings/{meeting_id}/summaries/generate` | `POST` | 触发会议总结生成 |
| `/api/meetings/{meeting_id}/summaries/final` | `GET` | 查询最终会议总结 |
| `/api/meetings/{meeting_id}/summaries/task/{task_id}` | `GET` | 查询总结任务状态 |
| `/api/speakers/register` | `POST` | 注册说话人声纹 |
| `/api/speakers` | `GET` | 查询已注册说话人 |

---


## 命令行测试流程

### 步骤 1：健康检查

```bash
curl http://183.36.243.124:8020/api/health
```

正常响应示例：

```json
{
  "status": "ok",
  "env": "local",
  "models_ready": true,
  "models": {
    "funasr": true,
    "punc": true,
    "vad": true,
    "campplus": true,
    "campplus_en": true
  }
}
```

如果 `models_ready` 不是 `true`，实时 ASR 可能还在加载或不可用。

---

### 步骤 2：创建会议

Linux / macOS / Git Bash：

```bash
curl -X POST http://183.36.243.124:8020/api/meetings \
  -H "Content-Type: application/json" \
  -d '{
    "title": "客户端实时 ASR 测试会议",
    "description": "接口联调测试",
    "participants": ["张三", "李四"],
    "mode": "realtime"
  }'
```

Windows CMD：

```bat
curl.exe -X POST http://183.36.243.124:8020/api/meetings ^
  -H "Content-Type: application/json" ^
  -d "{\"title\":\"客户端实时 ASR 测试会议\",\"description\":\"接口联调测试\",\"participants\":[\"张三\",\"李四\"],\"mode\":\"realtime\"}"
```

Windows PowerShell：

```powershell
curl.exe -X POST "http://183.36.243.124:8020/api/meetings" `
  -H "Content-Type: application/json" `
  -d '{"title":"客户端实时 ASR 测试会议","description":"接口联调测试","participants":["张三","李四"],"mode":"realtime"}'
```

> Windows CMD 不支持用单引号包 JSON。若直接复制 Linux 示例，会出现 `JSON decode error`、`URL rejected` 或中文变成乱码的错误。CMD 中请使用上面的转义双引号写法，或把 JSON 保存成文件后用 `--data-binary @body.json`。

响应示例：

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "客户端实时 ASR 测试会议",
  "description": "接口联调测试",
  "status": "created",
  "participants": ["张三", "李四"],
  "mode": "realtime",
  "created_at": "2026-07-07T10:00:00",
  "updated_at": "2026-07-07T10:00:00"
}
```

后续 WebSocket 地址中的 `{meeting_id}` 使用这里返回的 `id`。

> 注意：如果手动执行本步骤创建会议，后续运行 Python 脚本时必须把响应里的 `id` 传给 `--meeting-id`。否则脚本会生成新的临时 `meeting_id`，实时转写能在控制台看到，但转写不会保存到刚刚创建的会议里，步骤 7 查询转写会查不到。

> 如果客户端只测试实时识别，也可以自行生成 UUID 作为 `meeting_id`，不强制先创建会议。但要会后查询转写和总结，建议先创建会议。

---

### 步骤 3：连接实时 ASR WebSocket

推荐先测试 FunASR：

```text
ws://183.36.243.124:8020/ws/meeting/550e8400-e29b-41d4-a716-446655440000/funasr
```

其他模式：

```text
ws://183.36.243.124:8020/ws/meeting/{meeting_id}/whisper
ws://183.36.243.124:8020/ws/meeting/{meeting_id}/qwen
```

连接成功后，服务端会先返回：

```json
{
  "type": "config",
  "useAudioWorklet": true,
  "mode": "full"
}
```

---

### 步骤 4：客户端持续发送 PCM 音频帧

客户端发送的不是 WAV 文件、MP3、WebM 或 base64，而是 **裸 PCM 二进制帧**。

音频格式要求：

| 参数 | 要求 |
| --- | --- |
| 编码 | PCM 原始裸流 |
| 采样率 | `16000 Hz` |
| 声道 | 单声道 mono |
| 位深 | `16-bit signed int` |
| 字节序 | little-endian |
| 帧长 | 建议 20-100ms |
| 每帧大小 | 约 640-3200 字节 |

客户端要做的处理：

```text
采集会议音频
  -> 解码成 PCM
  -> 降混为单声道
  -> 重采样到 16kHz
  -> 转成 int16 little-endian
  -> 每 20-100ms 通过 WebSocket binary frame 发送
```

浏览器客户端通常是：

```text
getUserMedia / 屏幕共享音频
  -> AudioContext / AudioWorklet
  -> Float32 音频帧
  -> 重采样到 16kHz
  -> Float32 转 Int16
  -> websocket.send(ArrayBuffer)
```

桌面或服务端中转客户端通常是：

```text
麦克风 / 声卡 / 电话流 / ffmpeg
  -> 16kHz mono s16le PCM
  -> websocket.send(binary)
```

---

### 步骤 5：接收实时转写结果

服务端返回 JSON 文本帧。识别出一句后会返回：

```json
{
  "type": "transcript.completed",
  "source": "funasr",
  "speaker_id": "speaker_1",
  "speaker_name": "speaker_1",
  "text": "大家好，今天会议开始。",
  "start_ms": 1200,
  "end_ms": 4300,
  "start_time": 1.2,
  "end_time": 4.3,
  "is_final": true,
  "speaker_confidence": 1.0,
  "identified": false,
  "best_guess_name": null,
  "best_guess_score": null
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `type` | 消息类型，转写结果固定为 `transcript.completed` |
| `source` | ASR 来源：`funasr`、`whisper`、`qwen` |
| `speaker_id` | 说话人 ID，未识别时为 `speaker_1` 等匿名编号 |
| `speaker_name` | 展示名；声纹匹配成功时可能为真实姓名 |
| `text` | 转写文本 |
| `start_ms` / `end_ms` | 当前句子在音频流中的起止时间，单位毫秒 |
| `start_time` / `end_time` | 当前句子起止时间，单位秒 |
| `identified` | 是否确认匹配声纹库人员 |
| `best_guess_name` | 最高分候选人，可能未达到确认阈值 |

---

### 步骤 6：会议结束，发送结束帧

会议结束时，客户端发送一个空二进制帧：

```python
await ws.send(b"")
```

服务端会停止接收音频，尽量冲刷剩余识别结果，然后返回：

```json
{
  "type": "ready_to_stop"
}
```

客户端收到 `ready_to_stop` 后可以断开 WebSocket。

> 注意：当前实时 ASR WebSocket 收到结束帧后，会停止识别并保存转写，但不会自动生成会议总结。总结需要客户端额外调用 REST 接口触发。

---

### 步骤 7：查询转写结果

```bash
curl "http://183.36.243.124:8020/api/meetings/550e8400-e29b-41d4-a716-446655440000/transcripts?limit=1000&offset=0"
```

响应示例：

```json
{
  "items": [
    {
      "id": "line-id",
      "meeting_id": "550e8400-e29b-41d4-a716-446655440000",
      "speaker_id": "speaker_1",
      "speaker_label": "speaker_1",
      "text": "大家好，今天会议开始。",
      "start_time": 1.2,
      "end_time": 4.3,
      "confidence": 1.0,
      "created_at": "2026-07-07T10:00:05"
    }
  ],
  "total": 1
}
```

---

### 步骤 8：触发会议总结

会议结束后，由客户端主动触发总结：

```bash
curl -X POST "http://183.36.243.124:8020/api/meetings/550e8400-e29b-41d4-a716-446655440000/summaries/generate?summary_type=final"
```

响应示例：

```json
{
  "message": "最终总结任务已提交",
  "task_id": "summary-task-id",
  "transcript_count": 42
}
```

查询总结任务状态：

```bash
curl "http://183.36.243.124:8020/api/meetings/550e8400-e29b-41d4-a716-446655440000/summaries/task/summary-task-id"
```

任务状态说明：

| 状态 | 含义 | 客户端动作 |
| --- | --- | --- |
| `PENDING` | 任务已提交，等待执行或排队中 | 等待 20-30 秒后重试 |
| `STARTED` | 总结正在生成 | 继续轮询 |
| `SUCCESS` | 总结生成成功 | 调用 `/summaries/final` 获取最终总结 |
| `FAILURE` | 总结生成失败 | 查看 `result` 中的错误信息 |

实测 10 分钟左右音频、44 条转写的总结任务，状态会经历：

```text
PENDING -> STARTED -> SUCCESS
```

`SUCCESS` 响应示例：

```json
{
  "task_id": "ffdcb42a-683a-4843-8961-76bf03bb3140",
  "status": "SUCCESS",
  "result": {
    "summary_id": "57858d6a-b18c-44c6-a857-9e102ec7ee6a",
    "overview": "会议围绕会议总结功能的开发进展展开，确认了系统结构化与可视化展示的实现情况，并计划进一步完善功能。",
    "key_decisions": [
      "由刘总负责推进会议总结功能的开发工作。"
    ],
    "action_items": [
      {
        "content": "完善会议总结功能的可视化展示。",
        "assignee": "待定",
        "due_date": null,
        "status": "pending"
      }
    ]
  }
}
```

---

### 步骤 9：查询最终会议总结

```bash
curl "http://183.36.243.124:8020/api/meetings/550e8400-e29b-41d4-a716-446655440000/summaries/final"
```

响应示例：

```json
{
  "id": "summary-id",
  "meeting_id": "550e8400-e29b-41d4-a716-446655440000",
  "overview": "本次会议主要讨论了项目进度、风险和下一步安排。",
  "full_text": "本次会议主要讨论了项目进度、风险和下一步安排。",
  "markdown": "# 会议总结\n\n## 概要\n...",
  "raw_json": {},
  "key_decisions": [],
  "action_items": [],
  "generated_at": "2026-07-07T10:10:00Z"
}
```

---

## 实时麦克风监听测试脚本

如果要模拟真实客户端“开始监听 -> 持续推送麦克风 PCM -> Ctrl+C 结束 -> 触发总结”的流程，使用：

```text
tools/live_asr_mic_client.py
```

该脚本会：

1. 默认调用 `POST /api/meetings` 自动创建会议。
2. 打开本机默认麦克风。
3. 以 `16kHz / mono / signed int16 PCM` 采集音频。
4. 持续通过 WebSocket binary frame 推送 PCM。
5. 实时打印服务端返回的转写结果。
6. 按 Ctrl+C 后停止录音，发送空二进制结束帧 `b""`。
7. 收到 `ready_to_stop` 后退出。
8. 如果传入 `--auto-summary`，会自动触发最终总结并轮询到 `SUCCESS`。

### 1. 安装依赖

```bat
pip install websockets sounddevice
```

如果 Windows 安装 `sounddevice` 后无法打开麦克风，通常需要检查系统麦克风权限，或安装/修复本机音频驱动。

### 2. 运行实时监听

Windows CMD：

```bat
python live_asr_mic_client.py --title "实时麦克风测试会议" --host 183.36.243.124 --port 8020 --api-base-url http://183.36.243.124:8020 --mode funasr
```

PowerShell：

```powershell
python .\live_asr_mic_client.py --title "实时麦克风测试会议" --host 183.36.243.124 --port 8020 --api-base-url http://183.36.243.124:8020 --mode funasr
```

预期输出：

```text
[meeting_id] 7b0f4d51-0d0e-4b40-8f5d-2d942fce2ef1
[websocket] ws://183.36.243.124:8020/ws/meeting/7b0f4d51-0d0e-4b40-8f5d-2d942fce2ef1/funasr
[audio] capture: 16000 Hz, mono, signed 16-bit PCM
[control] press Ctrl+C to stop, send end frame, and finish gracefully
[websocket] connected
[audio] recording started
[recv] config: {"type": "config", "useAudioWorklet": true, "mode": "full"}
[   1.20s-   4.30s] speaker_1: 大家好，今天会议开始。
```

会议结束时按 Ctrl+C。正常输出：

```text
[send] end frame sent
[recv] ready_to_stop
[done] transcripts=12 elapsed=180.5s meeting_id=7b0f4d51-0d0e-4b40-8f5d-2d942fce2ef1
[next] query transcripts: http://183.36.243.124:8020/api/meetings/7b0f4d51-0d0e-4b40-8f5d-2d942fce2ef1/transcripts?limit=1000&offset=0
```

### 3. 运行实时监听并自动总结

如果希望 Ctrl+C 后自动触发最终总结并轮询结果：

```bat
python live_asr_mic_client.py --title "实时麦克风自动总结测试" --host 183.36.243.124 --port 8020 --api-base-url http://183.36.243.124:8020 --mode funasr --auto-summary
```

Ctrl+C 后脚本会继续执行：

```text
[summary] submitted task_id=...
[summary] status=PENDING
[summary] status=STARTED
[summary] status=SUCCESS
[summary] final overview:
...
```

### 4. 使用指定麦克风设备

如果默认麦克风不是目标音源，可先用 Python 查看 sounddevice 设备列表：

```bat
python -m sounddevice
```

然后传入设备编号或名称：

```bat
python live_asr_mic_client.py --device 1 --title "指定麦克风测试" --host 183.36.243.124 --port 8020 --mode funasr
```

### 5. 常见问题

**实时说话时没有显示，按 Ctrl+C 后才显示最后一条**

这说明 WebSocket 和音频推流是通的，但服务端没有及时把已切出的语音段提交给 ASR，直到收到结束帧才 flush。服务端 `/funasr` 对外接口应启用低延迟提交模式：VAD 切出一个有效语音段后立即送 ASR，不再等待多个同说话人片段合并；如果 VAD 一直没有检测到静音，也会按最长 `6` 秒强制切段。

正常现象：

1. 开始说话时不会逐字返回。
2. 说完一句并停顿约 `1` 秒后，控制台应出现一条 `[start-end] speaker: text`。
3. 按 Ctrl+C 只负责结束会议和 flush 少量尾段，不应是第一次出现转写结果。

如果仍然只有 Ctrl+C 后才显示：

1. 确认后端已经重启到低延迟提交版本。
2. 查看后端日志，应出现：`[FunASR-API] 低延迟提交已开启`，并包含 `最长语音段 6s`、`能量门限 0.0002`。
3. 确认连接的是 `/ws/meeting/{meeting_id}/funasr`，不是旧的前端富协议或其他模式。
4. 再检查默认输入设备、电平和麦克风权限。

排查方式：

```bat
python live_asr_mic_client.py --title "麦克风电平测试" --host 183.36.243.124 --port 8020 --mode funasr --level-meter
```

观察 `[level]`：

```text
[level] rms=0.0123 peak=0.0845 gated=0 dropped=0
```

- 正常说话时 `rms` 应明显高于安静状态。
- 如果一直接近 `0.0000`，说明没有采到正确麦克风或权限不对。
- 如果安静时 `rms` 仍很高，说明环境噪声或输入设备底噪较大。
- 对 `/funasr` 实时接口，后端当前能量门限为 `0.0002`，约等于 RMS `0.0141`；正常说话 rms 应高于这个值。

脚本默认启用了客户端噪声门：低于 `--noise-gate-threshold` 的帧会替换成静音帧，帮助服务端更早断句。低噪环境下通常不需要调高阈值；如果怀疑噪声门影响测试，可以直接关闭：

```bat
python live_asr_mic_client.py --title "关闭噪声门测试" --host 183.36.243.124 --port 8020 --mode funasr --level-meter --no-noise-gate
```

如果环境底噪确实较大，再按环境调整：

```bat
python live_asr_mic_client.py --title "噪声门测试" --host 183.36.243.124 --port 8020 --mode funasr --level-meter --noise-gate-threshold 0.008
```

如果发现正常轻声说话也被吞掉，则降低阈值：

```bat
python live_asr_mic_client.py --title "噪声门测试" --host 183.36.243.124 --port 8020 --mode funasr --level-meter --noise-gate-threshold 0.002
```

**`Missing dependency. Install it with: pip install sounddevice`**

未安装麦克风采集依赖：

```bat
pip install sounddevice
```

**`Error opening RawInputStream`**

常见原因：

1. 系统没有可用麦克风。
2. Windows 麦克风权限未开启。
3. 默认设备不支持 16kHz mono int16 输入。
4. 被其他会议软件独占。

可先运行：

```bat
python -m sounddevice
```

查看设备列表后用 `--device` 指定输入设备。

**按 Ctrl+C 后还没退出**

脚本会先发送结束帧并等待服务端 `ready_to_stop`。如果音频尾段还在冲刷，可能需要等待几秒。

---

## 说话人声纹注册

如果需要实时结果返回真实姓名，而不是 `speaker_1`、`speaker_2`，需要提前注册说话人声纹。

### 注册声纹

```bash
curl -X POST http://183.36.243.124:8020/api/speakers/register \
  -F "name=张三" \
  -F "speaker_id=zhangsan" \
  -F "role=销售" \
  -F "department=华南区" \
  -F "audio=@/path/to/zhangsan.wav"
```

音频建议：

| 项 | 建议 |
| --- | --- |
| 时长 | 2-15 秒 |
| 内容 | 自然朗读或真实说话 |
| 环境 | 安静、音量适中 |
| 格式 | WAV、MP3、M4A、OGG、FLAC 等常见格式 |

响应示例：

```json
{
  "success": true,
  "speaker_id": "zhangsan",
  "name": "张三",
  "message": "「张三」声纹注册成功！",
  "quality": 0.78,
  "quality_level": "良好",
  "quality_description": "声纹特征较明显，识别效果良好",
  "sample_count": 1,
  "total_duration": 8.5,
  "quality_issues": []
}
```

### 查询已注册说话人

```bash
curl http://183.36.243.124:8020/api/speakers
```

---


## 浏览器客户端 PCM 转换要点

浏览器采集到的音频通常是 `Float32Array`，采样率可能是 44.1kHz 或 48kHz。客户端需要重采样并转换为 int16。

伪代码：

```javascript
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

// 得到 16kHz mono Float32Array 后：
const pcmBuffer = floatTo16BitPCM(resampledMonoFloat32)
websocket.send(pcmBuffer)
```

注意：上面只演示 Float32 转 int16，真实客户端还需要完成重采样到 16kHz。

---

## 常见问题

**Q: 能不能直接上传 WAV 文件？**  
A: 实时 WebSocket 不能直接发送完整 WAV 文件。WAV 文件有文件头，客户端测试时要用 `readframes()` 读取其中的 PCM 数据逐帧发送。

**Q: 能不能发送 MP3、WebM、Opus？**  
A: 不能。客户端需要先解码成 PCM，再重采样为 16kHz 单声道 int16。

**Q: 会议结束后是否自动总结？**  
A: 当前不会自动总结。客户端收到 `ready_to_stop` 后，需要调用 `/api/meetings/{meeting_id}/summaries/generate` 触发总结。

**Q: Qwen 模式为什么连接后返回错误？**  
A: Qwen 模式依赖服务端本机 `8030` Qwen-ASR 微服务。如果该服务未启动，会返回 `Qwen-ASR 微服务未就绪`。

**Q: 外部系统必须先创建会议吗？**  
A: 不必须。只做实时识别时可以自行生成 `meeting_id`。但如果要会后查询转写、生成总结、下载文档，建议先创建会议。

**Q: 转写结果什么时候可以查询？**  
A: 实时识别返回 `transcript.completed` 后，后端会异步保存。通常稍后即可通过 `/api/meetings/{meeting_id}/transcripts` 查询。
