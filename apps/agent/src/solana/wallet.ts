import { Keypair } from '@solana/web3.js';
import type { PanthersDb } from '../db/panthers-db.js';

export function initializeSolanaWallet(db: PanthersDb): Keypair {
  const existing = db.getSolanaKeypairBytes();
  if (existing !== null) {
    return Keypair.fromSecretKey(existing);
  }
  const keypair = Keypair.generate();
  db.setSolanaKeypairBytes(keypair.secretKey);
  console.log(`Generated new Solana keypair: ${keypair.publicKey.toBase58()}`);
  return keypair;
}
