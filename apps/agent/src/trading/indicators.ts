import { RSI, SMA } from 'technicalindicators';
import type { OhlcvCandle } from './birdeye.js';

export interface TechnicalSignals {
  rsi: number;
  sma20: number;
  priceVsSma: number;
  trend: 'up' | 'down' | 'neutral';
}

export function computeSignals(candles: OhlcvCandle[]): TechnicalSignals | null {
  if (candles.length < 21) return null;

  const closes = candles.map((c) => c.close);

  const rsiSeries = RSI.calculate({ period: 14, values: closes });
  const smaSeries = SMA.calculate({ period: 20, values: closes });

  const rsi = rsiSeries[rsiSeries.length - 1];
  const sma20 = smaSeries[smaSeries.length - 1];
  if (rsi === undefined || sma20 === undefined || sma20 === 0) return null;

  const latestClose = closes[closes.length - 1]!;
  const priceVsSma = ((latestClose - sma20) / sma20) * 100;

  let trend: 'up' | 'down' | 'neutral' = 'neutral';
  if (priceVsSma > 2) trend = 'up';
  else if (priceVsSma < -2) trend = 'down';

  return { rsi, sma20, priceVsSma, trend };
}
