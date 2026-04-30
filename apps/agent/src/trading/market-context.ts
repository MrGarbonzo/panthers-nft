import { TRADING_TOKENS } from './tokens.js';

const DEFAULT_REFRESH_MS = 30 * 60 * 1000; // 30 min — Mycelia price polls
const SENTIMENT_REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours — GenVox sentiment
const NEWS_REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours — Gloria news

export interface CoinSnapshot {
  priceUsd: number;
  change24hPct: number;
}

export interface FearGreedSnapshot {
  value: number;
  classification: string;
}

export interface SentimentSnapshot {
  coin: string;
  signal: string; // BULLISH / BEARISH / NEUTRAL
  score: number;
  confidence: number;
  summary: string;
  fetchedAt: number;
}

export interface NewsSnapshot {
  headlines: string[];
  fetchedAt: number;
}

export interface MarketSnapshot {
  coins: Record<string, CoinSnapshot>;
  fearGreed: FearGreedSnapshot | null;
  sentiment: SentimentSnapshot[];
  news: NewsSnapshot | null;
  lastUpdatedAt: number;
}

/**
 * x402 fetch function — calls fetchWithPayment on the x402 client.
 * Injected from index.ts so market-context doesn't import idiostasis directly.
 */
export type X402Fetcher = (url: string) => Promise<Response>;

export interface MarketContextParams {
  coingeckoApiKey?: string;
  x402Fetcher?: X402Fetcher;
  refreshMs?: number;
}

// Mycelia Signal price endpoints
const MYCELIA_PRICES: Record<string, string> = {
  'ethereum': 'https://api.myceliasignal.com/oracle/price/eth/usd',
  'wrapped-bitcoin': 'https://api.myceliasignal.com/oracle/price/btc/usd',
};

// GenVox sentiment tokens
const GENVOX_TOKENS = ['ETH', 'BTC'];

// Coingecko IDs from trading tokens (fallback)
const COINGECKO_COINS: string[] = [
  ...new Set(TRADING_TOKENS.map((t) => t.coingeckoId)),
];

export class MarketContext {
  private snapshot: MarketSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sentimentTimer: NodeJS.Timeout | null = null;
  private newsTimer: NodeJS.Timeout | null = null;
  private lastSentiment: SentimentSnapshot[] = [];
  private lastNews: NewsSnapshot | null = null;

  constructor(private readonly params: MarketContextParams) {}

