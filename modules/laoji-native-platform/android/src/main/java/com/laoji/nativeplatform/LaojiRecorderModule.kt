package com.laoji.nativeplatform

// MIN-AUDIO-001 / MIN-REC-STATE-001: semantic recorder commands never expose PCM to JavaScript.

import android.content.Context
import com.laoji.nativeplatform.audio.AudioRuntimeContract
import com.laoji.nativeplatform.audio.RecorderErrorCode
import com.laoji.nativeplatform.audio.RecorderEventBus
import com.laoji.nativeplatform.audio.RecorderEventListener
import com.laoji.nativeplatform.audio.RecorderEvents
import com.laoji.nativeplatform.audio.RecorderRecovery
import com.laoji.nativeplatform.audio.RecorderRuntimeException
import com.laoji.nativeplatform.audio.RecorderServiceClient
import com.laoji.nativeplatform.audio.RecorderStartConfig
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.Locale
import java.util.concurrent.CompletableFuture

class RecorderStartOptions : Record {
  @Field
  var sessionId: String = ""

  @Field
  var purpose: String = "meeting"

  @Field
  var websocketUrl: String = ""

  @Field
  var accessToken: String? = null

  @Field
  var guestToken: String? = null

  @Field
  var allowInsecureDevelopment: Boolean = false

  @Field
  var connectionTimeoutMs: Double? = null

  @Field
  var stopTimeoutMs: Double? = null

  @Field
  var levelIntervalMs: Double? = null

  fun toConfig(): RecorderStartConfig = RecorderStartConfig.create(
    sessionId = sessionId,
    purpose = purpose,
    websocketUrl = websocketUrl,
    accessToken = accessToken,
    guestToken = guestToken,
    allowInsecureDevelopment = allowInsecureDevelopment,
    connectionTimeoutMs = connectionTimeoutMs,
    stopTimeoutMs = stopTimeoutMs,
    levelIntervalMs = levelIntervalMs,
  )

  override fun toString(): String =
    "RecorderStartOptions(sessionId=$sessionId, purpose=$purpose, websocketUrl=[REDACTED], " +
      "accessToken=[REDACTED], guestToken=[REDACTED], " +
      "allowInsecureDevelopment=$allowInsecureDevelopment, connectionTimeoutMs=$connectionTimeoutMs, " +
      "stopTimeoutMs=$stopTimeoutMs, levelIntervalMs=$levelIntervalMs)"
}

class LaojiRecorderModule : Module() {
  private val recorderEventListener = RecorderEventListener { name, body -> sendEvent(name, body) }

  override fun definition() = ModuleDefinition {
    Name("LaojiRecorder")

    Events(RecorderEvents.all)

    Constant("audioFormat") {
      mapOf(
        "sampleRateHz" to AudioRuntimeContract.SAMPLE_RATE_HZ,
        "channelCount" to AudioRuntimeContract.CHANNEL_COUNT,
        "bitsPerSample" to AudioRuntimeContract.BITS_PER_SAMPLE,
        "frameBytes" to AudioRuntimeContract.FRAME_BYTES,
      )
    }

    OnCreate {
      RecorderEventBus.addListener(recorderEventListener)
      appContext.reactContext?.applicationContext?.let { context ->
        RecorderRecovery.recover(context, RecorderServiceClient.currentSessionId())
      }
    }

    OnDestroy {
      RecorderEventBus.removeListener(recorderEventListener)
    }

    AsyncFunction("start") { options: RecorderStartOptions, promise: Promise ->
      try {
        settle(
          RecorderServiceClient.start(requireContext(), options.toConfig()),
          promise,
        ) { snapshot -> snapshot.toMap() }
      } catch (error: Exception) {
        reject(promise, error)
      }
    }

    AsyncFunction("startLocal") { sessionId: String, levelIntervalMs: Double?, promise: Promise ->
      try {
        settle(
          RecorderServiceClient.start(
            requireContext(),
            RecorderStartConfig.createLocal(sessionId, levelIntervalMs),
          ),
          promise,
        ) { snapshot -> snapshot.toMap() }
      } catch (error: Exception) {
        reject(promise, error)
      }
    }

    AsyncFunction("pause") { sessionId: String, promise: Promise ->
      try {
        settle(
          RecorderServiceClient.pause(requireContext(), RecorderStartConfig.validateSessionId(sessionId)),
          promise,
        ) { snapshot -> snapshot.toMap() }
      } catch (error: Exception) {
        reject(promise, error)
      }
    }

    AsyncFunction("resume") { sessionId: String, promise: Promise ->
      try {
        settle(
          RecorderServiceClient.resume(requireContext(), RecorderStartConfig.validateSessionId(sessionId)),
          promise,
        ) { snapshot -> snapshot.toMap() }
      } catch (error: Exception) {
        reject(promise, error)
      }
    }

    AsyncFunction("stop") { sessionId: String, promise: Promise ->
      try {
        settle(
          RecorderServiceClient.stop(requireContext(), RecorderStartConfig.validateSessionId(sessionId)),
          promise,
        ) { result -> result.toMap() }
      } catch (error: Exception) {
        reject(promise, error)
      }
    }

    AsyncFunction("recover") { promise: Promise ->
      try {
        settle(
          RecorderRecovery.recover(requireContext(), RecorderServiceClient.currentSessionId()),
          promise,
        ) { report -> report.toMap() }
      } catch (error: Exception) {
        reject(promise, error)
      }
    }

    AsyncFunction("getState") { sessionId: String? ->
      val normalized = sessionId?.let(RecorderStartConfig::validateSessionId)
      RecorderServiceClient.currentSnapshot(normalized)?.toMap()
    }
  }

  private fun requireContext(): Context = appContext.reactContext?.applicationContext
    ?: throw RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "Android application context is unavailable")

  private fun <T> settle(
    future: CompletableFuture<T>,
    promise: Promise,
    transform: (T) -> Any?,
  ) {
    future.whenComplete { value, error ->
      if (error != null) {
        reject(promise, error)
      } else {
        try {
          promise.resolve(transform(value))
        } catch (transformError: Exception) {
          reject(promise, transformError)
        }
      }
    }
  }

  private fun reject(promise: Promise, error: Throwable) {
    val publicError = unwrap(error)
    val code = "ERR_LAOJI_RECORDER_${publicError.errorCode.wireValue.uppercase(Locale.ROOT)}"
    promise.reject(CodedException(code, publicError.message, null))
  }

  private fun unwrap(error: Throwable): RecorderRuntimeException {
    var current = error
    while (current.cause != null && current !is RecorderRuntimeException) {
      current = requireNotNull(current.cause)
    }
    return current as? RecorderRuntimeException
      ?: RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "native recorder operation failed")
  }
}
