package com.laoji.nativeplatform.transfer

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeviceV2UploadReceiptTest {
  private val sessionId = "v2-upload-test"
  private val taskId = "v2-transcript-test"
  private val sha = "sha256:" + "a".repeat(64)
  private fun session(state: String) = JSONObject().put("state", state).put("session_id", sessionId)
    .put("verified_asset_id", "asset-revision:$sessionId").put("transcription_task_id", taskId)
  private fun receipt() = JSONObject().put("schema_version", 2)
    .put("verified_asset", JSONObject().put("asset_revision_id", "asset-revision:$sessionId")
      .put("object_revision", 7).put("asset_id", "source").put("generation", "generation")
      .put("byte_size", 1024).put("source_sha256", sha))
    .put("task", JSONObject().put("task_id", taskId).put("capability", "transcript")
      .put("entity_id", "source").put("input_sha256", sha))
  private fun parse(response: JSONObject) = DeviceV2UploadReceipt.parse(response, sessionId, taskId,
    "source", "generation", 1024, sha)
  private fun rejected(action: () -> Unit) {
    try { action(); fail("Invalid receipt must not produce upload success") }
    catch (error: TerminalUploadException) { assertEquals("invalid-response", error.reason) }
  }

  @Test fun verifiedPendingAndConsumedReceiptsAllUseTheSameCompletionPath() {
    for (state in listOf("verified", "cleanup_pending", "consumed")) {
      assertTrue(DeviceV2UploadReceipt.isCommitted(session(state), sessionId, taskId))
    }
  }
  @Test fun activeIncompleteAndCancelledSessionsDoNotInventAReceipt() {
    for (state in listOf("active", "completing", "provisioning", "cancelled", "expired")) {
      assertFalse(DeviceV2UploadReceipt.isCommitted(session(state), sessionId, taskId))
    }
  }
  @Test fun cleanupWithoutVerifiedIdentityIsNotSuccess() {
    for (field in listOf("session_id", "verified_asset_id", "transcription_task_id")) {
      rejected { DeviceV2UploadReceipt.isCommitted(session("cleanup_pending").put(field, JSONObject.NULL), sessionId, taskId) }
      rejected { DeviceV2UploadReceipt.isCommitted(session("cleanup_pending").put(field, "other"), sessionId, taskId) }
    }
  }
  @Test fun theRealServerObjectRevisionIsPreservedWithoutGuessingOne() {
    val parsed = parse(receipt())
    assertEquals(7L, parsed.objectRevision); assertEquals("asset-revision:$sessionId", parsed.assetRevisionId)
    assertEquals(taskId, parsed.transcriptionTaskId)
  }
  @Test fun differentAssetGenerationHashOrSizeCannotBeAccepted() {
    for ((field, value) in listOf("asset_revision_id" to "other", "asset_id" to "other",
      "generation" to "other", "source_sha256" to "sha256:${"b".repeat(64)}", "byte_size" to 1025,
      "object_revision" to 0)) {
      val changed = receipt(); changed.getJSONObject("verified_asset").put(field, value)
      rejected { parse(changed) }
    }
  }
  @Test fun taskIdentityScopeAndInputCannotBeTakenFromAnotherOperation() {
    for (field in listOf("task_id", "capability", "entity_id", "input_sha256")) {
      val changed = receipt(); changed.getJSONObject("task").put(field, "other")
      rejected { parse(changed) }
    }
  }
  @Test fun aDifferentContractNeverBecomesAnUploadSuccess() {
    rejected { parse(receipt().put("schema_version", 1)) }
  }
}
