import { Connection } from '@solana/web3.js';
import { mkdirSync } from 'node:fs';
import { PanthersDb } from './db/panthers-db.js';
import type { StorageBackend } from './db/storage-backend.js';
import { CONFIG } from './db/config-keys.js';
import { PanthersStateAdapter } from './state/adapter.js';
import { initializeSolanaWallet } from './solana/wallet.js';
import { initializeUmi } from './solana/umi-client.js';
import { UsdcMonitor, type InboundTransfer } from './solana/monitor.js';
import { NftMonitor } from './solana/nft-monitor.js';
import { completeSale } from './solana/deposit.js';
import { LLMRouter } from './llm/router.js';
import { BirdeyeClient } from './trading/birdeye.js';
import { JupiterClient } from './trading/jupiter.js';
import { TradingLoop } from './trading/loop.js';
import { PublicCacheWriter } from './public/cache.js';
import { PublicBalanceServer } from './public/server.js';
import { AuctionTicker } from './auction/ticker.js';
import { AuctionScheduler } from './auction/scheduler.js';
import { executeP2pSale } from './auction/p2p.js';
import { MarketContext } from './trading/market-context.js';
import { deriveWsUrl, isHeliusUrl } from './solana/rpc.js';
import { PersonaEngine } from './persona/engine.js';
import { WalletMonitor } from './persona/wallet-monitor.js';
import { PersonaContextProvider } from './persona/context-provider.js';
import { burnPanthersNft } from './solana/nft.js';
import { recalculateAllNavs } from './state/nav.js';
import type { PanthersState } from './state/schema.js';
import { XClient } from './social/x-client.js';
import { XPostingLoop } from './social/x-posting-loop.js';

