import { Connection } from '@solana/web3.js';
import { PanthersDb } from './db/panthers-db.js';
import type { StorageBackend } from './db/storage-backend.js';
import { PanthersStateAdapter } from './state/adapter.js';
import { initializeSolanaWallet } from './solana/wallet.js';
import { initializeUmi } from './solana/umi-client.js';
import { UsdcMonitor, type InboundTransfer } from './solana/monitor.js';
import { completeSale } from './solana/deposit.js';
import { createLLMClient } from './llm/client.js';
import { PanthersBot } from './telegram/bot.js';
import { BirdeyeClient } from './trading/birdeye.js';
import { JupiterClient } from './trading/jupiter.js';
import { TradingLoop } from './trading/loop.js';
import { PublicCacheWriter } from './public/cache.js';
import { PublicBalanceServer } from './public/server.js';
import { AuctionTicker } from './auction/ticker.js';
import { AuctionScheduler } from './auction/scheduler.js';
import { executeP2pSale } from './auction/p2p.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const STALE_SALE_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) throw new Error('DB_PATH environment variable is required');

  const solanaRpcUrl = process.env.SOLANA_RPC_URL;
  if (!solanaRpcUrl) throw new Error('SOLANA_RPC_URL environment variable is required');

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

  const publicCachePath = process.env.PUBLIC_CACHE_PATH ?? '/data/public-cache.json';
  const publicPort = Number(process.env.PUBLIC_PORT ?? '3000');

  const db = new PanthersDb(backend);
  const adapter = new PanthersStateAdapter();
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

  const publicServer = new PublicBalanceServer({
    cacheWriter,
    port: publicPort,
    devMode,
    startedAt: Date.now(),
  });
  publicServer.start();

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramGroupChatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  const heliusApiKey = process.env.HELIUS_API_KEY;
  const secretAiKey = process.env.SECRET_AI_API_KEY;
  const birdeyeApiKey = process.env.BIRDEYE_API_KEY;

  const fullStackEnabled =
    !devMode &&
    telegramToken !== undefined &&
    telegramGroupChatId !== undefined &&
    heliusApiKey !== undefined &&
    secretAiKey !== undefined &&
    birdeyeApiKey !== undefined;

  if (!fullStackEnabled) {
    console.log(
      devMode
        ? 'DEV_MODE=true — skipping Telegram/Helius/Birdeye subsystems'
        : 'Missing one or more runtime keys — running storage-only boot',
    );
    console.log('Panthers agent Phase 5b initialized (storage-only mode)');
    return;
  }

  const llm = createLLMClient(secretAiKey!);

  const bot = new PanthersBot({
    token: telegramToken!,
    groupChatId: telegramGroupChatId!,
    llm,
    db,
    adapter,
    umi,
    connection,
    agentKeypair: keypair,
    cacheWriter,
  });
  bot.start();

  const monitor = new UsdcMonitor({
    heliusApiKey: heliusApiKey!,
    agentWallet: keypair.publicKey.toBase58(),
    usdcMint: USDC_MINT,
    onInboundTransfer: async (transfer: InboundTransfer) => {
      const currentState = await db.loadState(adapter);
      const memo = transfer.memo;
      const match =
        memo !== null ? currentState.pendingSales[memo] : undefined;
      if (!match) {
        console.log(
          `Unmatched USDC transfer: ${transfer.txSignature} amount=${transfer.amountUsdc} memo=${memo ?? 'none'}`,
        );
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
            buyerTelegramId: match.telegramUserId,
            buyerWallet: match.buyerWallet,
            agreedPriceUsdc: transfer.amountUsdc,
            txSignature: transfer.txSignature,
          });
          const updatedState = await db.loadState(adapter);
          const nft = updatedState.nfts[result.newTokenId];
          await bot.sendGroupMessage(
            `Panthers Fund #${nft?.nftIndex ?? '?'} sold P2P. 🤝`,
          );
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
        });
        const updatedState = await db.loadState(adapter);
        const nft = updatedState.nfts[result.tokenId];
        await bot.sendGroupMessage(
          `Panthers Fund #${nft?.nftIndex ?? '?'} minted to new owner. 🐆`,
        );
        console.log(
          `Sale completed: tokenId=${result.tokenId} mintAddress=${result.mintAddress}`,
        );
      } catch (err) {
        console.error(`Failed to complete sale ${match.saleId}:`, err);
      }
    },
  });
  monitor.start();

  const birdeye = new BirdeyeClient(birdeyeApiKey!);
  const jupiter = new JupiterClient(connection, keypair);
  const tradingLoop = new TradingLoop({
    db,
    adapter,
    birdeye,
    jupiter,
    llm,
    connection,
    cacheWriter,
  });
  tradingLoop.start();

  const ticker = new AuctionTicker({ db, adapter, bot, cacheWriter });
  const scheduler = new AuctionScheduler({ db, adapter, llm, bot, cacheWriter });
  ticker.start();
  scheduler.start();

  setInterval(async () => {
    try {
      const current = await db.loadState(adapter);
      const next = db.expireStalePendingSales(current);
      if (next !== current) {
        await db.saveState(next, adapter, cacheWriter);
        console.log('Expired stale pending sales');
      }
    } catch (err) {
      console.error('expireStalePendingSales failed:', err);
    }
  }, STALE_SALE_INTERVAL_MS);

  console.log('Panthers agent Phase 5b initialized — auction engine active');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
