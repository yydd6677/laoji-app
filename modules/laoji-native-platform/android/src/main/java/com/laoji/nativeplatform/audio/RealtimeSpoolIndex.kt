package com.laoji.nativeplatform.audio

import java.io.File
import java.util.TreeMap

/** Rebuildable single-writer index, never a second durable cursor or owner. */
internal class RealtimeSpoolIndex(root: File) {
  private data class Entry(val file: File, val bytes: Long)
  private val chunks = TreeMap<Long, Entry>()
  private val events = TreeMap<Long, Entry>()
  var bytes: Long = 0L
    private set

  init {
    root.listFiles().orEmpty().filter { it.isFile }.forEach { file ->
      val length = file.length()
      bytes += length // Include unknown/orphan files conservatively in quota.
      locate(file)?.let { (map, sequence) -> map[sequence] = Entry(file, length) }
    }
  }

  fun files(kind: String): List<File> = map(kind).values.map { it.file }
  fun through(kind: String, sequence: Long): List<File> =
    map(kind).headMap(sequence, true).values.map { it.file }

  fun committed(file: File) {
    val (map, sequence) = requireNotNull(locate(file))
    val length = file.length()
    val previous = map.put(sequence, Entry(file, length))
    bytes += length - (previous?.bytes ?: 0L)
  }

  fun deleted(file: File) {
    val (map, sequence) = requireNotNull(locate(file))
    map.remove(sequence)?.let { bytes -= it.bytes }
  }

  private fun map(kind: String) = when (kind) {
    "chunk" -> chunks
    "event" -> events
    else -> throw IllegalArgumentException("Unknown spool kind")
  }

  private fun locate(file: File): Pair<TreeMap<Long, Entry>, Long>? {
    val match = Regex("^(chunk|event)-(\\d+)\\.bin$").matchEntire(file.name) ?: return null
    val sequence = match.groupValues[2].toLongOrNull() ?: return null
    return map(match.groupValues[1]) to sequence
  }
}
