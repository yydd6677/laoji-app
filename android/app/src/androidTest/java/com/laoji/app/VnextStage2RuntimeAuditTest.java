package com.laoji.app;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Read-only Stage 2 audit over state produced by a real candidate APK replay.
 *
 * <p>The replay titles are supplied as instrumentation arguments. This keeps
 * evaluation media and text out of product and test source while allowing the
 * test APK to inspect the shipping application's private SQLite owner.</p>
 */
@RunWith(AndroidJUnit4.class)
public final class VnextStage2RuntimeAuditTest {
    private static final String DATABASE_RELATIVE_PATH = "SQLite/laoji-meeting-memory.db";

    @Test
    public void recoveredUploadHasOneDurableOwnerAndOneStableProjection() {
        final String title = requiredArgument("recovered_title");
        try (SQLiteDatabase database = openReadOnlyDatabase()) {
            final String meetingId = uniqueMeetingId(database, title);
            assertEquals(1, count(database,
                    "SELECT COUNT(*) FROM recording_assets WHERE meeting_id = ?",
                    meetingId));

            final String[] asset = oneRow(database,
                    "SELECT id, asset_generation, source_sha256, remote_asset_id, "
                            + "CAST(remote_object_revision AS TEXT), upload_operation_id "
                            + "FROM recording_assets WHERE meeting_id = ?",
                    meetingId);
            assertTrue(asset[0].length() > 0);
            assertTrue(asset[1].matches("[0-9a-f]{32}"));
            assertTrue(asset[2].matches("sha256:[0-9a-f]{64}"));
            assertTrue(asset[3].length() > 0);
            assertTrue(Integer.parseInt(asset[4]) >= 1);
            assertTrue(asset[5].length() > 0);

            final String[] operation = oneRow(database,
                    "SELECT capability, entity_id, generation_id, remote_state, "
                            + "COALESCE(executor_kind, ''), COALESCE(executor_id, '') "
                            + "FROM device_operations WHERE operation_id = ?",
                    asset[5]);
            assertEquals("media.upload", operation[0]);
            assertEquals(meetingId, operation[1]);
            assertEquals(asset[1], operation[2]);
            assertEquals("success", operation[3]);
            assertEquals("workmanager", operation[4]);
            assertTrue(operation[5].matches(
                    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"));

            assertEquals(1, count(database,
                    "SELECT COUNT(*) FROM transcript_revisions "
                            + "WHERE meeting_id = ? AND is_active = 1 AND status = 'ready'",
                    meetingId));
            final String revisionId = scalar(database,
                    "SELECT id FROM transcript_revisions "
                            + "WHERE meeting_id = ? AND is_active = 1 AND status = 'ready'",
                    meetingId);
            final int segments = count(database,
                    "SELECT COUNT(*) FROM transcript_segments WHERE revision_id = ?",
                    revisionId);
            assertTrue("real text projection is empty", segments > 0);
            assertEquals(0, count(database,
                    "SELECT COUNT(*) FROM transcript_segments WHERE revision_id = ? "
                            + "AND (stable_segment_key IS NULL OR length(trim(stable_segment_key)) = 0 "
                            + "OR segment_revision IS NULL OR segment_revision < 1 "
                            + "OR text_state <> 'final')",
                    revisionId));
            assertEquals(0, count(database,
                    "SELECT COUNT(*) FROM (SELECT stable_segment_key FROM transcript_segments "
                            + "WHERE revision_id = ? GROUP BY stable_segment_key HAVING COUNT(*) > 1)",
                    revisionId));
            assertEquals("ready", scalar(database,
                    "SELECT status FROM processing_stages "
                            + "WHERE meeting_id = ? AND stage = 'transcript'",
                    meetingId));
            assertDatabaseIntegrity(database);
            System.out.println("VNEXT_STAGE2_RECOVERY_AUDIT assets=1 operations=1 "
                    + "attempt_owner=workmanager transcript_revisions=1 segments=" + segments
                    + " duplicate_stable_keys=0 integrity=ok foreign_keys=0");
        }
    }

    @Test
    public void noSpeechIsACompletedContentOutcome() {
        final String title = requiredArgument("no_speech_title");
        try (SQLiteDatabase database = openReadOnlyDatabase()) {
            final String meetingId = uniqueMeetingId(database, title);
            assertEquals(1, count(database,
                    "SELECT COUNT(*) FROM recording_assets WHERE meeting_id = ?",
                    meetingId));
            assertEquals(1, count(database,
                    "SELECT COUNT(*) FROM recording_assets asset "
                            + "INNER JOIN device_operations operation "
                            + "ON operation.operation_id = asset.upload_operation_id "
                            + "WHERE asset.meeting_id = ? AND operation.capability = 'media.upload' "
                            + "AND operation.remote_state = 'success'",
                    meetingId));
            final String[] stage = oneRow(database,
                    "SELECT status, COALESCE(error_code, ''), CAST(retryable AS TEXT) "
                            + "FROM processing_stages WHERE meeting_id = ? AND stage = 'transcript'",
                    meetingId);
            assertEquals("no_speech", stage[0]);
            // NO_SPEECH is a successful content outcome, not an error.  The
            // state carries the outcome while error_code intentionally stays
            // empty so legacy failure presentation cannot be reactivated.
            assertEquals("", stage[1]);
            assertEquals("0", stage[2]);
            assertEquals(0, count(database,
                    "SELECT COUNT(*) FROM transcript_segments WHERE meeting_id = ?",
                    meetingId));
            assertDatabaseIntegrity(database);
            System.out.println("VNEXT_STAGE2_NO_SPEECH_AUDIT assets=1 upload_operation=success "
                    + "stage=no_speech retryable=0 segments=0 integrity=ok foreign_keys=0");
        }
    }

    private String requiredArgument(String name) {
        final Bundle arguments = InstrumentationRegistry.getArguments();
        final String value = arguments == null ? null : arguments.getString(name);
        assertNotNull("pass -e " + name + " <exact local meeting title>", value);
        final String normalized = value.trim();
        assertTrue(name + " is empty", !normalized.isEmpty());
        assertTrue(name + " is too long", normalized.length() <= 240);
        return normalized;
    }

    private String uniqueMeetingId(SQLiteDatabase database, String title) {
        assertEquals("runtime replay title is not unique", 1, count(database,
                "SELECT COUNT(*) FROM meeting_notes WHERE scope_key = 'guest' "
                        + "AND lifecycle <> 'deleted' AND title = ?",
                title));
        return scalar(database,
                "SELECT id FROM meeting_notes WHERE scope_key = 'guest' "
                        + "AND lifecycle <> 'deleted' AND title = ?",
                title);
    }

    private SQLiteDatabase openReadOnlyDatabase() {
        final File databaseFile = new File(
                InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir(),
                DATABASE_RELATIVE_PATH);
        assertTrue("candidate meeting database is missing", databaseFile.isFile());
        return SQLiteDatabase.openDatabase(
                databaseFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
    }

    private static String scalar(SQLiteDatabase database, String query, String... arguments) {
        try (Cursor cursor = database.rawQuery(query, arguments)) {
            assertTrue("query returned no row", cursor.moveToFirst());
            final String value = cursor.getString(0);
            assertNotNull("query returned null", value);
            return value;
        }
    }

    private static int count(SQLiteDatabase database, String query, String... arguments) {
        return Integer.parseInt(scalar(database, query, arguments));
    }

    private static String[] oneRow(SQLiteDatabase database, String query, String... arguments) {
        try (Cursor cursor = database.rawQuery(query, arguments)) {
            assertTrue("query returned no row", cursor.moveToFirst());
            final String[] values = new String[cursor.getColumnCount()];
            for (int i = 0; i < cursor.getColumnCount(); i += 1) {
                final String value = cursor.getString(i);
                assertNotNull("query returned null column " + i, value);
                values[i] = value;
            }
            assertTrue("query returned more than one row", !cursor.moveToNext());
            return values;
        }
    }

    private static void assertDatabaseIntegrity(SQLiteDatabase database) {
        assertEquals("ok", scalar(database, "PRAGMA integrity_check"));
        try (Cursor cursor = database.rawQuery("PRAGMA foreign_key_check", null)) {
            assertEquals(0, cursor.getCount());
        }
    }
}
