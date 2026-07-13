export type MeetingAudioInputStatus = 'waiting' | 'quiet' | 'clear' | 'loud';

export function meetingAudioInputStatus(rawRms: number): MeetingAudioInputStatus {
  if (!Number.isFinite(rawRms) || rawRms < 40) return 'waiting';
  if (rawRms < 180) return 'quiet';
  if (rawRms < 3500) return 'clear';
  return 'loud';
}

export function meetingAudioInputLabel(rawRms: number): string {
  const status = meetingAudioInputStatus(rawRms);
  if (status === 'waiting') return '正在录音 · 等待说话';
  if (status === 'quiet') return '正在录音 · 声音偏小，请靠近手机';
  if (status === 'loud') return '正在录音 · 声音较大';
  return '正在录音 · 收音正常';
}

export function meetingAudioLevelPercent(rawRms: number): number {
  if (!Number.isFinite(rawRms) || rawRms <= 0) return 0;
  return Math.min(100, Math.round((rawRms / 2500) * 100));
}
