package com.laoji.app;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Release-target, emulator-only visual fixture for the Facts V3 rich-block renderer.
 *
 * <p>The fixture temporarily replaces the immutable JSON of one already linked Facts
 * document. It never creates a SummaryVersion, ActionItem, meeting, transcript, or
 * production request. The original JSON is held in a dedicated SQLite backup table;
 * restoration refuses to continue if the current version or document identity changed.
 * Invoke one test method explicitly with AndroidJUnitRunner and always restore after the
 * visual replay.</p>
 */
@RunWith(AndroidJUnit4.class)
public final class VnextSummaryRichBlockFixtureTest {
    private static final String DATABASE_RELATIVE_PATH = "SQLite/laoji-meeting-memory.db";
    private static final String BACKUP_TABLE = "vnext_test_summary_rich_backup";

    @Test
    public void testPrepareSummaryRichBlockFixture() throws Exception {
        try (SQLiteDatabase database = openDatabase()) {
            final String meetingId = requiredMeetingId(database);
            final String currentVersionId = scalarString(database,
                    "SELECT current_summary_version_id FROM meeting_notes "
                            + "WHERE id = ? AND lifecycle <> 'deleted'",
                    meetingId);
            assertNotNull("fixture meeting has no current summary", currentVersionId);
            assertFalse("restore the previous rich-block fixture first",
                    tableExists(database, BACKUP_TABLE));

            final String documentId = scalarString(database,
                    "SELECT id FROM summary_fact_documents "
                            + "WHERE meeting_id = ? AND summary_version_id = ?",
                    meetingId, currentVersionId);
            assertNotNull("current summary is not backed by Facts V3", documentId);
            final String originalJson = scalarString(database,
                    "SELECT document_json FROM summary_fact_documents WHERE id = ?",
                    documentId);
            final JSONObject fixture = buildFixture(new JSONObject(originalJson));
            final JSONObject coverage = fixture.getJSONObject("coverage");

            database.beginTransaction();
            try {
                database.execSQL("CREATE TABLE " + BACKUP_TABLE + " ("
                        + "document_id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, "
                        + "summary_version_id TEXT NOT NULL, document_json TEXT NOT NULL, "
                        + "coverage_json TEXT NOT NULL)");
                database.execSQL("INSERT INTO " + BACKUP_TABLE + " "
                                + "SELECT id, meeting_id, summary_version_id, document_json, coverage_json "
                                + "FROM summary_fact_documents WHERE id = ? AND meeting_id = ? "
                                + "AND summary_version_id = ?",
                        new Object[]{documentId, meetingId, currentVersionId});
                assertEquals("failed to back up the immutable Facts document", 1,
                        countRows(database, "SELECT COUNT(*) FROM " + BACKUP_TABLE));
                database.execSQL("UPDATE summary_fact_documents "
                                + "SET document_json = ?, coverage_json = ? "
                                + "WHERE id = ? AND meeting_id = ? AND summary_version_id = ?",
                        new Object[]{fixture.toString(), coverage.toString(), documentId,
                                meetingId, currentVersionId});
                assertEquals("rich-block fixture did not update exactly one document", 1,
                        countRows(database,
                                "SELECT COUNT(*) FROM summary_fact_documents WHERE id = ? "
                                        + "AND meeting_id = ? AND summary_version_id = ? "
                                        + "AND document_json = ?",
                                documentId, meetingId, currentVersionId, fixture.toString()));
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
            assertDatabaseIntegrity(database);
            System.out.println("VNEXT_SUMMARY_RICH_FIXTURE prepared=true facts=10 relations=3 "
                    + "actions=1 versions_created=0");
        }
    }

    @Test
    public void testAuditSummaryRichBlockFixture() throws Exception {
        try (SQLiteDatabase database = openDatabase()) {
            assertTrue("rich-block fixture is not prepared", tableExists(database, BACKUP_TABLE));
            assertEquals(1, countRows(database, "SELECT COUNT(*) FROM " + BACKUP_TABLE));
            final String documentId = scalarString(database,
                    "SELECT document_id FROM " + BACKUP_TABLE);
            final JSONObject current = new JSONObject(scalarString(database,
                    "SELECT document_json FROM summary_fact_documents WHERE id = ?", documentId));
            final JSONObject facts = current.getJSONObject("facts_document");
            assertEquals(10, facts.getJSONArray("facts").length());
            assertEquals(3, facts.getJSONArray("relations").length());
            assertEquals(1, facts.getJSONArray("action_candidates").length());
            assertTrue(current.toString().contains("明天下午完成12个关键场景回归"));
            assertDatabaseIntegrity(database);
            System.out.println("VNEXT_SUMMARY_RICH_FIXTURE audit=true facts=10 relations=3 actions=1");
        }
    }

    @Test
    public void testRestoreSummaryRichBlockFixture() {
        try (SQLiteDatabase database = openDatabase()) {
            assertTrue("rich-block fixture is not prepared", tableExists(database, BACKUP_TABLE));
            assertEquals(1, countRows(database, "SELECT COUNT(*) FROM " + BACKUP_TABLE));
            final String documentId = scalarString(database,
                    "SELECT document_id FROM " + BACKUP_TABLE);
            final String meetingId = scalarString(database,
                    "SELECT meeting_id FROM " + BACKUP_TABLE);
            final String versionId = scalarString(database,
                    "SELECT summary_version_id FROM " + BACKUP_TABLE);
            assertEquals("current summary changed during visual replay; refusing unsafe restore",
                    versionId,
                    scalarString(database,
                            "SELECT current_summary_version_id FROM meeting_notes WHERE id = ?",
                            meetingId));
            assertEquals("Facts document identity changed during visual replay; refusing unsafe restore",
                    1,
                    countRows(database,
                            "SELECT COUNT(*) FROM summary_fact_documents WHERE id = ? "
                                    + "AND meeting_id = ? AND summary_version_id = ?",
                            documentId, meetingId, versionId));

            database.beginTransaction();
            try {
                database.execSQL("UPDATE summary_fact_documents SET "
                                + "document_json = (SELECT document_json FROM " + BACKUP_TABLE
                                + " WHERE document_id = ?), "
                                + "coverage_json = (SELECT coverage_json FROM " + BACKUP_TABLE
                                + " WHERE document_id = ?) WHERE id = ? AND meeting_id = ? "
                                + "AND summary_version_id = ?",
                        new Object[]{documentId, documentId, documentId, meetingId, versionId});
                database.execSQL("DROP TABLE " + BACKUP_TABLE);
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
            assertFalse("rich-block backup table survived restoration",
                    tableExists(database, BACKUP_TABLE));
            assertDatabaseIntegrity(database);
            System.out.println("VNEXT_SUMMARY_RICH_FIXTURE restored=true versions_created=0");
        }
    }

    private static JSONObject buildFixture(JSONObject original) throws Exception {
        final JSONArray facts = new JSONArray()
                .put(fact("topic", "topic", "confirmed", "讨论移动端候选版本的上线范围"))
                .put(fact("context", "context", "completed", "客户端数据迁移已经完成"))
                .put(fact("conclusion", "conclusion", "confirmed", "回归测试通过率达到95%"))
                .put(fact("risk", "risk", "proposed", "测试环境剩余容量存在风险"))
                .put(fact("question", "question", "uncertain", "需要确认由谁协调扩容资源"))
                .put(fact("quote", "quote", "confirmed", "先保证交付质量，再压缩发布时间"))
                .put(fact("timeline", "timeline", "proposed", "明天下午完成12个关键场景回归"))
                .put(fact("action", "action", "proposed", "产品负责人明天下午提交回归清单"))
                .put(fact("alternative_a", "conclusion", "proposed", "方案一先灰度发布"))
                .put(fact("alternative_b", "conclusion", "proposed", "方案二一次性发布"));
        final JSONArray relations = new JSONArray()
                .put(relation("precedes", "context", "conclusion"))
                .put(relation("precedes", "conclusion", "timeline"))
                .put(relation("alternative", "alternative_a", "alternative_b"));
        final JSONArray actions = new JSONArray().put(new JSONObject()
                .put("action_id", "action1")
                .put("fact_id", "action")
                .put("content", "产品负责人明天下午提交回归清单")
                .put("owner", "产品负责人")
                .put("due_text", "明天下午")
                .put("schedule_fit", "high")
                .put("evidence_score", 1.0));
        final JSONObject factsDocument = new JSONObject()
                .put("schema_version", 3)
                .put("overview", new JSONObject()
                        .put("text", "会议确认了上线范围、完成进展、风险和下一步回归安排。")
                        .put("fact_ids", new JSONArray().put("topic").put("conclusion")))
                .put("facts", facts)
                .put("relations", relations)
                .put("action_candidates", actions);
        original.put("facts_document", factsDocument);
        return original;
    }

    private static JSONObject fact(
            String id, String type, String certainty, String content) throws Exception {
        final JSONObject source = new JSONObject()
                .put("source_id", "manual-note:rich-block:" + id)
                .put("source_type", "manual_note")
                .put("quote", content)
                .put("content_hash", sha256Text(content))
                .put("start_ms", JSONObject.NULL)
                .put("end_ms", JSONObject.NULL)
                .put("speaker", JSONObject.NULL);
        return new JSONObject()
                .put("fact_id", id)
                .put("fact_type", type)
                .put("certainty", certainty)
                .put("content", content)
                .put("evidence_score", 1.0)
                .put("conflict_group_id", JSONObject.NULL)
                .put("sources", new JSONArray().put(source));
    }

    private static JSONObject relation(String type, String from, String to) throws Exception {
        return new JSONObject()
                .put("relation_type", type)
                .put("from_fact_id", from)
                .put("to_fact_id", to);
    }

    private static String sha256Text(String value) throws Exception {
        final byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
        final StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte item : digest) hex.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return "sha256:" + hex;
    }

    private static void assertDatabaseIntegrity(SQLiteDatabase database) {
        assertEquals("ok", scalarString(database, "PRAGMA integrity_check"));
        try (Cursor cursor = database.rawQuery("PRAGMA foreign_key_check", null)) {
            assertEquals(0, cursor.getCount());
        }
    }

    private String requiredMeetingId(SQLiteDatabase database) {
        final Bundle arguments = InstrumentationRegistry.getArguments();
        final String direct = arguments == null ? null : arguments.getString("meeting_id");
        if (direct != null && !direct.trim().isEmpty()) {
            final String normalized = direct.trim();
            assertTrue("meeting_id contains unsupported characters",
                    normalized.matches("[A-Za-z0-9:._-]{1,160}"));
            return normalized;
        }
        final String title = arguments == null ? null : arguments.getString("meeting_title");
        assertNotNull("pass -e meeting_id ID or -e meeting_title TITLE", title);
        try (Cursor cursor = database.rawQuery(
                "SELECT id FROM meeting_notes WHERE title = ? AND lifecycle <> 'deleted'",
                new String[]{title})) {
            assertTrue("fixture meeting title is unavailable", cursor.moveToFirst());
            final String id = cursor.getString(0);
            assertFalse("fixture meeting title is ambiguous", cursor.moveToNext());
            return id;
        }
    }

    private File databaseFile() {
        return new File(
                InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir(),
                DATABASE_RELATIVE_PATH);
    }

    private SQLiteDatabase openDatabase() {
        final SQLiteDatabase database = SQLiteDatabase.openDatabase(
                databaseFile().getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);
        database.setForeignKeyConstraintsEnabled(true);
        return database;
    }

    private static boolean tableExists(SQLiteDatabase database, String name) {
        return countRows(database,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
                name) == 1;
    }

    private static int countRows(SQLiteDatabase database, String sql, String... arguments) {
        try (Cursor cursor = database.rawQuery(sql, arguments)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getInt(0);
        }
    }

    private static String scalarString(SQLiteDatabase database, String sql, String... arguments) {
        try (Cursor cursor = database.rawQuery(sql, arguments)) {
            assertTrue("query returned no row", cursor.moveToFirst());
            assertEquals("query returned more than one row", 1, cursor.getCount());
            return cursor.isNull(0) ? null : cursor.getString(0);
        }
    }
}
