#!/usr/bin/env python3
"""Static guard for the Stage 3 mobile source-stream wire contract.

This does not claim Android or server execution. It catches drift between the
server's received-count response, the mobile normalizer, and the bounded
resume/backpressure path before a device run is available.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def require(path: Path, *needles: str) -> str:
    source = path.read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise AssertionError(f"{path}: missing {missing}")
    return source


def main() -> None:
    client = ROOT / "src/services/deviceV2SourceStream.ts"
    summary = ROOT / "src/services/meetingSummaryV3SourceStream.ts"
    summary_dispatch = ROOT / "src/services/meetingSummary.ts"
    summary_contract = ROOT / "src/services/meetingSummaryV3.ts"
    summary_screen = ROOT / "src/screens/TranscriptionScreen.android.tsx"
    summary_mirror = ROOT / "src/services/meetingContentMirror.ts"
    summary_repository = ROOT / "src/data/repositories/meetingSummaryV3Repository.ts"
    meeting_repository_contract = ROOT / "src/data/repositories/meetingNoteRepository.ts"
    meeting_repository = ROOT / "src/data/repositories/sqliteMeetingNoteRepository.ts"
    upgrade_provider = ROOT / "src/components/MeetingSummaryV3UpgradeProvider.tsx"
    summary_generation_migration = ROOT / "src/data/db/migrations/0048SummaryFactsGenerations.ts"
    server = ROOT / "services/laoji-api/app/services/vnext_source_stream_store.py"
    chapter_pipeline = ROOT / "services/laoji-api/app/services/vnext_summary_chapter_pipeline.py"
    task_store = ROOT / "services/laoji-api/app/services/vnext_task_store.py"
    worker = ROOT / "services/laoji-api/app/services/vnext_summary_worker.py"

    client_source = require(
        client,
        "received_bundle_count: number",
        "received_item_count: number",
        "Number(group.received_bundle_count)",
        "Number(group.received_item_count)",
    )
    if "Number(group.bundle_count)" in client_source or "Number(group.item_count)" in client_source:
        raise AssertionError("mobile source-group normalizer still reads legacy count names")
    require(
        summary,
        "getDeviceV2SourceStream",
        "waitForSourceChapterSlot",
        "SOURCE_ADMISSION_LIMIT",
        "resumedTask.task.source_stream_id",
        "resumedTask.task.input_sha256",
        "appendSummaryManifestPages",
        "MANIFEST_PAGE_DESCRIPTORS",
        "current.next_manifest_chapter",
        "MANIFEST_CAPACITY",
        "const existingTask = await getDeviceV2Task(taskId);",
        "if (existingTask.task.state === 'success')",
        "const streamId = `summary-stream:${hex(await digest(taskId))}`;",
        "streamId,",
    )
    dispatch_source = require(
        summary_dispatch,
        "if (getFeatureFlags().meetingSummarySourceStreamCandidate)",
        "return generateDeviceMeetingSummaryV3(options);",
        "const capabilities = await loadDeviceServiceCapabilities().catch(() => null);",
    )
    candidate_dispatch = dispatch_source.index(
        "if (getFeatureFlags().meetingSummarySourceStreamCandidate)"
    )
    legacy_capability_probe = dispatch_source.index(
        "const capabilities = await loadDeviceServiceCapabilities().catch(() => null);",
        candidate_dispatch,
    )
    if candidate_dispatch >= legacy_capability_probe:
        raise AssertionError("source-stream candidate still depends on device-v1 capability discovery")
    require(
        summary_contract,
        "const documentId = text(root?.document_id, 220);",
        "function anchorTranscriptCitation(",
        "Math.abs(candidate.startMs - requestedStart) <= 2",
        "anchorTranscriptCitations(item.citations, transcriptLines)",
    )
    summary_screen_source = require(
        summary_screen,
        "current.document.manualNoteRevision,\n        transcriptRef.current,",
        "const ownsLocalSummaryRestore = () => (",
        "if (!ownsLocalSummaryRestore()) return;",
        "transcriptRef.current,",
        "}, [meetingScopeKey]);",
        "meeting_summary_v3_local_persist",
        "const activationFingerprint = meetingSummaryInputFingerprint(",
        "if (activationFingerprint !== fingerprint) throw new MeetingSummaryInputChangedError()",
        "storedFacts.result.documentId !== generated.facts_document_v3.documentId",
    )
    if "saveMeetingFactsResultV3" in summary_screen_source or "linkMeetingFactsToSummaryVersion" in summary_screen_source:
        raise AssertionError("active summary screen still persists Facts V3 outside the summary-version transaction")
    require(
        summary_mirror,
        "const activeManualNote = await transaction.getManualNote(note.id, scopeKey);",
        "const sourceInputsStillActive = sourceTranscriptStillActive && sourceManualNoteStillActive;",
        "factDocument: { ...factDocument, summaryVersionId: existingVersion.id }",
        "factDocument,\n        });",
    )
    require(
        meeting_repository_contract,
        "export interface SummaryFactDocumentRecord",
        "factDocument?: SummaryFactDocumentRecord;",
    )
    require(
        meeting_repository,
        "immutable summary fact document cannot be replaced",
        "INSERT INTO summary_fact_documents",
        "summary_version_id IS NULL",
    )
    upgrade_provider_source = require(
        upgrade_provider,
        "if (cached.projection !== 'updated') throw new SummaryV3UpgradeInputChangedError()",
        "clearRemoteTask: true",
        "storedFacts.result.documentId !== facts.documentId",
    )
    if "saveMeetingFactsResultV3" in upgrade_provider_source or "linkMeetingFactsToSummaryVersion" in upgrade_provider_source:
        raise AssertionError("background summary upgrade still persists Facts V3 outside the summary-version transaction")
    repository_source = require(
        summary_repository,
        "WHERE id = ?",
        "result.documentId",
        "summary v3 immutable identity changed",
        "summary v3 target version is unavailable",
        "summary v3 fact document is unavailable",
    )
    if "WHERE meeting_id = ? AND source_fingerprint = ?" in repository_source:
        raise AssertionError("summary v3 repository still collapses distinct force generations")
    require(
        summary_generation_migration,
        "CREATE TABLE summary_fact_documents_v48",
        "DROP TABLE summary_fact_documents",
        "idx_summary_fact_document_source_generation",
    )
    require(
        chapter_pipeline,
        "document_identity = hashlib.sha256(",
        '"document_id": f"vnext:{document_identity}"',
    )
    require(
        server,
        "MAX_GROUPS_DEVICE = 2",
        '"next_bundle_ordinal": int(totals["bundle_count"])',
        '"received_bundle_count"',
        '"received_item_count"',
    )
    require(
        task_store,
        "source_group.chapter_ordinal = stream.next_consumable_chapter",
        "source_group.state = 'complete'",
    )
    require(worker, "LEASE_SECONDS = 30", "HEARTBEAT_SECONDS = 10")
    print("stage3_source_stream_contract=passed")


if __name__ == "__main__":
    main()
