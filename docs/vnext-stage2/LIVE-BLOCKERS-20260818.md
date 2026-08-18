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

## 本轮隔离证据

- `tools/vnext/verify_stage2_android_contract.py` 通过；它检查了 `KEEP` 唯一任务的真实 UUID、
  CancellationException 传播、源文件大小与 SHA-256、multipart receipt/layout、device-v2 epoch 清理、
  capability 双门，以及 401 token 刷新的可取消 HTTP 路径。
- `./android/gradlew :laoji-native-platform:compileDebugKotlin` 通过（2026-08-18）。
- 401 后的 device-v2 token refresh 不再使用阻塞式 `OkHttp.execute()`；WorkManager 和实时 socket
  都复用 `suspendCancellableCoroutine`，取消会调用实际 `Call.cancel()`。
- 以上只证明源码/编译合同，不能替代 Android 网络中断、进程死亡、文件删除和 APK 运行回放。

## 结论

以上是外部验收条件，不是 vNext 代码缺陷。解除设备或显存窗口前，不切换 capability barrier、不修改 GPU1、
不停止其他服务。
