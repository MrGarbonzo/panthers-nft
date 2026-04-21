import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { v4 as uuidv4 } from 'uuid';

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

interface X402PaymentRequired {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: { feePayer?: string };
  }>;
}

export interface BirdeyeClientParams {
  keypair: Keypair;
  connection: Connection;
  onSpend?: (amountUsdc: number) => void;
}

export class BirdeyeClient {
  private readonly keypair: Keypair;
  private readonly connection: Connection;
  private readonly onSpend: (amountUsdc: number) => void;

  constructor(params: BirdeyeClientParams) {
    this.keypair = params.keypair;
    this.connection = params.connection;
    this.onSpend = params.onSpend ?? (() => {});
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${BASE_URL}/x402${path}`;
    const res = await fetch(url, {
      headers: { 'x-chain': 'solana', accept: 'application/json' },
    });

    if (res.status === 402) {
      const paid = await this.handlePayment(res, url);
      const body = (await paid.json()) as BirdeyeEnvelope<T>;
      if (body.success === false || body.data === undefined) {
        throw new Error(`Birdeye ${path} returned unsuccessful after payment`);
      }
      return body.data;
    }

    if (!res.ok) {
      throw new Error(`Birdeye ${path} failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as BirdeyeEnvelope<T>;
    if (body.success === false || body.data === undefined) {
      throw new Error(`Birdeye ${path} returned unsuccessful payload`);
    }
    return body.data;
  }

  private async handlePayment(
    res: Response,
    originalUrl: string,
  ): Promise<Response> {
    const headerValue = res.headers.get('PAYMENT-REQUIRED');
    if (!headerValue) throw new Error('x402: missing PAYMENT-REQUIRED header');

    const decoded = JSON.parse(
      Buffer.from(headerValue, 'base64').toString(),
    ) as X402PaymentRequired;

    const accept = decoded.accepts?.find(
      (a) => a.scheme === 'exact' && a.network?.startsWith('solana:'),
    );
    if (!accept) throw new Error('x402: no compatible Solana payment scheme');

    const amount = BigInt(accept.amount);
    const payTo = new PublicKey(accept.payTo);
    const asset = new PublicKey(accept.asset);

    const sourceAta = getAssociatedTokenAddressSync(
      asset,
      this.keypair.publicKey,
    );
    const destAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.keypair,
      asset,
      payTo,
    );

    const paymentId = `pay_${uuidv4().replace(/-/g, '').slice(0, 20)}`;

    const tx = new Transaction().add(
      createTransferInstruction(
        sourceAta,
        destAta.address,
        this.keypair.publicKey,
        amount,
      ),
    );

    const sig = await sendAndConfirmTransaction(this.connection, tx, [
      this.keypair,
    ]);
    const amountUsdc = Number(amount) / 1_000_000;
    this.onSpend(amountUsdc);
    console.log(
      `[Birdeye x402] Paid ${amountUsdc} USDC (tx: ${sig.slice(0, 8)}...)`,
    );

    const paymentPayload = {
      x402Version: decoded.x402Version,
      scheme: accept.scheme,
      network: accept.network,
      payload: {
        signature: sig,
        extensions: {
          'payment-identifier': { id: paymentId },
        },
      },
    };

    const retryRes = await fetch(originalUrl, {
      headers: {
        'x-chain': 'solana',
        accept: 'application/json',
        'PAYMENT-RESPONSE': Buffer.from(
          JSON.stringify(paymentPayload),
        ).toString('base64'),
      },
    });

    if (!retryRes.ok && retryRes.status !== 200) {
      throw new Error(`x402: retry after payment failed: ${retryRes.status}`);
    }
    return retryRes;
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
