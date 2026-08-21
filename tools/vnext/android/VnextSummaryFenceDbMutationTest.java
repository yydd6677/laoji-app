package com.laoji.app;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Emulator-only fault injection for the Summary V3 activation fence.
 *
 * <p>The test APK is separate from the shipping APK. A caller must pass the
 * local meeting identity explicitly, so no evaluation fixture or transcript
 * content is embedded in product code. The original revision is persisted in
 * the target application's cache and restoration fails closed unless the
 * database still contains exactly the injected revision.</p>
 */
@RunWith(AndroidJUnit4.class)
public final class VnextSummaryFenceDbMutationTest {
    private static final String DATABASE_RELATIVE_PATH = "SQLite/laoji-meeting-memory.db";
    private static final String ORIGINAL_REVISION_FILE =
            "vnext-summary-fence-binding-revision.txt";
    private static final String ORIGINAL_ATTACHMENT_REVISION_FILE =
            "vnext-summary-fence-attachment-revision.txt";
    private static final String ORIGINAL_BINDING_EPOCH_FILE =
            "vnext-summary-fence-binding-epoch.txt";
    private static final String DELETED_ATTACHMENT_FILE =
            "vnext-summary-fence-attachment-deleted.txt";
    private static final String MOVED_ATTACHMENT_FILE =
            "vnext-summary-fence-attachment-position.txt";
    private static final String CHANGED_ATTACHMENT_CONTENT_FILE =
            "vnext-summary-fence-attachment-content.txt";
    private static final String ATTACHMENT_FIXTURE_TEXT =
            "附件围栏验收：最终结果不得覆盖已经变化的会议来源。";
    private static final String CHANGED_ATTACHMENT_FIXTURE_TEXT =
            "附件围栏验收：这段正文已在远端任务运行期间变化。";

    @Test
    public void testQ2ActivationFenceMigration() {
        final File databaseFile = databaseFile();
        assertTrue("candidate meeting database is missing", databaseFile.isFile());
        try (SQLiteDatabase database = openDatabase()) {
            assertTrue("Q2 attachment-fence migration was not applied",
                    scalarLong(database, "PRAGMA user_version") >= 50L);
            final String[] columns = new String[]{
                    "activation_device_epoch_id",
                    "activation_binding_id",
                    "activation_binding_generation",
                    "activation_binding_revision",
                    "activation_binding_cancel_revision",
                    "activation_manual_note_mode",
                    "activation_manual_note_revision",
                    "activation_attachment_selection_sha256",
            };
            for (String column : columns) {
                assertEquals("missing Q2 activation-fence column " + column, 1,
                        countRows(database,
                                "SELECT COUNT(*) FROM pragma_table_info('meeting_question_q2_turns') "
                                        + "WHERE name = ?",
                                column));
            }
            assertEquals("ok", scalarString(database, "PRAGMA integrity_check"));
            try (Cursor foreignKeys = database.rawQuery("PRAGMA foreign_key_check", null)) {
                assertEquals(0, foreignKeys.getCount());
            }
        }
    }

    @Test
    public void testCreateTextAttachmentFixture() throws Exception {
        final String meetingId = requiredMeetingId();
        final String markerId = fixtureId("marker", meetingId);
        final String attachmentId = fixtureId("attachment", meetingId);
        final String revisionId = "attachment_text:" + attachmentId + ":1";
        final long nowMs = System.currentTimeMillis();

        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                assertEquals("fixture marker already exists", 0,
                        rowCount(database, "markers", markerId));
                assertEquals("fixture attachment already exists", 0,
                        rowCount(database, "meeting_attachments", attachmentId));
                final String scopeKey = readMeetingScope(database, meetingId);
                database.execSQL(
                        "INSERT INTO markers (id, meeting_id, position_ms, nearest_segment_id, "
                                + "label, kind, created_at_ms, updated_at_ms) "
                                + "VALUES (?, ?, 0, NULL, ?, 'important', ?, ?)",
                        new Object[]{markerId, meetingId, "vNext attachment fence fixture", nowMs, nowMs});
                database.execSQL(
                        "INSERT INTO meeting_attachments (id, meeting_id, scope_key, marker_id, "
                                + "position_ms, kind, text_content, created_at_ms, updated_at_ms) "
                                + "VALUES (?, ?, ?, ?, 0, 'text', ?, ?, ?)",
                        new Object[]{attachmentId, meetingId, scopeKey, markerId,
                                ATTACHMENT_FIXTURE_TEXT, nowMs, nowMs});
                database.execSQL(
                        "INSERT INTO meeting_attachment_text_revisions (revision_id, attachment_id, "
                                + "meeting_id, revision, content_kind, content, content_sha256, "
                                + "migrated_current, created_at_ms) "
                                + "VALUES (?, ?, ?, 1, 'text', ?, ?, 0, ?)",
                        new Object[]{revisionId, attachmentId, meetingId, ATTACHMENT_FIXTURE_TEXT,
                                sha256Text(ATTACHMENT_FIXTURE_TEXT), nowMs});
                database.execSQL(
                        "UPDATE meeting_attachments SET active_text_revision_id = ? WHERE id = ?",
                        new Object[]{revisionId, attachmentId});
                assertEquals(1, rowCount(database, "markers", markerId));
                assertEquals(1, rowCount(database, "meeting_attachments", attachmentId));
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
    }

