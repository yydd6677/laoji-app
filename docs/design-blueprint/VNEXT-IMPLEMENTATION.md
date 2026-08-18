# 老记 vNext 实施指示

- architecture: [VNEXT.md](VNEXT.md)
- decisions: [VNEXT-DECISIONS.md](VNEXT-DECISIONS.md)
- baseline release: `1.1.10 (118)`
- implementation status: `Stage 0/1 completed; Stage 2 isolated candidate; Stage 3 source-stream/Facts-V3 artifact candidate and Stage 4 schedule provenance slices implemented, not adopted`

本文供开发执行。阶段可以拆成多个提交，但不得改变 VNEXT 的数据所有权、领域边界和选定路线。
任一阶段只能在入口证据满足后开始，在退出门全部满足后切换默认路径。

## 0. 已核对的实施基线

2026-08-17 只读现场核对：

- `laoji-api.service` active，cwd 为
  `$SERVER_DEPLOYMENT_ROOT/compact-production/backend`，监听 `127.0.0.1:18020`；
- `laoji-asr.service` active，使用同一 cwd 下 `qwen_asr_service/server.py`；
- `laoji-ollama.service` active，监听 `21434`；Cloudflare Tunnel 直连 `18020`；
- OpenAPI 同时存在 account、`/api/laoji`、device v1、laoji v1/v2 和 guest route，证明兼容面需要
  显式切除，不能假设已经统一；
- 当前非空业务库包括 backend `local.db`、`schedule.db` 和
  `data/speaker_voiceprints.db`；`app/local.db` 与多个 `data/*.db` 为 0 字节占位，未完成配置/引用
  审计前不得删除或误认权威；
- 当前 GPU0 上老记 ASR 约 6.0 GiB、9B runner 约 8.5 GiB、API 约 0.6 GiB；其他进程同时占用，
  因此 vNext 不增加 GPU 常驻模型，embedding 固定 CPU/按需；
- Stage 0 已将真实后端导入并版本化到 `services/laoji-api` 和 `services/laoji-asr`，并由本地
  `vnext-stage0-1.1.10-118` tag 冻结；后续实现以该 tag 作为后端恢复边界。
- Git `HEAD` 的移动 migration 只到 v38，但公开 1.1.10 APK bundle 已检出
  `summary_fact_documents/summary_v3_upgrade_tasks` v39 SQL；当前 dirty worktree 包含对应未跟踪源码。
  因此实现基线必须冻结 APK 对应的完整 dirty source，而不是把 `48e3b36` 当可重建发布快照。

## 1. 代码库与生成合同

当前权威移动端工作树：

`$MOBILE_REPO`

Stage 0 已将生产机 `$SERVER_DEPLOYMENT_ROOT/compact-production/backend` 冻结并导入同一
版本控制边界，当前布局：

```text
contracts/vnext/              JSON Schema, fixtures, compatibility matrix
src/domain/                   mobile domain values and validators
src/data/repositories/        single local business repositories
src/application/              use cases; no HTTP/SQLite/native SQL
src/services/remote/          domain API clients and operation projection
modules/laoji-native-platform Android system capabilities only
services/laoji-api/           FastAPI domain routes, task owner, orchestration
services/laoji-asr/           Qwen3-ASR adapter service
deploy/linux/                 systemd, Cloudflare, environment templates
tools/vnext/                  Linux/Windows portable migration and audit tools
```

权威 schema：

- `entity-revision.schema.json`
- `device-authority.schema.json`
- `meeting-binding.schema.json`
- `generation-source-envelope.schema.json`
- `source-ref.schema.json`
- `task-attempt.schema.json`
- `content-outcome.schema.json`
- `operation-envelope.schema.json`
- `source-stream.schema.json`
- `source-bundle-group.schema.json`
- `purge-journal.schema.json`
- `projection-envelope.schema.json`
- `schedule-mention-graph.schema.json`
- `upload-session.schema.json`
- `realtime-asr-session.schema.json`
- `transcript-revision.schema.json`
- `meeting-facts-v3.schema.json`
- `meeting-answer-v2.schema.json`
- `error-envelope.schema.json`

使用脚本生成 TypeScript、Kotlin serialization DTO 和 Python Pydantic models。CI 对生成后 diff
失败关闭；禁止三端手写同名 wire type。

## 2. 当前模块到 vNext 的映射

| 当前入口 | vNext 归属 | 动作 |
| --- | --- | --- |
| `src/store/EventsStore.tsx` | ScheduleRepository + view store | 业务写入下沉 repository；store 只订阅 |
| `src/services/localScheduleParser.ts` | local MentionGraph producer | 拆出 recognizers；不再拥有最终 Draft 规则和服务路由 |
| `src/services/deviceApi.ts` schedule methods | `src/services/remote/scheduleApi.ts` | v2 graph API；删除服务端规则回退 |
| `VoiceInputModal*.tsx` / `ScheduleVoiceHostView.kt` | ScheduleVoiceSession | 先录音缓冲、后连 WSS；同一 clarification state |
| `meetingMediaImport*` / `MediaAudioExtractor.kt` | MediaAsset ingest | 保留；导入事务先创建本机 asset generation |
| `MeetingUploadWorker.kt` / `nativeTransferCoordinator.ts` | UploadExecutor | 改为 direct R2 single/multipart + server probe |
| `recordingAssets.ts` 旧 content API | v1 compatibility adapter | 一个发布周期后删除 |
| `realtimeAsr.ts` / `RealtimeAsrSocket.kt` | realtime ASR adapter | 保留 WSS，统一 partial/stable/final schema |
| `deviceTranscriptTasks.ts` | DeviceOperation projection | 不再拥有第二任务生命周期 |
| `processing.ts` / `meetingStageMirror.ts` | derived OperationStatus | 页面只读派生状态；删除任意跨阶段写入 |
| `meetingNoteRepository*` | MeetingRepository facade | 收敛为唯一 meeting aggregate transaction |
| `speakers.ts` / speaker Kotlin surfaces | SpeakerOverlayRepository | 自动/人工 overlay 分表和 expected revision CAS |
| `meetingSummaryV3.ts` | FactsV3 projection | 保留并扩展 deterministic chapter merge |
| `meetingSummaryTasks.ts` / `meetingSummaryProcessing.ts` | remote summary operation | 删除内存/重复 task owner |
| `meetingQuestions.ts` | legacy adapter + Q2 dispatch | Q2 路径只读取 immutable transcript/note source；旧链路在 barrier 前兼容 |
| `meetingQuestionRepository.ts` | QuestionRepository | 保存 immutable turn + exact SourceRef transaction |
| `MeetingActionsSheet.tsx` / `MeetingActionEditorSheet.tsx` | ActionItemRepository | 保留手动创建、编辑、完成、删除、负责人、截止、提醒和后续日程；candidate 只提供 provenance |
| `notifications.ts` meeting action/planned-end paths | NotificationProjection | 保留本场待办与预计结束提醒；从本机 revision 重建，不成为状态 owner |
| `meetingMediaClips.ts` / `LaojiMediaClipModule.kt` | MediaClipRepository | 保留本地剪辑/导出；remote job 只在用户明确请求时创建 |
| `meetingMarkers.ts` / `meetingAttachments.ts` | MeetingRepository sources | 保留本地 CRUD；删除远端 sync owner |
| `meetingSeriesMemory.ts` / occurrence services | local MeetingSeriesRepository | 保留系列与日程关联；删除跨设备 occurrence sync |
| `notifications.ts` / native system entries | LocalScheduleProjection | 保留提醒/小组件，只读本机事件 revision |
| `currentAddress.ts` / `reverseGeocoder.ts` | LocationService | 系统地址优先，服务端反查兜底；坐标不写日志 |
| `themePreferences.ts` / ThemeProvider / native tokens | ThemeProjection | 保留标准蓝/绚彩；同一 semantic token schema |
| `privacy.ts` / AppLockGate / legal screens | LocalPrivacySurface | 保留应用锁与文书；不恢复账号 profile |
| `meetingContentMirror.ts` / `meetingLegacyMirrorCoordinator.ts` | v1 drain adapter | Stage 5 删除 |
| `nativeMinutesSnapshots.ts` / `MinutesSnapshotParser.kt` | ProjectionEnvelope | 加 revision/hash/surface fencing |
| `navigationState*` / RootStack / notification/semantic links | RouteRegistry | 从一个 registry 生成类型、注册、持久化 sanitizer 和外部入口 |
| `PrivacyScreen.tsx` + native stores/files | LocalDataEraseCoordinator | 协调 recorder/player/worker/DB/SecureStore/files/notifications/memory 清除 |
| `appUpdate.ts` | UpdateService | RETAINED；只补发布一致性自动检查 |

导入后的服务端映射：

| 当前生产模块 | vNext 目标 | 动作 |
| --- | --- | --- |
| `app/api/device_v1.py` | `app/api/device_v2/*` | 按 schedule/upload/transcript/summary/question/speaker 拆 router |
| `app/services/device_identity.py` | DeviceAuthority | 保留并收紧 device+epoch+token revision |
| `app/services/summary_task_store.py` | legacy task owner + read adapter | cutover 前旧 owner 排空；不把缺少历史血缘的行迁入新 owner |
| new generic task/attempt store | TaskAttemptOwner | cutover 后新任务唯一写 owner；领域 payload 保持 typed |
| `app/workers/summary_tasks.py` | InProcessTaskWorker | 单 worker + priority queue；删除 Celery/CLI/第二 owner |
| `app/services/llm_provider.py` | LlmProvider/EmbeddingProvider | 保留接口，业务调用静态禁止绕过；embedding CPU/按需 |
| `app/services/compact_transcription_service.py` | TranscriptOrchestrator | VAD 后 ASR/speaker 分队列，逐段 publication |
| `app/asr/*` | VAD/CAM++ adapters | 保留算法；不拥有 task/transcript business state |
| `qwen_asr_service/server.py` | `services/laoji-asr` | 保留 8030，增加 stable batch/stream schema |
| `app/services/r2_upload_service.py` / `r2_storage_service.py` | UploadSession/CleanupService | staging generation、完整性校验、独立 cleanup obligation |
| `app/services/schedule_parser_service.py` | ScheduleGraphProvider | 删除 quick/fallback 和模型后 full-text normalizer |
| `app/services/summary_v3_*` | FactsV3Service | 修血缘/原子提交，增加 deterministic chapter builder/merger |
| `app/services/vnext_source_stream_store.py` | source stream + bounded checkpoint owner | 加密章节来源、manifest/group 配额、双槽恢复点和 artifact 原子提交；默认关闭 |
| `app/services/summary_v3_chapter_merge.py` | deterministic Facts V3 reducer | 事实/关系/行动有界合并；不调用模型、不使用样本专用规则 |
| `app/services/vnext_summary_chapter_pipeline.py` | generic Task/Attempt summary adapter | 每次最多处理一章；provider 适配、checkpoint 提升和最终 artifact 提交 |
| `app/services/vnext_summary_worker.py` | source-stream summary worker | 单并发扫描 active generic task；租约心跳、重启恢复和一章一让出；默认关闭 |
| `src/services/meetingSummaryV3SourceStream.ts` | mobile source-stream summary orchestrator | 由 immutable transcript/note/授权附件构造分章来源；幂等上传、task/artifact 恢复和本地模板投影；双开关候选 |
| `src/services/questionQ2Candidate.ts` / `meetingQuestionsQ2.ts` | Q2 single-reader candidate | source snapshot、单次 reader、grounding、Q2 operation retry 和现有问答页只读投影；默认双开关关闭，等待语义 holdout |
| `src/services/questionQ2DeviceProvider.ts` | Device Q2 Provider | capability/binding fence、严格 response normalization；不回退旧问答 |
| `app/services/vnext_question_reader.py` | server Q2 reader candidate | 单次 Ollama reader、结构协议、UTF-8 引用完整性和来源 hash 校验；默认 capability 关闭 |
| `app/services/app_meeting_question.py` | MeetingQuestionQ2 | 由 5,826 行多轮链替换为 snapshot/provider/grounding/owner 四层 |
| `app/models/meeting_*sync.py` | none after v1 drain | 账号/跨设备同步模型按 Stage 5 删除 |
| `app/api/location.py` | LocationProxy | 保留缓存/限流/日志脱敏 |

