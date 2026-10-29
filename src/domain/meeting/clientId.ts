import * as Crypto from 'expo-crypto';
import { createNativeRandomUuid } from 'laoji-native-platform';

export interface ClientIdFactory {
  create(): string;
}

export const secureClientIdFactory: ClientIdFactory = {
  create(): string {
    let id: string | null = null;
    try {
      id = Crypto.randomUUID() || null;
    } catch {
      // The native UUID path is the only permitted fallback; never use time or Math.random.
    }
    if (!id) id = createNativeRandomUuid();
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error('secure meeting ID generation failed');
    }
    return id.toLowerCase();
  },
};

export function createSecureAssetGeneration(): string {
  return secureClientIdFactory.create().replace(/-/g, '');
}