    @Test
    public void testBumpAttachmentRevision() throws Exception {
        final String meetingId = requiredMeetingId();
        final String attachmentId = fixtureId("attachment", meetingId);
        final File marker = attachmentRevisionMarkerFile();
        assertFalse("restore the previous attachment fault first", marker.exists());
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                final long original = readAttachmentUpdatedAt(database, meetingId, attachmentId);
                Files.write(marker.toPath(), (meetingId + "\n" + attachmentId + "\n" + original + "\n")
                        .getBytes(StandardCharsets.UTF_8));
                database.execSQL(
                        "UPDATE meeting_attachments SET updated_at_ms = updated_at_ms + 1 "
                                + "WHERE id = ? AND meeting_id = ? AND updated_at_ms = ? "
                                + "AND kind = 'text'",
                        new Object[]{attachmentId, meetingId, original});
                assertEquals(original + 1, readAttachmentUpdatedAt(database, meetingId, attachmentId));
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
    }

    @Test
    public void testRestoreAttachmentRevision() throws Exception {
        final File marker = attachmentRevisionMarkerFile();
        assertTrue("no injected attachment revision is pending", marker.isFile());
        final String[] lines = new String(
                Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8).split("\\R");
        assertTrue("attachment fault marker is malformed", lines.length >= 3);
        final String meetingId = lines[0].trim();
        final String attachmentId = lines[1].trim();
        final long original = Long.parseLong(lines[2].trim());
        assertEquals(requiredMeetingId(), meetingId);
        assertEquals(fixtureId("attachment", meetingId), attachmentId);
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                assertEquals("attachment changed after injection; refusing unsafe restore",
                        original + 1, readAttachmentUpdatedAt(database, meetingId, attachmentId));
                database.execSQL(
                        "UPDATE meeting_attachments SET updated_at_ms = ? "
                                + "WHERE id = ? AND meeting_id = ? AND updated_at_ms = ? "
                                + "AND kind = 'text'",
                        new Object[]{original, attachmentId, meetingId, original + 1});
                assertEquals(original, readAttachmentUpdatedAt(database, meetingId, attachmentId));
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
        assertTrue("attachment fault marker could not be deleted", marker.delete());
    }

    @Test
    public void testMoveBindingToDifferentEpoch() throws Exception {
        final String meetingId = requiredMeetingId();
        final String replacementEpochId = fixtureId("epoch", meetingId);
        final File marker = bindingEpochMarkerFile();
        assertFalse("restore the previous binding epoch fault first", marker.exists());
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                final BindingState before = readBinding(database, meetingId);
                assertEquals("fault injection requires an active binding", "active", before.state);
                assertFalse("replacement epoch unexpectedly matches the binding epoch",
                        replacementEpochId.equals(before.deviceEpochId));
                assertEquals("replacement epoch already exists", 0,
                        epochRowCount(database, replacementEpochId));
                Files.write(marker.toPath(), (meetingId + "\n" + before.deviceEpochId + "\n"
                        + replacementEpochId + "\n").getBytes(StandardCharsets.UTF_8));
                database.execSQL(
                        "INSERT INTO device_epochs (epoch_id, status, created_at_ms) "
                                + "VALUES (?, 'active', ?)",
                        new Object[]{replacementEpochId, System.currentTimeMillis()});
                database.execSQL(
                        "UPDATE meeting_service_bindings SET device_epoch_id = ?, "
                                + "updated_at_ms = updated_at_ms + 1 "
                                + "WHERE meeting_id = ? AND device_epoch_id = ? AND state = 'active'",
                        new Object[]{replacementEpochId, meetingId, before.deviceEpochId});
                assertEquals(replacementEpochId, readBinding(database, meetingId).deviceEpochId);
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
    }

