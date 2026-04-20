import type { Connection, Keypair } from '@solana/web3.js';
import type { Umi } from '@metaplex-foundation/umi';
import type { PanthersDb } from './db/panthers-db.js';
import type { PanthersStateAdapter } from './state/adapter.js';
import type { PublicCacheWriter } from './public/cache.js';
import type { PanthersBot } from './telegram/bot.js';
import { completeSale } from './solana/deposit.js';
import type { PendingSale, PanthersState } from './state/schema.js';

export async function runDevnetSelfTest(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  umi: Umi;
  connection: Connection;
  keypair: Keypair;
  rpcUrl: string;
  cacheWriter: PublicCacheWriter;
  agentPublicUrl: string;
  bot: PanthersBot | null;
}): Promise<void> {
  if (!params.rpcUrl.includes('devnet')) return;

  const state = await params.db.loadState(params.adapter);
  if (Object.keys(state.nfts).length > 0) return;

  console.log('[SelfTest] First boot on devnet — minting test NFT...');

  const saleId = `self-test-${Date.now()}`;
  const pendingSale: PendingSale = {
    saleId,
    telegramUserId: 'self-test',
    buyerWallet: params.keypair.publicKey.toBase58(),
    agreedPriceUsdc: 1.0,
    expiresAt: Date.now() + 86400000,
    status: 'awaiting_payment',
    createdAt: Date.now(),
  };

  const stateWithSale: PanthersState = {
    ...state,
    pendingSales: { ...state.pendingSales, [saleId]: pendingSale },
  };
  await params.db.saveState(stateWithSale, params.adapter, params.cacheWriter);

  const result = await completeSale({
    db: params.db,
    adapter: params.adapter,
    umi: params.umi,
    rpcUrl: params.rpcUrl,
    saleId,
    confirmedAmountUsdc: 1.0,
    txSignature: `devnet-self-test-${Date.now()}`,
    cacheWriter: params.cacheWriter,
    agentPublicUrl: params.agentPublicUrl,
  });

  console.log(
    `[SelfTest] NFT #1 minted. mintAddress=${result.mintAddress} tokenId=${result.tokenId}`,
  );

  if (params.bot) {
    try {
      await params.bot.sendGroupMessage(
        'Panthers Fund #1 minted. Systems operational.',
      );
    } catch (err) {
      console.error('[SelfTest] Failed to announce in group:', err);
    }
  }
}
