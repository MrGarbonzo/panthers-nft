import { defaultPanthersState, type PanthersState } from '../state/schema.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { PublicCacheWriter } from '../public/cache.js';
import type { StorageBackend } from './storage-backend.js';

export class PanthersDb {
  constructor(private readonly backend: StorageBackend) {}

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
    const value = this.backend.getConfig('solana_keypair');
    if (value === null) return null;
    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  setSolanaKeypairBytes(bytes: Uint8Array): void {
    const encoded = Buffer.from(bytes).toString('base64');
    this.backend.setConfig('solana_keypair', encoded);
  }

  getFeePct(): number {
    const value = this.backend.getConfig('fee_pct');
    if (value === null) return 0.02;
    return parseFloat(value);
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