    @Test
    public void testRestoreBindingEpoch() throws Exception {
        final File marker = bindingEpochMarkerFile();
        assertTrue("no injected binding epoch is pending", marker.isFile());
        final String[] lines = readMarkerLines(marker, 3);
        final String meetingId = lines[0].trim();
        final String originalEpochId = lines[1].trim();
        final String replacementEpochId = lines[2].trim();
        assertEquals(requiredMeetingId(), meetingId);
        assertEquals(fixtureId("epoch", meetingId), replacementEpochId);
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                assertEquals("binding epoch changed after injection; refusing unsafe restore",
                        replacementEpochId, readBinding(database, meetingId).deviceEpochId);
                database.execSQL(
                        "UPDATE meeting_service_bindings SET device_epoch_id = ?, "
                                + "updated_at_ms = updated_at_ms + 1 "
                                + "WHERE meeting_id = ? AND device_epoch_id = ? AND state = 'active'",
                        new Object[]{originalEpochId, meetingId, replacementEpochId});
                assertEquals(originalEpochId, readBinding(database, meetingId).deviceEpochId);
                database.execSQL("DELETE FROM device_epochs WHERE epoch_id = ?",
                        new Object[]{replacementEpochId});
                assertEquals(0, epochRowCount(database, replacementEpochId));
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
        assertTrue("binding epoch marker could not be deleted", marker.delete());
    }

    @Test
    public void testDeleteAttachmentDuringTask() throws Exception {
        final String meetingId = requiredMeetingId();
        final String attachmentId = fixtureId("attachment", meetingId);
        final File marker = deletedAttachmentMarkerFile();
        assertFalse("restore the previous deleted attachment fault first", marker.exists());
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                final AttachmentState before = readAttachment(database, meetingId, attachmentId);
                assertEquals(ATTACHMENT_FIXTURE_TEXT, before.textContent);
                assertEquals("attachment_text:" + attachmentId + ":1", before.activeRevisionId);
                final long revisionCreatedAtMs = readAttachmentRevisionCreatedAt(
                        database, before.activeRevisionId);
                Files.write(marker.toPath(), (meetingId + "\n" + attachmentId + "\n"
                        + before.scopeKey + "\n" + before.markerId + "\n" + before.positionMs + "\n"
                        + before.createdAtMs + "\n" + before.updatedAtMs + "\n"
                        + revisionCreatedAtMs + "\n").getBytes(StandardCharsets.UTF_8));
                database.execSQL(
                        "DELETE FROM meeting_attachments WHERE id = ? AND meeting_id = ? "
                                + "AND kind = 'text' AND text_content = ?",
                        new Object[]{attachmentId, meetingId, ATTACHMENT_FIXTURE_TEXT});
                assertEquals(0, rowCount(database, "meeting_attachments", attachmentId));
                assertEquals(0, attachmentRevisionRowCount(database, before.activeRevisionId));
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
    }

    @Test
    public void testDiscardUncommittedDeletedAttachmentMarker() throws Exception {
        final String meetingId = requiredMeetingId();
        final String attachmentId = fixtureId("attachment", meetingId);
        final String revisionId = "attachment_text:" + attachmentId + ":1";
        final File marker = deletedAttachmentMarkerFile();
        assertTrue("no uncommitted deleted attachment marker is pending", marker.isFile());
        final String[] lines = readMarkerLines(marker, 8);
        assertEquals(meetingId, lines[0].trim());
        assertEquals(attachmentId, lines[1].trim());
        try (SQLiteDatabase database = openDatabase()) {
            assertEquals(1, rowCount(database, "meeting_attachments", attachmentId));
            assertEquals(1, attachmentRevisionRowCount(database, revisionId));
            assertEquals(ATTACHMENT_FIXTURE_TEXT,
                    readAttachment(database, meetingId, attachmentId).textContent);
        }
        assertTrue("uncommitted deleted attachment marker could not be deleted", marker.delete());
    }

    @Test
    public void testRestoreDeletedAttachment() throws Exception {
        final File marker = deletedAttachmentMarkerFile();
        assertTrue("no deleted attachment fault is pending", marker.isFile());
        final String[] lines = readMarkerLines(marker, 8);
        final String meetingId = lines[0].trim();
        final String attachmentId = lines[1].trim();
        final String scopeKey = lines[2].trim();
        final String markerId = lines[3].trim();
        final long positionMs = Long.parseLong(lines[4].trim());
        final long createdAtMs = Long.parseLong(lines[5].trim());
        final long updatedAtMs = Long.parseLong(lines[6].trim());
        final long revisionCreatedAtMs = Long.parseLong(lines[7].trim());
        final String revisionId = "attachment_text:" + attachmentId + ":1";
        assertEquals(requiredMeetingId(), meetingId);
        assertEquals(fixtureId("attachment", meetingId), attachmentId);
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                assertEquals("attachment reappeared after injection; refusing unsafe restore", 0,
                        rowCount(database, "meeting_attachments", attachmentId));
                assertEquals("attachment revision reappeared after injection", 0,
                        attachmentRevisionRowCount(database, revisionId));
                database.execSQL(
                        "INSERT INTO meeting_attachments (id, meeting_id, scope_key, marker_id, "
                                + "position_ms, kind, text_content, created_at_ms, updated_at_ms, "
                                + "active_text_revision_id) VALUES (?, ?, ?, ?, ?, 'text', ?, ?, ?, ?)",
                        new Object[]{attachmentId, meetingId, scopeKey, markerId, positionMs,
                                ATTACHMENT_FIXTURE_TEXT, createdAtMs, updatedAtMs, revisionId});
                database.execSQL(
                        "INSERT INTO meeting_attachment_text_revisions (revision_id, attachment_id, "
                                + "meeting_id, revision, content_kind, content, content_sha256, "
                                + "migrated_current, created_at_ms) VALUES (?, ?, ?, 1, 'text', ?, ?, 0, ?)",
                        new Object[]{revisionId, attachmentId, meetingId, ATTACHMENT_FIXTURE_TEXT,
                                sha256Text(ATTACHMENT_FIXTURE_TEXT), revisionCreatedAtMs});
                assertEquals(1, rowCount(database, "meeting_attachments", attachmentId));
                assertEquals(1, attachmentRevisionRowCount(database, revisionId));
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
        assertTrue("deleted attachment marker could not be deleted", marker.delete());
    }

