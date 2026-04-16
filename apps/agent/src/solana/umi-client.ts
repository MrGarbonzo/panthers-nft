import type { Keypair } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity, type Umi } from '@metaplex-foundation/umi';
import { mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters';

export function initializeUmi(keypair: Keypair, rpcUrl: string): Umi {
  const umi = createUmi(rpcUrl).use(mplTokenMetadata());
  const umiKeypair = fromWeb3JsKeypair(keypair);
  return umi.use(keypairIdentity(umiKeypair));
}
