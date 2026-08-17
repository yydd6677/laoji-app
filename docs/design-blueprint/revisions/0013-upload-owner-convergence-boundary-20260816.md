# 蓝图修订 0013：录音上传 owner 收敛边界

## 状态

- revision: `0013-upload-owner-convergence-boundary-20260816`
- status: `candidate`; **not adopted**
- parent: `0012-meeting-answer-provider-reader-boundary-20260816`
- production change: `none`

## 为什么切换当前队列

Q2 已形成证据合同、Provider self-test 和修正评测口径，但下一质量门需要独立代码审计、
新自然口语和可用 GPU 时段下的 27B 对照。继续由实现者自己增加 adapter 或 prompt 会违反
反局部优化规则。Q2 保持 candidate，不撤销，也不把阻塞伪装成完成。

上传是当前第二队列，且真实源码确认四套 owner 同时存在。它影响导入、录音、后台状态、
删除、同步冲突和用户对“到底在做什么”的理解，系统级收益高于继续修一个问答 prompt。

## 当前选择

选择 [research 0018](../research/0018-upload-owner-convergence-20260816.md) 的 U1：

```text
local file + RecordingAsset + queued generation (one SQLite transaction)
  -> WorkManager executor
  -> same-domain CAS completion
  -> derived UI projection
```

SQLite `RecordingAsset + active upload generation/stage` 是唯一业务真相；WorkManager 只拥有
网络执行和系统 retry；server 只拥有 remote asset；UI 不持久化业务状态。

## 删除预算

U1 被采用时必须删除：

- `pendingMeetingAudioUploads:v1/v2/v3` registry；
- SQLite asset 反向重建 registry 的路径；
- JS 进程内 retry/backoff owner；
- `audioSyncPending/audioSyncBlocked` 持久镜像；
- “待上传/上传受阻”标签的业务语义；
- legacy upload protocol 在 v2 能力闭合后的生产入口。

允许保留一个发布周期的只读迁移器，但禁止双写。

## 下一隔离候选

建立 `upload-owner-sqlite-0014`，先用真实 SQLite state machine 和 fake WorkManager/server
验证 crash、乱序、幂等、delete tombstone 和旧 registry migration。它不得导入生产 DB、
真实录音或服务器，也不得新增通用 task/operation ledger。

通过 self-test 后必须由独立 reviewer 检查：

- 是否确实只有一个业务 owner；
- worker completion 如何进入同一 SQLite 故障域；
- credential、cancel、retry 和 remote idempotency 是否可落到现有 Android/server；
- 是否实际能删除旧 registry/标签/JS retry；
- Linux/Windows domain 合同是否未被 Android API 污染。

## 采用与停止

候选只有接真实 repository、Worker、v2 API 和设备纵向切片并完成删除预算后才可能
`validated`。生产迁移、真机安装和服务变更仍需明确授权。

两轮仍不能删除一个 owner、存在 late success 复活，或需要第五份持久状态时，停止 U1，
保持 U0 并比较 U2；不做第三轮局部补丁。

## 其他队列

- Q2 保持 revision 0012 的边界；等待独立 audit、自然 holdout 和 GPU 时段；
- speech 只闭合对称审计；
- schedule 先补人工 graph gold；
- summary 不新增 task owner；
- UI 只作为 U1 的真实状态消费者，不先做独立视觉重构。

没有新方案 adopted。生产代码、数据库、服务、模型、APK、设备和公网均未改变。
