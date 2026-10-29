package com.laoji.nativeplatform.hardware
import com.laoji.nativeplatform.audio.PcmWaveFile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import java.io.File
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.RandomAccessFile
import java.net.InetSocketAddress
import java.net.URL
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

internal data class HardwareDeviceRecording(
  val recordingId: String,
  val generation: String,
  val title: String?,
  val byteSize: Long,
  val durationMs: Long,
  val checksumSha256: String,
  val checksumScope: String,
  val createdEpochMs: Long?,
  val acknowledged: Boolean,
  val recovered: Boolean,
  val audioBytes: Long = byteSize - 44L,
  val purpose: String = "meeting",
  val captureId: String? = null,
  val timeZone: String? = null,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "recordingId" to recordingId,
    "generation" to generation,
    "title" to title,
    "byteSize" to byteSize,
    "durationMs" to durationMs,
    "checksumSha256" to checksumSha256,
    "checksumScope" to checksumScope,
    "createdEpochMs" to createdEpochMs,
    "acknowledged" to acknowledged,
    "recovered" to recovered,
    "purpose" to purpose, "captureId" to captureId, "timeZone" to timeZone,
  )
}

internal data class HardwareWifiOffer(
  val recordingId: String,
  val generation: String,
  val ssid: String,
  val password: String,
  val baseUrl: String,
  val path: String,
  val bearerToken: String,
  val securityMode: String,
  val certificateSha256: String?,
  val expiresEpochMs: Long,
  val expiresInMs: Long,
)

internal object HardwareWifiTransfer {
  fun requireWifiEnabled(context: Context) {
    val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
      ?: throw HardwareRuntimeException("wifi_unavailable", "无法使用本机无线网络。")
    if (!wifi.isWifiEnabled) {
      throw HardwareRuntimeException("wifi_disabled", "无线网络已关闭。")
    }
  }

