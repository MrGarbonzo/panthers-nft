import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
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

const PUBLIC_ENDPOINTS: Record<string, string> = {
  'base': 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
};

/**
 * Create Base RPC clients using public endpoint.
 * TODO: x402 QuickNode integration when @quicknode/x402 supports viem custom fetch
 */
export async function createBaseRpcClients(
  mnemonic: string,
  network: 'base' | 'base-sepolia' = 'base-sepolia',
): Promise<BaseRpcClients> {
  const chain = CHAINS[network];
  const account = mnemonicToAccount(mnemonic);

  const transport = http(PUBLIC_ENDPOINTS[network]);
  console.log(`[base-rpc] Public endpoint (${network})`);

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