  async start(): Promise<void> {
    if (this.timer) return;
    const interval = this.params.refreshMs ?? DEFAULT_REFRESH_MS;
    await this.safeRefresh();
    this.timer = setInterval(() => void this.safeRefresh(), interval);

    // Sentiment and news on slower cadence
    if (this.params.x402Fetcher) {
      void this.safeSentimentRefresh();
      this.sentimentTimer = setInterval(() => void this.safeSentimentRefresh(), SENTIMENT_REFRESH_MS);
      void this.safeNewsRefresh();
      this.newsTimer = setInterval(() => void this.safeNewsRefresh(), NEWS_REFRESH_MS);
    }

    const source = this.params.x402Fetcher ? 'x402 (Mycelia)' : 'CoinGecko';
    console.log(`MarketContext started (refresh ${Math.round(interval / 1000)}s, source: ${source})`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.sentimentTimer) { clearInterval(this.sentimentTimer); this.sentimentTimer = null; }
    if (this.newsTimer) { clearInterval(this.newsTimer); this.newsTimer = null; }
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

  private async safeSentimentRefresh(): Promise<void> {
    try {
      this.lastSentiment = await this.fetchGenVoxSentiment();
    } catch (err) {
      console.error('[market] GenVox sentiment failed:', err);
    }
  }

  private async safeNewsRefresh(): Promise<void> {
    try {
      this.lastNews = await this.fetchGloriaNews();
    } catch (err) {
      console.error('[market] Gloria news failed:', err);
    }
  }

  private async refresh(): Promise<void> {
    let coins: Record<string, CoinSnapshot>;

    // Try x402 Mycelia Signal first, fall back to CoinGecko
    if (this.params.x402Fetcher) {
      try {
        coins = await this.fetchMyceliaSignal();
        // If all prices are 0, x402 payment likely failed — try CoinGecko fallback
        const hasData = Object.values(coins).some((c) => c.priceUsd > 0);
        if (!hasData && this.params.coingeckoApiKey) {
          console.warn('[market] Mycelia returned all zeros — falling back to CoinGecko');
          coins = await this.fetchCoinGecko();
        }
      } catch (err) {
        console.error('[market] Mycelia failed, trying CoinGecko fallback:', err);
        if (this.params.coingeckoApiKey) {
          coins = await this.fetchCoinGecko();
        } else {
          throw err;
        }
      }
    } else if (this.params.coingeckoApiKey) {
      coins = await this.fetchCoinGecko();
    } else {
      throw new Error('No price source configured');
    }

    // Derive sentiment-based fear/greed from GenVox data
    const fearGreed = this.deriveFearGreed();

    this.snapshot = {
      coins,
      fearGreed,
      sentiment: this.lastSentiment,
      news: this.lastNews,
      lastUpdatedAt: Date.now(),
    };
    const eth = coins['ethereum'];
    const btc = coins['wrapped-bitcoin'];
    console.log(
      `[market] ETH $${eth?.priceUsd.toFixed(2) ?? '?'} ` +
        `BTC $${btc?.priceUsd.toFixed(0) ?? '?'} ` +
        `F&G ${fearGreed ? `${fearGreed.value} (${fearGreed.classification})` : 'n/a'}`,
    );
  }

  // ── Mycelia Signal (x402) ──

  private async fetchMyceliaSignal(): Promise<Record<string, CoinSnapshot>> {
    const fetcher = this.params.x402Fetcher!;
    const out: Record<string, CoinSnapshot> = {};

    const results = await Promise.allSettled(
      Object.entries(MYCELIA_PRICES).map(async ([coinId, url]) => {
        const res = await fetcher(url);
        const text = await res.text();
        let price = 0;
        try {
          const data = JSON.parse(text) as { price?: string; canonical?: string; pair?: string };
          if (data.price) {
            price = Number(data.price);
          } else if (data.canonical) {
            // Mycelia canonical format: v1|PRICE|ETHUSD|2260.58|USD|2|sources...|method|timestamp|nonce
            const parts = data.canonical.split('|');
            price = Number(parts[3] ?? 0);
          }
        } catch {
          console.error(`[market] Mycelia parse error for ${coinId}: ${text.slice(0, 200)}`);
        }
        if (price === 0) {
          console.warn(`[market] Mycelia ${coinId}: price=0 (response: ${text.slice(0, 200)})`);
        }
        return { coinId, price };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        out[result.value.coinId] = {
          priceUsd: result.value.price,
          change24hPct: 0,
        };
      } else {
        console.error(`[market] Mycelia fetch failed:`, result.reason);
      }
    }

    // Fill in any trading tokens not covered by Mycelia with price 0
    for (const token of TRADING_TOKENS) {
      if (!out[token.coingeckoId]) {
        out[token.coingeckoId] = { priceUsd: 0, change24hPct: 0 };
      }
    }

    return out;
  }

  // ── GenVox Sentiment (x402) ──

  private async fetchGenVoxSentiment(): Promise<SentimentSnapshot[]> {
    const fetcher = this.params.x402Fetcher;
    if (!fetcher) return [];

    const results = await Promise.allSettled(
      GENVOX_TOKENS.map(async (coin) => {
        const res = await fetcher(`https://api.genvox.io/v1/sentiment/${coin}`);
        const data = (await res.json()) as {
          signal?: string;
          score?: number;
          confidence?: number;
          summary?: string;
        };
        return {
          coin,
          signal: data.signal ?? 'NEUTRAL',
          score: data.score ?? 50,
          confidence: data.confidence ?? 0,
          summary: data.summary ?? '',
          fetchedAt: Date.now(),
        } as SentimentSnapshot;
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<SentimentSnapshot> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  // ── Gloria AI News (x402) ──

  private async fetchGloriaNews(): Promise<NewsSnapshot | null> {
    const fetcher = this.params.x402Fetcher;
    if (!fetcher) return null;

    const res = await fetcher(
      'https://api.itsgloria.ai/news?feed_categories=crypto',
    );
    const data = (await res.json()) as {
      articles?: { title?: string }[];
      news?: { title?: string }[];
    };

    const articles = data.articles ?? data.news ?? [];
    const headlines = articles
      .slice(0, 10)
      .map((a) => a.title ?? '')
      .filter(Boolean);

    return { headlines, fetchedAt: Date.now() };
  }

  // ── Derive Fear/Greed from GenVox sentiment ──

  private deriveFearGreed(): FearGreedSnapshot | null {
    if (this.lastSentiment.length === 0) {
      return null;
    }
    // Average the sentiment scores — GenVox returns 0-100 range
    const avgScore = this.lastSentiment.reduce((sum, s) => sum + s.score, 0) / this.lastSentiment.length;
    let classification = 'Neutral';
    if (avgScore >= 75) classification = 'Extreme Greed';
    else if (avgScore >= 55) classification = 'Greed';
    else if (avgScore <= 25) classification = 'Extreme Fear';
    else if (avgScore <= 45) classification = 'Fear';
    return { value: Math.round(avgScore), classification };
  }

  // ── CoinGecko fallback ──

  private async fetchCoinGecko(): Promise<Record<string, CoinSnapshot>> {
    const url =
      'https://api.coingecko.com/api/v3/simple/price' +
      `?ids=${COINGECKO_COINS.join(',')}` +
      '&vs_currencies=usd' +
      '&include_24hr_change=true';
    const res = await fetch(url, {
      headers: { 'x-cg-demo-api-key': this.params.coingeckoApiKey! },
    });
    if (!res.ok) {
      throw new Error(`CoinGecko ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as Record<
      string,
      { usd?: number; usd_24h_change?: number }
    >;
    const out: Record<string, CoinSnapshot> = {};
    for (const coin of COINGECKO_COINS) {
      const entry = data[coin];
      out[coin] = {
        priceUsd: entry?.usd ?? 0,
        change24hPct: entry?.usd_24h_change ?? 0,
      };
    }
    return out;
  }
}
