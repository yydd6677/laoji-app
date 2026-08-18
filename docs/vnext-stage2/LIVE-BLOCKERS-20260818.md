# Stage 2 当前外部门

本文件只记录本轮只读核对，不代表修改或授权切换生产。

## GPU

- 晚间最新只读快照：GPU0 约 31,123 MiB 已用、989 MiB 空闲；此前 2,042/7,850 MiB 等数值均为
  不同模型驻留时刻的历史快照，不能代表当前切换余量。
- 当前 GPU0 中老记 9B runner 约 8,842 MiB、embedding runner 约 574 MiB、生产 ASR 约
  6,010 MiB、候选 API/CAM++ 约 498 MiB；其余显存属于 PCB 和其他进程，按边界不触碰。
- GPU1：32,607 MiB 总量，约 6,163 MiB 空闲；PCB、Smart Meeting 和其他进程均在使用，按边界不触碰。
- Qwen3-ASR-1.7B 候选临时加载到 GPU0 后占用约 4.99 GiB，短片段真实 RTF 为 0.188--0.358；
  但与现有服务并存时 GPU0 只剩约 2.7 GiB，低于最终约 8 GiB 余量门。
- 因此 GPU 短片段延迟证据已取得，但常驻资源/替换切换仍未验收；候选 8031 已恢复固定 CPU，
  不能与线上 8030 并存加载第二份模型。
- 9B 与 embedding 同时常驻后，GPU0 余量远低于约 8 GiB 门；不能在当前资源状态激活 Stage 2/3
  capability。生产 18020 仍是旧 ready 表面；隔离 18021 的 `471d94f` 已使用真实 embedding
  probe，并于本轮返回 `embedding_ready=true`，但当前修复包 `de5e514` 尚未部署。
- 对老记 embedding runner（模型 blob `06507c...`）做过一次可回滚的单进程 TERM 重启，GPU0
  空闲从约 989 MiB 增至约 1.57 GiB；随后单条固定 readiness probe 仍在 30 秒超时，runner 未能
  重新加载。未重启 Ollama 主进程、9B、ASR、生产 API、GPU1、PCB 或其他服务；这证明问题不是
  单个 runner 的残留状态，后续需要服务级资源/运行态处理。
- 本轮结束时只读状态：GPU0 约 `31,969 MiB used / 143 MiB free`，GPU1 约
  `26,005 MiB used / 6,107 MiB free`；两张卡均未执行迁移或清理。18020、8030、8031
  仍保持原运行态，18021 仍为隔离候选。

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
