import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const QN_BASE_URL = 'https://x402.quicknode.com';

export interface X402ConnectionResult {
  connection: Connection;
  wsUrl: string;
}

/**
 * Create a Solana Connection using QuickNode x402 pay-per-request.
 * No API key needed — agent pays for each RPC call with Solana USDC.
 */
export async function createX402Connection(
  keypair: Keypair,
  network: 'solana-devnet' | 'solana-mainnet' = 'solana-devnet',
): Promise<X402ConnectionResult> {
  const { createQuicknodeX402Client } = await import('@quicknode/x402');

  // Solana mainnet CAIP-2 network ID
  const paymentNetwork = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const svmPrivateKey = bs58.encode(keypair.secretKey);

  const client = await createQuicknodeX402Client({
    baseUrl: QN_BASE_URL,
    network: paymentNetwork,
    svmPrivateKey,
    paymentModel: 'credit-drawdown',
    preAuth: true,
  });

  const rpcUrl = `${QN_BASE_URL}/${network}`;

  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    fetch: client.fetch as any,
  });

  // WebSocket URL from the x402 client
  const wsUrl = rpcUrl.replace('https://', 'wss://');

  console.log(`[x402-rpc] Connected to QuickNode x402 (${network})`);

  return { connection, wsUrl };
}
