package com.laoji.nativeplatform.audio

// MIN-AUDIO-001 / MIN-REC-STATE-001: recorder state and WAV contracts are pure Kotlin.

import android.media.MediaRecorder
import kotlinx.coroutines.flow.StateFlow
import java.net.URI
import java.util.Locale

object AudioRuntimeContract {
  const val SAMPLE_RATE_HZ = 16_000
  const val CHANNEL_COUNT = 1
  const val BITS_PER_SAMPLE = 16
  const val BYTES_PER_SAMPLE = 2
  const val BYTES_PER_SECOND = SAMPLE_RATE_HZ * CHANNEL_COUNT * BYTES_PER_SAMPLE
  const val FRAME_BYTES = 3_200
  const val WAV_HEADER_BYTES = 44
  const val MAX_PCM_BYTES = 1_000_000_000L
  const val JOURNAL_SCHEMA_VERSION = 1
  const val DEFAULT_CONNECTION_TIMEOUT_MS = 8_000L
  const val DEFAULT_STOP_TIMEOUT_MS = 10_000L
  const val DEFAULT_LEVEL_INTERVAL_MS = 100L
}

enum class AudioPurpose(val wireValue: String, val audioSource: Int) {
  SCHEDULE("schedule", MediaRecorder.AudioSource.VOICE_RECOGNITION),
  MEETING("meeting", MediaRecorder.AudioSource.VOICE_COMMUNICATION),
  // Enrollment and inference must use the same device-side audio processing domain.
  SPEAKER("speaker", MediaRecorder.AudioSource.VOICE_COMMUNICATION);

  companion object {
    fun fromWireValue(value: String): AudioPurpose = entries.firstOrNull { it.wireValue == value }
      ?: throw RecorderRuntimeException(
        RecorderErrorCode.INVALID_OPTIONS,
        "purpose must be schedule, meeting, or speaker",
      )
  }
}

enum class RecorderMode(val wireValue: String) {
  REALTIME("realtime"),
  LOCAL_ONLY("localOnly");

  companion object {
    fun fromWireValue(value: String): RecorderMode = entries.firstOrNull { it.wireValue == value }
      ?: throw RecorderRuntimeException(RecorderErrorCode.INVALID_OPTIONS, "invalid recorder mode")
  }
}

enum class RecorderState(val wireValue: String) {
  IDLE("idle"),
  PREPARING("preparing"),
  RECORDING("recording"),
  PAUSED("paused"),
  STOPPING("stopping"),
  LOCAL_SAVED("localSaved"),
  FAILED("failed"),
}

enum class RecorderErrorCode(val wireValue: String) {
  INVALID_OPTIONS("invalid_options"),
  SESSION_BUSY("session_busy"),
  SESSION_MISMATCH("session_mismatch"),
  PERMISSION_DENIED("permission_denied"),
  SERVICE_UNAVAILABLE("service_unavailable"),
  AUDIO_UNAVAILABLE("audio_unavailable"),
  AUDIO_READ_FAILED("audio_read_failed"),
  STORAGE_FAILED("storage_failed"),
  STORAGE_LIMIT("storage_limit"),
  WEBSOCKET_CONNECT_FAILED("websocket_connect_failed"),
  WEBSOCKET_DISCONNECTED("websocket_disconnected"),
  WEBSOCKET_SEND_FAILED("websocket_send_failed"),
  SERVER_ERROR("server_error"),
  READY_TO_STOP_TIMEOUT("ready_to_stop_timeout"),
  RECOVERY_FAILED("recovery_failed"),
}

class RecorderRuntimeException(
  val errorCode: RecorderErrorCode,
  override val message: String,
) : Exception(message)

class RecorderCredentials private constructor(
  val headerName: String,
  internal val headerValue: String,
) {
  override fun toString(): String = "RecorderCredentials(headerName=$headerName, headerValue=[REDACTED])"

  companion object {
    fun create(accessToken: String?, guestToken: String?): RecorderCredentials {
      val access = normalizeToken(accessToken)
      val guest = normalizeToken(guestToken)
      if ((access == null) == (guest == null)) {
        throw RecorderRuntimeException(
          RecorderErrorCode.INVALID_OPTIONS,
          "exactly one of accessToken or guestToken is required",
        )
      }
      return if (access != null) {
        RecorderCredentials("Authorization", "Bearer $access")
      } else {
        RecorderCredentials("X-Guest-Session-Token", requireNotNull(guest))
      }
    }

    private fun normalizeToken(value: String?): String? {
      val token = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
      if (token.any { it == '\r' || it == '\n' }) {
        throw RecorderRuntimeException(RecorderErrorCode.INVALID_OPTIONS, "invalid authentication token")
      }
      return token
    }
  }
}

