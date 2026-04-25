import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
} from 'viem';
import { baseSepolia } from 'viem/chains';

const REGISTRY_ADDRESS = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;

const REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    name: 'setAgentURI',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'tokenURI',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

interface AgentMetadata {
  type: string;
  name: string;
  description: string;
  services: Array<{ name: string; endpoint: string }>;
  active: boolean;
}

function buildMetadataUri(metadata: AgentMetadata): string {
  const json = JSON.stringify(metadata);
  const b64 = Buffer.from(json).toString('base64');
  return `data:application/json;base64,${b64}`;
}

export interface Erc8004Client {
  register(params: {
    name: string;
    description: string;
    services: Array<{ name: string; endpoint: string }>;
  }): Promise<bigint>;

  updateEndpoint(
    tokenId: bigint,
    serviceName: string,
    endpoint: string,
  ): Promise<void>;
}

export function createErc8004Client(params: {
  account: Account;
  rpcUrl?: string;
}): Erc8004Client {
  const chain: Chain = baseSepolia;
  const transport: Transport = http(params.rpcUrl);

  const publicClient: PublicClient = createPublicClient({
    chain,
    transport,
  });

  const walletClient: WalletClient = createWalletClient({
    account: params.account,
    chain,
    transport,
  });

  return {
    async register({ name, description, services }) {
      const metadata: AgentMetadata = {
        type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        name,
        description,
        services,
        active: true,
      };
      const uri = buildMetadataUri(metadata);

      const { request } = await publicClient.simulateContract({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'register',
        args: [uri],
        account: params.account,
      });

      const hash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Parse tokenId from Transfer event (topic0 = Transfer, topic3 = tokenId)
      const transferLog = receipt.logs.find(
        (log) =>
          log.topics[0] ===
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      );
      if (!transferLog || !transferLog.topics[3]) {
        throw new Error('Transfer event not found in registration receipt');
      }
      return BigInt(transferLog.topics[3]);
    },

    async updateEndpoint(tokenId, serviceName, endpoint) {
      const metadata: AgentMetadata = {
        type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        name: 'Panthers Fund',
        description: 'Autonomous AI NFT fund on Solana',
        services: [{ name: serviceName, endpoint }],
        active: true,
      };
      const uri = buildMetadataUri(metadata);

      const { request } = await publicClient.simulateContract({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'setAgentURI',
        args: [tokenId, uri],
        account: params.account,
      });

      const hash = await walletClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash });
    },
  };
}
