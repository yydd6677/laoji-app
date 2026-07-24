import type { TranscriptLine } from '../types';

export type TranscriptCandidateKind = 'realtime_draft' | 'final' | 'reprocessed';
export type TranscriptServerCompleteness = 'complete' | 'incomplete' | 'unknown';

export interface TranscriptComparableRow {
  text: string;
  startMs?: number | null;
  endMs?: number | null;
}

export interface TranscriptCoverage {
  latestTimeMs: number;
  textCodePoints: number;
  nonEmptySegments: number;
}

export type TranscriptRegressionSignal = 'latest_time' | 'text' | 'segments';

export interface TranscriptCandidateDecision {
  useCandidate: boolean;
  completing: boolean;
  clearlyShorter: boolean;
  reason:
    | 'candidate_empty'
    | 'no_baseline'
    | 'candidate_incomplete'
    | 'candidate_clearly_shorter'
    | 'candidate_accepted';
  baseline: TranscriptCoverage;
  candidate: TranscriptCoverage;
  regressionSignals: readonly TranscriptRegressionSignal[];
}

export interface EvaluateTranscriptCandidateOptions {
  candidateKind: TranscriptCandidateKind;
  serverCompleteness?: TranscriptServerCompleteness;
}

function finiteNonNegative(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function visibleCodePointLength(value: string): number {
  return Array.from(value.normalize('NFKC').replace(/\s+/gu, '')).length;
}

function ratio(candidate: number, baseline: number): number {
  return baseline > 0 ? candidate / baseline : 1;
}

export function transcriptCoverage(rows: readonly TranscriptComparableRow[]): TranscriptCoverage {
  let latestTimeMs = 0;
  let textCodePoints = 0;
  let nonEmptySegments = 0;
  rows.forEach(row => {
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (!text) return;
    nonEmptySegments += 1;
    textCodePoints += visibleCodePointLength(text);
    latestTimeMs = Math.max(
      latestTimeMs,
      finiteNonNegative(row.startMs),
      finiteNonNegative(row.endMs),
    );
  });
  return { latestTimeMs, textCodePoints, nonEmptySegments };
}

export function transcriptLineCoverage(lines: readonly TranscriptLine[]): TranscriptCoverage {
  return transcriptCoverage(lines.map(line => ({
    text: line.text,
    startMs: finiteNonNegative(line.start_time) * 1000,
    endMs: finiteNonNegative(line.end_time) * 1000,
  })));
}

/**
 * [PRODUCT] A final revision must not replace a more complete readable draft.
 * [INFERENCE] The thresholds intentionally require corroborating regressions,
 * except for an extreme loss of time or text coverage. Segment count alone is
 * never decisive because a final ASR pass may merge draft segments.
 */
export function evaluateTranscriptCandidate(
  baselineRows: readonly TranscriptComparableRow[],
  candidateRows: readonly TranscriptComparableRow[],
  options: EvaluateTranscriptCandidateOptions,
): TranscriptCandidateDecision {
  const baseline = transcriptCoverage(baselineRows);
  const candidate = transcriptCoverage(candidateRows);
  const serverCompleteness = options.serverCompleteness ?? 'unknown';
  const completing = options.candidateKind === 'realtime_draft'
    || serverCompleteness === 'incomplete';

  if (candidate.nonEmptySegments === 0) {
    return {
      useCandidate: baseline.nonEmptySegments === 0,
      completing,
      clearlyShorter: baseline.nonEmptySegments > 0,
      reason: 'candidate_empty',
      baseline,
      candidate,
      regressionSignals: baseline.nonEmptySegments > 0 ? ['segments'] : [],
    };
  }
  if (baseline.nonEmptySegments === 0) {
    return {
      useCandidate: true,
      completing,
      clearlyShorter: false,
      reason: 'no_baseline',
      baseline,
      candidate,
      regressionSignals: [],
    };
  }

  const timeRatio = ratio(candidate.latestTimeMs, baseline.latestTimeMs);
  const textRatio = ratio(candidate.textCodePoints, baseline.textCodePoints);
  const segmentRatio = ratio(candidate.nonEmptySegments, baseline.nonEmptySegments);
  const latestTimeRegression = baseline.latestTimeMs >= 15_000
    && baseline.latestTimeMs - candidate.latestTimeMs >= 8_000
    && timeRatio < 0.8;
  const textRegression = baseline.textCodePoints >= 16
    && baseline.textCodePoints - candidate.textCodePoints >= 8
    && textRatio < 0.75;
  const segmentRegression = baseline.nonEmptySegments >= 3
    && baseline.nonEmptySegments - candidate.nonEmptySegments >= 2
    && segmentRatio < 0.6;
  const regressionSignals: TranscriptRegressionSignal[] = [];
  if (latestTimeRegression) regressionSignals.push('latest_time');
  if (textRegression) regressionSignals.push('text');
  if (segmentRegression) regressionSignals.push('segments');

  const criticalTimeRegression = baseline.latestTimeMs >= 20_000
    && baseline.latestTimeMs - candidate.latestTimeMs >= 10_000
    && timeRatio < 0.5;
  const criticalTextRegression = baseline.textCodePoints >= 12
    && baseline.textCodePoints - candidate.textCodePoints >= 8
    && textRatio < 0.4;
  const clearlyShorter = criticalTimeRegression
    || criticalTextRegression
    || regressionSignals.length >= 2;

  if (clearlyShorter) {
    return {
      useCandidate: false,
      completing: true,
      clearlyShorter: true,
      reason: 'candidate_clearly_shorter',
      baseline,
      candidate,
      regressionSignals,
    };
  }
  return {
    useCandidate: true,
    completing,
    clearlyShorter: false,
    reason: completing ? 'candidate_incomplete' : 'candidate_accepted',
    baseline,
    candidate,
    regressionSignals,
  };
}

export function evaluateTranscriptLineCandidate(
  baseline: readonly TranscriptLine[],
  candidate: readonly TranscriptLine[],
  options: EvaluateTranscriptCandidateOptions,
): TranscriptCandidateDecision {
  return evaluateTranscriptCandidate(
    baseline.map(line => ({
      text: line.text,
      startMs: finiteNonNegative(line.start_time) * 1000,
      endMs: finiteNonNegative(line.end_time) * 1000,
    })),
    candidate.map(line => ({
      text: line.text,
      startMs: finiteNonNegative(line.start_time) * 1000,
      endMs: finiteNonNegative(line.end_time) * 1000,
    })),
    options,
  );
}

export function transcriptServerCompletenessFromPayload(
  payload: unknown,
): TranscriptServerCompleteness {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'unknown';
  const record = payload as Record<string, unknown>;
  const declared = record.is_complete ?? record.complete ?? record.final;
  if (declared === true) return 'complete';
  if (declared === false) return 'incomplete';
  const status = typeof record.transcript_status === 'string'
    ? record.transcript_status
    : typeof record.status === 'string'
      ? record.status
      : '';
  const normalized = status.trim().toLowerCase();
  if (['complete', 'completed', 'final', 'ready', 'success', 'succeeded'].includes(normalized)) {
    return 'complete';
  }
  if (['partial', 'pending', 'processing', 'transcribing', 'finalizing', 'running'].includes(normalized)) {
    return 'incomplete';
  }
  return 'unknown';
}

export function combineTranscriptServerCompleteness(
  current: TranscriptServerCompleteness,
  next: TranscriptServerCompleteness,
): TranscriptServerCompleteness {
  if (current === 'incomplete' || next === 'incomplete') return 'incomplete';
  if (current === 'complete' || next === 'complete') return 'complete';
  return 'unknown';
}
