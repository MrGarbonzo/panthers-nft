import type { PublicClient, WalletClient } from 'viem';
import { parseEventLogs } from 'viem';

/**
 * Minimal ERC-721 ABI for Panthers Fund NFTs.
 * The contract supports: mint (owner only), burn (owner only),
 * ownerOf, balanceOf, transferFrom, approve, tokenURI.
 */
export const PANTHERS_NFT_ABI = [
  // ERC-721 standard
  { type: 'function', name: 'name', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'ownerOf', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'tokenURI', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'transferFrom', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'safeTransferFrom', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  // Owner-only
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'burn', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setBaseURI', inputs: [{ name: 'baseURI_', type: 'string' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  // Events
  { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'Approval', inputs: [{ name: 'owner', type: 'address', indexed: true }, { name: 'approved', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: true }] },
] as const;

/**
 * Compiled bytecode for a minimal ERC-721 contract.
 *
 * Solidity source (OpenZeppelin-based):
 * ```solidity
 * // SPDX-License-Identifier: MIT
 * pragma solidity ^0.8.20;
 *
 * contract PanthersNFT {
 *     string public name = "Panthers Fund";
 *     string public symbol = "PANTHER";
 *     address public owner;
 *     uint256 public totalSupply;
 *     string private _baseURI;
 *
 *     mapping(uint256 => address) private _owners;
 *     mapping(address => uint256) private _balances;
 *     mapping(uint256 => address) private _tokenApprovals;
 *
 *     event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
 *     event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
 *
 *     constructor() { owner = msg.sender; }
 *
 *     function ownerOf(uint256 tokenId) public view returns (address) { ... }
 *     function balanceOf(address addr) public view returns (uint256) { ... }
 *     function mint(address to) external returns (uint256) { ... }
 *     function burn(uint256 tokenId) external { ... }
 *     function transferFrom(address from, address to, uint256 tokenId) public { ... }
 *     function approve(address to, uint256 tokenId) public { ... }
 *     function tokenURI(uint256 tokenId) public view returns (string memory) { ... }
 *     function setBaseURI(string memory baseURI_) external { ... }
 * }
 * ```
 *
 * To regenerate: compile with solc 0.8.20+ and paste the bytecode below.
 * For now, we deploy via CREATE2 or use a factory. The bytecode will be
 * generated when we set up the Solidity build pipeline.
 *
 * TEMPORARY: Using inline assembly-free minimal ERC-721 via Solidity compilation.
 * TODO: Replace with actual compiled bytecode from `forge build` or `solc`.
 */
export const PANTHERS_NFT_BYTECODE = '0x' as `0x${string}`;

// We'll use a different approach: deploy via a well-known factory
// or compile the contract separately. For now, provide the interface
// to interact with an already-deployed contract.

export interface PanthersNftClient {
  contractAddress: `0x${string}`;
  mint(to: `0x${string}`): Promise<{ tokenId: bigint; txHash: `0x${string}` }>;
  burn(tokenId: bigint): Promise<`0x${string}`>;
  ownerOf(tokenId: bigint): Promise<`0x${string}`>;
  balanceOf(owner: `0x${string}`): Promise<bigint>;
  totalSupply(): Promise<bigint>;
  setBaseURI(uri: string): Promise<`0x${string}`>;
}

/**
 * Create a client for interacting with a deployed Panthers NFT contract.
 */
export function createNftClient(
  contractAddress: `0x${string}`,
  publicClient: PublicClient,
  walletClient: WalletClient,
): PanthersNftClient {
  return {
    contractAddress,

    async mint(to) {
      const hash = await (walletClient as any).writeContract({
        address: contractAddress,
        abi: PANTHERS_NFT_ABI,
        functionName: 'mint',
        args: [to],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Parse Transfer event to get tokenId
      const logs = parseEventLogs({
        abi: PANTHERS_NFT_ABI,
        logs: receipt.logs as any,
        eventName: 'Transfer',
      });
      const transferLog = logs[0];
      const tokenId = transferLog ? (transferLog.args as any).tokenId as bigint : 0n;

      return { tokenId, txHash: hash };
    },

    async burn(tokenId) {
      return (walletClient as any).writeContract({
        address: contractAddress,
        abi: PANTHERS_NFT_ABI,
        functionName: 'burn',
        args: [tokenId],
      });
    },

    async ownerOf(tokenId) {
      return publicClient.readContract({
        address: contractAddress,
        abi: PANTHERS_NFT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }) as Promise<`0x${string}`>;
    },

    async balanceOf(owner) {
      return publicClient.readContract({
        address: contractAddress,
        abi: PANTHERS_NFT_ABI,
        functionName: 'balanceOf',
        args: [owner],
      }) as Promise<bigint>;
    },

    async totalSupply() {
      return publicClient.readContract({
        address: contractAddress,
        abi: PANTHERS_NFT_ABI,
        functionName: 'totalSupply',
        args: [],
      }) as Promise<bigint>;
    },

    async setBaseURI(uri) {
      return (walletClient as any).writeContract({
        address: contractAddress,
        abi: PANTHERS_NFT_ABI,
        functionName: 'setBaseURI',
        args: [uri],
      });
    },
  };
}