    @Test
    public void testMoveAttachmentDuringTask() throws Exception {
        final String meetingId = requiredMeetingId();
        final String attachmentId = fixtureId("attachment", meetingId);
        final File marker = movedAttachmentMarkerFile();
        assertFalse("restore the previous moved attachment fault first", marker.exists());
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                final AttachmentState before = readAttachment(database, meetingId, attachmentId);
                Files.write(marker.toPath(), (meetingId + "\n" + attachmentId + "\n"
                        + before.positionMs + "\n").getBytes(StandardCharsets.UTF_8));
                database.execSQL(
                        "UPDATE meeting_attachments SET position_ms = position_ms + 1 "
                                + "WHERE id = ? AND meeting_id = ? AND position_ms = ? AND kind = 'text'",
                        new Object[]{attachmentId, meetingId, before.positionMs});
                assertEquals(before.positionMs + 1,
                        readAttachment(database, meetingId, attachmentId).positionMs);
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
    }

    @Test
    public void testRestoreMovedAttachment() throws Exception {
        final File marker = movedAttachmentMarkerFile();
        assertTrue("no moved attachment fault is pending", marker.isFile());
        final String[] lines = readMarkerLines(marker, 3);
        final String meetingId = lines[0].trim();
        final String attachmentId = lines[1].trim();
        final long originalPositionMs = Long.parseLong(lines[2].trim());
        assertEquals(requiredMeetingId(), meetingId);
        assertEquals(fixtureId("attachment", meetingId), attachmentId);
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                assertEquals("attachment moved again after injection; refusing unsafe restore",
                        originalPositionMs + 1,
                        readAttachment(database, meetingId, attachmentId).positionMs);
                database.execSQL(
                        "UPDATE meeting_attachments SET position_ms = ? "
                                + "WHERE id = ? AND meeting_id = ? AND position_ms = ? AND kind = 'text'",
                        new Object[]{originalPositionMs, attachmentId, meetingId,
                                originalPositionMs + 1});
                assertEquals(originalPositionMs,
                        readAttachment(database, meetingId, attachmentId).positionMs);
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
        assertTrue("moved attachment marker could not be deleted", marker.delete());
    }

    @Test
    public void testChangeAttachmentContentDuringTask() throws Exception {
        final String meetingId = requiredMeetingId();
        final String attachmentId = fixtureId("attachment", meetingId);
        final File marker = changedAttachmentContentMarkerFile();
        assertFalse("restore the previous attachment content fault first", marker.exists());
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                final AttachmentState before = readAttachment(database, meetingId, attachmentId);
                assertEquals(ATTACHMENT_FIXTURE_TEXT, before.textContent);
                Files.write(marker.toPath(), (meetingId + "\n" + attachmentId + "\n")
                        .getBytes(StandardCharsets.UTF_8));
                database.execSQL(
                        "UPDATE meeting_attachments SET text_content = ? "
                                + "WHERE id = ? AND meeting_id = ? AND kind = 'text' "
                                + "AND text_content = ?",
                        new Object[]{CHANGED_ATTACHMENT_FIXTURE_TEXT, attachmentId, meetingId,
                                ATTACHMENT_FIXTURE_TEXT});
                assertEquals(CHANGED_ATTACHMENT_FIXTURE_TEXT,
                        readAttachment(database, meetingId, attachmentId).textContent);
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
    }

