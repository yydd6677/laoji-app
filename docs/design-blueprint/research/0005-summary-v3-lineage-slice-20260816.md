# summary-v3 最小 Artifact/Result 血缘切片（研究）

## 状态与证据边界

- status: `candidate; design-only; not adopted`
- observed: 2026-08-16 Asia/Shanghai
- blueprint baseline: `0002-incremental-artifact-flow-20260816`（`candidate + prototype-selected`，未采用）
- implementation fact source: `/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend`
- 本笔记只提出隔离切片合同；不改生产代码、数据库、服务、模型、设备或部署。

## 结论

下一项只做 `meeting.summary-v3` 的 **final facts artifact**。继续把
`summary_tasks_v2` 作为唯一的 durable task owner：claim、lease、attempt、
checkpoint、recovery、dedupe 和 retry 都留在该表及其现有 store。新增的只是一张
结果/血缘表，以及 owner 上两个取消元数据列；不得增加 `operations`、第二个
claim/lease 表、第二个 retry owner 或独立 current-pointer 表。

Artifact 是不可变结果身份；task 只保存一个小的 artifact pointer，不再复制完整
结果正文。旧 `summary_v3_documents` 在迁移期间只能作为兼容读取投影，不能和新表
一起成为两个可写事实源。

## 当前缺口（observed）

1. `backend/app/services/summary_task_store.py:46-75,132-199,214-302` 的
   `summary_tasks_v2` 已有 task identity、dedupe、
   status/stage、lease、checkpoint、result 和 retention 字段，并以
   `BEGIN IMMEDIATE` 完成 create/claim。它是现有持久 owner，不应被候选
   `operations` 表替换。
2. `backend/app/workers/summary_tasks.py:585-691,4111-4225` 的
   `_do_device_summary_v3()` 先调用 `summary_v3_store.persist_document()`，再由
   worker 外层调用 `mark_persistent_summary_success()`；两次调用各自打开 SQLite
   连接和事务。进程在两者之间退出时，可能留下 document 而 task 仍非 success，或
   反过来留下 success 而没有可读结果。
3. `backend/app/services/summary_v3_store.py:58-177` 的
   `summary_v3_source_payloads` 用 AES-GCM 保存 note/attachment，当前 request 只
   保存 opaque payload id；payload 的保存、task 创建和 terminal cleanup 仍是多个
   事务。保存后进程在 task insert 前退出会留下 TTL 内的孤儿载荷。
4. `backend/app/services/summary_v3_evidence.py:253-282` 的 `normalize_sources()`
   计算 server-side `source_fingerprint` 和
   `transcript_revision`；API 收到的 `declared_transcript_revision` 不能作为 CAS
   权威。worker 当前在生成前重算 fingerprint，但 document commit 没有在同一 owner
   事务中再次锁定/检查来源。
5. 现有 worker 的 `_submitted_tasks`、Future、dedupe 和 serialization map 仍是
   进程内协调状态。它们可以暂时存在，但不能被研究切片误报为 durable owner；切片
   的后续门禁必须证明至少删除一组重复 owner。
6. 移动端在任务轮询 404 时会读取按会议返回的 latest v3 document，但当前没有
   将该 document 与原 task 的 source/template/note/attachment identity 做 CAS；
   这条恢复路径可能把旧结果误认成新任务结果。修复前，GET latest 只能作为展示
   候选，不能作为任务完成证明。

## 最小 schema

### 1. 新增 `summary_v3_artifacts`

只存结果和不可变 lineage，不存 source payload 的原始 note/attachment 明文（生成的
document/quote 仍受现有 retained-result 策略约束）。`source_refs_json` 是
按稳定顺序编码的 `{source_id, source_type, content_hash, start_ms, end_ms,
speaker}` 元数据；引用的逐字 quote 仍由 v3 document 合同负责，不能借此跨会议或跨
revision。

