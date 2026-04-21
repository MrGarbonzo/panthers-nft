import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const DEFAULT_POLL_MS = 5 * 60 * 1000;

export interface WalletBalances {
  solanaUsdcBalance: number;
  baseUsdcBalance: number;
  solanaBalanceUpdatedAt: number;
  baseBalanceUpdatedAt: number;
}

export class WalletMonitor {
  private balances: WalletBalances = {
    solanaUsdcBalance: 0,
    baseUsdcBalance: 0,
    solanaBalanceUpdatedAt: 0,
    baseBalanceUpdatedAt: 0,
  };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly params: {
      connection: Connection;
      agentWallet: string;
      usdcMintSolana: string;
      evmWalletAddress?: string;
      pollIntervalMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.safePoll();
    const interval = this.params.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.timer = setInterval(() => void this.safePoll(), interval);
    console.log(`WalletMonitor started (poll ${Math.round(interval / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getBalances(): WalletBalances {
    return { ...this.balances };
  }

  private async safePoll(): Promise<void> {
    try {
      await this.pollSolanaUsdc();
    } catch (err) {
      console.error('WalletMonitor Solana poll failed:', err);
    }
    try {
      await this.pollBaseUsdc();
    } catch (err) {
      console.error('WalletMonitor Base poll failed:', err);
    }
  }

  private async pollSolanaUsdc(): Promise<void> {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(this.params.usdcMintSolana),
      new PublicKey(this.params.agentWallet),
    );
    try {
      const info = await this.params.connection.getTokenAccountBalance(ata);
      this.balances.solanaUsdcBalance = info.value.uiAmount ?? 0;
    } catch {
      this.balances.solanaUsdcBalance = 0;
    }
    this.balances.solanaBalanceUpdatedAt = Date.now();
  }

  private async pollBaseUsdc(): Promise<void> {
    if (!this.params.evmWalletAddress) return;
    const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const BASE_RPC = 'https://mainnet.base.org';
    const calldata =
      '0x70a08231000000000000000000000000' +
      this.params.evmWalletAddress.slice(2).padStart(64, '0');
    try {
      const res = await fetch(BASE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: BASE_USDC, data: calldata }, 'latest'],
        }),
      });
      const json = (await res.json()) as { result?: string };
      if (json.result) {
        const raw = BigInt(json.result);
        this.balances.baseUsdcBalance = Number(raw) / 1_000_000;
      }
    } catch {
      // Base balance unchanged on error
    }
    this.balances.baseBalanceUpdatedAt = Date.now();
  }
}
