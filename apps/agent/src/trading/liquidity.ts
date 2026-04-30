export function computeLiquidityFloor(params: {
  totalPoolValueUsdc: number;
  queuedRedemptionsUsdc: number;
}): number {
  return Math.max(params.totalPoolValueUsdc * 0.25, params.queuedRedemptionsUsdc);
}

export function computeDeployableCapital(params: {
  totalPoolValueUsdc: number;
  liquidUsdcBalance: number;
  queuedRedemptionsUsdc: number;
}): number {
  const floor = computeLiquidityFloor({
    totalPoolValueUsdc: params.totalPoolValueUsdc,
    queuedRedemptionsUsdc: params.queuedRedemptionsUsdc,
  });
  return Math.max(0, params.liquidUsdcBalance - floor);
}