    @Test
    public void testRestoreChangedAttachmentContent() throws Exception {
        final File marker = changedAttachmentContentMarkerFile();
        assertTrue("no attachment content fault is pending", marker.isFile());
        final String[] lines = readMarkerLines(marker, 2);
        final String meetingId = lines[0].trim();
        final String attachmentId = lines[1].trim();
        assertEquals(requiredMeetingId(), meetingId);
        assertEquals(fixtureId("attachment", meetingId), attachmentId);
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                assertEquals("attachment content changed again; refusing unsafe restore",
                        CHANGED_ATTACHMENT_FIXTURE_TEXT,
                        readAttachment(database, meetingId, attachmentId).textContent);
                database.execSQL(
                        "UPDATE meeting_attachments SET text_content = ? "
                                + "WHERE id = ? AND meeting_id = ? AND kind = 'text' "
                                + "AND text_content = ?",
                        new Object[]{ATTACHMENT_FIXTURE_TEXT, attachmentId, meetingId,
                                CHANGED_ATTACHMENT_FIXTURE_TEXT});
                assertEquals(ATTACHMENT_FIXTURE_TEXT,
                        readAttachment(database, meetingId, attachmentId).textContent);
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
        assertTrue("attachment content marker could not be deleted", marker.delete());
    }

    @Test
    public void testQ2ChangedAttachmentResultRejected() {
        final String meetingId = requiredMeetingId();
        final String remoteTaskId = requiredRemoteTaskId();
        try (SQLiteDatabase database = openDatabase()) {
            assertEquals("changed attachment result was not rejected exactly once", 1,
                    countRows(database,
                            "SELECT COUNT(*) FROM device_operations operation "
                                    + "INNER JOIN meeting_question_q2_turns turn "
                                    + "ON turn.current_operation_id = operation.operation_id "
                                    + "WHERE operation.remote_task_id = ? "
                                    + "AND operation.entity_id = ? "
                                    + "AND operation.remote_state = 'failure' "
                                    + "AND operation.error_code = 'Q2_EVIDENCE_CHANGED' "
                                    + "AND turn.answer IS NULL AND turn.completed_at_ms IS NULL",
                            remoteTaskId, meetingId));
            assertEquals("rejected Q2 result persisted local clauses", 0,
                    countRows(database,
                            "SELECT COUNT(*) FROM meeting_question_q2_clauses clause "
                                    + "INNER JOIN meeting_question_q2_turns turn "
                                    + "ON turn.turn_id = clause.turn_id "
                                    + "INNER JOIN device_operations operation "
                                    + "ON operation.operation_id = turn.current_operation_id "
                                    + "WHERE operation.remote_task_id = ?",
                            remoteTaskId));
            assertEquals("ok", scalarString(database, "PRAGMA integrity_check"));
        }
    }

    @Test
    public void testDeleteTextAttachmentFixture() throws Exception {
        final String meetingId = requiredMeetingId();
        final String markerId = fixtureId("marker", meetingId);
        final String attachmentId = fixtureId("attachment", meetingId);
        final String revisionId = "attachment_text:" + attachmentId + ":1";
        assertFalse("restore the injected attachment revision first",
                attachmentRevisionMarkerFile().exists());
        assertFalse("restore the injected attachment deletion first",
                deletedAttachmentMarkerFile().exists());
        assertFalse("restore the injected attachment move first",
                movedAttachmentMarkerFile().exists());
        assertFalse("restore the injected attachment content first",
                changedAttachmentContentMarkerFile().exists());
        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                final int attachmentCount = rowCount(
                        database, "meeting_attachments", attachmentId);
                assertTrue("unexpected fixture attachment count", attachmentCount <= 1);
                if (attachmentCount == 1) {
                    assertEquals(ATTACHMENT_FIXTURE_TEXT,
                            readAttachmentText(database, meetingId, attachmentId));
                    database.execSQL(
                            "UPDATE meeting_attachments SET active_text_revision_id = NULL "
                                    + "WHERE id = ? AND meeting_id = ? AND kind = 'text' "
                                    + "AND text_content = ? AND active_text_revision_id = ?",
                            new Object[]{attachmentId, meetingId, ATTACHMENT_FIXTURE_TEXT,
                                    revisionId});
                }
                database.execSQL(
                        "DELETE FROM meeting_attachment_text_revisions "
                                + "WHERE revision_id = ? AND attachment_id = ? AND meeting_id = ? "
                                + "AND revision = 1 AND content_kind = 'text' AND content = ? "
                                + "AND content_sha256 = ?",
                        new Object[]{revisionId, attachmentId, meetingId, ATTACHMENT_FIXTURE_TEXT,
                                sha256Text(ATTACHMENT_FIXTURE_TEXT)});
                assertEquals(0, attachmentRevisionRowCount(database, revisionId));
                database.execSQL(
                        "DELETE FROM meeting_attachments WHERE id = ? AND meeting_id = ? "
                                + "AND kind = 'text' AND text_content = ?",
                        new Object[]{attachmentId, meetingId, ATTACHMENT_FIXTURE_TEXT});
                assertEquals(0, rowCount(database, "meeting_attachments", attachmentId));
                database.execSQL(
                        "DELETE FROM markers WHERE id = ? AND meeting_id = ? "
                                + "AND label = 'vNext attachment fence fixture'",
                        new Object[]{markerId, meetingId});
                assertEquals(0, rowCount(database, "markers", markerId));
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
    }

