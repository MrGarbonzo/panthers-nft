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
  haggle: 'gemma3:4b',
  auction: 'gemma3:4b',
  trade: 'gemma3:4b',
  nomination: 'gemma3:4b',
  news_summary: 'gemma3:4b',
};
