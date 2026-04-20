export type LlmTaskType =
  | 'chat'
  | 'sentiment'
  | 'buy_intent'
  | 'haggle'
  | 'auction'
  | 'trade'
  | 'nomination'
  | 'news_summary';

export interface LlmModelRouting {
  chat: string;
  sentiment: string;
  buy_intent: string;
  haggle: string;
  auction: string;
  trade: string;
  nomination: string;
  news_summary: string;
}

export const DEFAULT_MODEL_ROUTING: LlmModelRouting = {
  chat: 'gemma3:4b',
  sentiment: 'gemma3:4b',
  buy_intent: 'gemma3:4b',
  haggle: 'qwen3:8b',
  auction: 'qwen3:8b',
  trade: 'llama3.3:70b',
  nomination: 'llama3.3:70b',
  news_summary: 'qwen3:8b',
};