    @Test
    public void testAuditRestoredFenceState() throws Exception {
        final String meetingId = requiredMeetingId();
        final String attachmentId = fixtureId("attachment", meetingId);
        assertFalse(markerFile().exists());
        assertFalse(attachmentRevisionMarkerFile().exists());
        assertFalse(bindingEpochMarkerFile().exists());
        assertFalse(deletedAttachmentMarkerFile().exists());
        assertFalse(movedAttachmentMarkerFile().exists());
        assertFalse(changedAttachmentContentMarkerFile().exists());
        try (SQLiteDatabase database = openDatabase()) {
            final BindingState binding = readBinding(database, meetingId);
            assertEquals("active", binding.state);
            assertEquals(readCurrentEpoch(database), binding.deviceEpochId);
            final AttachmentState attachment = readAttachment(database, meetingId, attachmentId);
            assertEquals(0L, attachment.positionMs);
            assertEquals(ATTACHMENT_FIXTURE_TEXT, attachment.textContent);
            assertEquals("attachment_text:" + attachmentId + ":1", attachment.activeRevisionId);
            assertEquals(1, attachmentRevisionRowCount(database, attachment.activeRevisionId));
            assertEquals(0, countRows(database,
                    "SELECT COUNT(*) FROM device_summary_task_intents WHERE meeting_id = ?",
                    meetingId));
            final String currentSummaryVersionId = readCurrentSummaryVersion(database, meetingId);
            assertNotNull("previous readable summary was lost", currentSummaryVersionId);
            assertEquals(1, countRows(database,
                    "SELECT COUNT(*) FROM summary_fact_documents "
                            + "WHERE meeting_id = ? AND summary_version_id = ?",
                    meetingId, currentSummaryVersionId));
            assertEquals("ok", scalarString(database, "PRAGMA integrity_check"));
            try (Cursor foreignKeys = database.rawQuery("PRAGMA foreign_key_check", null)) {
                assertEquals(0, foreignKeys.getCount());
            }
            final int factsCount = countRows(database,
                    "SELECT COUNT(*) FROM summary_fact_documents WHERE meeting_id = ?", meetingId);
            System.out.println("VNEXT_FENCE_AUDIT facts=" + factsCount
                    + " intents=0 integrity=ok foreign_keys=0");
        }
    }

    @Test
    public void testBumpBindingRevision() throws Exception {
        final String meetingId = requiredMeetingId();
        final File databaseFile = databaseFile();
        assertTrue("candidate meeting database is missing", databaseFile.isFile());

        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                final BindingState before = readBinding(database, meetingId);
                assertEquals("fault injection requires an active binding", "active", before.state);
                assertTrue("binding revision must be positive", before.revision > 0);
                final File marker = markerFile();
                assertFalse("restore the previous fault injection first", marker.exists());
                Files.write(
                        marker.toPath(),
                        (meetingId + "\n" + before.revision + "\n")
                                .getBytes(StandardCharsets.UTF_8));

                database.execSQL(
                        "UPDATE meeting_service_bindings "
                                + "SET binding_revision = binding_revision + 1, "
                                + "updated_at_ms = updated_at_ms + 1 "
                                + "WHERE meeting_id = ? AND binding_revision = ? "
                                + "AND state = 'active'",
                        new Object[]{meetingId, before.revision});
                assertEquals(before.revision + 1, readBinding(database, meetingId).revision);
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
    }

