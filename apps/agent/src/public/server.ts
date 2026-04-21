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

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">
  <rect width="500" height="500" fill="#0A0A0A"/>
  <rect x="10" y="10" width="480" height="480" fill="none" stroke="#E8780E" stroke-width="2"/>
  <ellipse cx="250" cy="200" rx="80" ry="90" fill="#1A1A1A" stroke="#E8780E" stroke-width="1.5"/>
  <ellipse cx="250" cy="340" rx="60" ry="80" fill="#1A1A1A" stroke="#E8780E" stroke-width="1.5"/>
  <polygon points="195,140 175,100 215,130" fill="#1A1A1A" stroke="#E8780E" stroke-width="1.5"/>
  <polygon points="305,140 325,100 285,130" fill="#1A1A1A" stroke="#E8780E" stroke-width="1.5"/>
  <ellipse cx="225" cy="195" rx="10" ry="8" fill="#E8780E"/>
  <ellipse cx="275" cy="195" rx="10" ry="8" fill="#E8780E"/>
  <text x="250" y="440" font-family="monospace" font-size="14" fill="#555555" text-anchor="middle">PANTHERS FUND</text>
  <text x="250" y="460" font-family="monospace" font-size="11" fill="#333333" text-anchor="middle">AUTONOMOUS AI TRADING</text>
</svg>`;

export interface PublicBalanceServerParams {
  cacheWriter: PublicCacheWriter;
  port?: number;
  devMode?: boolean;
  startedAt?: number;
  nftImagesDir?: string;
  storageBackend?: string;
  solanaWalletAddress?: string;
}

const DEFAULT_PORT = 3000;

export class PublicBalanceServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly startedAt: number;
  private readonly devMode: boolean;
  private readonly nftImagesDir: string;
  private readonly storageBackend: string;
  private readonly solanaWalletAddress: string;

  constructor(private readonly params: PublicBalanceServerParams) {
    this.port = params.port ?? DEFAULT_PORT;
    this.startedAt = params.startedAt ?? Date.now();
    this.devMode = params.devMode ?? false;
    this.nftImagesDir = params.nftImagesDir ?? '/data/nft-images';
    this.storageBackend = params.storageBackend ?? 'simple';
    this.solanaWalletAddress = params.solanaWalletAddress ?? '';
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
          storageBackend: this.storageBackend,
          solanaWalletAddress: this.solanaWalletAddress,
          personalFund: cache?.stats?.personalFund ?? null,
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
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.statusCode = 200;
        res.end(PLACEHOLDER_SVG);
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
