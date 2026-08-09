import type { ScopeKey } from './entities';

/**
 * The local SQLite schema still accepts the historical `guest` scope key for
 * backwards-compatible migrations.  In the accountless product that key does
 * not mean an anonymous network session: it is the installation's device/data
 * epoch.  Keep the wire-compatible value in `scope`, but make the runtime
 * ownership and network path explicit in audit events so a log cannot be read
 * as proof that a legacy guest endpoint was called.
 */
export function scopeTelemetry(
  scopeKey: ScopeKey,
  networkPath: 'none' | 'device-v1' | 'account-api',
): {
  scope: 'guest' | 'account';
  scope_kind: 'device-local' | 'account';
  network_path: 'none' | 'device-v1' | 'account-api';
} {
  const deviceLocal = scopeKey === 'guest';
  return {
    // Keep the old field stable for existing log parsers.
    scope: deviceLocal ? 'guest' : 'account',
    // `guest` is only a compatibility label in the accountless build.
    scope_kind: deviceLocal ? 'device-local' : 'account',
    network_path: networkPath,
  };
}
