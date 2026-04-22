import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import type { Umi } from '@metaplex-foundation/umi';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import { recalculateAllNavs } from '../state/nav.js';
import { burnPanthersNft } from './nft.js';
import type { PublicCacheWriter } from '../public/cache.js';

const USDC_DECIMALS = 1_000_000;

export async function processWithdrawal(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  umi: Umi;
  connection: Connection;
  agentKeypair: Keypair;
  tokenId: string;
  ownerWallet: string;
  usdcMint: string;
  cacheWriter?: PublicCacheWriter;
}): Promise<{ withdrawnUsdc: number; feesUsdc: number }> {
  const state = await params.db.loadState(params.adapter);

  const nft = state.nfts[params.tokenId];
  if (!nft) {
    throw new Error(`NFT not found: ${params.tokenId}`);
  }
  if (nft.ownerWallet !== params.ownerWallet) {
    throw new Error(
      `Owner mismatch for NFT ${params.tokenId}: expected ${nft.ownerWallet}, got ${params.ownerWallet}`,
    );
  }

  const feesUsdc = nft.currentNav * state.agentConfig.feePctOnBurn;
  const withdrawnUsdc = nft.currentNav - feesUsdc;

  await burnPanthersNft({
    umi: params.umi,
    mintAddress: nft.mintAddress,
    ownerWallet: params.ownerWallet,
  });

  const ownerPubkey = new PublicKey(params.ownerWallet);
  const usdcMintPk = new PublicKey(params.usdcMint);
  const sourceAta = await getAssociatedTokenAddress(
    usdcMintPk,
    params.agentKeypair.publicKey,
  );
  const destAta = await getOrCreateAssociatedTokenAccount(
    params.connection,
    params.agentKeypair,
    usdcMintPk,
    ownerPubkey,
  );

  const atomicAmount = BigInt(Math.floor(withdrawnUsdc * USDC_DECIMALS));
  const tx = new Transaction().add(
    createTransferInstruction(
      sourceAta,
      destAta.address,
      params.agentKeypair.publicKey,
      atomicAmount,
    ),
  );

  await sendAndConfirmTransaction(params.connection, tx, [params.agentKeypair]);

  const { [params.tokenId]: _removed, ...remainingNfts } = state.nfts;
  void _removed;

  const now = Date.now();
  let nextState = {
    ...state,
    nfts: remainingNfts,
    pool: {
      ...state.pool,
      totalUsdcDeposited: state.pool.totalUsdcDeposited - nft.usdcDeposited,
      totalUsdcCurrentValue: state.pool.totalUsdcCurrentValue - nft.currentNav,
    },
    personalFund: {
      ...(state.personalFund ?? { totalFeesCollectedUsdc: 0, totalDonationsUsdc: 0, totalInfraSpendSolanaUsdc: 0, totalInfraSpendBaseUsdc: 0, lastUpdatedAt: 0 }),
      totalFeesCollectedUsdc: (state.personalFund?.totalFeesCollectedUsdc ?? 0) + feesUsdc,
      lastUpdatedAt: now,
    },
  };

  nextState = recalculateAllNavs(nextState);
  await params.db.saveState(nextState, params.adapter, params.cacheWriter);

  return { withdrawnUsdc, feesUsdc };
}
