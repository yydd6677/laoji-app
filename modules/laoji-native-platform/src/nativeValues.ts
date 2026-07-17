// UI-OVERLAY-WINDOW-001: Expo's Kotlin converter accepts null but not JavaScript undefined.

export type NativeBridgeValue =
  | null
  | boolean
  | number
  | string
  | NativeBridgeValue[]
  | { [key: string]: NativeBridgeValue };

export function compactNativeBridgeValue(value: unknown): NativeBridgeValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const result: NativeBridgeValue[] = [];
    for (const item of value) {
      const compacted = compactNativeBridgeValue(item);
      if (compacted !== undefined) result.push(compacted);
    }
    return result;
  }
  if (typeof value === 'object') {
    const result: { [key: string]: NativeBridgeValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const compacted = compactNativeBridgeValue(item);
      if (compacted !== undefined) result[key] = compacted;
    }
    return result;
  }
  return undefined;
}

export function compactNativeOverlaySnapshot(snapshot: object): { [key: string]: NativeBridgeValue } {
  return compactNativeBridgeValue(snapshot) as { [key: string]: NativeBridgeValue };
}
