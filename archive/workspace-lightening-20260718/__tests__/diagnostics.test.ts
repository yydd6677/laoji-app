import {
  diagnosticInfo,
  diagnosticWarn,
  diagnosticsEnabled,
} from '../src/services/diagnostics';

describe('release diagnostics boundary', () => {
  const runtime = globalThis as typeof globalThis & { __DEV__?: boolean };
  const originalDev = runtime.__DEV__;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    runtime.__DEV__ = originalDev;
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('emits no diagnostic payloads in a production runtime', () => {
    runtime.__DEV__ = false;

    diagnosticInfo('meetingId=private-meeting');
    diagnosticWarn('websocket failed', new Error('Bearer sensitive-token'));

    expect(diagnosticsEnabled()).toBe(false);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps useful diagnostics in development without passing native Error objects', () => {
    runtime.__DEV__ = true;
    const error = new Error('connection failed');

    diagnosticInfo('connecting');
    diagnosticWarn('websocket failed', error);

    expect(infoSpy).toHaveBeenCalledWith('connecting');
    expect(warnSpy).toHaveBeenCalledWith('websocket failed', 'Error: connection failed');
    expect(warnSpy).not.toHaveBeenCalledWith('websocket failed', error);
  });
});
