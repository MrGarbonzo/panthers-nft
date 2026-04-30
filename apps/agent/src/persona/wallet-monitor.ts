const DEFAULT_POLL_MS = 5 * 60 * 1000;

export interface WalletBalances {
  baseUsdcBalance: number;
  baseBalanceUpdatedAt: number;
}

export class WalletMonitor {
  private balances: WalletBalances = {
    baseUsdcBalance: 0,
    baseBalanceUpdatedAt: 0,
  };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly params: {
      evmWalletAddress: string;
      usdcAddress: string;
      rpcUrl: string;
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
      await this.pollBaseUsdc();
    } catch (err) {
      console.error('WalletMonitor Base poll failed:', err);
    }
  }

  private async pollBaseUsdc(): Promise<void> {
    const calldata =
      '0x70a08231000000000000000000000000' +
      this.params.evmWalletAddress.slice(2).padStart(64, '0');
    try {
      const res = await fetch(this.params.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: this.params.usdcAddress, data: calldata }, 'latest'],
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
