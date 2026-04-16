import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  transferV1,
  TokenStandard,
} from '@metaplex-foundation/mpl-token-metadata';
import { publicKey, type Umi } from '@metaplex-foundation/umi';

export async function transferNftToUser(params: {
  umi: Umi;
  mintAddress: string;
  toWallet: string;
}): Promise<void> {
  await transferV1(params.umi, {
    mint: publicKey(params.mintAddress),
    authority: params.umi.identity,
    tokenOwner: params.umi.identity.publicKey,
    destinationOwner: publicKey(params.toWallet),
    tokenStandard: TokenStandard.NonFungible,
  }).sendAndConfirm(params.umi);
}

export async function getCurrentHolder(
  mintAddress: string,
  connection: Connection,
): Promise<string | null> {
  const mint = new PublicKey(mintAddress);
  const largest = await connection.getTokenLargestAccounts(mint);
  const first = largest.value[0];
  if (!first) return null;
  const info = await connection.getParsedAccountInfo(first.address);
  const data = info.value?.data;
  if (!data || !('parsed' in data)) return null;
  const parsed = data.parsed as {
    info?: { owner?: string; tokenAmount?: { uiAmount?: number } };
  };
  const amount = parsed.info?.tokenAmount?.uiAmount;
  const owner = parsed.info?.owner;
  if (amount !== 1 || !owner) return null;
  return owner;
}

export function verifyWalletSignature(
  walletAddress: string,
  message: string,
  signatureBase58: string,
): boolean {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signatureBase58);
    const pubkeyBytes = new PublicKey(walletAddress).toBytes();
    return nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
  } catch {
    return false;
  }
}
