type TranscriptLike = {
  start_time?: number;
  end_time?: number;
  confidence?: number;
  text?: string;
};

type ResumableMeetingLike = {
  status?: string;
  audioAvailable?: boolean;
  audioLocalUri?: string | null;
};

type RemoteMeetingIdentityLike = {
  id: string;
  remoteId?: string | null;
  source?: 'cloud' | 'guest';
};

const MEETING_STATUS_PRIORITY = [
  '上传受阻',
  '待上传',
  '待同步',
  '录音中',
  '录音已暂停',
  '处理中',
  '失败',
  '已完成',
  '未开始',
] as const;

// MIN-PLAYER-001: matches the Feishu 7.71.8 speed picker contract.
export const MEETING_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export function nextMeetingPlaybackRate(current: number): number {
  const index = MEETING_PLAYBACK_RATES.findIndex(rate => Math.abs(rate - current) < 0.001);
  return MEETING_PLAYBACK_RATES[(index + 1 + MEETING_PLAYBACK_RATES.length)
    % MEETING_PLAYBACK_RATES.length];
}

export function canResumeMeetingRecording(meeting: ResumableMeetingLike): boolean {
  if (meeting.audioAvailable || meeting.audioLocalUri) return false;
  return ['created', 'recording', 'failed'].includes(meeting.status ?? 'created');
}

export function meetingRemoteIdentity(meeting: RemoteMeetingIdentityLike): string | null {
  if (Object.prototype.hasOwnProperty.call(meeting, 'remoteId')) {
    return meeting.remoteId?.trim() || null;
  }
  // Legacy account cache rows predate remoteId and used the server ID as id.
  return meeting.source === 'cloud' ? meeting.id.trim() || null : null;
}

export function requireMeetingRemoteIdentity(meeting: RemoteMeetingIdentityLike): string {
  const remoteId = meetingRemoteIdentity(meeting);
  if (!remoteId) throw new Error('会议正在同步，请稍后重试。');
  return remoteId;
}

export function preferredMeetingStatusLabel(tags: ReadonlyArray<{ label: string }>): string {
  return MEETING_STATUS_PRIORITY.find(label => tags.some(tag => tag.label === label))
    ?? tags[0]?.label
    ?? '';
}

export function latestTranscriptWindow<T>(items: T[], maxItems = 40): {
  items: T[];
  hiddenCount: number;
} {
  const limit = Number.isFinite(maxItems) ? Math.max(1, Math.floor(maxItems)) : 40;
  const hiddenCount = Math.max(0, items.length - limit);
  return {
    items: hiddenCount > 0 ? items.slice(hiddenCount) : items,
    hiddenCount,
  };
}

export function shouldCheckpointTranscript(
  nextLineCount: number,
  lastCheckpointLineCount: number,
  elapsedSinceCheckpointMs: number,
  lineInterval = 4,
  maxDelayMs = 10_000,
): boolean {
  if (!Number.isFinite(nextLineCount) || nextLineCount <= 0) return false;
  if (!Number.isFinite(lastCheckpointLineCount) || lastCheckpointLineCount <= 0) return true;
  const unsavedLines = nextLineCount - lastCheckpointLineCount;
  return unsavedLines >= Math.max(1, Math.floor(lineInterval))
    || elapsedSinceCheckpointMs >= Math.max(0, maxDelayMs);
}

export function transcriptDurationSec(items: TranscriptLike[]): number | undefined {
  const end = items.reduce((max, item) => {
    const value = typeof item.end_time === 'number' ? item.end_time : 0;
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  return end > 0 ? end : undefined;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—';
  // Native playback clocks advance only after a complete second. Keep list and
  // detail durations on that same floor-based clock.
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function pcmDurationSec(
  byteCount: number,
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16,
): number | undefined {
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!Number.isFinite(byteCount) || byteCount <= 0 || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return undefined;
  }
  return byteCount / bytesPerSecond;
}

export function audioSamplesToBars(samples: number[], count = 50): number[] {
  const usable = samples.filter(value => Number.isFinite(value) && value >= 0);
  if (usable.length === 0 || count <= 0) return [];

  const outputCount = Math.min(count, usable.length);
  const bars = Array.from({ length: outputCount }, (_, index) => {
    const start = Math.floor((index * usable.length) / outputCount);
    const end = Math.max(start + 1, Math.floor(((index + 1) * usable.length) / outputCount));
    return Math.max(...usable.slice(start, end));
  });
  const peak = Math.max(...bars, 1);
  return bars.map(value => Math.max(0.04, Math.min(1, value / peak)));
}

export function shouldReplayAudio(positionMs: number, durationMs: number, toleranceMs = 250): boolean {
  return Number.isFinite(positionMs)
    && Number.isFinite(durationMs)
    && durationMs > 0
    && positionMs >= durationMs - Math.max(0, toleranceMs);
}
