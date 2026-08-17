# 候选 0030：upload-owner-sqlite-0015 服务端扩展独立审计

## 状态

- candidate: `/home/yydd/LaoJi-candidates/upload-owner-sqlite-0015`
- result: `rejected-current-shape`
- adoption: **not adopted**
- production mutation: `none`

0015 在 0014 基础上增加 fake server、staging object、sealed/commit 流程，实现者自测为
`36/36`。自测只证明抽象模型内部一致，未证明生产适配、Android、正式 SQLite migration、
真实 R2 或用户体验。

```text
4e8652c2de4e517f563a8f2c82b6ced22864d1dbcfac5c9430571a90fe6b08b9  upload_owner.py
c967cd9ea81273cf8ef10a4c6d877a9fbccc4ef6f61eea2e734b1e6e61a4ef33  server_upload.py
af1f46c3442a3cb6d5a1bff8c0c604948225f75aebdd042c489d73674c65ded1  tests/test_upload_owner.py
cfcd0ba6ea40165146328542a743691b43e2872c34b4697b45c9356ff8f2c021  tests/test_server_upload.py
```

## 独立审计阻塞

### 服务端终态竞态

`seal_and_commit` 在读取到已存储状态后，迟到 seal 仍可通过无 CAS 的 failure 路径把另一个
请求已经提交的 `completed` 改为 `failed`。这是可复现的终态回退，不是测试假设差异。

### 删除和恢复

`purge_meeting` 会删除最后的 tombstone/operation fence；迟到 Worker 之后得到
`upload_operation_missing`，而不是稳定的 `ignored_deleted`。服务器也没有会议删除 fence。

### 迁移和身份

迁移用字典覆盖同 asset/digest、不同 meeting 的 registry 记录，并允许两个旧 key 被删除，
造成静默少导入。服务端另建 `server_assets/server_upload_operations`，缺少正式
`role/origin/data_epoch/R2 session`，不能与现有 `MeetingRecordingAssetV2`、
`MeetingRecordingR2UploadV1` 并存。

### 原音频生命周期和内存

sealed 原音频没有 TTL、成功清理、会议/epoch 删除协议；`StrongObjectStore` 甚至没有完整
delete 合同。对象校验以 `read()` 一次读入完整录音，不适合 1 GiB 上限。

### 业务身份错误

`UNIQUE(meeting_id, digest)` 会把同一会议中内容相同但业务身份不同的资产合并，且没有正式
primary/secondary 角色。没有真实 device/R2 probe、正式 migration、per-asset generation
到会议 stage 的事务投影或 WorkManager completion 交接。

Cloudflare 官方能力确认 R2 支持条件 CopyObject；因此供应商能力不是阻塞，阻塞在候选
自己的 CAS、清理、身份和正式系统接入。

## 结论

0015 也冻结为 `rejected-current-shape`。不得修第三版 U1。保留的边界只有：正式 SQLite
唯一业务 owner、WorkManager 仅执行、stable operation name、credential generation 与
local generation 分离、跨 generation 稳定 server idempotency root、禁止 completion inbox、
会议上传状态作为多资产派生投影。

第二份审计代理曾因本地认证服务 503 中断；这不改变上述独立审计已经复现的阻塞，也不构成
通过证据。后续若重新运行审计，只能审阅 U2-A 的真实适配候选，不能把 0015 改写为 validated。
