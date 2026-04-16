export interface PanthersState {
  pool: PoolState;
  nfts: Record<string, NftRecord>;
  auctions: Record<string, AuctionRecord>;
  haggling: Record<string, HagglingSession>;
  escrow: Record<string, EscrowRecord>;
  pendingSales: Record<string, PendingSale>;
  p2pListings: Record<string, P2pListing>;
  signals: SignalState;
  agentConfig: AgentConfig;
}

export interface P2pListing {
  listingId: string;
  tokenId: string;
  sellerTelegramId: string;
  sellerWallet: string;
  askingPriceUsdc: number;
  createdAt: number;
  status: 'active' | 'sold' | 'cancelled';
}

export interface PendingSale {
  saleId: string;
  telegramUserId: string;
  buyerWallet: string;
  agreedPriceUsdc: number;
  expiresAt: number;
  status: 'awaiting_payment' | 'paid' | 'expired';
  createdAt: number;
  listingId?: string;
}

export interface PoolState {
  totalUsdcDeposited: number;
  totalUsdcCurrentValue: number;
  openPositions: Position[];
  tradingHistory: TradeRecord[];
  allocations: PoolAllocations;
}

export interface PoolAllocations {
  coreValueUsdc: number;
  top10ValueUsdc: number;
  llmValueUsdc: number;
  lastRebalancedAt: number;
}

export interface NftRecord {
  tokenId: string;
  ownerWallet: string;
  ownerTelegramId: string;
  usdcDeposited: number;
  currentNav: number;
  mintPrice: number;
  mintedAt: number;
  mintAddress: string;
  custodyMode: 'agent' | 'self';
  claimedAt?: number;
  nftIndex: number;
}

export interface AuctionRecord {
  auctionId: string;
  type: 'dutch' | 'english' | 'flash';
  nftTokenId: string;
  startPrice: number;
  currentPrice: number;
  bids: Bid[];
  expiresAt: number;
  status: 'scheduled' | 'active' | 'settled' | 'cancelled';
  triggeredBy: 'scheduled' | 'opportunistic';
  scheduledAt?: number;
  announcedAt?: number;
  winnerId?: string;
  winnerWallet?: string;
  dutchNextDropAt?: number;
  dutchDropIntervalMs?: number;
  dutchDropPct?: number;
  dutchFloorPct?: number;
}

export interface Bid {
  bidderWallet: string;
  bidderTelegramId: string;
  amount: number;
  placedAt: number;
}

export interface HagglingSession {
  sessionId: string;
  telegramUserId: string;
  nftTokenId: string;
  agentFloor: number;
  agentCeiling: number;
  offerHistory: Offer[];
  status: 'active' | 'accepted' | 'rejected' | 'expired';
}

export interface Offer {
  fromAgent: boolean;
  amount: number;
  offeredAt: number;
}

export interface EscrowRecord {
  escrowId: string;
  type: 'auction' | 'p2p';
  nftTokenId: string;
  buyerWallet: string;
  sellerWallet: string;
  sellerTelegramId?: string;
  amount: number;
  feesUsdc: number;
  status: 'pending' | 'released' | 'refunded';
  createdAt: number;
  settledAt?: number;
  txSignature?: string;
}

export interface SignalState {
  lastAvgNav: number;
  lastSentimentScore: number;
  lastPoolPerformancePct: number;
  lastUpdatedAt: number;
}

export interface AgentConfig {
  feePctOnBurn: number;
  haggleAggressiveness: number;
  tradingStrategyActive: string;
  lastAnnouncedMilestonePct?: number;
}

export interface Position {
  tokenMint: string;
  entryPrice: number;
  size: number;
  openedAt: number;
  bucket: 'core' | 'top10' | 'llm';
  llmReasoning?: string;
}

export interface TradeRecord {
  tokenMint: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  executedAt: number;
  pnl: number;
  bucket: 'core' | 'top10' | 'llm';
  llmDecision: 'approve' | 'reject' | 'wait';
  llmReasoning: string;
  txSignature?: string;
}

export function defaultPanthersState(): PanthersState {
  return {
    pool: {
      totalUsdcDeposited: 0,
      totalUsdcCurrentValue: 0,
      openPositions: [],
      tradingHistory: [],
      allocations: {
        coreValueUsdc: 0,
        top10ValueUsdc: 0,
        llmValueUsdc: 0,
        lastRebalancedAt: 0,
      },
    },
    nfts: {},
    auctions: {},
    haggling: {},
    escrow: {},
    pendingSales: {},
    p2pListings: {},
    signals: {
      lastAvgNav: 0,
      lastSentimentScore: 0,
      lastPoolPerformancePct: 0,
      lastUpdatedAt: 0,
    },
    agentConfig: {
      feePctOnBurn: 0.02,
      haggleAggressiveness: 0.5,
      tradingStrategyActive: 'trend_follow',
    },
  };
}
