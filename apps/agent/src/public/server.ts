import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import type { PublicCacheWriter } from './cache.js';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { LLMRouter } from '../llm/router.js';
import type { PersonaContextProvider } from '../persona/context-provider.js';
import { evaluateOffer, type OfferEvaluation } from '../llm/tasks.js';
import { CONFIG } from '../db/config-keys.js';
import { getUsdcAddress } from '../base/rpc.js';
import { processRedemptionRequest } from '../base/withdraw.js';

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

const BUY_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

function isValidEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export interface PublicBalanceServerParams {
  cacheWriter: PublicCacheWriter;
  db?: PanthersDb;
  adapter?: PanthersStateAdapter;
  llmRouter?: LLMRouter;
  personaCtx?: PersonaContextProvider;
  port?: number;
  devMode?: boolean;
  startedAt?: number;
  nftImagesDir?: string;
  storageBackend?: string;
  evmWalletAddress?: string;
}

const DEFAULT_PORT = 8080;

export class PublicBalanceServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly startedAt: number;
  private readonly devMode: boolean;
  private readonly nftImagesDir: string;
  private readonly storageBackend: string;
  private readonly evmWalletAddress: string;

  constructor(private readonly params: PublicBalanceServerParams) {
    this.port = params.port ?? DEFAULT_PORT;
    this.startedAt = params.startedAt ?? Date.now();
    this.devMode = params.devMode ?? false;
    this.nftImagesDir = params.nftImagesDir ?? '/data/nft-images';
    this.storageBackend = params.storageBackend ?? 'simple';
    this.evmWalletAddress = params.evmWalletAddress ?? '';
  }

  setLlmDependencies(llmRouter: LLMRouter, personaCtx: PersonaContextProvider): void {
    this.params.llmRouter = llmRouter;
    this.params.personaCtx = personaCtx;
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('X-Panthers-Agent', 'true');

    try {
      if (method === 'OPTIONS') {
        status = 204;
        res.statusCode = status;
        res.end();
        return;
      }

      if (method === 'POST') {
        await this.handlePost(urlPath, req, res);
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

      const portfolioMatch = urlPath.match(/^\/api\/portfolio\/([^/]+)$/);
      const activityMatch = urlPath.match(/^\/api\/activity\/([^/]+)$/);
      if (urlPath === '/api/provenance') {
        const result = this.handleProvenance();
        status = result.status;
        this.respondJson(res, status, result.body);
        return;
      }
      if (urlPath === '/api/attestation') {
        const result = this.handleAttestation();
        status = result.status;
        this.respondJson(res, status, result.body);
        return;
      }
      if (urlPath === '/api/secretvm-status') {
        const result = this.handleSecretVmStatus();
        status = result.status;
        this.respondJson(res, status, result.body);
        return;
      }
      if (urlPath === '/api/trading-log') {
        const result = await this.handleTradingLog();
        status = result.status;
        this.respondJson(res, status, result.body);
        return;
      }
      if (urlPath === '/api/trading-status') {
        const result = this.handleTradingStatus();
        status = result.status;
        this.respondJson(res, status, result.body);
        return;
      }
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
          evmWalletAddress: this.evmWalletAddress,
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

      if (portfolioMatch) {
        const result = await this.handlePortfolio(decodeURIComponent(portfolioMatch[1]!));
        status = result.status;
        this.respondJson(res, status, result.body);
        return;
      }

      if (activityMatch) {
        const result = await this.handleActivity(decodeURIComponent(activityMatch[1]!));
        status = result.status;
        this.respondJson(res, status, result.body);
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
          description: 'Panthers Fund — an autonomous AI trading fund on Base.',
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

  private async handlePortfolio(walletAddr: string): Promise<{ status: number; body: unknown }> {
    if (!isValidEvmAddress(walletAddr)) {
      return { status: 400, body: { error: 'invalid wallet address' } };
    }

    const db = this.params.db;
    const adapter = this.params.adapter;
    if (!db || !adapter) {
      return { status: 503, body: { error: 'Database not available' } };
    }

    const state = await db.loadState(adapter);
    const allNfts = Object.values(state.nfts);
    const owned = allNfts.filter(
      (nft) => nft.ownerWallet.toLowerCase() === walletAddr.toLowerCase(),
    );

    const nfts = owned.map((nft) => ({
      tokenId: nft.tokenId,
      name: `Panthers #${nft.nftIndex}`,
      acquiredAt: new Date(nft.mintedAt).toISOString(),
      navUsdc: nft.currentNav,
    }));

    const totalNavUsdc = nfts.reduce((sum, n) => sum + n.navUsdc, 0);

    return {
      status: 200,
      body: {
        walletAddress: walletAddr,
        nfts,
        totalNavUsdc,
        nftCount: nfts.length,
      },
    };
  }

  private async handlePost(urlPath: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (urlPath === '/api/buy') {
      const body = await this.readBody(req);
      const result = await this.handleBuy(body);
      this.respondJson(res, result.status, result.body);
      return;
    }
    if (urlPath === '/api/offer') {
      const body = await this.readBody(req);
      const result = await this.handleOffer(body);
      this.respondJson(res, result.status, result.body);
      return;
    }
    if (urlPath === '/api/redeem' || urlPath === '/api/withdraw') {
      const body = await this.readBody(req);
      const result = await this.handleWithdraw(body);
      this.respondJson(res, result.status, result.body);
      return;
    }
    if (urlPath === '/api/claim') {
      const body = await this.readBody(req);
      const result = await this.handleClaim(body);
      this.respondJson(res, result.status, result.body);
      return;
    }
    if (urlPath === '/api/add-funds') {
      const body = await this.readBody(req);
      const result = await this.handleAddFunds(body);
      this.respondJson(res, result.status, result.body);
      return;
    }
    this.respondJson(res, 404, { error: 'Not found' });
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  private async handleBuy(rawBody: string): Promise<{ status: number; body: unknown }> {
    const db = this.params.db;
    const adapter = this.params.adapter;
    if (!db || !adapter) {
      return { status: 503, body: { error: 'Database not available' } };
    }

    let parsed: { walletAddress?: string };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'Invalid JSON body' } };
    }

    const walletAddress = parsed.walletAddress;
    if (!walletAddress || typeof walletAddress !== 'string') {
      return { status: 400, body: { error: 'walletAddress is required' } };
    }

    if (!isValidEvmAddress(walletAddress)) {
      return { status: 400, body: { error: 'Invalid wallet address' } };
    }

    const state = await db.loadState(adapter);
    const now = Date.now();

    const existing = Object.values(state.pendingSales).find(
      (s) =>
        s.buyerWallet.toLowerCase() === walletAddress.toLowerCase() &&
        s.status === 'awaiting_payment' &&
        s.expiresAt > now,
    );
    if (existing) {
      return {
        status: 409,
        body: {
          error: 'pending_sale_exists',
          expiresAt: new Date(existing.expiresAt).toISOString(),
          agentWallet: this.evmWalletAddress,
          amountUsdc: existing.agreedPriceUsdc,
        },
      };
    }

    const priceStr = db.config.get(CONFIG.NFT_PRICE_USDC, {
      envKey: 'NFT_PRICE_USDC',
      defaultValue: '1.0',
    });
    const amountUsdc = Number(priceStr);

    const saleId = uuidv4();
    const expiresAt = now + BUY_EXPIRY_MS;

    const nextState = {
      ...state,
      pendingSales: {
        ...state.pendingSales,
        [saleId]: {
          saleId,
          buyerWallet: walletAddress,
          agreedPriceUsdc: amountUsdc,
          expiresAt,
          status: 'awaiting_payment' as const,
          createdAt: now,
        },
      },
    };
    await db.saveState(nextState, adapter, this.params.cacheWriter);

    const baseNetwork = (db.config.get(CONFIG.BASE_NETWORK, {
      defaultValue: 'base-sepolia',
    }) ?? 'base-sepolia') as 'base' | 'base-sepolia';
    const usdcAddr = getUsdcAddress(baseNetwork);

    console.log(
      `[Buy] Created pending sale ${saleId} for ${walletAddress.slice(0, 8)}... amount=${amountUsdc} USDC`,
    );

    return {
      status: 200,
      body: {
        saleId,
        agentWallet: this.evmWalletAddress,
        usdcAddress: usdcAddr,
        amountUsdc,
        expiresAt: new Date(expiresAt).toISOString(),
      },
    };
  }

  private async handleOffer(rawBody: string): Promise<{ status: number; body: unknown }> {
    const db = this.params.db;
    const adapter = this.params.adapter;
    if (!db || !adapter) {
      return { status: 503, body: { error: 'Database not available' } };
    }

    let parsed: { walletAddress?: string; offerAmountUsdc?: number };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'Invalid JSON body' } };
    }

    const walletAddress = parsed.walletAddress;
    if (!walletAddress || typeof walletAddress !== 'string') {
      return { status: 400, body: { error: 'walletAddress is required' } };
    }

    if (!isValidEvmAddress(walletAddress)) {
      return { status: 400, body: { error: 'Invalid wallet address' } };
    }

    const offerAmountUsdc = parsed.offerAmountUsdc;
    if (typeof offerAmountUsdc !== 'number' || offerAmountUsdc <= 0 || !isFinite(offerAmountUsdc)) {
      return { status: 400, body: { error: 'offerAmountUsdc must be a positive number' } };
    }

    const state = await db.loadState(adapter);
    const now = Date.now();

    const existing = Object.values(state.pendingSales).find(
      (s) =>
        s.buyerWallet.toLowerCase() === walletAddress.toLowerCase() &&
        s.status === 'awaiting_payment' &&
        s.expiresAt > now,
    );
    if (existing) {
      return {
        status: 409,
        body: {
          error: 'pending_sale_exists',
          expiresAt: new Date(existing.expiresAt).toISOString(),
          agentWallet: this.evmWalletAddress,
          amountUsdc: existing.agreedPriceUsdc,
        },
      };
    }

    const priceStr = db.config.get(CONFIG.NFT_PRICE_USDC, {
      envKey: 'NFT_PRICE_USDC',
      defaultValue: '1.0',
    });
    const askPriceUsdc = Number(priceStr);

    const cache = await this.params.cacheWriter.read();
    const tvl = cache?.fundSummary.totalPoolValueUsdc ?? 0;
    const totalMinted = cache?.fundSummary.totalNftCount ?? 0;

    let runwayDays = 999;
    if (this.params.personaCtx) {
      try {
        const ctx = await this.params.personaCtx.getSurvivalContext();
        runwayDays = ctx.estimatedRunwayDays;
      } catch {
        // Fall back to default runway
      }
    }

    let evaluation: OfferEvaluation;
    const llmRouter = this.params.llmRouter;
    if (llmRouter && this.params.personaCtx) {
      try {
        const survivalCtx = await this.params.personaCtx.getSurvivalContext();
        const llm = llmRouter.forWithPersona('offer', survivalCtx, this.params.personaCtx.agentWallet);
        evaluation = await evaluateOffer(llm, {
          offerAmountUsdc,
          askPriceUsdc,
          tvl,
          runwayDays,
          totalMinted,
        });
      } catch (err) {
        console.error('[Offer] LLM evaluation failed, defaulting to reject:', err);
        evaluation = {
          decision: 'reject',
          counterAmountUsdc: null,
          reason: 'Unable to evaluate offer at this time. Please try again.',
        };
      }
    } else {
      // No LLM available — use simple heuristic
      const pct = offerAmountUsdc / askPriceUsdc;
      if (pct >= 0.9) {
        evaluation = { decision: 'accept', counterAmountUsdc: null, reason: 'Offer meets the threshold.' };
      } else if (pct >= 0.7) {
        const counter = askPriceUsdc * 0.95;
        evaluation = { decision: 'counter', counterAmountUsdc: Math.round(counter * 100) / 100, reason: 'Offer is in range but below ask.' };
      } else {
        evaluation = { decision: 'reject', counterAmountUsdc: null, reason: 'Offer is too far below the asking price.' };
      }
    }

    console.log(
      `[Offer] wallet=${walletAddress.slice(0, 8)}... offer=${offerAmountUsdc} ask=${askPriceUsdc} decision=${evaluation.decision}`,
    );

    if (evaluation.decision === 'accept') {
      const saleId = uuidv4();
      const expiresAt = now + BUY_EXPIRY_MS;
      const nextState = {
        ...state,
        pendingSales: {
          ...state.pendingSales,
          [saleId]: {
            saleId,
            buyerWallet: walletAddress,
            agreedPriceUsdc: offerAmountUsdc,
            expiresAt,
            status: 'awaiting_payment' as const,
            createdAt: now,
          },
        },
      };
      await db.saveState(nextState, adapter, this.params.cacheWriter);

      const baseNetworkOffer = (db.config.get(CONFIG.BASE_NETWORK, {
        defaultValue: 'base-sepolia',
      }) ?? 'base-sepolia') as 'base' | 'base-sepolia';
      const usdcAddrOffer = getUsdcAddress(baseNetworkOffer);

      return {
        status: 200,
        body: {
          decision: 'accept',
          saleId,
          amountUsdc: offerAmountUsdc,
          agentWallet: this.evmWalletAddress,
          usdcAddress: usdcAddrOffer,
          expiresAt: new Date(expiresAt).toISOString(),
          reason: evaluation.reason,
        },
      };
    }

    if (evaluation.decision === 'counter') {
      return {
        status: 200,
        body: {
          decision: 'counter',
          counterAmountUsdc: evaluation.counterAmountUsdc,
          reason: evaluation.reason,
        },
      };
    }

    return {
      status: 200,
      body: {
        decision: 'reject',
        reason: evaluation.reason,
      },
    };
  }

  private async handleWithdraw(rawBody: string): Promise<{ status: number; body: unknown }> {
    const db = this.params.db;
    const adapter = this.params.adapter;
    if (!db || !adapter) {
      return { status: 503, body: { error: 'Database not available' } };
    }

    let parsed: { walletAddress?: string; tokenId?: string };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'Invalid JSON body' } };
    }

    const { walletAddress, tokenId } = parsed;
    if (!walletAddress || typeof walletAddress !== 'string') {
      return { status: 400, body: { error: 'walletAddress is required' } };
    }
    if (!isValidEvmAddress(walletAddress)) {
      return { status: 400, body: { error: 'Invalid wallet address' } };
    }
    if (!tokenId || typeof tokenId !== 'string') {
      return { status: 400, body: { error: 'tokenId is required' } };
    }

    const state = await db.loadState(adapter);
    const nft = state.nfts[tokenId];
    if (!nft) {
      return { status: 404, body: { error: 'NFT not found' } };
    }
    if (nft.ownerWallet.toLowerCase() !== walletAddress.toLowerCase()) {
      return { status: 403, body: { error: 'not_owner' } };
    }

    // Check for duplicate queued redemption
    const existingQueued = Object.values(state.redemptionQueue ?? {}).find(
      (r) => r.tokenId === tokenId && r.status === 'queued',
    );
    if (existingQueued) {
      return { status: 409, body: { error: 'Redemption already queued for this NFT', requestId: existingQueued.requestId } };
    }

    try {
      const request = await processRedemptionRequest({
        db,
        adapter,
        tokenId,
        ownerWallet: walletAddress,
        cacheWriter: this.params.cacheWriter,
      });

      return {
        status: 200,
        body: {
          requestId: request.requestId,
          status: request.status,
          netUsdc: request.netUsdc,
          swingFactor: request.swingFactor,
          feePct: request.feePct,
          effectiveNav: request.effectiveNav,
          queuedUntil: request.status === 'queued' ? new Date(request.expiresAt).toISOString() : undefined,
          message: request.status === 'fulfilled'
            ? 'Redemption processed immediately'
            : 'Queued — USDC will be sent within 72 hours',
        },
      };
    } catch (err: any) {
      if (err.message === 'not_owner') {
        return { status: 403, body: { error: 'not_owner' } };
      }
      if (err.message === 'duplicate_redemption') {
        return { status: 409, body: { error: 'Redemption already queued for this NFT' } };
      }
      console.error('[Withdraw] Error:', err);
      return { status: 500, body: { error: 'Internal server error' } };
    }
  }

  private async handleClaim(rawBody: string): Promise<{ status: number; body: unknown }> {
    const db = this.params.db;
    const adapter = this.params.adapter;
    if (!db || !adapter) {
      return { status: 503, body: { error: 'Database not available' } };
    }

    let parsed: { walletAddress?: string; tokenId?: string };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'Invalid JSON body' } };
    }

    const { walletAddress, tokenId } = parsed;
    if (!walletAddress || typeof walletAddress !== 'string') {
      return { status: 400, body: { error: 'walletAddress is required' } };
    }
    if (!isValidEvmAddress(walletAddress)) {
      return { status: 400, body: { error: 'Invalid wallet address' } };
    }
    if (!tokenId || typeof tokenId !== 'string') {
      return { status: 400, body: { error: 'tokenId is required' } };
    }

    const state = await db.loadState(adapter);
    const nft = state.nfts[tokenId];
    if (!nft) {
      return { status: 404, body: { error: 'NFT not found' } };
    }
    if (nft.ownerWallet.toLowerCase() !== walletAddress.toLowerCase()) {
      return { status: 403, body: { error: 'not_owner' } };
    }

    const updatedNft = {
      ...nft,
      custodyMode: 'self' as const,
      claimedAt: Date.now(),
    };

    const nextState = {
      ...state,
      nfts: { ...state.nfts, [tokenId]: updatedNft },
    };
    await db.saveState(nextState, adapter, this.params.cacheWriter);

    console.log(
      `[Claim] wallet=${walletAddress.slice(0, 8)}... tokenId=${tokenId} → self-custody`,
    );

    return {
      status: 200,
      body: {
        tokenId,
        custodyMode: 'self',
        claimedAt: updatedNft.claimedAt,
      },
    };
  }

  private async handleAddFunds(rawBody: string): Promise<{ status: number; body: unknown }> {
    const db = this.params.db;
    const adapter = this.params.adapter;
    if (!db || !adapter) {
      return { status: 503, body: { error: 'Database not available' } };
    }

    let parsed: { walletAddress?: string; tokenId?: string; amountUsdc?: number };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: 'Invalid JSON body' } };
    }

    const { walletAddress, tokenId, amountUsdc } = parsed;
    if (!walletAddress || typeof walletAddress !== 'string') {
      return { status: 400, body: { error: 'walletAddress is required' } };
    }
    if (!tokenId || typeof tokenId !== 'string') {
      return { status: 400, body: { error: 'tokenId is required' } };
    }
    if (typeof amountUsdc !== 'number' || amountUsdc <= 0 || !isFinite(amountUsdc)) {
      return { status: 400, body: { error: 'amountUsdc must be a positive number' } };
    }

    if (!isValidEvmAddress(walletAddress)) {
      return { status: 400, body: { error: 'Invalid wallet address' } };
    }

    const state = await db.loadState(adapter);
    const nft = state.nfts[tokenId];
    if (!nft) {
      return { status: 404, body: { error: 'NFT not found' } };
    }
    if (nft.ownerWallet.toLowerCase() !== walletAddress.toLowerCase()) {
      return { status: 403, body: { error: 'You do not own this NFT' } };
    }

    const now = Date.now();
    const existing = Object.values(state.pendingSales).find(
      (s) =>
        s.buyerWallet.toLowerCase() === walletAddress.toLowerCase() &&
        s.status === 'awaiting_payment' &&
        s.expiresAt > now,
    );
    if (existing) {
      return {
        status: 409,
        body: {
          error: 'pending_sale_exists',
          expiresAt: new Date(existing.expiresAt).toISOString(),
          agentWallet: this.evmWalletAddress,
          amountUsdc: existing.agreedPriceUsdc,
        },
      };
    }

    const saleId = uuidv4();
    const expiresAt = now + BUY_EXPIRY_MS;

    const nextState = {
      ...state,
      pendingSales: {
        ...state.pendingSales,
        [saleId]: {
          saleId,
          buyerWallet: walletAddress,
          agreedPriceUsdc: amountUsdc,
          expiresAt,
          status: 'awaiting_payment' as const,
          createdAt: now,
          type: 'add_funds' as const,
          targetTokenId: tokenId,
        },
      },
    };
    await db.saveState(nextState, adapter, this.params.cacheWriter);

    const baseNetworkAf = (db.config.get(CONFIG.BASE_NETWORK, {
      defaultValue: 'base-sepolia',
    }) ?? 'base-sepolia') as 'base' | 'base-sepolia';
    const usdcAddrAf = getUsdcAddress(baseNetworkAf);

    console.log(
      `[AddFunds] Created pending add-funds ${saleId} for ${walletAddress.slice(0, 8)}... tokenId=${tokenId} amount=${amountUsdc} USDC`,
    );

    return {
      status: 200,
      body: {
        saleId,
        agentWallet: this.evmWalletAddress,
        usdcAddress: usdcAddrAf,
        amountUsdc,
        expiresAt: new Date(expiresAt).toISOString(),
      },
    };
  }

  private handleProvenance(): { status: number; body: unknown } {
    const db = this.params.db;
    if (!db) return { status: 503, body: { error: 'Database not available' } };
    const raw = db.config.get(CONFIG.PROVENANCE_RESULT);
    if (!raw) return { status: 200, body: { provenance: null } };
    try {
      return { status: 200, body: { provenance: JSON.parse(raw) } };
    } catch {
      return { status: 200, body: { provenance: null } };
    }
  }

  private handleAttestation(): { status: number; body: unknown } {
    const db = this.params.db;
    if (!db) return { status: 503, body: { error: 'Database not available' } };
    const raw = db.config.get(CONFIG.ATTESTATION_RESULT);
    if (!raw) return { status: 200, body: { attestation: null } };
    try {
      return { status: 200, body: { attestation: JSON.parse(raw) } };
    } catch {
      return { status: 200, body: { attestation: null } };
    }
  }

  private handleSecretVmStatus(): { status: number; body: unknown } {
    const db = this.params.db;
    if (!db) return { status: 503, body: { error: 'Database not available' } };
    const balance = db.config.get(CONFIG.SECRETVM_BALANCE);
    const vmId = db.config.get(CONFIG.SECRETVM_VM_ID);
    const balanceMinor = balance ? Number(balance) : null;
    return {
      status: 200,
      body: {
        balance: balanceMinor,
        balanceUsdc: balanceMinor !== null ? balanceMinor / 1_000_000 : null,
        vmId: vmId ?? null,
      },
    };
  }

  private handleTradingStatus(): { status: number; body: unknown } {
    const db = this.params.db;
    if (!db) return { status: 503, body: { error: 'Database not available' } };

    const tradesToday = Number(db.config.get(CONFIG.TRADES_TODAY) ?? '0');
    const tradesTodayDate = db.config.get(CONFIG.TRADES_TODAY_DATE) ?? null;
    const lastTradeAt = Number(db.config.get(CONFIG.LAST_TRADE_AT) ?? '0');
    const lastRebalanceAt = Number(db.config.get(CONFIG.LAST_REBALANCE_AT) ?? '0');

    return {
      status: 200,
      body: {
        tradesToday,
        tradesTodayDate,
        lastTradeAt: lastTradeAt > 0 ? new Date(lastTradeAt).toISOString() : null,
        lastRebalanceAt: lastRebalanceAt > 0 ? new Date(lastRebalanceAt).toISOString() : null,
        maxTradesPerDay: 3,
      },
    };
  }

  private async handleTradingLog(): Promise<{ status: number; body: unknown }> {
    const db = this.params.db;
    const adapter = this.params.adapter;
    if (!db || !adapter) {
      return { status: 503, body: { error: 'Database not available' } };
    }
    const state = await db.loadState(adapter);
    const log = (state.tradingDecisionLog ?? []).slice().reverse();
    return { status: 200, body: { decisions: log } };
  }

  private async handleActivity(walletAddr: string): Promise<{ status: number; body: unknown }> {
    const db = this.params.db;
    const adapter = this.params.adapter;
    if (!db || !adapter) {
      return { status: 503, body: { error: 'Database not available' } };
    }

    const state = await db.loadState(adapter);
    const log = state.activityLog ?? [];
    const entries = log
      .filter((e) => e.wallet.toLowerCase() === walletAddr.toLowerCase())
      .reverse();

    return { status: 200, body: { activity: entries } };
  }

  private respondJson(res: ServerResponse, status: number, body: unknown): void {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = status;
    res.end(JSON.stringify(body));
  }
}
