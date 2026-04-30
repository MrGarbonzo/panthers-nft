export interface SwapQuote {
  fromToken: string;
  toToken: string;
  fromAmountUsdc: number;
  toAmountToken: number;
  estimatedPriceUsdc: number;
  priceImpactPct: number;
  gasEstimate: number;
}

export interface OneInchClientParams {
  baseNetwork: 'base' | 'base-sepolia';
  x402ApiUrl?: string;
}

const CHAIN_IDS: Record<string, number> = {
  'base': 8453,
  'base-sepolia': 84532,
};

export class OneInchClient {
  private readonly chainId: number;
  private readonly isMock: boolean;
  private readonly x402ApiUrl: string | undefined;

  constructor(params: OneInchClientParams) {
    this.chainId = CHAIN_IDS[params.baseNetwork]!;
    this.isMock = params.baseNetwork === 'base-sepolia';
    this.x402ApiUrl = params.x402ApiUrl;
  }

  async getPrice(tokenAddress: string): Promise<number> {
    // Try x402 price API first if configured
    if (this.x402ApiUrl) {
      try {
        const res = await fetch(`${this.x402ApiUrl}/price/${tokenAddress}`, {
          headers: { 'X-Payment-Required': 'true' },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = (await res.json()) as { priceUsdc?: number };
          if (data.priceUsdc !== undefined) return data.priceUsdc;
        }
      } catch {
        // Fall through to 1inch
      }
    }

    if (this.isMock) {
      // Return a mock price for testnet
      console.log(`[1inch-mock] getPrice(${tokenAddress.slice(0, 10)}...): returning mock`);
      return 0;
    }

    try {
      const url = `https://api.1inch.dev/price/v1.1/${this.chainId}/${tokenAddress}?currency=USD`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        console.error(`[1inch] Price API ${res.status}: ${await res.text()}`);
        return 0;
      }
      const data = (await res.json()) as Record<string, string>;
      const price = Number(data[tokenAddress.toLowerCase()]);
      return isFinite(price) ? price : 0;
    } catch (err) {
      console.error('[1inch] Price fetch failed:', err);
      return 0;
    }
  }

  async getSwapQuote(params: {
    fromToken: string;
    toToken: string;
    amountWei: bigint;
    slippagePct: number;
  }): Promise<SwapQuote> {
    if (this.isMock) {
      console.log(
        `[1inch-mock] getSwapQuote: ${params.fromToken.slice(0, 10)}→${params.toToken.slice(0, 10)} amount=${params.amountWei}`,
      );
      return {
        fromToken: params.fromToken,
        toToken: params.toToken,
        fromAmountUsdc: Number(params.amountWei) / 1e6,
        toAmountToken: 0,
        estimatedPriceUsdc: 0,
        priceImpactPct: 0,
        gasEstimate: 0,
      };
    }

    try {
      const url =
        `https://api.1inch.dev/swap/v6.0/${this.chainId}/quote` +
        `?src=${params.fromToken}&dst=${params.toToken}` +
        `&amount=${params.amountWei.toString()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        throw new Error(`1inch quote ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as {
        dstAmount?: string;
        gas?: number;
      };
      const dstAmount = BigInt(data.dstAmount ?? '0');
      return {
        fromToken: params.fromToken,
        toToken: params.toToken,
        fromAmountUsdc: Number(params.amountWei) / 1e6,
        toAmountToken: Number(dstAmount),
        estimatedPriceUsdc: Number(params.amountWei) / 1e6,
        priceImpactPct: 0,
        gasEstimate: data.gas ?? 0,
      };
    } catch (err) {
      console.error('[1inch] Quote failed:', err);
      return {
        fromToken: params.fromToken,
        toToken: params.toToken,
        fromAmountUsdc: Number(params.amountWei) / 1e6,
        toAmountToken: 0,
        estimatedPriceUsdc: 0,
        priceImpactPct: 0,
        gasEstimate: 0,
      };
    }
  }

  async executeSwap(params: {
    fromToken: string;
    toToken: string;
    amountWei: bigint;
    slippagePct: number;
    walletClient: any;
    publicClient: any;
  }): Promise<{ txHash: string }> {
    if (this.isMock) {
      const mockHash = `0xmock_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
      console.log(
        `[1inch-mock] executeSwap: ${params.fromToken.slice(0, 10)}→${params.toToken.slice(0, 10)} amount=${params.amountWei} → ${mockHash}`,
      );
      return { txHash: mockHash };
    }

    try {
      const account = params.walletClient.account;
      const url =
        `https://api.1inch.dev/swap/v6.0/${this.chainId}/swap` +
        `?src=${params.fromToken}&dst=${params.toToken}` +
        `&amount=${params.amountWei.toString()}` +
        `&from=${account.address}` +
        `&slippage=${params.slippagePct}` +
        `&disableEstimate=true`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        throw new Error(`1inch swap ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as {
        tx?: { to?: string; data?: string; value?: string; gas?: number };
      };
      if (!data.tx?.to || !data.tx?.data) {
        throw new Error('1inch swap response missing tx data');
      }

      const txHash = await params.walletClient.sendTransaction({
        to: data.tx.to as `0x${string}`,
        data: data.tx.data as `0x${string}`,
        value: BigInt(data.tx.value ?? '0'),
        gas: data.tx.gas ? BigInt(data.tx.gas) : undefined,
      });

      await params.publicClient.waitForTransactionReceipt({ hash: txHash });
      return { txHash };
    } catch (err) {
      console.error('[1inch] Swap execution failed:', err);
      throw err;
    }
  }
}
