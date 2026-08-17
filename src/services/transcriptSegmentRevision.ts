import type { TranscriptSegmentRecord } from '../data/repositories';

function sameTextRevision(
  left: TranscriptSegmentRecord,
  right: TranscriptSegmentRecord,
): boolean {
  return left.id === right.id
    && left.sourceId === right.sourceId
    && left.sourceRecordingAssetId === right.sourceRecordingAssetId
    && left.sourceRecordingAssetRemoteId === right.sourceRecordingAssetRemoteId
    && left.sourceTranscriptionJobId === right.sourceTranscriptionJobId
    && left.ordinal === right.ordinal
    && left.startMs === right.startMs
    && left.endMs === right.endMs
    && left.text === right.text
    && left.normalizedText === right.normalizedText
    && left.confidence === right.confidence
    && left.textState === right.textState
    && left.isFinal === right.isFinal;
}

/** Adds monotonic segment revisions to legacy snapshots that predate the vNext wire contract. */
export function projectLegacyTranscriptSegmentRevisions(
  previous: readonly TranscriptSegmentRecord[],
  candidate: readonly TranscriptSegmentRecord[],
): readonly TranscriptSegmentRecord[] {
  const previousByKey = new Map(previous.map(segment => [segment.stableSegmentKey, segment]));
  return candidate.map(segment => {
    const prior = previousByKey.get(segment.stableSegmentKey);
    if (!prior) return segment;
    const required = prior.segmentRevision + (sameTextRevision(prior, segment) ? 0 : 1);
    return required === segment.segmentRevision
      ? segment
      : { ...segment, segmentRevision: Math.max(segment.segmentRevision, required) };
  });
}
