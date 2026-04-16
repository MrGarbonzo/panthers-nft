import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import { createJupiterApiClient, type SwapApi } from '@jup-ag/api';

const USDC_DECIMALS = 1_000_000;

export interface SwapResult {
  txSignature: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amountUsdc: number;
  slippageBps?: number;
}

export class JupiterClient {
  private readonly api: SwapApi;

  constructor(
    private readonly connection: Connection,
    private readonly agentKeypair: Keypair,
  ) {
    this.api = createJupiterApiClient();
  }

  async getQuote(
    params: QuoteParams,
  ): Promise<{ outAmount: number; priceImpactPct: number } | null> {
    const atomicAmount = BigInt(Math.floor(params.amountUsdc * USDC_DECIMALS));
    try {
      const quote = await this.api.quoteGet({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: Number(atomicAmount),
        slippageBps: params.slippageBps ?? 50,
      });
      if (!quote.outAmount) return null;
      return {
        outAmount: Number(quote.outAmount),
        priceImpactPct: Number(quote.priceImpactPct ?? 0),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('COULD_NOT_FIND_ANY_ROUTE') ||
        msg.includes('no route')
      ) {
        return null;
      }
      return null;
    }
  }

  async executeSwap(params: QuoteParams): Promise<SwapResult> {
    const atomicAmount = BigInt(Math.floor(params.amountUsdc * USDC_DECIMALS));

    const quote = await this.api.quoteGet({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: Number(atomicAmount),
      slippageBps: params.slippageBps ?? 50,
    });
    if (!quote.outAmount) {
      throw new Error('Jupiter executeSwap: no route available');
    }

    const swap = await this.api.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: this.agentKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    });

    const txBuf = Buffer.from(swap.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([this.agentKeypair]);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    const latest = await this.connection.getLatestBlockhash('confirmed');
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed',
    );

    return {
      txSignature: signature,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inputAmount: params.amountUsdc,
      outputAmount: Number(quote.outAmount),
      priceImpactPct: Number(quote.priceImpactPct ?? 0),
    };
  }
}
