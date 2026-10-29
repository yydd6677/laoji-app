package com.laoji.nativeplatform.hardware

import java.io.IOException
import java.io.OutputStream

/** The file owner distinguishes disk failure from a socket failure, preserving
 * bulk writes and leaving resource lifetime to its existing outer scope. */
internal class HardwareDownloadOutput(private val output: OutputStream) : OutputStream() {
  override fun write(value: Int) = storage { output.write(value) }
  override fun write(bytes: ByteArray, offset: Int, length: Int) = storage { output.write(bytes, offset, length) }

  companion object {
    fun <T> storage(action: () -> T): T = try { action() }
    catch (error: IOException) {
      throw HardwareRuntimeException("storage_failed", "录音暂时无法保存，请检查本机存储空间。", error)
    }
  }
}
