# Stage 2 GPU ASR 候选测量

本次测量在服务器隔离候选目录执行，未修改 systemd、生产 `8030/18020`、GPU1 或公网。

## 运行边界

- 临时端口：`127.0.0.1:8032`
- 模型：`Qwen3-ASR-1.7B`
- model revision：`7278e1e70fe206f11671096ffdd38061171dd6e5`
- 设备：GPU0，进程环境 `CUDA_VISIBLE_DEVICES=0`、`QWEN_ASR_DEVICE=cuda:0`
- 候选进程启动后已停止，端口已确认关闭，GPU0 显存恢复到启动前快照

## 真实音频测量

使用候选目录中的 `restart-30s.m4a`，先由 ffmpeg 提取单声道 16 kHz PCM，再请求真实
`POST /v2/asr/batch`，优先级为 `realtime`：

| 音频时长 | 墙钟 | 推理 | 队列 | RTF |
| ---: | ---: | ---: | ---: | ---: |
| 1 秒 | 262 ms | 244 ms | 12 ms | 0.262 |
| 2 秒 | 376 ms | 357 ms | 12 ms | 0.188 |
| 4 秒 | 804 ms | 784 ms | 12 ms | 0.201 |
| 8 秒 | 2863 ms | 2836 ms | 12 ms | 0.358 |

每次都返回 `outcome=text`，model revision 一致。短片段达到实时体验方向，8 秒批次仍需由
客户端切片策略控制，不能把长批次延迟误报为首段延迟。

## 显存与结论

- 启动前 GPU0：`24,261 MiB used / 7,850 MiB free`
- 临时 GPU ASR 加载后 GPU0：`29,405 MiB used / 2,707 MiB free`
- 停止后 GPU0 恢复：`24,261 MiB used / 7,850 MiB free`
- GPU1 全程未触碰，停前后为 `26,005 MiB used / 6,107 MiB free`

GPU ASR 路径功能和短片段延迟已获得真实候选证据，但常驻时会把 GPU0 余量压到约 2.7 GiB，
不满足最终保留约 8 GiB 的资源门。因此它只能作为未来替换现有 8030 模型的候选运行方式，
不能与现有生产 ASR 并存，也不能仅凭本次测量激活 capability barrier。

另一次错误启动使用系统 Python，因缺失 NumPy 立即退出；没有加载模型、没有占用 GPU，未计入性能结果。
