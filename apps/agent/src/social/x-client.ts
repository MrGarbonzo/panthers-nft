import { TwitterApi } from 'twitter-api-v2';

const MAX_POSTS_PER_DAY = 15;

export class XClient {
  private client: TwitterApi;
  private postsToday = 0;
  private lastResetDate = '';

  constructor(params: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  }) {
    this.client = new TwitterApi({
      appKey: params.apiKey,
      appSecret: params.apiSecret,
      accessToken: params.accessToken,
      accessSecret: params.accessTokenSecret,
    });
  }

  async post(text: string): Promise<string | null> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.postsToday = 0;
      this.lastResetDate = today;
    }
    if (this.postsToday >= MAX_POSTS_PER_DAY) {
      console.log('[XClient] Daily post limit reached, skipping');
      return null;
    }
    try {
      const trimmed = text.slice(0, 280);
      const result = await this.client.v2.tweet(trimmed);
      this.postsToday++;
      console.log(`[XClient] Posted (${this.postsToday}/${MAX_POSTS_PER_DAY}): ${trimmed.slice(0, 50)}...`);
      return result.data.id;
    } catch (err) {
      console.error('[XClient] Post failed:', err);
      return null;
    }
  }

  getRemainingPostsToday(): number {
    return MAX_POSTS_PER_DAY - this.postsToday;
  }
}