class RecorderStartConfig(
  val sessionId: String,
  val purpose: AudioPurpose,
  val mode: RecorderMode,
  val websocketUrl: String?,
  val credentials: RecorderCredentials?,
  val allowInsecureDevelopment: Boolean,
  val connectionTimeoutMs: Long,
  val stopTimeoutMs: Long,
  val levelIntervalMs: Long,
) {
  override fun toString(): String =
    "RecorderStartConfig(sessionId=$sessionId, purpose=${purpose.wireValue}, mode=${mode.wireValue}, " +
      "websocketUrl=[REDACTED], " +
      "credentials=$credentials, allowInsecureDevelopment=$allowInsecureDevelopment, " +
      "connectionTimeoutMs=$connectionTimeoutMs, " +
      "stopTimeoutMs=$stopTimeoutMs, levelIntervalMs=$levelIntervalMs)"

  companion object {
    fun create(
      sessionId: String,
      purpose: String,
      websocketUrl: String,
      accessToken: String?,
      guestToken: String?,
      allowInsecureDevelopment: Boolean = false,
      connectionTimeoutMs: Double?,
      stopTimeoutMs: Double?,
      levelIntervalMs: Double?,
    ): RecorderStartConfig {
      val normalizedSessionId = validateSessionId(sessionId)
      val normalizedPurpose = AudioPurpose.fromWireValue(purpose)
      if (normalizedPurpose == AudioPurpose.SPEAKER) {
        throw RecorderRuntimeException(
          RecorderErrorCode.INVALID_OPTIONS,
          "realtime purpose must be schedule or meeting",
        )
      }
      return RecorderStartConfig(
        sessionId = normalizedSessionId,
        purpose = normalizedPurpose,
        mode = RecorderMode.REALTIME,
        websocketUrl = validateWebSocketUrl(websocketUrl, allowInsecureDevelopment),
        credentials = RecorderCredentials.create(accessToken, guestToken),
        allowInsecureDevelopment = allowInsecureDevelopment,
        connectionTimeoutMs = boundedMilliseconds(
          connectionTimeoutMs,
          AudioRuntimeContract.DEFAULT_CONNECTION_TIMEOUT_MS,
          1_000L,
          60_000L,
          "connectionTimeoutMs",
        ),
        stopTimeoutMs = boundedMilliseconds(
          stopTimeoutMs,
          AudioRuntimeContract.DEFAULT_STOP_TIMEOUT_MS,
          1_000L,
          120_000L,
          "stopTimeoutMs",
        ),
        levelIntervalMs = boundedMilliseconds(
          levelIntervalMs,
          AudioRuntimeContract.DEFAULT_LEVEL_INTERVAL_MS,
          50L,
          1_000L,
          "levelIntervalMs",
        ),
      )
    }

    fun createLocal(
      sessionId: String,
      levelIntervalMs: Double?,
    ): RecorderStartConfig = RecorderStartConfig(
      sessionId = validateSessionId(sessionId),
      purpose = AudioPurpose.SPEAKER,
      mode = RecorderMode.LOCAL_ONLY,
      websocketUrl = null,
      credentials = null,
      allowInsecureDevelopment = false,
      connectionTimeoutMs = AudioRuntimeContract.DEFAULT_CONNECTION_TIMEOUT_MS,
      stopTimeoutMs = AudioRuntimeContract.DEFAULT_STOP_TIMEOUT_MS,
      levelIntervalMs = boundedMilliseconds(
        levelIntervalMs,
        AudioRuntimeContract.DEFAULT_LEVEL_INTERVAL_MS,
        50L,
        1_000L,
        "levelIntervalMs",
      ),
    )

    fun validateSessionId(value: String): String {
      val sessionId = value.trim()
      if (sessionId.isEmpty() || sessionId.length > 160 || sessionId.any { it.isISOControl() }) {
        throw RecorderRuntimeException(RecorderErrorCode.INVALID_OPTIONS, "invalid sessionId")
      }
      return sessionId
    }

    fun safeFileStem(sessionId: String): String {
      val normalized = sessionId
        .lowercase(Locale.ROOT)
        .replace(Regex("[^a-z0-9_-]+"), "_")
        .trim('_')
        .take(64)
      return normalized.ifEmpty { "laoji-recording" }
    }

    fun validateWebSocketUrl(value: String, allowInsecureDevelopment: Boolean = false): String {
      val raw = value.trim()
      val uri = try {
        URI(raw)
      } catch (_: Exception) {
        throw RecorderRuntimeException(RecorderErrorCode.INVALID_OPTIONS, "invalid websocketUrl")
      }
      val scheme = uri.scheme?.lowercase(Locale.ROOT)
      val allowedScheme = scheme == "wss" || (scheme == "ws" && allowInsecureDevelopment)
      if (
        !allowedScheme ||
        uri.host.isNullOrBlank() ||
        uri.userInfo != null ||
        uri.fragment != null ||
        uri.rawQuery != null
      ) {
        throw RecorderRuntimeException(
          RecorderErrorCode.INVALID_OPTIONS,
          if (allowInsecureDevelopment) {
            "websocketUrl must be ws or wss without userinfo, query, or fragment"
          } else {
            "websocketUrl must be wss without userinfo, query, or fragment"
          },
        )
      }
      return uri.normalize().toASCIIString()
    }

    private fun boundedMilliseconds(
      value: Double?,
      defaultValue: Long,
      minimum: Long,
      maximum: Long,
      fieldName: String,
    ): Long {
      if (value == null) return defaultValue
      if (!value.isFinite() || value % 1.0 != 0.0 || value < minimum || value > maximum) {
        throw RecorderRuntimeException(
          RecorderErrorCode.INVALID_OPTIONS,
          "$fieldName must be an integer between $minimum and $maximum",
        )
      }
      return value.toLong()
    }
  }
}

