# 候选 0033：U2-A Android executor 真实设备边界审计

## 状态

- candidate: `$CANDIDATE_ROOT/upload-u2-android-executor-0002`
- device: `emulator-5562`, Android 15 / API 35, x86_64
- independent audit: `PASS`（仅限下列平台原语）
- U2-A production verdict: `BLOCK`
- adoption: **not adopted**
- production mutation: `none`

该候选是独立 Android 工程，不引用老记生产代码、密钥、数据、接口或 R2。实现代理完成
首轮运行后，独立审计代理从重新构建开始复跑普通 instrumentation、分段 force-stop 和包
状态检查；两个探针包随后卸载，唯一模拟器已关闭。

## 独立复跑

```sh
./gradlew --offline --no-daemon --rerun-tasks \
  :app:assembleDebug :app:assembleAndroidTest
```

```text
BUILD SUCCESSFUL
ordinary instrumentation: 5/5
force-stop phase 1: 1/1
package stopped state: false -> true
force-stop phase 2: 1/1
```

当前重建产物：

```text
8225f9b3b941900d3e21564b75af34bd7cc8ece29321e93de6aab4dced0f0504  app-debug.apk
a5785e78f3905d50358e9f21635bcaec0d2ffaced5cdc0f88ea22fceffee2b21  app-debug-androidTest.apk
```

androidTest APK 与先前交接摘要中的 `5f8701...` 不同；独立连续重建稳定得到
`a5785e...`，因此后续只采用这里的现场哈希。

## 已证明的窄边界

- 真实 WorkManager 数据库执行 `enqueueUniqueWork(..., KEEP, ...)` 时保留第一份实际
  WorkRequest，调用方新建的第二个 UUID 没有成为实际任务；实际记录可按 unique name 查询。
- 已完成 WorkInfo 经 `pruneWork()` 后，按 unique name 的查询结果确实为空。
- 延迟 WorkRequest 入库后，`adb force-stop` 使包进入 `stopped=true`；新的
  instrumentation 进程仍能按名称查到同一个 WorkSpec UUID。
- app-private `content://` 通过真实 ContentProvider 和 seekable PFD 精确读取 12 MiB 文件的
  指定区间，摘要一致，单次读缓冲不超过 256 KiB。
- 纯布局函数为 12 MiB 对象生成 `5 MiB + 5 MiB + remainder`，非末片满足 5 MiB 下限。
- 可见 Activity 为 `RESUMED` 时，API 35 的 UIDT JobScheduler 接受任务，JobService 启动并
  创建通知频道。

## 必须收窄的表述

- prune 后 WorkManager 已不能按名称查询。稳定 operation name 只能由 domain identity
  **重新计算**，不能称为 WorkManager 内持久 owner；测试中对字符串的断言与 prune 查询是
  两个独立事实。
- force-stop 只证明 WorkSpec 记录可重新查询。Worker 被设置为延迟一天且恢复测试随后取消
  任务，没有证明上传继续执行、remote commit 或最终完成。
- 当前 operation name 只有 `scope/asset/generation`，不等于包含 epoch、role、origin、
  source revision/digest 的正式幂等根。
- URI 测试只覆盖同 UID、规则文件、可 seek PFD；未覆盖 SAF 管道、不可 seek provider、
  persistable permission 丢失或源文件被替换。
- multipart 只验证长度布局，没有真实 presigned PUT、ETag、complete、abort、URL 过期或 R2。
- UIDT 只覆盖 API 35 上立即结束的前台调度；没有覆盖 API 34、长传、后台启动、通知拒绝、
  用户取消、配额和进度恢复。

## 仍然阻塞 U2-A 的证据

正式 SQLite asset/generation owner、完整业务身份、并发终态 CAS、真实 R2 session 与对象
生命周期、remote commit 后崩溃重放、WorkManager/UIDT 共用同一领域合同、系统重启/应用
升级、真实吞吐与资源对照均未证明。下一候选必须复用正式资产/R2 表；不能把这组 Android
平台原语包装成已经可接生产的上传器。

当前结论：Android 平台原语值得保留，U2-A 仍是 `candidate; BLOCK`，用户可见收益为 `0`。
