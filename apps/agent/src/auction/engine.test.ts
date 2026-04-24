import assert from 'node:assert/strict';
import type { Bid } from '../state/schema.js';
import {
  createAuction,
  tickDutchAuction,
  placeBid,
  getWinningBid,
  DUTCH_DROP_INTERVAL_MS,
  ENGLISH_EXTENSION_MS,
} from './engine.js';

// Test 1 — Dutch price decay
{
  const auction = createAuction({
    type: 'dutch',
    startPriceUsdc: 100,
    durationMinutes: 60,
    triggeredBy: 'opportunistic',
  });
  const t0 = auction.dutchNextDropAt!;
  const ticked1 = tickDutchAuction(auction, t0);
  assert.equal(ticked1.currentPrice, 95, `ticked1 ${ticked1.currentPrice}`);
  const ticked2 = tickDutchAuction(ticked1, t0 + DUTCH_DROP_INTERVAL_MS);
  assert.equal(ticked2.currentPrice, 90.25, `ticked2 ${ticked2.currentPrice}`);
  console.log(
    `Test 1 OK — Dutch decay: 100 → ${ticked1.currentPrice} → ${ticked2.currentPrice}`,
  );
}

// Test 2 — Dutch floor enforcement
{
  let a = createAuction({
    type: 'dutch',
    startPriceUsdc: 10,
    durationMinutes: 999,
    triggeredBy: 'opportunistic',
  });
  let t = a.dutchNextDropAt!;
  for (let i = 0; i < 200; i++) {
    a = tickDutchAuction(a, t);
    t += DUTCH_DROP_INTERVAL_MS;
  }
  assert.ok(a.currentPrice >= 5, `floor not honored: ${a.currentPrice}`);
  assert.ok(a.currentPrice <= 5.01, `floor overshoot: ${a.currentPrice}`);
  console.log(`Test 2 OK — Dutch floor honored: settled at ${a.currentPrice}`);
}

// Test 3 — English bidding + anti-snipe
{
  const ea = createAuction({
    type: 'english',
    startPriceUsdc: 100,
    durationMinutes: 30,
    triggeredBy: 'opportunistic',
  });
  const now = Date.now();
  const bid1: Bid = { bidderWallet: 'w1', amount: 110, placedAt: now };
  const bid2: Bid = { bidderWallet: 'w2', amount: 150, placedAt: now };
  const bid3: Bid = { bidderWallet: 'w3', amount: 200, placedAt: now };

  const ea2 = placeBid(placeBid(placeBid(ea, bid1, now), bid2, now), bid3, now);
  assert.equal(ea2.currentPrice, 200);
  assert.equal(ea2.bids.length, 3);
  assert.equal(getWinningBid(ea2)!.amount, 200);

  const closeToExpiry = ea2.expiresAt - 60_000;
  const lateBid: Bid = {
    bidderWallet: 'w4',
        amount: 250,
    placedAt: closeToExpiry,
  };
  const ea3 = placeBid(ea2, lateBid, closeToExpiry);
  assert.equal(
    ea3.expiresAt,
    closeToExpiry + ENGLISH_EXTENSION_MS,
    `expiresAt ${ea3.expiresAt}, expected ${closeToExpiry + ENGLISH_EXTENSION_MS}`,
  );
  console.log('Test 3 OK — English bidding + anti-snipe extension verified');
}

// Test 4 — Bid rejection
{
  const ra = createAuction({
    type: 'english',
    startPriceUsdc: 100,
    durationMinutes: 30,
    triggeredBy: 'opportunistic',
  });
  const low: Bid = { bidderWallet: 'w', amount: 50, placedAt: Date.now() };
  assert.throws(() => placeBid(ra, low), /Bid too low/);
  console.log('Test 4 OK — low bid rejected with "Bid too low"');
}

console.log('Engine tests PASSED');
