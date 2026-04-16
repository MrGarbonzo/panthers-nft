import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicCacheWriter } from './cache.js';
import { defaultPanthersState, type NftRecord, type PanthersState } from '../state/schema.js';

function makeNft(overrides: Partial<NftRecord>): NftRecord {
  return {
    tokenId: overrides.tokenId ?? 'token',
    ownerWallet: 'owner',
    ownerTelegramId: 'tg',
    usdcDeposited: overrides.usdcDeposited ?? 100,
    currentNav: overrides.currentNav ?? 100,
    mintPrice: 100,
    mintedAt: 0,
    mintAddress: overrides.mintAddress ?? 'mint',
    custodyMode: overrides.custodyMode ?? 'agent',
    nftIndex: overrides.nftIndex ?? 1,
    ...overrides,
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'panthers-cache-'));
const cachePath = path.join(tmpDir, 'cache.json');

const base: PanthersState = defaultPanthersState();
const state: PanthersState = {
  ...base,
  pool: {
    ...base.pool,
    totalUsdcDeposited: 1280,
    totalUsdcCurrentValue: 1447.23,
  },
  nfts: {
    t1: makeNft({
      tokenId: 't1',
      nftIndex: 1,
      usdcDeposited: 80,
      currentNav: 100,
      mintAddress: 'mintA',
      custodyMode: 'agent',
    }),
    t2: makeNft({
      tokenId: 't2',
      nftIndex: 142,
      usdcDeposited: 700,
      currentNav: 847.23,
      mintAddress: 'mintB',
      custodyMode: 'self',
    }),
    t3: makeNft({
      tokenId: 't3',
      nftIndex: 7,
      usdcDeposited: 500,
      currentNav: 500,
      mintAddress: 'mintC',
      custodyMode: 'agent',
    }),
  },
};

const writer = new PublicCacheWriter(cachePath);
await writer.write(state);

const cache = await writer.read();
assert.ok(cache !== null, 'cache read returned null');

assert.equal(Object.keys(cache.byMint).length, 3, 'byMint entry count');
assert.ok(cache.byMint['mintA'], 'mintA present');
assert.ok(cache.byMint['mintB'], 'mintB present');
assert.ok(cache.byMint['mintC'], 'mintC present');

const r142 = cache.byName['panthers#142'];
assert.ok(r142, 'panthers#142 missing');
assert.equal(r142.navUsdc, 847.23, 'nav for #142');
assert.ok(
  Math.abs(r142.gainPct - ((847.23 - 700) / 700) * 100) < 0.01,
  `gainPct wrong: ${r142.gainPct}`,
);

assert.equal(cache.fundSummary.totalNftCount, 3);
assert.equal(cache.fundSummary.totalPoolValueUsdc, 1447.23);

const variants: Array<[string, boolean]> = [
  ['Panthers #142', true],
  ['#142', true],
  ['142', true],
  ['panthers#142', true],
  ['Panthers#142', true],
  ['Panthers#999', false],
];

const variantResults: string[] = [];
for (const [query, shouldMatch] of variants) {
  const result = writer.lookupByName(cache, query);
  const ok = shouldMatch ? result !== null : result === null;
  variantResults.push(
    `  ${query.padEnd(16)} → ${result ? 'found #' + (result.name.match(/#(\d+)$/)?.[1] ?? '?') : 'null'} (${ok ? 'OK' : 'FAIL'})`,
  );
  assert.ok(
    ok,
    `lookupByName(${query}) expected ${shouldMatch ? 'match' : 'null'}, got ${result ? 'match' : 'null'}`,
  );
}

console.log('Cache test OK');
console.log(variantResults.join('\n'));
console.log(
  `panthers#142: nav=${r142.navUsdc} gainPct=${r142.gainPct.toFixed(2)} custody=${r142.custodyMode}`,
);

await fs.rm(tmpDir, { recursive: true, force: true });
