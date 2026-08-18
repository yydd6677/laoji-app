# 候选 0032：U2-A native executor contract probe 审计

## 状态

- candidate: `$CANDIDATE_ROOT/upload-u2-native-executor-0001`
- implementer self-test: `10/10`
- independent root audit: `BLOCK`
- adoption: **not adopted**
- production mutation: `none`

该候选由独立实现代理创建，主代理随后逐行复核并重跑测试。测试命令：

```sh
cd $CANDIDATE_ROOT/upload-u2-native-executor-0001
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

```text
4d39dfa6354189585d7ae44e5eb27311f09a0ee237d0c386ba2bb8a5fb26b3fd  ARCHITECTURE.md
40772311946fbea33b1c6c095e9d9f031586ec838d5d7d821f7fac8cab950bda  README.md
df57c7d57f65a7a6fc41a5d62942ef2d45a29b2db6fc92cfe9083ba260bb9179  u2_contract.py
cd958bd4a3b07d040b5497a46f7aed7e1369e5caadcdf9fc1c3689cbb8dd74fb  tests/test_u2_contract.py
```

## 值得保留的证据

- `enqueueUniqueWork(KEEP)` 的业务身份应是 stable unique name，而不是调用方新建的
  `WorkRequest.id`；prune 后 operation name 可由 domain identity 重建。
- source revision/digest/epoch、active generation 和 tombstone 可以在同一状态机 fence
  迟到回调；`uploaded` 的 expected-state CAS 可阻止简单终态回退。
- R2 staging key 按 epoch/asset/generation/operation 隔离，避免同 key 的并发覆盖。
- verify/seal/activate 三个故障点可在同 operation 下重放；服务端 verify 循环使用 256 KiB
  缓冲并写 operation-private 0600 临时文件。

这些只属于合成 contract 证据，不是 Android、R2、正式 SQLite 或性能证据。

## 阻塞问题

### 业务身份仍被压缩

`stable_idempotency_root()` 只有 `asset_id + digest`。domain schema 又缺 scope、role、origin；
operation 和 server record 也未绑定完整 source revision。它只能在运行时额外比较部分字段，
无法从根上防止跨 scope/epoch/角色的同内容资产合并。

### 状态与删除合同不闭合

状态只有 queued/running/retry_wait/blocked/uploaded，没有显式
`superseded/cancelled` 和允许迁移表；`transition(expected,status)` 可以调用未预注册的边。
`blocked` 被列入终态却没有“重试创建更高 generation”的合同。`register_asset()` 会清除
tombstone，等价于隐式恢复；没有 meeting 删除、显式 restore、更高 generation、物理 purge
后的有限期 late-result fence 或 ABA 防线。

### prune 只证明名字可重建

测试在 prune 后只断言 unique name 字符串相同，没有模拟 remote commit 后进程被杀、server
probe、同库 CAS、probe 不可观测时的 `unknown/conflict` 或有界恢复时限。前台轮询仍可能
成为事实上的 completion handoff。

### R2/memory 证据无效

FakeR2 以 `dict[str, bytes]` 保存整对象，single PUT 用 `b''.join()`，multipart completion
也拼接完整 bytes；因此“256 KiB peak chunk”不能证明候选峰值内存有界。multipart 测试把
768 KiB 文件切为 256 KiB 非末片，不符合 R2/S3 非末片至少 5 MiB 的真实约束，也没有
presigned URL 到期、credential lease、list/resume、abort、10,000 part 或 TTL。

### 服务端与资源生命周期仍是假象

server record 是进程内 dict，不是真实数据库 CAS，也没有并发终态竞争。sealed 文件在成功
后未交给转写 owner、未清理、无 TTL/reaper；测试每次 setUp 创建临时目录但不关闭，主代理
重跑后发现并清理了 39 个 `$TEMP_ROOT/laoji-u2-seal-*` 目录。没有 meeting/epoch 删除或 R2 原对象
清理闭环。

### 平台覆盖缺失

没有 Android WorkManager/UIDT、ContentResolver、MediaIngestor、force-stop、系统重启、
guest/device 与 authenticated/account 双 scope，也没有 Linux/Windows 可移植 domain
合同或任何 U0 速度/CPU/RSS/磁盘对照。

## 结论和下一步

该候选冻结为 `self-tested; BLOCK`。不在同一 Python fake 上继续增加断言，因为它会再次把
真实 Android/R2/正式数据库问题替换成自洽模型。下一候选应缩成两个真实边界探针：

1. Android executor probe：operation-name KEEP/query/prune、app-private URI range streaming、
   WorkManager 与 Android 14+ UIDT、force-stop 和 credential rotation；
2. 服务端/R2 probe：复用正式表和真实 R2 sandbox，完整幂等根、5 MiB multipart、流式
   digest、commit-after-crash probe、TTL/abort/delete 与数据库终态 CAS。

两者通过后才允许建立正式 migration/meeting stage 投影。没有用户可见收益，也没有生产
代码、服务、数据库、APK 或设备变更。
