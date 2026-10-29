package com.laoji.nativeplatform.hardware

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.util.TimeZone

class HardwareProtocolTest {
  @Test fun localRecordingIdentitySurvivesHandoffWithoutAcceptingOtherSources() {
    val expected = java.util.UUID.nameUUIDFromBytes("board\u0000会议.wav\u0000gen-one".toByteArray(Charsets.UTF_8)).toString()
    assertEquals(expected, HardwareBoardContract.localRecordingId("board", "会议.wav", "gen-one"))
    assertNotEquals(expected, HardwareBoardContract.localRecordingId("other", "会议.wav", "gen-one"))
    assertNotEquals(expected, HardwareBoardContract.localRecordingId("board", "会议.wav", "gen-two"))
    assertNotEquals(expected, HardwareBoardContract.localRecordingId("board", "其他.wav", "gen-one"))
  }
  @Test fun captureFailureKeepsBoardAndPhoneOwnershipSeparate() {
    assertEquals("device_storage_failed", HardwareBoardContract.captureInterruption("storage_failed").publicCode)
    assertTrue(HardwareBoardContract.captureInterruption("storage_failed").message!!.contains("存储卡"))
    assertEquals("device_audio_failed", HardwareBoardContract.captureInterruption("audio_failed").publicCode)
    val unknown = HardwareBoardContract.captureInterruption("private device detail")
    assertEquals("device_recording_interrupted", unknown.publicCode)
    assertFalse(unknown.message!!.contains("private"))
    assertFalse(unknown.message!!.contains("本机存储"))
  }
  @Test fun generatedRecordingTitleUsesReadableStartTimeWithoutChangingIdentity() {
    val id = "LJ_1792508902559_43d47e3b.wav"
    assertEquals("录音 2026-10-20 23-08-22", HardwareBoardContract.recordingTitle(id, TimeZone.getTimeZone("Asia/Shanghai")))
    val preview = HardwareBoardContract.preview(id, null)
    assertEquals(id, preview.recordingId)
    assertTrue((preview.toMap()["title"] as String).startsWith("录音 2026-10-20"))
    val recording = HardwareBoardContract.recording(metadata().put("recording_id", id))
    assertEquals(id, recording.recordingId)
    assertEquals(preview.toMap()["title"], recording.title)
    // Displayed title remains a legal editable filename; never inject a colon.
    assertEquals(recording.title + ".wav", HardwareBoardContract.fileName(recording.title + ".wav"))
  }
  @Test fun generatedRecordingTitlePreservesCustomNamesAndUnknownTime() {
    val zone = TimeZone.getTimeZone("Asia/Shanghai")
    assertEquals("客户访谈", HardwareBoardContract.recordingTitle("客户访谈.wav", zone))
    assertEquals("LJ_0_43d47e3b", HardwareBoardContract.recordingTitle("LJ_0_43d47e3b.wav", zone))
    assertEquals("LJ_1792508902559_自定义", HardwareBoardContract.recordingTitle("LJ_1792508902559_自定义.wav", zone))
    assertEquals("LJ_999999999999999999999_aabbccdd", HardwareBoardContract.recordingTitle("LJ_999999999999999999999_aabbccdd.wav", zone))
    assertEquals("恢复录音 2026-10-20 23-08-22", HardwareBoardContract.recordingTitle("RECOVERED_LJ_1792508902559_43d47e3b.wav", zone))
    assertEquals("录音 2026-10-20 15-08-22", HardwareBoardContract.recordingTitle("LJ_1792508902559_43d47e3b.wav", TimeZone.getTimeZone("UTC")))
  }

