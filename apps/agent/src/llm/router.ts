import { LLMClient, type LLM } from './client.js';
import type { ConfigStore } from '../db/config-store.js';
import { DEFAULT_MODEL_ROUTING } from './routing.js';
import type { LlmTaskType, LlmModelRouting } from './routing.js';
import { CONFIG } from '../db/config-keys.js';
import type { PersonaEngine } from '../persona/engine.js';
import type { SurvivalContext } from '../persona/survival.js';

export type PersonaLLM = LLM;

export class LLMRouter {
  private readonly clients = new Map<string, LLMClient>();
  private routing: LlmModelRouting;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private persona: PersonaEngine | null = null;

  constructor(
    apiKey: string,
    baseUrl: string,
    private readonly config: ConfigStore,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    const cached = config.getJson<Partial<LlmModelRouting>>(
      CONFIG.LLM_MODEL_ROUTING,
      {},
    );
    this.routing = { ...DEFAULT_MODEL_ROUTING, ...cached };
    console.log('[LLMRouter] Model routing:', JSON.stringify(this.routing));
  }

  setPersona(engine: PersonaEngine): void {
    this.persona = engine;
  }

  for(task: LlmTaskType): LLMClient {
    const model = this.routing[task];
    if (!this.clients.has(model)) {
      this.clients.set(
        model,
        new LLMClient(this.apiKey, model, 0.7, 4096, this.baseUrl),
      );
    }
    return this.clients.get(model)!;
  }

  forWithPersona(
    task: LlmTaskType,
    ctx: SurvivalContext,
    agentWallet: string,
  ): PersonaLLM {
    const client = this.for(task);
    const persona = this.persona;
    if (!persona) return client;
    const prefix = persona.buildSystemPrompt(ctx, task, agentWallet);
    return {
      invoke: (sys, user, max) => client.invoke(`${prefix}\n\n${sys}`, user, max),
      invokeForJson: <T>(sys: string, user: string, max?: number) =>
        client.invokeForJson<T>(`${prefix}\n\n${sys}`, user, max),
    };
  }

  updateRouting(updates: Partial<LlmModelRouting>): void {
    this.routing = { ...this.routing, ...updates };
    this.config.setJson(CONFIG.LLM_MODEL_ROUTING, this.routing);
    this.clients.clear();
    console.log('[LLMRouter] Routing updated:', JSON.stringify(this.routing));
  }

  getRouting(): LlmModelRouting {
    return { ...this.routing };
  }
}
