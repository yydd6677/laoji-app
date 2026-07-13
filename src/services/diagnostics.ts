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
