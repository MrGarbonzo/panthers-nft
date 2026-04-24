import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { PublicCacheWriter } from '../public/cache.js';
import type { AuctionRecord, PanthersState } from '../state/schema.js';
import { getWinningBid, isExpired, tickDutchAuction } from './engine.js';

const DEFAULT_INTERVAL_MS = 60 * 1000;

export interface AuctionTickerParams {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  cacheWriter: PublicCacheWriter;
  intervalMs?: number;
}

export class AuctionTicker {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly params: AuctionTickerParams) {}

  start(): void {
    if (this.timer) return;
    const interval = this.params.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.safeTick(), interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      console.error('AuctionTicker error:', err);
    }
  }

  private async tick(): Promise<void> {
    const state = await this.params.db.loadState(this.params.adapter);
    let mutated = false;
    const nextAuctions: Record<string, AuctionRecord> = { ...state.auctions };
    const now = Date.now();

    for (const [auctionId, original] of Object.entries(state.auctions)) {
      let auction = original;

      if (
        auction.status === 'scheduled' &&
        auction.scheduledAt !== undefined &&
        auction.scheduledAt <= now
      ) {
        auction = { ...auction, status: 'active', announcedAt: now };
        nextAuctions[auctionId] = auction;
        mutated = true;
        console.log(`[AuctionTicker] Auction ${auctionId} now active`);
      }

      if (auction.status === 'active' && auction.type === 'dutch') {
        const ticked = tickDutchAuction(auction, now);
        if (ticked.currentPrice !== auction.currentPrice) {
          auction = ticked;
          nextAuctions[auctionId] = auction;
          mutated = true;
          console.log(`[AuctionTicker] Dutch drop: ${auction.currentPrice} USDC`);
        }
      }

      if (auction.status === 'active' && isExpired(auction, now)) {
        const winner = getWinningBid(auction);
        if (winner === null) {
          auction = { ...auction, status: 'cancelled' };
          nextAuctions[auctionId] = auction;
          mutated = true;
          console.log(`[AuctionTicker] Auction ${auctionId} cancelled (no bids)`);
        } else {
          auction = {
            ...auction,
            status: 'settled',
            winnerId: winner.bidderWallet,
          };
          nextAuctions[auctionId] = auction;
          mutated = true;
          console.log(`[AuctionTicker] Auction ${auctionId} settled, winner: ${winner.bidderWallet}`);
        }
      }
    }

    if (mutated) {
      const nextState: PanthersState = { ...state, auctions: nextAuctions };
      await this.params.db.saveState(
        nextState,
        this.params.adapter,
        this.params.cacheWriter,
      );
    }
  }
}
