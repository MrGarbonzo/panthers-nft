import { v4 as uuidv4 } from 'uuid';
import type { Umi } from '@metaplex-foundation/umi';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { NftRecord } from '../state/schema.js';
import { recalculateAllNavs } from '../state/nav.js';
import { mintPanthersNft } from './nft.js';
import type { PublicCacheWriter } from '../public/cache.js';

export async function completeSale(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  umi: Umi;
  rpcUrl: string;
  saleId: string;
  confirmedAmountUsdc: number;
  txSignature: string;
  cacheWriter?: PublicCacheWriter;
  agentPublicUrl?: string;
}): Promise<{ mintAddress: string; tokenId: string }> {
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

  const metadataUri = params.agentPublicUrl
    ? `${params.agentPublicUrl}/metadata/${tokenId}`
    : undefined;

  const mintAddress = await mintPanthersNft({
    umi: params.umi,
    recipientWallet: pendingSale.buyerWallet,
    tokenId,
    nftIndex,
    rpcUrl: params.rpcUrl,
    metadataUri,
  });

  const nftRecord: NftRecord = {
    tokenId,
    ownerWallet: pendingSale.buyerWallet,
    ownerTelegramId: pendingSale.telegramUserId,
    usdcDeposited: params.confirmedAmountUsdc,
    currentNav: params.confirmedAmountUsdc,
    mintPrice: pendingSale.agreedPriceUsdc,
    mintedAt: Date.now(),
    mintAddress,
    custodyMode: 'agent',
    nftIndex,
  };

  let nextState = {
    ...state,
    nfts: { ...state.nfts, [tokenId]: nftRecord },
    pool: {
      ...state.pool,
      totalUsdcDeposited: state.pool.totalUsdcDeposited + params.confirmedAmountUsdc,
      totalUsdcCurrentValue:
        state.pool.totalUsdcCurrentValue + params.confirmedAmountUsdc,
    },
    pendingSales: {
      ...state.pendingSales,
      [params.saleId]: { ...pendingSale, status: 'paid' as const },
    },
  };

  nextState = recalculateAllNavs(nextState);
  await params.db.saveState(nextState, params.adapter, params.cacheWriter);

  return { mintAddress, tokenId };
}
