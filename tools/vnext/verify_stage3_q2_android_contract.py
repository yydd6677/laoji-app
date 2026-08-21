#!/usr/bin/env python3
"""Fail closed when the Android Q2 candidate regresses its owner boundary."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def require(path: Path, *needles: str) -> str:
    source = path.read_text(encoding="utf-8")
    for needle in needles:
        if needle not in source:
            raise AssertionError(f"{path.relative_to(ROOT)} missing {needle!r}")
    return source


def main() -> None:
    q2 = ROOT / "src/services/meetingQuestionsQ2.ts"
    candidate = ROOT / "src/services/questionQ2Candidate.ts"
    provider = ROOT / "src/services/questionQ2DeviceProvider.ts"
    repository = ROOT / "src/data/repositories/vnext/questionQ2Repository.ts"
    authority = ROOT / "src/services/deviceAuthority.ts"
    authority_repository = ROOT / "src/data/repositories/vnext/deviceAuthorityRepository.ts"
    sheet = ROOT / "src/components/MeetingQuestionSheet.tsx"
    android_detail = ROOT / "src/screens/TranscriptionScreen.android.tsx"
    api = ROOT / "services/laoji-api/app/api/device_v2.py"
    reader = ROOT / "services/laoji-api/app/services/vnext_question_reader.py"
    contracts = ROOT / "services/laoji-api/app/schemas/vnext_contracts.py"

    q2_source = require(
        q2,
        "JSON.stringify([q2Thread.snapshotId, requestId, operationId])",
        "const generationId = `q2-generation:${generationDigest.slice('sha256:'.length)}`",
        "generationId,",
        "meeting_question_q2_operation",
        "newProviderRevision: Q2_PROVIDER_REVISION",
        "await bindQ2DurableTransport({",
        "!isRecoverableQ2OperationError(error)",
        "Q2_RECOVERY_FENCE_MISSING",
        "await q2TransportHandles({",
        "operation.remoteTaskId !== expectedTransport.taskId",
        "Closing only the local operation",
        "getMeetingServiceBinding(evidence.meetingId)",
        "Only register/confirm the binding remotely after the canonical local",
        "error instanceof DeviceV2ApiError && error.status === 404",
        "reconcilePendingQ2TurnsForMeeting",
        "findPendingQ2ThreadsForMeeting",
        "snapshot.sourceFingerprint !== evidence.sourceFingerprint",
        "return { thread: await projectThread(completed, input.evidence), evidence: input.evidence };",
    )
    if "generationId: `${q2Thread.snapshotId}:${requestId}:${operationId}`" in q2_source:
        raise AssertionError("Q2 still writes an overlong composite generation identity")
    if "`${q2Thread.snapshotId}\\0${requestId}\\0${operationId}`" in q2_source:
        raise AssertionError("Q2 generation digest still uses a native-NUL-truncated input")

    provider_source = require(
        provider,
        "sourceId: required(citation?.source_id, 'source_id', 512)",
        "sourceRevisionId: required(citation?.source_revision_id, 'source_revision_id', 512)",
        "item_id: `q2-item:${index}:${source.contentSha256.slice(-20)}`",
        "const Q2_TASK_RECOVERY_TIMEOUT_MS = 240_000",
        "const shouldStream = request.sources.length > 0",
        "const replay = await readExistingDurableTask(request)",
        "await bindRemoteTaskToOperation(request.operationId!, taskId)",
        "export async function bindQ2DurableTransport(",
        "if (!capabilities.sourceStreamV2) throw new DeviceV2SourceStreamUnavailableError()",
        "const transportDigest = await digest({",
        "taskId: `q2-task:${transportSeed}`",
        "clientOperationId: `q2-operation:${transportSeed}`",
        "generationId: `q2-generation:${transportSeed}`",
        "return readFromSourceStream(request, binding, stream)",
        "const sourceStream = await getDeviceV2SourceStream(replay.streamId)",
        "sourceStream.state === 'open' || sourceStream.state === 'consuming'",
        "stream = await streamLongSources(request, binding)",
        "return recoverQuestionTask(stream.taskId, request, runAttempt)",
        "snapshot.task.retry_not_before_epoch",
        "if (!retryableReaderError(error)) throw error",
        "snapshot.task.input_sha256 !== request.sourceFingerprint",
        "export function q2SourceStreamFailureIsTerminal(error: unknown): boolean",
        "error.status !== 408",
        "error.status !== 429",
    )
    if "item_id: `q2-item:${index}:${source.sourceType}:${source.sourceId}`" in provider_source:
        raise AssertionError("Q2 source stream still embeds an overlong stable source ID in item_id")
    if "const seed = request.operationId" in provider_source:
        raise AssertionError("Q2 source stream still embeds the full durable operation ID in transport handles")

    source_stream = require(
        ROOT / "src/services/deviceV2SourceStream.ts",
        "source_id: id(item.source_id, 'source_id', 512)",
        "source_revision_id: id(item.source_revision_id, 'source_revision_id', 512)",
        "retry_not_before_epoch: retryNotBeforeEpoch",
        "export async function cancelDeviceV2Task(taskId: string)",
        "/tasks/${encodeURIComponent(id(taskId, 'task_id'))}/cancel",
    )
    if "source_id: id(item.source_id, 'source_id', 180)" in source_stream:
        raise AssertionError("Android source-stream client still rejects valid stable source identities")

    require(
        api,
        "source_id: str = Field(min_length=1, max_length=512)",
        "source_revision_id: str = Field(min_length=1, max_length=512)",
    )
    require(
        reader,
        '_SOURCE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,512}$")',
        'source_id = _source_id(item.get("source_id"), "source_id")',
        'revision = _source_id(item.get("source_revision_id"), "source_revision_id")',
    )
    require(
        contracts,
        "class SourceBundleItemV2(VNextModel):",
        "source_id: str = Field(min_length=1, max_length=512)",
        "source_revision_id: str = Field(min_length=1, max_length=512)",
    )
    source_store = require(
        ROOT / "services/laoji-api/app/services/vnext_source_stream_store.py",
        '"source_id": _safe(str(raw.get("source_id") or ""), "source_id", 512)',
        '"source_revision_id": _safe(str(raw.get("source_revision_id") or ""), "source_revision_id", 512)',
    )
    if '"source_id": _safe(str(raw.get("source_id") or ""), "source_id", 180)' in source_store:
        raise AssertionError("source-stream persistence still rejects valid stable source identities")

    candidate_source = require(
        candidate,
        "A generated\n  // summary is a derived projection",
        "...(await sourceForTranscript(evidence))",
        "...(await sourceForAuxiliary(evidence))",
        "sources.length > MAX_Q2_SNAPSHOT_SOURCES",
    )
    auxiliary = candidate_source[
        candidate_source.index("async function sourceForAuxiliary"):
        candidate_source.index("export async function buildQ2CandidateSources")
    ]
    if "evidence.summary" in auxiliary:
        raise AssertionError("Q2 auxiliary source builder reads a generated summary")

    require(
        repository,
        "export const MAX_Q2_SNAPSHOT_SOURCES = 50_000",
        "input.sources.length > MAX_Q2_SNAPSHOT_SOURCES",
        "`q2-clause:${turnId}:${clauseOrdinal}:${clauseId}`",
        "`q2-citation:${turnId}:${clauseOrdinal}:${citationOrdinal}:${citationId}`",
        "persistedCitationId,\n          persistedClauseId,",
        "export class Q2ActivationFenceError extends Error",
        "turn.transcript_revision_id === activationFence.transcriptRevisionId",
        "activeTranscript?.id === activationFence.transcriptRevisionId",
        "turn.current_epoch_id === activationFence.deviceEpochId",
        "turn.binding_generation === activationFence.bindingGeneration",
        "Number(turn.binding_cancel_revision) === activationFence.bindingCancelRevision",
        "source.content_sha256 !== manualNote.content_sha256",
        "SET current_operation_id = ?, provider_revision = ?",
        "newProviderRevision: string;",
        "activation_device_epoch_id",
        "activation_manual_note_revision",
        "activation_attachment_selection_sha256",
        "current.active_text_revision_id !== source.source_revision_id",
        "current.text_content !== current.immutable_content",
        "current.content_sha256 !== source.content_sha256",
        "await sha256Text(current.text_content) !== source.content_sha256",
        "sameStoredActivationFence(turn, activationFence)",
        "export async function findPendingQ2ThreadsForMeeting",
        "operation.remote_state IN ('queued', 'running')",
        "turn.completed_at_ms IS NULL",
    )
    require(
        ROOT / "src/data/db/migrations/0049QuestionQ2ActivationFence.ts",
        "version: 49",
        "PRAGMA table_info(meeting_question_q2_turns)",
        "activation_device_epoch_id",
        "activation_manual_note_revision",
    )
    require(
        ROOT / "src/data/db/migrations/0050QuestionQ2AttachmentFence.ts",
        "version: 50",
        "PRAGMA table_info(meeting_question_q2_turns)",
        "activation_attachment_selection_sha256",
    )
    require(
        authority_repository,
        "listActiveMeetingServiceBindingsThrough",
        "binding_epoch_seq <= ? AND state = 'active'",
        "ORDER BY binding_epoch_seq, binding_id",
    )
    require(
        authority,
        "enqueueBindingRegistration",
        "for (const binding of prefix)",
        "registerRemoteMeetingServiceBinding(binding, binding.bindingId === target.bindingId)",
        "sequence_backfill: !target",
    )
    require(
        ROOT / "tools/vnext/prepare_stage3_android_instrumentation.py",
        "android.testBuildType",
        "VnextSummaryFenceDbMutationTest.java",
        "shutil.copy2(HARNESS_SOURCE, HARNESS_TARGET)",
    )

    require(
        sheet,
        "session.thread.summaryVersionId && session.evidence.summary.length > 0",
        "session.evidence.includeManualNote ? '我的笔记' : null",
        "session.evidence.attachments.length > 0",
        'testID="meeting-question-attachments"',
        'purpose="question"',
        "isMeetingQuestionCitationCurrent(citation, session.evidence)",
        "accessibilityLabel={`查看来源：${citation.sourceLabel}`}",
    )
    require(
        android_detail,
        "const openQuestionCitation = useCallback((target: MeetingQuestionCitationTarget) => {",
        "const selectCitationTab = (tab: MinutesDetailTab) => {",
        "if (target.meetingId !== route.params.meetingId) return;",
        "setActiveTab(tab);",
        "selectCitationTab('transcript');",
        "transcriptFocusRequestId: requestId,",
        "route.params.transcriptFocusRequestId,",
    )
    print("stage3_q2_android_contract=passed")


if __name__ == "__main__":
    main()