## 3. 手机 canonical schema

不新建第二业务数据库。继续使用当前 Expo SQLite `laoji-meeting-memory.db`（WAL、foreign keys、
5 秒 busy timeout），在 `0039` 后增加迁移：

迁移文件按发布阶段连续落库：Stage 1 包只新增 `0040-0042`，Stage 2 再新增 `0043-0044`，Stage 4
新增 `0045`；不得提前放置高编号 placeholder，也不得让常规 migration runner 跳号或逆序执行。

### 0040 `VNextAuthorityAndOperations`

```text
device_epochs(
  epoch_id PK, status CHECK(active/retired), created_at_ms, retired_at_ms
)
device_authority_state(
  singleton_id PK CHECK(singleton_id=1),
  current_epoch_id REFERENCES device_epochs(epoch_id),
  authority_revision, next_binding_epoch_seq, updated_at_ms
)
meeting_service_bindings(
  meeting_id PK REFERENCES meeting_notes(id) ON DELETE CASCADE,
  device_epoch_id REFERENCES device_epochs(epoch_id),
  binding_id UNIQUE, binding_generation, binding_epoch_seq, binding_revision,
  state CHECK(active/purging/purged), cancel_revision, created_at_ms
)
device_operations(
  operation_id PK, device_epoch_id REFERENCES device_epochs(epoch_id),
  capability, entity_id, entity_revision, input_sha256,
  generation_id, predecessor_operation_id, creation_reason CHECK(original/retry/regenerate),
  operation_revision, cancel_revision,
  remote_task_id, accepted_attempt_id, remote_state,
  progress_done, progress_total, error_code, retry_after_ms,
  created_at_ms, updated_at_ms, terminal_at_ms,
  UNIQUE(device_epoch_id, capability, entity_id, entity_revision, input_sha256, generation_id)
)
```

`device_operations` 是远端 intent/projection，不拥有 meeting/transcript/summary business state。所有
远端结果带 epoch/operation/task/attempt/input identity；领域 repository 在一个本机事务中检查当前
epoch、operation/cancel revision、accepted attempt 与预期实体 revision 后才提交。`binding_generation`
由本机在创建会议事务中生成并保存 128-bit opaque 值；首次 `PUT` 只登记该值，服务端不得生成或
替换。未成功登记 active binding 前不得提交远端领域任务。
epoch 退休、取消
或用户重试提升 fence，迟到结果只能记脱敏诊断。Transcript/Summary 仅保存 nullable
`source_operation_id`；它是 provenance，不是第二生命周期 owner。

### 0041 `VNextCutoverTombstones`

记录已完成迁移、已关闭 owner 和兼容 API 最后使用时间。它不存业务正文，只用于阻止旧 provider/
worker 在升级后复活。

### 0042 `ImmutableSourcesAndQuestionQ2`

```text
manual_note_revisions(
  revision_id PK, meeting_id REFERENCES meeting_notes(id), revision,
  content, format, content_sha256, migrated_current, created_at_ms,
  UNIQUE(meeting_id, revision)
)
manual_notes: add active_revision_id

meeting_attachment_text_revisions(
  revision_id PK, attachment_id REFERENCES meeting_attachments(id),
  meeting_id REFERENCES meeting_notes(id), revision,
  content_kind CHECK(text/extracted_text), content, content_sha256,
  source_asset_sha256, extractor_revision, migrated_current, created_at_ms,
  UNIQUE(attachment_id, revision)
)
meeting_attachments: add active_text_revision_id

meeting_question_q2_snapshots(snapshot_id PK, meeting_id, source_fingerprint,
                              transcript_revision_id, created_at_ms)
meeting_question_q2_snapshot_sources(snapshot_id, ordinal, source_type, source_id,
                                     source_revision_id, content_sha256)
meeting_question_q2_threads(thread_id PK, meeting_id, snapshot_id, created_at_ms, updated_at_ms)
meeting_question_q2_turns(turn_id PK, thread_id, request_id, current_operation_id,
                          ordinal, question, answer_kind NULL, answer NULL,
                          provider_revision, completed_at_ms NULL)
meeting_question_q2_clauses(clause_id PK, turn_id, ordinal,
                            answer_start_utf8, answer_end_utf8)
meeting_question_q2_citations(citation_id PK, clause_id, ordinal,
                              source_type CHECK(transcript/manual_note/attachment),
                              source_id, source_revision_id, content_sha256,
                              source_start_utf8, source_end_utf8, quote_sha256)
```

每个 clause 的 citation 集合语义为 `all_of`。Q2 没有 summary 来源和 general scope；pending turn
允许 answer/completed_at 为空。升级只为迁移时真实存在的当前笔记和附件提取文本建立
`migrated_current=1` revision，不能制造过去正文；旧 `meeting_question_*` 永远不提升成 Q2。

`MeetingNoteRepository` 在保存笔记或附件提取结果的同一事务中先写 immutable revision，再更新
`active_revision_id`；内容 hash 未变化不产生新 revision。任何远端 source bundle 只能引用已经存在
的 revision，不能直接读取可变 `manual_notes`/`meeting_attachments` 行。

`action_items` 保持唯一 mutable ActionItem 表：`status=pending/completed/dismissed`、
`source_kind=generated/manual/marker`、`source_summary_version_id`、`source_segment_id`、
`source_start_ms`、负责人、截止时间、提醒 ID 和 `updated_at_ms` 必须随 CAS 更新。候选采用、手动
新建、编辑、完成/恢复、删除和后续日程都调用同一 repository/use-case；重生成只写候选，不更新
已有 ActionItem。

保留并复用：`meeting_notes`、`manual_notes`、`recording_assets`、`transcript_revisions`、
`transcript_segments`、`summary_versions`、`summary_fact_documents`、`summary_view_*`、`action_items`、
历史只读 `meeting_question_*`、新 `meeting_question_q2_*`、`meeting_tags/tag_links`、
`meeting_list_order`、`meeting_attachments`、
`meeting_content_shares`、`local_schedule_events`。

### 0043 `TranscriptOverlayAndSearchVNext`

```text
transcript_revisions: add source_manifest_sha256, text_final_at_ms
transcript_segments: add stable_segment_key, segment_revision, text_state
speaker_overlay_revisions(revision_id PK, meeting_id, transcript_revision_id, ...)
speaker_overlay_assignments(revision_id, stable_segment_key, automatic_label, confidence, ...)
speaker_manual_overrides(meeting_id, stable_segment_key, expected_transcript_revision, label, ...)
```

旧 `speaker_assignments/corrections` 只读迁移到 overlay；无法稳定映射的修正标记 `needs_review`，
不静默删除或强配到新片段。v20 已存在、且当前查询仓储仍在使用的 `meeting_search_fts` 在 Stage 2
保持原结构；外部内容 FTS 与查询仓储一起在 0045/Stage 4 原子切换，禁止 0043 复用同名表但改变列结构。

### 0044 `MediaGenerationAndTrashVNext`

扩展 `recording_assets`：`asset_generation`、`source_sha256`、`local_state`、`upload_operation_id`、
`remote_object_revision`。会议删除继续使用 `meeting_notes.deleted_at_ms`，新增统一 `purge_after_ms`；
回收站不是单独复制表。

### 0045 `ScheduleMentionGraphVNext`

扩展 `local_schedule_events`：`event_revision`、`draft_source_sha256`、`producer_revision`、
`graph_schema_revision`、`deleted_at_ms`。Graph 只在编辑会话和诊断中短期保存，不为每次解析建立
永久业务表。新增 `native_projection_checkpoints`，只持久保存每个 device epoch / native surface /
entity 已接受的 revision、surface instance 和 payload SHA-256，不复制页面正文；同 revision 同 hash
幂等，旧 revision 或同 revision 不同 hash 拒绝。

## 4. 服务端 canonical schema

Stage 0 导入真实后端后，以当前 SQLite/WAL 库原位迁移：

