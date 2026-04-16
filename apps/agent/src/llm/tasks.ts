import type { LLMClient } from './client.js';
import type {
  HagglingSession,
  Position,
  SignalState,
} from '../state/schema.js';
import type { TechnicalSignals } from '../trading/indicators.js';
import type { TokenInfo } from '../trading/birdeye.js';

export interface BuyIntentResult {
  hasBuyIntent: boolean;
  confidence: 'high' | 'medium' | 'low';
  userName: string;
}

export async function detectBuyIntent(
  llm: LLMClient,
  message: string,
  userName: string,
): Promise<BuyIntentResult> {
  const system =
    'You are monitoring a Telegram group for an autonomous NFT fund called Panthers Fund.\n' +
    'Your job is to detect if a user message expresses genuine interest in buying a Panthers Fund NFT.\n' +
    'Respond ONLY with a JSON object, no other text. No markdown fences.';

  const user =
    `Message: "${message}"\n` +
    `UserName: "${userName}"\n` +
    `Respond with: {"hasBuyIntent": boolean, "confidence": "high"|"medium"|"low", "userName": "${userName}"}\n` +
    'Only return hasBuyIntent: true for clear expressions of purchase interest.\n' +
    'Casual questions about the fund, price checks, or general curiosity are NOT buy intent.';

  return llm.invokeForJson<BuyIntentResult>(system, user, 500);
}

export interface HaggleResult {
  action: 'counter' | 'accept' | 'walk';
  counterOfferUsdc?: number;
  message: string;
}

export async function generateHaggleResponse(
  llm: LLMClient,
  session: HagglingSession,
  signals: SignalState,
): Promise<HaggleResult> {
  const system =
    'You are the Panthers Fund agent — an autonomous AI fund manager negotiating the sale\n' +
    'of a Panthers Fund NFT share. You want to maximize the sale price but you can close deals.\n' +
    'You have a floor (minimum you will accept) and a ceiling (your ideal price).\n' +
    'Be direct, confident, and slightly mysterious. Never reveal your floor or ceiling.\n' +
    'Respond ONLY with JSON, no markdown fences.';

  const user =
    `Floor: ${session.agentFloor} USDC\n` +
    `Ceiling: ${session.agentCeiling} USDC\n` +
    `Offer history: ${JSON.stringify(session.offerHistory)}\n` +
    `Current avg NAV: ${signals.lastAvgNav} USDC\n` +
    `Pool performance: ${signals.lastPoolPerformancePct}%\n` +
    'Respond with: {"action":"counter"|"accept"|"walk","counterOfferUsdc":number|null,"message":"your telegram message to the user"}\n' +
    'Rules:\n' +
    '- If latest user offer >= floor, you may accept\n' +
    '- If user is negotiating in good faith (offers moving up), counter\n' +
    '- If user offers below 50% of floor twice, walk away\n' +
    '- counter offers should move down gradually from ceiling toward floor\n' +
    '- Keep messages under 3 sentences, in character as the fund agent';

  return llm.invokeForJson<HaggleResult>(system, user, 500);
}

export interface SentimentResult {
  score: number;
  buyInterestLevel: 'low' | 'medium' | 'high';
  summary: string;
}

export async function scoreSentiment(
  llm: LLMClient,
  recentMessages: string[],
): Promise<SentimentResult> {
  const system =
    'You are analyzing Telegram group messages for Panthers Fund, an autonomous AI NFT fund.\n' +
    'Respond ONLY with JSON, no markdown fences.';

  const user =
    'Messages (newest first):\n' +
    recentMessages.slice(0, 20).join('\n') +
    '\n' +
    'Respond with: {"score": 0.0-1.0, "buyInterestLevel": "low"|"medium"|"high", "summary": "one sentence"}\n' +
    'score: 0=very negative/no interest, 0.5=neutral, 1.0=very high interest and enthusiasm';

  return llm.invokeForJson<SentimentResult>(system, user, 300);
}

export interface AuctionDecision {
  type: 'dutch' | 'english' | 'flash';
  startPriceUsdc: number;
  durationMinutes: number;
  reasoning: string;
}

