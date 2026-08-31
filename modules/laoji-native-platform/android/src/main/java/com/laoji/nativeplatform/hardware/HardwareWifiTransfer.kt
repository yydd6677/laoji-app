package com.laoji.nativeplatform.hardware

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import java.io.File
import java.io.FileInputStream
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.RandomAccessFile
import java.net.InetSocketAddress
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
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
        if (!available.isDone) {
          available.completeExceptionally(
            HardwareRuntimeException("transport_lost", "录音设备的传输连接已断开。"),
          )
        }
      }
    }
    connectivity.requestNetwork(request, callback, 30_000)
    try {
      val network = available.get(32, TimeUnit.SECONDS)
      return download(network, endpoint, deviceId, recording, offer, store, onProgress)
    } catch (error: java.util.concurrent.TimeoutException) {
      throw HardwareRuntimeException("wifi_unavailable", "连接录音设备超时。", error)
    } finally {
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
        onProgress = onProgress,
      )
    }
    if (!part.isFile || part.length() != recording.byteSize) {
      throw HardwareRuntimeException("transport_lost", "设备录音尚未完整接收。")
    }
    verifyWav(part, recording)
    val actual = sha256(part, if (recording.checksumScope == "audio_payload") 44L else 0L)
    if (actual != recording.checksumSha256.lowercase()) {
      part.delete()
      throw HardwareRuntimeException("checksum_mismatch", "设备录音校验未通过，请重新接收。")
    }
    onProgress(1.0)
    return store.commitDeviceDownload(
      localRecordingId = localId,
      partFile = part,
      deviceId = deviceId,
      deviceRecordingId = recording.recordingId,
      generation = recording.generation,
      title = recording.title,
      recordedAtMs = recording.createdEpochMs ?: System.currentTimeMillis().coerceAtLeast(0L),
      durationMs = recording.durationMs,
      byteSize = recording.byteSize,
    )
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
    onProgress: (Double) -> Unit,
  ): Long {
    val port = if (endpoint.port > 0) endpoint.port else 80
    val socket = network.socketFactory.createSocket()
    socket.connect(InetSocketAddress(endpoint.host, port), 8_000)
    socket.soTimeout = 20_000
    try {
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
        headers[line.substring(0, separator).trim().lowercase()] = line.substring(separator + 1).trim()
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
      if (headers["content-length"]?.toLongOrNull() != expectedBody) {
        part.delete()
        throw HardwareRuntimeException("resume_mismatch", "设备返回的录音大小不一致。")
      }
      var offset = initialOffset
      RandomAccessFile(part, "rw").use { output ->
        output.seek(offset)
        val buffer = ByteArray(64 * 1024)
        while (offset < recording.byteSize) {
          val count = input.read(buffer, 0, minOf(buffer.size.toLong(), recording.byteSize - offset).toInt())
          if (count < 0) break
          if (count == 0) continue
          output.write(buffer, 0, count)
          offset += count
          onProgress((offset.toDouble() / recording.byteSize.coerceAtLeast(1L)).coerceIn(0.0, 1.0))
        }
        output.fd.sync()
      }
      return offset
    } finally {
      runCatching { socket.close() }
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

  private fun verifyWav(file: File, recording: HardwareDeviceRecording) {
    val header = ByteArray(44)
    FileInputStream(file).use { input ->
      if (input.read(header) != header.size) {
        throw HardwareRuntimeException("checksum_mismatch", "设备录音格式不完整。")
      }
    }
    val buffer = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
    val riff = String(header, 0, 4, Charsets.US_ASCII)
    val wave = String(header, 8, 4, Charsets.US_ASCII)
    val format = String(header, 12, 4, Charsets.US_ASCII)
    val data = String(header, 36, 4, Charsets.US_ASCII)
    val audioFormat = buffer.getShort(20).toInt() and 0xffff
    val channels = buffer.getShort(22).toInt() and 0xffff
    val sampleRate = buffer.getInt(24)
    val bits = buffer.getShort(34).toInt() and 0xffff
    val dataBytes = buffer.getInt(40).toLong() and 0xffffffffL
    if (
      riff != "RIFF" || wave != "WAVE" || format != "fmt " || data != "data" ||
      audioFormat != 1 || channels != 1 || sampleRate != 16_000 || bits != 16 ||
      dataBytes + 44L != recording.byteSize
    ) {
      file.delete()
      throw HardwareRuntimeException("checksum_mismatch", "设备录音格式与声明不一致。")
    }
  }

  private fun sha256(file: File, skipBytes: Long): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      var remaining = skipBytes
      while (remaining > 0L) {
        val skipped = input.skip(remaining)
        if (skipped <= 0L) throw HardwareRuntimeException("checksum_mismatch", "设备录音格式不完整。")
        remaining -= skipped
      }
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) digest.update(buffer, 0, count)
      }
    }
    return "sha256:" + digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }
}
