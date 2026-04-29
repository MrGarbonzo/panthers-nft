import { Connection } from '@solana/web3.js';

const QN_BASE_URL = 'https://x402.quicknode.com';

export interface X402ConnectionResult {
  connection: Connection;
  wsUrl: string;
}

/**
 * Create a Solana Connection using QuickNode x402.
 * Pays for RPC calls with Base Sepolia USDC via the EVM wallet.
 */
export async function createX402Connection(
  evmPrivateKey: string,
  network: 'solana-devnet' | 'solana-mainnet' = 'solana-devnet',
): Promise<X402ConnectionResult> {
  const { createQuicknodeX402Client } = await import('@quicknode/x402');

  const paymentNetwork = 'eip155:84532';
  const hexKey = (evmPrivateKey.startsWith('0x') ? evmPrivateKey : `0x${evmPrivateKey}`) as `0x${string}`;

  const client = await createQuicknodeX402Client({
    baseUrl: QN_BASE_URL,
    network: paymentNetwork,
    evmPrivateKey: hexKey,
    paymentModel: 'credit-drawdown',
    preAuth: true,
  });

  const rpcUrl = `${QN_BASE_URL}/${network}`;

  // Wrap client.fetch to work with @solana/web3.js Connection
  // Connection calls fetch(url, options) but the x402 client needs to intercept 402 responses
  const x402Fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    return client.fetch(url, init);
  };

  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    fetch: x402Fetch as any,
  });

  const wsUrl = rpcUrl.replace('https://', 'wss://');

  console.log(`[x402-rpc] Connected to QuickNode x402 (${network}, paying on Base Sepolia)`);

  return { connection, wsUrl };
}
