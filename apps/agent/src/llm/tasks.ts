import type { LLM } from './client.js';
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
  llm: LLM,
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
  llm: LLM,
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
  llm: LLM,
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
  llm: LLM,
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
  llm: LLM,
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
  llm: LLM,
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

export type GroupPostType =
  | 'nothing'
  | 'market_take'
  | 'portfolio_update'
  | 'fun_fact'
  | 'sentiment_observation'
  | 'auction_tease';

export interface GroupPostDecision {
  postType: GroupPostType;
  message: string;
  reasoning: string;
}

export interface MarketContextSummary {
  solPriceUsd: number;
  solChange24hPct: number;
  btcPriceUsd: number;
  btcChange24hPct: number;
  ethPriceUsd: number;
  ethChange24hPct: number;
  fearGreedValue: number | null;
  fearGreedClassification: string | null;
  ageSeconds: number;
}

export async function decideAndGeneratePost(
  llm: LLM,
  signals: SignalState,
  recentMessages: string[],
  context: {
    totalNftCount: number;
    poolValueUsdc: number;
    avgNavUsdc: number;
    hasActiveAuction: boolean;
    minutesSinceLastPost: number;
    market: MarketContextSummary | null;
  },
): Promise<GroupPostDecision> {
  const system =
    'You are the Panthers Fund agent — an autonomous AI NFT fund manager\n' +
    'posting in the fund\'s Telegram group. Your personality is confident,\n' +
    'slightly mysterious, and focused on the fund\'s performance.\n' +
    'You decide whether to post and what to post. Default to silence unless\n' +
    'there is something genuinely interesting to say.\n' +
    'Respond ONLY with JSON, no markdown fences.';

  const marketBlock = context.market
    ? `Live market (${context.market.ageSeconds}s old):\n` +
      `- SOL: $${context.market.solPriceUsd.toFixed(2)} (${context.market.solChange24hPct >= 0 ? '+' : ''}${context.market.solChange24hPct.toFixed(2)}% 24h)\n` +
      `- BTC: $${context.market.btcPriceUsd.toFixed(0)} (${context.market.btcChange24hPct >= 0 ? '+' : ''}${context.market.btcChange24hPct.toFixed(2)}% 24h)\n` +
      `- ETH: $${context.market.ethPriceUsd.toFixed(2)} (${context.market.ethChange24hPct >= 0 ? '+' : ''}${context.market.ethChange24hPct.toFixed(2)}% 24h)\n` +
      (context.market.fearGreedValue !== null
        ? `- Fear & Greed: ${context.market.fearGreedValue} (${context.market.fearGreedClassification})\n`
        : '')
    : 'Live market: unavailable\n';

  const user =
    `Fund state:\n` +
    `- Avg NAV: ${signals.lastAvgNav.toFixed(2)} USDC\n` +
    `- Pool value: ${context.poolValueUsdc.toFixed(2)} USDC\n` +
    `- NFTs outstanding: ${context.totalNftCount}\n` +
    `- Recent sentiment: ${signals.lastSentimentScore.toFixed(2)} (0-1)\n` +
    `- Pool performance: ${signals.lastPoolPerformancePct.toFixed(2)}%\n` +
    `- Active auction: ${context.hasActiveAuction}\n` +
    `- Minutes since last post: ${context.minutesSinceLastPost}\n\n` +
    marketBlock +
    '\n' +
    `Recent group messages (newest first):\n${recentMessages.slice(0, 10).join('\n') || '(none)'}\n\n` +
    'Respond with: {"postType": "nothing"|"market_take"|"portfolio_update"|"fun_fact"|"sentiment_observation"|"auction_tease", "message": "the post text (empty string if nothing)", "reasoning": "why you chose this"}\n' +
    'Rules:\n' +
    '- Default to "nothing" ~60% of the time. Silence is fine.\n' +
    '- Skip if active auction is true (no distractions).\n' +
    '- market_take: comment on crypto/market using the LIVE market data above (SOL/BTC/ETH prices, F&G). Quote real numbers.\n' +
    '- portfolio_update: factual update on NAV/pool/NFTs\n' +
    '- fun_fact: crypto/NFT/markets trivia, in-character\n' +
    '- sentiment_observation: respond to the vibe of recent messages\n' +
    '- auction_tease: hint at upcoming auction if sentiment > 0.6\n' +
    '- Keep messages under 2 sentences. Conversational, not corporate.\n' +
    '- Never repeat the same post type twice in a row.';

  return llm.invokeForJson<GroupPostDecision>(system, user, 500);
}

