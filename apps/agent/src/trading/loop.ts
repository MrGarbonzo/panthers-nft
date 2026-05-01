import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { LLMRouter } from '../llm/router.js';
import type { PersonaContextProvider } from '../persona/context-provider.js';
import type { MarketContext } from './market-context.js';
import type { OneInchClient } from './oneinch.js';
import type { PublicCacheWriter } from '../public/cache.js';
import { CONFIG } from '../db/config-keys.js';
import { computeDeployableCapital, computeLiquidityFloor } from './liquidity.js';
import { computeCurrentAllocations, computeRebalanceNeeded } from './allocations.js';
import { computeSignals, type TechnicalSignals } from './indicators.js';
import { evaluateTradingDecision } from '../llm/tasks.js';
import { appendTradingDecision, type PanthersState, type Position } from '../state/schema.js';
import { TRADING_TOKENS } from './tokens.js';

export interface TradingLoopParams {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  llmRouter: LLMRouter;
  personaCtx: PersonaContextProvider;
  marketCtx: MarketContext;
  oneInchClient: OneInchClient;
  publicClient: any;
  walletClient: any;
  cacheWriter?: PublicCacheWriter;
  baseNetwork: 'base' | 'base-sepolia';
}

export interface TradingLoopResult {
  action: 'traded' | 'rebalanced' | 'nothing' | 'skipped';
  reason: string;
  tradesExecuted: number;
}

const MAX_TRADES_PER_DAY = 3;
const MIN_TRADE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_REBALANCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_DEPLOYABLE_USDC = 10;
const MAX_TRADE_PCT = 0.20; // max 20% of deployable capital per trade

function utcDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export class TradingLoop {
  constructor(private readonly params: TradingLoopParams) {}

  async evaluate(): Promise<TradingLoopResult> {
    const { db, adapter, llmRouter, personaCtx, marketCtx, oneInchClient, cacheWriter, baseNetwork } = this.params;

    // Check market context availability
    const snapshot = marketCtx.getSnapshot();
    if (!snapshot) {
      console.log('[trading] No market context — skipping');
      return { action: 'skipped', reason: 'no market context', tradesExecuted: 0 };
    }

    const state = await db.loadState(adapter);

    // Compute liquidity
    const queuedRedemptionsUsdc = Object.values(state.redemptionQueue ?? {})
      .filter((r) => r.status === 'queued')
      .reduce((sum, r) => sum + r.netUsdc, 0);

    const totalTvl = state.pool.totalUsdcCurrentValue;
    const liquidityFloor = computeLiquidityFloor({
      totalPoolValueUsdc: totalTvl,
      queuedRedemptionsUsdc,
    });
    const deployableCapital = computeDeployableCapital({
      totalPoolValueUsdc: totalTvl,
      liquidUsdcBalance: state.liquidUsdcBalance,
      queuedRedemptionsUsdc,
    });

    if (deployableCapital < MIN_DEPLOYABLE_USDC) {
      console.log(`[trading] Insufficient deployable capital: ${deployableCapital.toFixed(2)} USDC`);
      return { action: 'skipped', reason: 'insufficient deployable capital', tradesExecuted: 0 };
    }

    // Never trade if pending redemptions exceed 50% of liquid USDC
    if (state.liquidUsdcBalance > 0 && queuedRedemptionsUsdc > state.liquidUsdcBalance * 0.5) {
      console.log('[trading] Pending redemptions exceed 50% of liquid USDC — skipping');
      return { action: 'skipped', reason: 'pending redemptions too high', tradesExecuted: 0 };
    }

    // Rate limits
    const today = utcDateStr();
    const tradesTodayDate = db.config.get(CONFIG.TRADES_TODAY_DATE);
    let tradesToday = Number(db.config.get(CONFIG.TRADES_TODAY) ?? '0');
    if (tradesTodayDate !== today) {
      tradesToday = 0;
      db.config.set(CONFIG.TRADES_TODAY, '0');
      db.config.set(CONFIG.TRADES_TODAY_DATE, today);
    }

    if (tradesToday >= MAX_TRADES_PER_DAY) {
      console.log(`[trading] Daily trade limit reached (${tradesToday}/${MAX_TRADES_PER_DAY})`);
      return { action: 'skipped', reason: 'daily trade limit reached', tradesExecuted: 0 };
    }

    const lastTradeAt = Number(db.config.get(CONFIG.LAST_TRADE_AT) ?? '0');
    if (Date.now() - lastTradeAt < MIN_TRADE_INTERVAL_MS) {
      console.log('[trading] Too soon since last trade');
      return { action: 'skipped', reason: 'trade cooldown active', tradesExecuted: 0 };
    }

    // Technical signals from WETH price history (if available from market context)
    // For now, signals are null unless we have candle data
    const signals: TechnicalSignals | null = null;

    // Allocations
    const allocations = computeCurrentAllocations(state);

    // Persona context for LLM
    let personaContext = '';
    try {
      const ctx = await personaCtx.getSurvivalContext();
      personaContext = `Agent runway: ${ctx.estimatedRunwayDays.toFixed(0)} days. Survival state: ${ctx.survivalState}.`;
    } catch {
      personaContext = 'Persona context unavailable.';
    }

    // LLM decision
    let decision;
    try {
      const survivalCtx = await personaCtx.getSurvivalContext();
      const llm = llmRouter.forWithPersona('trade', survivalCtx, personaCtx.agentWallet);
      decision = await evaluateTradingDecision(llm, {
        deployableCapital,
        liquidityFloor,
        totalTvl,
        currentPositions: state.pool.openPositions,
        allocations,
        marketSnapshot: snapshot,
        signals,
        tradesToday,
        pendingRedemptionsUsdc: queuedRedemptionsUsdc,
        personaContext,
      });
    } catch (err) {
      console.error('[trading] LLM decision failed:', err);
      return { action: 'skipped', reason: 'LLM decision failed', tradesExecuted: 0 };
    }

    console.log(
      `[trading] Decision: ${decision.decision} ${decision.action ?? ''} ${decision.token ?? ''} ${decision.amountUsdc ? decision.amountUsdc.toFixed(2) + ' USDC' : ''} — ${decision.reasoning}`,
    );

    // Log every decision to the trading decision log — including "nothing"
    let logState = appendTradingDecision(state, {
      bucket: (decision.bucket as any) ?? 'core',
      side: (decision.action as any) ?? 'buy',
      tokenSymbol: decision.token ?? '-',
      tokenMint: '-',
      proposedAmountUsdc: decision.amountUsdc ?? 0,
      decision: decision.decision === 'nothing' ? 'wait' : 'approve',
      reasoning: decision.reasoning,
      rsi: 0,
      trend: 'neutral',
      executed: false,
      paperTrade: baseNetwork === 'base-sepolia',
    });
    await db.saveState(logState, adapter, cacheWriter);

    if (decision.decision === 'nothing') {
      return { action: 'nothing', reason: decision.reasoning, tradesExecuted: 0 };
    }

    if (decision.decision === 'rebalance') {
      const lastRebalanceAt = Number(db.config.get(CONFIG.LAST_REBALANCE_AT) ?? '0');
      if (Date.now() - lastRebalanceAt < MIN_REBALANCE_INTERVAL_MS) {
        console.log('[trading] Rebalance cooldown active');
        return { action: 'skipped', reason: 'rebalance cooldown', tradesExecuted: 0 };
      }

      const drifts = computeRebalanceNeeded(allocations, totalTvl);
      if (drifts.length === 0) {
        console.log('[trading] No rebalance needed — allocations within threshold');
        return { action: 'nothing', reason: 'allocations balanced', tradesExecuted: 0 };
      }

      console.log(`[trading] Rebalance needed: ${drifts.map((d) => `${d.bucket} ${d.deltaUsdc > 0 ? '+' : ''}${d.deltaUsdc.toFixed(2)}`).join(', ')}`);
      db.config.set(CONFIG.LAST_REBALANCE_AT, String(Date.now()));
      // Rebalance execution would go here with real swaps
      // For now, log and return
      return { action: 'rebalanced', reason: decision.reasoning, tradesExecuted: 0 };
    }

    // Execute trade
    if (!decision.token || !decision.action || !decision.amountUsdc) {
      console.log('[trading] Incomplete trade decision — skipping');
      return { action: 'skipped', reason: 'incomplete trade decision', tradesExecuted: 0 };
    }

    const token = TRADING_TOKENS.find((t) => t.symbol === decision.token);
    if (!token) {
      console.log(`[trading] Unknown token: ${decision.token}`);
      return { action: 'skipped', reason: `unknown token: ${decision.token}`, tradesExecuted: 0 };
    }

    // Cap at 20% of deployable capital
    const maxAmount = deployableCapital * MAX_TRADE_PCT;
    const tradeAmount = Math.min(decision.amountUsdc, maxAmount);

    const paperTrade = baseNetwork === 'base-sepolia';

    try {
      if (paperTrade) {
        console.log(
          `[trading] Paper trade: ${decision.action} ${token.symbol} for ${tradeAmount.toFixed(2)} USDC`,
        );
      } else {
        // Real trade execution
        const usdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
        const fromToken = decision.action === 'buy' ? usdcAddress : token.baseAddress;
        const toToken = decision.action === 'buy' ? token.baseAddress : usdcAddress;
        const amountWei = BigInt(Math.floor(tradeAmount * 1e6));

        const result = await oneInchClient.executeSwap({
          fromToken,
          toToken,
          amountWei,
          slippagePct: 1,
          walletClient: this.params.walletClient,
          publicClient: this.params.publicClient,
        });
        console.log(`[trading] Swap executed: ${result.txHash}`);
      }

      // Record in state
      const price = snapshot.coins[token.coingeckoId]?.priceUsd ?? 0;
      const size = price > 0 ? tradeAmount / price : 0;
      let nextState: PanthersState;

      if (decision.action === 'buy') {
        const newPosition: Position = {
          tokenMint: token.baseAddress,
          entryPrice: price,
          size,
          openedAt: Date.now(),
          bucket: token.bucket,
        };
        nextState = {
          ...state,
          pool: {
            ...state.pool,
            openPositions: [...state.pool.openPositions, newPosition],
          },
          // Paper trading: reduce liquid balance as if USDC was spent
          liquidUsdcBalance: state.liquidUsdcBalance - tradeAmount,
        };
      } else {
        // Sell — close matching position
        const posIdx = state.pool.openPositions.findIndex(
          (p) => p.tokenMint === token.baseAddress,
        );
        if (posIdx >= 0) {
          const pos = state.pool.openPositions[posIdx]!;
          const pnl = (price - pos.entryPrice) * pos.size;
          const saleValue = price * pos.size;
          const positions = [...state.pool.openPositions];
          positions.splice(posIdx, 1);
          nextState = {
            ...state,
            pool: {
              ...state.pool,
              openPositions: positions,
              tradingHistory: [
                ...state.pool.tradingHistory,
                {
                  tokenMint: token.baseAddress,
                  side: 'sell',
                  price,
                  size: pos.size,
                  executedAt: Date.now(),
                  pnl,
                  bucket: token.bucket,
                  llmDecision: 'approve',
                  llmReasoning: decision.reasoning,
                },
              ],
            },
            // Paper trading: add USDC back from sale at current price
            liquidUsdcBalance: state.liquidUsdcBalance + saleValue,
          };
        } else {
          nextState = state;
        }
      }

      nextState = appendTradingDecision(nextState, {
        bucket: token.bucket,
        side: decision.action,
        tokenSymbol: token.symbol,
        tokenMint: token.baseAddress,
        proposedAmountUsdc: tradeAmount,
        decision: 'approve',
        reasoning: decision.reasoning,
        rsi: 0,
        trend: 'neutral',
        executed: true,
        paperTrade,
      });

      await db.saveState(nextState, adapter, cacheWriter);

      // Update rate limit counters
      db.config.set(CONFIG.TRADES_TODAY, String(tradesToday + 1));
      db.config.set(CONFIG.TRADES_TODAY_DATE, today);
      db.config.set(CONFIG.LAST_TRADE_AT, String(Date.now()));

      return { action: 'traded', reason: decision.reasoning, tradesExecuted: 1 };
    } catch (err) {
      console.error('[trading] Trade execution failed:', err);

      // Log the failed attempt
      let failState = appendTradingDecision(state, {
        bucket: token.bucket,
        side: decision.action,
        tokenSymbol: token.symbol,
        tokenMint: token.baseAddress,
        proposedAmountUsdc: tradeAmount,
        decision: 'approve',
        reasoning: `Failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        rsi: 0,
        trend: 'neutral',
        executed: false,
        paperTrade,
      });
      await db.saveState(failState, adapter, cacheWriter);

      return { action: 'skipped', reason: 'trade execution failed', tradesExecuted: 0 };
    }
  }
}
