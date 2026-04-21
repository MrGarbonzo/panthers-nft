import { v4 as uuidv4 } from 'uuid';
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import type { Umi } from '@metaplex-foundation/umi';
import type { PanthersDb } from '../db/panthers-db.js';
import type { PanthersStateAdapter } from '../state/adapter.js';
import type {
  EscrowRecord,
  NftRecord,
  P2pListing,
  PanthersState,
} from '../state/schema.js';
import { burnPanthersNft, mintPanthersNft } from '../solana/nft.js';
import { recalculateAllNavs } from '../state/nav.js';
import type { PublicCacheWriter } from '../public/cache.js';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 1_000_000;

export async function createP2pListing(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  tokenId: string;
  sellerTelegramId: string;
  sellerWallet: string;
  askingPriceUsdc: number;
}): Promise<P2pListing> {
  const state = await params.db.loadState(params.adapter);
  const nft = state.nfts[params.tokenId];
  if (!nft) throw new Error('NFT not found');
  if (nft.ownerTelegramId !== params.sellerTelegramId) {
    throw new Error('Not your NFT');
  }

  const listing: P2pListing = {
    listingId: uuidv4(),
    tokenId: params.tokenId,
    sellerTelegramId: params.sellerTelegramId,
    sellerWallet: params.sellerWallet,
    askingPriceUsdc: params.askingPriceUsdc,
    createdAt: Date.now(),
    status: 'active',
  };

  const nextState: PanthersState = {
    ...state,
    p2pListings: { ...state.p2pListings, [listing.listingId]: listing },
  };
  await params.db.saveState(nextState, params.adapter);
  return listing;
}

export async function executeP2pSale(params: {
  db: PanthersDb;
  adapter: PanthersStateAdapter;
  umi: Umi;
  connection: Connection;
  agentKeypair: Keypair;
  cacheWriter: PublicCacheWriter;
  listingId: string;
  buyerTelegramId: string;
  buyerWallet: string;
  agreedPriceUsdc: number;
  txSignature: string;
  agentPublicUrl?: string;
}): Promise<{ newTokenId: string; mintAddress: string }> {
  const state = await params.db.loadState(params.adapter);
  const listing = state.p2pListings[params.listingId];
  if (!listing || listing.status !== 'active') {
    throw new Error('Listing not found or inactive');
  }
  const nft = state.nfts[listing.tokenId];
  if (!nft) throw new Error('NFT record not found');

  const feesUsdc = params.agreedPriceUsdc * state.agentConfig.feePctOnBurn;
  const sellerReceives = params.agreedPriceUsdc - feesUsdc;

  await burnPanthersNft({
    umi: params.umi,
    mintAddress: nft.mintAddress,
    ownerWallet: listing.sellerWallet,
  });

  const newTokenId = uuidv4();
  const newNftIndex = nft.nftIndex;
  const metadataUri = params.agentPublicUrl
    ? `${params.agentPublicUrl}/metadata/${newTokenId}`
    : undefined;
  const mintAddress = await mintPanthersNft({
    umi: params.umi,
    recipientWallet: params.agentKeypair.publicKey.toBase58(),
    tokenId: newTokenId,
    nftIndex: newNftIndex,
    rpcUrl: '',
    metadataUri,
  });

  const sellerPubkey = new PublicKey(listing.sellerWallet);
  const sourceAta = await getAssociatedTokenAddress(
    USDC_MINT,
    params.agentKeypair.publicKey,
  );
  const destAta = await getOrCreateAssociatedTokenAccount(
    params.connection,
    params.agentKeypair,
    USDC_MINT,
    sellerPubkey,
  );
  const atomicAmount = BigInt(Math.floor(sellerReceives * USDC_DECIMALS));
  const tx = new Transaction().add(
    createTransferInstruction(
      sourceAta,
      destAta.address,
      params.agentKeypair.publicKey,
      atomicAmount,
    ),
  );
  await sendAndConfirmTransaction(params.connection, tx, [params.agentKeypair]);

  const now = Date.now();
  const newNft: NftRecord = {
    tokenId: newTokenId,
    ownerWallet: params.buyerWallet,
    ownerTelegramId: params.buyerTelegramId,
    usdcDeposited: nft.usdcDeposited,
    currentNav: nft.currentNav,
    mintPrice: params.agreedPriceUsdc,
    mintedAt: now,
    mintAddress,
    custodyMode: 'agent',
    nftIndex: newNftIndex,
  };

  const escrowId = uuidv4();
  const escrow: EscrowRecord = {
    escrowId,
    type: 'p2p',
    nftTokenId: newTokenId,
    buyerWallet: params.buyerWallet,
    sellerWallet: listing.sellerWallet,
    sellerTelegramId: listing.sellerTelegramId,
    amount: params.agreedPriceUsdc,
    feesUsdc,
    status: 'released',
    createdAt: now,
    settledAt: now,
    txSignature: params.txSignature,
  };

  const { [listing.tokenId]: _removed, ...remainingNfts } = state.nfts;
  void _removed;

  let nextState: PanthersState = {
    ...state,
    nfts: { ...remainingNfts, [newTokenId]: newNft },
    escrow: { ...state.escrow, [escrowId]: escrow },
    p2pListings: {
      ...state.p2pListings,
      [params.listingId]: { ...listing, status: 'sold' },
    },
    personalFund: {
      ...state.personalFund,
      totalFeesCollectedUsdc: state.personalFund.totalFeesCollectedUsdc + feesUsdc,
      lastUpdatedAt: now,
    },
  };
  nextState = recalculateAllNavs(nextState);

  await params.db.saveState(nextState, params.adapter, params.cacheWriter);
  return { newTokenId, mintAddress };
}
