import {
  meetingAudioInputLabel,
  meetingAudioLevelPercent,
  meetingAudioInputStatus,
} from '../src/utils/meetingAudioStatus';

describe('meeting audio input status', () => {
  it.each([
    [0, 'waiting', '正在录音 · 等待说话'],
    [100, 'quiet', '正在录音 · 声音偏小，请靠近手机'],
    [900, 'clear', '正在录音 · 收音正常'],
    [5000, 'loud', '正在录音 · 声音较大'],
  ] as const)('maps raw RMS %s to a user-facing status', (rms, status, label) => {
    expect(meetingAudioInputStatus(rms)).toBe(status);
    expect(meetingAudioInputLabel(rms)).toBe(label);
  });

  it('treats invalid input as waiting instead of exposing technical values', () => {
    expect(meetingAudioInputLabel(Number.NaN)).toBe('正在录音 · 等待说话');
  });

  it('maps raw microphone volume to a bounded visual level', () => {
    expect(meetingAudioLevelPercent(Number.NaN)).toBe(0);
    expect(meetingAudioLevelPercent(0)).toBe(0);
    expect(meetingAudioLevelPercent(1250)).toBe(50);
    expect(meetingAudioLevelPercent(5000)).toBe(100);
  });
});
