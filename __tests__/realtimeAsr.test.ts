import {
  applyPcmAutoGain,
  base64ToArrayBuffer,
  buildRealtimeAsrUrl,
  buildRealtimeWavFileName,
  parseRealtimeAsrMessage,
  selectRealtimeScheduleText,
} from '../src/services/realtimeAsr';

describe('realtime ASR helpers', () => {
  it('builds the default realtime websocket URL with the default server', () => {
    expect(buildRealtimeAsrUrl({ meetingId: 'meeting-1' })).toBe(
      'ws://183.36.243.124:18020/ws/meeting/meeting-1/funasr',
    );
  });

  it('normalizes host protocols and preserves explicit ports', () => {
    expect(buildRealtimeAsrUrl({
      meetingId: 'a/b',
      provider: 'whisper',
      host: 'https://example.com:9443/',
      secure: true,
    })).toBe('wss://example.com:9443/ws/meeting/a%2Fb/whisper');
  });

  it('creates a unique safe WAV file name for each meeting', () => {
    expect(buildRealtimeWavFileName('meeting/2026 07 10')).toBe('meeting_2026_07_10.wav');
    expect(buildRealtimeWavFileName('')).toBe('laoji-realtime.wav');
  });

  it('decodes base64 PCM chunks to ArrayBuffer', () => {
    const bytes = new Uint8Array(base64ToArrayBuffer('AQIDBA=='));
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('parses transcript messages from the realtime ASR server', () => {
    expect(parseRealtimeAsrMessage(JSON.stringify({
      type: 'transcript.completed',
      text: '明天下午三点开会',
      speaker_name: 'speaker_1',
    }))).toEqual(expect.objectContaining({
      type: 'transcript.completed',
      text: '明天下午三点开会',
    }));
  });

  it('ignores non-JSON websocket messages', () => {
    expect(parseRealtimeAsrMessage('not-json')).toBeNull();
    expect(parseRealtimeAsrMessage(new ArrayBuffer(0))).toBeNull();
  });

  it('amplifies quiet PCM frames without clipping int16 samples', () => {
    const input = samplesToBuffer([100, -200, 300, -400]);
    const result = applyPcmAutoGain(input, 12000, 16);
    const output = bufferToSamples(result.buffer);

    expect(result.gain).toBeGreaterThan(1);
    expect(result.sent.peak).toBeGreaterThan(result.raw.peak);
    expect(Math.max(...output)).toBeLessThanOrEqual(32767);
    expect(Math.min(...output)).toBeGreaterThanOrEqual(-32768);
  });

  it('selects the most schedule-like realtime transcript chunk', () => {
    expect(selectRealtimeScheduleText([
      '没有没有没有没有没有证据。',
      '下午三点开会。',
      '下午三十点开会。',
    ])).toBe('下午三点开会');
  });

  it('prefers a transcript refinement that restores the date phrase', () => {
    expect(selectRealtimeScheduleText([
      '下午三点开会。',
      '明天下午三点开会。',
    ])).toBe('明天下午三点开会');
  });

  it('prefers the latest equivalent schedule candidate while recording', () => {
    expect(selectRealtimeScheduleText([
      '下午三点开会。',
      '下午四点开会。',
    ])).toBe('下午四点开会');
  });

  it('repairs common clipped temporal prefixes from realtime ASR', () => {
    expect(selectRealtimeScheduleText(['天下午三点开会。'])).toBe('明天下午三点开会');
    expect(selectRealtimeScheduleText(['午三点开会。'])).toBe('下午三点开会');
  });
});

function samplesToBuffer(samples: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, sample, true);
  });
  return buffer;
}

function bufferToSamples(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  const samples: number[] = [];
  for (let offset = 0; offset + 1 < view.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}
