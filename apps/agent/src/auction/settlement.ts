import { v4 as uuidv4 } from 'uuid';
import type { Umi } from '@metaplex-foundation/umi';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { EscrowRecord, NftRecord, PanthersState } from '../state/schema.js';
import { mintPanthersNft } from '../solana/nft.js';
import { recalculateAllNavs } from '../state/nav.js';
import type { PublicCacheWriter } from '../public/cache.js';

export async function settleAuction(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  umi: Umi;
  cacheWriter: PublicCacheWriter;
  auctionId: string;
  winnerTelegramId: string;
  winnerWallet: string;
  paidAmountUsdc: number;
  txSignature: string;
  agentWalletAddress: string;
}): Promise<{ tokenId: string; mintAddress: string }> {
  const state = await params.db.loadState(params.adapter);
  const auction = state.auctions[params.auctionId];
  if (!auction) throw new Error(`Auction not found: ${params.auctionId}`);
  if (auction.status === 'settled') {
    throw new Error(`Auction already settled: ${params.auctionId}`);
  }

  const tokenId = uuidv4();
  const nftIndex = Object.keys(state.nfts).length + 1;

  const mintAddress = await mintPanthersNft({
    umi: params.umi,
    recipientWallet: params.agentWalletAddress,
    tokenId,
    nftIndex,
    rpcUrl: '',
  });

  const now = Date.now();
  const nft: NftRecord = {
    tokenId,
    ownerWallet: params.winnerWallet,
    ownerTelegramId: params.winnerTelegramId,
    usdcDeposited: params.paidAmountUsdc,
    currentNav: params.paidAmountUsdc,
    mintPrice: params.paidAmountUsdc,
    mintedAt: now,
    mintAddress,
    custodyMode: 'agent',
    nftIndex,
  };

  const escrowId = uuidv4();
  const escrow: EscrowRecord = {
    escrowId,
    type: 'auction',
    nftTokenId: tokenId,
    buyerWallet: params.winnerWallet,
    sellerWallet: params.agentWalletAddress,
    amount: params.paidAmountUsdc,
    feesUsdc: 0,
    status: 'released',
    createdAt: now,
    settledAt: now,
    txSignature: params.txSignature,
  };

  let nextState: PanthersState = {
    ...state,
    nfts: { ...state.nfts, [tokenId]: nft },
    pool: {
      ...state.pool,
      totalUsdcDeposited: state.pool.totalUsdcDeposited + params.paidAmountUsdc,
      totalUsdcCurrentValue:
        state.pool.totalUsdcCurrentValue + params.paidAmountUsdc,
    },
    escrow: { ...state.escrow, [escrowId]: escrow },
    auctions: {
      ...state.auctions,
      [params.auctionId]: {
        ...auction,
        status: 'settled',
        nftTokenId: tokenId,
        winnerWallet: params.winnerWallet,
      },
    },
  };

  nextState = recalculateAllNavs(nextState);

  const poolPerformancePct =
    nextState.pool.totalUsdcDeposited > 0
      ? ((nextState.pool.totalUsdcCurrentValue -
          nextState.pool.totalUsdcDeposited) /
          nextState.pool.totalUsdcDeposited) *
        100
      : 0;
  nextState = {
    ...nextState,
    signals: {
      ...nextState.signals,
      lastPoolPerformancePct: poolPerformancePct,
      lastUpdatedAt: now,
    },
  };

  await params.db.saveState(nextState, params.adapter, params.cacheWriter);
  return { tokenId, mintAddress };
}
