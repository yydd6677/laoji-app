package com.laoji.nativeplatform.hardware

import java.io.FilterInputStream
import java.io.InputStream
import java.io.OutputStream

/** Per-transfer aggregate timings only: no names, addresses, tokens or audio.
 * Wrappers preserve bulk calls instead of FilterOutputStream's byte-at-a-time default. */
internal class HardwareTransferMetrics {
  var readNanos = 0L; private set
  var writeNanos = 0L; private set
  var progressNanos = 0L; private set
  var reads = 0; private set
  var writes = 0; private set

  fun input(source: InputStream): InputStream = object : FilterInputStream(source) {
    override fun read(): Int {
      val start = System.nanoTime()
      try { return source.read() }
      finally { readNanos += System.nanoTime() - start; reads++ }
    }
    override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
      val start = System.nanoTime()
      try { return source.read(bytes, offset, length) }
      finally { readNanos += System.nanoTime() - start; reads++ }
    }
  }

  fun output(target: OutputStream): OutputStream = object : OutputStream() {
    override fun write(value: Int) {
      val start = System.nanoTime()
      try { target.write(value) }
      finally { writeNanos += System.nanoTime() - start; writes++ }
    }
    override fun write(bytes: ByteArray, offset: Int, length: Int) {
      val start = System.nanoTime()
      try { target.write(bytes, offset, length) }
      finally { writeNanos += System.nanoTime() - start; writes++ }
    }
  }

  fun progress(action: () -> Unit) {
    val start = System.nanoTime()
    try { action() } finally { progressNanos += System.nanoTime() - start }
  }
}
