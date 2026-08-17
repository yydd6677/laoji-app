# 候选 0028：上传 SQLite 唯一 owner 自测

## 状态

- candidate: `/home/yydd/LaoJi-candidates/upload-owner-sqlite-0014`
- result: `self-tested; independent audit pending`
- adoption: **not adopted**
- production mutation: `none`

该候选实现 revision 0013 的纯 SQLite 状态机，不连接 React Native、WorkManager、R2、
HTTP、credential、生产 DB、真实录音或 UI。

## 已实现的 owner 合同

- local asset 与 generation=1 queued 在同一 `BEGIN IMMEDIATE` 事务提交；
- operation ID 由 asset/source/content/generation 哈希生成，长度固定；
- enqueue ack 只是执行握手，提交后 enqueue 前崩溃可恢复同一 operation；
- running executor 丢失会退回 queued 并恢复，不铸造新任务；
- retry_wait 只在 due 且 executor 确认缺失时恢复；
- user retry 创建更高 generation，并返回旧 operation 供取消；
- callback 必须命中 active generation；旧 generation 和 tombstone 都 no-op；
- blocked/uploaded 对当前 generation 终结，重复同结果幂等，冲突结果不覆盖；
- server success 后本地 commit 前重放复用同一 operation，fake server 只产生一个 remote asset；
- v1/v2/v3 migration 在一个事务中按 v3 优先合并，完成后才返回待删 key；
- URI 是可变 locator，不参与内容 identity；meeting/source/size/hash 冲突 fail closed；
- SQLite 开启 WAL、foreign keys 和 5 秒 busy timeout。

## 自测证据

```text
6220e09956b8017d285ccf3a4b83416dc19959056a2eb12f957736364e51fe5c  upload_owner.py
e01052086f2faef5d12aa4a7e82f655a680163bfdc8359a3ca84206c6a26c064  tests/test_upload_owner.py
```

Python 编译和 `22/22` 测试通过，其中包括：

- 子进程在 DB commit 后、enqueue 前 `os._exit`，重开后恢复相同 operation；
- 子进程在只插入 asset 的未提交事务中 `os._exit`，重开后无半条 asset；
- trigger 模拟第二张表写失败，整个 asset/stage 事务回滚；
- 32 路并发 create 只产生一代/一个 operation；
- 32 路重复 success 只有一次 applied，其余 duplicate；
- delete 后晚到 success、new generation 后旧 success 都不能复活；
- retry、lower attempt、blocked terminal、migration conflict 和 locator 变化。

初版自测为 `16/16`。自审发现 running executor missing 无法被 recovery scan 找到、retry
未返回旧 operation、长 asset ID 会使 operation 超限，以及 locator 被错误当内容 identity；
修正并增加真实 crash/atomicity 后才达到当前 `22/22`。

## 仍未证明

- Android Worker 能否在 RN SQLite 活跃时安全写同一文件；
- 若改用同库 completion inbox，它是否只是短交接而非第二业务 owner；
- WorkManager prune、force-stop、系统重启和 credential lease 的真实时序；
- 当前 server register/content 是否对所有未知执行结果保持同 operation 幂等；
- DB full/read-only/busy、文件 permission 丢失和 content URI revoke；
- 真实 v1/v2/v3 数据形状、迁移 key 删除和回滚；
- AppStorage registry、JS retry、会议字段和状态标签是否真的能删除；
- UI、上传速度、内存或用户体验改善。

## 下一门

独立 reviewer 先审查同库写入/交接和删除预算。若通过，再建立现有 TS repository、Kotlin
Worker 与 v2 server 的只读 adapter map；只有 map 能证明每个旧写入口都有唯一替代后，才
允许在独立 worktree 做真实代码切片。

该候选只能记为 `self-tested`，不能因 crash test 通过而记为 durable 或 validated。
