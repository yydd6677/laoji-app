# 候选 0038：mobile speech publication adapter 0009 独立否决

## 状态

- candidate: `$CANDIDATE_ROOT/speech-publication-mobile-adapter-0009`
- implementation snapshot:
  - `projection_contract.ts`: `268d586febb6ff942e858b0618bad8544bc3c7c796379bf49f96e9201612c9e6`
  - `sqlite_schema.sql`: `f48cdf03ff13be93cfe6494e54d8e4326482bf01ab02dd08ef70700348b58cce`
- independent verdict: **BLOCK integration; rejected-current-shape**
- adoption: **not adopted**
- production/App/APK mutation: `none`

0009 没有继续使用 0005 的 UTF-16 计数和第二套 manual overlay 表；它还把 cursor 的会议归属
改为只经正式 `recording_assets` 外键取得。这两点是有效改进，但不能抵消以下合同缺口。

## 已复现阻塞

### 1. close 不是完整状态转换

`textClosed=true` 的 delta 只验证本次携带的 segment。它与旧状态合并后，未携带的
`provisional` segment 仍被保留，但整体却被标为 closed。另一个 delta 可以新增不同
`sourceSegmentId`、相同 ordinal，合并后产生两个 ordinal 0；reducer 返回 applied，直到真实
数据库唯一约束才晚失败。

`speakerClosed` 也没有封闭语义：可以在 pending segment 存在时关闭，下一 revision 又可回退
为 open，关闭后仍可继续改 speaker revision。

### 2. manual helper 可跨会议串用人工姓名

`ManualSpeakerAssignmentView` 只有 `sourceSegmentId`、revision、name 和 lock，没有 scope、
data epoch、meeting、asset、generation 或 run。`effectiveSpeakerName` 与
`planManualSpeakerCarry` 都只按 source ID 匹配。独立反例把 meeting A 的人工姓名带入
meeting B/epoch B 的同名 source segment，函数正常返回 carry plan。

### 3. digest 参数可以自证

`applyRemoteProjection` 接受调用者传入 `locallyCalculatedDigest`，但不在唯一入口内计算。
调用方直接把响应的 `snapshotDigest` 原样作为该参数即可通过。除此之外，identifier 先对 raw
payload hash、落库前再 trim；segment/replacement 数组顺序、未知字段和跨语言
`localeCompare` 也没有冻结为同一规范。

这意味着当前 digest 既不能证明实际做过本地计算，也不是持久语义状态的跨端稳定指纹。

### 4. replacement 与人工修正没有原子边界

当前 replacement：

- 允许不存在于旧状态的额外 `from`；
- 允许 `from` 同时继续存在于 final；
- 不支持一个旧 segment 拆成多个 final segment；
- 没有进入 `PersistedProjectionState`；
- carry plan 没验证 next identity/digest，也没有与正式 correction/assignment 同事务。

正文 replacement 提交后、人工姓名 carry 前崩溃会永久丢失映射。将更多 CAS 加进纯 plan
仍不能关闭该事务窗口。

### 5. SQLite 形成双状态且没有唯一写入目标

迁移把全部旧行默认成 `text_maturity='final'` 与
`stable_prefix_codepoints=0`。非空 final 立即违反 TypeScript 合同；旧 `is_final=0` draft
也被误标为 final。新 `text_maturity` 与既有 `is_final` 同时可写，形成两套 finality。

cursor 没有 `transcript_revision_id` 外键。同一 asset 有 draft、final 和历史 reprocessed
revision 时，adapter 无法由 cursor 唯一决定写哪份。`transcript_segments.meeting_id`、
`revision_id` 与 `source_recording_asset_id` 仍是彼此独立的单列外键，也不能仅凭
`PRAGMA foreign_key_check` 阻止跨会议 asset 绑定。

自动 speaker 新 revision/state 与既有 `speaker_profile_id/speaker_label/is_final` 的单向投影
没有定义。候选确实没有第二 manual 表，但尚未证明只有一个正文/自动 speaker 状态 owner。

## 动态证据

冻结目录现在保留通过式反例，而不是把预期安全行为伪装成通过：

```text
TypeScript adversarial reproductions: 6/6
SQLite ownership/migration reproductions: 6/6
```

TypeScript 六项分别复现 Unicode 修复、close delta 漏 provisional、delta 重复 ordinal、
speaker close 回退、跨会议 manual 泄漏和 digest 自证。SQLite 六项确认 cursor 经 asset 归属、
没有第二 manual 表和 cascade 等保留项，同时固定 legacy final/prefix 矛盾。

这些 `12/12` 只证明反例可重复，不是候选验收通过。

## 保留、废弃和下一边界

保留：

- Unicode scalar-value 校验与孤立 surrogate 拒绝；
- scope/epoch/meeting/local asset/remote asset/generation/run 的完整 wire identity；
- text 与 automatic speaker revision 分离；
- cursor 作为消费水位而非 task owner；
- 正式 manual correction/assignment 继续是唯一人工姓名 owner。

废弃当前 reducer/schema 形态，不再直接修 0009。下一候选必须先解决：

1. 唯一 decoder 内严格解析、规范化并自行计算摘要；
2. close 只接受完整 snapshot，delta 合并后重验全局不变量；
3. cursor 绑定 exact transcript revision；
4. 只保留既有 `is_final` 一份 finality；
5. many-to-many replacement lineage 与 final revision 在同事务提交；
6. manual 显示通过正式 assignment + lineage 解析，不复制第二份人工姓名。

