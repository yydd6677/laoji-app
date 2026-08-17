# 候选 0037：mobile speech projection 0005 独立否决

## 状态

- candidate: `/home/yydd/LaoJi-candidates/mobile-speech-projection-0005`
- original self-test: TypeScript `9/9`, SQLite `2/2`
- independent verdict: **BLOCK integration; rejected-current-shape**
- adoption: **not adopted**
- production/App mutation: `none`

本轮独立复跑原测试，全部通过；随后按真实 Unicode、会议归属和现有 speaker owner 做反例
审计。通过原测试不等于候选能安全接入 App。

## 可复现阻塞

### 1. codepoint 合同实际使用 UTF-16 code unit

字段名和 README 声称 `stablePrefixCodepoints`，实现却用
`segment.text.length`、`slice(0, count)`。JavaScript 的这两个操作按 UTF-16 code unit，
不是 Unicode codepoint。

独立反例：

- 当前稳定文字 `A😀x`，声明前 2 个 codepoint 稳定；
- 下一 revision 改为 `A😁y`，同样声明 2；
- reducer 错误接受，因为 `slice(0, 2)` 只截到两个 emoji 共有的 high surrogate；
- 合法 final `A😀x` 的 codepoint 数是 3，但 `text.length` 是 4，候选反而以
  `final_text_not_stable` 拒绝。

动态结果：

```json
{"changed_stable_codepoint_accepted":true,"valid_final_codepoint_count_rejected":true}
```

candidate 0017 已有 Python/TypeScript/Kotlin 一致的 scalar-value 合同，0005 没有复用它。
这会允许稳定文字静默改写，属于正文正确性阻塞。

### 2. SQLite 外键不能证明 asset 属于同一 meeting

`remote_transcript_projection_cursors_v1` 分别外键到 `recording_assets(id)` 和
`meeting_notes(id)`，但没有复合约束证明两者属于同一会议。独立内存 SQLite 反例把
`meeting-a` 的 `asset-a` 与 `meeting-b` 的 cursor 成功写入，且
`PRAGMA foreign_key_check` 仍为空。

同一缺口也存在于 remote/manual overlay 的重复 `meeting_id`。在真实仓库中，这会使
错误 meeting scope 的 speaker/cursor 行满足所有单列外键，不能进入集成。

### 3. 新建了第二套 manual speaker owner

正式 App 已有 `speaker_corrections` 和 `speaker_assignments`，包含 scope、base revision、
assignment revision、sync state、manual/remote/reprocessed 来源和 user lock。候选另建
`manual_speaker_source_overlays_v1`，却没有 backfill、双读一致性、CAS 或删除旧写权的
实现。README 也明确承认迁移不存在。

在该状态接入会让“用户手动姓名”同时由两套表拥有；这违反一个能力一个 owner，不可用
“先双写一版”绕过。

### 4. 还不能消费真实 final replacement

候选要求 full snapshot 的 ordinal 从 0 连续，并禁止同 generation 的 full snapshot 删除
任何旧 segment。当前文件转写会在 provisional 后做 overlap 去重和全局说话人处理，final
可能需要 replacement/resegmentation；候选没有 source replacement map，无法区分合法合并
与数据丢失。

此外：

- reducer 只检查 `snapshotDigest` 格式，不计算规范 payload digest；README 把这项留给
  尚不存在的 adapter；
- `assetId` 没有区分本地 recording asset 与服务端 remote asset，manual overlay 又用它
  作本地归属键；
- 没有 scope/data epoch、delete tombstone、真实 repository transaction、App 重启或
  summary/citation 保留合同。

## 保留与停止

保留的产品合同：

- 文字 revision 与自动 speaker revision 分离；
- speaker patch 可迟到且不能改写已封闭文字；
- manual 显示优先；
- generation/run/projection cursor 拒绝旧结果。

不保留 0005 的独立 schema 和 reducer 实现。下一候选不得在该目录做第二轮自我修补；应
直接映射真实 `transcript_revisions/transcript_segments/speaker_corrections/
speaker_assignments`，复用 candidate 0017 的跨语言 Unicode 合同，并先定义 provisional
到 final 的 replacement lineage。只有真实 repository adapter 能证明删除旧写权后，才可
新增最小 remote automatic overlay/cursor。

