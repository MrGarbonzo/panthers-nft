import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { LLMClient } from '../llm/client.js';
import type { PanthersBot } from './bot.js';
import { decideAndGeneratePost, type GroupPostType } from '../llm/tasks.js';

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

export interface GroupActivityLoopParams {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  llm: LLMClient;
  bot: PanthersBot;
  intervalMs?: number;
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
    if (hasActiveAuction) {
      console.log('GroupActivityLoop: skipping — active auction');
      return;
    }

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

    const decision = await decideAndGeneratePost(
      this.params.llm,
      state.signals,
      recentMessages,
      {
        totalNftCount,
        poolValueUsdc: state.pool.totalUsdcCurrentValue,
        avgNavUsdc,
        hasActiveAuction,
        minutesSinceLastPost,
      },
    );

    console.log(
      `GroupActivityLoop: decision=${decision.postType} — ${decision.reasoning}`,
    );

    if (decision.postType === 'nothing' || !decision.message.trim()) return;
    if (decision.postType === this.lastPostType) {
      console.log(
        `GroupActivityLoop: skipping — same type as last post (${decision.postType})`,
      );
      return;
    }

    await this.params.bot.sendGroupMessage(decision.message);
    this.lastPostAt = Date.now();
    this.lastPostType = decision.postType;
  }
}
