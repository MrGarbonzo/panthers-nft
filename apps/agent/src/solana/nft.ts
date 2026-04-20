import {
  generateSigner,
  percentAmount,
  publicKey,
  type Umi,
} from '@metaplex-foundation/umi';
import {
  createNft,
  burnV1,
  TokenStandard,
} from '@metaplex-foundation/mpl-token-metadata';

export async function mintPanthersNft(params: {
  umi: Umi;
  recipientWallet: string;
  tokenId: string;
  nftIndex: number;
  rpcUrl: string;
  metadataUri?: string;
}): Promise<string> {
  const mint = generateSigner(params.umi);
  await createNft(params.umi, {
    mint,
    name: `Panthers Fund #${params.nftIndex}`,
    symbol: 'PANTH',
    uri: params.metadataUri ?? '',
    sellerFeeBasisPoints: percentAmount(0),
    isMutable: true,
    tokenOwner: publicKey(params.recipientWallet),
  }).sendAndConfirm(params.umi);
  return mint.publicKey.toString();
}

export async function burnPanthersNft(params: {
  umi: Umi;
  mintAddress: string;
  ownerWallet: string;
}): Promise<void> {
  await burnV1(params.umi, {
    mint: publicKey(params.mintAddress),
    authority: params.umi.identity,
    tokenOwner: publicKey(params.ownerWallet),
    tokenStandard: TokenStandard.NonFungible,
  }).sendAndConfirm(params.umi);
}
