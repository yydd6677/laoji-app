package com.laoji.nativeplatform.transfer

import org.json.JSONObject

/** Completed upload identity outlives its disposable R2 object. No new task,
 * source, revision or success may be invented from cleanup state alone. */
internal object DeviceV2UploadReceipt {
  fun isCommitted(session: JSONObject, sessionId: String, taskId: String): Boolean {
    if (session.optString("state") !in setOf("verified", "cleanup_pending", "consumed")) return false
    if (session.opt("session_id") != sessionId ||
      session.opt("verified_asset_id") != "asset-revision:$sessionId" ||
      session.opt("transcription_task_id") != taskId) {
      throw TerminalUploadException("invalid-response")
    }
    return true
  }

  fun parse(
    response: JSONObject, sessionId: String, taskId: String,
    assetId: String, generation: String, byteSize: Long, sha256: String,
  ): DeviceV2R2UploadOutcome.Success {
    val asset = response.getJSONObject("verified_asset")
    val task = response.getJSONObject("task")
    val revision = asset.optLong("object_revision", -1L)
    if (response.optInt("schema_version") != 2 ||
      asset.opt("asset_revision_id") != "asset-revision:$sessionId" || revision < 1 ||
      asset.opt("asset_id") != assetId || asset.opt("generation") != generation ||
      asset.optLong("byte_size", -1L) != byteSize || asset.opt("source_sha256") != sha256 ||
      task.opt("task_id") != taskId || task.opt("capability") != "transcript" ||
      task.opt("entity_id") != assetId || task.opt("input_sha256") != sha256) {
      throw TerminalUploadException("invalid-response")
    }
    return DeviceV2R2UploadOutcome.Success("asset-revision:$sessionId", revision, taskId)
  }
}