```sql
CREATE TABLE IF NOT EXISTS summary_v3_artifacts (
    artifact_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    task_scope TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    logical_key TEXT NOT NULL DEFAULT 'facts-v3',
    maturity TEXT NOT NULL DEFAULT 'final',
    source_fingerprint TEXT NOT NULL,
    transcript_revision TEXT NOT NULL,
    source_refs_json TEXT NOT NULL,
    model_revision TEXT NOT NULL,
    prompt_revision TEXT NOT NULL,
    document_json TEXT NOT NULL,
    coverage_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (
        task_scope, meeting_id, logical_key,
        source_fingerprint, model_revision, prompt_revision
    ),
    CHECK (maturity = 'final'),
    CHECK (active IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_summary_v3_artifact_active
    ON summary_v3_artifacts(task_scope, meeting_id, logical_key)
    WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_summary_v3_artifact_task
    ON summary_v3_artifacts(task_id, generated_at DESC);
```

`artifact_id` 必须由 `(task_scope, meeting_id, logical_key, source_fingerprint,
model_revision, prompt_revision)` 的 canonical identity 稳定派生（沿用当前
document UUID5 语义即可）。`payload_digest` 是 canonical `document_json` 的
SHA-256；重试不能就地改写正文、source refs 或 digest。`active=0` 只表示旧投影被
新 source revision supersede，历史行仍可审计。

首个切片只允许 `maturity=final`。不要用合成 replay 把 `partial/stable` 假装已经
进入真实 worker；水位产物另立后续合同。

### 2. 扩展现有 owner，而不是增加 owner

```sql
ALTER TABLE summary_tasks_v2 ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE summary_tasks_v2 ADD COLUMN cancel_reason TEXT;
ALTER TABLE summary_v3_source_payloads ADD COLUMN task_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_summary_v3_payload_task
    ON summary_v3_source_payloads(task_id)
    WHERE task_id IS NOT NULL;
```

旧数据库迁移必须幂等（先用 `PRAGMA table_info` 检查缺列，再执行 `ALTER`）；旧行允许
`task_id IS NULL`。在新入队路径中，先生成 task id，
再把 payload 绑定到该 id。取消暂不扩展现有四值 `status` CHECK（避免破坏已有消费方）：
`cancel_requested_at` 表示请求中，最终使用现有 `status='failure'`、
`stage='cancelled'`、`error_code='SUMMARY_CANCELLED'`。若将来要公开 `cancelled`
状态，必须另做状态合同和全调用方审计。

`request_json` 保持无明文，并固定包含：

```json
{
  "worker_args": ["meeting_id", "task_scope", "payload_id", "source_fingerprint", "model_revision"],
  "lineage": {
    "source_fingerprint": "sha256:...",
    "transcript_revision": "sha256:...",
    "source_refs_digest": "sha256:..."
  }
}
```

完整 source refs 留在 artifact 行；request 只需足够让恢复 worker 重建并验证同一
快照。客户端声明的 revision 只作输入校验，不能写成权威 lineage。

## 事务边界

### 入队（推荐的窄改）

把 AES-GCM 的低层 insert helper 改为接受 owner SQLite connection，在一个
`BEGIN IMMEDIATE` 中完成：

```text
T_enqueue:
  generate task_id
  encrypt payload (nonce + ciphertext + existing AAD(scope, meeting, payload_id))
  INSERT summary_v3_source_payloads(task_id, ...)
  INSERT summary_tasks_v2(request_json with payload_id + lineage, status=queued)
  COMMIT
```

若实现阶段无法共享 connection，必须明确保留当前两步入队，并把“payload 已提交、
task 未提交”的崩溃窗口交给 TTL orphan cleanup；这不能被称为原子入队，且必须有
对应故障测试。不得用第二张 queue 表来填补窗口。

### 生成阶段

worker 仍按现有 owner 流程 claim lease、heartbeat 和 checkpoint。解密 payload、
构建 evidence package、调用模型和验证 document 都在事务外；事务内不能做网络/GPU
工作。payload 在 task 仍可恢复时保留，不能因为一次 lease loss 提前删除。

### 唯一提交事务

将 `persist_document()` 与 `mark_success()` 合并为 owner store 内的
`commit_summary_v3_artifact(...)`，两者必须使用同一个 connection：

