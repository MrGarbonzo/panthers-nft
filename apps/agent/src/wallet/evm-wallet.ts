import { mnemonicToAccount, generateMnemonic, english } from 'viem/accounts';
import type { PanthersDb } from '../db/panthers-db.js';
import { CONFIG } from '../db/config-keys.js';

export interface EvmWalletInfo {
  address: string;
  mnemonic: string;
  signMessage: (msg: string | Uint8Array) => Promise<string>;
  signTypedData: (params: any) => Promise<string>;
}

export function initializeEvmWallet(db: PanthersDb): EvmWalletInfo {
  let mnemonic = db.config.get(CONFIG.EVM_PRIVATE_KEY);

  if (!mnemonic) {
    mnemonic = generateMnemonic(english);
    db.config.set(CONFIG.EVM_PRIVATE_KEY, mnemonic);
    console.log('[evm] Generated new EVM wallet mnemonic (stored in DB)');
  }

  const account = mnemonicToAccount(mnemonic);

  console.log(`[evm] EVM wallet address: ${account.address}`);

  return {
    address: account.address,
    mnemonic,
    signMessage: async (msg: string | Uint8Array) =>
      account.signMessage({ message: typeof msg === 'string' ? msg : { raw: msg } }),
    signTypedData: async (params: any) => account.signTypedData(params),
  };
}
