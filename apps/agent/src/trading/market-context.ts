const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const COINS = ['solana', 'bitcoin', 'ethereum'] as const;
type Coin = (typeof COINS)[number];

export interface CoinSnapshot {
  priceUsd: number;
  change24hPct: number;
}

export interface FearGreedSnapshot {
  value: number;
  classification: string;
}

export interface MarketSnapshot {
  coins: Record<Coin, CoinSnapshot>;
  fearGreed: FearGreedSnapshot | null;
  lastUpdatedAt: number;
}

export interface MarketContextParams {
  coingeckoApiKey: string;
  refreshMs?: number;
}

export class MarketContext {
  private snapshot: MarketSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly params: MarketContextParams) {}

  async start(): Promise<void> {
    if (this.timer) return;
    const interval = this.params.refreshMs ?? DEFAULT_REFRESH_MS;
    await this.safeRefresh();
    this.timer = setInterval(() => void this.safeRefresh(), interval);
    console.log(
      `MarketContext started (refresh ${Math.round(interval / 1000)}s)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): MarketSnapshot | null {
    return this.snapshot;
  }

  private async safeRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      console.error('MarketContext refresh failed:', err);
    }
  }

  private async refresh(): Promise<void> {
    const [coins, fearGreed] = await Promise.all([
      this.fetchCoinGecko(),
      this.fetchFearGreed(),
    ]);
    this.snapshot = {
      coins,
      fearGreed,
      lastUpdatedAt: Date.now(),
    };
    const sol = coins.solana;
    console.log(
      `MarketContext: SOL $${sol.priceUsd.toFixed(2)} (${sol.change24hPct >= 0 ? '+' : ''}${sol.change24hPct.toFixed(2)}%) ` +
        `F&G ${fearGreed ? `${fearGreed.value} (${fearGreed.classification})` : 'n/a'}`,
    );
  }

  private async fetchCoinGecko(): Promise<Record<Coin, CoinSnapshot>> {
    const url =
      'https://api.coingecko.com/api/v3/simple/price' +
      `?ids=${COINS.join(',')}` +
      '&vs_currencies=usd' +
      '&include_24hr_change=true';
    const res = await fetch(url, {
      headers: { 'x-cg-demo-api-key': this.params.coingeckoApiKey },
    });
    if (!res.ok) {
      throw new Error(`CoinGecko ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as Record<
      string,
      { usd?: number; usd_24h_change?: number }
    >;
    const out = {} as Record<Coin, CoinSnapshot>;
    for (const coin of COINS) {
      const entry = data[coin];
      out[coin] = {
        priceUsd: entry?.usd ?? 0,
        change24hPct: entry?.usd_24h_change ?? 0,
      };
    }
    return out;
  }

  private async fetchFearGreed(): Promise<FearGreedSnapshot | null> {
    try {
      const res = await fetch('https://api.alternative.me/fng/?limit=1');
      if (!res.ok) return null;
      const data = (await res.json()) as {
        data?: { value?: string; value_classification?: string }[];
      };
      const latest = data.data?.[0];
      if (!latest || !latest.value) return null;
      return {
        value: Number(latest.value),
        classification: latest.value_classification ?? 'unknown',
      };
    } catch {
      return null;
    }
  }
}
