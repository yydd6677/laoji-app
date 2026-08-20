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

    @Test
    public void testBumpBindingRevision() throws Exception {
        final String meetingId = requiredMeetingId();
        final File databaseFile = databaseFile();
        assertTrue("candidate meeting database is missing", databaseFile.isFile());

        try (SQLiteDatabase database = SQLiteDatabase.openDatabase(
                databaseFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE)) {
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

        try (SQLiteDatabase database = SQLiteDatabase.openDatabase(
                databaseFile().getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE)) {
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