  fun receive(
    context: Context,
    deviceId: String,
    recording: HardwareDeviceRecording,
    offer: HardwareWifiOffer,
    store: HardwareRecordingStore,
    allowDevelopmentHttp: Boolean,
    onProgress: (Double) -> Unit,
  ): PendingHardwareRecording {
    require(recording.recordingId == offer.recordingId && recording.generation == offer.generation) {
      "Wi-Fi offer does not match the selected recording"
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      throw HardwareRuntimeException("wifi_unavailable", "当前 Android 版本不支持设备直连传输。")
    }
    requireWifiEnabled(context)
    if (
      Build.VERSION.SDK_INT >= 33 &&
      context.checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED
    ) {
      throw HardwareRuntimeException("permission_denied", "老记需要附近设备权限才能接收录音。")
    }
    val endpoint = URL(URL(offer.baseUrl), offer.path)
    when (offer.securityMode) {
      "development_http" -> {
        if (!allowDevelopmentHttp || endpoint.protocol != "http" || endpoint.host != "192.168.4.1") {
          throw HardwareRuntimeException("device_untrusted", "测试设备的传输地址不受信任。")
        }
      }
      "tls_pinned" -> throw HardwareRuntimeException(
        "incompatible",
        "正式硬件的证书传输适配尚未完成。",
      )
      else -> throw HardwareRuntimeException("device_untrusted", "设备使用了不受支持的传输方式。")
    }

    val connectivity = context.getSystemService(ConnectivityManager::class.java)
      ?: throw HardwareRuntimeException("wifi_unavailable", "无法使用本机 Wi-Fi。")
    val specifier = WifiNetworkSpecifier.Builder()
      .setSsid(offer.ssid)
      .setWpa2Passphrase(offer.password)
      .build()
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifier)
      .build()
    val available = CompletableFuture<Network>()
    val lease = HardwareTransferLease()
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        available.complete(network)
      }

      override fun onUnavailable() {
        available.completeExceptionally(
          HardwareRuntimeException("wifi_unavailable", "未能连接录音设备的传输网络。"),
        )
      }

      override fun onLost(network: Network) {
        val error = HardwareRuntimeException("wifi_transfer_interrupted", "录音接收中断，请重试。")
        lease.cancel(error)
        available.completeExceptionally(error)
      }
    }
    val requestedAt = android.os.SystemClock.elapsedRealtime()
    try {
      connectivity.requestNetwork(request, callback, 30_000)
      val network = available.get(32, TimeUnit.SECONDS)
      lease.check()
      Log.i("LaojiHardware", "wifi_connected wait_ms=${android.os.SystemClock.elapsedRealtime() - requestedAt}")
      return download(network, endpoint, deviceId, recording, offer, store, lease, onProgress)
    } catch (error: java.util.concurrent.TimeoutException) {
      throw HardwareRuntimeException("wifi_unavailable", "连接录音设备超时。", error)
    } catch (error: ExecutionException) {
      // Future.get wraps callback failures. Keep the public code/outcome intact
      // through the Expo boundary instead of exposing an implementation wrapper.
      val cause = error.cause
      if (cause is HardwareRuntimeException) throw cause
      throw HardwareRuntimeException("wifi_unavailable", "未能连接录音设备的传输网络。", cause ?: error)
    } catch (error: java.io.IOException) {
      lease.check()
      throw HardwareRuntimeException("wifi_transfer_interrupted", "录音接收中断，请重试。", error)
    } finally {
      lease.close()
      runCatching { connectivity.unregisterNetworkCallback(callback) }
    }
  }

  private fun download(
    network: Network,
    endpoint: URL,
    deviceId: String,
    recording: HardwareDeviceRecording,
    offer: HardwareWifiOffer,
    store: HardwareRecordingStore,
    lease: HardwareTransferLease,
    onProgress: (Double) -> Unit,
  ): PendingHardwareRecording {
    val (localId, part) = store.deviceDownloadPart(deviceId, recording.recordingId, recording.generation)
    if (part.exists() && part.length() > recording.byteSize) part.delete()
    var offset = part.length().coerceAtLeast(0L)
    if (offset < recording.byteSize) {
      offset = downloadDevelopmentHttp(
        network = network,
        endpoint = endpoint,
        offer = offer,
        recording = recording,
        part = part,
        initialOffset = offset,
        lease = lease,
        onProgress = onProgress,
      )
    }
    if (!part.isFile || part.length() != recording.byteSize) {
      throw HardwareRuntimeException("transport_lost", "设备录音尚未完整接收。")
    }
    val verifyAt = android.os.SystemClock.elapsedRealtime()
    val layout = try { PcmWaveFile.inspect(part, recording.byteSize, recording.audioBytes) }
    catch (error: java.io.IOException) {
      part.delete()
      throw HardwareRuntimeException("checksum_mismatch", "设备录音格式与声明不一致。", error)
    }
    val hashes = PcmWaveFile.digests(part, layout)
    val actual = if (recording.checksumScope == "audio_payload") hashes.audioSha256 else hashes.fileSha256
    if (actual != recording.checksumSha256.lowercase()) {
      part.delete()
      throw HardwareRuntimeException("checksum_mismatch", "设备录音校验未通过，请重新接收。")
    }
    onProgress(1.0)
    val commitAt = android.os.SystemClock.elapsedRealtime()
    val result = store.commitDeviceDownload(
      localRecordingId = localId,
      partFile = part,
      deviceId = deviceId,
      deviceRecordingId = recording.recordingId,
      generation = recording.generation,
      title = recording.title,
      recordedAtMs = recording.createdEpochMs ?: System.currentTimeMillis().coerceAtLeast(0L),
      durationMs = recording.durationMs,
      byteSize = recording.byteSize,
      verifiedFileSha256 = hashes.fileSha256,
      purpose = recording.purpose, captureId = recording.captureId, timeZone = recording.timeZone,
      audioChecksumSha256 = hashes.audioSha256,
    )
    Log.i("LaojiHardware", "wifi_download_verified bytes=${recording.byteSize} sha_match=true verify_ms=${commitAt - verifyAt} commit_ms=${android.os.SystemClock.elapsedRealtime() - commitAt}")
    return result
  }

  /**
   * The known test board deliberately advertises `development_http`. A raw
   * socket bound to the temporary Android Network keeps this narrow profile
   * independent from the app-wide cleartext policy; unknown devices never
   * reach this method. Formal hardware uses the separate tls_pinned profile.
   */
  private fun downloadDevelopmentHttp(
    network: Network,
    endpoint: URL,
    offer: HardwareWifiOffer,
    recording: HardwareDeviceRecording,
    part: File,
    initialOffset: Long,
    lease: HardwareTransferLease,
    onProgress: (Double) -> Unit,
  ): Long {
    val port = if (endpoint.port > 0) endpoint.port else 80
    return lease.use(network.socketFactory.createSocket()) { socket ->
      socket.connect(InetSocketAddress(endpoint.host, port), 8_000)
      socket.soTimeout = 20_000
      val request = buildString {
        append("GET ").append(endpoint.file.ifBlank { "/" }).append(" HTTP/1.1\r\n")
        append("Host: ").append(endpoint.host).append("\r\n")
        append("Authorization: Bearer ").append(offer.bearerToken).append("\r\n")
        append("If-Match: \"").append(recording.generation).append("\"\r\n")
        if (initialOffset > 0L) append("Range: bytes=").append(initialOffset).append("-\r\n")
        append("Connection: close\r\n\r\n")
      }
      val outputStream = BufferedOutputStream(socket.getOutputStream())
      outputStream.write(request.toByteArray(Charsets.US_ASCII))
      outputStream.flush()
      val input = BufferedInputStream(socket.getInputStream())
      val statusLine = readAsciiLine(input, 1024)
      val status = statusLine.split(' ').getOrNull(1)?.toIntOrNull()
        ?: throw HardwareRuntimeException("transport_lost", "设备返回了无效的传输响应。")
      val headers = linkedMapOf<String, String>()
      var headerBytes = statusLine.length
      while (true) {
        val line = readAsciiLine(input, 4096)
        headerBytes += line.length + 2
        if (headerBytes > 16 * 1024) {
          throw HardwareRuntimeException("transport_lost", "设备传输响应过大。")
        }
        if (line.isEmpty()) break
        val separator = line.indexOf(':')
        if (separator <= 0) throw HardwareRuntimeException("transport_lost", "设备传输响应无效。")
        val name = line.substring(0, separator).trim().lowercase()
        val value = line.substring(separator + 1).trim()
        if (name in setOf("content-length", "transfer-encoding") && headers.containsKey(name)) {
          throw HardwareRuntimeException("transport_lost", "设备传输响应无效。")
        }
        headers[name] = value
      }
      if (initialOffset == 0L && status != 200) {
        throw HardwareRuntimeException("transport_lost", "设备没有返回可接收的录音。")
      }
      if (initialOffset > 0L && status != 206) {
        part.delete()
        throw HardwareRuntimeException("resume_mismatch", "录音续传状态不一致，请重试。")
      }
      if (initialOffset > 0L && !headers["content-range"].orEmpty().startsWith("bytes $initialOffset-")) {
        part.delete()
        throw HardwareRuntimeException("resume_mismatch", "录音续传位置不一致，请重试。")
      }
      val etag = headers["etag"]?.trim()?.trim('"')
      if (!etag.isNullOrEmpty() && etag != recording.generation) {
        part.delete()
        throw HardwareRuntimeException("resume_mismatch", "设备录音已发生变化，请刷新后重试。")
      }
      val expectedBody = recording.byteSize - initialOffset
      Log.i("LaojiHardware", "wifi_response status=$status chunked=${headers["transfer-encoding"]?.equals("chunked", true) == true} declared_bytes=${headers["content-length"]?.toLongOrNull() ?: -1} expected_bytes=$expectedBody")
      if (headers["content-length"] != null && headers["content-length"]?.toLongOrNull() != expectedBody) {
        part.delete()
        throw HardwareRuntimeException("resume_mismatch", "设备返回的录音大小不一致。")
      }
      var offset = initialOffset
      val timing = HardwareTransferMetrics()
      val bodyAt = android.os.SystemClock.elapsedRealtime()
      HardwareDownloadOutput.storage {
        RandomAccessFile(part, "rw").use { output ->
          output.seek(offset)
          val sink = HardwareDownloadOutput(object : java.io.OutputStream() {
            override fun write(value: Int) = output.write(value)
            override fun write(bytes: ByteArray, start: Int, count: Int) = output.write(bytes, start, count)
          })
          try {
            HardwareHttpBody.copy(timing.input(input), timing.output(sink), headers, expectedBody) { received ->
              offset = initialOffset + received
              timing.progress { onProgress((offset.toDouble() / recording.byteSize.coerceAtLeast(1L)).coerceIn(0.0, 1.0)) }
            }
          } catch (error: java.io.IOException) {
            Log.w("LaojiHardware", "wifi_body_failed received_bytes=${offset-initialOffset} expected_bytes=$expectedBody chunked=${headers["transfer-encoding"]?.equals("chunked", true) == true}")
            lease.check()
            throw HardwareRuntimeException("wifi_transfer_interrupted", "录音接收中断，请重试。", error)
          }
          output.fd.sync()
        }
      }
      Log.i("LaojiHardware", "wifi_body_complete bytes=$expectedBody elapsed_ms=${android.os.SystemClock.elapsedRealtime() - bodyAt} read_ms=${timing.readNanos / 1000000} write_ms=${timing.writeNanos / 1000000} progress_ms=${timing.progressNanos / 1000000} reads=${timing.reads} writes=${timing.writes}")
      offset
    }
  }

  private fun readAsciiLine(input: BufferedInputStream, maximumBytes: Int): String {
    val bytes = ArrayList<Byte>(minOf(maximumBytes, 128))
    while (bytes.size < maximumBytes) {
      val value = input.read()
      if (value < 0) throw HardwareRuntimeException("transport_lost", "设备传输连接提前结束。")
      if (value == '\n'.code) {
        if (bytes.lastOrNull() == '\r'.code.toByte()) bytes.removeAt(bytes.lastIndex)
        return bytes.toByteArray().toString(Charsets.US_ASCII)
      }
      bytes += value.toByte()
    }
    throw HardwareRuntimeException("transport_lost", "设备传输响应过大。")
  }

}
