export interface ClientRequestState {
  id: string;
  fingerprint: string;
}

let requestCounter = 0;

export function createClientRequestId(prefix: string): string {
  requestCounter = (requestCounter + 1) % 0x100000;
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16) || 'request';
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${safePrefix}:${timestamp}:${requestCounter.toString(36)}:${random}`;
}

export function createClientRequestState(prefix: string): ClientRequestState {
  return { id: createClientRequestId(prefix), fingerprint: '' };
}

export function requestStateForPayload(
  previous: ClientRequestState,
  prefix: string,
  payload: unknown,
): ClientRequestState {
  const fingerprint = JSON.stringify(payload);
  if (!previous.fingerprint || previous.fingerprint === fingerprint) {
    return { ...previous, fingerprint };
  }
  return { id: createClientRequestId(prefix), fingerprint };
}
