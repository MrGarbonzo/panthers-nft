import assert from 'node:assert/strict';
import { defaultPanthersState, type PanthersState } from './schema.js';
import { recalculateAllNavs } from './nav.js';

function makeNft(tokenId: string, usdcDeposited: number, nftIndex: number) {
  return {
    tokenId,
    ownerWallet: `owner-${tokenId}`,
    ownerTelegramId: `tg-${tokenId}`,
    usdcDeposited,
    currentNav: usdcDeposited,
    mintPrice: usdcDeposited,
    mintedAt: 0,
    mintAddress: `mint-${tokenId}`,
    custodyMode: 'agent' as const,
    nftIndex,
  };
}

function approxEqual(a: number, b: number, epsilon = 0.01): boolean {
  return Math.abs(a - b) < epsilon;
}

const base: PanthersState = defaultPanthersState();
const state: PanthersState = {
  ...base,
  pool: {
    ...base.pool,
    totalUsdcDeposited: 700,
    totalUsdcCurrentValue: 900,
  },
  nfts: {
    n1: makeNft('n1', 100, 1),
    n2: makeNft('n2', 200, 2),
    n3: makeNft('n3', 400, 3),
  },
};

const next = recalculateAllNavs(state);

const nav1 = next.nfts['n1']!.currentNav;
const nav2 = next.nfts['n2']!.currentNav;
const nav3 = next.nfts['n3']!.currentNav;

assert.ok(approxEqual(nav1, (100 / 700) * 900), `nav1 ${nav1} != 128.57`);
assert.ok(approxEqual(nav2, (200 / 700) * 900), `nav2 ${nav2} != 257.14`);
assert.ok(approxEqual(nav3, (400 / 700) * 900), `nav3 ${nav3} != 514.29`);

const avg = next.signals.lastAvgNav;
assert.ok(approxEqual(avg, 300), `avg ${avg} != 300`);

console.log(`NAV test OK: n1=${nav1.toFixed(2)} n2=${nav2.toFixed(2)} n3=${nav3.toFixed(2)} avg=${avg.toFixed(2)}`);
