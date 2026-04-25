import { MoltbookClient } from './client.js';
import { parseVerificationChallenge, formatAnswer, VerificationParseError } from './verification.js';
import { generateMoltbookPost } from '../llm/tasks.js';
import { CONFIG } from '../db/config-keys.js';
import type { LLMRouter } from '../llm/router.js';
import type { PersonaContextProvider } from '../persona/context-provider.js';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';

export type MoltbookTrigger =
  | 'nft_minted'
  | 'trade_executed'
  | 'donation_received'
  | 'market_update'
  | 'survival';

const DEDUP_MS = 30 * 60 * 1000;
const SUBMOLTS = ['aiagents', 'solana', 'autonomousai', 'technology'];

export class MoltbookPostingLoop {
  private lastPostedTriggers = new Map<string, number>();
  private verified = false;

  constructor(
    private readonly params: {
      client: MoltbookClient;
      llmRouter: LLMRouter;
      personaCtx: PersonaContextProvider;
      db: PanthersDb;
      adapter: PanthersStateAdapter;
    },
  ) {}

  async initialize(): Promise<void> {
    const { client, db } = this.params;

    const existingApiKey = db.config.get(CONFIG.MOLTBOOK_API_KEY);
    if (existingApiKey) {
      client.setApiKey(existingApiKey);
      const claimUrl = db.config.get(CONFIG.MOLTBOOK_CLAIM_URL);
      const verified = db.config.get(CONFIG.MOLTBOOK_VERIFIED) === 'true';
      this.verified = verified;
      if (!verified && claimUrl) {
        console.log(`[moltbook] Claim your agent: ${claimUrl}`);
      }
      console.log(`[moltbook] Restored registration (verified: ${verified})`);
    } else {
      const name = db.config.get(CONFIG.MOLTBOOK_NAME, {
        envKey: 'MOLTBOOK_NAME',
        defaultValue: 'Panthers Fund',
      })!;
      const description = db.config.get(CONFIG.MOLTBOOK_DESCRIPTION, {
        envKey: 'MOLTBOOK_DESCRIPTION',
        defaultValue: 'Autonomous AI NFT fund on Solana. No human in the loop.',
      })!;

      try {
        const result = await client.register(name, description);
        const reg = result.agent;
        db.config.set(CONFIG.MOLTBOOK_API_KEY, reg.api_key);
        db.config.set(CONFIG.MOLTBOOK_CLAIM_URL, reg.claim_url);
        client.setApiKey(reg.api_key);
        console.log(`[moltbook] Registered. Claim your agent: ${reg.claim_url}`);
      } catch (err) {
        console.error('[moltbook] Registration failed:', err);
        return;
      }
    }

    // Seed submolt subscriptions once
    const seeded = db.config.get(CONFIG.MOLTBOOK_SUBMOLTS_SEEDED) === 'true';
    if (!seeded && client.hasApiKey()) {
      for (const submolt of SUBMOLTS) {
        try {
          await client.subscribe(submolt);
        } catch (err) {
          console.error(`[moltbook] Failed to subscribe to ${submolt}:`, err);
        }
      }
      db.config.set(CONFIG.MOLTBOOK_SUBMOLTS_SEEDED, 'true');
      console.log(`[moltbook] Subscribed to submolts: ${SUBMOLTS.join(', ')}`);
    }
  }

  async onEvent(trigger: MoltbookTrigger, context: string): Promise<void> {
    const lastTime = this.lastPostedTriggers.get(trigger) ?? 0;
    if (Date.now() - lastTime < DEDUP_MS) return;

    if (!this.verified) {
      console.log('[moltbook] not yet claimed, skipping');
      return;
    }

    try {
      const survivalCtx = await this.params.personaCtx.getSurvivalContext();
      const wallet = this.params.personaCtx.agentWallet;
      const state = await this.params.db.loadState(this.params.adapter);

      const nftCount = Object.keys(state.nfts).length;
      const poolValueUsdc = state.pool.totalUsdcCurrentValue;
      const avgNavUsdc = nftCount > 0 ? poolValueUsdc / nftCount : 0;

      const llm = this.params.llmRouter.forWithPersona('moltbook_post', survivalCtx, wallet);
      const post = await generateMoltbookPost(llm, {
        trigger,
        context,
        poolValueUsdc,
        nftCount,
        avgNavUsdc,
        runwayDays: survivalCtx.estimatedRunwayDays,
      });

      const response = await this.params.client.createPost(post.submolt, post.title, post.content);
      this.lastPostedTriggers.set(trigger, Date.now());
      console.log(`[moltbook] Posted to ${post.submolt}: "${post.title}"`);

      if (response.verification_required && response.verification) {
        await this.solveVerification(
          response.verification.verification_code,
          response.verification.challenge_text,
        );
      }
    } catch (err) {
      console.error(`[moltbook] Failed to post for ${trigger}:`, err);
    }
  }

  private async solveVerification(code: string, challenge: string): Promise<void> {
    try {
      const result = parseVerificationChallenge(challenge);
      const answer = formatAnswer(result);
      const response = await this.params.client.verify(code, answer);
      if (response.success) {
        this.verified = true;
        this.params.db.config.set(CONFIG.MOLTBOOK_VERIFIED, 'true');
        console.log('[moltbook] Verification solved successfully');
      } else {
        console.warn(`[moltbook] Verification rejected: ${response.error ?? response.message}`);
      }
    } catch (err) {
      if (err instanceof VerificationParseError) {
        console.warn(`[moltbook] Cannot parse verification challenge, skipping: ${err.message}`);
      } else {
        console.error('[moltbook] Verification failed:', err);
      }
    }
  }
}