```text
devices(device_id PK, current_key_version, token_revision, revoked_at, created_at)
device_keys(device_id, key_version, public_key_der, public_key_hash,
            created_at, retired_at, PRIMARY KEY(device_id, key_version))
device_epochs(device_id, epoch_id, status, last_binding_seq, created_at, last_authenticated_at, retired_at,
              PRIMARY KEY(device_id, epoch_id))
device_rate_buckets(device_id, epoch_id, bucket_kind, tokens, last_refill_at,
                    PRIMARY KEY(device_id, epoch_id, bucket_kind))
auth_challenges(challenge_id PK, kind CHECK(bootstrap/auth/rotate),
                device_id, epoch_id, nonce_sha256, proof_difficulty_bits,
                expires_at, consumed_at, rate_bucket)
meeting_bindings(binding_id PK, device_id, epoch_id, binding_generation, binding_epoch_seq,
                 binding_revision, cancel_revision,
                 state CHECK(active/purging/purged),
                 created_at, purge_requested_at, purged_at,
                 UNIQUE(device_id, epoch_id, binding_generation),
                 UNIQUE(device_id, epoch_id, binding_epoch_seq))
binding_purge_obligations(purge_id PK, binding_id, binding_generation,
                          binding_revision, cancel_revision,
                          state, not_before, claim_until, attempts, last_error_code)
purge_capabilities(capability_id PK,
                   scope_kind CHECK(epoch/binding), device_id, epoch_id,
                   binding_id, binding_generation, secret_sha256,
                   state CHECK(active/consumed/revoked),
                   registration_request_id, created_at, consumed_at, revoked_at)
tasks(task_id PK, device_id, epoch_id, binding_id, capability,
      binding_generation, binding_revision,
      client_operation_id, client_request_id, request_sha256, logical_request_sha256, generation_id,
      lineage_root_task_id, predecessor_task_id, task_generation,
      creation_reason CHECK(original/retry/regenerate),
      handler_revision, provider_revision, prompt_revision,
      state CHECK(active/success/failure/cancelled), state_revision,
      current_attempt_id REFERENCES task_attempts(attempt_id),
      current_checkpoint_slot CHECK(current_checkpoint_slot IN (0,1)), checkpoint_through_chapter,
      checkpoint_reservation_id,
      cancel_revision, next_retry_at,
      source_stream_id, source_manifest_sha256,
      result_artifact_id, result_kind, outcome_code, outcome_json,
      terminal_code, created_at, terminal_at,
      UNIQUE(device_id, epoch_id, client_request_id),
      UNIQUE(device_id, epoch_id, client_operation_id),
      UNIQUE(device_id, epoch_id, generation_id),
      UNIQUE(device_id, epoch_id, binding_id, binding_generation,
             capability, logical_request_sha256, task_generation),
      UNIQUE(lineage_root_task_id, task_generation))
task_attempts(attempt_id PK, task_id REFERENCES tasks(task_id) ON DELETE CASCADE, attempt_number,
              state CHECK(queued/running/succeeded/retryable_failure/
                          terminal_failure/cancelled/lease_expired),
              phase CHECK(queued/admitted/running/committing),
              lease_generation, worker_session_generation, lease_owner, lease_until,
              epoch_id, binding_generation, binding_revision, cancel_revision_snapshot,
              provider_request_id, handler_revision, error_code,
              started_at, ended_at,
              UNIQUE(task_id, attempt_number), UNIQUE(task_id, attempt_id))
task_checkpoints(task_id REFERENCES tasks(task_id) ON DELETE CASCADE,
                 slot_no CHECK(slot_no IN (0,1)), through_chapter_ordinal,
                 source_prefix_sha256, input_sha256, handler_revision, provider_revision,
                 produced_by_attempt_id, encrypted_aggregate, aggregate_sha256,
                 sealed_at, PRIMARY KEY(task_id, slot_no))
source_streams(stream_id PK, task_id UNIQUE REFERENCES tasks(task_id), device_id, epoch_id, binding_id,
               binding_generation, binding_revision, cancel_revision,
               client_operation_id, generation_id, request_sha256,
               source_manifest_sha256, contract_revision,
               manifest_accumulator_sha256, next_manifest_page,
               next_consumable_chapter, final_chapter_count,
               state CHECK(open/consuming/complete/cancelled/expired), expires_at,
               UNIQUE(device_id, epoch_id, client_operation_id),
               UNIQUE(device_id, epoch_id, generation_id))
source_manifest_pages(stream_id, page_seq, first_chapter_ordinal,
                      descriptor_count, page_bytes, page_sha256, final_page,
                      reservation_id, state CHECK(received/compacted),
                      PRIMARY KEY(stream_id, page_seq))
source_bundle_groups(group_id PK, stream_id, chapter_ordinal,
                     declared_bundle_count, declared_item_count,
                     declared_uncompressed_bytes, reservation_id,
                     state CHECK(open/complete/consumed/cancelled/expired), expires_at,
                     UNIQUE(stream_id, chapter_ordinal))
source_bundles(bundle_id PK, group_id, ordinal, bundle_sha256,
               item_count, state CHECK(open/complete/consumed/cancelled/expired),
               consumed_by_task_id, expires_at,
               UNIQUE(group_id, ordinal))
source_bundle_items(item_id PK, bundle_id, ordinal, source_type,
                    source_id, source_revision_id, locator,
                    source_start_utf8, source_end_utf8, content_sha256,
                    UNIQUE(bundle_id, ordinal))
encrypted_payloads(payload_id PK, bundle_id, item_id, source_type,
                   source_id, source_revision_id, content_sha256,
                   aes_gcm_nonce, ciphertext, aad_sha256, expires_at)
generated_artifacts(artifact_id PK, task_id UNIQUE, source_manifest_sha256,
                    contract_revision, provider_revision, output_sha256,
                    encrypted_output, expires_at)
public_shares(share_id PK, device_id, epoch_id, binding_id, binding_generation,
              binding_revision, token_sha256, selection_sha256,
              payload_kind, encrypted_payload_or_locator, reservation_id,
              state CHECK(active/revoked/purging/expired),
              created_at, expires_at, revoked_at, purged_at,
              UNIQUE(device_id, epoch_id, share_id))
verified_assets(asset_revision_id PK, binding_id, binding_generation,
                binding_revision, cancel_revision, asset_id, generation,
                byte_size, source_sha256, sealed_locator, reservation_id, state, activated_at)
voiceprint_profiles(device_id, epoch_id, speaker_id, profile_revision,
                    encrypted_embedding, embedding_model_revision, revoked_at)
upload_sessions(session_id, device_id, epoch_id, binding_id, binding_generation,
                binding_revision, cancel_revision, asset_id, generation,
                object_key_hmac, multipart_upload_id, expected_size, expected_sha256,
                last_presign_expires_at, reservation_id, state, ...)
realtime_asr_sessions(session_id PK, task_id REFERENCES tasks(task_id), client_operation_id,
                      device_id, epoch_id, binding_id,
                      binding_generation, binding_revision, cancel_revision,
                      asset_id, asset_generation, codec_revision,
                      last_contiguous_chunk_seq, last_durable_event_seq,
                      state CHECK(open/reconnecting/finalizing/succeeded/cancelled/expired),
                      opened_at, last_seen_at, expires_at)
realtime_chunk_checkpoints(session_id, chunk_seq, start_ms, end_ms, content_sha256,
                           encrypted_spool_locator, state CHECK(spooled/consumed),
                           PRIMARY KEY(session_id, chunk_seq))
realtime_event_ledger(session_id, event_seq, event_kind CHECK(stable/final/error),
                      stable_segment_key, payload_sha256, encrypted_payload,
                      created_at, device_acked_at,
                      PRIMARY KEY(session_id, event_seq))
object_cleanup_obligations(obligation_id, binding_id, binding_generation,
                           binding_revision, cancel_revision, opaque_object_ref,
                           multipart_upload_id, reservation_id,
                           not_before, claim_until, attempts, state, ...)
capacity_reservations(reservation_id PK, device_id, epoch_id,
                      resource_kind CHECK(r2_staging/source_manifest/source_payload/task_checkpoint/public_share),
                      owner_kind, owner_id, reserved_bytes,
                      state CHECK(active/releasing/released), created_at, released_at,
                      UNIQUE(resource_kind, owner_kind, owner_id))
cleanup_audit_aggregates(scope_kind CHECK(epoch/global), scope_id,
                         obligation_kind, confirmed_count,
                         last_chain_sha256, updated_at,
                         PRIMARY KEY(scope_kind, scope_id, obligation_kind))
cross_store_purge_journal(purge_id, device_id, epoch_id, binding_id,
                          binding_generation, cancel_revision, target_store,
                          opaque_scope_sha256, idempotency_key,
                          state CHECK(pending/running/confirmed),
                          next_retry_at, last_error_code,
                          created_at, confirmed_at,
                          PRIMARY KEY(purge_id, target_store))
legacy_purge_scope_map(map_id PK, legacy_store, legacy_scope_kind,
                       encrypted_legacy_locator, locator_sha256,
                       device_id, epoch_id, binding_id, binding_generation,
                       evidence_kind CHECK(request_context/exact_join/device_scope/unresolved_global),
                       evidence_sha256, created_at,
                       UNIQUE(legacy_store, locator_sha256))
capability_cutovers(capability PK, contract_revision, barrier_id,
                    activated_at, legacy_submit_closed_at,
                    legacy_reader_removed_at, legacy_submit_count)
```

约束：

- 相同 client request ID 与 hash 返回原 task；同 ID 不同 hash 返回 409。相同 binding generation、
  capability、logical request hash 和 task generation 的并发请求由唯一约束/事务收敛为一个 task。
- 客户端在本机先创建 `operation_id` 并随首次领域 POST 提交；服务端保存为 `client_operation_id`，
  `/operations/{operation_id}` 只在 device/epoch scope 内查询。每次可见状态事务提升 `state_revision`；
  operation WSS 的 `event_seq` 等于该 revision，cursor 落后时先返回当前 durable snapshot，不要求保存
  全部中间文案事件。
- `generation_id` 由客户端为每次 original/retry/regenerate 随机生成并在 lineage 内不可复用；同一个
  generation 的网络重放收敛到原 Task，用户明确重新生成必须使用新 generation。服务端原子分配
  单调 `task_generation`，并校验 predecessor/lineage root，不能根据 source hash 吞掉显式重生成。
- Task 创建事务从部署配置冻结 `handler_revision/provider_revision/prompt_revision`；所有 Attempt 和
  checkpoint 只能使用该快照。配置改变只影响后续新 Task，worker 不按失败类型静默换 provider/model。
- 每个 task 的 `attempt_number` 从 1 开始，**总数最多 3 次（初次 + 最多 2 次自动重试）**；退避为
  `5s/30s`，第三次仍失败进入 `failure`，不再保留 `retry_wait` 状态。用户重试/重新生成创建新
  task generation，不增加旧 task 的 attempt。
- terminal task 永不恢复 running。lease 过期先把旧 attempt 终结为 `lease_expired`，再创建新 attempt。
- owner 在一个事务中完成 exact attempt、authority/cancel/binding CAS 和 artifact/outcome commit；
  `current_attempt_id` 必须外键指向该 task 的唯一 active attempt，旧 attempt 不能再次成为 current。
- 实际 SQL 使用 `(task_id, current_attempt_id)` deferred composite FK 指向
  `task_attempts(task_id, attempt_id)`，并为每个 task 建立至多一个 queued/running attempt 的 partial
  unique index；不能只靠应用层检查 attempt 是否属于该 Task。
- `(task_id, current_checkpoint_slot)` 使用 deferred composite FK 指向 `task_checkpoints(task_id, slot_no)`；
  Task 的 `checkpoint_through_chapter` 必须与 current 槽一致，提升槽和 ordinal 是同一 fenced 事务。
- commit 同时 CAS current attempt、lease generation、worker session generation、attempt 的
  epoch/binding generation/revision、cancel revision、active epoch 和 active binding revision。
