import { ProtocolDatabase } from '@idiostasis/core';
import type { StorageBackend } from './storage-backend.js';

export class IdiostasisStorageBackend implements StorageBackend {
  private readonly db: ProtocolDatabase;

  constructor(dbPath: string, vaultKey: Uint8Array) {
    this.db = new ProtocolDatabase(dbPath, vaultKey);
  }

  getAgentState(): Uint8Array | null {
    return this.db.getAgentState();
  }

  setAgentState(blob: Uint8Array): void {
    this.db.setAgentState(blob);
  }

  getConfig(key: string): string | null {
    return this.db.getConfig(key);
  }

  setConfig(key: string, value: string): void {
    this.db.setConfig(key, value);
  }
}
