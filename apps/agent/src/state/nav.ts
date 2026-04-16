import type { NftRecord, PanthersState, PoolState } from './schema.js';

export function calculateNftNav(nft: NftRecord, pool: PoolState): number {
  if (pool.totalUsdcDeposited === 0) return nft.usdcDeposited;
  const share = nft.usdcDeposited / pool.totalUsdcDeposited;
  return share * pool.totalUsdcCurrentValue;
}

export function calculateAvgNav(nfts: Record<string, NftRecord>): number {
  const records = Object.values(nfts);
  if (records.length === 0) return 0;
  const total = records.reduce((sum, nft) => sum + nft.currentNav, 0);
  return total / records.length;
}

export function recalculateAllNavs(state: PanthersState): PanthersState {
  const updatedNfts: Record<string, NftRecord> = { ...state.nfts };
  for (const tokenId of Object.keys(updatedNfts)) {
    updatedNfts[tokenId] = {
      ...updatedNfts[tokenId]!,
      currentNav: calculateNftNav(updatedNfts[tokenId]!, state.pool),
    };
  }
  return {
    ...state,
    nfts: updatedNfts,
    signals: {
      ...state.signals,
      lastAvgNav: calculateAvgNav(updatedNfts),
      lastUpdatedAt: Date.now(),
    },
  };
}
