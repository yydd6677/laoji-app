import { Share } from 'react-native';
import type { MarkerRecord } from "../data/repositories/meetingNoteRepository";
import type { TranscriptLine } from '../types';
import { formatNativeMinutesTimestamp } from '../native/nativeMinutesSnapshots';
import { speakerDisplayLabel } from '../utils/speakerLabels';

function finiteSeconds(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function transcriptLineNearMarker(
  marker: MarkerRecord,
  transcript: readonly TranscriptLine[],
): TranscriptLine | null {
  const lines = transcript.filter(line => line.text.trim());
  const exact = marker.nearestSegmentId
    ? lines.find(line => line.id === marker.nearestSegmentId)
    : null;
  if (exact) return exact;
  const positionSec = marker.positionMs / 1_000;
  const ranked = lines
    .map((line, ordinal) => {
      const start = finiteSeconds(line.start_time);
      const end = finiteSeconds(line.end_time) ?? start;
      const distance = start === null
        ? Number.POSITIVE_INFINITY
        : positionSec < start
          ? start - positionSec
          : end !== null && positionSec > end
            ? positionSec - end
            : 0;
      return { line, ordinal, distance };
    })
    .sort((left, right) => left.distance - right.distance || left.ordinal - right.ordinal);
  return ranked[0]?.line ?? null;
}

export function meetingMarkerShareText(
  marker: MarkerRecord,
  transcript: readonly TranscriptLine[],
): string {
  const timestamp = formatNativeMinutesTimestamp(marker.positionMs / 1_000);
  const nearby = transcriptLineNearMarker(marker, transcript);
  if (!nearby) return `标记 ${timestamp}`;
  const speaker = speakerDisplayLabel(nearby.speaker_label, nearby.speaker_id);
  return `标记 ${timestamp}\n${speaker}：${nearby.text.trim()}`;
}

export async function shareMeetingMarkerText(
  marker: MarkerRecord,
  transcript: readonly TranscriptLine[],
): Promise<void> {
  await Share.share(
    { message: meetingMarkerShareText(marker, transcript), title: '会议标记' },
    { dialogTitle: '分享会议标记' },
  );
}