const STALE_SALE_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) throw new Error('DB_PATH environment variable is required');

  const devMode = process.env.DEV_MODE === 'true';
  const storageBackend = process.env.STORAGE_BACKEND ?? 'simple';

  let backend: StorageBackend;
  if (storageBackend === 'idiostasis') {
    const vaultKeyHex = process.env.VAULT_KEY_HEX;
    if (!vaultKeyHex) {
      throw new Error('VAULT_KEY_HEX required when STORAGE_BACKEND=idiostasis');
    }
    const vaultKey = new Uint8Array(Buffer.from(vaultKeyHex, 'hex'));
    const { IdiostasisStorageBackend } = await import('./db/idiostasis-backend.js');
    backend = new IdiostasisStorageBackend(dbPath, vaultKey);
    console.log('Storage backend: Idiostasis (ProtocolDatabase)');
  } else {
    const { SimpleStorageBackend } = await import('./db/simple-backend.js');
    backend = new SimpleStorageBackend(dbPath);
    console.log('Storage backend: Simple (local SQLite)');
  }

  const db = new PanthersDb(backend);
  const adapter = new PanthersStateAdapter();

  const solanaRpcUrl = db.config.get(CONFIG.SOLANA_RPC_URL, {
    envKey: 'SOLANA_RPC_URL',
    required: true,
  })!;

  const publicCachePath = db.config.get(CONFIG.PUBLIC_CACHE_PATH, {
    envKey: 'PUBLIC_CACHE_PATH',
    defaultValue: '/data/public-cache.json',
  })!;

  const publicPort = Number(db.config.get(CONFIG.PUBLIC_PORT, {
    envKey: 'PUBLIC_PORT',
    defaultValue: '3000',
  }));

  const usdcMint = db.config.get(CONFIG.USDC_MINT, {
    envKey: 'USDC_MINT',
    defaultValue: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  })!;

  const firstBootAt = Number(db.config.get(CONFIG.FIRST_BOOT_AT, {
    defaultValue: String(Date.now()),
  }));

  const cacheWriter = new PublicCacheWriter(publicCachePath);
  const state = await db.loadState(adapter);
  await cacheWriter.write(state).catch((err) =>
    console.error('Initial cache write failed:', err),
  );
  const keypair = initializeSolanaWallet(db);
  const umi = initializeUmi(keypair, solanaRpcUrl);
  const connection = new Connection(solanaRpcUrl, 'confirmed');

  console.log(`Solana public key: ${keypair.publicKey.toBase58()}`);
  console.log(
    `Pool totalUsdcDeposited: ${state.pool.totalUsdcDeposited}, totalUsdcCurrentValue: ${state.pool.totalUsdcCurrentValue}`,
  );
  console.log(`NFT count: ${Object.keys(state.nfts).length}`);

  const nftImagesDir = '/data/nft-images';
  try { mkdirSync(nftImagesDir, { recursive: true }); } catch {}

  // Run expired sale cleanup at startup
  {
    const bootState = await db.loadState(adapter);
    const cleaned = db.expireStalePendingSales(bootState);
    if (cleaned !== bootState) {
      const expired = Object.values(cleaned.pendingSales).filter(
        (s) => s.status === 'expired' && bootState.pendingSales[s.saleId]?.status === 'awaiting_payment',
      );
      for (const s of expired) {
        console.log(`[Boot] Expired pending sale ${s.saleId} for wallet ${s.buyerWallet.slice(0, 8)}...`);
      }
      await db.saveState(cleaned, adapter, cacheWriter);
      console.log(`[Boot] Cleaned up ${expired.length} expired pending sale(s)`);
    }
  }

  const publicServer = new PublicBalanceServer({
    cacheWriter,
    connection,
    db,
    adapter,
    port: publicPort,
    devMode,
    startedAt: Date.now(),
    nftImagesDir,
    storageBackend,
    solanaWalletAddress: keypair.publicKey.toBase58(),
  });
  publicServer.start();

  // ERC-8004 registration
  try {
    const agentHost = process.env.AGENT_HOST;
    if (!agentHost) {
      console.log('[registry] AGENT_HOST not set — skipping ERC-8004 registration');
    } else {
      const evmMnemonic = process.env.EVM_MNEMONIC;
      if (!evmMnemonic) {
        console.log('[registry] EVM_MNEMONIC not set — skipping ERC-8004 registration');
      } else {
        const { mnemonicToAccount } = await import('viem/accounts');
        const { createErc8004Client } = await import('./registry/erc8004.js');
        const baseRpcUrl = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org';
        const port = process.env.PORT ?? '3000';
        const account = mnemonicToAccount(evmMnemonic);
        const registry = createErc8004Client({ account, rpcUrl: baseRpcUrl });
        const existingTokenId = db.config.get(CONFIG.ERC8004_TOKEN_ID);
        if (!existingTokenId) {
          const tokenId = await registry.register({
            name: 'Panthers Fund',
            description: 'Autonomous AI NFT fund on Solana',
            services: [{ name: 'dashboard', endpoint: `http://${agentHost}:${port}` }],
          });
          db.config.set(CONFIG.ERC8004_TOKEN_ID, tokenId.toString());
          console.log(`[registry] registered, token ID: ${tokenId}`);
        } else {
          const tokenId = BigInt(existingTokenId);
          await registry.updateEndpoint(tokenId, 'dashboard', `http://${agentHost}:${port}`);
          console.log(`[registry] endpoint updated, token ID: ${existingTokenId}`);
        }
      }
    }
  } catch (err) {
    console.error('[registry] ERC-8004 registration failed (non-fatal):', err);
  }

  if (devMode) {
    console.log('DEV_MODE=true — storage-only boot');
    console.log('Panthers agent initialized (storage-only mode)');
    return;
  }

  const secretAiKey = db.config.get(CONFIG.SECRET_AI_API_KEY, {
    envKey: 'SECRET_AI_API_KEY',
    required: true,
  })!;

  const secretAiBaseUrl = db.config.get(CONFIG.SECRET_AI_BASE_URL, {
    envKey: 'SECRET_AI_BASE_URL',
    defaultValue: 'https://secretai-rytn.scrtlabs.com:21434',
  })!;

  const coingeckoApiKey = db.config.get(CONFIG.COINGECKO_API_KEY, {
    envKey: 'COINGECKO_API_KEY',
  });

  const agentPublicUrl = db.config.get(CONFIG.AGENT_PUBLIC_URL, {
    envKey: 'AGENT_PUBLIC_URL',
  }) || '';
  if (!agentPublicUrl) {
    console.warn('[Boot] AGENT_PUBLIC_URL not set — NFT metadata URIs will be empty');
  }

  const dailyBurnRate = Number(db.config.get(CONFIG.DAILY_BURN_RATE_USDC, {
    envKey: 'DAILY_BURN_RATE_USDC',
    defaultValue: '2.0',
  }));

  const llmRouter = new LLMRouter(secretAiKey, secretAiBaseUrl, db.config);
  const personaEngine = new PersonaEngine();
  llmRouter.setPersona(personaEngine);
  console.log(`[Boot] Config loaded. SecretAI base: ${secretAiBaseUrl}`);

  const walletMonitor = new WalletMonitor({
    connection,
    agentWallet: keypair.publicKey.toBase58(),
    usdcMintSolana: usdcMint,
  });
  await walletMonitor.start();

  const personaCtx = new PersonaContextProvider({
    db,
    adapter,
    walletMonitor,
    dailyBurnRate: dailyBurnRate,
    firstBootAt,
    agentWallet: keypair.publicKey.toBase58(),
  });

  publicServer.setLlmDependencies(llmRouter, personaCtx);

  if (isHeliusUrl(solanaRpcUrl)) {
    const wsUrl = deriveWsUrl(solanaRpcUrl);
    const monitor = new UsdcMonitor({
      wsUrl,
      rpcUrl: solanaRpcUrl,
      agentWallet: keypair.publicKey.toBase58(),
      usdcMint,
      onInboundTransfer: async (transfer: InboundTransfer) => {
        const currentState = await db.loadState(adapter);
        const memo = transfer.memo;
        const memoMatch =
          memo !== null ? currentState.pendingSales[memo] : undefined;
        const walletMatch = memoMatch ?? Object.values(currentState.pendingSales).find(
          (s) =>
            s.status === 'awaiting_payment' &&
            s.buyerWallet.toLowerCase() === transfer.senderWallet.toLowerCase() &&
            Date.now() < s.expiresAt,
        );
        const match = walletMatch;
        if (!match) {
          const alreadyPaid = Object.values(currentState.pendingSales).some(
            (s) =>
              s.status === 'paid' &&
              s.buyerWallet.toLowerCase() === transfer.senderWallet.toLowerCase(),
          );
          if (alreadyPaid) {
            console.log(
              `Already-processed transfer from ${transfer.senderWallet.slice(0, 8)}..., skipping`,
            );
            return;
          }
          const amount = transfer.amountUsdc;
          console.log(
            `Donation: ${transfer.txSignature} amount=${amount} from=${transfer.senderWallet.slice(0, 8)}...`,
          );
          const pf = currentState.personalFund ?? {
            totalFeesCollectedUsdc: 0,
            totalDonationsUsdc: 0,
            totalInfraSpendSolanaUsdc: 0,
            totalInfraSpendBaseUsdc: 0,
            lastUpdatedAt: 0,
          };
          const updated: PanthersState = {
            ...currentState,
            personalFund: {
              ...pf,
              totalDonationsUsdc: pf.totalDonationsUsdc + amount,
              lastUpdatedAt: Date.now(),
            },
          };
          await db.saveState(updated, adapter, cacheWriter);
          void xPostingLoop?.onEvent('donation_received', `${amount.toFixed(2)} USDC received`);
          return;
        }
        if (match.status !== 'awaiting_payment') {
          console.log(
            `Transfer for non-awaiting sale ${match.saleId} (status=${match.status}); ignoring`,
          );
          return;
        }
        if (Date.now() > match.expiresAt) {
          console.log(`Sale ${match.saleId} expired; ignoring transfer`);
          return;
        }

        if (match.listingId) {
          const listing = currentState.p2pListings[match.listingId];
          if (!listing) {
            console.log(`P2P listing not found: ${match.listingId}`);
            return;
          }
          try {
            const result = await executeP2pSale({
              db,
              adapter,
              umi,
              connection,
              agentKeypair: keypair,
              cacheWriter,
              listingId: match.listingId,
              buyerWallet: match.buyerWallet,
              agreedPriceUsdc: transfer.amountUsdc,
              txSignature: transfer.txSignature,
              agentPublicUrl,
              usdcMint,
            });
            console.log(`P2P sale complete: newTokenId=${result.newTokenId}`);
          } catch (err) {
            console.error(`Failed P2P sale ${match.saleId}:`, err);
          }
          return;
        }

        try {
          const result = await completeSale({
            db,
            adapter,
            umi,
            rpcUrl: solanaRpcUrl,
            saleId: match.saleId,
            confirmedAmountUsdc: transfer.amountUsdc,
            txSignature: transfer.txSignature,
            cacheWriter,
            agentPublicUrl,
          });
          const updatedState = await db.loadState(adapter);
          const nft = updatedState.nfts[result.tokenId];
          console.log(
            `Sale completed: tokenId=${result.tokenId} mintAddress=${result.mintAddress} nftIndex=${nft?.nftIndex ?? '?'}`,
          );
        } catch (err) {
          console.error(`Failed to complete sale ${match.saleId}:`, err);
        }
      },
    });
    monitor.start();
    console.log(`[Boot] USDC monitor started (ws: ${wsUrl.split('?')[0]}...)`);
  } else {
    console.log('[Boot] USDC monitor skipped — non-Helius RPC URL');
  }

  const nftMonitor = new NftMonitor({
    rpcUrl: solanaRpcUrl,
    agentWallet: keypair.publicKey.toBase58(),
    onInboundNft: async ({ mintAddress, fromWallet, txSignature }) => {
      const currentState = await db.loadState(adapter);
      const nft = Object.values(currentState.nfts).find(
        (n) => n.mintAddress === mintAddress,
      );
      if (!nft || nft.custodyMode !== 'self') {
        console.log(`[NftMonitor] Unmatched NFT inbound: ${mintAddress}`);
        return;
      }
      const feePct = currentState.agentConfig.feePctOnBurn;
      const feesUsdc = nft.currentNav * feePct;
      const withdrawnUsdc = nft.currentNav - feesUsdc;

      try {
        await burnPanthersNft({
          umi,
          mintAddress: nft.mintAddress,
          ownerWallet: keypair.publicKey.toBase58(),
        });
      } catch (err) {
        console.error(`[NftMonitor] Burn failed for ${mintAddress}:`, err);
        return;
      }

      const { [nft.tokenId]: _removed, ...remainingNfts } = currentState.nfts;
      void _removed;

      let nextState: PanthersState = {
        ...currentState,
        nfts: remainingNfts,
        pool: {
          ...currentState.pool,
          totalUsdcDeposited: currentState.pool.totalUsdcDeposited - nft.usdcDeposited,
          totalUsdcCurrentValue: currentState.pool.totalUsdcCurrentValue - nft.currentNav,
        },
        personalFund: {
          ...(currentState.personalFund ?? { totalFeesCollectedUsdc: 0, totalDonationsUsdc: 0, totalInfraSpendSolanaUsdc: 0, totalInfraSpendBaseUsdc: 0, lastUpdatedAt: 0 }),
          totalFeesCollectedUsdc: (currentState.personalFund?.totalFeesCollectedUsdc ?? 0) + feesUsdc,
          lastUpdatedAt: Date.now(),
        },
      };
      nextState = recalculateAllNavs(nextState);
      await db.saveState(nextState, adapter, cacheWriter);

      console.log(
        `[NftMonitor] Redemption: burned ${mintAddress}, sending ${withdrawnUsdc.toFixed(2)} USDC to ${fromWallet}`,
      );

      try {
        const { processWithdrawal: _ } = await import('./solana/withdraw.js');
        void _;
        const { PublicKey: PK } = await import('@solana/web3.js');
        const {
          createTransferInstruction: cti,
          getAssociatedTokenAddress: gata,
          getOrCreateAssociatedTokenAccount: gocata,
        } = await import('@solana/spl-token');
        const { Transaction: Tx, sendAndConfirmTransaction: sact } =
          await import('@solana/web3.js');

        const usdcPk = new PK(usdcMint);
        const sourceAta = await gata(usdcPk, keypair.publicKey);
        const destAta = await gocata(connection, keypair, usdcPk, new PK(fromWallet));
        const atomicAmount = BigInt(Math.floor(withdrawnUsdc * 1_000_000));
        const tx = new Tx().add(
          cti(sourceAta, destAta.address, keypair.publicKey, atomicAmount),
        );
        await sact(connection, tx, [keypair]);
        console.log(`[NftMonitor] Sent ${withdrawnUsdc.toFixed(2)} USDC to ${fromWallet}`);
      } catch (err) {
        console.error(`[NftMonitor] USDC transfer failed:`, err);
      }
    },
  });
  for (const nft of Object.values(state.nfts)) {
    if (nft.custodyMode === 'agent') nftMonitor.seedKnownMint(nft.mintAddress);
  }
  nftMonitor.start();

  const onBirdeyeSpend = async (amountUsdc: number) => {
    try {
      const s = await db.loadState(adapter);
      const spf = s.personalFund ?? { totalFeesCollectedUsdc: 0, totalDonationsUsdc: 0, totalInfraSpendSolanaUsdc: 0, totalInfraSpendBaseUsdc: 0, lastUpdatedAt: 0 };
      const updated: PanthersState = {
        ...s,
        personalFund: {
          ...spf,
          totalInfraSpendSolanaUsdc: spf.totalInfraSpendSolanaUsdc + amountUsdc,
          lastUpdatedAt: Date.now(),
        },
      };
      await db.saveState(updated, adapter, cacheWriter);
    } catch {}
  };

  const birdeye = new BirdeyeClient({
    keypair,
    connection,
    onSpend: (amount) => void onBirdeyeSpend(amount),
  });
  const jupiter = new JupiterClient(connection, keypair);
  const xApiKey = db.config.get(CONFIG.X_API_KEY, { envKey: 'X_API_KEY' });
  const xApiSecret = db.config.get(CONFIG.X_API_SECRET, { envKey: 'X_API_SECRET' });
  const xAccessToken = db.config.get(CONFIG.X_ACCESS_TOKEN, { envKey: 'X_ACCESS_TOKEN' });
  const xAccessTokenSecret = db.config.get(CONFIG.X_ACCESS_TOKEN_SECRET, { envKey: 'X_ACCESS_TOKEN_SECRET' });

  let xPostingLoop: XPostingLoop | null = null;
  if (xApiKey && xApiSecret && xAccessToken && xAccessTokenSecret) {
    const xClient = new XClient({
      apiKey: xApiKey,
      apiSecret: xApiSecret,
      accessToken: xAccessToken,
      accessTokenSecret: xAccessTokenSecret,
    });
    xPostingLoop = new XPostingLoop({
      xClient,
      llmRouter,
      personaCtx,
    });
    setInterval(() => void xPostingLoop!.checkDailySurvival(), 6 * 60 * 60 * 1000);
    console.log('[Boot] X posting loop initialized');
  } else {
    console.log('[Boot] X posting skipped — credentials not configured');
  }

  const tradingLoop = new TradingLoop({
    db,
    adapter,
    birdeye,
    jupiter,
    llmRouter,
    connection,
    cacheWriter,
    personaCtx,
    onTradeExecuted: (context) => void xPostingLoop?.onEvent('trade_executed', context),
  });
  tradingLoop.start();
  console.log('Trading loop started');

  const ticker = new AuctionTicker({ db, adapter, cacheWriter });
  ticker.start();
  const scheduler = new AuctionScheduler({ db, adapter, llmRouter, cacheWriter, personaCtx });
  scheduler.start();
  console.log('Auction ticker + scheduler started');

  if (coingeckoApiKey) {
    const market = new MarketContext({ coingeckoApiKey });
    await market.start();
  } else {
    console.log('MarketContext skipped — missing COINGECKO_API_KEY');
  }

  setInterval(async () => {
    try {
      const current = await db.loadState(adapter);
      const next = db.expireStalePendingSales(current);
      if (next !== current) {
        const expired = Object.values(next.pendingSales).filter(
          (s) => s.status === 'expired' && current.pendingSales[s.saleId]?.status === 'awaiting_payment',
        );
        for (const s of expired) {
          console.log(`[Cleanup] Expired pending sale ${s.saleId} for wallet ${s.buyerWallet.slice(0, 8)}...`);
        }
        await db.saveState(next, adapter, cacheWriter);
      }
    } catch (err) {
      console.error('expireStalePendingSales failed:', err);
    }
  }, STALE_SALE_INTERVAL_MS);

  console.log('Panthers agent initialized');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
