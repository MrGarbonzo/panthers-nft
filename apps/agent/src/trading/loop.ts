import type { Connection } from '@solana/web3.js';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { LLMRouter } from '../llm/router.js';
import type {
  PanthersState,
  Position,
  TradeRecord,
} from '../state/schema.js';
import {
  BirdeyeClient,
  SOL_MINT,
  USDC_MINT,
  type OhlcvCandle,
  type TokenInfo,
} from './birdeye.js';
import { JupiterClient } from './jupiter.js';
import { computeSignals, type TechnicalSignals } from './indicators.js';
import {
  CORE_TARGET_PCT,
  LLM_TARGET_PCT,
  TOP10_TARGET_PCT,
  computeCurrentAllocations,
} from './allocations.js';
import {
  evaluateTradeProposal,
  nominateLlmBucketToken,
  type TradeDecision,
  type TradeProposal,
} from '../llm/tasks.js';
import { recalculateAllNavs } from '../state/nav.js';
import type { PublicCacheWriter } from '../public/cache.js';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_POOL_TO_TRADE = 10;
const MAX_TOP10_POSITIONS = 3;
const PER_TRADE_POOL_FRACTION = 0.1;
const MIN_LLM_LIQUIDITY_USDC = 500_000;

import type { PersonaContextProvider } from '../persona/context-provider.js';

export interface TradingLoopParams {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  birdeye: BirdeyeClient;
  jupiter: JupiterClient;
  llmRouter: LLMRouter;
  connection: Connection;
  cacheWriter?: PublicCacheWriter;
  intervalMs?: number;
  personaCtx?: PersonaContextProvider;
  onTradeExecuted?: (context: string) => void;
}

