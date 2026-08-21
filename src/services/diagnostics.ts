declare const __DEV__: boolean;

export function diagnosticsEnabled(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

export function diagnosticInfo(message: string): void {
  if (diagnosticsEnabled()) console.info(message);
}

export function diagnosticWarn(message: string, error?: unknown): void {
  if (!diagnosticsEnabled()) return;
  if (error instanceof Error) {
    console.warn(message, `${error.name}: ${error.message}`);
    return;
  }
  console.warn(message);
}

type DiagnosticAuditValue = string | number | boolean | null;

function safeDiagnosticString(value: string): string {
  if (/^[a-z0-9_.-]{1,120}$/i.test(value)) return value;
  // Content-addressed identities are explicitly allowed by the vNext
  // privacy contract. They identify equality across attempts without
  // exposing the transcript, title, person, file name or object key.
  if (/^sha256:[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  return '[redacted]';
}

export function diagnosticAudit(
  event: string,
  fields: Readonly<Record<string, DiagnosticAuditValue>>,
): void {
  const safeEvent = event.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);
  const payload = Object.entries(fields).reduce<Record<string, DiagnosticAuditValue>>((result, [key, value]) => {
    const safeKey = key.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);
    if (safeKey) {
      result[safeKey] = typeof value === 'string'
        ? safeDiagnosticString(value)
        : value;
    }
    return result;
  }, {});
  console.info(`[laoji-audit] ${safeEvent} ${JSON.stringify(payload)}`);
}
