# 研究 0021：语音发布的原子投影边界

## 问题重定义

M1-T 的产品结论仍成立：文字可用不应等待讲话人。但 0005 与 0009 连续证明，先设计一个
通用 mobile reducer、再把它映射到真实 repository，会制造新的 cursor、finality、manual
carry 和 digest 语义。问题不再是“怎样给 reducer 补齐条件”，而是：

> 如何让正式 transcript revision 事务直接产生一个可增量消费的 wire projection，同时让
> 手机 cursor 只记录消费水位，不拥有正文、人工讲话人或任务状态？

## 三条路线

| 路线 | 形态 | 判断 |
|---|---|---|
| C0 | task success 后读取 canonical final；device 旁路读 draft；speaker 仍参与部分完成门 | 仅保留生产回滚 |
| R1 | 继续扩展 0009 reducer 与 `transcript_segments` 新 maturity/state 列 | 否决；双 owner 和跨事务 carry 无法靠更多 reducer 条件消除 |
| P2 | 正式 revision/segment 为唯一正文 owner；server 生成严格 envelope；mobile 唯一 decoder + exact revision cursor；final/lineage/active pointer 单事务 | **下一隔离候选** |

P2 不是增加通用 Artifact ledger。它把 wire、消费水位和 provenance 限制在三个窄概念内，
业务正文、manual assignment 和 transcription job 继续由现有正式域拥有。

## P2 wire envelope

### 唯一解码入口

- 网络层只把 UTF-8 bytes 交给 `decodeProjectionEnvelope(bytes, expectedIdentity)`；业务代码
  不能直接构造已验证 snapshot，也不能传入所谓 local digest。
- decoder 使用严格 schema，拒绝 duplicate key、unknown key、非 I-JSON 数字、孤立
  surrogate、控制字符和被 trim 后才有效的 identifier。
- envelope 的 `payload_sha256` 由 decoder 对 payload 的 RFC 8785 JCS bytes 自行计算后比较。
  JCS 用于可重复指纹，不替代 HTTPS、鉴权或响应真实性。
- segment 必须按 ordinal/source ID 的冻结顺序发送；replacement edge 按 old/new ID 排序。
  非规范顺序直接拒绝，不靠客户端排序后掩盖不同 wire bytes。
- 同一 projection revision 的 JCS digest 必须唯一；精确重复幂等，不同 digest fail closed。

RFC 8785 明确把 JSON 限制在 I-JSON、使用确定性 property sort 和 ECMAScript primitive
serialization，适合跨端 hash；它是规范化依据，不证明 LaoJi adapter 已正确实现：
https://www.rfc-editor.org/rfc/rfc8785

### 状态转换

- delta 只能 append/advance segment 或 speaker patch，不能关闭 text/speaker，不能携带
  replacement。
- 每次 delta 合并后重新验证 source ID、ordinal、range、revision、stable prefix 和所有全局
  唯一约束；验证失败时不改变 cursor。
- `text_closed` 只由完整 full snapshot 建立；full 中所有正文 segment 必须 final，且旧 draft
  segment 必须经 lineage edge 覆盖。
- `speaker_closed` 只在 `text_closed` 后建立；full snapshot 中每个有声 source segment 必须
  是 identified/anonymous/unavailable/superseded 之一。closed 终态不可回退或继续 patch。
- gap delta 返回 refetch full；新 generation 也必须从 full 开始。

### Unicode 与可见稳定性

wire 水位继续使用 Unicode scalar count，便于 Python/TypeScript/Kotlin 一致比较。但 server
发布的 stable boundary 还必须落在 Unicode extended grapheme cluster 边界；否则
`e + combining mark` 或 ZWJ emoji 的 scalar prefix 虽未改，用户看到的字形仍可能变化。

边界遵循 Unicode UAX #29 的 extended grapheme cluster conformance：
https://www.unicode.org/reports/tr29/

客户端验证 scalar prefix 不被改写；是否为 grapheme boundary 由三端 ICU/Unicode fixture
交叉验证。不同 Unicode 数据版本不一致时停止发布新 stable 水位，不静默降级为 code unit。

## 正式本地 owner 映射

### 正文与 cursor

- `transcript_revisions` / `transcript_segments` 继续是唯一正文 owner。
- 当前 active revision 是**会议级唯一**，而 recording asset 是一对多。单个 asset 的 full/final
  不能停用会议 active revision 后只写自己的 segments，否则其他 asset 的可用文字会消失。
- 不新增 `text_maturity`。现有 `is_final` 是唯一 finality；只补
  `source_text_revision` 与 `stable_prefix_codepoints`，并由 repository transaction 验证。
- provisional 写入一个明确的 meeting aggregate `realtime_draft` revision；每个 asset cursor
  必须 FK 到它实际消费的 exact transcript revision，但多个 asset cursor 可以指向同一 aggregate
  revision。任何 asset delta 只替换自己的 slice，并保留其他 asset 的 segment、manual 和 lineage。
- cursor 不重复拥有 meeting/scope。repository 通过 asset、revision、meeting join 校验它们
  属于同一 scope；该 join 既用于读，也进入 compare-and-set UPDATE predicate。
