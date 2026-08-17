# 蓝图修订 0008：语音 active generation 与现有 owner 收敛

## 状态

- revision: `0008-speech-active-generation-owner-contract-20260816`
- status: `candidate`; **not adopted**
- parent: `0007-speech-identity-revision-owner-boundary-20260816`
- observed: `2026-08-16 Asia/Shanghai`
- source commit observed: `48e3b36`
- production mutation: none

## 触发原因

0007 要求先证明唯一 revision owner。隔离候选 0003 虽通过 `25/25` 合成事务测试，
两轮全新非 Fast 独立审计均判定 `REVISE`：它若连接真实库会与现有表冲突，若使用
独立库则成为第二 owner；同时缺少 EOF、active generation、writer fencing、设备数据域
删除、人工讲话人锁定和手机 projection CAS。完整证据见
[candidate 0018](../evidence/candidate-0018-speech-revision-owner-rejection-20260816.md)。

0008 不撤销 M1-T 的“文字先可见、讲话人迟到 patch”，但撤销“先完善孤立 ledger 再
映射生产”的路线。下一候选必须直接演进真实 job/draft/canonical 角色。

## 本修订的架构选择

### C0：保留生产，不再补隐式状态

当前生产继续作为冻结回滚基线。它仍由单 in-process queue 限制并发，没有数据库级
worker fencing；draft revision 是时间戳/数量拼接，final 会删除并重建 canonical。
这些是 observed 事实，不再通过增加页面轮询、fallback 或另一张 ledger 掩盖。

### M1-O：现有 owner 的版本化演进

选择 `M1-O (owner convergence)` 作为下一隔离候选：

```text
existing RecordingAsset
  -> existing TranscriptionJobV2 (run_id, contract_version, attempt fence)
      -> child SegmentManifest (identity + source coordinates)
      -> existing Draft rows (text lane revisions)
      -> existing TranscriptLine (active canonical generation)
      -> existing SpeakerAssignment overlay (manual lock wins)
```

不创建第二个 job、canonical transcript 或独立任务 worker。允许新增的 manifest 只是
现有 job 的级联子表，没有 claim/retry/current pointer，不能独立推进状态。

### G1：统一 realtime/offline run，暂不采用独立 live ledger

目标候选优先让 realtime 和 offline 共用同一 run 合同，而不是再建一个 live-run owner。
实时采集开始前预留 `capture_id/asset_id/run_id`；闭段 segment ID 由稳定 capture identity、
ordinal 和 16 kHz PCM sample range 产生。停止后文件 SHA 只补充完整性，不更换 ID。

若真实延迟证明同一 job 事务无法承受 realtime，才允许比较独立 durable live-run；该
替代必须在同一阶段删除 `qwen_ws` 随机 UUID 直写和 guest 内存 writer，否则直接否决。

## 真实 owner 合同

### Job 与 writer fence

- `meeting_recording_transcription_jobs_v2` 增加 `contract_version`、独立的
  `text_state/speaker_state`、`projection_revision`、`close_requested`、
  `decode_cursor_sample`、`source_total_samples` 和 `manifest_eof`。
- 只允许 scheduler 用 `UPDATE ... WHERE status='queued' AND attempt=:expected`
  原子 claim，并返回递增后的 `attempt`。该 attempt 就是 writer fencing epoch，不新增
  lease 表。
- 每次 manifest、draft、cursor、speaker 和 final 写都必须带 `run_id + attempt`，并在
  同一事务检查。失效 attempt 无论 revision 多大都不能写。
- SQLite busy 映射为稳定的 retryable 错误；重试仍必须使用同一 attempt，不能借重试
  绕过 fence。

### 来源、manifest 与 close

- `decode_cursor_sample` 只能由解码/VAD reducer 在已经提交该区间全部 manifest 后前进；
  `max(segment.end)` 仅作诊断，不作授权。
- `source_total_samples` 在导入文件解码后冻结；实时录音停止时冻结。`manifest_eof=1`
  表示 reducer 已处理完整来源，不表示所有 ASR/speaker 都完成。
- manifest ordinal 必须与 sample range 严格单调、互不重叠。不同 VAD 边界建立新
  generation/run lineage，不复用旧 segment ID。
- close 请求先持久化。只有 `manifest_eof=1`、cursor 到 source total、所有 manifest
  text final 且 attempt/active generation CAS 通过时，才原子关闭文字。
- 没有语音 segment 但 EOF 完整是成功的空文字结果，不再把无讲话音频伪装成处理失败。

### Active generation 与 canonical

- RecordingAsset 保存当前 active transcription generation/run 指针。新 v2 run 的创建
  和 supersession 必须 CAS；`parent_run_id` 只保留 lineage，不能充当 current pointer。
