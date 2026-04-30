export interface SwingFactorParams {
  redemptionNavUsdc: number;
  liquidUsdcBalance: number;
  totalPoolValueUsdc: number;
  queuedRedemptionsUsdc: number;
}

export function calculateSwingFactor(params: SwingFactorParams): number {
  // Immediate fulfillment possible — use minimum swing
  if (params.liquidUsdcBalance >= params.redemptionNavUsdc) {
    return 0.005;
  }

  const liquidityRequired = params.redemptionNavUsdc + params.queuedRedemptionsUsdc;
  const shortfall = Math.max(0, liquidityRequired - params.liquidUsdcBalance);
  const shortfallPct = params.totalPoolValueUsdc > 0
    ? shortfall / params.totalPoolValueUsdc
    : 1;

  // Swing factor scales from 0.5% (instant) to 3% (severe illiquidity)
  const swingFactor = 0.005 + shortfallPct * 0.5;
  return Math.min(Math.max(swingFactor, 0.005), 0.03);
}
