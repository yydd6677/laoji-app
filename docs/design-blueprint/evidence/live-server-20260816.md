# 运行证据：服务器 2026-08-16

## 范围

只读 SSH 检查，时间为 2026-08-16 Asia/Shanghai。该记录证明现场观察到的进程和端口，不证明它们都属于老记，也不授权修改或停止任何进程。

## 老记相关入口

| 入口 | 现场状态 | 观察 |
|---|---|---|
| `127.0.0.1:18020` | 监听 | `laoji-api.service`，cwd 为 `$SERVER_DEPLOYMENT_ROOT/compact-production/backend` |
| `127.0.0.1:8030` | 监听 | `laoji-asr.service`，Qwen3-ASR-1.7B |
| `127.0.0.1:21434` | 监听 | `laoji-ollama.service`，`qwen3.5:9b` 和 `qwen3-embedding:0.6b` |
| `cloudflared.service` | 运行 | systemd 配置指向 `127.0.0.1:18020` |

`/api/ready` 返回 ready，但累计任务计数为 `success=51`、`failure=16`；健康探针不能代替质量验收。最近观测到 `summary.facts.v3` 约 20.7 秒、问答 embedding 约 6.5 秒。

## 同机其他运行时

现场还存在：

- `127.0.0.1:11434` 的另一套 Ollama，当前加载 `qwen3:32b`，约 22.6 GB VRAM；
- Smart Meeting `8020`；
- 另一个手动 Cloudflare Tunnel 进程；
- 多个其他 uvicorn/Python 服务。

不能根据端口或模型名称把这些进程归入老记，也不能自动停止它们。

## GPU 观察

现场 `nvidia-smi` 显示 GPU0/GPU1 均有老记或其他服务共同占用。GPU0 上可见 PCB、ASR、多个 Python 服务和老记 Ollama runner；GPU1 上可见另一套 Ollama 32B 与 Smart Meeting。当前不具备盲目加载第二个老记大模型或把并行度升高的条件。

## 架构结论

最高杠杆问题不是先调 `qwen3.5:9b` 的参数，而是建立老记自己的“认知运行时边界”：统一任务、证据、Provider、资源准入和结果投影，同时明确隔离外部服务。任何模型替换都必须在这个边界内作为可交换 Provider 进行回放。
