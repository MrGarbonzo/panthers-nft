import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { LLMRouter } from '../llm/router.js';
import type { PanthersBot } from './bot.js';
import {
  decideAndGeneratePost,
  type GroupPostType,
  type MarketContextSummary,
} from '../llm/tasks.js';
import type { MarketContext } from '../trading/market-context.js';
import type { PersonaContextProvider } from '../persona/context-provider.js';
import type { PanthersState } from '../state/schema.js';

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const SURVIVAL_POST_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export interface GroupActivityLoopParams {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  llmRouter: LLMRouter;
  bot: PanthersBot;
  market?: MarketContext;
  intervalMs?: number;
  personaCtx?: PersonaContextProvider;
  onSurvivalPost?: (text: string) => void;
}

export class GroupActivityLoop {
  private timer: NodeJS.Timeout | null = null;
  private lastPostAt: number = 0;
  private lastPostType: GroupPostType = 'nothing';

  constructor(private readonly params: GroupActivityLoopParams) {}

  start(): void {
    if (this.timer) return;
    const interval = this.params.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.safeTick(), interval);
    console.log(
      `GroupActivityLoop started (interval ${Math.round(interval / 1000)}s)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      console.error('GroupActivityLoop error:', err);
    }
  }

  private async tick(): Promise<void> {
    const state = await this.params.db.loadState(this.params.adapter);
    const hasActiveAuction = Object.values(state.auctions).some(
      (a) => a.status === 'active' || a.status === 'scheduled',
    );
    if (hasActiveAuction) return;

    if (await this.trySurvivalPost(state)) return;

    const nfts = Object.values(state.nfts);
    const totalNftCount = nfts.length;
    const avgNavUsdc =
      totalNftCount > 0
        ? nfts.reduce((s, n) => s + n.currentNav, 0) / totalNftCount
        : 0;
    const minutesSinceLastPost =
      this.lastPostAt === 0
        ? 999
        : Math.floor((Date.now() - this.lastPostAt) / 60000);

    const recentMessages = this.params.bot.getRecentMessages();
    const market = this.buildMarketSummary();

    const pCtx = this.params.personaCtx;
    const ctx = pCtx ? await pCtx.getSurvivalContext() : undefined;
    const llm = ctx && pCtx
      ? this.params.llmRouter.forWithPersona('news_summary', ctx, pCtx.agentWallet)
      : this.params.llmRouter.for('news_summary');

    const decision = await decideAndGeneratePost(
      llm,
      state.signals,
      recentMessages,
      {
        totalNftCount,
        poolValueUsdc: state.pool.totalUsdcCurrentValue,
        avgNavUsdc,
        hasActiveAuction,
        minutesSinceLastPost,
        market,
      },
    );

    if (decision.postType === 'nothing' || !decision.message.trim()) return;
    if (decision.postType === this.lastPostType) return;

    await this.params.bot.sendGroupMessage(decision.message);
    this.lastPostAt = Date.now();
    this.lastPostType = decision.postType;
  }

  private async trySurvivalPost(state: PanthersState): Promise<boolean> {
    const pCtx = this.params.personaCtx;
    if (!pCtx) return false;

    const ctx = await pCtx.getSurvivalContext();
    if (
      ctx.survivalState !== 'lean' &&
      ctx.survivalState !== 'critical' &&
      ctx.survivalState !== 'emergency'
    ) {
      return false;
    }

    const lastPost = state.agentConfig.lastSurvivalPostAt ?? 0;
    if (Date.now() - lastPost < SURVIVAL_POST_COOLDOWN_MS) return false;

    const walletMention =
      ctx.survivalState === 'critical' || ctx.survivalState === 'emergency'
        ? `\nYour wallet address is: ${pCtx.agentWallet}\nMention it in your post.`
        : '';

    const llm = this.params.llmRouter.forWithPersona(
      'chat',
      ctx,
      pCtx.agentWallet,
    );
    const result = await llm.invoke(
      '',
      `Write a single Telegram group post about your current situation. Facts only. No markdown. Under 3 sentences.${walletMention}`,
      300,
    );

    const text = result.trim();
    if (!text) return false;

    await this.params.bot.sendGroupMessage(text);
    this.lastPostAt = Date.now();
    this.lastPostType = 'nothing';

    const nextState: PanthersState = {
      ...state,
      agentConfig: {
        ...state.agentConfig,
        lastSurvivalPostAt: Date.now(),
      },
    };
    await this.params.db.saveState(nextState, this.params.adapter);

    this.params.onSurvivalPost?.(text);
    console.log(`[GroupActivity] Survival post: ${text.slice(0, 60)}...`);
    return true;
  }

  private buildMarketSummary(): MarketContextSummary | null {
    const snap = this.params.market?.getSnapshot();
    if (!snap) return null;
    return {
      solPriceUsd: snap.coins.solana.priceUsd,
      solChange24hPct: snap.coins.solana.change24hPct,
      btcPriceUsd: snap.coins.bitcoin.priceUsd,
      btcChange24hPct: snap.coins.bitcoin.change24hPct,
      ethPriceUsd: snap.coins.ethereum.priceUsd,
      ethChange24hPct: snap.coins.ethereum.change24hPct,
      fearGreedValue: snap.fearGreed?.value ?? null,
      fearGreedClassification: snap.fearGreed?.classification ?? null,
      ageSeconds: Math.floor((Date.now() - snap.lastUpdatedAt) / 1000),
    };
  }
}