  private fun audio(offset: Long = 0, sequence: Int = 1, flags: Int = 0, pcm: ByteArray = byteArrayOf(1, 0)) =
    ByteBuffer.allocate(20 + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
      .put(1).put(3).put(0x10).put(flags.toByte()).putInt(-1).putInt(sequence).putLong(offset).put(pcm).array()

  @Test fun controlUsesEightByteHeaderAndCommandId() {
    val json = JSONObject().put("schema_version", 1).put("op", "status.get").put("command_id", "c1").put("ok", true)
    val wire = HardwareProtocol.encodeControl(json)
    assertEquals(1, wire[0].toInt()); assertEquals(3, wire[1].toInt())
    assertEquals(wire.size - 8, ByteBuffer.wrap(wire).order(ByteOrder.LITTLE_ENDIAN).getInt(4))
    assertEquals("c1", HardwareProtocol.decodeControl(wire).json().getString("command_id"))
  }
  @Test fun eventsNeedNoCommandId() {
    val json = JSONObject().put("schema_version", 1).put("op", "capture.requested").put("request_id", "key-1")
    assertEquals(HardwareProtocol.KIND_EVENT, HardwareProtocol.decodeControl(HardwareProtocol.encodeControl(json)).kind)
  }
  @Test(expected = HardwareProtocolException::class) fun oldEnvelopeIsRejected() {
    HardwareProtocol.decodeControl("LJHW".toByteArray() + ByteArray(64))
  }
  @Test(expected = HardwareProtocolException::class) fun wrongLengthRejected() {
    val wire = HardwareProtocol.encodeControl(JSONObject().put("schema_version", 1).put("op", "event"))
    HardwareProtocol.decodeControl(wire + byteArrayOf(0))
  }
  @Test(expected = HardwareProtocolException::class) fun malformedUtf8Rejected() {
    HardwareProtocol.parseJson(byteArrayOf(0xc3.toByte(), 0x28))
  }
  @Test(expected = HardwareProtocolException::class) fun trailingJsonRejected() {
    HardwareProtocol.parseJson("{\"op\":\"hello\"}{}".toByteArray())
  }
  private fun metadata(): JSONObject = JSONObject("""{
    "recording_id":"客户访谈.wav","container":"wav","generation":"gen-6acf486a-0002942c",
    "file_bytes":169004,"audio_bytes":168960,"samples":84480,"duration_ms":5280,
    "checksum_sha256":"sha256:daf6cb75b62a1debdd73fac070105e70a69d21ba9f0fddd7c1665f8ad96a50e0",
    "checksum_scope":"audio_payload",
    "audio":{"codec":"pcm_s16le","sample_rate_hz":16000,"channels":1,"bits_per_sample":16}
  }""")
  @Test fun boardMetadataUsesPcmNotContainerSize() {
    val value = HardwareBoardContract.recording(metadata())
    assertEquals(168960L, value.audioBytes)
    assertEquals(169004L, value.byteSize)
    assertEquals(5280L, value.durationMs)
  }
  @Test fun catalogPreviewIsNotTransferMetadata() {
    val entry = metadata()
    entry.remove("checksum_sha256"); entry.remove("checksum_scope")
    val preview = HardwareBoardContract.preview("客户访谈.wav", entry)
    assertEquals(169004L, preview.byteSize)
    assertEquals(5280L, preview.durationMs)
    assertFalse(preview.toMap().containsKey("checksumSha256"))
    try { HardwareBoardContract.recording(entry); fail("preview accepted for transfer") }
    catch (_: org.json.JSONException) { }
  }
  @Test fun olderFirmwareNamesStayUnknownNotZeroLength() {
    val entry = HardwareBoardContract.preview("会议.wav", null)
    assertNull(entry.generation); assertNull(entry.byteSize); assertNull(entry.durationMs)
  }
  @Test(expected = HardwareProtocolException::class) fun mismatchedPreviewCannotRenameAnotherFile() {
    HardwareBoardContract.preview("另一份.wav", metadata())
  }
  @Test fun bulkTransportPolicyHasOneNativeOwner() {
    assertFalse(HardwareBoardContract.preferWifi(1024 * 1024 - 1L, true))
    assertTrue(HardwareBoardContract.preferWifi(1024 * 1024L, true))
    assertFalse(HardwareBoardContract.preferWifi(1024 * 1024L, false))
  }
  @Test(expected = HardwareProtocolException::class) fun contradictorySampleCountRejected() {
    HardwareBoardContract.recording(metadata().put("samples", 169004))
  }
  @Test fun finishedEventIsCompleteMetadataWithoutASecondDeviceQuery() {
    val payload = metadata().put("op", "capture.finished")
    payload.remove("audio"); payload.remove("container"); payload.remove("created_epoch_ms")
    val value = HardwareBoardContract.finishedRecording(payload, 123456)
    assertEquals(123456L, value.createdEpochMs)
    assertEquals(168960L, value.audioBytes)
    assertEquals("客户访谈.wav", value.recordingId)
  }
  @Test fun wifiOfferScopesUtf8PathToSelectedGeneration() {
    val selected = HardwareBoardContract.recording(metadata())
    val offer = HardwareBoardContract.wifiOffer(JSONObject().put("base_url", "http://192.168.4.1")
      .put("recording_base_path", "/recording/").put("ssid", "board").put("password", "password1")
      .put("bearer_token", "a".repeat(32)).put("security_mode", "development_http").put("expires_in_ms", 60000), selected)
    assertEquals(selected.generation, offer.generation)
    assertTrue(offer.path.startsWith("/recording/%E5%AE%A2"))
  }
  @Test fun audioIsNotBleFragmented() {
    val frame = HardwareProtocol.decodeAudio(audio(492, -1))
    assertEquals(492L, frame.pcmOffset); assertEquals(-1, frame.streamId); assertEquals(-1, frame.sequence)
    assertArrayEquals(byteArrayOf(1, 0), frame.payload)
    assertEquals(1, HardwareProtocol.nextSequence(-1))
  }
  @Test fun emptyFinalAudioIsValid() { assertEquals(0, HardwareProtocol.decodeAudio(audio(flags = 1, pcm = byteArrayOf())).payload.size) }
  @Test(expected = HardwareProtocolException::class) fun unalignedOffsetRejected() { HardwareProtocol.decodeAudio(audio(offset = 1)) }
  @Test(expected = HardwareProtocolException::class) fun zeroSequenceRejected() { HardwareProtocol.decodeAudio(audio(sequence = 0)) }
  @Test(expected = HardwareProtocolException::class) fun emptyNonFinalRejected() { HardwareProtocol.decodeAudio(audio(pcm = byteArrayOf())) }
  @Test fun chineseNamesArePreservedAndEncodedOnce() {
    assertEquals("客户访谈.wav", HardwareBoardContract.fileName("客户访谈.wav"))
    assertEquals("a%20b%25.wav", HardwareBoardContract.percentEncode("a b%.wav"))
    assertTrue(HardwareBoardContract.percentEncode("会议.wav").startsWith("%E4%BC%9A"))
  }
  @Test(expected = HardwareProtocolException::class) fun pathsRejected() { HardwareBoardContract.fileName("../会议.wav") }
  @Test fun pcmPrefixNeverClosesGapWithSilence() {
    val directory = Files.createTempDirectory("board-pcm").toFile()
    try {
      val file = File(directory, "prefix")
      HardwarePcmFile(file).use { pcm ->
        assertTrue(pcm.append(0, byteArrayOf(1, 0)))
        assertFalse(pcm.append(4, byteArrayOf(3, 0)))
        assertEquals(2L, pcm.size())
        assertTrue(pcm.append(2, byteArrayOf(2, 0, 3, 0)))
      }
      assertArrayEquals(byteArrayOf(1, 0, 2, 0, 3, 0), file.readBytes())
      HardwarePcmFile(file).use { assertEquals(6L, it.size()); assertTrue(it.append(6, byteArrayOf(4, 0))) }
    } finally { directory.deleteRecursively() }
  }
}