export async function decideAuctionType(
  llm: LLMClient,
  signals: SignalState,
  availableNftCount: number,
): Promise<AuctionDecision> {
  const system =
    'You are the Panthers Fund agent deciding how to sell an NFT.\n' +
    'Respond ONLY with JSON, no markdown fences.';

  const user =
    `Current avg NAV: ${signals.lastAvgNav} USDC\n` +
    `Sentiment score: ${signals.lastSentimentScore} (0-1)\n` +
    `Pool performance: ${signals.lastPoolPerformancePct}%\n` +
    `NFTs available: ${availableNftCount}\n` +
    'Respond with: {"type":"dutch"|"english"|"flash","startPriceUsdc":number,"durationMinutes":number,"reasoning":"one sentence"}\n' +
    'Rules:\n' +
    '- dutch: good when sentiment is low (below 0.4), start above NAV and let price drop\n' +
    '- english: good when sentiment is high (above 0.7), competitive bidding\n' +
    '- flash: good for quick liquidity, fixed price close to NAV, short window (15-30 min)\n' +
    '- startPriceUsdc must be at least 90% of lastAvgNav for dutch/flash, no minimum for english';

  return llm.invokeForJson<AuctionDecision>(system, user, 300);
}

export interface TradeProposal {
  bucket: 'core' | 'top10' | 'llm';
  side: 'buy' | 'sell';
  tokenMint: string;
  tokenSymbol: string;
  proposedAmountUsdc: number;
  signals: TechnicalSignals;
  sentimentScore: number;
  poolPerformancePct: number;
  currentBucketAllocationPct: number;
  targetBucketAllocationPct: number;
}

export interface TradeDecision {
  decision: 'approve' | 'reject' | 'wait';
  reasoning: string;
}

export async function evaluateTradeProposal(
  llm: LLMClient,
  proposal: TradeProposal,
): Promise<TradeDecision> {
  const system =
    'You are the Panthers Fund trading agent — an autonomous AI fund manager.\n' +
    'You evaluate trade proposals and decide whether to execute them.\n' +
    'Be conservative with real capital. Reject if conditions are marginal.\n' +
    'Respond ONLY with JSON, no markdown fences.';

  const user =
    `Bucket: ${proposal.bucket} (target allocation: ${proposal.targetBucketAllocationPct}%)\n` +
    `Current bucket allocation: ${proposal.currentBucketAllocationPct}%\n` +
    `Proposed: ${proposal.side} ${proposal.tokenSymbol} for ${proposal.proposedAmountUsdc} USDC\n` +
    `RSI: ${proposal.signals.rsi} | Trend: ${proposal.signals.trend} | Price vs SMA: ${proposal.signals.priceVsSma}%\n` +
    `Sentiment score: ${proposal.sentimentScore} (0-1)\n` +
    `Pool performance: ${proposal.poolPerformancePct}%\n\n` +
    'Respond with: {"decision":"approve"|"reject"|"wait","reasoning":"one sentence"}\n' +
    'Rules:\n' +
    '- approve: signals clearly align, risk is acceptable\n' +
    '- wait: signals are mixed or marginal — check again next cycle\n' +
    '- reject: signals contradict the trade or risk is too high\n' +
    '- Never approve a buy if RSI > 75 or price is >5% above SMA\n' +
    '- Never approve a sell if RSI < 25 (oversold, likely bounce)\n' +
    '- For llm bucket: require RSI < 45 for buys and strong reasoning';

  return llm.invokeForJson<TradeDecision>(system, user, 300);
}

export interface TokenNomination {
  tokenMint: string;
  tokenSymbol: string;
  reasoning: string;
}

export async function nominateLlmBucketToken(
  llm: LLMClient,
  top10Tokens: TokenInfo[],
  currentPositions: Position[],
  signals: SignalState,
): Promise<TokenNomination> {
  const system =
    'You are the Panthers Fund agent selecting a token for the high-risk 10% allocation bucket.\n' +
    'This bucket is for your best autonomous pick beyond the top 10.\n' +
    'Respond ONLY with JSON, no markdown fences.';

  const user =
    `Current top 10 tokens by volume: ${JSON.stringify(top10Tokens.map((t) => ({ symbol: t.symbol, address: t.address, volume24h: t.volume24h })))}\n` +
    `Current positions: ${JSON.stringify(currentPositions.map((p) => p.tokenMint))}\n` +
    `Sentiment: ${signals.lastSentimentScore}\n` +
    `Pool performance: ${signals.lastPoolPerformancePct}%\n` +
    'Nominate ONE Solana token NOT in the top 10 list and NOT already held.\n' +
    'Respond with: {"tokenMint":"<address>","tokenSymbol":"<symbol>","reasoning":"one sentence"}';

  return llm.invokeForJson<TokenNomination>(system, user, 300);
}
