import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';

export interface BaseRpcClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chain: Chain;
  account: ReturnType<typeof mnemonicToAccount>;
}

const CHAINS: Record<string, Chain> = {
  'base': base,
  'base-sepolia': baseSepolia,
};

const QN_ENDPOINTS: Record<string, string> = {
  'base': 'https://x402.quicknode.com/base-mainnet',
  'base-sepolia': 'https://x402.quicknode.com/base-sepolia',
};

const PUBLIC_ENDPOINTS: Record<string, string> = {
  'base': 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
};

/**
 * Create Base RPC clients.
 * If evmPrivateKey is provided, uses QuickNode x402 (pay-per-request).
 * Otherwise, falls back to free public endpoint.
 */
export async function createBaseRpcClients(
  mnemonic: string,
  network: 'base' | 'base-sepolia' = 'base-sepolia',
  useX402 = true,
): Promise<BaseRpcClients> {
  const chain = CHAINS[network];
  const account = mnemonicToAccount(mnemonic);

  let transport: Transport;

  if (useX402) {
    try {
      const { createQuicknodeX402Client } = await import('@quicknode/x402');
      const evmPrivKeyHex = Buffer.from(account.getHdKey().privateKey!).toString('hex');

      const x402Client = await createQuicknodeX402Client({
        baseUrl: 'https://x402.quicknode.com',
        network: network === 'base' ? 'eip155:8453' : 'eip155:84532',
        evmPrivateKey: `0x${evmPrivKeyHex}` as `0x${string}`,
        paymentModel: 'credit-drawdown',
        preAuth: true,
      });

      transport = http(QN_ENDPOINTS[network], {
        fetchOptions: {},
        onFetchRequest: async (request) => {
          // Use x402 client's fetch for payment handling
          return x402Client.fetch(request.url, {
            method: request.method,
            headers: Object.fromEntries(request.headers.entries()),
            body: request.body ? await request.text() : undefined,
          });
        },
      });

      console.log(`[base-rpc] QuickNode x402 (${network})`);
    } catch (err) {
      console.warn(`[base-rpc] x402 failed, using public endpoint: ${err}`);
      transport = http(PUBLIC_ENDPOINTS[network]);
      console.log(`[base-rpc] Public endpoint (${network})`);
    }
  } else {
    transport = http(PUBLIC_ENDPOINTS[network]);
    console.log(`[base-rpc] Public endpoint (${network})`);
  }

  const publicClient = createPublicClient({ chain, transport });

  const walletClient = createWalletClient({
    account,
    chain,
    transport,
  });

  return { publicClient, walletClient, chain, account };
}

/**
 * Base Sepolia USDC contract address.
 */
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

/**
 * Base mainnet USDC contract address.
 */
export const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

/**
 * Get the USDC address for the given network.
 */
export function getUsdcAddress(network: 'base' | 'base-sepolia'): `0x${string}` {
  return network === 'base' ? BASE_MAINNET_USDC : BASE_SEPOLIA_USDC;
}
