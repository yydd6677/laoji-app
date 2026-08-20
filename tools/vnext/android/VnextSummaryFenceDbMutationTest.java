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
    private static final String ATTACHMENT_FIXTURE_TEXT =
            "附件围栏验收：最终结果不得覆盖已经变化的会议来源。";

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
    public void testDeleteTextAttachmentFixture() throws Exception {
        final String meetingId = requiredMeetingId();
        final String markerId = fixtureId("marker", meetingId);
        final String attachmentId = fixtureId("attachment", meetingId);
        final String revisionId = "attachment_text:" + attachmentId + ":1";
        assertFalse("restore the injected attachment revision first",
                attachmentRevisionMarkerFile().exists());
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

    private SQLiteDatabase openDatabase() {
        return SQLiteDatabase.openDatabase(
                databaseFile().getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);
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

    private static BindingState readBinding(SQLiteDatabase database, String meetingId) {
        try (Cursor cursor = database.rawQuery(
                "SELECT binding_revision, state FROM meeting_service_bindings WHERE meeting_id = ?",
                new String[]{meetingId})) {
            assertTrue("meeting binding is missing", cursor.moveToFirst());
            assertEquals("duplicate meeting binding", 1, cursor.getCount());
            return new BindingState(cursor.getLong(0), cursor.getString(1));
        }
    }

    private static final class BindingState {
        final long revision;
        final String state;

        BindingState(long revision, String state) {
            this.revision = revision;
            this.state = state;
        }
    }
}
