import { defaultPanthersState, type PanthersState } from '../state/schema.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { PublicCacheWriter } from '../public/cache.js';
import type { StorageBackend } from './storage-backend.js';
import { ConfigStore } from './config-store.js';
import { CONFIG } from './config-keys.js';

export class PanthersDb {
  public readonly config: ConfigStore;

  constructor(private readonly backend: StorageBackend) {
    this.config = new ConfigStore(backend);
  }

  async loadState(adapter: PanthersStateAdapter): Promise<PanthersState> {
    const blob = this.backend.getAgentState();
    if (blob === null) {
      return defaultPanthersState();
    }
    await adapter.deserialize(blob);
    return adapter.getState();
  }

  async saveState(
    state: PanthersState,
    adapter: PanthersStateAdapter,
    cacheWriter?: PublicCacheWriter,
  ): Promise<void> {
    adapter.setState(state);
    const blob = await adapter.serialize();
    this.backend.setAgentState(blob);
    if (cacheWriter) {
      try {
        await cacheWriter.write(state);
      } catch (err) {
        console.error('Public cache write failed:', err);
      }
    }
  }

  getSolanaKeypairBytes(): Uint8Array | null {
    const value = this.config.get(CONFIG.SOLANA_KEYPAIR);
    if (value === null) return null;
    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  setSolanaKeypairBytes(bytes: Uint8Array): void {
    this.config.set(CONFIG.SOLANA_KEYPAIR, Buffer.from(bytes).toString('base64'));
  }

  getFeePct(): number {
    const value = this.config.get(CONFIG.FEE_PCT_ON_BURN, {
      envKey: 'FEE_PCT_ON_BURN',
      defaultValue: '0.02',
    });
    return value !== null ? parseFloat(value) : 0.02;
  }

  expireStalePendingSales(state: PanthersState): PanthersState {
    const now = Date.now();
    let changed = false;
    const nextPendingSales = { ...state.pendingSales };
    for (const [id, sale] of Object.entries(state.pendingSales)) {
      if (sale.status === 'awaiting_payment' && sale.expiresAt < now) {
        nextPendingSales[id] = { ...sale, status: 'expired' };
        changed = true;
      }
    }
    if (!changed) return state;
    return { ...state, pendingSales: nextPendingSales };
  }
}