- `task_checkpoints` 是每 Task 固定两个槽的 crash-safe 滚动聚合，不按章节追加行。每槽密文上限
  `4 MiB`；聚合内容受领域最终 schema 的同一数量上限约束，并携带已消费前缀的 chapter ordinal、
  source prefix hash、handler/provider revision 和 aggregate hash。worker 先在非 current 槽完整写入、校验，
  再以 current-attempt/lease/cancel fence 原子提升 Task 的 current checkpoint slot；旧槽在提升后才可覆盖。
  新 attempt 只有在 source prefix、handler、provider 和 input hash 全部相同时才可复用。当前章节 payload
  只在新槽成为 current 后删除，因此崩溃最多重放当前章节；两个槽均无法校验时 fail closed，客户端从
  本机 canonical source 创建新 generation，不从残缺聚合继续。它替代递归摘要/章级子任务 owner，
  不拥有独立状态机，随 Task 终态 TTL 清理。
- source bundle 经 HTTPS 校验 locator/hash 后使用 AES-256-GCM；AAD 固定包含 device/epoch/binding/
  generation/revision/cancel revision/bundle/source locator/hash。成功、永久失败或取消立即删除，
  恢复所需最长 TTL 为 24 小时；没有
  返回正文的 GET API。
- generated artifact 默认 TTL 7 天；设备显式选择“帮助改进生成质量”时最长 30 天。公开 share
  默认 7 天、上限 30 天且可撤销；task/attempt 元数据终态保留 30 天后压缩为无正文审计计数。
- voiceprint 只保存派生 embedding；登记样本音频在提取成功/失败后删除，撤销 revision 立即 fence 旧缓存。
- cleanup obligation 不能由 meeting/task/upload session 外键级联删除。
- `public_shares` 不能被 binding/epoch 直接级联删除；purge 先原子设 purging/revoke token，再建立 payload/
  object cleanup。share capacity reservation 只有在 public redeem 已 410 且 payload/R2 HEAD absent 后释放。
- 手机在创建会议事务中从 `next_binding_epoch_seq` 分配并递增 seq；PUT 只接受服务端
  `last_binding_seq + 1` 或同 binding/generation/seq 的幂等 replay。purge 确认且所有 presign/token/task
  retention 窗口结束后可删 binding row，但 epoch high-water 不回退，任何旧 seq 无条件拒绝复活。
- upload 创建事务先校验 `expected_size<=1 GiB`，再通过 `capacity_reservations` 原子检查每 device/global
  active session `<=2/4` 与 R2 bytes `<=2/4 GiB`；失败不创建 session 或 presign。reservation 一直覆盖
  incomplete multipart、最后 presign 可能的迟到 PUT、verified-but-unconsumed asset 和 cleanup；只有
  abort/delete 后 HEAD absent 才进入 released。R2 lifecycle 24 小时只作兜底。
- source stream 创建事务以 operation/generation/request hash 幂等插入 reservation，并在插行前检查
  active stream（open/consuming）每 device/global `<=2/8`；manifest page 检查未 compact page `<=2/4` 与 bytes
  `<=8/16 MiB`；chapter group 检查未消费 group `<=2/4` 与 payload bytes `<=256/512 MiB`。cancel、
  expiry、page compact 或 group consumed 在删除实际 payload/row 的同一事务释放 reservation；released
  reservation 24 小时后压缩为计数，不成为另一条无界 ledger。
- source Task 创建时同时预留两个 `4 MiB` checkpoint 槽；每 device/global checkpoint reservation
  `<=16/64 MiB`，超过水位不创建空壳 Task。checkpoint 行数固定为每 Task 0-2 行，不随章节数增长；
  reservation 只在 Task 终态清理两个槽后释放。
- native 在 epoch bootstrap complete 或 binding PUT 前先生成随机 capability ID 与 256-bit secret，写入
  purge-only journal 的 `registering` 行，并只提交 secret SHA-256。服务端从不生成或返回 secret；相同
  registration request/hash 幂等返回原 capability，响应丢失不会丢失唯一凭据。epoch scope
  只能清理该 epoch 的 schedule/source/task/artifact/voiceprint 和全部 binding；binding scope 只能清理
  对应 generation。purge 确认后原子标记 `consumed`；已 purging/purged 时幂等返回原 purge ID。
- `purge_capabilities` 使用两个 partial unique index：epoch scope 唯一键为 `(device_id, epoch_id)`，且
  binding 字段必须为空；binding scope 唯一键为 `(device_id, epoch_id, binding_id, binding_generation)`，
  且 binding 字段必须非空。capability 与未确认 `cross_store_purge_journal` 均不得按时间自动过期。
- 每次成功 token 交换只更新 `device_epochs.last_authenticated_at`，不记录位置或正文；超过 90 天未认证
  的 active epoch 先转 `retired` 并创建 epoch purge obligation，不能只删 token 而保留 voiceprint/payload。
- `cross_store_purge_journal` 不保存正文、标题、文件名、对象 key 或可创建任务的凭据，也不能被
  binding/epoch 级联删除。它只在 legacy/generic 不同事务边界时使用；两个 target store 均确认删除
  且关联 share/R2 object/multipart 已由 HEAD/list 证明不存在后才进入 `confirmed`。只“建立 cleanup
  obligation”不算完成；confirmed 事务立即追加 epoch-scoped 链式 hash/count aggregate 并删除详细行，
  epoch purge 时再合并到 global aggregate。
- unconfirmed cleanup/purge obligation、journal 与未压缩 tombstone 合计每 device/global 最多
  `4096/16384` 行且序列化 `<=64 MiB`。75% 水位可把同 epoch/binding 的 locator 集合并入一个 epoch
  purge，但必须完整保留 object/multipart 引用；硬门停止新远端 bootstrap/binding/task/upload/share admission，
  不停止本机删除和 purge worker。confirmed 行按上述 aggregate 立即压缩，未确认义务永不按 TTL 丢弃。
- bootstrap epoch 以及任何可能产生远端 payload/object/share 的 binding/task/upload admission 都先预留最坏情况 cleanup
  slot 与 metadata bytes；终态在同一事务把 reservation 转成 obligation 或在证明无需清理后释放。
  已接纳操作因此不会在失败/取消时才发现 cleanup ledger 已满。
- `legacy_purge_scope_map` 只用于定位删除，不得用于迁移、回答、artifact 激活或补造 provenance。
  它覆盖 summary task 以及 account/sync/mirror/share 的所有服务端 legacy 表；v1 adapter 在 barrier 前
  用真实 request context 写 map，历史行只接受可复验的主外键 join。locator
  使用服务端密钥加密，日志只记 hash/evidence kind。无法精确到 binding 但能证明 device 的行标为
  `device_scope`；连 device 也无法证明的行标为 `unresolved_global`，禁止猜测填值。
- verified asset 激活与唯一 transcription task 在同一事务；R2 清理不删除 sealed asset，直到所有
  消费者持有本地 checkpoint 或任务终态，恢复不得重新选择未经校验的对象。
- realtime chunk 只有在加密 spool checkpoint 已 fsync 或对应 stable/final event 已持久提交后才 ack；
  partial 不进入 durable ledger。session/事件/spool 受 binding/cancel fence 和全局临时盘预算约束，final
  TranscriptRevision 被手机确认后立即清除，最长 TTL 24 小时。
- WSS handshake 在一个事务创建/复用 generic transcription Task 并把 session 绑定到唯一
  `task_id + client_operation_id`；session state 只拥有传输恢复，Task 仍是 final Transcript outcome owner。
  手机 durable ack 后可删除对应 event；临时盘高水位不得丢未 ack stable/final，而是停止新 chunk ack、
  typed 关闭连接并让本地录音稍后 replay。final CAS ack 后清 event/spool；24 小时过期时手机仍以本地
  MediaAsset 创建新 generation，不把服务器 TTL 描述成原始音频丢失。

Task 行是终态结果 envelope 的唯一 owner：`result_kind` 只能为 `artifact/content_outcome`；
`result_kind=artifact` 时只允许 `result_artifact_id` 非空，`result_kind=content_outcome` 时只允许
`outcome_code/outcome_json` 非空并由 `content-outcome.schema.json` 校验。`generated_artifacts` 只保存
Task 引用的密文和哈希元数据，不重复保存 result kind 或 ContentOutcome。ErrorEnvelope 只写
attempt/task error 字段，不得同时写 ContentOutcome。

### 4.1 legacy task bridge-and-drain

旧 `summary_tasks_v2` 没有 task-time transcript snapshot、epoch、policy、handler 和完整 payload 血缘，
禁止全量迁移，也禁止用当前会议、当前 epoch、dedupe key 或固定常量制造 provenance。

1. Stage 0 记录 legacy 行数、active lease、schema/table hash，并确认 legacy/generic 表是否位于同一
   SQLite 事务边界；同时建立 `legacy_purge_scope_map`，只导入 request-time 或 exact-join 证据。不满足
   同库条件时隐私删除使用可恢复 purge journal，而不伪称跨库原子。
2. generic tables 与持久 `capability_cutovers` 先建立。barrier 前，v1 submit 继续写 legacy，v2/probe
   才写 generic；先发布支持 v2 source/binding 的客户端并观察一个完整公开周期。对应 v1 submit 为零
   后才逐 capability 激活 barrier；barrier 后 v1 submit 返回 `426 UPGRADE_REQUIRED`，只保留状态/结果读，
   不允许 adapter 伪造 binding/source bundle。barrier 前 queued/running 仍由 legacy worker 排空。
3. generic worker 只 claim generic row，legacy worker 只 claim barrier 前 legacy row。task ID namespace
   不同；同一 ID 出现在两侧即 integrity failure。
4. 状态按 task namespace 路由；过渡读为 generic first、legacy second。legacy 结果标记
   `provenance=legacy_unbound`，只维持既有页面，不提升为 vNext artifact。
5. meeting/epoch 永久删除先 fence 两侧 publication，再清理 task/payload/artifact；R2/object cleanup
   obligation 不随业务行级联删除。若两 store 同库则一个事务完成，否则先写 purge journal，逐库
   幂等执行，确认后才终结 journal。exact map 存在时精确删除；只有 device scope 时保守删除该 device
   全部 legacy task/artifact。当前锁定为单用户部署，若存在 `unresolved_global`，首次永久 purge 或
   Stage 5 retirement 会删除部署内全部 unresolved legacy task/artifact；它可能过删旧服务器生成结果，
   但不删除手机业务数据，也绝不把这些行提升为业务 provenance。
6. 不提供历史 importer。旧任务自然 drain/expiry；Q0/Summary V2 handler、route 和 reader 保留到
   Stage 5 删除门，不能在新请求失败时静默 fallback。
