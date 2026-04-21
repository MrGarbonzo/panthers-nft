import type { PanthersState } from '../state/schema.js';
import type { WalletBalances } from './wallet-monitor.js';
import {
  computeSurvivalState,
  computeTradingMood,
  type SurvivalContext,
} from './survival.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function buildSurvivalContext(params: {
  state: PanthersState;
  balances: WalletBalances;
  dailyBurnRate: number;
  firstBootAt: number;
}): SurvivalContext {
  const totalUsdc =
    params.balances.solanaUsdcBalance + params.balances.baseUsdcBalance;
  const estimatedRunwayDays =
    params.dailyBurnRate > 0 ? totalUsdc / params.dailyBurnRate : 999;
  const survivalState = computeSurvivalState(estimatedRunwayDays);

  const trades = params.state.pool.tradingHistory;
  const last20 = trades.slice(-20);
  const wins = last20.filter((t) => t.pnl > 0).length;
  const recentWinRate = last20.length > 0 ? wins / last20.length : 0.5;

  const sevenDaysAgo = Date.now() - SEVEN_DAYS_MS;
  const recentPnlUsdc = trades
    .filter((t) => t.executedAt > sevenDaysAgo)
    .reduce((sum, t) => sum + t.pnl, 0);

  const tradingMood = computeTradingMood(
    recentWinRate,
    recentPnlUsdc,
    params.state.pool.totalUsdcCurrentValue,
  );

  const daysOnline = Math.floor(
    (Date.now() - params.firstBootAt) / 86400000,
  );

  return {
    solanaUsdcBalance: params.balances.solanaUsdcBalance,
    baseUsdcBalance: params.balances.baseUsdcBalance,
    dailyBurnRateUsdc: params.dailyBurnRate,
    estimatedRunwayDays,
    survivalState,
    recentWinRate,
    recentPnlUsdc,
    totalTradeCount: trades.length,
    tradingMood,
    daysOnline,
    lastUpdatedAt: Date.now(),
  };
}
