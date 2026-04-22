import { Bot, type Context } from 'grammy';
import { v4 as uuidv4 } from 'uuid';
import { Connection, Keypair } from '@solana/web3.js';
import type { Umi } from '@metaplex-foundation/umi';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type { LLMRouter } from '../llm/router.js';
import type {
  AuctionRecord,
  Bid,
  EscrowRecord,
  HagglingSession,
  NftRecord,
  PanthersState,
  PendingSale,
} from '../state/schema.js';
import { placeBid } from '../auction/engine.js';
import { createP2pListing } from '../auction/p2p.js';
import {
  detectBuyIntent,
  generateHaggleResponse,
  scoreSentiment,
  decideAuctionType,
  generateGroupReply,
} from '../llm/tasks.js';
import { processWithdrawal } from '../solana/withdraw.js';
import { transferNftToUser } from '../solana/custody.js';

import { PublicCacheWriter, normalizeName } from '../public/cache.js';


const MESSAGE_BUFFER_MAX = 50;
const SENTIMENT_INTERVAL_MS = 10 * 60 * 1000;
const PAYMENT_WINDOW_MS = 30 * 60 * 1000;
const REDEMPTION_WINDOW_MS = 60 * 60 * 1000;
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface AwaitingWallet {
  sessionId: string;
  agreedPriceUsdc: number;
}

interface AwaitingWithdrawConfirm {
  tokenId: string;
}

interface AwaitingRedemption {
  tokenId: string;
  redemptionId: string;
  navUsdc: number;
  expiresAt: number;
}

import type { PersonaContextProvider } from '../persona/context-provider.js';

export interface PanthersBotParams {
  token: string;
  groupChatId: number | string;
  llmRouter: LLMRouter;
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  umi: Umi;
  connection: Connection;
  agentKeypair: Keypair;
  cacheWriter: PublicCacheWriter;
  personaCtx?: PersonaContextProvider;
  usdcMint: string;
}

export class PanthersBot {
  private readonly bot: Bot;
  private readonly groupChatId: string;
  private readonly messageBuffer: string[] = [];
  private readonly awaitingWallet = new Map<string, AwaitingWallet>();
  private readonly awaitingWithdrawConfirm = new Map<
    string,
    AwaitingWithdrawConfirm
  >();
  private readonly awaitingRedemption = new Map<
    string,
    AwaitingRedemption
  >();
  private sentimentTimer: NodeJS.Timeout | null = null;

  constructor(private readonly params: PanthersBotParams) {
    this.bot = new Bot(params.token);
    this.groupChatId = String(params.groupChatId);
    this.registerHandlers();
  }

  private async llmFor(task: import('../llm/routing.js').LlmTaskType) {
    const pCtx = this.params.personaCtx;
    if (pCtx) {
      const ctx = await pCtx.getSurvivalContext();
      return this.params.llmRouter.forWithPersona(task, ctx, pCtx.agentWallet);
    }
    return this.params.llmRouter.for(task);
  }

  start(): void {
    void this.bot.start({ onStart: (info) => {
      console.log(`PanthersBot started as @${info.username}`);
    } });
    this.sentimentTimer = setInterval(
      () => void this.runSentiment(),
      SENTIMENT_INTERVAL_MS,
    );
  }

  async stop(): Promise<void> {
    if (this.sentimentTimer) {
      clearInterval(this.sentimentTimer);
      this.sentimentTimer = null;
    }
    await this.bot.stop();
  }

  async sendAuctionWinDm(
    telegramUserId: string,
    auctionId: string,
  ): Promise<void> {
    const state = await this.params.db.loadState(this.params.adapter);
    const auction = state.auctions[auctionId];
    if (!auction) {
      console.error(`sendAuctionWinDm: auction not found ${auctionId}`);
      return;
    }
    const finalPrice = auction.currentPrice;
    this.awaitingWallet.set(telegramUserId, {
      sessionId: auctionId,
      agreedPriceUsdc: finalPrice,
    });

    const escrowId = uuidv4();
    const escrow: EscrowRecord = {
      escrowId,
      type: 'auction',
      nftTokenId: '',
      buyerWallet: '',
      sellerWallet: this.params.agentKeypair.publicKey.toBase58(),
      amount: finalPrice,
      feesUsdc: 0,
      status: 'pending',
      createdAt: Date.now(),
    };
    const nextState: PanthersState = {
      ...state,
      escrow: { ...state.escrow, [escrowId]: escrow },
    };
    await this.params.db.saveState(
      nextState,
      this.params.adapter,
      this.params.cacheWriter,
    );

    try {
      await this.bot.api.sendMessage(
        telegramUserId,
        `Congratulations! You won the Panthers Fund NFT auction at ${finalPrice} USDC.\n` +
          'Send me your Solana wallet address to receive your NFT.',
      );
    } catch (err) {
      console.error('sendAuctionWinDm send failed:', err);
    }
  }

