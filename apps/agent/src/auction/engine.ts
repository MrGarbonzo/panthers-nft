import { v4 as uuidv4 } from 'uuid';
import type { AuctionRecord, Bid } from '../state/schema.js';

export const DUTCH_DROP_INTERVAL_MS = 5 * 60 * 1000;
export const DUTCH_DROP_PCT = 0.05;
export const DUTCH_FLOOR_PCT = 0.5;
export const ENGLISH_EXTENSION_MS = 2 * 60 * 1000;

export function createAuction(params: {
  type: 'dutch' | 'english' | 'flash';
  startPriceUsdc: number;
  durationMinutes: number;
  triggeredBy: 'scheduled' | 'opportunistic';
  scheduledAt?: number;
}): AuctionRecord {
  const now = Date.now();
  const isScheduled =
    params.scheduledAt !== undefined && params.scheduledAt > now;
  const status: AuctionRecord['status'] = isScheduled ? 'scheduled' : 'active';
  const startAt = isScheduled ? params.scheduledAt! : now;
  const expiresAt = startAt + params.durationMinutes * 60 * 1000;

  const auction: AuctionRecord = {
    auctionId: uuidv4(),
    type: params.type,
    nftTokenId: '',
    startPrice: params.startPriceUsdc,
    currentPrice: params.startPriceUsdc,
    bids: [],
    expiresAt,
    status,
    triggeredBy: params.triggeredBy,
    ...(params.scheduledAt !== undefined ? { scheduledAt: params.scheduledAt } : {}),
  };

  if (params.type === 'dutch') {
    auction.dutchNextDropAt = now + DUTCH_DROP_INTERVAL_MS;
    auction.dutchDropIntervalMs = DUTCH_DROP_INTERVAL_MS;
    auction.dutchDropPct = DUTCH_DROP_PCT;
    auction.dutchFloorPct = DUTCH_FLOOR_PCT;
  }

  return auction;
}

export function tickDutchAuction(
  auction: AuctionRecord,
  now: number = Date.now(),
): AuctionRecord {
  if (auction.status !== 'active' || auction.type !== 'dutch') return auction;
  if (auction.dutchNextDropAt === undefined) return auction;
  if (now < auction.dutchNextDropAt) return auction;

  const dropPct = auction.dutchDropPct ?? DUTCH_DROP_PCT;
  const floorPct = auction.dutchFloorPct ?? DUTCH_FLOOR_PCT;
  const intervalMs = auction.dutchDropIntervalMs ?? DUTCH_DROP_INTERVAL_MS;

  const floor = Math.round(auction.startPrice * floorPct * 100) / 100;
  const dropped = Math.round(auction.currentPrice * (1 - dropPct) * 100) / 100;
  const newPrice = Math.max(dropped, floor);

  return {
    ...auction,
    currentPrice: newPrice,
    dutchNextDropAt: auction.dutchNextDropAt + intervalMs,
  };
}

export function placeBid(
  auction: AuctionRecord,
  bid: Bid,
  now: number = Date.now(),
): AuctionRecord {
  if (auction.type !== 'english') throw new Error('Not an English auction');
  if (auction.status !== 'active') throw new Error('Auction not active');
  if (bid.amount <= auction.currentPrice) throw new Error('Bid too low');

  const newExpiresAt =
    auction.expiresAt - now < ENGLISH_EXTENSION_MS
      ? now + ENGLISH_EXTENSION_MS
      : auction.expiresAt;

  return {
    ...auction,
    bids: [...auction.bids, bid],
    currentPrice: bid.amount,
    expiresAt: newExpiresAt,
  };
}

export function isExpired(
  auction: AuctionRecord,
  now: number = Date.now(),
): boolean {
  return auction.status === 'active' && now > auction.expiresAt;
}

export function getWinningBid(auction: AuctionRecord): Bid | null {
  if (auction.bids.length === 0) return null;
  if (auction.type === 'english') {
    return auction.bids.reduce((a, b) => (b.amount > a.amount ? b : a));
  }
  return auction.bids[0] ?? null;
}
