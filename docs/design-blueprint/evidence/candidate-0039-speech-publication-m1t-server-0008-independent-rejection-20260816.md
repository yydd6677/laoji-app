# 候选 0039：speech publication M1-T server 0008 独立否决

## 状态

- candidate: `/home/yydd/LaoJi-candidates/speech-publication-m1t-server-0008`
- audited implementation snapshot:
  - `m1t_server.py`: `4e37505ffb7571a1f7dab89bf8c8521cafac001bccf68f0909e56efa6ba672ab`
  - `tests/test_m1t_server.py`: `cd9ec9a16ad5b3cea57bf742ebaf45e9eef41e3db63bea540d1e0e23d5eff24d`
  - `README.md`: `f34ad6db7dc3be3a635be404cbd522a141cc514e629ccec201bd1b3a3905cfa8`
- post-audit status-only README: `95cacfa953c2b15d34baa2c0bafdb4e5d23b3e987d86c9bf68eeb6618e5bc5e0`
- original self-test: `12/12`; independent rerun: `12/12`
- independent verdict: **BLOCK real-adapter integration; rejected-current-shape**
- adoption: **not adopted**
- production/service/database/App/APK mutation: `none`

0008 是有价值的单进程 lane-separation 行为草图，但不是 revision 0015 要求的“直接映射真实
repository/route”候选。原测试通过与以下反例可以同时成立。

## 独立通过边界

- SQLite `BEGIN IMMEDIATE` 下 32 个并发 text writer 获得唯一连续 seq `1..32`。
- 同进程单 writer 中，slow/failing/unavailable CAM++ 不阻塞 text emit、text close 和
  stop-ready。
- 同一 embedding object 复用于 cluster 与 identity。
- speaker patch 不改变 probe 的 text revision。
- task status 字段变化不隐藏 probe text。
- 不完整的全覆盖 merge 在 probe transaction 内 rollback。
- 同 locator 的 account/device wrapper 返回 byte-equivalent Python data。
- cross-run source 被拒绝。

这些证据结构性支持删除三条等待边：speaker inference -> text emit、speaker completion ->
text close、speaker backlog -> stop-ready。它们没有证明真实 CAM++ ready、真实 task gate 或
真实 account/device route 已被删除。

## P0 动态阻塞

### 1. close、attempt 与重启都没有 fence

- `close_speaker` 后仍可 `publish_speaker_patch`；projection 同时返回顶层 closed 与 item assigned。
- 两个同 base speaker writer 都成功，自动分配 revision 1/2；没有 expected revision CAS。
- 真实 job 有 `attempt`，候选 owner/state 没有 attempt/generation，旧 attempt 在 job 被重新置为
  running 后仍可写 seq 1。
- queue overload 只 emit `durable:false`，随后 speaker closed；被 shed 的 source 永久 pending。
- 进程崩溃后 fresh session 没有 durable pending/recovery/lease，会直接 close 成
  `speaker_closed + item pending`。

### 2. final lineage 不支持真实重分段

- 一个有来源 final 加一个 `replaces=()` 的凭空 final 被接受。
- 一个 provisional 拆成两个 final 的合法 split 被 exact-once claim 拒绝。
- 两个 source merge 为一个 final 后，原 source 已识别 speaker 丢失，final 显示 unknown/pending。
- final projection 只按 final source ID 查 patch，没有沿 lineage 解析自动或人工 speaker。

### 3. manual、no-speech 与 scope 仍有双真值

- canonical line 已是人工姓名时，迟到 automatic patch 会覆盖人工显示；projection 未读取正式
  manual assignment owner。
- 同一 `(job, source_segment_id)` 可先写 no-speech 再写正文，projection 同时返回 item 与
  no-speech outcome。
- parent job 的 epoch 从 1 改成 2 后，epoch 2 locator 可读 epoch 1 child draft；真实 device
  route 原本会显式校验 child epoch，probe 只按 job ID 读 child。

### 4. realtime、finalization 与生产 schema 不可映射

`M1TRealtimeSession` 把 draft segment 写成 maturity final，再 `close_text`，得到
`text_status=closed/source_kind=provisional`；之后 canonical promote 必然报 text lane 已关闭。
真实 realtime route 目前并没有该 transcription job owner，而是直接写 `TranscriptLine` 或使用
guest 内存 session。0008 因此只模拟了离线 job，不能声称复用实时 owner。

真实表与 probe 至少有以下结构差异：

- production job 没有 run ID；
- production draft 没有 run/source revision/seq/maturity/replaced/segment reason；
- production `TranscriptLine` 没有 run/source/seq/model revision；
- probe canonical line 对 job 使用 `ON DELETE CASCADE`，production 使用 nullable
  `ON DELETE SET NULL`。

把 probe DDL 直接映射真实库不仅会因列不存在失败，还会让 task owner 重新拥有 canonical
正文寿命：删除 job 会删除 probe final line。

### 5. 0008 没实现 0015 的关键 wire 合同

- `segment_revision` 永远为 1；没有 stable prefix 或 Unicode scalar 校验。
- text replay 没把 audio、segment reason、ordinal 纳入 identity；speaker replay 又每次创建新
  revision，没有 operation ID/request hash。
- account/device “一致”只是两个 wrapper 调同一单-job函数；没有 cursor、snapshot digest、
  meeting 多 asset 聚合或全局 watermark。
- summary/Q&A 仍直接读 production `TranscriptLine`，不会消费新 probe projection。

## owner 与概念预算结论

没有新增通用 ledger 或第二 manual 表，这一点保留。但四张 durable probe 表中，automatic
speaker patch 已与 canonical speaker 字段、正式 assignment/reprocess owner 冲突；no-speech
又与 job terminal outcome 重叠。实时 execution owner 根本未映射。

因此不在 0008 目录继续修。保留它的 wait-edge fixtures、单 embedding fixture 与事务 rollback
反例；下一候选必须直接基于真实 SQLAlchemy/SQLite schema、attempt/generation CAS、正式
manual owner、many-to-many lineage 和 meeting-level projection 重建。
