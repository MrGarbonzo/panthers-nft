import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PanthersState } from '../state/schema.js';

export interface NftPublicRecord {
  tokenId: string;
  nftIndex: number;
  mintAddress: string;
  name: string;
  navUsdc: number;
  usdcDeposited: number;
  gainPct: number;
  custodyMode: 'agent' | 'self';
  mintedAt: number;
  lastUpdatedAt: number;
}

export interface PublicPosition {
  tokenMint: string;
  bucket: 'core' | 'top10' | 'llm';
  entryPrice: number;
  sizeUsdc: number;
  openedAt: number;
}

export interface PublicTradeRecord {
  tokenMint: string;
  side: 'buy' | 'sell';
  price: number;
  sizeUsdc: number;
  pnl: number;
  bucket: 'core' | 'top10' | 'llm';
  executedAt: number;
}

export interface PublicPersonalFund {
  totalFeesCollectedUsdc: number;
  totalDonationsUsdc: number;
  totalInfraSpendSolanaUsdc: number;
  totalInfraSpendBaseUsdc: number;
  lastUpdatedAt: number;
}

export interface PublicFundStats {
  totalPoolValueUsdc: number;
  totalUsdcDeposited: number;
  performancePct: number;
  totalNftCount: number;
  avgNavUsdc: number;
  allocations: {
    coreUsdc: number;
    top10Usdc: number;
    llmUsdc: number;
    corePct: number;
    top10Pct: number;
    llmPct: number;
  };
  openPositions: PublicPosition[];
  recentTrades: PublicTradeRecord[];
  personalFund: PublicPersonalFund;
  lastUpdatedAt: number;
}

export interface PublicBalanceCache {
  byMint: Record<string, NftPublicRecord>;
  byName: Record<string, NftPublicRecord>;
  fundSummary: {
    totalPoolValueUsdc: number;
    totalNftCount: number;
    avgNavUsdc: number;
    lastUpdatedAt: number;
  };
  stats: PublicFundStats;
}

export class PublicCacheWriter {
  constructor(private readonly cachePath: string) {}

  async write(state: PanthersState): Promise<void> {
    const now = Date.now();
    const byMint: Record<string, NftPublicRecord> = {};
    const byName: Record<string, NftPublicRecord> = {};

    const nfts = Object.values(state.nfts);
    for (const nft of nfts) {
      const gainPct =
        nft.usdcDeposited > 0
          ? ((nft.currentNav - nft.usdcDeposited) / nft.usdcDeposited) * 100
          : 0;
      const record: NftPublicRecord = {
        tokenId: nft.tokenId,
        nftIndex: nft.nftIndex,
        mintAddress: nft.mintAddress,
        name: `Panthers Fund #${nft.nftIndex}`,
        navUsdc: nft.currentNav,
        usdcDeposited: nft.usdcDeposited,
        gainPct,
        custodyMode: nft.custodyMode,
        mintedAt: nft.mintedAt,
        lastUpdatedAt: now,
      };
      byMint[nft.mintAddress] = record;
      byName[`panthers#${nft.nftIndex}`] = record;
    }

    const totalNftCount = nfts.length;
    const avgNavUsdc =
      totalNftCount > 0
        ? nfts.reduce((sum, n) => sum + n.currentNav, 0) / totalNftCount
        : 0;

    const totalPoolValueUsdc = state.pool.totalUsdcCurrentValue;
    const alloc = state.pool.allocations;
    const openPositions: PublicPosition[] = state.pool.openPositions.map((p) => ({
      tokenMint: p.tokenMint,
      bucket: p.bucket,
      entryPrice: p.entryPrice,
      sizeUsdc: p.entryPrice * p.size,
      openedAt: p.openedAt,
    }));
    const recentTrades: PublicTradeRecord[] = state.pool.tradingHistory
      .slice(-20)
      .reverse()
      .map((t) => ({
        tokenMint: t.tokenMint,
        side: t.side,
        price: t.price,
        sizeUsdc: t.price * t.size,
        pnl: t.pnl,
        bucket: t.bucket,
        executedAt: t.executedAt,
      }));

    const cache: PublicBalanceCache = {
      byMint,
      byName,
      fundSummary: {
        totalPoolValueUsdc,
        totalNftCount,
        avgNavUsdc,
        lastUpdatedAt: now,
      },
      stats: {
        totalPoolValueUsdc,
        totalUsdcDeposited: state.pool.totalUsdcDeposited,
        performancePct: state.signals.lastPoolPerformancePct,
        totalNftCount,
        avgNavUsdc,
        allocations: {
          coreUsdc: alloc.coreValueUsdc,
          top10Usdc: alloc.top10ValueUsdc,
          llmUsdc: alloc.llmValueUsdc,
          corePct: totalPoolValueUsdc > 0
            ? (alloc.coreValueUsdc / totalPoolValueUsdc) * 100 : 0,
          top10Pct: totalPoolValueUsdc > 0
            ? (alloc.top10ValueUsdc / totalPoolValueUsdc) * 100 : 0,
          llmPct: totalPoolValueUsdc > 0
            ? (alloc.llmValueUsdc / totalPoolValueUsdc) * 100 : 0,
        },
        openPositions,
        recentTrades,
        personalFund: {
          totalFeesCollectedUsdc: state.personalFund?.totalFeesCollectedUsdc ?? 0,
          totalDonationsUsdc: state.personalFund?.totalDonationsUsdc ?? 0,
          totalInfraSpendSolanaUsdc: state.personalFund?.totalInfraSpendSolanaUsdc ?? 0,
          totalInfraSpendBaseUsdc: state.personalFund?.totalInfraSpendBaseUsdc ?? 0,
          lastUpdatedAt: state.personalFund?.lastUpdatedAt ?? 0,
        },
        lastUpdatedAt: now,
      },
    };

    const json = JSON.stringify(cache, null, 2);
    const tmpPath = `${this.cachePath}.tmp`;
    const dir = path.dirname(this.cachePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, json, 'utf8');
    await fs.rename(tmpPath, this.cachePath);
    console.log(`Public cache updated: ${totalNftCount} NFTs`);
  }

  async read(): Promise<PublicBalanceCache | null> {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      return JSON.parse(raw) as PublicBalanceCache;
    } catch {
      return null;
    }
  }

  lookupByName(
    cache: PublicBalanceCache,
    query: string,
  ): NftPublicRecord | null {
    const normalized = normalizeName(query);
    if (normalized === null) return null;
    return cache.byName[normalized] ?? null;
  }
}

export function normalizeName(query: string): string | null {
  const cleaned = query.replace(/\s+/g, '').toLowerCase();
  if (cleaned.length === 0) return null;
  const digits = cleaned.match(/(\d+)$/);
  if (!digits) return null;
  return `panthers#${digits[1]}`;
}
