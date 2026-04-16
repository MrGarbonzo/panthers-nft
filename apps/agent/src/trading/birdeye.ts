export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const BASE_URL = 'https://public-api.birdeye.so';

export interface OhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  liquidity: number;
  volume24h: number;
}

interface BirdeyeEnvelope<T> {
  success?: boolean;
  data?: T;
}

export class BirdeyeClient {
  constructor(private readonly apiKey: string) {}

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'X-API-Key': this.apiKey,
        'x-chain': 'solana',
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Birdeye ${path} failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as BirdeyeEnvelope<T>;
    if (body.success === false || body.data === undefined) {
      throw new Error(`Birdeye ${path} returned unsuccessful payload`);
    }
    return body.data;
  }

  async getOhlcv(tokenMint: string, limit = 50): Promise<OhlcvCandle[]> {
    const nowSec = Math.floor(Date.now() / 1000);
    const type = '15m';
    const fromSec = nowSec - limit * 15 * 60;
    const path =
      `/defi/ohlcv?address=${tokenMint}&type=${type}` +
      `&time_from=${fromSec}&time_to=${nowSec}`;
    const data = await this.request<{
      items: Array<{
        unixTime: number;
        o: number;
        h: number;
        l: number;
        c: number;
        v: number;
      }>;
    }>(path);
    const items = data.items ?? [];
    return items.slice(-limit).map((it) => ({
      timestamp: it.unixTime,
      open: it.o,
      high: it.h,
      low: it.l,
      close: it.c,
      volume: it.v,
    }));
  }

  async getTop10Tokens(): Promise<TokenInfo[]> {
    const data = await this.request<{
      tokens?: Array<{
        address: string;
        symbol: string;
        name: string;
        liquidity: number;
        volume_24h_usd?: number;
        v24hUSD?: number;
      }>;
    }>(`/defi/v3/token/list?sort_by=v24hUSD&sort_type=desc&limit=10`);
    const tokens = data.tokens ?? [];
    return tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      liquidity: t.liquidity,
      volume24h: t.volume_24h_usd ?? t.v24hUSD ?? 0,
    }));
  }

  async getCurrentPrice(tokenMint: string): Promise<number> {
    const data = await this.request<{ value: number }>(
      `/defi/price?address=${tokenMint}`,
    );
    return data.value;
  }

  async getTokenInfo(tokenMint: string): Promise<TokenInfo> {
    const data = await this.request<{
      address: string;
      symbol: string;
      name: string;
      liquidity: number;
      v24hUSD?: number;
      volume24hUSD?: number;
    }>(`/defi/token_overview?address=${tokenMint}`);
    return {
      address: data.address,
      symbol: data.symbol,
      name: data.name,
      liquidity: data.liquidity,
      volume24h: data.v24hUSD ?? data.volume24hUSD ?? 0,
    };
  }
}