```text
T_commit:
  BEGIN IMMEDIATE
  SELECT task (the BEGIN IMMEDIATE write lock serializes this read)
    WHERE id = ? AND status = 'running'
      AND lease_owner = ? AND lease_expires_at_epoch > now
      AND cancel_requested_at IS NULL
  recompute current server source snapshot in this connection
  compare source_fingerprint + transcript_revision + source_refs_digest
  if identity row exists: reuse its artifact_id (idempotent ack retry)
  else:
    UPDATE old active artifact -> active=0
    INSERT immutable summary_v3_artifacts(...)
  UPDATE summary_tasks_v2
    SET status='success', stage='success',
        result_json='{"artifact_id":...,"payload_digest":...}',
        lease_owner=NULL, lease_expires_at_epoch=NULL,
        heartbeat_at_epoch=NULL, checkpoint_json=NULL,
        completed_at=now, updated_at=now
  DELETE summary_v3_source_payloads
    WHERE id=? AND task_id=? AND task_scope=? AND meeting_id=?
  COMMIT
```

任何异常都回滚 artifact、active flip、task success、pointer 和 payload deletion
一起。成功后 task `result_json` 只保留 pointer/摘要元数据；兼容 API 需要正文时从
artifact 读取，不再复制第二份可写正文。

### 来源 CAS

`source_fingerprint` 是全量 transcript + note + attachment identity；
`transcript_revision` 是 transcript-only identity。提交前必须在同一 owner transaction
重新读取 canonical `transcript_lines`（及绑定 payload 的不可变 note/attachments），
按 `normalize_sources()` 的同一函数重算两者和 `source_refs_digest`。`BEGIN IMMEDIATE`
拿到锁后，新的 transcript writer 会被 SQLite 串行化；若当前数据库不能从 owner
connection 读取权威 transcript 表，则本切片阻塞，必须先增加一个由 transcript 写事务
维护的 source-head CAS 行，不能只比较 API 传来的字符串。

CAS 失败时不写任何 artifact，task 以
`status='failure'`, `error_code='SUMMARY_SOURCE_CHANGED'` 结束本次旧快照；保留
task/audit 行，并在同一终态事务删除 payload（若进程在清理前崩溃，再由 TTL purge
兜底）。新的 source fingerprint 必须创建新的 task，不能让旧 task 自动把结果绑定到
新 transcript。

## 恢复、取消与保留

- **进程崩溃/lease 过期**：`summary_tasks_v2` 原 task id 保留，startup recovery
  重新 claim；checkpoint 和未过期 encrypted payload 复用。由于 artifact 与 success
  是同一事务，不能出现“已有 active artifact 但 task 仍可重跑”的半提交窗口。
- **旧 worker 迟到**：lease 被新 worker 接管、来源 revision 改变或取消标记存在时，
  `T_commit` 的条件更新为 0；迟到 document 不得发表，也不得覆盖 active artifact。
  外部 Ollama/ASR 是否真正 abort 需要单独 transport 证据，本切片不作假设。
- **取消**：API 在 owner 事务写 `cancel_requested_at/reason`。queued task 可直接
  终止并删除 payload；running task 只写 marker，worker 在 provider 前、checkpoint
  后和 commit 前检查 marker，再以 `stage='cancelled'`/`SUMMARY_CANCELLED` 清理。
  取消与 commit 的先后由 `BEGIN IMMEDIATE` 决定：先提交者获胜，后者只能观察 terminal
  状态。`Future.cancel()` 仅是内存优化，不能作为 durable 取消证据。
- **payload retention**：成功、明确取消和不可恢复的终态在同一 owner 事务删除
  ciphertext；lease recovery 保留；过期 purge 只删除过期 payload，并把引用它的
  queued/running task 标为 `SUMMARY_PRIVATE_PAYLOAD_EXPIRED`，避免无限 recovery。
  AES-GCM nonce/AAD、密钥环境变量和日志脱敏合同沿用现状；artifact 只存 source
  refs/hash，不复制原始 note/attachment 明文。
- **结果 retention/deletion**：v3 artifact 遵循现有 retained-result 语义；device
  epoch close、account deletion 和 purge 必须在同一清理边界加入
  `summary_v3_artifacts`，先删 artifact/task/payload，再允许 epoch 完成。旧
  `summary_v3_documents` 兼容行不得成为绕过该边界的残留事实源。

## 最小测试门禁（隔离 SQLite，Linux + Windows，Python 3.12）

