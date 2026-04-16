import OpenAI from 'openai';

export const SECRET_AI_MODELS = [
  'deepseek-r1:70b',
  'gemma3:4b',
  'llama3.3:70b',
  'qwen3:8b',
] as const;

export type SecretAIModel = (typeof SECRET_AI_MODELS)[number];

export class LLMClient {
  private client: OpenAI | null = null;
  private readonly resolvedModel: string;
  private readonly _baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(
    apiKey?: string,
    model?: string,
    private readonly temperature: number = 0.7,
    private readonly maxTokens: number = 800,
  ) {
    this.apiKey = apiKey ?? process.env.SECRET_AI_API_KEY;
    let base = (
      process.env.SECRET_AI_BASE_URL ?? 'https://ai.api.scrt.network'
    ).replace(/\/+$/, '');
    if (!base.endsWith('/v1')) base = `${base}/v1`;
    this._baseUrl = base;
    const configured =
      model ?? process.env.SECRET_AI_MODEL ?? 'deepseek-r1:70b';
    const match = SECRET_AI_MODELS.find((m) =>
      m.toLowerCase().includes(configured.toLowerCase()),
    );
    this.resolvedModel = match ?? 'deepseek-r1:70b';
  }

  private ensureClient(): OpenAI {
    if (this.client) return this.client;
    if (!this.apiKey) throw new Error('LLMClient: SECRET_AI_API_KEY not set');
    this.client = new OpenAI({
      baseURL: this._baseUrl,
      apiKey: this.apiKey,
      defaultHeaders: { 'X-API-Key': this.apiKey },
    });
    return this.client;
  }

  async invoke(
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<string> {
    const client = this.ensureClient();
    const response = await client.chat.completions.create({
      model: this.resolvedModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: this.temperature,
      max_tokens: maxTokens ?? this.maxTokens,
    });
    return response.choices[0]?.message.content ?? '';
  }

  async invokeForJson<T>(
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<T> {
    const raw = await this.invoke(systemPrompt, userPrompt, maxTokens);
    let cleaned = raw
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    const firstBrace = cleaned.search(/[\[{]/);
    const lastBrace = Math.max(
      cleaned.lastIndexOf(']'),
      cleaned.lastIndexOf('}'),
    );
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error('LLMClient: failed to extract JSON from: ' + raw);
    }
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    return JSON.parse(cleaned) as T;
  }
}

export function createLLMClient(apiKey?: string): LLMClient {
  return new LLMClient(apiKey);
}
