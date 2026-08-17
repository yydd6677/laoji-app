# Stage 2 当前外部门

本文件只记录本轮只读核对，不代表修改或授权切换生产。

## GPU

- GPU0：32,607 MiB 总量，约 2,042 MiB 空闲；线上 ASR/Ollama 等进程已经占用大部分显存。
- GPU1：32,607 MiB 总量，约 6,163 MiB 空闲；PCB、Smart Meeting 和其他进程均在使用，按边界不触碰。
- Qwen3-ASR-1.7B 候选需要约 6 GiB 以上常驻显存，当前没有不抢占现有服务的候选 GPU 窗口。
- 因此 GPU 首段/RTF 仍保持未验收，候选 8031 继续固定 CPU。

## Android

- 当前 ADB 只有 `emulator-5560`，属于其他任务的实例；没有连接 `LaoJi_API_35` 或真机。
- AVD 列表虽然包含 `LaoJi_API_35`，但在现有实例不退出且不增加内存压力的约束下，本轮不启动第二实例。
- WorkManager 合同已通过源码静态门和 Kotlin 编译；网络断开/进程死亡仍需要 LaoJi 专属设备或实例才能形成运行时证据。

## 结论

以上是外部验收条件，不是 vNext 代码缺陷。解除设备或显存窗口前，不切换 capability barrier、不修改 GPU1、
不停止其他服务。