- final 事务同时验证 EOF、attempt、asset active generation，然后按稳定
  `source_segment_id` upsert/替换该 asset 的 canonical、写 `result_revision_id`、推进
  `projection_revision` 和 `text_state`。任一 CAS 失败则整笔回滚。
- 旧 run 的迟到 text/speaker、checkpoint 恢复或 final 一律拒绝；它们不能修改当前
  asset 投影。
- `TranscriptLine.id` 与 API `source_segment_id` 的映射必须跨 draft/final 稳定。不得再
 用 job/timestamp/文字/讲话人二次包 UUID。

### Speaker lane 与人工编辑

- 自动 speaker patch 记录独立 `speaker_revision`、`speaker_model_revision` 和来源 run；
  它不改变 final text revision。
- canonical 显示通过现有 `MeetingSpeakerAssignmentV2` overlay 解析。`user_locked=1`
  永远优先，自动 patch 不得直接覆盖或删除人工 assignment。
- `text_state` 到 `closed` 即可展示、整理和引用正文；`speaker_state` 可继续
  `pending -> closed/unavailable`。设备任务和 UI 不得用一个 completed 布尔值混淆两者。
- speaker 永久失败必须有 `unavailable` 终态，不能让会议永久显示处理中。

## API 与手机投影合同

v2 run 的全量 snapshot 至少返回：

```text
run_id
contract_version
text_revision_id
projection_revision
text_state
speaker_state
source_total_samples
decode_cursor_sample
segments[].source_segment_id
segments[].text_revision / maturity / stable_prefix_codepoints
segments[].speaker_revision / speaker_state / speaker_model_revision
```

- 手机按 meeting/asset/run 持久化最后应用的 remote `projection_revision`，不能复用
  scope-wide `canonical_revision`。
- 只接受同一 active run 的更高 projection；重复 revision 必须字节等价，跳号或 run
  变化时重取全量 snapshot。手机不得自行铸造 remote revision。
- draft/final/late speaker 保持同一 `source_segment_id`；一行修订和 speaker patch 不新增行。
- 第一切片继续短轮询全量 snapshot。delta/long poll 只有在该 CAS 合同通过后再评估，
  不作为首刀前置。

## 数据边界与 checkpoint

- 新 manifest/projection 字段必须通过真实 job -> asset -> meeting 级联或显式清理纳入
  device data epoch 删除闭包，不保存正文日志。
- 旧 filesystem checkpoint 降级为可删除计算缓存。数据库 run/manifest/cursor 是恢复
  权威；checkpoint epoch/run 不匹配时直接丢弃，不能反向推进 DB。
- 不持久化 CAM++ 原始 embedding。若未来需要，必须另过生物特征加密、权限、TTL 和
  删除门禁。

## 迁移与回滚

1. 只做 additive schema migration；旧 `contract_version=1` job 和当前在途 job 按 C0
   完成，不转换 ID、毫秒坐标或 owner。
2. migration 后新建 job 才使用 v2 contract。v1/v2 API projector 都只能读取各自 owner，
   不执行第二次 ASR/CAM++。
3. v2 先在隔离库和影子任务验证；生产默认仍为 v1。回滚只停止创建 v2 job，不需要
   回写或删除 v1 数据。
4. 只有 v2 active generation、手机 CAS、删除闭包和真实恢复通过后才允许切默认；旧
   projector 的删除仍遵守 0007 的客户端覆盖和保留期门禁。

## 下一隔离候选 0004

下一候选不改生产，使用真实表名和字段基线建立迁移副本，至少覆盖：

1. 旧库迁移和在途 v1 不变；
2. 两个 worker 竞争 claim，只有一个 attempt 可写；
3. EOF 前 close、close/final 乱序和 API 重启恢复；
4. active generation 切换后旧 run 的 text/speaker/final 全部拒绝；
5. 空语音成功关闭；ordinal/sample 逆序和区间重叠拒绝；
6. draft/final 同 segment ID，speaker patch 不改 text revision；
7. 人工 speaker lock 优先以及 speaker unavailable 终态；
8. 手机重复、乱序、跳号、run 变化和全量恢复 fixture；
9. data epoch 删除后 manifest/draft/canonical/projection 无残留；
10. DB busy、提交前退出、提交后退出和 checkpoint epoch 不匹配。

候选通过后仍只获得 `validated in isolation`，不等于生产采用。下一步才是把同一事务
补丁嵌入隔离服务副本，并以真实脱敏 PCM 比较 C0/M1-O 的首个可读文字、最终文字、
speaker patch 延迟和资源。

## 当前结论

M1-T 的用户结果方向保留；孤立 ledger 路线被否决。当前目标收紧为
`M1-O: existing owner convergence`，生产继续 C0。0008 是 `candidate; not adopted`，
没有任何 schema、API、Native 或 provider 迁移已经发生。
