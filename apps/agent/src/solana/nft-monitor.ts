import { Connection, PublicKey } from '@solana/web3.js';

const DEFAULT_POLL_MS = 30_000;

export interface NftMonitorParams {
  rpcUrl: string;
  agentWallet: string;
  onInboundNft: (params: {
    mintAddress: string;
    fromWallet: string;
    txSignature: string;
  }) => Promise<void>;
  pollIntervalMs?: number;
}

export class NftMonitor {
  private timer: NodeJS.Timeout | null = null;
  private knownMints = new Set<string>();
  private connection: Connection;
  private connected = false;

  constructor(private readonly params: NftMonitorParams) {
    this.connection = new Connection(params.rpcUrl, 'confirmed');
  }

  start(): void {
    if (this.timer) return;
    const interval = this.params.pollIntervalMs ?? DEFAULT_POLL_MS;
    void this.safePoll(true);
    this.timer = setInterval(() => void this.safePoll(false), interval);
    this.connected = true;
    console.log(`NftMonitor started (poll ${Math.round(interval / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  seedKnownMint(mintAddress: string): void {
    this.knownMints.add(mintAddress);
  }

  private async safePoll(isInit: boolean): Promise<void> {
    try {
      await this.poll(isInit);
    } catch (err) {
      console.error('NftMonitor poll failed:', err);
    }
  }

  private async poll(isInit: boolean): Promise<void> {
    const owner = new PublicKey(this.params.agentWallet);
    const TOKEN_PROGRAM = new PublicKey(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    const accounts = await this.connection.getParsedTokenAccountsByOwner(
      owner,
      { programId: TOKEN_PROGRAM },
    );

    for (const { account } of accounts.value) {
      const parsed = account.data as {
        parsed?: {
          info?: {
            mint?: string;
            tokenAmount?: { uiAmount?: number };
          };
        };
      };
      const mint = parsed.parsed?.info?.mint;
      const amount = parsed.parsed?.info?.tokenAmount?.uiAmount;
      if (!mint || amount !== 1) continue;

      if (this.knownMints.has(mint)) continue;
      this.knownMints.add(mint);

      if (isInit) continue;

      console.log(`[NftMonitor] New NFT detected: ${mint}`);
      const sigs = await this.connection.getSignaturesForAddress(
        new PublicKey(mint),
        { limit: 1 },
      );
      const txSig = sigs[0]?.signature ?? 'unknown';

      let fromWallet = 'unknown';
      if (sigs[0]) {
        try {
          const tx = await this.connection.getParsedTransaction(txSig, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          const signers = tx?.transaction.message.accountKeys
            .filter((k) => k.signer)
            .map((k) => k.pubkey.toBase58());
          if (signers && signers.length > 0) {
            fromWallet = signers[0]!;
          }
        } catch {}
      }

      await this.params.onInboundNft({
        mintAddress: mint,
        fromWallet,
        txSignature: txSig,
      });
    }
  }
}
