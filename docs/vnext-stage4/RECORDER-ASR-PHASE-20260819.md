# Stage 4 录音 ASR 阶段合同

状态：`isolated native candidate; not adopted`。

## 目的

录音和实时转写是两个并行 lane。仅有 `asrConnected` 无法表达“本机已经开始录音，但
WebSocket 仍在连接”以及“连接失败、录音文件仍可恢复”这两个用户可见但性质不同的状态。
vNext native 快照现在携带可选兼容字段 `asrPhase`：

```text
notRequired -> connecting -> connected -> completed
                         \-> recoveryRequired
```

`recoveryRequired` 不表示麦克风失败；本机 WAV/journal 仍是权威恢复输入。`completed` 只在
本地文件已保存、服务端 ready-to-stop 已确认、且没有待恢复错误时出现。

## 兼容与边界

- Kotlin 快照和 `toMap()` 输出固定 wire 值；TypeScript 对旧 native 二进制保留回退推导。
- 未增加新的录音 owner、任务、网络请求或持久数据表。
- 生产 8030/18020、稳定 APK、GPU 和公网入口均未改动；候选默认关闭。

## 证据

- `python3 tools/vnext/verify_recorder_asr_phase_contract.py`：通过，覆盖 wire 值、快照字段、
  失败优先级和 TypeScript 兼容回退。
- `npx tsc --noEmit --pretty false`：应与本候选一同验证。
- `android/gradlew :laoji-native-platform:compileDebugKotlin --no-daemon`：应与本候选一同验证。

仍缺专属 LaoJi 设备上的冷启动、慢 WebSocket、断网、杀进程和真实首帧延迟回放；本切片不能
作为 Stage 4 退出或生产采用证据。
