import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PanthersState } from '../state/schema.js';

export interface NftPublicRecord {
  mintAddress: string;
  name: string;
  navUsdc: number;
  usdcDeposited: number;
  gainPct: number;
  custodyMode: 'agent' | 'self';
  mintedAt: number;
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

    const cache: PublicBalanceCache = {
      byMint,
      byName,
      fundSummary: {
        totalPoolValueUsdc: state.pool.totalUsdcCurrentValue,
        totalNftCount,
        avgNavUsdc,
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
