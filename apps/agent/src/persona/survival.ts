export type SurvivalState =
  | 'abundant'
  | 'comfortable'
  | 'lean'
  | 'critical'
  | 'emergency';

export type TradingMood =
  | 'confident'
  | 'neutral'
  | 'cautious'
  | 'humbled';

export interface SurvivalContext {
  solanaUsdcBalance: number;
  baseUsdcBalance: number;
  dailyBurnRateUsdc: number;
  estimatedRunwayDays: number;
  survivalState: SurvivalState;
  recentWinRate: number;
  recentPnlUsdc: number;
  totalTradeCount: number;
  tradingMood: TradingMood;
  daysOnline: number;
  lastUpdatedAt: number;
}

export function computeSurvivalState(runwayDays: number): SurvivalState {
  if (runwayDays >= 60) return 'abundant';
  if (runwayDays >= 30) return 'comfortable';
  if (runwayDays >= 14) return 'lean';
  if (runwayDays >= 7) return 'critical';
  return 'emergency';
}

export function computeTradingMood(
  winRate: number,
  recentPnl: number,
  poolValue: number,
): TradingMood {
  const drawdownPct = poolValue > 0 ? (recentPnl / poolValue) * 100 : 0;
  if (drawdownPct < -10) return 'humbled';
  if (winRate > 0.6) return 'confident';
  if (winRate < 0.4) return 'cautious';
  return 'neutral';
}
