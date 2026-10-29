package com.laoji.nativeplatform.hardware

import org.json.JSONObject
import org.json.JSONTokener
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction

/** The collaborator's BLE 1.3 contract, without the old LJHW envelope. */
internal object HardwareProtocol {
  const val MAJOR = 1
  const val MINOR = 3
  const val JSON_HEADER_LENGTH = 8
  const val AUDIO_HEADER_LENGTH = 20
  const val MAX_CONTROL_PAYLOAD = 48 * 1024 - JSON_HEADER_LENGTH
  const val KIND_CONTROL_RESPONSE = 0x02
  const val KIND_EVENT = 0x03
  const val KIND_LIVE_AUDIO = 0x10
  const val KIND_FILE_CHUNK = 0x11
  const val FLAG_FINAL = 1

  fun encodeControl(message: JSONObject): ByteArray {
    val payload = message.toString().toByteArray(Charsets.UTF_8)
    require(payload.size in 1..MAX_CONTROL_PAYLOAD) { "control JSON exceeds capacity" }
    return ByteBuffer.allocate(JSON_HEADER_LENGTH + payload.size).order(ByteOrder.LITTLE_ENDIAN)
      .put(MAJOR.toByte()).put(MINOR.toByte()).put(0).put(0).putInt(payload.size).put(payload).array()
  }

  fun decodeControl(bytes: ByteArray): HardwareFrame {
    checkProtocol(bytes.size >= JSON_HEADER_LENGTH, "short JSON frame")
    val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    checkProtocol(b.get().toInt() == MAJOR && b.get().toInt() == MINOR, "unsupported protocol")
    val flags = b.get().toInt() and 255
    checkProtocol(b.get().toInt() == 0 && flags and 0xfd == 0, "invalid JSON flags")
    val size = b.int
    checkProtocol(size in 1..MAX_CONTROL_PAYLOAD && size == bytes.size - 8, "invalid JSON length")
    val payload = bytes.copyOfRange(8, bytes.size)
    val json = parseJson(payload)
    checkProtocol(json.optInt("schema_version", -1) == 1 && json.optString("op").isNotBlank(), "invalid message")
    val response = json.has("ok")
    checkProtocol(response || flags == 0, "event flags")
    if (response) {
      checkProtocol(json.opt("ok") is Boolean && json.optString("command_id").isNotBlank(), "invalid response")
      checkProtocol(flags == 0 || (!json.getBoolean("ok") && json.optJSONObject("error")?.optBoolean("retryable") == true), "retryable flag mismatch")
    }
    return HardwareFrame(if (response) KIND_CONTROL_RESPONSE else KIND_EVENT, flags, 0, 0, payload)
  }

  fun decodeAudio(bytes: ByteArray): HardwareFrame {
    checkProtocol(bytes.size in AUDIO_HEADER_LENGTH..512, "invalid audio frame length")
    val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    checkProtocol(b.get().toInt() == MAJOR && b.get().toInt() == MINOR, "unsupported audio protocol")
    val kind = b.get().toInt() and 255
    val flags = b.get().toInt() and 255
    val stream = b.int
    val sequence = b.int
    val offset = b.long
    checkProtocol(kind in setOf(KIND_LIVE_AUDIO, KIND_FILE_CHUNK) && flags and 0xfe == 0, "invalid audio kind/flags")
    checkProtocol(stream != 0 && sequence != 0 && offset >= 0 && offset % 2L == 0L, "invalid audio identity/offset")
    checkProtocol((bytes.size - 20) % 2 == 0 && (bytes.size > 20 || flags == FLAG_FINAL), "invalid PCM alignment")
    return HardwareFrame(kind, flags, stream, sequence, bytes.copyOfRange(20, bytes.size), offset)
  }

  fun nextSequence(value: Int): Int = if (value == -1) 1 else value + 1
  fun parseJson(payload: ByteArray): JSONObject = try {
    val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(payload)).toString()
    val tokens = JSONTokener(text)
    val value = tokens.nextValue() as? JSONObject ?: throw HardwareProtocolException("JSON object required")
    checkProtocol(tokens.nextClean() == '\u0000', "trailing JSON data")
    value
  } catch (e: Exception) { throw HardwareProtocolException("invalid JSON", e) }
  private fun checkProtocol(valid: Boolean, reason: String) {
    if (!valid) throw HardwareProtocolException(reason)
  }
}

internal data class HardwareFrame(
  val kind: Int,
  val flags: Int,
  val streamId: Int,
  val sequence: Int,
  val payload: ByteArray,
  val pcmOffset: Long = 0,
) {
  fun json(): JSONObject = HardwareProtocol.parseJson(payload)
}

internal class HardwareProtocolException(message: String, cause: Throwable? = null) :
  IllegalStateException(message, cause)
