import { v4 as uuidv4 } from 'uuid';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { NftRecord } from '../state/schema.js';
import { appendActivity } from '../state/schema.js';
import { recalculateAllNavs } from '../state/nav.js';
import type { PublicCacheWriter } from '../public/cache.js';

/**
 * Complete a sale — creates a mock NFT record in the DB.
 * No on-chain minting — the NFT is tracked purely in the agent's state.
 * When real ERC-721 is ready, add the on-chain mint call here.
 */
export async function completeSale(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  saleId: string;
  confirmedAmountUsdc: number;
  txHash: string;
  cacheWriter?: PublicCacheWriter;
  agentPublicUrl?: string;
}): Promise<{ tokenId: string }> {
  const state = await params.db.loadState(params.adapter);

  const pendingSale = state.pendingSales[params.saleId];
  if (!pendingSale) {
    throw new Error(`Pending sale not found: ${params.saleId}`);
  }
  if (pendingSale.status !== 'awaiting_payment') {
    throw new Error(
      `Pending sale ${params.saleId} is not awaiting payment (status=${pendingSale.status})`,
    );
  }

  const tokenId = uuidv4();
  const nftIndex = Object.keys(state.nfts).length + 1;

  const nftRecord: NftRecord = {
    tokenId,
    ownerWallet: pendingSale.buyerWallet,
    usdcDeposited: params.confirmedAmountUsdc,
    currentNav: params.confirmedAmountUsdc,
    mintPrice: pendingSale.agreedPriceUsdc,
    mintedAt: Date.now(),
    mintAddress: `mock-${tokenId}`, // No on-chain mint — placeholder
    custodyMode: 'self',
    nftIndex,
  };

  let nextState = {
    ...state,
    nfts: { ...state.nfts, [tokenId]: nftRecord },
    pool: {
      ...state.pool,
      totalUsdcDeposited: state.pool.totalUsdcDeposited + params.confirmedAmountUsdc,
      totalUsdcCurrentValue: state.pool.totalUsdcCurrentValue + params.confirmedAmountUsdc,
    },
    pendingSales: {
      ...state.pendingSales,
      [params.saleId]: { ...pendingSale, status: 'paid' as const },
    },
  };

  nextState = recalculateAllNavs(nextState);
  nextState = appendActivity(nextState, {
    type: 'purchase',
    wallet: pendingSale.buyerWallet,
    nftLabel: `Panthers #${nftIndex}`,
    amountUsdc: params.confirmedAmountUsdc,
    txSignature: params.txHash,
  });
  await params.db.saveState(nextState, params.adapter, params.cacheWriter);

  return { tokenId };
}

/**
 * Add funds to an existing NFT — increases its NAV.
 */
export async function addFundsToNft(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  saleId: string;
  targetTokenId: string;
  confirmedAmountUsdc: number;
  txHash: string;
  cacheWriter?: PublicCacheWriter;
}): Promise<{ tokenId: string; newNav: number }> {
  const state = await params.db.loadState(params.adapter);

  const pendingSale = state.pendingSales[params.saleId];
  if (!pendingSale) {
    throw new Error(`Pending sale not found: ${params.saleId}`);
  }
  if (pendingSale.status !== 'awaiting_payment') {
    throw new Error(
      `Pending sale ${params.saleId} is not awaiting payment (status=${pendingSale.status})`,
    );
  }

  const nft = state.nfts[params.targetTokenId];
  if (!nft) {
    throw new Error(`NFT not found: ${params.targetTokenId}`);
  }

  const updatedNft = {
    ...nft,
    usdcDeposited: nft.usdcDeposited + params.confirmedAmountUsdc,
    currentNav: nft.currentNav + params.confirmedAmountUsdc,
  };

  let nextState = {
    ...state,
    nfts: { ...state.nfts, [params.targetTokenId]: updatedNft },
    pool: {
      ...state.pool,
      totalUsdcDeposited: state.pool.totalUsdcDeposited + params.confirmedAmountUsdc,
      totalUsdcCurrentValue: state.pool.totalUsdcCurrentValue + params.confirmedAmountUsdc,
    },
    pendingSales: {
      ...state.pendingSales,
      [params.saleId]: { ...pendingSale, status: 'paid' as const },
    },
  };

  nextState = recalculateAllNavs(nextState);
  nextState = appendActivity(nextState, {
    type: 'add_funds',
    wallet: pendingSale.buyerWallet,
    nftLabel: `Panthers #${nft.nftIndex}`,
    amountUsdc: params.confirmedAmountUsdc,
    txSignature: params.txHash,
  });
  await params.db.saveState(nextState, params.adapter, params.cacheWriter);

  const finalNft = nextState.nfts[params.targetTokenId];
  return { tokenId: params.targetTokenId, newNav: finalNft.currentNav };
}

/**
 * Redeem an NFT — removes it from state and returns USDC amount.
 * No on-chain burn — just DB update. USDC transfer handled separately.
 */
export async function redeemNft(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  tokenId: string;
  feePct: number;
  cacheWriter?: PublicCacheWriter;
}): Promise<{ withdrawnUsdc: number; feesUsdc: number }> {
  const state = await params.db.loadState(params.adapter);
  const nft = state.nfts[params.tokenId];
  if (!nft) {
    throw new Error(`NFT not found: ${params.tokenId}`);
  }

  const feesUsdc = nft.currentNav * params.feePct;
  const withdrawnUsdc = nft.currentNav - feesUsdc;

  const { [params.tokenId]: _removed, ...remainingNfts } = state.nfts;
  void _removed;

  let nextState: PanthersState = {
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
      lastUpdatedAt: Date.now(),
    },
  };

  nextState = recalculateAllNavs(nextState);
  nextState = appendActivity(nextState, {
    type: 'redeem',
    wallet: nft.ownerWallet,
    nftLabel: `Panthers #${nft.nftIndex}`,
    amountUsdc: withdrawnUsdc,
  });
  await params.db.saveState(nextState, params.adapter, params.cacheWriter);

  return { withdrawnUsdc, feesUsdc };
}

import type { PanthersState } from '../state/schema.js';