- data epoch 由调用方 expected identity 与 cursor 比较；epoch 改变时旧 cursor 失效并要求
  full，不把 epoch 当成正文 owner。

### final 与 many-to-many lineage

- final full 创建不可变 final/reprocessed revision 与**会议全部可用 asset slices**，不能只包含
  触发本次完成的 asset。若另一个 asset 仍在运行，则该 asset 可在 aggregate draft 中把自己的
  segments 标为 final，但不能提前把整场会议切成缺少其他 slice 的 canonical final。
- lineage 是 old revision segment -> new revision segment 的 many-to-many edge；每个旧正文
  segment 至少有一条出边，每个新正文 segment 至少有一条入边。revision 方向天然禁止环。
- final segments、lineage、`is_active` pointer、cursor 和 closed fingerprint 在同一个 SQLite
  transaction 提交。任一步失败全部 rollback，旧 draft 继续可读。
- 不复制人工姓名。渲染 final segment 时先看该 final segment 的正式 locked assignment；若
  没有，则沿 lineage 读取旧正式 assignments。同名来源可继承，不同人工姓名合并为显式
  conflict/unknown，不让正文提交失败。
- 用户随后修正 final segment 时，仍只创建现有 `speaker_corrections/speaker_assignments`；
  该新 assignment 优先级最高。

当前先比较两个 owner-preserving 形态：

| 形态 | 优点 | 风险 | 当前判断 |
|---|---|---|---|
| M-A：meeting aggregate revision + per-asset slice cursor | 保留现有唯一 active revision 和下游查询；delta 可按 asset 更新 | 需要在事务内重排 meeting ordinal，并在新增 asset 时从旧 final 建新 aggregate draft | **首选候选** |
| A-M：per-asset immutable subrevision + derived meeting view | 每资产完成和 lineage 更自然 | 需要改变 active uniqueness、summary/Q&A/citation/搜索全部查询，容易形成第二正文 owner | challenger；未证明前不实现 |

若 M-A 不能在一个正式 repository transaction 内保留其他 slices，再研究 A-M；不能让隔离
候选暗中采用 A-M，却继续声称复用当前 active revision owner。

### automatic speaker

- 自动 patch 更新 segment 既有 base `speaker_profile_id/speaker_label`，并用最小
  `automatic_speaker_revision/state/model_revision` 做 CAS；不写 `speaker_label_override`，不改
 正式 manual assignment。
- speaker patch transaction 不修改 text、normalized text、is_final、stable prefix、active
  revision 或正文 fingerprint。
- final 重分段后的自动 speaker 也通过 lineage 投影；冲突退为 anonymous/unknown，不猜姓名。

SQLite 复合归属只能由匹配的 parent key/UNIQUE key 或等价事务 guard 证明；多个独立单列 FK
不能证明 asset、revision 和 meeting 属于同一聚合。SQLite 官方约束说明：
https://www.sqlite.org/foreignkeys.html

## 服务端映射

- 现有 transcription job 仍是任务 owner；attempt/generation/run 必须进入所有 commit CAS。
- ASR text commit 后立刻进入 projection，随后才投递 bounded speaker lane。
- speaker queue 满、CAM++ unavailable 或失败只写 typed speaker outcome，不影响 text commit、
  text close 或 stop-ready。
- account/device/guest route 只调用同一个 projection query；task status 不是正文读取前置。
- server full/delta 直接由正式 draft/final/lineage 状态生成，不另建一套正文镜像表。
- `no_speech` 是 source outcome，不是 transcript failure；它不能生成空 segment，也不能触发
  CAM++。

## 概念与删除预算

新增窄概念：

1. strict projection envelope decoder；
2. exact revision consumption cursor；
3. many-to-many replacement lineage。

不得新增：第二 transcript ledger、第二 task owner、manual overlay、通用 Artifact DAG、独立
speaker task owner或第二 finality。

候选通过后应可删除六条等待/定义边：speaker-before-text、speaker-before-close、speaker
backlog-before-stop、task-before-read、account-final-only 与 device-only draft，以及 VAD segment
直接等同 display sentence 的 UI 假设。

## 下一隔离候选门禁

1. 从当前真实 migration 建临时 DB，而不是手写宽松 stub；至少包含 draft/final/history、
   existing manual assignment、emoji/combining/ZWJ 和同 asset 多 revision。
2. 先完成跨语言 JCS/Unicode 固定 fixture；decoder API 不暴露 local digest 参数。
3. delta ordinal/source collision、close delta、speaker closed 回退、跨 meeting/epoch/asset/run、
   unknown key、raw trim 和 replay 全部在 transaction 前拒绝。
4. split、merge、many-to-many、人工同名/冲突和 final commit 崩溃全部验证；正文与 manual lineage
   不出现半提交。
5. 同一会议至少两个 asset：A 已 final、B running，B delta/final 前后 A 的正文、manual、引用和
   active 可见性 100% 保留；删除或重处理 B 也不能重写 A。
6. server/mobile 使用同一 envelope fixture；account/device/guest 返回相同 meeting-level 可用水位。
7. 等速 PCM 与真实 repository 之前，仍不得写 partial/stable p95、CER、DER 或用户可见收益。