7. barrier 前可回滚到完整 legacy 链；barrier 后始终保留 v2 ingress 和 generic owner，只能显式切换
   到保留的版本化 legacy handler adapter。Transcript adapter 读取 verified asset，Summary/Q0 adapter
   读取 immutable source chapter，Schedule adapter 输出同一 MentionGraph schema；它们都只形成临时
   typed input，不查询/写入 legacy meeting mirror，不拥有任务。已进入 generic 的任务继续 generic
   drain/read，不迁回 legacy，不恢复 legacy submission、remote mirror 或 dual write。

## 5. v2 公共 API

业务请求带 `X-Laoji-Device-Id`、`X-Laoji-Epoch-Id`、15 分钟短期 bearer token 和
`X-Laoji-Request-Id`。只有下述 bootstrap/auth challenge、token 交换、单用途 purge capability 和
public share redeem 端点可免 bearer，且必须按其 challenge、签名、capability secret 和限流合同认证；错误统一返回
`ErrorEnvelope`，不得用 HTTP 200 包装失败。

### Bootstrap 与能力

```text
POST /api/device/v2/bootstrap/challenges
POST /api/device/v2/bootstrap/complete
POST /api/device/v2/auth/challenges
POST /api/device/v2/auth/tokens
POST /api/device/v2/auth/keys/rotate
GET  /api/device/v2/capabilities
GET  /api/device/v2/ready
DELETE /api/device/v2/epochs/{epoch_id}
POST /api/device/v2/purge-capabilities/{capability_id}/execute
GET  /api/device/v2/purge-capabilities/{capability_id}
```

Android Keystore 生成不可导出的 P-256 签名密钥。bootstrap 是公开匿名注册：challenge 60 秒且单次
消费，complete 校验 challenge、设备签名、自适应 18-22 bit proof-of-work，并执行每 IP 每 24 小时
最多 3 个成功 epoch、全局每 24 小时最多 20 个成功 epoch 的部署配额。它不使用或分发共享 bootstrap
secret，也不证明 APK 来源；安全边界是新 device/epoch 只能访问自己的任务且仍受业务队列/字节配额。
native 在 complete 前先持久化随机 epoch ID、registration request ID 和 `registering` purge credential；
complete 登记公钥和该 opaque epoch，并登记客户端预先提交 hash 的 epoch purge capability。相同 request
ID/body 的响应可幂等重放，ID 相同/body 不同返回 409。后续 auth challenge
同样单次消费，token 固定绑定 device/epoch/key/token revision，15 分钟到期。密钥轮换要求旧/新
密钥双签名并原子提升 revision；设备私钥丢失时创建新 device/epoch，不伪造旧身份。关闭 epoch
返回 purge ID，本机清除不等待远端完成；持久 purge credential 只允许继续该 epoch 清理，不能
创建新任务。

Bearer 免除表固定为：`bootstrap/challenges` 无 bearer 且按 IP 限流并返回 proof difficulty；
`bootstrap/complete` 使用 bootstrap challenge + proof-of-work + 设备签名；`auth/challenges` 使用 device/epoch/key identity 与
限流，不接受正文；`auth/tokens` 使用未消费 auth challenge + 设备签名。四者之外没有“token 过期
仍可调用”的隐式例外；`auth/keys/rotate` 必须携带当前 bearer 和旧/新密钥双签名。另有两个
`purge-capabilities` 端点只接受 epoch/binding 登记前由 native 生成的单用途 capability secret，不接受通用 bearer，
也不能读取正文、列举 binding 或创建任务。`capabilities`、`ready`、普通 binding/source/operation
和 `/purges/{purge_id}` 查询均要求有效 bearer。

唯一另一项 bearer 例外是 `POST /api/public/v1/shares/{share_id}/redeem`：`GET /s/{share_id}` 只返回
静态落地页，客户端从 URL fragment 读取 256-bit secret 并在 POST body 兑换，token 不进入 query/access
log。服务端 constant-time 比较 token hash；share token 不得调用任何 device API。active 且未过期时只返回本次
明确选择的投影，revoked/purging/expired 或 binding fence 不匹配统一返回 410，未知 ID 返回 404。

两个 purge-only 端点都要求 path capability ID、`X-Laoji-Purge-Request-Id` 和
`Authorization: LaojiPurge <secret>`；服务端 constant-time 比较 secret hash。epoch 与 binding scope
使用同一 wire schema，execute 幂等返回 purge ID，status 只能返回 `pending/running/confirmed` 和
脱敏错误码，不能返回被删除对象清单。epoch/binding 与 capability hash 必须在同一事务创建；未知
高熵 capability ID 返回 `404 CAPABILITY_NOT_REGISTERED`，供 `pending_probe` 收敛，不能返回相近 scope。

### 日程

```text
POST /api/device/v2/schedule/graphs
POST /api/device/v2/schedule/graphs/{draft_id}/clarify
WSS  /api/device/v2/realtime/schedule-asr
```

POST 输入 raw text、reference time/timezone、locale、可选 prior graph/draft revision；输出
`ScheduleMentionGraph`，不写日程。服务端禁止返回已保存事件 ID。

### 上传与转写

```text
PUT    /api/device/v2/meetings/{binding_id}
GET    /api/device/v2/meetings/{binding_id}
DELETE /api/device/v2/meetings/{binding_id}
GET    /api/device/v2/purges/{purge_id}

POST /api/device/v2/uploads
POST /api/device/v2/uploads/{session_id}/parts
POST /api/device/v2/uploads/{session_id}/complete
GET  /api/device/v2/uploads/{session_id}
DELETE /api/device/v2/uploads/{session_id}

POST /api/device/v2/meetings/{binding_id}/transcripts
WSS /api/device/v2/meetings/{binding_id}/realtime-transcripts
GET  /api/device/v2/operations/{operation_id}
WSS  /api/device/v2/operations/{operation_id}/events?after_event_seq={cursor}
POST /api/device/v2/operations/{operation_id}/cancel
POST /api/device/v2/operations/{operation_id}/retry
POST /api/device/v2/operations/{operation_id}/regenerate
GET  /api/device/v2/artifacts/{artifact_id}
POST /api/device/v2/shares
DELETE /api/device/v2/shares/{share_id}
GET /s/{share_id}
POST /api/public/v1/shares/{share_id}/redeem

POST   /api/device/v2/speakers
POST   /api/device/v2/speakers/{speaker_id}/samples
DELETE /api/device/v2/speakers/{speaker_id}
```

`binding_id` 是本机生成的随机 UUID v4，不复用 meeting ID；`binding_generation` 是同时生成的随机
128-bit 值，在同一 device epoch 内永久唯一。`PUT /meetings/{binding_id}` 必须提交 generation、
`binding_epoch_seq`、初始
`binding_revision=1` 和 `cancel_revision=0`；服务端只接受、校验和持久化，禁止替客户端生成、从 meeting
ID 推导或为已 tombstone 的 generation 重新建 binding。后续 revision/cancel revision 只能单调增加。
native binding registrar 在每个 epoch 内按 `binding_epoch_seq` 串行，不跳号；后分配的 meeting 仍可
本地使用，但远端任务等待前序登记。若前序 meeting 在联网前已永久删除，仍只登记 opaque binding 后
立即用已持久 purge capability 清理，不上传标题、正文或媒体，从而推进 high-water 而不复活业务数据。
首次 PUT 同时提交 native 已持久化的 `purge_capability_id + secret_sha256 + registration_request_id`；
服务端只保存 hash，权限严格限制为对该 device/epoch/binding generation 发起幂等永久清理并查询结果。
201/幂等 200 确认后 native 把 credential 标为 `armed`；secret 不进入 JS、业务 SQLite 或普通 SecureStore。
远端 binding 只表达 device/epoch/task 归属，不保存标题、标签或会议生命周期。移入回收站不调用远端；
永久删除或 30 天到期才 fence binding 并创建 purge obligation。purge 先拒绝迟到 commit，再删
payload/artifact；R2 obligation 独立保留
至 abort/delete/HEAD 证明完成。上传创建请求必须携带 binding ID/generation/revision、asset
generation、expected size/hash；每个 part/complete/delete 都带并校验 binding cancel revision。
binding purging 后旧 presigned PUT、complete、activate 和 transcription claim 均归类为
`BINDING_PURGING`，不得重新打开 upload session。

会议实时 WSS 首帧提交 device/epoch、binding generation/revision/cancel revision、asset ID/generation、
随机 session ID、codec revision、`resume_from_chunk_seq` 和 `resume_from_event_seq`。音频帧固定携带单调
`chunk_seq`、源起止毫秒、PCM hash 与 payload；服务端返回最高连续 `chunk_ack_seq` 和单调
`event_seq`。native 先写本地录音，再发送并保留未 ack chunk；断线/进程重启后用同 session 和 cursor
重放，重复 hash 幂等，序号相同但 hash 不同返回协议错误。GET operation 同时返回
`last_durable_event_seq + stable/final snapshot`，因此漏掉 WSS event 不会丢失已稳定文字。

WSS 握手要求有效短 token；服务端在每个 chunk/event 边界复核 expiry、token revision、epoch 与
binding cancel revision。token 到期或撤销时发送 typed auth event 后以 4401 关闭，native 继续本地
录音，换取新 token 后从两个 cursor 续接；禁止让旧连接无限延长失效凭据。

### 整理与问答

```text
POST /api/device/v2/meetings/{binding_id}/summaries
GET  /api/device/v2/meetings/{binding_id}/summaries/{operation_id}
POST /api/device/v2/meetings/{binding_id}/questions
GET  /api/device/v2/meetings/{binding_id}/questions/{operation_id}
POST /api/device/v2/meetings/{binding_id}/source-streams
POST /api/device/v2/source-streams/{stream_id}/manifest-pages
POST /api/device/v2/source-streams/{stream_id}/groups
POST /api/device/v2/source-bundle-groups/{group_id}/bundles
POST /api/device/v2/source-bundle-groups/{group_id}/commit
DELETE /api/device/v2/source-streams/{stream_id}
```

Summary 不接模板 ID。Question 不接 summary sections 或历史 answer text。来源 manifest 只含稳定
revision/hash。短会是一个 stream/一个 chapter；长会按确定性章节顺序消费，不因会议时长拒绝，也不
在 task 创建前暂存整场正文。stream 创建提交 binding generation/revision/cancel revision、客户端
operation/generation/idempotency hash 与 contract revision；同 request/hash 幂等，同 ID/不同 hash 409。
每 device/global 最多 2/8 个 active stream（open/consuming）；空 stream 30 分钟无活动过期，已有内容的
stream 在 24 小时无有效 page/group/checkpoint 活动后过期，正常进度会续租，因此不形成会议时长门。

