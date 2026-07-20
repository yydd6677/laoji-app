package com.laoji.nativeplatform.ui

import java.util.Locale

/**
 * User-facing native copy must not expose transport or provider wording.
 * Keep this boundary limited to UI status/error messages; meeting content is
 * deliberately passed through unchanged elsewhere.
 */
object NativeUserMessages {
  private val chinesePattern = Regex("[\\u3400-\\u9fff]")
  private val latinPattern = Regex("[A-Za-z]")

  fun readable(raw: String?, fallback: String): String {
    val message = raw?.trim().orEmpty()
    if (message.isBlank()) return fallback
    val cleaned = stripHttpPrefix(message)
    val normalized = cleaned.lowercase(Locale.ROOT)
    return when {
      normalized.contains("network request failed") ||
        normalized.contains("failed to fetch") ||
        normalized.contains("connection refused") -> "暂时无法连接老记服务，请检查网络后重试。"
      normalized.contains("timeout") || normalized.contains("timed out") -> "请求超时，请稍后重试。"
      normalized.contains("401") || normalized.contains("unauthorized") || normalized.contains("token") -> "登录已过期，请重新登录。"
      normalized.contains("permission") || normalized.contains("microphone") || normalized.contains("recording") ->
        "录音暂时不可用，请稍后重试。"
      normalized.contains("parse") || normalized.contains("schedule") -> "日程解析失败，请检查输入后重试。"
      normalized.contains("audio") || normalized.contains("play") -> "音频暂时无法播放，请稍后重试。"
      normalized.contains("server") || normalized.contains("500") || normalized.contains("502") || normalized.contains("503") ->
        "老记服务暂时不可用，请稍后重试。"
      chinesePattern.containsMatchIn(cleaned) && !latinPattern.containsMatchIn(cleaned) -> cleaned.ifBlank { fallback }
      else -> fallback
    }
  }

  private fun stripHttpPrefix(message: String): String =
    message.replace(Regex("^[^:]+:\\s*\\d{3}\\s*"), "").trim()
}