    @Test
    public void testRestoreBindingRevision() throws Exception {
        final File marker = markerFile();
        assertTrue("no injected binding revision is pending", marker.isFile());
        final String[] lines = new String(
                Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8).split("\\R");
        assertTrue("fault marker is malformed", lines.length >= 2);
        final String meetingId = lines[0].trim();
        final long originalRevision = Long.parseLong(lines[1].trim());
        assertEquals("restore meeting does not match requested meeting", requiredMeetingId(), meetingId);

        try (SQLiteDatabase database = openDatabase()) {
            database.beginTransaction();
            try {
                final BindingState before = readBinding(database, meetingId);
                assertEquals(
                        "binding changed after fault injection; refusing an unsafe restore",
                        originalRevision + 1,
                        before.revision);
                database.execSQL(
                        "UPDATE meeting_service_bindings "
                                + "SET binding_revision = ?, updated_at_ms = updated_at_ms + 1 "
                                + "WHERE meeting_id = ? AND binding_revision = ? "
                                + "AND state = 'active'",
                        new Object[]{originalRevision, meetingId, before.revision});
                assertEquals(originalRevision, readBinding(database, meetingId).revision);
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
        assertTrue("fault marker could not be deleted", marker.delete());
    }

    private String requiredMeetingId() {
        final Bundle arguments = InstrumentationRegistry.getArguments();
        final String meetingId = arguments == null ? null : arguments.getString("meeting_id");
        assertNotNull("pass -e meeting_id <local meeting UUID>", meetingId);
        final String normalized = meetingId.trim();
        assertTrue("meeting_id must be a UUID", normalized.matches(
                "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                        + "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"));
        return normalized;
    }

    private String requiredRemoteTaskId() {
        final Bundle arguments = InstrumentationRegistry.getArguments();
        final String remoteTaskId = arguments == null ? null : arguments.getString("remote_task_id");
        assertNotNull("pass -e remote_task_id q2-task:<sha256>", remoteTaskId);
        final String normalized = remoteTaskId.trim();
        assertTrue("remote_task_id must be a deterministic Q2 task identity",
                normalized.matches("q2-task:[0-9a-f]{64}"));
        return normalized;
    }

    private File databaseFile() {
        return new File(
                InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir(),
                DATABASE_RELATIVE_PATH);
    }

    private File markerFile() {
        return new File(
                InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),
                ORIGINAL_REVISION_FILE);
    }

    private File attachmentRevisionMarkerFile() {
        return new File(
                InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),
                ORIGINAL_ATTACHMENT_REVISION_FILE);
    }

    private File bindingEpochMarkerFile() {
        return cacheFile(ORIGINAL_BINDING_EPOCH_FILE);
    }

    private File deletedAttachmentMarkerFile() {
        return cacheFile(DELETED_ATTACHMENT_FILE);
    }

    private File movedAttachmentMarkerFile() {
        return cacheFile(MOVED_ATTACHMENT_FILE);
    }

    private File changedAttachmentContentMarkerFile() {
        return cacheFile(CHANGED_ATTACHMENT_CONTENT_FILE);
    }

    private File cacheFile(String name) {
        return new File(
                InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(), name);
    }

    private SQLiteDatabase openDatabase() {
        final SQLiteDatabase database = SQLiteDatabase.openDatabase(
                databaseFile().getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);
        database.setForeignKeyConstraintsEnabled(true);
        return database;
    }

    private static String fixtureId(String kind, String meetingId) {
        return UUID.nameUUIDFromBytes(
                ("vnext-summary-fence:" + kind + ":" + meetingId)
                        .getBytes(StandardCharsets.UTF_8)).toString();
    }

    private static String sha256Text(String value) throws Exception {
        final byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
        final StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte item : digest) hex.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return "sha256:" + hex;
    }

    private static int rowCount(SQLiteDatabase database, String table, String id) {
        try (Cursor cursor = database.rawQuery(
                "SELECT COUNT(*) FROM " + table + " WHERE id = ?", new String[]{id})) {
            assertTrue(cursor.moveToFirst());
            return cursor.getInt(0);
        }
    }

    private static int attachmentRevisionRowCount(
            SQLiteDatabase database, String revisionId) {
        try (Cursor cursor = database.rawQuery(
                "SELECT COUNT(*) FROM meeting_attachment_text_revisions "
                        + "WHERE revision_id = ?",
                new String[]{revisionId})) {
            assertTrue(cursor.moveToFirst());
            return cursor.getInt(0);
        }
    }

    private static int epochRowCount(SQLiteDatabase database, String epochId) {
        try (Cursor cursor = database.rawQuery(
                "SELECT COUNT(*) FROM device_epochs WHERE epoch_id = ?",
                new String[]{epochId})) {
            assertTrue(cursor.moveToFirst());
            return cursor.getInt(0);
        }
    }

    private static long readAttachmentRevisionCreatedAt(
            SQLiteDatabase database, String revisionId) {
        try (Cursor cursor = database.rawQuery(
                "SELECT created_at_ms FROM meeting_attachment_text_revisions "
                        + "WHERE revision_id = ?",
                new String[]{revisionId})) {
            assertTrue("attachment revision fixture is missing", cursor.moveToFirst());
            assertEquals(1, cursor.getCount());
            return cursor.getLong(0);
        }
    }

    private static int countRows(SQLiteDatabase database, String query, String... arguments) {
        try (Cursor cursor = database.rawQuery(query, arguments)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getInt(0);
        }
    }

    private static String scalarString(SQLiteDatabase database, String query) {
        try (Cursor cursor = database.rawQuery(query, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
        }
    }

    private static long scalarLong(SQLiteDatabase database, String query) {
        try (Cursor cursor = database.rawQuery(query, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        }
    }

    private static String readCurrentEpoch(SQLiteDatabase database) {
        try (Cursor cursor = database.rawQuery(
                "SELECT current_epoch_id FROM device_authority_state WHERE singleton_id = 1",
                null)) {
            assertTrue("device authority state is missing", cursor.moveToFirst());
            assertEquals(1, cursor.getCount());
            return cursor.getString(0);
        }
    }

    private static String readCurrentSummaryVersion(
            SQLiteDatabase database, String meetingId) {
        try (Cursor cursor = database.rawQuery(
                "SELECT current_summary_version_id FROM meeting_notes WHERE id = ?",
                new String[]{meetingId})) {
            assertTrue("meeting fixture target is unavailable", cursor.moveToFirst());
            assertEquals(1, cursor.getCount());
            return cursor.isNull(0) ? null : cursor.getString(0);
        }
    }

    private static String[] readMarkerLines(File marker, int minimumLines) throws Exception {
        final String[] lines = new String(
                Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8).split("\\R");
        assertTrue("fault marker is malformed", lines.length >= minimumLines);
        return lines;
    }

    private static String readMeetingScope(SQLiteDatabase database, String meetingId) {
        try (Cursor cursor = database.rawQuery(
                "SELECT scope_key FROM meeting_notes WHERE id = ? AND lifecycle <> 'deleted'",
                new String[]{meetingId})) {
            assertTrue("meeting fixture target is unavailable", cursor.moveToFirst());
            assertEquals(1, cursor.getCount());
            return cursor.getString(0);
        }
    }

    private static long readAttachmentUpdatedAt(
            SQLiteDatabase database, String meetingId, String attachmentId) {
        try (Cursor cursor = database.rawQuery(
                "SELECT updated_at_ms FROM meeting_attachments "
                        + "WHERE id = ? AND meeting_id = ? AND kind = 'text'",
                new String[]{attachmentId, meetingId})) {
            assertTrue("text attachment fixture is missing", cursor.moveToFirst());
            assertEquals(1, cursor.getCount());
            return cursor.getLong(0);
        }
    }

    private static String readAttachmentText(
            SQLiteDatabase database, String meetingId, String attachmentId) {
        try (Cursor cursor = database.rawQuery(
                "SELECT text_content FROM meeting_attachments "
                        + "WHERE id = ? AND meeting_id = ? AND kind = 'text'",
                new String[]{attachmentId, meetingId})) {
            assertTrue("text attachment fixture is missing", cursor.moveToFirst());
            assertEquals(1, cursor.getCount());
            return cursor.getString(0);
        }
    }

    private static AttachmentState readAttachment(
            SQLiteDatabase database, String meetingId, String attachmentId) {
        try (Cursor cursor = database.rawQuery(
                "SELECT scope_key, marker_id, position_ms, text_content, created_at_ms, "
                        + "updated_at_ms, active_text_revision_id FROM meeting_attachments "
                        + "WHERE id = ? AND meeting_id = ? AND kind = 'text'",
                new String[]{attachmentId, meetingId})) {
            assertTrue("text attachment fixture is missing", cursor.moveToFirst());
            assertEquals(1, cursor.getCount());
            return new AttachmentState(
                    cursor.getString(0), cursor.getString(1), cursor.getLong(2),
                    cursor.getString(3), cursor.getLong(4), cursor.getLong(5),
                    cursor.getString(6));
        }
    }

    private static BindingState readBinding(SQLiteDatabase database, String meetingId) {
        try (Cursor cursor = database.rawQuery(
            "SELECT binding_revision, state, device_epoch_id FROM meeting_service_bindings "
                    + "WHERE meeting_id = ?",
                new String[]{meetingId})) {
            assertTrue("meeting binding is missing", cursor.moveToFirst());
            assertEquals("duplicate meeting binding", 1, cursor.getCount());
            return new BindingState(cursor.getLong(0), cursor.getString(1), cursor.getString(2));
        }
    }

    private static final class AttachmentState {
        final String scopeKey;
        final String markerId;
        final long positionMs;
        final String textContent;
        final long createdAtMs;
        final long updatedAtMs;
        final String activeRevisionId;

        AttachmentState(
                String scopeKey, String markerId, long positionMs, String textContent,
                long createdAtMs, long updatedAtMs, String activeRevisionId) {
            this.scopeKey = scopeKey;
            this.markerId = markerId;
            this.positionMs = positionMs;
            this.textContent = textContent;
            this.createdAtMs = createdAtMs;
            this.updatedAtMs = updatedAtMs;
            this.activeRevisionId = activeRevisionId;
        }
    }

    private static final class BindingState {
        final long revision;
        final String state;
        final String deviceEpochId;

        BindingState(long revision, String state, String deviceEpochId) {
            this.revision = revision;
            this.state = state;
            this.deviceEpochId = deviceEpochId;
        }
    }
}