章节描述通过连续 manifest page 上传；每页最大 4 MiB/10,000 descriptors，每 device/global 最多
2/4 个未 compact page，manifest outstanding bytes `<=8/16 MiB`，插行前用 capacity reservation 原子
准入。服务端按 page/chapter ordinal 和 page hash 更新滚动 Merkle accumulator；final page 冻结
`source_manifest_sha256/final_chapter_count` 后才允许已绑定的 Summary/Q2 Task 进入最终 generating/
publication。已消费 page 压缩为
accumulator/ordinal 并释放 row/bytes，因此页数和会议时长不形成持久无界行。

source stream 创建与空壳 Task 在同一事务完成并互相绑定，`generation_id` 是未完成 manifest 时的幂等根；
Task 保持 `active`，typed detail 为 `awaiting_source`，没有 source group 时 Attempt/phase 为空且不占
provider slot。worker 可在 stream
仍 open 时逐页处理 complete group，并把本章事实/证据确定性并入两槽滚动 checkpoint；final page 才冻结 Task 的
`source_manifest_sha256/final_chapter_count`。只有 manifest final 且 current checkpoint 已覆盖最终 chapter 后才提交
artifact。达到上述 inactivity expiry 时以 `SOURCE_STREAM_EXPIRED` 终结 Task 并清 reservation。

每个 group 创建时声明并通过 capacity reservation 在同一 SQLite 事务原子预留
`bundle_count<=8`、`item_count<=50,000`、
`uncompressed_bytes<=128 MiB`；每 bundle 仍不超过 16 MiB。每项带 source type/id/revision、locator、
UTF-8 range 和 content hash。commit 只有在 ordinal 连续、声明计数/字节和 item hash 与 manifest 一致，
且 stream cancel revision 仍匹配 active binding 时才完成。每 device 最多 2 个、全局最多 4 个未消费
group；outstanding source bytes 每 device `<=256 MiB`、全局 `<=512 MiB`，超限返回 429 而不创建空壳行。

Summary/Q2 Task 引用绑定的 stream ID。worker 按 chapter ordinal 消费 complete group，将本章结果和当前
聚合按领域确定性 reducer 合并；reducer 必须持续满足 Facts/Q2 最终协议的事实、关系、行动、引用和
证据候选数量上限，不保存已淘汰章结果。新滚动槽完成 schema/hash 校验并经 fenced CAS 成为 current 后，
才删除该 chapter payload、标记 group consumed 并释放预留，再接收/消费下一章；所有 chapter 成功后才
从 current 聚合提交最终 artifact。最终 source manifest root、已 compact page 的滚动 Merkle accumulator
和 current checkpoint 的 source prefix hash 共同证明处理前缀；不会为每章保留输出行。
取消/删除先 fence stream/group/checkpoint 再清 payload。不存在临时
对象直读或整场 source 同时驻留的第二路径。cancel、24 小时 inactivity expiry 或 complete 都删除未消费页/group
并释放 reservation；空 stream、manifest page 和 group 的数量/字节都不能绕过准入。

HTTP 合同固定为：bootstrap/token/binding 创建 `201`，异步 task/source 提交 `202`，查询/幂等 replay
`200`，输入或 revision 冲突 `409`，过期/已 purge binding `410`，对象/来源超限 `413`，旧提交入口关闭
`426 UPGRADE_REQUIRED`，有界队列忙
`429 + retry_after_ms`，鉴权失败 `401/403`。每个 `202/200` 的异步响应都使用
`OperationEnvelope`；不会用 `200` 包装业务失败。

`POST retry` 只接受 `task_state=failure` 的终态 operation，由客户端提交新的 `generation_id` 和同一领域输入，创建
`creation_reason=retry` 的新 Task；它不重开旧 Task。`POST regenerate` 只接受已有成功 artifact 的
operation，由客户端提交新的 `generation_id`、当前 source fingerprint 和领域输入，创建
`creation_reason=regenerate` 的新 Task；来源未变仍允许用户显式重生成。provider、handler 和 prompt
revision 只由服务端当前部署配置选择，并在 Task 创建事务中冻结；客户端不能提交、覆盖或触发云端
选择。两者都返回
新 `OperationEnvelope`，旧结果和旧 Task 保持不可变。普通首次提交使用领域 POST，不复用这两个端点。

`GET /artifacts/{artifact_id}` 要求与 Task 相同的 device/epoch/binding 授权并校验未过 retention；返回
领域 schema artifact 或 404/410，locator 不能用作公开分享 token。公开分享仍只走独立 share API。

### 分享与地址

保留 `/api/location/reverse` 的 v2 设备限流入口。`POST /api/device/v2/shares` 要求 device bearer、
active binding generation/revision、显式 selection hash 和 TTL，请求明确列出 Markdown、附件或音频，
默认仅 Markdown；客户端先生成 share ID/256-bit secret，只提交 token hash，并本地保存
`/s/{share_id}#capability={secret}`，
服务端不生成/返回 secret。相同 request/hash 幂等。创建事务限制每 device/global active share
`<=32/128`、referenced/copied payload `<=8/32 GiB`，并写 capacity reservation；超限返回 429，不创建
token/payload。DELETE 立即
原子设 revoked，使 public GET 返回 410，再异步删 payload/R2。binding/epoch purge 在同一 fence 事务
把关联 share 全部设 purging；只有 payload 删除、R2 HEAD 不存在且 public GET 已为 410 才可确认 purge。
share row 可保留无 token/payload tombstone 到审计 TTL，不得保留可读内容。

音频或附件进入公开分享前，服务端必须复制为独立 `share object`，或在同一事务中把已完成校验的
verified object 原子登记为有 TTL 的 `share lease`；禁止把 staging R2 URL、上传 session locator 或
内部 artifact locator 直接返回给公开访问者。staging capacity reservation 只有在 share object 的
HEAD/hash 校验成功，或 share lease 已持久化且绑定 cleanup obligation 后才可释放。公开落地页从 URL
fragment 读取 secret，再以 `POST /api/public/v1/shares/{share_id}/redeem` 的 body 兑换；API 网关在
开始响应及每个不超过 `1 MiB` 的流式 chunk 前重新检查 share/binding/epoch revision，发现撤销即终止
在途响应，Range 续传重新兑换。禁止签发任何可绕过该检查的对象 URL。撤销、TTL 到期和 binding/epoch
purge 必须立即使 capability 与 share lease 不可兑换，并由同一 cleanup obligation 完成 DELETE/HEAD
确认。

## 6. 状态与错误合同

共享 task 与 attempt 分层状态：

```text
task:    active -> success | failure | cancelled
attempt: queued -> running -> succeeded
                    |-> retryable_failure -> new attempt on same active task
                    |-> terminal_failure
                    |-> lease_expired -> new attempt on same active task
                    |-> cancelled
phase:   queued -> admitted -> running -> committing
```

领域 progress 作为 typed detail，不增加共享状态。状态只单调前进。每个 task 总计最多 3 个
attempt（初次 + 2 次自动 retry），退避固定为 `5s/30s`，generic owner 不存在第三次自动退避或
`retry_wait` 状态。用户点击重试走 `POST retry`，成功结果重新生成走 `POST regenerate`，两者均创建
lineage 中更高 generation 的新 task。terminal task 永不复活。相同 request ID/hash 是只读 replay；
相同 ID/不同 hash 返回 409。

`busy` 只是 `task=active + attempt=queued + phase=admitted` 的 admission detail，`cancel_requested` 只是
手机 `device_operations` 已提升 cancel intent、等待服务端确认的本地投影；二者都不是 Task/Attempt
lifecycle state，也不得写入 canonical state 列。服务端确认后才进入 `cancelled`。

成功 task 的 `result_kind` 必须为 `artifact` 或 `content_outcome`。`artifact` 通过
`result_artifact_id` 指向唯一密文 artifact；`ContentOutcome` 只覆盖没有普通 artifact 的两类：

```text
no_content(code, measurements)
limited(code, constraint_metadata)
```

`NO_SPEECH` 是 `task=success + no_content`，包含 analyzed/voiced duration 与 VAD revision；手机提交
零 segment 的 final TranscriptRevision。它不得进入 error、failed、blocked 或自动重试。
`EVIDENCE_INCOMPLETE` 和“完整会议无法确认”是 `limited`；provider/decode/schema/citation 失败才是
ErrorEnvelope。

标准错误：

```text
OFFLINE, AUTH_REQUIRED, DEVICE_REVOKED, INPUT_STALE, IDENTITY_CONFLICT,
BINDING_REQUIRED, BINDING_PURGING, SOURCE_ENVELOPE_INVALID,
SOURCE_ENVELOPE_TOO_LARGE, SOURCE_STREAM_EXPIRED, UPLOAD_EXPIRED, OBJECT_VERIFY_FAILED,
PROVIDER_BUSY, PROVIDER_UNAVAILABLE, PROVIDER_TIMEOUT, PROTOCOL_INVALID,
CITATION_INVALID,
CANCELLED, UPGRADE_REQUIRED, STORAGE_LOW, INTERNAL_RETRYABLE, INTERNAL_TERMINAL
```

ErrorEnvelope 的 code 不与 ContentOutcome code 复用；客户端按 typed outcome/state 决定展示和重试，
不解析中文文案。

每个 operation 响应使用同一 `OperationEnvelope`：

```text
{ task_id, operation_id, attempt_id, attempt_number,
  generation_id, predecessor_task_id,
  task_state, state_revision, event_seq, attempt_state, phase, next_retry_at,
  result_kind, artifact_locator, outcome_code, outcome_json,
  handler_revision, provider_revision, prompt_revision,
  error_code, retry_after_ms }
```

source stream 尚在 `awaiting_source` 时 `attempt_id/attempt_number/attempt_state/phase` 允许为空；创建首个
Attempt 后必须完整返回，客户端不能把 nullable attempt 解释成失败。

`result_kind=artifact` 时返回 artifact locator；`result_kind=content_outcome` 时只返回通过 schema
校验的 outcome code/measurements/constraint metadata；`error_code` 与 outcome 互斥。`POST retry`
只接受 `task_state=failure`，`POST regenerate` 只接受 `task_state=success + result_kind=artifact`；
二者均创建新 task generation，
自动 retry 才保持原 task ID 并增加 attempt。

## 7. UI 投影实现

新增 `src/native/projectionEnvelope.ts` 和 Kotlin `ui/ProjectionEnvelope.kt`。JS 生成 snapshot 时固定
entity/view revision 与 payload hash；native action 必须回传它们。`nativeMinutesRequestCoordinator`
是唯一 Minutes 跨边界仲裁器。

native 持有 recorder/player/WorkManager 与 surface 瞬时状态，但必须通过 `RecordingOperation`、
`PlaybackOperation`、`TransferOperation` 和 envelope 暴露单调 command/checkpoint；不得把它们复制成
第二套 meeting/transcript business state。

