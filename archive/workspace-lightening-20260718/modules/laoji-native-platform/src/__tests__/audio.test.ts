jest.mock('expo-modules-core', () => ({
  NativeModule: class NativeModule {},
  requireOptionalNativeModule: () => null,
}));

import {
  assertNativeRecorderDeploymentPolicy,
  isNativeRecorderStopComplete,
  normalizeNativeLocalRecorderStartOptions,
  normalizeNativeRecorderStartOptions,
  resolveNativeRecorderInsecureDevelopment,
  validateNativeRecorderWebSocketUrl,
} from '../audio';

describe('native recorder transport contract', () => {
  it('rejects insecure transport by default', () => {
    expect(() => validateNativeRecorderWebSocketUrl('ws://dev.example/ws/meeting/1/qwen'))
      .toThrow(/must be wss/);
  });

  it('allows ws only when development explicitly opts in', () => {
    expect(validateNativeRecorderWebSocketUrl(
      'ws://dev.example:18020/ws/meeting/meeting-1/qwen',
      true,
    )).toBe('ws://dev.example:18020/ws/meeting/meeting-1/qwen');
    expect(validateNativeRecorderWebSocketUrl(
      'wss://realtime.example/ws/meeting/meeting-1/qwen',
    )).toBe('wss://realtime.example/ws/meeting/meeting-1/qwen');
  });

  it.each([
    'ws://user:password@dev.example/ws/meeting/1/qwen',
    'ws://dev.example/ws/meeting/1/qwen?token=secret',
    'ws://dev.example/ws/meeting/1/qwen#fragment',
    'ws://dev.example/ws/meeting/1/qwen?',
    'ws://dev.example/ws/meeting/1/qwen#',
  ])('rejects credential-bearing or ambiguous development URL %s', (url) => {
    expect(() => validateNativeRecorderWebSocketUrl(url, true)).toThrow();
  });

  it('defaults the start option to secure-only and preserves an explicit development opt-in', () => {
    expect(normalizeNativeRecorderStartOptions({
      sessionId: 'meeting-secure',
      purpose: 'meeting',
      websocketUrl: 'wss://realtime.example/ws/meeting/meeting-secure/qwen',
      accessToken: ' bearer-token ',
    })).toEqual(expect.objectContaining({
      allowInsecureDevelopment: false,
      accessToken: 'bearer-token',
    }));

    expect(normalizeNativeRecorderStartOptions({
      sessionId: 'meeting-dev',
      purpose: 'meeting',
      websocketUrl: 'ws://dev.example:18020/ws/meeting/meeting-dev/qwen',
      guestToken: 'guest-token',
      allowInsecureDevelopment: true,
    })).toEqual(expect.objectContaining({
      allowInsecureDevelopment: true,
      guestToken: 'guest-token',
    }));
  });

  it('forbids production callers from enabling insecure development transport', () => {
    expect(() => assertNativeRecorderDeploymentPolicy(true, true)).toThrow(/production/);
    expect(() => assertNativeRecorderDeploymentPolicy(true, false)).not.toThrow();
    expect(() => assertNativeRecorderDeploymentPolicy(false, true)).not.toThrow();
    expect(resolveNativeRecorderInsecureDevelopment(true, false)).toBe(false);
    expect(resolveNativeRecorderInsecureDevelopment(false, false)).toBe(true);
    expect(resolveNativeRecorderInsecureDevelopment(false, true)).toBe(false);
  });

  it('normalizes local-only recording without transport or credentials', () => {
    const normalized = normalizeNativeLocalRecorderStartOptions(
      ' speaker-enrollment-1 ',
      { levelIntervalMs: 250 },
    );

    expect(normalized).toEqual({
      sessionId: 'speaker-enrollment-1',
      levelIntervalMs: 250,
    });
    expect(normalized).not.toHaveProperty('websocketUrl');
    expect(normalized).not.toHaveProperty('accessToken');
    expect(normalized).not.toHaveProperty('guestToken');
  });

  it('applies the same bounded level interval contract to local-only recording', () => {
    expect(() => normalizeNativeLocalRecorderStartOptions('speaker-1', { levelIntervalMs: 49 }))
      .toThrow(/levelIntervalMs/);
    expect(() => normalizeNativeLocalRecorderStartOptions('speaker-1', { levelIntervalMs: 1_001 }))
      .toThrow(/levelIntervalMs/);
  });

  it('does not require ready_to_stop for a completed local-only recording', () => {
    const localResult = {
      status: 'completed' as const,
      localSaved: true,
      readyToStop: false,
      localUri: 'file:///speaker.wav',
      errorCode: null,
      errorMessage: null,
      audioBars: [],
      snapshot: {
        sessionId: 'speaker-1',
        purpose: 'speaker' as const,
        mode: 'localOnly' as const,
        state: 'localSaved' as const,
        startedAtMs: 1,
        updatedAtMs: 2,
        bytesRecorded: 3_200,
        durationMs: 100,
        localUri: 'file:///speaker.wav',
        asrConnected: false,
        asrRequired: false,
        readyToStop: false,
        transcriptRecoveryRequired: false,
        errorCode: null,
        errorMessage: null,
      },
    };

    expect(isNativeRecorderStopComplete(localResult)).toBe(true);
    expect(isNativeRecorderStopComplete({
      ...localResult,
      snapshot: { ...localResult.snapshot, asrRequired: true, mode: 'realtime' },
    })).toBe(false);
  });
});
