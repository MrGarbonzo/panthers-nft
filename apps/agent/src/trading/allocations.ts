import type { PanthersState, PoolAllocations } from '../state/schema.js';

export const CORE_TARGET_PCT = 0.6;
export const TOP10_TARGET_PCT = 0.3;
export const LLM_TARGET_PCT = 0.1;
export const REBALANCE_DRIFT_THRESHOLD = 0.03;

export function computeCurrentAllocations(state: PanthersState): PoolAllocations {
  let core = 0;
  let top10 = 0;
  let llm = 0;
  for (const position of state.pool.openPositions) {
    const valueUsdc = position.entryPrice * position.size;
    if (position.bucket === 'core') core += valueUsdc;
    else if (position.bucket === 'top10') top10 += valueUsdc;
    else if (position.bucket === 'llm') llm += valueUsdc;
  }
  return {
    coreValueUsdc: core,
    top10ValueUsdc: top10,
    llmValueUsdc: llm,
    lastRebalancedAt: state.pool.allocations.lastRebalancedAt,
  };
}

export function computeRebalanceNeeded(
  allocations: PoolAllocations,
  totalPoolValue: number,
): { bucket: 'core' | 'top10' | 'llm'; deltaUsdc: number }[] {
  const result: { bucket: 'core' | 'top10' | 'llm'; deltaUsdc: number }[] = [];
  const threshold = totalPoolValue * REBALANCE_DRIFT_THRESHOLD;

  const check = (
    bucket: 'core' | 'top10' | 'llm',
    current: number,
    targetPct: number,
  ): void => {
    const target = totalPoolValue * targetPct;
    if (Math.abs(current - target) > threshold) {
      result.push({ bucket, deltaUsdc: target - current });
    }
  };

  check('core', allocations.coreValueUsdc, CORE_TARGET_PCT);
  check('top10', allocations.top10ValueUsdc, TOP10_TARGET_PCT);
  check('llm', allocations.llmValueUsdc, LLM_TARGET_PCT);

  return result;
}
