# 候选 0029：upload-owner-sqlite-0014 独立审计

## 状态

- candidate: `/home/yydd/LaoJi-candidates/upload-owner-sqlite-0014`
- result: `rejected-current-shape`
- adoption: **not adopted**
- production mutation: `none`

## 自测事实

候选只实现纯 Python/SQLite 抽象状态机，不连接 Android、WorkManager、正式 RN SQLite、
真实 R2、HTTP、服务器数据库、真实录音或 UI。实现者自测为 `22/22`；审计未把它提升为
validated。

```text
6220e09956b8017d285ccf3a4b83416dc19959056a2eb12f957736364e51fe5c  upload_owner.py
e01052086f2faef5d12aa4a7e82f655a680163bfdc8359a3ca84206c6a26c064  tests/test_upload_owner.py
```

## 独立审计阻塞

1. 迁移 marker 可能在真实 registry 尚未完整 claim 时写入；后续会删除未导入的旧 key。
2. scope key、remote identity、data epoch 和同 asset 跨会议冲突没有形成完整迁移合同。
3. 同一次 attempt 的乱序更新可能使状态倒退；没有源 digest 的 CAS。
4. 回收站恢复、永久删除和物理级联删除没有形成闭合的迟到 worker fence。
5. 它会与正式 `processing_stages.upload`、AppStorage registry、会议字段和 WorkManager
   同时表达业务状态，反而增加第二 owner。
6. WorkManager enqueue/完成交接只是抽象回调，没有证明 `KEEP`、prune、force-stop、系统
   重启和同一 SQLite 文件的实际时序。

这些问题不是补一两个条件即可证明的局部 bug，而是候选的 owner 边界错误。因此按持续目标
的“两轮停止”规则冻结，不建立 0014 第三版。

## 保留价值

它仍提供了几个可复用的反例：稳定 operation name、generation fencing、删除 tombstone、
旧 registry 的精确 claim、失败关闭而不是静默覆盖。它们只能作为 U2-A 的测试断言，不能作为
生产实现或数据库迁移脚本。

## 结论

0014 证明“先写一个独立 SQLite 状态机”不足以接入老记。下一候选必须扩展正式资产域，
把会议级 stage 降为投影，并在真实 Android/R2 故障域中验证；候选目录保持只读，不合并、不
推送、不安装。
