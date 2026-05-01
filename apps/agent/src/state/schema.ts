export interface X402SpendRecord {
  myceliaUsdc: number;
  genvoxUsdc: number;
  gloriaUsdc: number;
  secretvmUsdc: number;
}

export interface PersonalFund {
  totalFeesCollectedUsdc: number;
  totalDonationsUsdc: number;
  totalInfraSpendSolanaUsdc: number;
  totalInfraSpendBaseUsdc: number;
  x402Spend?: X402SpendRecord;
  lastUpdatedAt: number;
}

export interface TradingDecisionRecord {
  id: string;
  bucket: 'core' | 'top10' | 'speculative';
  side: 'buy' | 'sell';
  tokenSymbol: string;
  tokenMint: string;
  proposedAmountUsdc: number;
  decision: 'approve' | 'reject' | 'wait';
  reasoning: string;
  rsi: number;
  trend: string;
  executed: boolean;
  paperTrade: boolean;
  txSignature?: string;
  timestamp: number;
}

export type ActivityType = 'purchase' | 'add_funds' | 'redeem' | 'withdrawal';

export interface RedemptionRequest {
  requestId: string;
  tokenId: string;
  ownerWallet: string;
  requestedAt: number;
  expiresAt: number;
  navAtRequest: number;
  swingFactor: number;
  effectiveNav: number;
  feePct: number;
  netUsdc: number;
  status: 'queued' | 'fulfilled' | 'expired' | 'cancelled';
  fulfilledAt?: number;
  fulfilledTxHash?: string;
}

export interface ActivityRecord {
  id: string;
  type: ActivityType;
  wallet: string;
  nftLabel: string;
  amountUsdc: number;
  txSignature?: string;
  timestamp: number;
}

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
  personalFund: PersonalFund;
  activityLog?: ActivityRecord[];
  tradingDecisionLog?: TradingDecisionRecord[];
  redemptionQueue: Record<string, RedemptionRequest>;
  peakNavUsdc: number;
  liquidUsdcBalance: number;
}

export interface P2pListing {
  listingId: string;
  tokenId: string;
  sellerWallet: string;
  askingPriceUsdc: number;
  createdAt: number;
  status: 'active' | 'sold' | 'cancelled';
}

export interface PendingSale {
  saleId: string;
  buyerWallet: string;
  agreedPriceUsdc: number;
  expiresAt: number;
  status: 'awaiting_payment' | 'paid' | 'expired';
  createdAt: number;
  listingId?: string;
  type?: 'buy' | 'add_funds';
  targetTokenId?: string;
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
  speculativeValueUsdc: number;
  /** @deprecated Read alias — old state may have this instead of speculativeValueUsdc */
  llmValueUsdc?: number;
  lastRebalancedAt: number;
}

export interface NftRecord {
  tokenId: string;
  ownerWallet: string;
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
  amount: number;
  placedAt: number;
}

export interface HagglingSession {
  sessionId: string;
  buyerWallet: string;
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
  lastSurvivalPostAt?: number;
}

export interface Position {
  tokenMint: string;
  entryPrice: number;
  size: number;
  openedAt: number;
  bucket: 'core' | 'top10' | 'speculative';
  llmReasoning?: string;
}

export interface TradeRecord {
  tokenMint: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  executedAt: number;
  pnl: number;
  bucket: 'core' | 'top10' | 'speculative';
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
        speculativeValueUsdc: 0,
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
      feePctOnBurn: 0.10,
      haggleAggressiveness: 0.5,
      tradingStrategyActive: 'trend_follow',
    },
    personalFund: {
      totalFeesCollectedUsdc: 0,
      totalDonationsUsdc: 0,
      totalInfraSpendSolanaUsdc: 0,
      totalInfraSpendBaseUsdc: 0,
      lastUpdatedAt: 0,
    },
    activityLog: [],
    redemptionQueue: {},
    peakNavUsdc: 0,
    liquidUsdcBalance: 0,
  };
}

const MAX_TRADING_DECISION_LOG = 200;

export function appendTradingDecision(
  state: PanthersState,
  entry: Omit<TradingDecisionRecord, 'id' | 'timestamp'>,
): PanthersState {
  const record: TradingDecisionRecord = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };
  const log = [...(state.tradingDecisionLog ?? []), record].slice(-MAX_TRADING_DECISION_LOG);
  return { ...state, tradingDecisionLog: log };
}

const MAX_ACTIVITY_LOG = 200;

export function appendActivity(
  state: PanthersState,
  entry: Omit<ActivityRecord, 'id' | 'timestamp'>,
): PanthersState {
  const record: ActivityRecord = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };
  const log = [...(state.activityLog ?? []), record].slice(-MAX_ACTIVITY_LOG);
  return { ...state, activityLog: log };
}
