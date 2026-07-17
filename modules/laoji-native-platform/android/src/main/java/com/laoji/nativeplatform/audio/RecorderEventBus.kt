package com.laoji.nativeplatform.audio

// MIN-AUDIO-001: only throttled state, level, transcript, and file events cross the bridge.

import java.util.concurrent.CopyOnWriteArraySet

fun interface RecorderEventListener {
  fun onRecorderEvent(name: String, body: Map<String, Any?>)
}

object RecorderEvents {
  const val STATE_CHANGED = "onRecorderStateChanged"
  const val LEVEL = "onRecorderLevel"
  const val TRANSCRIPT = "onRecorderTranscript"
  const val ERROR = "onRecorderError"
  const val RECOVERED = "onRecorderRecovered"

  val all = arrayOf(STATE_CHANGED, LEVEL, TRANSCRIPT, ERROR, RECOVERED)
}

object RecorderEventBus {
  private val listeners = CopyOnWriteArraySet<RecorderEventListener>()

  fun addListener(listener: RecorderEventListener) {
    listeners.add(listener)
  }

  fun removeListener(listener: RecorderEventListener) {
    listeners.remove(listener)
  }

  fun emit(name: String, body: Map<String, Any?>) {
    listeners.forEach { listener ->
      try {
        listener.onRecorderEvent(name, body)
      } catch (_: Exception) {
        // Event delivery must not stop recording or persistence.
      }
    }
  }
}
