import { v4 as uuidv4 } from 'uuid';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { RedemptionRequest } from '../state/schema.js';
import { appendActivity } from '../state/schema.js';
import { redeemNft } from './deposit.js';
import { calculateSwingFactor } from '../trading/swing.js';
import type { PublicCacheWriter } from '../public/cache.js';

const REDEMPTION_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours

export async function processRedemptionRequest(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  tokenId: string;
  ownerWallet: string;
  cacheWriter?: PublicCacheWriter;
}): Promise<RedemptionRequest> {
  const state = await params.db.loadState(params.adapter);

  const nft = state.nfts[params.tokenId];
  if (!nft) {
    throw new Error(`NFT not found: ${params.tokenId}`);
  }
  if (nft.ownerWallet.toLowerCase() !== params.ownerWallet.toLowerCase()) {
    throw new Error('not_owner');
  }

  // Check for duplicate queued redemption
  const existing = Object.values(state.redemptionQueue ?? {}).find(
    (r) => r.tokenId === params.tokenId && r.status === 'queued',
  );
  if (existing) {
    throw new Error('duplicate_redemption');
  }

  // Calculate queued redemptions total (excluding this one)
  const queuedRedemptionsUsdc = Object.values(state.redemptionQueue ?? {})
    .filter((r) => r.status === 'queued')
    .reduce((sum, r) => sum + r.netUsdc, 0);

  const swingFactor = calculateSwingFactor({
    redemptionNavUsdc: nft.currentNav,
    liquidUsdcBalance: state.liquidUsdcBalance,
    totalPoolValueUsdc: state.pool.totalUsdcCurrentValue,
    queuedRedemptionsUsdc,
  });

  const feePct = state.agentConfig.feePctOnBurn;
  const effectiveNav = nft.currentNav * (1 - swingFactor);
  const netUsdc = Math.round(effectiveNav * (1 - feePct) * 100) / 100;
  const now = Date.now();

  const request: RedemptionRequest = {
    requestId: uuidv4(),
    tokenId: params.tokenId,
    ownerWallet: params.ownerWallet,
    requestedAt: now,
    expiresAt: now + REDEMPTION_WINDOW_MS,
    navAtRequest: nft.currentNav,
    swingFactor,
    effectiveNav,
    feePct,
    netUsdc,
    status: 'queued',
  };

  // Immediate fulfillment if liquid USDC covers it
  if (state.liquidUsdcBalance >= netUsdc) {
    request.status = 'fulfilled';
    request.fulfilledAt = now;

    // Remove NFT from state via redeemNft
    await redeemNft({
      db: params.db,
      adapter: params.adapter,
      tokenId: params.tokenId,
      feePct,
      cacheWriter: params.cacheWriter,
    });

    // Reload state after redeemNft modified it, then add the redemption request + update balance
    const postRedeemState = await params.db.loadState(params.adapter);
    let nextState = {
      ...postRedeemState,
      redemptionQueue: {
        ...(postRedeemState.redemptionQueue ?? {}),
        [request.requestId]: request,
      },
      liquidUsdcBalance: postRedeemState.liquidUsdcBalance - netUsdc,
    };
    nextState = appendActivity(nextState, {
      type: 'withdrawal',
      wallet: params.ownerWallet,
      nftLabel: `Panthers #${nft.nftIndex}`,
      amountUsdc: netUsdc,
    });
    await params.db.saveState(nextState, params.adapter, params.cacheWriter);

    console.log(
      `[Withdraw] Fulfilled immediately: ${request.requestId} tokenId=${params.tokenId} net=${netUsdc} swing=${(swingFactor * 100).toFixed(1)}%`,
    );
  } else {
    // Queue for later fulfillment
    let nextState = {
      ...state,
      redemptionQueue: {
        ...(state.redemptionQueue ?? {}),
        [request.requestId]: request,
      },
    };
    nextState = appendActivity(nextState, {
      type: 'withdrawal',
      wallet: params.ownerWallet,
      nftLabel: `Panthers #${nft.nftIndex}`,
      amountUsdc: netUsdc,
    });
    await params.db.saveState(nextState, params.adapter, params.cacheWriter);

    console.log(
      `[Withdraw] Queued: ${request.requestId} tokenId=${params.tokenId} net=${netUsdc} swing=${(swingFactor * 100).toFixed(1)}% (insufficient liquid USDC)`,
    );
  }

  return request;
}

export async function fulfillQueuedRedemptions(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  cacheWriter?: PublicCacheWriter;
  onFulfilled?: (request: RedemptionRequest) => void;
}): Promise<void> {
  let state = await params.db.loadState(params.adapter);
  const queue = state.redemptionQueue ?? {};
  const now = Date.now();
  let changed = false;

  for (const req of Object.values(queue)) {
    if (req.status !== 'queued') continue;

    // Expire old requests
    if (req.expiresAt < now) {
      queue[req.requestId] = { ...req, status: 'expired' };
      console.log(`[Withdraw] Expired: ${req.requestId} tokenId=${req.tokenId}`);
      changed = true;
      continue;
    }

    // Try to fulfill
    if (state.liquidUsdcBalance >= req.netUsdc) {
      try {
        await redeemNft({
          db: params.db,
          adapter: params.adapter,
          tokenId: req.tokenId,
          feePct: req.feePct,
          cacheWriter: params.cacheWriter,
        });

        // Reload after redeemNft
        state = await params.db.loadState(params.adapter);

        const fulfilled: RedemptionRequest = {
          ...req,
          status: 'fulfilled',
          fulfilledAt: now,
        };
        state = {
          ...state,
          redemptionQueue: {
            ...(state.redemptionQueue ?? {}),
            [req.requestId]: fulfilled,
          },
          liquidUsdcBalance: state.liquidUsdcBalance - req.netUsdc,
        };
        await params.db.saveState(state, params.adapter, params.cacheWriter);

        console.log(
          `[Withdraw] Fulfilled queued: ${req.requestId} tokenId=${req.tokenId} net=${req.netUsdc}`,
        );
        params.onFulfilled?.(fulfilled);
        changed = true;
      } catch (err) {
        console.error(`[Withdraw] Failed to fulfill ${req.requestId}:`, err);
      }
    }
  }

  if (changed && !Object.values(queue).some((r) => r.status === 'queued')) {
    // Save final expired-only changes if we didn't save above
    const finalState = await params.db.loadState(params.adapter);
    if (finalState.redemptionQueue !== state.redemptionQueue) {
      await params.db.saveState(
        { ...finalState, redemptionQueue: state.redemptionQueue ?? {} },
        params.adapter,
        params.cacheWriter,
      );
    }
  }
}
