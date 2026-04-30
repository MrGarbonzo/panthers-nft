export interface TradingToken {
  symbol: string;
  coingeckoId: string;
  baseAddress: `0x${string}`;
  bucket: 'core' | 'top10' | 'speculative';
  maxPositionPct: number;
}

export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const WETH_BASE: `0x${string}` = '0x4200000000000000000000000000000000000006';

export const TRADING_TOKENS: TradingToken[] = [
  {
    symbol: 'WETH',
    coingeckoId: 'ethereum',
    baseAddress: WETH_BASE,
    bucket: 'core',
    maxPositionPct: 0.75,
  },
  {
    symbol: 'WBTC',
    coingeckoId: 'wrapped-bitcoin',
    baseAddress: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    bucket: 'top10',
    maxPositionPct: 0.10,
  },
  {
    symbol: 'LINK',
    coingeckoId: 'chainlink',
    baseAddress: '0xE4aB69C077896252FAFBD49EFD26B5D171A32410',
    bucket: 'top10',
    maxPositionPct: 0.10,
  },
  {
    symbol: 'AERO',
    coingeckoId: 'aerodrome-finance',
    baseAddress: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    bucket: 'speculative',
    maxPositionPct: 0.05,
  },
];

export function getBucketTargetPct(bucket: 'core' | 'top10' | 'speculative'): number {
  if (bucket === 'core') return 0.75;
  if (bucket === 'top10') return 0.20;
  return 0.05;
}
