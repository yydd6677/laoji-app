package com.laoji.nativeplatform.hardware

/** Notification identity is the visible operation, not every byte/progress event. */
internal object HardwareConnectionNoticePolicy {
  fun text(phase: String, purpose: String? = null): String = if (purpose == "schedule" && phase in setOf("recording","paused","finalizing")) when (phase) {
    "recording" -> "正在录入日程"
    "paused" -> "日程录音已暂停"
    else -> "正在保存日程录音"
  } else when (phase) {
    "recording" -> "正在录音"
    "paused" -> "录音已暂停"
    "transferring" -> "正在接收录音"
    "finalizing" -> "正在保存录音"
    else -> "已连接"
  }
  fun needsWake(phase: String): Boolean = phase in setOf("recording", "paused", "finalizing", "transferring")
  fun renewWake(held: Boolean, nowMs: Long, lastRenewedMs: Long): Boolean =
    !held || nowMs - lastRenewedMs >= 5 * 60_000L
}
