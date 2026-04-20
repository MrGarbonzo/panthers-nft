import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PublicCacheWriter } from './cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let indexHtml: string;
try {
  indexHtml = readFileSync(resolve(__dirname, 'index.html'), 'utf-8');
} catch {
  indexHtml = '<html><body>Panthers Fund — loading...</body></html>';
  console.warn('[Server] index.html not found in dist/');
}

export interface PublicBalanceServerParams {
  cacheWriter: PublicCacheWriter;
  port?: number;
  devMode?: boolean;
  startedAt?: number;
  nftImagesDir?: string;
}

const DEFAULT_PORT = 3000;

export class PublicBalanceServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly startedAt: number;
  private readonly devMode: boolean;
  private readonly nftImagesDir: string;

  constructor(private readonly params: PublicBalanceServerParams) {
    this.port = params.port ?? DEFAULT_PORT;
    this.startedAt = params.startedAt ?? Date.now();
    this.devMode = params.devMode ?? false;
    this.nftImagesDir = params.nftImagesDir ?? '/data/nft-images';
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
        this.respondJson(res, status, { error: 'Method not allowed' });
        return;
      }

      if (urlPath === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.statusCode = 200;
        res.end(indexHtml);
        return;
      }

      res.setHeader('Content-Type', 'application/json');

      const nftMintMatch = urlPath.match(/^\/nft\/([^/]+)$/);
      const nftNameMatch = urlPath.match(/^\/nft\/name\/(.+)$/);
      const nftImageMatch = urlPath.match(/^\/nft-image\/([^/]+)$/);
      const metadataMatch = urlPath.match(/^\/metadata\/([^/]+)$/);

      if (urlPath === '/health') {
        const cache = await this.params.cacheWriter.read();
        this.respondJson(res, status, {
          status: 'ok',
          uptime: Math.floor((Date.now() - this.startedAt) / 1000),
          nftCount: cache?.fundSummary.totalNftCount ?? 0,
          poolValueUsdc: cache?.fundSummary.totalPoolValueUsdc ?? 0,
          devMode: this.devMode,
          timestamp: Date.now(),
        });
        return;
      }

      if (urlPath === '/stats') {
        const cache = await this.params.cacheWriter.read();
        if (!cache) {
          status = 503;
          this.respondJson(res, status, { error: 'Cache not initialized' });
          return;
        }
        this.respondJson(res, status, cache.stats);
        return;
      }

      if (urlPath === '/nfts') {
        const cache = await this.params.cacheWriter.read();
        if (!cache) {
          status = 503;
          this.respondJson(res, status, { error: 'Cache not initialized' });
          return;
        }
        const nfts = Object.values(cache.byMint).sort(
          (a, b) => a.nftIndex - b.nftIndex,
        );
        this.respondJson(res, status, nfts);
        return;
      }

      if (urlPath === '/fund') {
        const cache = await this.params.cacheWriter.read();
        if (!cache) {
          status = 503;
          this.respondJson(res, status, { error: 'Cache not initialized' });
          return;
        }
        this.respondJson(res, status, cache.fundSummary);
        return;
      }

      if (nftImageMatch) {
        const tokenId = decodeURIComponent(nftImageMatch[1]!);
        const safeName = tokenId.replace(/[^a-zA-Z0-9_-]/g, '');
        const imgPath = resolve(this.nftImagesDir, `${safeName}.png`);
        const placeholderPath = resolve(this.nftImagesDir, 'placeholder.png');

        const servePath = existsSync(imgPath)
          ? imgPath
          : existsSync(placeholderPath)
            ? placeholderPath
            : null;

        if (servePath) {
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.statusCode = 200;
          createReadStream(servePath).pipe(res);
          return;
        }
        status = 404;
        this.respondJson(res, status, { error: 'Image not found' });
        return;
      }

      if (metadataMatch) {
        const tokenId = decodeURIComponent(metadataMatch[1]!);
        const cache = await this.params.cacheWriter.read();
        if (!cache) {
          status = 503;
          this.respondJson(res, status, { error: 'Cache not initialized' });
          return;
        }
        const nft = Object.values(cache.byMint).find(n => n.tokenId === tokenId);
        if (!nft) {
          status = 404;
          this.respondJson(res, status, { error: 'NFT not found' });
          return;
        }
        const host = req.headers.host ?? 'localhost';
        const protocol = req.headers['x-forwarded-proto'] ?? 'http';
        this.respondJson(res, status, {
          name: nft.name,
          symbol: 'PANTH',
          description: 'Panthers Fund — an autonomous AI trading fund on Solana.',
          image: `${protocol}://${host}/nft-image/${tokenId}`,
          external_url: `${protocol}://${host}/`,
          attributes: [],
        });
        return;
      }

      if (nftNameMatch) {
        const cache = await this.params.cacheWriter.read();
        if (!cache) {
          status = 503;
          this.respondJson(res, status, { error: 'Cache not initialized' });
          return;
        }
        const query = decodeURIComponent(nftNameMatch[1]!);
        const record = this.params.cacheWriter.lookupByName(cache, query);
        if (!record) {
          status = 404;
          this.respondJson(res, status, { error: 'NFT not found' });
          return;
        }
        this.respondJson(res, status, record);
        return;
      }

      if (nftMintMatch) {
        const cache = await this.params.cacheWriter.read();
        if (!cache) {
          status = 503;
          this.respondJson(res, status, { error: 'Cache not initialized' });
          return;
        }
        const mint = decodeURIComponent(nftMintMatch[1]!);
        const record = cache.byMint[mint];
        if (!record) {
          status = 404;
          this.respondJson(res, status, { error: 'NFT not found' });
          return;
        }
        this.respondJson(res, status, record);
        return;
      }

      status = 404;
      this.respondJson(res, status, { error: 'Not found' });
    } catch (err) {
      status = 500;
      console.error('PublicBalanceServer error:', err);
      this.respondJson(res, status, { error: 'Internal server error' });
    } finally {
      const ms = Date.now() - start;
      console.log(`[public-api] ${method} ${urlPath} ${status} ${ms}ms`);
    }
  }

  private respondJson(res: ServerResponse, status: number, body: unknown): void {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = status;
    res.end(JSON.stringify(body));
  }
}
