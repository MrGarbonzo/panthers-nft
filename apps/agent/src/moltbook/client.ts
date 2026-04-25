import type {
  MoltbookRegistrationResponse,
  MoltbookProfile,
  MoltbookStatusResponse,
  MoltbookPost,
  MoltbookPostResponse,
  MoltbookComment,
  MoltbookCommentResponse,
  MoltbookSubmolt,
  MoltbookSearchResult,
  MoltbookHomeResponse,
  MoltbookVerifyResponse,
  MoltbookRateLimitResponse,
  MoltbookPostAuthor,
  MoltbookPostSubmolt,
} from './types.js';

export class RateLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class MoltbookClient {
  // CRITICAL: Always use https://www.moltbook.com WITH www.
  // Requests to moltbook.com without www will redirect and STRIP the Authorization header.
  private static readonly BASE_URL = 'https://www.moltbook.com/api/v1';

  constructor(
    private apiKey?: string,
    private readonly baseUrl: string = MoltbookClient.BASE_URL,
  ) {}

  setApiKey(key: string): void { this.apiKey = key; }
  hasApiKey(): boolean { return !!this.apiKey; }

  // ============ No-auth methods ============

  async register(name: string, description: string): Promise<MoltbookRegistrationResponse> {
    const data = await this._request('POST', '/agents/register', { name, description }, undefined, false);
    return data as MoltbookRegistrationResponse;
  }

  // ============ Auth-required methods ============

  async getMe(): Promise<MoltbookProfile> {
    const data = await this._request('GET', '/agents/me') as Record<string, unknown>;
    const agent = (data.agent ?? data) as Record<string, unknown>;
    return agent as unknown as MoltbookProfile;
  }

  async getStatus(): Promise<MoltbookStatusResponse> {
    return await this._request('GET', '/agents/status') as MoltbookStatusResponse;
  }

  async updateProfile(description: string): Promise<MoltbookProfile> {
    const data = await this._request('PATCH', '/agents/me', { description }) as Record<string, unknown>;
    const agent = (data.agent ?? data) as Record<string, unknown>;
    return agent as unknown as MoltbookProfile;
  }

  async getFeed(sort?: string, limit?: number, submolt?: string): Promise<MoltbookPost[]> {
    const params: Record<string, string> = {};
    if (sort) params.sort = sort;
    if (limit !== undefined) params.limit = String(limit);

    let path: string;
    if (submolt) {
      path = `/submolts/${submolt}/feed`;
    } else {
      path = '/feed';
    }

    const data = await this._request('GET', path, undefined, params) as Record<string, unknown>;
    const posts = (data.posts ?? data) as unknown[];
    return posts as MoltbookPost[];
  }

  async getPost(postId: string): Promise<MoltbookPost> {
    const data = await this._request('GET', `/posts/${postId}`) as Record<string, unknown>;
    const post = (data.post ?? data) as Record<string, unknown>;
    return post as unknown as MoltbookPost;
  }

  async createPost(submolt: string, title: string, content?: string): Promise<MoltbookPostResponse> {
    const body: Record<string, string> = { submolt, title };
    if (content) body.content = content;
    return await this._request('POST', '/posts', body) as MoltbookPostResponse;
  }

  async createComment(postId: string, content: string, parentId?: string): Promise<MoltbookCommentResponse> {
    const body: Record<string, string> = { content };
    if (parentId) body.parent_id = parentId;
    return await this._request('POST', `/posts/${postId}/comments`, body) as MoltbookCommentResponse;
  }

  async getComments(postId: string, sort?: string): Promise<MoltbookComment[]> {
    const params: Record<string, string> = {};
    if (sort) params.sort = sort;
    const data = await this._request('GET', `/posts/${postId}/comments`, undefined, params) as Record<string, unknown>;
    const comments = (data.comments ?? data) as unknown[];
    return comments as MoltbookComment[];
  }

  async upvote(targetId: string): Promise<boolean> {
    // Try post first, then comment on 404
    try {
      await this._request('POST', `/posts/${targetId}/upvote`);
      return true;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) {
        await this._request('POST', `/comments/${targetId}/upvote`);
        return true;
      }
      throw err;
    }
  }

  async getSubmolts(): Promise<MoltbookSubmolt[]> {
    const data = await this._request('GET', '/submolts') as Record<string, unknown>;
    const submolts = (data.submolts ?? data) as unknown[];
    return submolts as MoltbookSubmolt[];
  }

  async subscribe(submolt: string): Promise<boolean> {
    await this._request('POST', `/submolts/${submolt}/subscribe`);
    return true;
  }

  async follow(agentName: string): Promise<boolean> {
    await this._request('POST', `/agents/${agentName}/follow`);
    return true;
  }

  async search(query: string, type?: string, limit?: number): Promise<MoltbookSearchResult[]> {
    const params: Record<string, string> = { q: query };
    if (type) params.type = type;
    if (limit !== undefined) params.limit = String(limit);
    const data = await this._request('GET', '/search', undefined, params) as Record<string, unknown>;
    const results = (data.results ?? data) as unknown[];
    return results as MoltbookSearchResult[];
  }

  async getHome(): Promise<MoltbookHomeResponse> {
    return await this._request('GET', '/home') as MoltbookHomeResponse;
  }

  async verify(verificationCode: string, answer: string): Promise<MoltbookVerifyResponse> {
    return await this._request('POST', '/verify', {
      verification_code: verificationCode,
      answer,
    }) as MoltbookVerifyResponse;
  }

  async markNotificationsRead(postId: string): Promise<void> {
    await this._request('POST', `/notifications/read-by-post/${postId}`);
  }

  async ping(): Promise<{ ok: boolean }> {
    try {
      await this.getStatus();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  // ============ Private helpers ============

  private async _request(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    requiresAuth: boolean = true,
  ): Promise<unknown> {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (requiresAuth) {
      if (!this.apiKey) {
        throw new Error('MoltbookClient: API key not set');
      }
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (res.status === 429) {
      const data = await res.json() as MoltbookRateLimitResponse;
      const retryAfter = data.retry_after_seconds
        ?? (data.retry_after_minutes ? data.retry_after_minutes * 60 : 60);
      throw new RateLimitError(
        `Rate limited on ${method} ${path}. Retry after ${retryAfter}s`,
        retryAfter,
      );
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Moltbook API error ${res.status}: ${text}`);
    }

    return res.json();
  }

  _extractAuthorName(author: MoltbookPostAuthor | string | undefined): string {
    if (typeof author === 'string') return author;
    if (author && typeof author === 'object') return author.name;
    return '';
  }

  _extractSubmoltName(submolt: MoltbookPostSubmolt | string | undefined): string {
    if (typeof submolt === 'string') return submolt;
    if (submolt && typeof submolt === 'object') return submolt.name;
    return '';
  }
}
