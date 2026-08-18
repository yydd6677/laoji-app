# 候选 0040：speech projection atomic seam 0010 根审计

## 状态

- implementation: `$CANDIDATE_ROOT/speech-projection-atomic-seam-0010`
- root audit: `$CANDIDATE_ROOT/speech-projection-atomic-seam-0010-root-audit`
- implementation self-test: TypeScript `21/21`, Python fixture `2/2`, strict typecheck passed
- root adversarial reproductions: `5/5`
- verdict: **BLOCK integration; rejected-current-shape**
- independent-agent approval: `not performed`
- adoption: **not adopted**
- production/service/database/App/APK mutation: `none`

0010 是 0009 后的架构重做，不是原 reducer 的第三轮补丁。它直接执行真实 mobile migration
0001/0002/0005/0011/0025，保留 `is_final` 和正式 manual owner；strict decoder 自行 hash，
exact revision cursor、delta merged invariant、many-to-many lineage 与 final transaction 都有可执行
证据。这些改进真实存在，但仍不足以进入老记实际 repository。

## 通过边界

- strict UTF-8/JSON 拒绝 duplicate/unknown key、trim identifier、孤立 surrogate 和 schema 外
  数字；payload digest 在 decoder 内计算。
- TypeScript/Python 对冻结 integer-only JCS 子集得到一致结果。
- delta 没有 close/lineage vocabulary；gap 明确 refetch；合并后重复 ordinal 被事务前拒绝。
- cursor 绑定 recording asset 与 exact transcript revision，scope/meeting/asset 通过真实表 join。
- final/reprocessed segments、lineage、active pointer 与 cursor 在一个 SQLite transaction；四个故障
  点全部 rollback。
- automatic speaker patch 不改变 text fingerprint；speaker close 不回退。
- manual assignment 不复制；同名 ancestor 继承，不同姓名返回显式 conflict。

这些结果只证明单会议、单资产、本地 `node:sqlite` seam。

## 五个动态阻塞

### 1. 第二 asset 无法进入同一会议

首个 asset 建立 active draft 后，为同一 meeting 的第二个正式 `recording_assets` 行应用 initial
full，repository 返回 `unexpected_active_transcript_revision`。这不是罕见边缘：真实会议允许
录音、导入和多个 recording asset；当前 `transcript_revisions.is_active` 又是 meeting-level
unique。

因此当前代码既没有 meeting aggregate + asset slice，也没有安全的 per-asset subrevision。

### 2. lineage 阻塞会议删除

final commit 后，`transcript_segment_lineage.from_segment_id` 使用 `ON DELETE RESTRICT`。执行正式
`DELETE FROM meeting_notes` 的 cascade 时触发 `FOREIGN KEY constraint failed`，会议仍保留。
这会直接回归用户已有的删除/回收站能力，也使历史 revision prune 无法完成。

### 3. run identity 污染 job provenance

`insertSegment` 把 wire `run_id` 写入既有 `source_transcription_job_id`。mobile schema 没有
`meeting_recording_transcription_jobs_v2` 表，wire 也没有真正 job ID；run 与 job 是不同身份。
这会让下游 provenance、恢复和 server mirror 对同一字段产生两种含义。

### 4. no-speech 无法表达

wire final 要求至少一个非空 text segment，且没有 source outcome 字段。合法的“音频无人说话”
只能得到 `final_snapshot_incomplete`，无法投影为成功空文字。老记当前已经把 no-speech 作为
正常结果，不能重新退化为失败或永久 processing。

### 5. legacy automatic speaker backfill 不一致

迁移默认 `automatic_speaker_state='pending'`、revision 0，却不根据旧
`speaker_profile_id/speaker_label` 回填。数据库接受 pending + legacy profile/name；
`readSegments` 也返回这一 wire 禁止组合。下一次 revision 会与同 revision speaker material
冲突，旧数据无法稳定进入新 adapter。

## 其他未关闭边界

- `node:crypto`、`node:sqlite` 与 `Intl.Segmenter` 尚不能证明 Expo/Hermes/Android 可运行；
- strict JSON 是自写 parser，需要依赖与攻击面审计；
- server attempt/generation、source outcome、bounded speaker recovery、meeting multi-asset envelope、
  process kill、Kotlin/ICU 和真实 PCM 均未实现；
- 完整 mobile migration 和真实已有数据库未验证；
- root audit 不是独立代理验收，不能用于 adoption。

## 停止与保留

按 revision 0016 的“两轮 speech 后转队列”停止当前组合，不修 0010 第二版。保留：

- strict decoder 内部 hash 与 Unicode fixtures；
- merged delta invariants；
- final transaction fault injection；
- manual-through-lineage 的同名/conflict 语义；
- meeting-level aggregate vs per-asset subrevision 的反事实输入。

下一蓝图轮次转会议问答 Q2-S shadow。未来重开 speech 时，必须从 meeting-level multi-asset
owner 决策开始，而不是再次扩展 0010。