页面状态规则：

- 列表只显示稳定的简短状态；详情是 operation 细分状态的唯一完整入口。
- 状态放在既有标题/日期行的尾部或内容区内，不新增永久占位行。
- transcript partial 追加不切换 tab、不重建播放器、不滚动用户视口。
- summary regenerate 显示上一结果并叠加单一进度；按钮不在生成/重新生成之间交替。
- question pending 是 thread 内不可变 turn；退出重进从 repository 恢复。
- 固定控件在 loading/error 出现前后几何位移 `<=2dp`。
- `queued/admitted/busy/retryable_failure/cancel_requested` 映射为同一 operation 的行内细分状态；不会创建
  第二条列表记录。首次整理无旧结果时显示稳定 skeleton，讲话人独立失败只在讲话人入口说明，
  不把 Transcript 或整理降级为失败。

### 7.1 清除本机数据的 purge-only journal

`LocalDataEraseCoordinator` 顺序固定为：停止 recorder/player/WorkManager 并等待当前本机事务 -> 将当前
epoch 和每个尚未完成清理的 binding credential 从 `armed -> pending`、`registering -> pending_probe`
原子推进并 fsync journal ->
删除 SQLite 业务行、媒体/附件/clip、
AsyncStorage、SecureStore、通知、更新文件、native prefs 和内存投影 -> 重启到空设备状态。

purge-only journal 不进入业务 SQLite 或普通 SecureStore，而进入 Android Keystore 独立 alias
`laoji_purge_only_v1` 保护的 app-private `purge-only/` 原生 capability journal。canonical row 为：

```text
PurgeOnlyJournalV1 {
  scope_kind=epoch|binding,
  capability_id, capability_secret_ciphertext,
  device_epoch_id, binding_id?, binding_generation?,
  registration_request_id, purge_request_id?,
  state=registering|armed|pending_probe|pending|executing|confirmed|confirmed_absent,
  next_retry_at, created_at, last_error_code
}
```

`registering` 在提交注册前已经持久化 secret；epoch/binding 与 capability 在服务端同一事务创建，
幂等注册确认后进入 `armed`。清除遇到 `pending_probe` 时先用 purge status 探测：capability 存在则
进入 `pending` 并 execute；服务端明确返回 `CAPABILITY_NOT_REGISTERED` 证明原创建事务未提交时进入
`confirmed_absent`；超时/未知只重试，不能猜成 absent。只有永久删除或全量本机清除事务才能把
`armed` 推进到 `pending`。每行只含 opaque scope 和单用途凭据，不含正文、会议 ID 映射、设备长期密钥、文件名、对象 key 或
创建任务权限。业务清除删除所有普通 Keystore/SecureStore alias，但明确保留
`laoji_purge_only_v1`；native 组件是唯一可解密调用者，JS 无读取 API。联网后用 capability 端点创建/
确认服务端 purge，再先删除 journal row；最后一行 `confirmed/confirmed_absent` 后才删除 purge-only alias。未确认 journal 不按
时间过期，后台使用有界退避持续重试。若用户绕过应用流程直接卸载导致 journal 与 Keystore 一并丢失，
服务器对 90 天无 token 活动的 orphan epoch 自动执行同一 purge，并令旧 epoch/token 永久失效。
离线清除由此不阻塞本机删除，也不会因清除普通设备凭据而自锁或把“请求已发出”记成清理完成。

## 8. Stage 0：冻结与代码归一

入口：公开 `1.1.10/118` manifest、APK metadata、hash/size 和生产进程已只读核对。

实施：

1. 保存 APK、公开 manifest、移动 SQLite `PRAGMA integrity_check`、媒体清单和当前版本字段。
2. 将当前 dirty mobile source、APK bundle 中的 schema 标记和 Git HEAD 做 manifest，确认 v39 对应
   源码后形成可回溯基线提交；不能只保存 commit `48e3b36`。
3. 从生产 cwd 创建只读源码 tar/hash，导入 `services/laoji-api`；从 8030 源 cwd 导入
   `services/laoji-asr`。systemd/environment 只导入脱敏模板。
4. 建立 `contracts/vnext` schemas 和三端生成检查。
5. 生成 current-to-target 文件、表、route 和进程 inventory；对 backend `local.db`、`schedule.db`、
   `speaker_voiceprints.db` 逐表记录 owner、行数、外键、目标表、迁移/排空/保留动作和快照恢复顺序；
   对每个 account/sync/mirror/share/task 表同时记录 exact/device/unresolved legacy purge scope；0 字节路径
   只记录配置引用，未知归属不能删除。
6. 创建本机数据库备份/恢复工具，Windows/Linux 均使用 Python 3/Node，无 shell-only 逻辑。

退出：后端源码可从仓库构建；所有当前用户能力、表、route 有目标映射；快照可恢复；无生产写入。

回滚：本阶段只有新增文档/源码副本/工具，删除候选目录即可；生产无回滚动作。

## 9. Stage 1：本机权威与最小远端任务

入口：Stage 0 exit gate 通过，inventory、快照恢复和 schemas 已冻结。

实施：

1. 顺序执行 0040/0041/0042，接入 epoch/binding/operation、cutover counter、immutable source 和 Q2 表。
2. 新安装只创建 SQLite canonical store；旧安装执行一次性、可恢复、带 row count/hash 的导入，
   导入成功后停止反向 legacy mirror。此处只迁手机业务数据，不包含服务端 legacy task；历史笔记/
   附件只为当前真实正文创建 `migrated_current` revision。
3. 把 meeting/schedule 写入统一到 repository transaction；日程迁出 AsyncStorage metadata、编辑和
   删除 journal；UI/store 不直接拼 SQL/网络结果。
4. `device_operations` 接管上传、转写、整理、补全和删除 remote intent；`processing_stages` 只作派生
   UI projection，WorkManager 只作执行器。
5. 建立本机 speaker profile/deletion owner，迁移 SecureStore/AsyncStorage/native prefs 中重复 key。
6. 为 ActionItem 建立唯一 repository，保留手动/候选/标记三种 provenance，以及编辑、完成、删除、
   负责人、截止、提醒和后续日程；停止账号协作新写但保留历史只读。
7. 当前 Q0/旧 Question 与 Summary 兼容整链继续作为默认直到 Stage 3 capability barrier；0042 Q2
   只建新表不接流量，历史 answer 不进入新证据合同。Summary Facts V3 与 V2 不再产生第二 current
   pointer，但不得在 Stage 3 前切断当前可用生成服务。
8. 会议详情 route 只组合 transcript/summary/question/speaker/audio/marker 领域投影，不再拥有各自生命周期。
9. 部署 challenge/token/binding/source-stream API 与 generic task owner；使用专用 probe capability 和
   fake provider 完成 restart/cancel/replay，真实 domain 尚不激活 barrier。
10. account/guest 分支收敛为 device scope；旧 account API 只读 adapter 保留一周期。
11. 从一个 RouteRegistry 生成 RootStack 类型、Navigator、sanitizer、通知和 semantic link；删除账号和
   公开 token 分享幽灵 route。
12. 新增 RecordingOperation 和 LocalDataEraseCoordinator；清除覆盖 recorder/player/worker、SQLite、
    AsyncStorage、SecureStore、通知、附件、录音、clip、更新文件、native prefs 和内存投影。
13. 停止创建无消费者的 sync outbox；旧 pending 行只读导出后标记 cutover，不伪造成功。
14. 从 Stage 1 起持久记录每个 legacy submit/read/active lease；验证 bridge 两侧 task namespace、
    generic-first/legacy-second 读取、delete-only legacy scope map，以及同库事务或跨库 purge journal。

退出：离线日程和会议 CRUD 不访问网络；每类数据/任务/view state 只有一个 owner；AsyncStorage 无
业务正文或恢复任务；无 subscriber outbox 为零；route registry/type/Navigator/sanitizer 一致；远端
task 重启后可恢复；同 logical generation 只产生一个结果；ActionItem 全部当前行为回归；Q2 pending
turn 与 immutable source revision 可持久；清除本机数据在离线/录音中/重启后无业务正文残留，
只允许保留不可读取业务内容、仅能执行清理的 purge credential/outbox；旧版客户端仍走 v1。

回滚：feature capability 只切换读取入口；0040 表保留但停止写，不恢复反向双写，也不把 v2 结果
反写旧 sync owner。

Stage 1 停写/退出门：generic probe 的 restart/cancel/replay、epoch/binding fence、purge-only journal
和本机 clear 回放通过；旧同步 owner 只允许 drain/read，submission counter 从此刻开始计数；任何
未满足 owner 唯一性的领域不得进入 Stage 2。Stage 1 不物理删除 legacy 表或任务。

## 10. Stage 2：媒体、上传、转写与讲话人

入口：Stage 1 exit gate 通过，v2 owner、device identity、0040/0042 和 purge-only journal 已可用；
0043/0044 尚未执行，属于本阶段首个可回滚 migration unit。

实施：

1. 顺序执行 0043/0044；MediaAudioExtractor 输出 app-private 可 seek 音频和 hash。
2. MeetingUploadWorker 接入 single/multipart R2；server upload/verified-asset/cleanup schema 与 API 上线。
3. 先发布 v2 upload/transcript 客户端；对应 v1 submit 连续一个完整公开周期为零后激活 capability
   barrier。server commit 在同事务激活 verified asset 并创建唯一 generic transcription task；barrier 后
   v1 submit 返回 426，旧 ASR job 只由旧 worker drain。
4. 8030 增加 stable batch/stream DTO；VAD 片段同时投递 ASR/CAM++ 队列。
5. 接入 realtime WSS chunk ack/event cursor/durable snapshot/token refresh；mobile 保存
   partial/stable/final text，speaker/manual overlay 独立应用。
6. 声纹样本只用于生成 scoped encrypted embedding，样本音频随后删除；撤销提升 profile revision。
7. 对 realtime、导入、无语音、断网、kill、重启、删除/恢复做端到端回放；NO_SPEECH 必须提交
   success/no_content 和零 segment final revision，不进入失败或 retry。

退出：1 GiB 上传内存与恢复门通过；双上传+实时会议无冲突；首段/RTF/讲话人预算通过；
未知讲话人不命名；NO_SPEECH 中文结果正确。

回滚：barrier 前允许客户端 capability 切回旧完整链路；barrier 后保留 v2 R2 ingress、verified asset
和 generic Task，只把新 generation 显式路由到 legacy transcription handler adapter，不恢复旧 upload/
ASR submit。新 generation 不回退旧状态；已创建 R2 对象仍由 cleanup obligation 清理。

