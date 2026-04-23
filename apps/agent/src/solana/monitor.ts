import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

export interface InboundTransfer {
  txSignature: string;
  senderWallet: string;
  amountUsdc: number;
  memo: string | null;
}

export interface UsdcMonitorOptions {
  wsUrl: string;
  rpcUrl: string;
  agentWallet: string;
  usdcMint: string;
  onInboundTransfer: (transfer: InboundTransfer) => Promise<void>;
}

const USDC_DECIMALS = 1_000_000;
const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
const MEMO_PROGRAM_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export class UsdcMonitor {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private readonly connection: Connection;
  private readonly agentAta: PublicKey;
  private readonly seen = new Set<string>();
  private closed = false;

  constructor(private readonly opts: UsdcMonitorOptions) {
    this.wsUrl = opts.wsUrl;
    this.connection = new Connection(opts.rpcUrl, 'confirmed');
    this.agentAta = getAssociatedTokenAddressSync(
      new PublicKey(opts.usdcMint),
      new PublicKey(opts.agentWallet),
    );
  }

  start(): void {
    this.closed = false;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.addEventListener('open', () => {
      const subscribeMsg = {
        jsonrpc: '2.0',
        id: 1,
        method: 'accountSubscribe',
        params: [
          this.agentAta.toBase58(),
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        ],
      };
      console.log('UsdcMonitor subscribe:', JSON.stringify(subscribeMsg));
      this.ws?.send(JSON.stringify(subscribeMsg));
    });

    this.ws.addEventListener('message', (event) => {
      void this.handleMessage(event.data as string);
    });

    this.ws.addEventListener('error', (err) => {
      console.error('UsdcMonitor websocket error:', err);
    });

    this.ws.addEventListener('close', () => {
      if (!this.closed) {
        console.warn('UsdcMonitor websocket closed; reconnecting in 5s');
        setTimeout(() => this.start(), 5000);
      }
    });
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      typeof msg !== 'object' ||
      msg === null ||
      (msg as { method?: string }).method !== 'accountNotification'
    ) {
      return;
    }
    await this.scanRecentTransfers();
  }

  private async scanRecentTransfers(): Promise<void> {
    let sigs;
    try {
      sigs = await this.connection.getSignaturesForAddress(this.agentAta, {
        limit: 5,
      });
    } catch (err) {
      console.error('UsdcMonitor getSignaturesForAddress failed:', err);
      return;
    }

    for (const sigInfo of sigs) {
      if (this.seen.has(sigInfo.signature)) continue;
      this.seen.add(sigInfo.signature);
      if (sigInfo.err !== null) continue;

      try {
        const parsed = await this.connection.getParsedTransaction(
          sigInfo.signature,
          { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
        );
        if (!parsed) continue;
        const inbound = this.extractInboundTransfer(sigInfo.signature, parsed);
        if (inbound) {
          await this.opts.onInboundTransfer(inbound);
        }
      } catch (err) {
        console.error('UsdcMonitor parse failed:', err);
      }
    }

    if (this.seen.size > 200) {
      const all = Array.from(this.seen);
      this.seen.clear();
      for (const s of all.slice(-100)) this.seen.add(s);
    }
  }

  private extractInboundTransfer(
    txSignature: string,
    tx: Awaited<ReturnType<Connection['getParsedTransaction']>>,
  ): InboundTransfer | null {
    if (!tx) return null;
    const instructions = tx.transaction.message.instructions as Array<
      ParsedInstruction | PartiallyDecodedInstruction
    >;

    let amountUsdc = 0;
    let senderWallet = '';
    for (const ix of instructions) {
      if (!('parsed' in ix)) continue;
      const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> };
      if (ix.program !== 'spl-token') continue;
      if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') continue;

      const info = parsed.info ?? {};
      const destination = String(info.destination ?? '');
      if (destination !== this.agentAta.toBase58()) continue;

      if (parsed.type === 'transferChecked') {
        const tokenAmount = info.tokenAmount as
          | { uiAmount?: number; amount?: string }
          | undefined;
        if (tokenAmount?.uiAmount !== undefined) {
          amountUsdc = tokenAmount.uiAmount;
        } else if (tokenAmount?.amount !== undefined) {
          amountUsdc = Number(tokenAmount.amount) / USDC_DECIMALS;
        }
      } else {
        const amt = info.amount;
        if (typeof amt === 'string') amountUsdc = Number(amt) / USDC_DECIMALS;
      }
      senderWallet = String(
        info.authority ?? info.multisigAuthority ?? info.source ?? '',
      );
    }

    if (amountUsdc <= 0) return null;

    let memo: string | null = null;
    for (const ix of instructions) {
      const programId =
        'programId' in ix ? ix.programId.toBase58() : undefined;
      if (programId === MEMO_PROGRAM_V1 || programId === MEMO_PROGRAM_V2) {
        if ('parsed' in ix && typeof ix.parsed === 'string') {
          memo = ix.parsed;
        } else if ('data' in ix && typeof ix.data === 'string') {
          try {
            memo = Buffer.from(ix.data, 'base64').toString('utf8');
          } catch {
            memo = ix.data;
          }
        }
      }
    }

    return { txSignature, senderWallet, amountUsdc, memo };
  }
}