  async sendGroupMessage(text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.groupChatId, text);
    } catch (err) {
      console.error('sendGroupMessage failed:', err);
    }
  }

  async announceAuction(auction: AuctionRecord): Promise<void> {
    const typeLabel =
      auction.type === 'dutch'
        ? 'Dutch auction (price drops over time — first /bid wins)'
        : auction.type === 'english'
        ? 'English auction (bid higher with /bid <amount>)'
        : 'Flash sale (first /buy claims it)';
    const minutes = Math.max(
      1,
      Math.round((auction.expiresAt - Date.now()) / 60000),
    );
    await this.sendGroupMessage(
      `🔔 Panthers Fund auction live — ${typeLabel}\n` +
        `Starting price: ${auction.startPrice.toFixed(2)} USDC\n` +
        `Ends in ~${minutes} min`,
    );
  }

  async announceDutchDrop(auction: AuctionRecord): Promise<void> {
    await this.sendGroupMessage(
      `🔽 Dutch auction price drop → ${auction.currentPrice.toFixed(2)} USDC\n` +
        'First to /bid wins!',
    );
  }

  async announceAuctionCancelled(_auction: AuctionRecord): Promise<void> {
    await this.sendGroupMessage(
      'Panthers Fund auction ended with no bids. Watch for the next one.',
    );
  }

  private registerHandlers(): void {
    this.bot.command('nav', (ctx) => this.handleNavCommand(ctx));
    this.bot.command('portfolio', (ctx) => this.handlePortfolioCommand(ctx));
    this.bot.command('withdraw', (ctx) => this.handleWithdrawCommand(ctx));
    this.bot.command('claim', (ctx) => this.handleClaimCommand(ctx));
    this.bot.command('redeem', (ctx) => this.handleRedeemCommand(ctx));
    this.bot.command('balance', (ctx) => this.handleBalanceCommand(ctx));
    this.bot.command('sell', (ctx) => this.handleSellCommand(ctx));
    this.bot.command('buylisting', (ctx) => this.handleBuyListingCommand(ctx));
    this.bot.command('bid', (ctx) => this.handleBidCommand(ctx));
    this.bot.command('buy', (ctx) => this.handleBuyCommand(ctx));

    this.bot.on('message:text', async (ctx) => {
      const chatType = ctx.chat?.type;
      if (chatType === 'private') {
        await this.handlePrivateMessage(ctx);
      } else if (
        (chatType === 'group' || chatType === 'supergroup') &&
        String(ctx.chat.id) === this.groupChatId
      ) {
        await this.handleGroupMessage(ctx);
      }
    });

    this.bot.catch((err) => {
      console.error('PanthersBot error:', err);
    });
  }

  getRecentMessages(): string[] {
    return [...this.messageBuffer];
  }

  private async handleGroupMessage(ctx: Context): Promise<void> {
    const text = ctx.message?.text;
    const from = ctx.from;
    if (!text || !from) return;

    if (text.startsWith('/')) return;

    const userName = from.username ?? from.first_name ?? String(from.id);
    this.messageBuffer.unshift(`[${userName}]: ${text}`);
    if (this.messageBuffer.length > MESSAGE_BUFFER_MAX) {
      this.messageBuffer.length = MESSAGE_BUFFER_MAX;
    }

    if (await this.tryAnswerBalanceQuery(ctx, text)) return;

    if (await this.tryReplyToMention(ctx, text, userName)) return;

    try {
      const intent = await detectBuyIntent(await this.llmFor('buy_intent'), text, userName);
      if (
        intent.hasBuyIntent &&
        (intent.confidence === 'high' || intent.confidence === 'medium')
      ) {
        await this.openBuyDm(String(from.id), userName);
      }
    } catch (err) {
      console.error('detectBuyIntent failed:', err);
    }
  }

  private async tryReplyToMention(
    ctx: Context,
    text: string,
    userName: string,
  ): Promise<boolean> {
    const botUsername = this.bot.botInfo?.username;
    if (!botUsername) return false;

    const botUserId = this.bot.botInfo.id;
    const replyToBot = ctx.message?.reply_to_message?.from?.id === botUserId;
    const entities = ctx.message?.entities ?? [];
    const mentioned = entities.some((e) => {
      if (e.type !== 'mention') return false;
      const slice = text.slice(e.offset, e.offset + e.length);
      return slice.toLowerCase() === `@${botUsername.toLowerCase()}`;
    });

    if (!replyToBot && !mentioned) return false;

    try {
      const state = await this.params.db.loadState(this.params.adapter);
      const result = await generateGroupReply(
        await this.llmFor('chat'),
        text,
        userName,
        this.getRecentMessages(),
        state.signals,
      );
      if (result.message.trim()) {
        await ctx.reply(result.message);
      }
    } catch (err) {
      console.error('generateGroupReply failed:', err);
    }
    return true;
  }

  private async tryAnswerBalanceQuery(
    ctx: Context,
    text: string,
  ): Promise<boolean> {
    const hasPanthers = /panthers/i.test(text);
    let match = text.match(/panthers[#\s]*(\d+)/i);
    if (!match && hasPanthers) match = text.match(/#(\d+)/);
    if (!match) return false;

    const cache = await this.params.cacheWriter.read();
    if (!cache) return false;
    const record = this.params.cacheWriter.lookupByName(
      cache,
      `panthers#${match[1]}`,
    );
    if (!record) {
      await ctx.reply('No Panthers Fund NFT found with that number.');
      return true;
    }
    await ctx.reply(formatBalanceReply(record));
    return true;
  }

  private async handlePrivateMessage(ctx: Context): Promise<void> {
    const from = ctx.from;
    const text = ctx.message?.text;
    if (!from || !text) return;

    const userId = String(from.id);

    const awaitingConfirm = this.awaitingWithdrawConfirm.get(userId);
    if (awaitingConfirm) {
      await this.completeWithdrawConfirm(ctx, userId, awaitingConfirm.tokenId, text);
      return;
    }

    const awaitingAddr = this.awaitingWallet.get(userId);
    if (awaitingAddr) {
      await this.handleWalletAddress(ctx, userId, awaitingAddr, text);
      return;
    }

    const state = await this.params.db.loadState(this.params.adapter);
    const activeSession = findActiveSession(state, userId);
    if (activeSession) {
      await this.handleHaggleReply(ctx, userId, activeSession, text, state);
      return;
    }
  }

  async openBuyDm(telegramUserId: string, userName: string): Promise<void> {
    let state = await this.params.db.loadState(this.params.adapter);

    if (findActiveSession(state, telegramUserId)) return;

    const availableNftCount = Object.keys(state.nfts).length;
    let decision;
    try {
      decision = await decideAuctionType(
        await this.llmFor('auction'),
        state.signals,
        availableNftCount,
      );
    } catch (err) {
      console.error('decideAuctionType failed:', err);
      return;
    }

    const agentCeiling = decision.startPriceUsdc;
    const agentFloor = agentCeiling * 0.85;
    const sessionId = uuidv4();
    const session: HagglingSession = {
      sessionId,
      telegramUserId,
      nftTokenId: '',
      agentFloor,
      agentCeiling,
      offerHistory: [
        { fromAgent: true, amount: agentCeiling, offeredAt: Date.now() },
      ],
      status: 'active',
    };

    state = {
      ...state,
      haggling: { ...state.haggling, [sessionId]: session },
    };
    await this.params.db.saveState(state, this.params.adapter, this.params.cacheWriter);

    try {
      await this.bot.api.sendMessage(
        telegramUserId,
        `Hey ${userName} 👋 I noticed you're interested in Panthers Fund.\n` +
          `I'm the fund agent. I can offer you a share at ${agentCeiling} USDC.\n` +
          'What would you like to offer?',
      );
    } catch (err) {
      console.error('openBuyDm sendMessage failed:', err);
    }
  }

  private async handleHaggleReply(
    ctx: Context,
    userId: string,
    session: HagglingSession,
    text: string,
    state: PanthersState,
  ): Promise<void> {
    const offerMatch = text.match(/(\d+(?:\.\d+)?)/);
    if (!offerMatch) {
      await ctx.reply('Please make me a USDC offer to continue.');
      return;
    }
    const userOffer = Number(offerMatch[1]);

    const updatedOfferHistory = [
      ...session.offerHistory,
      { fromAgent: false, amount: userOffer, offeredAt: Date.now() },
    ];
    const withUserOffer: HagglingSession = {
      ...session,
      offerHistory: updatedOfferHistory,
    };

    let result;
    try {
      result = await generateHaggleResponse(
        await this.llmFor('haggle'),
        withUserOffer,
        state.signals,
      );
    } catch (err) {
      console.error('generateHaggleResponse failed:', err);
      await ctx.reply('Give me a moment, my models are catching up.');
      return;
    }

    let finalSession: HagglingSession = withUserOffer;

    if (result.action === 'counter') {
      finalSession = {
        ...withUserOffer,
        offerHistory: [
          ...updatedOfferHistory,
          {
            fromAgent: true,
            amount: result.counterOfferUsdc ?? withUserOffer.agentCeiling,
            offeredAt: Date.now(),
          },
        ],
      };
      await ctx.reply(result.message);
    } else if (result.action === 'accept') {
      finalSession = { ...withUserOffer, status: 'accepted' };
      this.awaitingWallet.set(userId, {
        sessionId: session.sessionId,
        agreedPriceUsdc: userOffer,
      });
      await ctx.reply(
        `${result.message}\n\nSend me your Solana wallet address to proceed.`,
      );
    } else {
      finalSession = { ...withUserOffer, status: 'rejected' };
      await ctx.reply(result.message);
    }

    const nextState: PanthersState = {
      ...state,
      haggling: { ...state.haggling, [session.sessionId]: finalSession },
    };
    await this.params.db.saveState(nextState, this.params.adapter, this.params.cacheWriter);
  }

  private async handleWalletAddress(
    ctx: Context,
    userId: string,
    awaiting: AwaitingWallet,
    text: string,
  ): Promise<void> {
    const candidate = text.trim();
    if (!SOLANA_ADDRESS_REGEX.test(candidate)) {
      await ctx.reply(
        "That doesn't look like a valid Solana address. Please send your wallet address.",
      );
      return;
    }

    const state = await this.params.db.loadState(this.params.adapter);
    const saleId = uuidv4();
    const session = state.haggling[awaiting.sessionId];
    const listingId =
      session && state.p2pListings[session.nftTokenId]
        ? session.nftTokenId
        : undefined;
    const pending: PendingSale = {
      saleId,
      telegramUserId: userId,
      buyerWallet: candidate,
      agreedPriceUsdc: awaiting.agreedPriceUsdc,
      expiresAt: Date.now() + PAYMENT_WINDOW_MS,
      status: 'awaiting_payment',
      createdAt: Date.now(),
      ...(listingId ? { listingId } : {}),
    };

    const nextState: PanthersState = {
      ...state,
      pendingSales: { ...state.pendingSales, [saleId]: pending },
    };
    await this.params.db.saveState(nextState, this.params.adapter, this.params.cacheWriter);
    this.awaitingWallet.delete(userId);

    const agentWallet = this.params.agentKeypair.publicKey.toBase58();
    await ctx.reply(
      `Perfect. Send exactly ${awaiting.agreedPriceUsdc} USDC to:\n` +
        `${agentWallet}\n\n` +
        `Include this memo exactly: ${saleId}\n\n` +
        "Payment window: 30 minutes. I'll mint your NFT automatically when payment is confirmed.",
    );
  }

  private async runSentiment(): Promise<void> {
    if (this.messageBuffer.length === 0) return;
    try {
      const result = await scoreSentiment(await this.llmFor('sentiment'), [
        ...this.messageBuffer,
      ]);
      const state = await this.params.db.loadState(this.params.adapter);
      const nextState: PanthersState = {
        ...state,
        signals: {
          ...state.signals,
          lastSentimentScore: result.score,
          lastUpdatedAt: Date.now(),
        },
      };
      await this.params.db.saveState(nextState, this.params.adapter, this.params.cacheWriter);
      console.log(
        `Sentiment updated: score=${result.score} level=${result.buyInterestLevel} — ${result.summary}`,
      );
    } catch (err) {
      console.error('scoreSentiment failed:', err);
    }
  }

  private async handleNavCommand(ctx: Context): Promise<void> {
    if (ctx.chat?.type !== 'private') return;
    const userId = String(ctx.from?.id);
    const state = await this.params.db.loadState(this.params.adapter);
    const owned = ownedNfts(state, userId);
    if (owned.length === 0) {
      await ctx.reply("You don't hold any Panthers Fund NFTs.");
      return;
    }
    const lines = owned.map(
      (n, i) =>
        `Panthers Fund #${i + 1} [${n.tokenId}] — NAV: ${n.currentNav.toFixed(2)} USDC`,
    );
    await ctx.reply(lines.join('\n'));
  }

  private async handlePortfolioCommand(ctx: Context): Promise<void> {
    if (ctx.chat?.type !== 'private') return;
    const userId = String(ctx.from?.id);
    const state = await this.params.db.loadState(this.params.adapter);
    const owned = ownedNfts(state, userId);
    if (owned.length === 0) {
      await ctx.reply("You don't hold any Panthers Fund NFTs.");
      return;
    }
    const lines = owned.map((n, i) => {
      const minted = new Date(n.mintedAt).toISOString().slice(0, 10);
      return (
        `Panthers Fund #${i + 1} [${n.tokenId}]\n` +
        `  NAV: ${n.currentNav.toFixed(2)} USDC\n` +
        `  Minted: ${minted} @ ${n.mintPrice.toFixed(2)} USDC`
      );
    });
    await ctx.reply(lines.join('\n\n'));
  }

  private async handleWithdrawCommand(ctx: Context): Promise<void> {
    if (ctx.chat?.type !== 'private') return;
    const userId = String(ctx.from?.id);
    const match = ctx.message?.text?.match(/^\/withdraw\s+(\S+)/);
    if (!match) {
      await ctx.reply('Usage: /withdraw [tokenId]');
      return;
    }
    const tokenId = match[1]!;
    const state = await this.params.db.loadState(this.params.adapter);
    const nft = state.nfts[tokenId];
    if (!nft || nft.ownerTelegramId !== userId) {
      await ctx.reply("That NFT isn't yours or doesn't exist.");
      return;
    }
    const feePct = state.agentConfig.feePctOnBurn;
    const fees = nft.currentNav * feePct;
    const receive = nft.currentNav - fees;
    this.awaitingWithdrawConfirm.set(userId, { tokenId });
    await ctx.reply(
      `Your NFT current NAV: ${nft.currentNav.toFixed(2)} USDC. ` +
        `Fee: ${fees.toFixed(2)} USDC (${(feePct * 100).toFixed(0)}%). ` +
        `You receive: ${receive.toFixed(2)} USDC.\n` +
        'Reply YES to confirm withdrawal and burn.',
    );
  }

  private async completeWithdrawConfirm(
    ctx: Context,
    userId: string,
    tokenId: string,
    text: string,
  ): Promise<void> {
    if (text.trim().toUpperCase() !== 'YES') {
      this.awaitingWithdrawConfirm.delete(userId);
      await ctx.reply('Withdrawal cancelled.');
      return;
    }
    this.awaitingWithdrawConfirm.delete(userId);

    const state = await this.params.db.loadState(this.params.adapter);
    const nft = state.nfts[tokenId];
    if (!nft || nft.ownerTelegramId !== userId) {
      await ctx.reply("That NFT isn't yours or doesn't exist.");
      return;
    }

    try {
      const result = await processWithdrawal({
        db: this.params.db,
        adapter: this.params.adapter,
        umi: this.params.umi,
        connection: this.params.connection,
        agentKeypair: this.params.agentKeypair,
        tokenId,
        ownerWallet: nft.ownerWallet,
        usdcMint: this.params.usdcMint,
        cacheWriter: this.params.cacheWriter,
      });
      await ctx.reply(
        `Withdrawal complete. You received ${result.withdrawnUsdc.toFixed(2)} USDC ` +
          `(fee ${result.feesUsdc.toFixed(2)} USDC). NFT burned.`,
      );
    } catch (err) {
      console.error('processWithdrawal failed:', err);
      await ctx.reply(
        'Withdrawal failed. Please try again in a moment or contact support.',
      );
    }
  }

  private async handleClaimCommand(ctx: Context): Promise<void> {
    if (ctx.chat?.type !== 'private') return;
    const userId = String(ctx.from?.id);
    const match = ctx.message?.text?.match(/^\/claim\s+(\S+)/);
    if (!match) {
      await ctx.reply('Usage: /claim [tokenId]');
      return;
    }
    const tokenId = match[1]!;

    const state = await this.params.db.loadState(this.params.adapter);
    const nft = state.nfts[tokenId];
    if (!nft || nft.ownerTelegramId !== userId) {
      await ctx.reply("That NFT isn't yours or doesn't exist.");
      return;
    }
    if (nft.custodyMode === 'self') {
      await ctx.reply('You already hold this NFT in self-custody.');
      return;
    }

    await ctx.reply(
      `Transferring Panthers Fund #${nft.nftIndex} to your wallet ${nft.ownerWallet}...`,
    );

    try {
      await transferNftToUser({
        umi: this.params.umi,
        mintAddress: nft.mintAddress,
        toWallet: nft.ownerWallet,
      });
    } catch (err) {
      console.error('transferNftToUser failed:', err);
      await ctx.reply('Transfer failed. Please try again in a moment.');
      return;
    }

    const now = Date.now();
    const updatedNft: NftRecord = {
      ...nft,
      custodyMode: 'self',
      claimedAt: now,
    };
    const nextState: PanthersState = {
      ...state,
      nfts: { ...state.nfts, [tokenId]: updatedNft },
    };
    await this.params.db.saveState(
      nextState,
      this.params.adapter,
      this.params.cacheWriter,
    );

    await ctx.reply(
      `Done. Panthers Fund #${nft.nftIndex} is now in your wallet.\n` +
        `You can verify at: https://explorer.solana.com/address/${nft.mintAddress}\n` +
        `To redeem funds later, use /redeem ${tokenId} — you will need to sign a message with your wallet.`,
    );
  }

  private async handleRedeemCommand(ctx: Context): Promise<void> {
    if (ctx.chat?.type !== 'private') return;
    const userId = String(ctx.from?.id);
    const match = ctx.message?.text?.match(/^\/redeem\s+(\S+)/);
    if (!match) {
      await ctx.reply('Usage: /redeem [tokenId]');
      return;
    }
    const tokenId = match[1]!;
    const state = await this.params.db.loadState(this.params.adapter);
    const nft = state.nfts[tokenId];
    if (!nft) {
      await ctx.reply("That NFT doesn't exist.");
      return;
    }
    if (nft.custodyMode === 'agent') {
      await ctx.reply(
        `This NFT is in agent custody. Use /withdraw ${tokenId} instead.`,
      );
      return;
    }

    const feePct = state.agentConfig.feePctOnBurn;
    const fee = nft.currentNav * feePct;
    const receive = nft.currentNav - fee;
    const redemptionId = uuidv4();
    const agentWallet = this.params.agentKeypair.publicKey.toBase58();

    this.awaitingRedemption.set(userId, {
      tokenId,
      redemptionId,
      navUsdc: nft.currentNav,
      expiresAt: Date.now() + REDEMPTION_WINDOW_MS,
    });

    await ctx.reply(
      `Panthers Fund #${nft.nftIndex} Redemption\n\n` +
        `Current NAV: ${nft.currentNav.toFixed(2)} USDC\n` +
        `Fee: ${fee.toFixed(2)} USDC (${(feePct * 100).toFixed(0)}%)\n` +
        `You receive: ${receive.toFixed(2)} USDC\n\n` +
        `To redeem, transfer the NFT to the agent wallet:\n${agentWallet}\n\n` +
        `Window: 60 minutes. I will detect the transfer and send your USDC automatically.`,
    );
  }

  private async handleBalanceCommand(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? '';
    const argMatch = text.match(/^\/balance(?:@\S+)?\s+(.+)/);
    if (!argMatch) {
      await ctx.reply('Usage: /balance <Panthers#142 | 142>');
      return;
    }
    const normalized = normalizeName(argMatch[1]!);
    if (!normalized) {
      await ctx.reply('No Panthers Fund NFT found with that number.');
      return;
    }
    const cache = await this.params.cacheWriter.read();
    if (!cache) {
      await ctx.reply('Balance cache not yet initialized.');
      return;
    }
    const record = this.params.cacheWriter.lookupByName(cache, normalized);
    if (!record) {
      await ctx.reply('No Panthers Fund NFT found with that number.');
      return;
    }
    await ctx.reply(formatBalanceReply(record));
  }

  private async handleSellCommand(ctx: Context): Promise<void> {
    if (ctx.chat?.type !== 'private') return;
    const userId = String(ctx.from?.id);
    const text = ctx.message?.text ?? '';
    const match = text.match(/^\/sell(?:@\S+)?\s+(\S+)\s+(\S+)/);
    if (!match) {
      await ctx.reply('Usage: /sell [tokenId] [askingPriceUSDC]');
      return;
    }
    const tokenId = match[1]!;
    const askingStr = match[2]!;
    const state = await this.params.db.loadState(this.params.adapter);
    const nft = state.nfts[tokenId];
    if (!nft || nft.ownerTelegramId !== userId) {
      await ctx.reply('NFT not found or not yours.');
      return;
    }
    const asking = Number(askingStr);
    if (!Number.isFinite(asking) || asking <= 0) {
      await ctx.reply('Invalid price.');
      return;
    }

    let listing;
    try {
      listing = await createP2pListing({
        db: this.params.db,
        adapter: this.params.adapter,
        tokenId,
        sellerTelegramId: userId,
        sellerWallet: nft.ownerWallet,
        askingPriceUsdc: asking,
      });
    } catch (err) {
      console.error('createP2pListing failed:', err);
      await ctx.reply('Failed to create listing.');
      return;
    }

    await this.sendGroupMessage(
      `📋 P2P Sale: Panthers Fund #${nft.nftIndex} listed for ${asking} USDC\n` +
        `DM me /buylisting ${listing.listingId} to negotiate.`,
    );
    await ctx.reply(
      `Your NFT is now listed. Buyers will DM me /buylisting ${listing.listingId} to negotiate.`,
    );
  }

  private async handleBuyListingCommand(ctx: Context): Promise<void> {
    if (ctx.chat?.type !== 'private') return;
    const userId = String(ctx.from?.id);
    const text = ctx.message?.text ?? '';
    const match = text.match(/^\/buylisting(?:@\S+)?\s+(\S+)/);
    if (!match) {
      await ctx.reply('Usage: /buylisting [listingId]');
      return;
    }
    const listingId = match[1]!;
    const state = await this.params.db.loadState(this.params.adapter);
    const listing = state.p2pListings[listingId];
    if (!listing || listing.status !== 'active') {
      await ctx.reply('Listing not found or no longer active.');
      return;
    }
    if (listing.sellerTelegramId === userId) {
      await ctx.reply('You cannot buy your own listing.');
      return;
    }

    const buyerNft = Object.values(state.nfts).find(
      (n) => n.ownerTelegramId === userId,
    );
    const buyerWallet = buyerNft?.ownerWallet ?? null;
    if (!buyerWallet) {
      await ctx.reply(
        'You need to hold a Panthers Fund NFT or have a wallet on file. DM me to set one up.',
      );
      return;
    }

    const agentCeiling = listing.askingPriceUsdc;
    const agentFloor = listing.askingPriceUsdc * 0.9;
    const sessionId = uuidv4();
    const session: HagglingSession = {
      sessionId,
      telegramUserId: userId,
      nftTokenId: listingId,
      agentFloor,
      agentCeiling,
      offerHistory: [
        { fromAgent: true, amount: agentCeiling, offeredAt: Date.now() },
      ],
      status: 'active',
    };

    const nextState: PanthersState = {
      ...state,
      haggling: { ...state.haggling, [sessionId]: session },
    };
    await this.params.db.saveState(
      nextState,
      this.params.adapter,
      this.params.cacheWriter,
    );

    const nftIndex = state.nfts[listing.tokenId]?.nftIndex ?? '?';
    await ctx.reply(
      `Panthers Fund #${nftIndex} is available for ${agentCeiling} USDC.\n` +
        'What would you like to offer?',
    );
  }

  private async handleBidCommand(ctx: Context): Promise<void> {
    if (
      (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') ||
      String(ctx.chat.id) !== this.groupChatId
    ) {
      return;
    }
    const userId = String(ctx.from?.id);
    const username = ctx.from?.username ?? ctx.from?.first_name ?? userId;

    let state = await this.params.db.loadState(this.params.adapter);
    const auction = Object.values(state.auctions).find(
      (a) => a.status === 'active',
    );
    if (!auction) {
      await ctx.reply('No active auction right now.');
      return;
    }
    const userNft = Object.values(state.nfts).find(
      (n) => n.ownerTelegramId === userId,
    );
    if (!userNft) {
      await ctx.reply(
        'DM me first to set up your Panthers Fund account before bidding.',
      );
      return;
    }
    const bidderWallet = userNft.ownerWallet;

    if (auction.type === 'dutch') {
      const bid: Bid = {
        bidderWallet,
        bidderTelegramId: userId,
        amount: auction.currentPrice,
        placedAt: Date.now(),
      };
      const nextState: PanthersState = {
        ...state,
        auctions: {
          ...state.auctions,
          [auction.auctionId]: {
            ...auction,
            bids: [bid],
            status: 'settled',
            winnerId: userId,
          },
        },
      };
      await this.params.db.saveState(
        nextState,
        this.params.adapter,
        this.params.cacheWriter,
      );
      await this.sendGroupMessage(
        `🏆 Dutch auction won by @${username} at ${auction.currentPrice.toFixed(2)} USDC!`,
      );
      await this.sendAuctionWinDm(userId, auction.auctionId);
      return;
    }

    if (auction.type === 'english') {
      const text = ctx.message?.text ?? '';
      const amountStr = text.split(/\s+/)[1];
      const amount = amountStr ? Number(amountStr) : NaN;
      if (!Number.isFinite(amount)) {
        await ctx.reply('Usage: /bid [amount] e.g. /bid 150');
        return;
      }
      const bid: Bid = {
        bidderWallet,
        bidderTelegramId: userId,
        amount,
        placedAt: Date.now(),
      };
      let updated;
      try {
        updated = placeBid(auction, bid);
      } catch (err) {
        await ctx.reply((err as Error).message);
        return;
      }
      const nextState: PanthersState = {
        ...state,
        auctions: { ...state.auctions, [auction.auctionId]: updated },
      };
      await this.params.db.saveState(
        nextState,
        this.params.adapter,
        this.params.cacheWriter,
      );
      await this.sendGroupMessage(
        `💰 New high bid: ${amount} USDC by @${username}`,
      );
      return;
    }

    await ctx.reply('This auction does not accept /bid. Try /buy for flash sales.');
    void state;
  }

  private async handleBuyCommand(ctx: Context): Promise<void> {
    if (
      (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') ||
      String(ctx.chat.id) !== this.groupChatId
    ) {
      return;
    }
    const userId = String(ctx.from?.id);
    const username = ctx.from?.username ?? ctx.from?.first_name ?? userId;
    const state = await this.params.db.loadState(this.params.adapter);
    const auction = Object.values(state.auctions).find(
      (a) => a.status === 'active' && a.type === 'flash',
    );
    if (!auction) {
      await ctx.reply('No active flash sale right now.');
      return;
    }
    const userNft = Object.values(state.nfts).find(
      (n) => n.ownerTelegramId === userId,
    );
    if (!userNft) {
      await ctx.reply('DM me first to set up your account.');
      return;
    }
    const bid: Bid = {
      bidderWallet: userNft.ownerWallet,
      bidderTelegramId: userId,
      amount: auction.currentPrice,
      placedAt: Date.now(),
    };
    const nextState: PanthersState = {
      ...state,
      auctions: {
        ...state.auctions,
        [auction.auctionId]: {
          ...auction,
          bids: [bid],
          status: 'settled',
          winnerId: userId,
        },
      },
    };
    await this.params.db.saveState(
      nextState,
      this.params.adapter,
      this.params.cacheWriter,
    );
    await this.sendGroupMessage(`⚡ Flash sale claimed by @${username}!`);
    await this.sendAuctionWinDm(userId, auction.auctionId);
  }
}

function findActiveSession(
  state: PanthersState,
  telegramUserId: string,
): HagglingSession | undefined {
  return Object.values(state.haggling).find(
    (s) => s.telegramUserId === telegramUserId && s.status === 'active',
  );
}

function ownedNfts(state: PanthersState, telegramUserId: string): NftRecord[] {
  return Object.values(state.nfts).filter(
    (n) => n.ownerTelegramId === telegramUserId,
  );
}

function timeAgo(timestamp: number): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSec < 30) return 'just now';
  if (deltaSec < 60) return `${deltaSec} sec ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

function formatBalanceReply(record: {
  navUsdc: number;
  usdcDeposited: number;
  gainPct: number;
  custodyMode: 'agent' | 'self';
  lastUpdatedAt: number;
  name: string;
}): string {
  const indexMatch = record.name.match(/#(\d+)$/);
  const label = indexMatch ? `Panthers Fund #${indexMatch[1]}` : record.name;
  const gainSign = record.gainPct >= 0 ? '+' : '';
  return (
    `${label}\n` +
    `NAV: ${record.navUsdc.toFixed(2)} USDC\n` +
    `Deposited: ${record.usdcDeposited.toFixed(2)} USDC\n` +
    `Gain: ${gainSign}${record.gainPct.toFixed(1)}%\n` +
    `Custody: ${record.custodyMode}\n` +
    `Updated: ${timeAgo(record.lastUpdatedAt)}`
  );
}
