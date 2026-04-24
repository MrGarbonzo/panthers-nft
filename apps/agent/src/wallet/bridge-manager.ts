import type { CctpBridge } from './cctp-bridge.js';
import type { WalletMonitor } from '../persona/wallet-monitor.js';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { PublicCacheWriter } from '../public/cache.js';

const DEFAULT_CHECK_MS = 30 * 60 * 1000;

export class BridgeManager {
  private bridgeInProgress = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly params: {
      bridge: CctpBridge;
      walletMonitor: WalletMonitor;
      db: PanthersDb;
      adapter: PanthersStateAdapter;
      cacheWriter: PublicCacheWriter;
      agentBaseWallet: string;
      dailyBurnRate: number;
      checkIntervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.params.checkIntervalMs ?? DEFAULT_CHECK_MS;
    this.timer = setInterval(() => void this.safeCheck(), interval);
    console.log(
      `BridgeManager started (check ${Math.round(interval / 1000)}s)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async safeCheck(): Promise<void> {
    try {
      await this.check();
    } catch (err) {
      console.error('BridgeManager check failed:', err);
      this.bridgeInProgress = false;
    }
  }

  private async check(): Promise<void> {
    if (this.bridgeInProgress) return;
    if (!this.params.agentBaseWallet) return;

    const balances = this.params.walletMonitor.getBalances();
    const baseRunwayDays =
      this.params.dailyBurnRate > 0
        ? balances.baseUsdcBalance / this.params.dailyBurnRate
        : 999;

    if (baseRunwayDays > 14) return;
    if (balances.solanaUsdcBalance < 10) {
      console.log(
        '[BridgeManager] Insufficient Solana USDC to bridge',
      );
      return;
    }

    const bridgeAmount = Math.min(
      30 * this.params.dailyBurnRate,
      balances.solanaUsdcBalance * 0.2,
    );

    console.log(
      `[BridgeManager] Base runway ${baseRunwayDays.toFixed(1)} days — bridging ${bridgeAmount.toFixed(2)} USDC`,
    );

    this.bridgeInProgress = true;

    try {
      const result = await this.params.bridge.bridgeSolanaToBase({
        amountUsdc: bridgeAmount,
        destinationAddress: this.params.agentBaseWallet,
      });

      let attempts = 0;
      const maxAttempts = 30;
      while (attempts < maxAttempts) {
        const status = await this.params.bridge.checkAttestation(
          result.messageHash,
        );
        if (status === 'complete') break;
        await new Promise((r) => setTimeout(r, 60_000));
        attempts++;
      }

      console.log('[BridgeManager] CCTP bridge settled.');
    } finally {
      this.bridgeInProgress = false;
    }
  }
}
