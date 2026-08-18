# 候选 0034：U2-A 正式 SQLite 与流式 seal 边界自测

## 状态

- candidate: `$CANDIDATE_ROOT/upload-u2-server-domain-0003`
- implementer/root self-test: `9/9`
- independent audit: `BLOCK` (candidate 0036)
- R2 evidence: `none`
- adoption: **not adopted**
- production mutation: `none`

该候选使用真实 SQLite 文件、WAL、foreign keys、`BEGIN IMMEDIATE` 和真实文件流；表名与
身份字段对齐正式资产/R2 域，但代码没有接入正式 SQLAlchemy model、Alembic、API、生产
数据库或 Cloudflare R2。它是正式终态合同的可执行反例探针，不是生产 patch。

## 自测

```sh
cd $CANDIDATE_ROOT/upload-u2-server-domain-0003
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

```text
Ran 9 tests in 8.517s
OK
```

```text
57059783f241262b4c500e4d8a1b42f158724f5461f69a0e6faca15bd4fafc17  README.md
bcf54f99b6a07fc005dad2e6183478d5825f3a205044d84a98ff532fb81092fc  u2_server_domain.py
74a56b66efdfdacd9835efe585ce34d8387ae331455113d0d1f33217817aca07  tests/test_u2_server_domain.py
```

测试使用 `TemporaryDirectory`；结束后 `$TEMP_ROOT/laoji-u2-server-*` 残留为 `0`。

## 当前只证明的边界

- 32 个并发 reserve 通过真实 SQLite 锁和唯一约束收敛为一个 generation，不依赖进程内锁。
- 同一来源被 blocked 后创建更高 generation；operation name 改变，包含完整来源身份的
  idempotency root 保持不变。领域表没有 `next_retry_at` 或 `executor_enqueued`。
- 同 digest 的不同 asset/role 不合并；source revision/digest 改变会 supersede 未完成
  generation，已 uploaded 的资产内容不可原地替换。
- `scope_key`、epoch、asset 和 generation 共同形成 executor name；不同 epoch 不再命中
  同一个 WorkManager unique name。
- tombstone 阻止迟到状态，restore 创建更高 generation；物理 purge 前必须再次 tombstone，
  purge 后有限期 fence 仍能把旧 observation 分类为 `stale_fenced`，不冒充 applied。
- completion claim 有租约；租约内不同 claim 被拒绝，过期后可以接管同 operation。
- 20 MiB+123 B 合成源使用 8 MiB parts、256 KiB 读写缓冲完成 assemble、SHA-256、0600
  operation-private seal、崩溃后重放和原子 activation；activation 与转写 job 在一个 SQLite
  事务内，重复调用只产生一个 job，迟到 failure 不回退 activated。
- SQLite `integrity_check=ok`、`journal_mode=wal`、`foreign_keys=1`。

## 本轮纠正的蓝图错误

真实移动端 `scope_key` 对游客是长期的 `guest`，data epoch 单独保存在设备身份中；因此
先前 `laoji-upload:<scope>:<asset>:<generation>` 会在 epoch 更换、相同 asset/generation
重现时碰撞。executor name 必须至少包含
`scope + data_epoch + asset + generation`。完整 source idempotency root 仍另外包含
principal、role、origin、source revision/digest 和 byte size；两者职责不能混为一谈。

## 仍然阻塞

- 候选没有复用正式 SQLAlchemy/Alembic/API，不能证明 migration、双 scope 或当前服务代码
  能无第二 owner 接入。
- `FilesystemMultipartStore` 只证明流式文件边界，不是 R2 emulator；没有 presign、ETag、
  multipart complete/abort、URL 与 credential 到期、list-parts、R2 并发和生命周期证据。
- purge 会级联删除 session；候选还没有在删除 session 前把 R2 object 与 sealed file 的
  清理义务持久移交给独立、有限的 cleanup obligation。当前 `cleanup()` 只是调用方显式
  执行，不能通过删除/崩溃门。
- 没有 Android Worker 到 API 的完整上传、remote commit 后进程死亡、系统重启、应用升级、
  URI 权限失效、真实 p50/p95、CPU、RSS、磁盘或失败率对照。
- 独立审计已确认 asset cascade 会删除 session 但丢失 R2 物理清理义务；同时缺少
  `last_presign_expires_at`、multipart upload ID、cleanup claim/status/attempt。详见
  [candidate 0036](candidate-0036-upload-u2-server-r2-independent-audit-20260816.md)。
  `9/9` 仍只是实现者自测，不得写成通过。

当前结论：保留 epoch-qualified identity、SQLite 终态 CAS 和流式 seal 方向；候选当前形态
被独立审计阻塞，不做第三轮自我补丁。若继续 U2，只建立独立 C2 schema adapter，再申请
真实 R2 sandbox。用户可见收益仍为 `0`。
