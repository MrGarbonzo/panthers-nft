import assert from 'node:assert/strict';
import { computeSignals } from './indicators.js';
import type { OhlcvCandle } from './birdeye.js';

const candles: OhlcvCandle[] = [];
for (let i = 0; i < 50; i++) {
  const close = 100 + i * 0.5;
  candles.push({
    timestamp: i * 900,
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.3,
    close,
    volume: 1000,
  });
}

const signals = computeSignals(candles);
assert.ok(signals !== null, 'computeSignals returned null');
assert.ok(
  typeof signals.rsi === 'number' && signals.rsi >= 0 && signals.rsi <= 100,
  `rsi out of range: ${signals.rsi}`,
);
assert.ok(
  typeof signals.sma20 === 'number' && signals.sma20 > 0,
  `sma20 invalid: ${signals.sma20}`,
);
assert.ok(
  signals.trend === 'up' ||
    signals.trend === 'down' ||
    signals.trend === 'neutral',
  `trend invalid: ${signals.trend}`,
);

console.log(
  `Indicators test OK: rsi=${signals.rsi.toFixed(2)} sma20=${signals.sma20.toFixed(2)} ` +
    `priceVsSma=${signals.priceVsSma.toFixed(2)}% trend=${signals.trend}`,
);
