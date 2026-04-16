import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { PublicCacheWriter } from './cache.js';

export interface PublicBalanceServerParams {
  cacheWriter: PublicCacheWriter;
  port?: number;
  devMode?: boolean;
  startedAt?: number;
}

const DEFAULT_PORT = 3000;

export class PublicBalanceServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly startedAt: number;
  private readonly devMode: boolean;

  constructor(private readonly params: PublicBalanceServerParams) {
    this.port = params.port ?? DEFAULT_PORT;
    this.startedAt = params.startedAt ?? Date.now();
    this.devMode = params.devMode ?? false;
  }

  start(): void {
    if (this.server) return;
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.listen(this.port, () => {
      console.log(`PublicBalanceServer listening on :${this.port}`);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const method = req.method ?? 'GET';
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    let status = 200;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('X-Panthers-Agent', 'true');

    try {
      if (method === 'OPTIONS') {
        status = 204;
        res.statusCode = status;
        res.end();
        return;
      }

      if (method !== 'GET') {
        status = 405;
        this.respond(res, status, { error: 'Method not allowed' });
        return;
      }

      const nftMintMatch = urlPath.match(/^\/nft\/([^/]+)$/);
      const nftNameMatch = urlPath.match(/^\/nft\/name\/(.+)$/);

      if (urlPath === '/health') {
        const cache = await this.params.cacheWriter.read();
        this.respond(res, status, {
          status: 'ok',
          uptime: Math.floor((Date.now() - this.startedAt) / 1000),
          nftCount: cache?.fundSummary.totalNftCount ?? 0,
          poolValueUsdc: cache?.fundSummary.totalPoolValueUsdc ?? 0,
          devMode: this.devMode,
          timestamp: Date.now(),
        });
        return;
      }

      if (urlPath === '/fund') {
        const cache = await this.params.cacheWriter.read();
        if (!cache) {
          status = 503;
          this.respond(res, status, { error: 'Cache not initialized' });
          return;
        }
        this.respond(res, status, cache.fundSummary);
        return;
      }

      if (nftNameMatch) {
        const cache = await this.params.cacheWriter.read();
        if (!cache) {
          status = 503;
          this.respond(res, status, { error: 'Cache not initialized' });
          return;
        }
        const query = decodeURIComponent(nftNameMatch[1]!);
        const record = this.params.cacheWriter.lookupByName(cache, query);
        if (!record) {
          status = 404;
          this.respond(res, status, { error: 'NFT not found' });
          return;
        }
        this.respond(res, status, record);
        return;
      }

      if (nftMintMatch) {
        const cache = await this.params.cacheWriter.read();
        if (!cache) {
          status = 503;
          this.respond(res, status, { error: 'Cache not initialized' });
          return;
        }
        const mint = decodeURIComponent(nftMintMatch[1]!);
        const record = cache.byMint[mint];
        if (!record) {
          status = 404;
          this.respond(res, status, { error: 'NFT not found' });
          return;
        }
        this.respond(res, status, record);
        return;
      }

      status = 404;
      this.respond(res, status, { error: 'Not found' });
    } catch (err) {
      status = 500;
      console.error('PublicBalanceServer error:', err);
      this.respond(res, status, { error: 'Internal server error' });
    } finally {
      const ms = Date.now() - start;
      console.log(`[public-api] ${method} ${urlPath} ${status} ${ms}ms`);
    }
  }

  private respond(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  }
}
