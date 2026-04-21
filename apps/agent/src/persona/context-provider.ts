import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { WalletMonitor } from './wallet-monitor.js';
import type { SurvivalContext } from './survival.js';
import { buildSurvivalContext } from './survival-context.js';

export class PersonaContextProvider {
  constructor(
    private readonly params: {
      db: PanthersDb;
      adapter: PanthersStateAdapter;
      walletMonitor: WalletMonitor;
      dailyBurnRate: number;
      firstBootAt: number;
      agentWallet: string;
    },
  ) {}

  get agentWallet(): string {
    return this.params.agentWallet;
  }

  async getSurvivalContext(): Promise<SurvivalContext> {
    const state = await this.params.db.loadState(this.params.adapter);
    return buildSurvivalContext({
      state,
      balances: this.params.walletMonitor.getBalances(),
      dailyBurnRate: this.params.dailyBurnRate,
      firstBootAt: this.params.firstBootAt,
    });
  }
}