1. 幂等迁移：旧 schema 重开两次；只有一个 `summary_tasks_v2` owner 和一个
   `summary_v3_artifacts` 表，无 `operations`/第二 lease 表。
2. 入队崩溃：payload insert 后注入异常；原子路径下 task 与 payload 都回滚；两步
   兼容路径则证明 orphan TTL 清理，不得把孤儿当成功 task。
3. 正常提交：artifact、active pointer、task success pointer 和 payload deletion
   同时可见；另一连接不能看到半成品。
4. 提交中断：artifact insert 后、task update 前注入异常；重开 WAL 后 artifact 和
   active pointer 均不存在，task 仍可按同 id recovery，最终只产生一行 active。
5. lease 竞争：旧 owner 过期后新 owner claim；旧 owner 的 late commit 为 0，新
   owner 可提交；无永久 running、无重复 active。
6. 来源 CAS：transcript 文本、speaker correction、manual-note revision 或
   attachment revision 任一变化均拒绝旧 task；跨会议/跨 scope source ref 均拒绝。
7. 幂等/ack 丢失：同 identity 重试或 force task 最终只一份 artifact；task pointer
   可从 artifact 重建，document digest 不变。
8. 取消竞态：queued cancel、running cooperative cancel、cancel-vs-commit 两种锁
   顺序；取消后零 late artifact，payload 被清理，已成功任务不会被倒置取消。
9. 重启恢复：payload 未过期时同 task id 继续；payload 过期时明确失败且不循环
   recovery；密文数据库字节不包含 note plaintext，错误 scope/meeting 无法解密。
10. 隐私清理：epoch close/account deletion 同时移除 task、artifact、payload；无
    dangling pointer，旧兼容读取不再返回已删除结果。
11. 兼容读取：旧 summary API 从 artifact 生成只读 response；生产调用图不出现
    `summary_v3_documents` 与 artifact 的双写 owner。
12. 资源/取消记录：模型调用外的 transaction 持锁时间有上限；记录 provider abort
   是否发生，但不把合成 replay 延迟当作真实质量或性能证据。

13. 404 恢复：注入任务记录丢失或暂时不可见，latest document 的
    source/model/prompt/transcript/note/attachment identity 不完全匹配时必须拒绝
    复用；匹配时也只能恢复原模板偏好，不能触发模型调用或创建第二版本。

## 反证与退出条件

以下任一条件成立，切片退回“只读研究”，不进入 production/adopted：

- artifact commit 不能和 task success 共用一个事务；
- CAS 只能比较客户端声明或旧 worker 内存值，不能锁定 server source revision；
- 需要新 task/lease/retry 表，或至少一组旧内存 owner 无法删除；
- 取消只能改 Future，迟到 provider 仍可发表结果；
- payload cleanup 会破坏 lease recovery，或 plaintext 进入 task/artifact/log；
- 真实 Python 3.12/Linux + Windows、WAL 重启和故障矩阵未通过；
- 404 latest fallback 未通过完整 identity CAS，或仍能把不同来源的 latest 结果当作
  当前任务成功；

## 隔离原型结果（0007）

`/home/yydd/LaoJi-candidates/summary-v3-lineage-0007` 以标准库 SQLite 复刻了
上述提交边界，包含 7 个合同测试：正常原子提交、artifact 写入后的崩溃回滚、
错误 transcript revision、过期 lease、重复身份和“无第二 operations 表”。
在本机 Python 3.13.5 上结果为 `7/7 passed`。这只是候选合同证据；尚未在项目
要求的 Python 3.12、Windows、真实服务数据库、真实 worker 或真实模型上验证，
因此不改变本切片的 `not adopted` 状态。

候选中的 `audit_source_gaps.py` 当前稳定报告 4 项预期缺口：客户端 revision
误用、投影丢 revision、artifact/task 跨事务，以及 404 latest 无 identity CAS。
实现切片后必须用同一脚本得到 0 项，再进入真实 schema 故障门禁。
- 旧 UI/API 仍同时写两个可见结果源，无法证明单一 artifact projection。

本切片不宣称 partial/stable 增量、真实模型 abort、Android/RN 接入、性能收益或
生产数据安全；这些必须另有独立证据。
