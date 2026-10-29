import type { HardwareBleDevice, HardwareConnectionState, HardwareRecordingPreview } from 'laoji-native-platform';

export type HardwareDeviceRow = Pick<HardwareBleDevice, 'locator' | 'transport' | 'productName' | 'compatible'>;

/** A connected board can stop advertising. Re-entering the page must project
 * the native connection, not falsely show an empty discovery result. */
export function hardwareDeviceRows(
  discovered: readonly HardwareBleDevice[], connection: HardwareConnectionState | null,
): HardwareDeviceRow[] {
  if (!connection?.deviceId || !connection.locator || connection.transport !== 'ble'
    || !['ready','recording','paused','finalizing','transferring'].includes(connection.phase)
    || discovered.some(device => device.locator === connection.locator)) return [...discovered];
  return [{ locator: connection.locator, transport: 'ble', productName: connection.model || '录音设备', compatible: true }, ...discovered];
}

/** Device directory order is not recency. Unknown dates and equal timestamps
 * stay stable; titles/renames are not sort signals. Source IDs remain intact. */
export function orderHardwareCatalog(entries: readonly HardwareRecordingPreview[]): HardwareRecordingPreview[] {
  const time = (entry: HardwareRecordingPreview) => {
    const value = entry.createdEpochMs;
    return value != null && Number.isFinite(value) && value > 0 ? value : 0;
  };
  return entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => time(b.entry) - time(a.entry) || a.index - b.index)
    .map(item => item.entry);
}