Stage 2 停写/退出门：旧 upload/ASR submission 已连续一个完整公开周期为零且 capability barrier
已持久激活；barrier 前 lease 可恢复排空；verified asset、late PUT、NO_SPEECH success、双上传+实时
会议和删除/恢复回放通过。旧 worker/handler 保留到 Stage 5；barrier 后回滚只切换 handler revision，
不停止 v2/generic ingress。

## 11. Stage 3：Facts V3、行动与 Q2

入口：Stage 2 exit gate 通过，Transcript source identity、verified asset 和 task owner 已采用。

实施：

1. 先发布携带 v2 binding/source stream 的客户端；summary/question 的 v1 submit 连续一个完整公开周期
   为零后分别激活 capability barrier。此后新 v2 请求只写 generic，v1 submit 返回 426，legacy worker
   只 drain，旧 status/result route 只读。
2. 修复 Facts V3 的 transcript revision/fingerprint 血缘和 artifact/task 原子提交。
3. 增加 deterministic chapter builder/merger；短会 single pack，长会多 pack，无模板模型调用。
   每个已验证 chapter 确定性并入两个固定槽交替写入的有界聚合 checkpoint；重启或自动 retry 从最后
   一个 hash/prefix 均有效的槽继续，最多重跑仍保留 payload 的当前 chapter，不创建 chapter 子 Task，
   也不把 checkpoint 暴露成部分整理结果。
4. action candidates 只做来源/状态/重复验证；采用时创建 ActionItem，绝不覆盖已有 mutable item。
5. Q2 snapshot、provider DTO、grounding、device operation retry 和 owner 已在隔离候选接入；先 shadow，
   再按 capability 默认。笔记/附件修改、epoch/binding 变化和迟到 attempt 都必须使本机激活 CAS 失败。
6. mobile summary/question repositories 原子保存版本、facts/turns、clauses 和 exact citations；Q2
   thread/turn/citation 通过只读投影复用现有问答页，不写旧问答表。

退出：短/长真实样本无截断；事实支持率、引用、行动重复、模板切换、问答相关性和延迟预算通过；
进程在 generation/commit 阶段中断后只有一个当前版本。

回滚：停止新的 vNext handler admission，但继续接收 v2 source stream + generic Task，并将新 generation
显式路由到保留的 Q0/Summary V2 handler revision；已进入 generic 的任务继续 generic drain/read，
不迁回 legacy，也不恢复 legacy submit/mirror。禁止 Q2 失败时请求内调用 Q0。兼容 handler 只在
Stage 5 删除门通过后物理删除。

Stage 3 停写/退出门：summary/question v1 submission 已连续一个完整公开周期为零且 capability barrier
已激活；旧 legacy queued/running/retry_wait 仅剩可恢复排空项；generic 不使用 retry_wait；Q2 immutable source、Facts V3、ActionItem、章节
manifest、引用和内容结果回放通过。Q0/V2 只读兼容保留，不在此阶段物理删除。

## 12. Stage 4：日程、搜索与投影

入口：Stage 3 exit gate 通过，shared schema generation、device v2 和 ProjectionEnvelope 可用。

实施：

1. 执行 0045，拆 `localScheduleParser` 为 recognizers/producer/validator/executor，并启用唯一的本机
   ProjectionEnvelope checkpoint owner。
2. 服务端 graph producer 和 clarification 上线；先发布 v2 schedule client，v1 schedule submit 连续一个
   完整公开周期为零后激活 barrier 并返回 426；server rule pass/model post-normalizer 仅移入兼容模块。
3. voice session 先录后连；统一 supplement graph revision。
4. 建立 FTS5、显式标签分类、回收站和本地 Markdown 分享投影。
5. Minutes/Calendar native snapshots/actions 全部加 envelope；清除文案状态判断。

退出：自然日程 holdout 与常见澄清门通过；两种输入速度预算通过；页面 restart/recreate/stale action
故障注入无跳动、串页或旧写；全局功能回归通过。

回滚：barrier 前日程 v1 整链 producer 可显式恢复；barrier 后保留 v2 graph ingress 和手机唯一 validator，
只把新请求显式路由到 `LegacyScheduleGraphAdapter`，不得重开 v1 submit 或第二 Draft owner。新 Draft
不混入旧 parser 字段。

Stage 4 停写/退出门：v1 schedule submission 已连续一个完整公开周期为零，schedule graph capability
barrier 与本地 validator 已成为默认；旧 parser 只作为版本化 handler adapter；自然 holdout、语音补充、FTS/标签、stale envelope、冷/暖启动与全局本地
功能回放通过。所有旧 parser/mirror/fallback 继续保留到 Stage 5 删除门。

## 13. Stage 5：删除、资源与发布

入口：所有 Stage 1-4 exit gate 通过。删除逐 capability 执行；被删除的每个 legacy capability 必须
同时满足：submission 为零一个完整公开周期、其 legacy 表 queued/running/retry_wait 与有效 lease 为零
（`retry_wait` 仅是 legacy 状态）、legacy 结果保留期已结束、已发布客户端不再保存或查询对应 legacy
task ID、generic task/handler 对待删 route/table/module 的引用计数为零，并且 meeting/epoch 双 store
purge 与进程重启/回滚演练通过。正常 vNext generic task 可以继续 active，不要求全局停服或队列清空。

实施：

1. 在 0041/capability_cutovers 写入 reader removal marker，并再次核对上述逐 capability 删除门。
2. 删除 account/cross-device sync、旧 upload、summary v2、Q0、server duplicate parser 和 mirror。
3. 清理旧模型/venv/cache 前执行 cwd/open-file/systemd/source-reference/hash 审计。
4. 验证三进程拓扑、loopback、公网 80/443、TLS/WSS、日志脱敏、磁盘和 GPU 预算。
5. 递增 version/name/versionCode，构建 APK；核对 APK metadata、hash、size、本地 manifest、公开
   manifest 和下载 headers 后发布。

退出：删除清单无活跃引用；全局验收通过；恢复演练可回到 Stage 4 稳定包；文档与发布事实一致。

回滚：保留 Stage 4 APK、数据库 migration forward compatibility 和一个轻量源码 tag；重资产模型可
重新下载，不保留活动目录多轮副本。

## 14. 删除清单

Stage 1 后停止新写或移出默认路径；实体代码/表保留到 Stage 5 删除门：

- `AuthStore` 的账号状态、Login/Profile/AccountDeletion 业务入口和账号 API；
- `sync_outbox`、`sync_conflicts`、`meeting_scope_write_state` 的新业务写入；
- root/action/summary/occurrence/manual-note/speaker/attachment/marker/tag 的 sync trigger/provider/
  pull/conflict owner；
- 无消费者的 outbox listener 和中文“未同步不能删除”门。

Stage 2 capability barrier 后停止新写并移动到 compatibility module；Stage 5 才物理删除：

- AppStorage upload registry v1/v2/v3、JS Base64 chunk 和前台 retry/backoff；
- WorkRequest UUID 业务身份、共享 R2 key、旧 `/recording-assets/*/content` 写路径；
- speaker 阻塞 transcript final、自动结果原地覆盖 text segment 的逻辑。

Stage 3 capability barrier 后停止新调用并移动到 compatibility module；Stage 5 才物理删除：

- summary v2 公共/模板第二轮、递归摘要、逐行动复核、样本行动补丁；
- Q0 fast-repair/sample answers、scope model、strict verifier、transcript review、final editor、
  exact-slot repair 和 recovery generation；
- Question request 中 `summary_sections` 和历史 `answer` 正文。

Stage 4 barrier 后停止新调用、Stage 5 删除门后物理删除：

- server schedule quick/fallback parser、model 后全文 normalizer、客户端第二 Draft owner；
- summary/topic 自动分类映射；人物页保留为本机 speaker overlay 派生视图，不建立持久人物分类 owner；
- `meetingContentMirror`、`meetingLegacyMirrorCoordinator` 和旧 v1 API adapter；
- 活动源码中的 `.before-*`、多轮备份和无引用模型/venv/cache。

删除前必须 `rg` 源码引用、检查数据库行数/外键、进程 cwd/open files、systemd 和公开 capability；
任何未知归属项保持不动并登记，不用猜测填补。

## 15. 验证矩阵

| 门 | 最低证据 |
| --- | --- |
| 数据 | migration 前后 integrity、外键、实体计数、随机回放；笔记/附件只迁当前真实 revision；account/sync/mirror/share/task purge scope；删除/恢复/epoch fault |
| API | challenge/token/key rotation、binding/purge/source stream 分页/空壳配额、task/attempt lineage、idempotency/cancel/replay/restart、v1/v2 隔离 |
| 上传 | 1 MiB/31 MiB/33 MiB/1 GiB 与超限 1 GiB+，2/4 session、2/4 GiB reservation，断网/kill/prune/expiry/delete/late PUT/HEAD release |
| ASR | realtime/import/no-speech，多格式，首 partial/stable/final、chunk/event cursor 断线重放、token 到期/轮换、RTF、CER/数字时间准确率、标点边界 |
| speaker | registered/unknown/short/overlap，attribution F1、manual CAS/rebase/revoke |
| summary | short/long、notes/attachments、四模板、actions、chapter retry、source mutation |
| Q&A | direct/implicit/absence/open/follow-up，跨会议/旧 revision/无关引用/timeout |
| schedule | independent natural holdout 完全正确率、关键字段召回、错误保存率；simple/complex/correction/range/clarify/query/delete/OOD |
| local features | recurrence/reminder/location/widget/marker/clip/series/tag/trash/share/update/app-lock；ActionItem 全 CRUD/提醒/后续日程 |
| UI | cold/warm launch、process death、rotation/recreate、stale envelope、状态几何稳定 |
| privacy | log scan、payload/artifact/task/share 明确 TTL、device/share revoke（含在途分块中止）、R2 HEAD/list、无公开对象 URL、registering clear、90 天 orphan epoch purge、4096/16384 cleanup 水位与 high-water tombstone 压缩 |
| recovery | 本机 RPO 0；server restart 后查询/续跑 RTO、双 checkpoint 槽切换/损坏/当前章重放、3-attempt backoff、late attempt/epoch/binding fence |
| resource | GPU `<=16 GiB`、总 RSS `<=8 GiB`、CPU p95 `<=16` 核、temp `<=4 GiB`、2/4 realtime、2/4 upload 与 2/4 GiB R2、2/8 stream 与 8/16 MiB manifest、256/512 MiB source、每 Task 2x4 MiB checkpoint 与 16/64 MiB reservation、32/128 share 与 8/32 GiB、4096/16384 cleanup、4/8/32 队列混合负载 |
| release | version fields、APK metadata/signature/hash/size、manifest、headers、standalone launch |

质量样本和自动化流量必须带 `traffic_class`。公开/合成样本可自动回放；私人会议只能在用户明确
授权的验收阶段使用，日志和报告不得保存正文。
