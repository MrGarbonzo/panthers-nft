import { LLMClient } from './client.js';
import type { ConfigStore } from '../db/config-store.js';
import { DEFAULT_MODEL_ROUTING } from './routing.js';
import type { LlmTaskType, LlmModelRouting } from './routing.js';
import { CONFIG } from '../db/config-keys.js';

export class LLMRouter {
  private readonly clients = new Map<string, LLMClient>();
  private routing: LlmModelRouting;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    apiKey: string,
    baseUrl: string,
    private readonly config: ConfigStore,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.routing = config.getJson<LlmModelRouting>(
      CONFIG.LLM_MODEL_ROUTING,
      DEFAULT_MODEL_ROUTING,
    );
    console.log('[LLMRouter] Model routing:', JSON.stringify(this.routing));
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
