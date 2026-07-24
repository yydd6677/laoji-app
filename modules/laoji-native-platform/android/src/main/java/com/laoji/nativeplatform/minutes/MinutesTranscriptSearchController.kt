package com.laoji.nativeplatform.minutes

import java.text.BreakIterator
import java.text.Normalizer
import java.util.Locale

data class MinutesTextRange(
  val start: Int,
  val end: Int,
) {
  fun validFor(text: String): Boolean = start >= 0 && end > start && end <= text.length
}

internal data class MinutesTranscriptMatch(
  val lineIndex: Int,
  val lineId: String,
  val range: MinutesTextRange,
)

internal data class MinutesTranscriptSearchState(
  val query: String = "",
  val matches: List<MinutesTranscriptMatch> = emptyList(),
  val selectedIndex: Int = -1,
  val truncated: Boolean = false,
) {
  val selectedMatch: MinutesTranscriptMatch?
    get() = matches.getOrNull(selectedIndex)

  val countLabel: String
    get() = when {
      matches.isEmpty() -> "0/0"
      truncated -> "${selectedIndex + 1}/${matches.size}+"
      else -> "${selectedIndex + 1}/${matches.size}"
    }
}

/**
 * TRN-01 keeps query and match navigation entirely inside the native page.
 * No keystroke crosses the React Native bridge and no query is persisted.
 */
internal class MinutesTranscriptSearchController(
  private val maximumMatches: Int = 1_000,
) {
  private var lines: List<MinutesTranscriptLine> = emptyList()
  private var searchableLines: List<NormalizedMappedText> = emptyList()
  private var timeline: List<TimelineEntry> = emptyList()

  var state: MinutesTranscriptSearchState = MinutesTranscriptSearchState()
    private set

  init {
    require(maximumMatches > 0) { "maximum transcript matches must be positive" }
  }

  fun updateLines(next: List<MinutesTranscriptLine>): MinutesTranscriptSearchState {
    if (lines == next) return state
    val selected = state.selectedMatch
    lines = next.toList()
    searchableLines = lines.map { normalizeWithOriginalRanges(it.text) }
    timeline = lines.mapIndexedNotNull { index, line ->
      if (line.id.isBlank() || line.startMs < 0L) null else TimelineEntry(index, line)
    }.sortedWith(compareBy<TimelineEntry> { it.line.startMs }.thenBy { it.lineIndex })
    state = search(state.query, selected)
    return state
  }

  fun updateQuery(value: String): MinutesTranscriptSearchState {
    val query = value.take(MAX_QUERY_LENGTH)
    if (query == state.query) return state
    state = search(query, selected = null)
    return state
  }

  fun previous(): MinutesTranscriptSearchState = move(-1)

  fun next(): MinutesTranscriptSearchState = move(1)

  fun hasEffectiveQuery(): Boolean = normalize(state.query).isNotBlank()

  fun rangesByLineIndex(): Map<Int, List<MinutesTextRange>> =
    state.matches.groupBy({ it.lineIndex }, { it.range })

  fun activeLineIndex(positionMs: Long): Int? {
    if (timeline.isEmpty() || positionMs < 0L) return null
    var low = 0
    var high = timeline.lastIndex
    var candidate = -1
    while (low <= high) {
      val middle = (low + high).ushr(1)
      if (timeline[middle].line.startMs <= positionMs) {
        candidate = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (candidate < 0) return null
    val current = timeline[candidate]
    val nextStart = timeline.getOrNull(candidate + 1)?.line?.startMs
    val exclusiveEnd = maxOf(
      current.line.startMs,
      current.line.endMs,
      nextStart ?: Long.MIN_VALUE,
    )
    return current.lineIndex.takeIf { positionMs < exclusiveEnd }
  }

  private fun move(delta: Int): MinutesTranscriptSearchState {
    if (state.matches.isEmpty()) return state.copy(selectedIndex = -1)
    val size = state.matches.size
    val current = state.selectedIndex.takeIf { it in state.matches.indices } ?: 0
    state = state.copy(selectedIndex = Math.floorMod(current + delta, size))
    return state
  }

  private fun search(
    query: String,
    selected: MinutesTranscriptMatch?,
  ): MinutesTranscriptSearchState {
    val normalizedQuery = normalize(query)
    if (normalizedQuery.isBlank()) return MinutesTranscriptSearchState(query = query)
    val matches = ArrayList<MinutesTranscriptMatch>(minOf(maximumMatches, 32))
    var truncated = false
    outer@ for ((lineIndex, line) in lines.withIndex()) {
      val normalized = searchableLines.getOrNull(lineIndex) ?: normalizeWithOriginalRanges(line.text)
      var fromIndex = 0
      while (fromIndex <= normalized.value.length - normalizedQuery.length) {
        val found = normalized.value.indexOf(normalizedQuery, fromIndex)
        if (found < 0) break
        val end = found + normalizedQuery.length
        val originalRange = normalized.originalRange(found, end)
        if (originalRange != null) {
          if (matches.size >= maximumMatches) {
            truncated = true
            break@outer
          }
          matches += MinutesTranscriptMatch(lineIndex, line.id, originalRange)
        }
        fromIndex = maxOf(found + normalizedQuery.length, found + 1)
      }
    }
    val selectedIndex = when {
      matches.isEmpty() -> -1
      selected == null -> 0
      else -> matches.indexOfFirst { it == selected }.takeIf { it >= 0 } ?: 0
    }
    return MinutesTranscriptSearchState(query, matches, selectedIndex, truncated)
  }

  private data class TimelineEntry(
    val lineIndex: Int,
    val line: MinutesTranscriptLine,
  )

  private data class NormalizedMappedText(
    val value: String,
    val originalStarts: IntArray,
    val originalEnds: IntArray,
  ) {
    fun originalRange(start: Int, end: Int): MinutesTextRange? {
      if (start !in originalStarts.indices || end <= start || end - 1 !in originalEnds.indices) return null
      return MinutesTextRange(originalStarts[start], originalEnds[end - 1])
    }
  }

  private fun normalizeWithOriginalRanges(value: String): NormalizedMappedText {
    if (value.isEmpty()) return NormalizedMappedText("", IntArray(0), IntArray(0))
    val normalized = StringBuilder(value.length)
    val starts = ArrayList<Int>(value.length)
    val ends = ArrayList<Int>(value.length)
    val iterator = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(value) }
    var start = iterator.first()
    var end = iterator.next()
    while (end != BreakIterator.DONE) {
      val fragment = normalize(value.substring(start, end))
      normalized.append(fragment)
      repeat(fragment.length) {
        starts += start
        ends += end
      }
      start = end
      end = iterator.next()
    }
    return NormalizedMappedText(
      normalized.toString(),
      starts.toIntArray(),
      ends.toIntArray(),
    )
  }

  private fun normalize(value: String): String =
    Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase(Locale.ROOT)

  companion object {
    private const val MAX_QUERY_LENGTH = 200
  }
}
