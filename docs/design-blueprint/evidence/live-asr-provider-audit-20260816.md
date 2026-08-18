# 老记 ASR Provider 现场审计 2026-08-16

## 范围与时间

- 只读 SSH 检查：2026-08-16 06:42 Asia/Shanghai
- 服务器：`183.36.243.124`
- 未重启、未改配置、未安装依赖、未访问用户录音或笔记。
- 进程归属只按 `laoji-*` systemd 服务和工作目录判断；Smart Meeting 历史目录不自动归入老记。

## 现场事实

| 项目 | 观察 |
|---|---|
| `laoji-asr.service` | active/running，`qwen_asr_service/server.py` |
| 8030 health/ready | ready；模型 `$SERVER_DEPLOYMENT_ROOT/models/qwen3-asr/Qwen3-ASR-1.7B` |
| ASR revision | `7278e1e70fe206f11671096ffdd38061171dd6e5` |
| ASR device | `cuda:0`；`max_batch_size=8` |
| 最近一次推理记录 | priority `offline`、batch 3、queue 12ms、infer 587ms；这是历史单次观测，不是 p95 |
| Qwen 环境 | `qwen_asr`、Torch `2.12.1+cu130`、Transformers `4.57.6` 存在 |
| Qwen 环境缺失 | `vllm`、`funasr`、`modelscope`、`onnxruntime` 均未安装 |
| 运行服务 | `laoji-api.service`、`laoji-asr.service`、`laoji-ollama.service` active/running |

## GPU 余量

同一时刻 `nvidia-smi` 只读结果：

| GPU | 总显存 | 已用 | 空闲 | GPU 利用率 |
|---|---:|---:|---:|---:|
| 0 | 32607 MiB | 29872 MiB | 2240 MiB | 0% |
| 1 | 32607 MiB | 25949 MiB | 6163 MiB | 0% |

这不能支持“直接再常驻一个完整 streaming provider”的假设。尤其 GPU0 是
当前老记 ASR 的设备，新增 vLLM/FunASR、ForcedAligner 或第二份 Qwen 模型前，
必须先有隔离显存预算和并发回放。

## FunASR / vLLM 判断

- `$SERVER_HOME` 下能找到 FunASR wheel、旧 Smart Meeting 的 FunASR 脚本和历史转写
  文件，但当前进程列表没有运行中的 `funasr` 或 `vllm` 服务。
- `qwen3asr-venv` 中没有 `vllm`，因此不能仅通过改 8030 URL 或事件名启用 Qwen
  官方 streaming；需要额外运行时、显存和安装/回滚方案。
- 历史 Smart Meeting 目录的文件不能作为老记依赖证据；其归属曾被明确纠正，
  本审计不触碰、不复用、不停止。

## 对蓝图的影响

1. C0 当前 Qwen Transformers 路径仍是唯一已运行的老记 ASR provider。
2. M1 可以先做 provider/watermark 合同和离线 replay，不要求生产机同时加载第二
   个模型。
3. Qwen streaming 和 FunASR/Paraformer 只能在独立环境或另一张有明确余量的 GPU
   上做 A/B；当前不能把它们写入生产依赖或宣称速度收益。
4. 8030 的单 worker/优先级队列仍是首要实测对象；587ms 单次记录只能用于确认接口
   正常，不能证明实时 p95 或并发能力。

## 08:29 复核补充

2026-08-16 08:29 Asia/Shanghai 再次只读核对：

- 三个服务实际是 system unit；`systemctl show` 均为 active/running。使用
  `systemctl --user show` 会得到 inactive/dead 的假阴性，不能据此判断停服。
- API、ASR、Ollama 进程 cwd 与 systemd ExecStart 均指向
  `$SERVER_DEPLOYMENT_ROOT/compact-production` 对应目录。
- 18020/8030 ready，ASR queue depth 为 0；GPU0 空闲约 2.5 GiB，GPU1 空闲约
  6.1 GiB。GPU1 仅观察，不作为候选部署资源。
- 生产的 `qwen_ws.py`、`compact_transcription_service.py`、8030 `server.py` 与
  `$SERVICE_REPO` 中对应文件 SHA-256 一致。

该复核只证明现场与本地源码没有这三处漂移，不改变“无真实 ASR p95/CER/DER”结论。