export class TradingLoop {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly params: TradingLoopParams) {}

  private async llmFor(task: import('../llm/routing.js').LlmTaskType) {
    const pCtx = this.params.personaCtx;
    if (pCtx) {
      const ctx = await pCtx.getSurvivalContext();
      return this.params.llmRouter.forWithPersona(task, ctx, pCtx.agentWallet);
    }
    return this.params.llmRouter.for(task);
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.params.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.safeRunCycle(), intervalMs);
    void this.safeRunCycle();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async safeRunCycle(): Promise<void> {
    try {
      await this.runCycle();
    } catch (err) {
      console.error('TradingLoop cycle error:', err);
    }
  }

  private async runCycle(): Promise<void> {
    let state = await this.params.db.loadState(this.params.adapter);
    if (state.pool.totalUsdcCurrentValue < MIN_POOL_TO_TRADE) {
      console.log('Pool too small to trade');
      return;
    }

    state = await this.runCoreBucket(state);
    state = await this.runTop10Bucket(state);
    state = await this.runLlmBucket(state);

    const totalValue = state.pool.totalUsdcCurrentValue;
    const deposited = state.pool.totalUsdcDeposited;
    const poolPerformancePct =
      deposited > 0 ? ((totalValue - deposited) / deposited) * 100 : 0;

    const freshAllocations = computeCurrentAllocations(state);
    state = {
      ...state,
      pool: {
        ...state.pool,
        allocations: { ...freshAllocations, lastRebalancedAt: Date.now() },
      },
      signals: {
        ...state.signals,
        lastPoolPerformancePct: poolPerformancePct,
        lastUpdatedAt: Date.now(),
      },
    };

    await this.params.db.saveState(state, this.params.adapter, this.params.cacheWriter);
  }

  private async runCoreBucket(state: PanthersState): Promise<PanthersState> {
    let candles: OhlcvCandle[];
    try {
      candles = await this.params.birdeye.getOhlcv(SOL_MINT);
    } catch (err) {
      console.error('Core: Birdeye OHLCV failed:', err);
      return state;
    }
    const signals = computeSignals(candles);
    if (!signals) {
      console.log('Core: insufficient candle data');
      return state;
    }

    const totalValue = state.pool.totalUsdcCurrentValue;
    const corePct = totalValue > 0
      ? state.pool.allocations.coreValueUsdc / totalValue
      : 0;
    const sentiment = state.signals.lastSentimentScore;

    let side: 'buy' | 'sell' | null = null;
    if (
      signals.rsi < 35 &&
      signals.trend !== 'down' &&
      sentiment > 0.4 &&
      corePct < CORE_TARGET_PCT + 0.05
    ) {
      side = 'buy';
    } else if (
      (signals.rsi > 70 || (signals.trend === 'down' && sentiment < 0.3)) &&
      corePct > CORE_TARGET_PCT - 0.05
    ) {
      side = 'sell';
    }

    if (!side) {
      console.log('Core: no signal this cycle');
      return state;
    }

    const proposedAmountUsdc = totalValue * PER_TRADE_POOL_FRACTION;
    return this.evaluateAndExecute(state, {
      bucket: 'core',
      side,
      tokenMint: SOL_MINT,
      tokenSymbol: 'SOL',
      signals,
      proposedAmountUsdc,
      currentBucketPct: corePct,
      targetBucketPct: CORE_TARGET_PCT,
    });
  }

  private async runTop10Bucket(state: PanthersState): Promise<PanthersState> {
    let tokens: TokenInfo[];
    try {
      tokens = await this.params.birdeye.getTop10Tokens();
    } catch (err) {
      console.error('Top10: Birdeye top list failed:', err);
      return state;
    }

    const totalValue = state.pool.totalUsdcCurrentValue;
    const top10Pct = totalValue > 0
      ? state.pool.allocations.top10ValueUsdc / totalValue
      : 0;
    let currentState = state;

    for (const token of tokens) {
      if (token.address === SOL_MINT || token.address === USDC_MINT) continue;

      const held = currentState.pool.openPositions.find(
        (p) => p.bucket === 'top10' && p.tokenMint === token.address,
      );
      const top10Positions = currentState.pool.openPositions.filter(
        (p) => p.bucket === 'top10',
      );

      let candles: OhlcvCandle[];
      try {
        candles = await this.params.birdeye.getOhlcv(token.address);
      } catch (err) {
        console.error(`Top10: OHLCV for ${token.symbol} failed:`, err);
        continue;
      }
      const signals = computeSignals(candles);
      if (!signals) continue;

      let side: 'buy' | 'sell' | null = null;
      if (!held && top10Positions.length < MAX_TOP10_POSITIONS) {
        if (signals.rsi < 40 && signals.trend === 'up') side = 'buy';
      } else if (held) {
        if (signals.rsi > 65 || signals.trend === 'down') side = 'sell';
      }
      if (!side) continue;

      const proposedAmountUsdc =
        currentState.pool.totalUsdcCurrentValue * PER_TRADE_POOL_FRACTION;

      currentState = await this.evaluateAndExecute(currentState, {
        bucket: 'top10',
        side,
        tokenMint: token.address,
        tokenSymbol: token.symbol,
        signals,
        proposedAmountUsdc,
        currentBucketPct: top10Pct,
        targetBucketPct: TOP10_TARGET_PCT,
      });
    }

    return currentState;
  }

  private async runLlmBucket(state: PanthersState): Promise<PanthersState> {
    const hasLlmPosition = state.pool.openPositions.some(
      (p) => p.bucket === 'llm',
    );
    if (hasLlmPosition) return state;

    let top10: TokenInfo[];
    try {
      top10 = await this.params.birdeye.getTop10Tokens();
    } catch (err) {
      console.error('LLM: Birdeye top list failed:', err);
      return state;
    }

    let nomination;
    try {
      nomination = await nominateLlmBucketToken(
        await this.llmFor('nomination'),
        top10,
        state.pool.openPositions,
        state.signals,
      );
    } catch (err) {
      console.error('LLM: nomination failed:', err);
      return state;
    }

    let info: TokenInfo;
    try {
      info = await this.params.birdeye.getTokenInfo(nomination.tokenMint);
    } catch (err) {
      console.error('LLM: getTokenInfo failed:', err);
      console.log('LLM nomination failed validation');
      return state;
    }
    if (info.liquidity < MIN_LLM_LIQUIDITY_USDC) {
      console.log(
        `LLM nomination failed validation: liquidity ${info.liquidity} < ${MIN_LLM_LIQUIDITY_USDC}`,
      );
      return state;
    }

    const totalValue = state.pool.totalUsdcCurrentValue;
    const probeUsdc = totalValue * LLM_TARGET_PCT;

    const quote = await this.params.jupiter.getQuote({
      inputMint: USDC_MINT,
      outputMint: nomination.tokenMint,
      amountUsdc: probeUsdc,
    });
    if (!quote) {
      console.log('LLM nomination failed validation: no Jupiter route');
      return state;
    }

    let candles: OhlcvCandle[];
    try {
      candles = await this.params.birdeye.getOhlcv(nomination.tokenMint);
    } catch (err) {
      console.error('LLM: OHLCV failed:', err);
      return state;
    }
    const signals = computeSignals(candles);
    if (!signals) {
      console.log('LLM: insufficient candle data');
      return state;
    }

    const llmPct = totalValue > 0
      ? state.pool.allocations.llmValueUsdc / totalValue
      : 0;

    return this.evaluateAndExecute(state, {
      bucket: 'llm',
      side: 'buy',
      tokenMint: nomination.tokenMint,
      tokenSymbol: nomination.tokenSymbol,
      signals,
      proposedAmountUsdc: probeUsdc,
      currentBucketPct: llmPct,
      targetBucketPct: LLM_TARGET_PCT,
      llmReasoning: nomination.reasoning,
    });
  }

  private async evaluateAndExecute(
    state: PanthersState,
    args: {
      bucket: 'core' | 'top10' | 'llm';
      side: 'buy' | 'sell';
      tokenMint: string;
      tokenSymbol: string;
      signals: TechnicalSignals;
      proposedAmountUsdc: number;
      currentBucketPct: number;
      targetBucketPct: number;
      llmReasoning?: string;
    },
  ): Promise<PanthersState> {
    const proposal: TradeProposal = {
      bucket: args.bucket,
      side: args.side,
      tokenMint: args.tokenMint,
      tokenSymbol: args.tokenSymbol,
      proposedAmountUsdc: args.proposedAmountUsdc,
      signals: args.signals,
      sentimentScore: state.signals.lastSentimentScore,
      poolPerformancePct: state.signals.lastPoolPerformancePct,
      currentBucketAllocationPct: args.currentBucketPct * 100,
      targetBucketAllocationPct: args.targetBucketPct * 100,
    };

    let decision: TradeDecision;
    try {
      decision = await evaluateTradeProposal(await this.llmFor('trade'), proposal);
    } catch (err) {
      console.error(`${args.bucket}: evaluateTradeProposal failed:`, err);
      return state;
    }

    console.log(
      `${args.bucket}: ${args.side} ${args.tokenSymbol} ${args.proposedAmountUsdc.toFixed(2)} USDC — ` +
        `${decision.decision}: ${decision.reasoning}`,
    );

    if (decision.decision !== 'approve') return state;

    const inputMint = args.side === 'buy' ? USDC_MINT : args.tokenMint;
    const outputMint = args.side === 'buy' ? args.tokenMint : USDC_MINT;

    let swap;
    try {
      swap = await this.params.jupiter.executeSwap({
        inputMint,
        outputMint,
        amountUsdc: args.proposedAmountUsdc,
      });
    } catch (err) {
      console.error(`${args.bucket}: executeSwap failed:`, err);
      return state;
    }

    const price = args.side === 'buy'
      ? args.proposedAmountUsdc / (swap.outputAmount || 1)
      : (swap.outputAmount || 0) / Math.max(args.proposedAmountUsdc, 1e-9);
    const size = args.side === 'buy' ? swap.outputAmount : args.proposedAmountUsdc;

    const trade: TradeRecord = {
      tokenMint: args.tokenMint,
      side: args.side,
      price,
      size,
      executedAt: Date.now(),
      pnl: 0,
      bucket: args.bucket,
      llmDecision: decision.decision,
      llmReasoning: decision.reasoning,
      txSignature: swap.txSignature,
    };

    let nextPositions: Position[];
    if (args.side === 'buy') {
      const newPosition: Position = {
        tokenMint: args.tokenMint,
        entryPrice: price,
        size,
        openedAt: Date.now(),
        bucket: args.bucket,
        ...(args.llmReasoning ? { llmReasoning: args.llmReasoning } : {}),
      };
      nextPositions = [...state.pool.openPositions, newPosition];
    } else {
      nextPositions = state.pool.openPositions.filter(
        (p) => !(p.bucket === args.bucket && p.tokenMint === args.tokenMint),
      );
    }

    const deltaValue = args.side === 'buy'
      ? 0
      : args.proposedAmountUsdc - args.proposedAmountUsdc;
    void deltaValue;

    let nextState: PanthersState = {
      ...state,
      pool: {
        ...state.pool,
        openPositions: nextPositions,
        tradingHistory: [...state.pool.tradingHistory, trade],
      },
    };

    nextState = {
      ...nextState,
      pool: {
        ...nextState.pool,
        allocations: {
          ...computeCurrentAllocations(nextState),
          lastRebalancedAt: nextState.pool.allocations.lastRebalancedAt,
        },
      },
    };

    nextState = recalculateAllNavs(nextState);
    return nextState;
  }
}
