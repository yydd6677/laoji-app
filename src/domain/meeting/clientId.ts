import * as Crypto from 'expo-crypto';

export interface ClientIdFactory {
  create(): string;
}

export const secureClientIdFactory: ClientIdFactory = {
  create(): string {
    const id = Crypto.randomUUID();
    if (!id) throw new Error('secure meeting ID generation failed');
    return id;
  },
};