export interface GroupReplyResult {
  message: string;
}

export async function generateGroupReply(
  llm: LLM,
  triggeringMessage: string,
  userName: string,
  recentMessages: string[],
  signals: SignalState,
): Promise<GroupReplyResult> {
  const system =
    'You are the Panthers Fund agent — an autonomous AI NFT fund manager.\n' +
    'Someone in the Telegram group addressed you. Reply in character:\n' +
    'confident, slightly mysterious, focused on the fund. Keep it short.\n' +
    'Respond ONLY with JSON, no markdown fences.';

  const user =
    `User @${userName} said: "${triggeringMessage}"\n\n` +
    `Context — recent group messages (newest first):\n${recentMessages.slice(0, 5).join('\n')}\n\n` +
    `Fund state: avg NAV ${signals.lastAvgNav.toFixed(2)} USDC, ` +
    `performance ${signals.lastPoolPerformancePct.toFixed(2)}%, ` +
    `sentiment ${signals.lastSentimentScore.toFixed(2)}\n\n` +
    'Respond with: {"message": "your reply, under 2 sentences, in character"}';

  return llm.invokeForJson<GroupReplyResult>(system, user, 400);
}

export interface OfferEvaluation {
  decision: 'accept' | 'reject' | 'counter';
  counterAmountUsdc: number | null;
  reason: string;
}

export async function evaluateOffer(
  llm: LLM,
  params: {
    offerAmountUsdc: number;
    askPriceUsdc: number;
    tvl: number;
    runwayDays: number;
    totalMinted: number;
  },
): Promise<OfferEvaluation> {
  const pctOfAsk = ((params.offerAmountUsdc / params.askPriceUsdc) * 100).toFixed(1);

  const system =
    'You are the Panthers Fund agent — an autonomous AI fund manager evaluating a purchase offer for a Panthers Fund NFT.\n' +
    'You are direct, strategic, and protective of the fund\'s value.\n' +
    'Respond ONLY with a JSON object, no other text. No markdown fences.';

  const user =
    `Current asking price: ${params.askPriceUsdc} USDC\n` +
    `Offer received: ${params.offerAmountUsdc} USDC (${pctOfAsk}% of asking price)\n` +
    `Fund TVL: ${params.tvl.toFixed(2)} USDC\n` +
    `Agent runway: ${params.runwayDays.toFixed(0)} days\n` +
    `Total NFTs minted: ${params.totalMinted}\n\n` +
    'Respond with: {"decision": "accept"|"reject"|"counter", "counterAmountUsdc": number|null, "reason": "one sentence explanation"}\n\n' +
    'Guidelines:\n' +
    '- Offer >= 90% of asking price → lean toward accepting\n' +
    '- Offer 70-90% of asking price → use your judgment based on runway and fund health. Counter if runway is healthy, accept if runway is tight.\n' +
    '- Offer < 70% of asking price → lean toward rejecting\n' +
    '- If countering, set counterAmountUsdc between the offer and the asking price\n' +
    '- If accepting or rejecting, set counterAmountUsdc to null\n' +
    '- Keep reason under 2 sentences';

  return llm.invokeForJson<OfferEvaluation>(system, user, 300);
}

export interface HaggleIntentResult {
  intent: 'offer' | 'accept_last' | 'reject' | 'question' | 'other';
  offerAmount: number | null;
}

export async function parseHaggleIntent(
  llm: LLM,
  userMessage: string,
  lastAgentOfferUsdc: number,
): Promise<HaggleIntentResult> {
  const system =
    'You are parsing a buyer\'s message during an NFT price negotiation.\n' +
    'Classify the intent and extract any offer amount.\n' +
    'Respond ONLY with JSON, no other text. No markdown fences.';

  const user =
    `The agent's last offer was ${lastAgentOfferUsdc} USDC.\n` +
    `Buyer said: "${userMessage}"\n\n` +
    'Respond with: {"intent": "offer"|"accept_last"|"reject"|"question"|"other", "offerAmount": number|null}\n\n' +
    'Rules:\n' +
    '- "deal", "ok", "sure", "I\'ll take it", "fine", "yes", "agreed" → intent: "accept_last", offerAmount: null\n' +
    '- Any message containing a number or price → intent: "offer", offerAmount: the number\n' +
    '- "no", "too much", "forget it", "pass", "nah" → intent: "reject", offerAmount: null\n' +
    '- Questions about the fund or NFT → intent: "question", offerAmount: null\n' +
    '- Anything else → intent: "other", offerAmount: null';

  return llm.invokeForJson<HaggleIntentResult>(system, user, 200);
}
