import type { XClient } from './x-client.js';
import type { LLMRouter } from '../llm/router.js';
import type { PersonaContextProvider } from '../persona/context-provider.js';

export type XPostTrigger =
  | 'trade_executed'
  | 'nav_milestone'
  | 'survival_state_change'
  | 'auction_announced'
  | 'donation_received'
  | 'bridge_completed'
  | 'daily_survival';

const DEDUP_MS = 60 * 60 * 1000;
const SURVIVAL_CHECK_MS = 6 * 60 * 60 * 1000;

export class XPostingLoop {
  private lastPostedTriggers = new Map<string, number>();
  private lastSurvivalState = '';

  constructor(
    private readonly params: {
      xClient: XClient;
      llmRouter: LLMRouter;
      personaCtx: PersonaContextProvider;
    },
  ) {}

  async onEvent(trigger: XPostTrigger, context?: string): Promise<void> {
    const lastTime = this.lastPostedTriggers.get(trigger) ?? 0;
    if (Date.now() - lastTime < DEDUP_MS) return;

    try {
      const ctx = await this.params.personaCtx.getSurvivalContext();
      const wallet = this.params.personaCtx.agentWallet;

      if (ctx.survivalState !== this.lastSurvivalState) {
        this.lastSurvivalState = ctx.survivalState;
        if (trigger !== 'survival_state_change') {
          void this.onEvent('survival_state_change', `State: ${ctx.survivalState}`);
        }
      }

      const llm = this.params.llmRouter.forWithPersona('chat', ctx, wallet);
      const text = await llm.invoke(
        '',
        `Write a single X (Twitter) post about: ${trigger}.\n` +
          `Context: ${context ?? ''}\n` +
          'Under 280 characters. No hashtags. No markdown. In character. Short and declarative.',
        200,
      );

      const trimmed = text.trim();
      if (trimmed) {
        await this.params.xClient.post(trimmed);
        this.lastPostedTriggers.set(trigger, Date.now());
      }
    } catch (err) {
      console.error(`[XPostingLoop] Failed for ${trigger}:`, err);
    }
  }

  async checkDailySurvival(): Promise<void> {
    try {
      const ctx = await this.params.personaCtx.getSurvivalContext();
      if (
        ctx.survivalState !== 'critical' &&
        ctx.survivalState !== 'emergency'
      ) {
        return;
      }
      const lastTime = this.lastPostedTriggers.get('daily_survival') ?? 0;
      if (Date.now() - lastTime < SURVIVAL_CHECK_MS) return;
      await this.onEvent(
        'daily_survival',
        `Runway: ${ctx.estimatedRunwayDays.toFixed(1)} days. State: ${ctx.survivalState}.`,
      );
    } catch (err) {
      console.error('[XPostingLoop] Daily survival check failed:', err);
    }
  }

  async mirrorSurvivalPost(text: string): Promise<void> {
    try {
      await this.params.xClient.post(text.slice(0, 280));
    } catch (err) {
      console.error('[XPostingLoop] Mirror failed:', err);
    }
  }
}
