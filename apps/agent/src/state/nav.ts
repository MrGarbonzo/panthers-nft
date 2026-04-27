import type { NftRecord, PanthersState } from './schema.js';

export function calculateAvgNav(nfts: Record<string, NftRecord>): number {
  const records = Object.values(nfts);
  if (records.length === 0) return 0;
  const total = records.reduce((sum, nft) => sum + nft.currentNav, 0);
  return total / records.length;
}

/**
 * Distribute trading gains/losses proportionally across all NFTs.
 * Each NFT's share of gains is proportional to its currentNav relative to the total.
 * If there are no gains/losses (pool value == sum of navs), navs are preserved as-is.
 */
export function recalculateAllNavs(state: PanthersState): PanthersState {
  const nftList = Object.values(state.nfts);
  if (nftList.length === 0) {
    return {
      ...state,
      signals: { ...state.signals, lastAvgNav: 0, lastUpdatedAt: Date.now() },
    };
  }

  const sumOfNavs = nftList.reduce((sum, nft) => sum + nft.currentNav, 0);
  const poolValue = state.pool.totalUsdcCurrentValue;

  // If pool value matches sum of navs, no trading gains/losses to distribute
  if (sumOfNavs === 0 || Math.abs(poolValue - sumOfNavs) < 0.001) {
    return {
      ...state,
      signals: {
        ...state.signals,
        lastAvgNav: calculateAvgNav(state.nfts),
        lastUpdatedAt: Date.now(),
      },
    };
  }

  // Distribute pool value proportionally based on each NFT's current share
  const updatedNfts: Record<string, NftRecord> = {};
  for (const [tokenId, nft] of Object.entries(state.nfts)) {
    const share = nft.currentNav / sumOfNavs;
    updatedNfts[tokenId] = {
      ...nft,
      currentNav: share * poolValue,
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