object RecorderStateMachine {
  private val transitions = mapOf(
    RecorderState.IDLE to setOf(RecorderState.PREPARING),
    RecorderState.PREPARING to setOf(RecorderState.RECORDING, RecorderState.STOPPING, RecorderState.FAILED),
    RecorderState.RECORDING to setOf(RecorderState.PAUSED, RecorderState.STOPPING, RecorderState.FAILED),
    RecorderState.PAUSED to setOf(RecorderState.RECORDING, RecorderState.STOPPING, RecorderState.FAILED),
    RecorderState.STOPPING to setOf(RecorderState.LOCAL_SAVED, RecorderState.FAILED),
    RecorderState.LOCAL_SAVED to setOf(RecorderState.FAILED),
    RecorderState.FAILED to emptySet(),
  )

  fun canTransition(from: RecorderState, to: RecorderState): Boolean =
    from == to || transitions[from].orEmpty().contains(to)
}

data class RecorderSnapshot(
  val sessionId: String,
  val purpose: AudioPurpose,
  val mode: RecorderMode,
  val state: RecorderState,
  val startedAtMs: Long,
  val updatedAtMs: Long,
  val bytesRecorded: Long,
  val localUri: String?,
  val asrConnected: Boolean,
  val readyToStop: Boolean,
  val transcriptRecoveryRequired: Boolean,
  val errorCode: RecorderErrorCode?,
  val errorMessage: String?,
) {
  val asrRequired: Boolean
    get() = mode == RecorderMode.REALTIME

  val durationMs: Long
    get() = bytesRecorded * 1_000L / AudioRuntimeContract.BYTES_PER_SECOND

  fun toMap(): Map<String, Any?> = mapOf(
    "sessionId" to sessionId,
    "purpose" to purpose.wireValue,
    "mode" to mode.wireValue,
    "state" to state.wireValue,
    "startedAtMs" to startedAtMs.toDouble(),
    "updatedAtMs" to updatedAtMs.toDouble(),
    "bytesRecorded" to bytesRecorded.toDouble(),
    "durationMs" to durationMs.toDouble(),
    "localUri" to localUri,
    "asrConnected" to asrConnected,
    "asrRequired" to asrRequired,
    "readyToStop" to readyToStop,
    "transcriptRecoveryRequired" to transcriptRecoveryRequired,
    "errorCode" to errorCode?.wireValue,
    "errorMessage" to errorMessage,
  )
}

data class RecorderLevelFrame(
  val sessionId: String,
  val sequence: Long,
  val normalized: Float,
  val peak: Int,
  val rms: Int,
  val durationMs: Long,
  val capturedAtElapsedMs: Long,
)

interface RecorderLevelSource {
  fun observe(sessionId: String): StateFlow<RecorderLevelFrame?>
  fun latest(sessionId: String): RecorderLevelFrame?
}

data class RecorderStopResult(
  val snapshot: RecorderSnapshot,
  val localSaved: Boolean,
  val readyToStop: Boolean,
  val errorCode: RecorderErrorCode?,
  val errorMessage: String?,
  val audioBars: List<Float> = emptyList(),
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "status" to if (
      localSaved && (!snapshot.asrRequired || readyToStop) && errorCode == null
    ) "completed" else "failed",
    "localSaved" to localSaved,
    "readyToStop" to readyToStop,
    "localUri" to snapshot.localUri,
    "errorCode" to errorCode?.wireValue,
    "errorMessage" to errorMessage,
    "audioBars" to audioBars.map(Float::toDouble),
    "snapshot" to snapshot.toMap(),
  )
}
