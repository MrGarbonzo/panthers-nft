import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { LLMRouter } from '../llm/router.js';
import type { PublicCacheWriter } from '../public/cache.js';
import type { AuctionRecord, PanthersState } from '../state/schema.js';
import { decideAuctionType } from '../llm/tasks.js';
import { createAuction } from './engine.js';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const OPPORTUNISTIC_RANDOM_PCT = 0.02;
const SENTIMENT_THRESHOLD = 0.85;
const MILESTONES = [10, 25, 50];

import type { PersonaContextProvider } from '../persona/context-provider.js';

export interface AuctionSchedulerParams {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  llmRouter: LLMRouter;
  cacheWriter: PublicCacheWriter;
  intervalMs?: number;
  personaCtx?: PersonaContextProvider;
}

export class AuctionScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly params: AuctionSchedulerParams) {}

  private async llmFor(task: import('../llm/routing.js').LlmTaskType) {
    const pCtx = this.params.personaCtx;
    if (pCtx) {
      const ctx = await pCtx.getSurvivalContext();
      return this.params.llmRouter.forWithPersona(task, ctx, pCtx.agentWallet);
    }
    return this.params.llmRouter.for(task);
  }

  start(): void {
    if (this.timer) return;
    const interval = this.params.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(
      () => void this.safeCheckOpportunistic(),
      interval,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scheduleAuction(scheduledAt: number): Promise<AuctionRecord> {
    const state = await this.params.db.loadState(this.params.adapter);
    const decision = await decideAuctionType(
      await this.llmFor('auction'),
      state.signals,
      Object.keys(state.nfts).length,
    );
    const auction = createAuction({
      type: decision.type,
      startPriceUsdc: decision.startPriceUsdc,
      durationMinutes: decision.durationMinutes,
      triggeredBy: 'scheduled',
      scheduledAt,
    });

    const nextState: PanthersState = {
      ...state,
      auctions: { ...state.auctions, [auction.auctionId]: auction },
    };
    await this.params.db.saveState(
      nextState,
      this.params.adapter,
      this.params.cacheWriter,
    );

    console.log(`[AuctionScheduler] Auction scheduled for ${new Date(scheduledAt).toUTCString()}`);
    return auction;
  }

  private async safeCheckOpportunistic(): Promise<void> {
    try {
      await this.checkOpportunistic();
    } catch (err) {
      console.error('AuctionScheduler error:', err);
    }
  }

  private async checkOpportunistic(): Promise<void> {
    let state = await this.params.db.loadState(this.params.adapter);
    const hasActive = Object.values(state.auctions).some(
      (a) => a.status === 'active' || a.status === 'scheduled',
    );
    if (hasActive) return;

    let triggerReason: string | null = null;
    const { lastSentimentScore, lastPoolPerformancePct } = state.signals;
    const lastMilestone = state.agentConfig.lastAnnouncedMilestonePct ?? 0;
    const nextMilestone = MILESTONES.find(
      (m) => lastPoolPerformancePct >= m && lastMilestone < m,
    );

    if (lastSentimentScore > SENTIMENT_THRESHOLD) {
      triggerReason = 'sentiment';
    } else if (nextMilestone !== undefined) {
      triggerReason = `milestone_${nextMilestone}`;
      state = {
        ...state,
        agentConfig: {
          ...state.agentConfig,
          lastAnnouncedMilestonePct: nextMilestone,
        },
      };
    } else if (Math.random() < OPPORTUNISTIC_RANDOM_PCT) {
      triggerReason = 'random';
    }

    if (triggerReason === null) return;

    const decision = await decideAuctionType(
      await this.llmFor('auction'),
      state.signals,
      Object.keys(state.nfts).length,
    );
    const auction = createAuction({
      type: decision.type,
      startPriceUsdc: decision.startPriceUsdc,
      durationMinutes: decision.durationMinutes,
      triggeredBy: 'opportunistic',
    });

    const nextState: PanthersState = {
      ...state,
      auctions: { ...state.auctions, [auction.auctionId]: auction },
    };
    await this.params.db.saveState(
      nextState,
      this.params.adapter,
      this.params.cacheWriter,
    );

    console.log(`[AuctionScheduler] Opportunistic auction triggered by ${triggerReason}`);
  }
}
