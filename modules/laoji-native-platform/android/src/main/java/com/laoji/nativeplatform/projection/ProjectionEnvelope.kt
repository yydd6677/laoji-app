package com.laoji.nativeplatform.projection

/** Cross-surface revision fence for native snapshots and gestures. */
data class ProjectionEnvelope(
  val deviceEpoch: String,
  val entityId: String,
  val entityRevision: Long,
  val viewRevision: Long,
  val surfaceInstanceId: String,
  val payloadSha256: String,
) {
  /** A live native host may only advance within one entity/surface lineage. */
  fun isAcceptableReplacement(current: ProjectionEnvelope?): Boolean {
    if (current == null) return true
    if (deviceEpoch != current.deviceEpoch || entityId != current.entityId) return false
    if (surfaceInstanceId != current.surfaceInstanceId) return false
    val revision = compareRevision(this, current)
    return revision > 0 || (revision == 0 && payloadSha256 == current.payloadSha256)
  }

  fun sameIdentity(other: ProjectionEnvelope?): Boolean = other != null
    && deviceEpoch == other.deviceEpoch
    && entityId == other.entityId
    && entityRevision == other.entityRevision
    && viewRevision == other.viewRevision
    && surfaceInstanceId == other.surfaceInstanceId
    && payloadSha256 == other.payloadSha256

  // Kept for callers of the initial candidate contract.
  fun isNewerThan(current: ProjectionEnvelope?): Boolean = isAcceptableReplacement(current)

  companion object {
    private fun compareRevision(left: ProjectionEnvelope, right: ProjectionEnvelope): Int {
      val entity = left.entityRevision.compareTo(right.entityRevision)
      return if (entity != 0) entity else left.viewRevision.compareTo(right.viewRevision)
    }

    fun fromMap(raw: Map<String, Any?>?): ProjectionEnvelope? {
      if (raw == null) return null
      val deviceEpoch = raw["deviceEpoch"] as? String ?: return null
      val entityId = raw["entityId"] as? String ?: return null
      val entityRevisionValue = raw["entityRevision"] as? Number ?: return null
      val viewRevisionValue = raw["viewRevision"] as? Number ?: return null
      val entityRevision = entityRevisionValue.toLong()
      val viewRevision = viewRevisionValue.toLong()
      val surfaceInstanceId = raw["surfaceInstanceId"] as? String ?: return null
      val payloadSha256 = raw["payloadSha256"] as? String ?: return null
      val revisionsAreIntegral = entityRevisionValue.toDouble().isFinite()
        && viewRevisionValue.toDouble().isFinite()
        && entityRevisionValue.toDouble() == entityRevision.toDouble()
        && viewRevisionValue.toDouble() == viewRevision.toDouble()
      if (
        deviceEpoch.isBlank() || entityId.isBlank() || surfaceInstanceId.isBlank()
        || deviceEpoch.length > 128 || entityId.length > 256 || surfaceInstanceId.length > 128
        || !revisionsAreIntegral || entityRevision < 1 || viewRevision < 1
        || !Regex("^sha256:[0-9a-f]{64}$").matches(payloadSha256)
      ) return null
      return ProjectionEnvelope(
        deviceEpoch,
        entityId,
        entityRevision,
        viewRevision,
        surfaceInstanceId,
        payloadSha256,
      )
    }
  }
}
