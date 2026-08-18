# 候选 0018：语音 revision owner 事务草图否决证据

## 范围

- 候选目录：`$CANDIDATE_ROOT/speech-revision-ledger-0003`
- 状态：`rejected as integration candidate`; **not adopted**
- 生产修改：无；没有修改数据库、服务、模型、设备或 APK。
- 目的：验证现有 job、draft 和 canonical 角色能否用一个孤立 SQLite 草图证明
  text/speaker 双 revision、原子 projection 和 draft/final 交接。

该候选不是生产迁移，也不能连接真实数据库。它保留为反例和事务测试材料，防止后续
把“SQLite 原子性”误写成“唯一 owner 已成立”。

## 已验证的窄事实

修正非法 `revision=0` 测试、最终内容 ID 对中间 revision 的污染、区间重叠和一致性
快照后，候选单元测试为 `25/25`。同一完整测试套件并行重复 256 次未出现偶发失败；
`PRAGMA integrity_check=ok`，foreign-key violation 为 0。

独立故障注入还确认：

- 未提交写入和 close 中 `os._exit` 均完整回滚；
- commit 返回后退出会保留结果；
- WAL reader 在 writer 未提交时同时看到旧 projection 和旧正文，提交后同时看到新版；
- 正文已经 final 时，close 与 speaker patch 可由 SQLite 写锁串行且不丢字段。

这些只证明单库事务的基础性质，不证明 owner、EOF、水位、移动端消费或用户体验。

## 阻断性反证

### 1. 孤立 schema 不能成为真实 owner

候选自行定义 `transcription_jobs/transcript_drafts/transcript_lines`。真实服务已有结构
不同的 `meeting_recording_transcription_jobs_v2`、
`meeting_recording_transcript_drafts_v1` 和 `transcript_lines`：

- `backend/app/models/meeting_recording_asset.py:81-115`
- `backend/app/models/meeting_recording_transcript_draft.py:14-62`
- `backend/app/models/transcript.py:10-35`

指向主库时，`CREATE TABLE IF NOT EXISTS transcript_lines` 会静默保留旧结构，随后访问
候选的 `run_id` 列失败；使用独立库则形成第二套持久 owner。候选也没有
`meeting_id/user_id/data_epoch_id` 和真实 asset FK，设备数据域删除不会清理它。

### 2. `max(segment.end)` 不是处理水位

候选用已登记 segment 的最大结束位置更新 `observed_through_sample`，无法区分 VAD
确认的静音区间和尚未扫描的音频。实测只登记来源前半段也可以 close，之后的 segment
被 `run_not_writable` 永久拒绝。这直接违反 0007 已冻结的禁止项。

下一合同必须由解码/VAD owner 持久提交 `source_total_samples + decode_cursor +
manifest_eof`；manifest 最大结束位置只能是观测值，不能授权 seal 或 close。

### 3. close intent、active generation 和 fencing 缺失

close 先于最后 final text 到达时会返回 `final_text_incomplete`；后续正文成功但 run
保持 `running`，没有持久 close intent 供恢复。`parent_run_id` 也不是 asset 当前结果
指针，旧 run 的迟到 text/speaker 可以继续写。

真实 job 的 `attempt` 已存在，但当前 draft 写和 final 提交不检查执行 attempt：

- claim 仅执行 `job.attempt += 1`：
  `meeting_recording_asset_service.py:773-809`
- draft 写只检查 `queued/running`：
  `meeting_recording_asset_service.py:121-197`
- final 重新读取 job 后直接替换 canonical：
  `meeting_recording_asset_service.py:881-964`

因此 SQLite 写锁不能阻止失效 worker 用更高 revision 覆盖当前 worker。下一候选必须
复用 `attempt` 作为 fencing epoch，并在每次 draft、cursor、speaker 和 final 事务中
做 CAS；不得新增独立 lease owner。

### 4. 投影合同不完整

manifest-only segment 在候选 snapshot 中返回 `segment_id=None`，snapshot 也不返回
`maturity`。ordinal 只检查连续整数，不检查与 sample 时间单调一致；实测 ordinal 0
可位于 ordinal 1 之后并按错误顺序 close。浮点 revision/stable prefix 会被 SQLite
作为 REAL 接受，`unavailable` speaker 还能同时携带 profile/name/confidence。

即使修正这些局部缺陷，现有 HTTP 仍把 draft/final 包装成不同 ID，并用时间戳和数量
拼 revision；手机把响应 `id` 当 source identity，且没有 remote projection CAS。孤立
ledger 内正确不能穿透真实 API 和手机。

### 5. 讲话人不是可直接覆盖的 canonical 字段

真实系统已有 `MeetingSpeakerAssignmentV2.user_locked`。候选迟到 speaker patch 直接更新
canonical speaker 字段，会越过人工修正。自动 patch 必须校验 active generation，并作为
低优先级 overlay；`user_locked=1` 永远优先。text lane close 也不能等同 speaker lane
完成，否则手机会过早清除任务或继续把可读文字显示为处理中。

### 6. 该身份工厂不能启动 live run

候选 segment ID 依赖完整来源 SHA；实时录音开始时尚无最终文件 SHA。下一候选必须在
采集前预留 capture/asset/run identity，由服务端直接返回稳定 segment ID。停止录音后的
文件 SHA 是完整性材料，不得反向更换已经展示的 segment ID。

## 保留与删除

保留的合同材料：

- text/speaker revision 独立；
- stable prefix 和 final 不可改写；
- projection 与可见状态同事务前进；
- speaker patch 不改变 final text content ID；
- rollback、重启、乱序和 Unicode fixture。

否决的实现方向：

- 新建一套独立 job/draft/canonical schema；
- 用 manifest 最大结束位置作为 sealed watermark；
- 用 SQLite 写锁代替 writer fencing；
- 让自动 speaker patch 直接覆盖人工锁定；
- 在 HTTP/手机合同未变时宣称双 revision 已落地。

## 下一门禁

下一候选必须是对真实 schema 的**加法迁移和事务补丁**，而不是平行 ledger。至少证明：

1. 新 job 使用 `contract_version=2`，旧在途 v1 不转换；
2. `attempt` claim CAS 和每次写入 fencing；
3. source EOF 前禁止 close，close intent 可跨重启收敛；
4. 每个 asset 只有一个 active generation，旧 run 迟到事件被拒绝；
5. draft/final 使用同一 `source_segment_id`；
6. 人工 speaker lock 优先，text/speaker 各有终态；
7. 手机按 `run_id + projection_revision` CAS，跳号重取全量；
8. device data epoch 删除能级联清理新增 manifest 和 projection 数据；
9. 零语音来源可成功关闭为空文字结果；
10. checkpoint 只作可删计算缓存，不再与数据库共同拥有恢复进度。

在该门禁通过前，候选 0018 只能标记为 `rejected`，不得生成 protocol-2、生产迁移或
Native 集成结论。
