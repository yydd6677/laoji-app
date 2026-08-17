# 候选 0020：speech owner convergence 0004 最终否决

## 状态

- candidate: `/home/yydd/LaoJi-candidates/speech-owner-convergence-0004`
- decision: `rejected`; **not adopted**
- review: 全新非 Fast、未参与候选实现的独立蓝图代理
- production mutation: none
- supersedes: [candidate 0019 self-test](candidate-0019-speech-owner-convergence-selftest-20260816.md)

候选的局部测试已经明显加强，但最终审计仍发现 owner/recovery 级反例。按照
[revision 0008](../revisions/0008-speech-active-generation-owner-contract-20260816.md)
和 [research 0013](../research/0013-durable-execution-counterfactual-20260816.md)预先锁定的
门槛，不允许第三轮继续补丁，M1-O 到此停止。

## 已通过但不足以采用的证据

- 标准库候选测试 `38/38` 通过；16 并发重复 64 轮通过。
- 使用 compact-production-v3 真实 SQLAlchemy Base/Meeting/Asset/speaker DDL 的临时库
  集成测试 `2/2` 通过。
- 候选内部的 attempt/generation fencing、EOF/checksum、反向 legacy insert/resume
  trigger、空语音、基本 mobile generation cursor 和数据库行级 cascade 可自洽。
- 生产格式 `sha256:<hex>` 与转写侧裸 64 hex 已在真实 DDL harness 交叉验证。
- 删除结论只覆盖数据库 FK；从未证明本地音频、checkpoint、R2 object 或 multipart。

最终候选文件哈希：

- `owner_contract.py`: `87b80b13d06db4a66774b371a4c200524235dfd825b2c6a857eeeadafac6accb`
- `tests/test_owner_contract.py`: `22740e68a2e3e2c88e493e4499e4fbd509f05afa756c7b72d8eef7d17f491759`
- `real_schema_integration.py`: `a4d99f26602e33243f9f4700975cbaf0ae329d3b451564b4a395713302ac7ec4`

## 阻断反例

### 1. 真实 legacy worker 仍可抢占 v2 job

数据库 trigger 只阻止 `contract_version=1` 的 job 在 v2 owner 之后插入或恢复；真实
`meeting_recording_asset_service` 恢复器却扫描所有 `queued/running` job，不理解 v2
owner。真实 ORM 临时库复现了候选 v2 job 被旧恢复器从 `queued/attempt=0` 改为
`running/attempt=1`，随后候选自己的 claim CAS 失败。旧 worker 还能进入原 final
整批替换路径，绕过 generation、EOF 和 checksum fencing。

这证明 additive columns/trigger 不能让旧执行器自动失去 owner 身份；必须替换 claim 和
recovery 入口，而不是继续修表内条件。

### 2. Speaker 可在 EOF 前进入不可恢复终态

候选允许在尚无 manifest、尚未 EOF 时关闭 speaker；之后仍可登记新 segment，形成
`job.speaker_state=closed` 与 `segment.speaker_state=pending`。后续 patch 被 terminal
门禁拒绝，重复 close 又是 no-op。局部增加 speaker revision 不能修复这个阶段所有权错误。

### 3. 重分段删除历史与人工编辑

新 generation promotion 会删除同 asset 中不属于新 segment 集合的全部 canonical
`TranscriptLine`；人工 assignment 对 line 又是 `ON DELETE CASCADE`。改变 VAD 边界后，
旧 snapshot 失去 line/text，人工 assignment 从 1 变 0，而 SQLite integrity 仍为 `ok`。

因此数据库完整性通过不等于用户历史和人工编辑边界通过。目标必须保留不可变 generation
history，并只切 active pointer。

### 4. Manual 操作没有 expected transcript revision CAS

人工接口只提交 `line_id + assignment_revision`，服务端在执行时读取该 line 当前关联的
job revision。若客户端基于旧正文发起操作、同 segment 已被新 generation 改写，旧请求
仍会成功并被记录到新正文。assignment revision 只串行化人工操作，不能替代正文 revision
CAS。

### 5. 手机恢复只闭合自动 projection cursor

手机 fixture 持久化了 asset/generation/run/projection cursor，但 manual overlay 没有进入
同一可恢复合同，也没有删除 tombstone。基础自动投影 CAS 通过，不代表用户最终看到的
讲话人状态在重启、重做和删除后闭合。

## 决策

- M1-T 的用户结果仍保留：文字先可见，讲话人迟到增强。
- M1-O 的实现路线正式否决；禁止再在 0004 上追加第三轮 owner 条件。
- 下一候选必须由 durable execution runtime 真正拥有 workflow/claim/recovery；旧 worker
  只服务冻结的 C0 数据，不能看到新候选任务。
- domain 结果改为不可变 generation history + active pointer；manual 必须提交 expected
  text revision；speaker terminal 必须在 source EOF 后。
- 独立手机候选 0005 继续验证 immutable text + automatic speaker overlay + manual priority，
  但不因服务端候选被否决而宣称已可集成。
