// TODO: Circle CCTP Solana instruction encoding requires verification
// against Circle's actual devnet program before mainnet use.
// The account derivation (PDAs, event authority, local token) follows
// Circle's published IDL but has not been tested against live devnet.
// Test via: https://developers.circle.com/stablecoins/docs/cctp-getting-started
// before enabling the BridgeManager on mainnet.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createApproveInstruction,
} from '@solana/spl-token';

const TOKEN_MESSENGER = new PublicKey('CCTPiPYPcUsz8vFCQSa2VNXsVHm2f1zVm7Q9DfM');
const MESSAGE_TRANSMITTER = new PublicKey('CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ATTESTATION_API = 'https://iris-api.circle.com/attestations';
const BASE_DOMAIN = 6;

export interface BridgeParams {
  amountUsdc: number;
  destinationAddress: string;
}

export interface BridgeResult {
  solanaTxSignature: string;
  messageHash: string;
  estimatedSettlementMs: number;
}

export class CctpBridge {
  constructor(
    private readonly params: {
      connection: Connection;
      agentKeypair: Keypair;
      baseRpcUrl?: string;
    },
  ) {}

  async bridgeSolanaToBase(params: BridgeParams): Promise<BridgeResult> {
    const connection = this.params.connection;
    const keypair = this.params.agentKeypair;
    const atomicAmount = BigInt(Math.floor(params.amountUsdc * 1_000_000));

    const mintRecipient = Buffer.alloc(32);
    const addrBytes = Buffer.from(
      params.destinationAddress.replace(/^0x/, ''),
      'hex',
    );
    addrBytes.copy(mintRecipient, 32 - addrBytes.length);

    const sourceAta = getAssociatedTokenAddressSync(
      USDC_MINT,
      keypair.publicKey,
    );

    const approveTx = new Transaction().add(
      createApproveInstruction(
        sourceAta,
        TOKEN_MESSENGER,
        keypair.publicKey,
        atomicAmount,
      ),
    );
    await sendAndConfirmTransaction(connection, approveTx, [keypair]);

    const nonce = BigInt(Date.now());
    const data = this.encodeDepositForBurn(
      atomicAmount,
      BASE_DOMAIN,
      mintRecipient,
      USDC_MINT,
      nonce,
    );

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_MESSENGER, isSigner: false, isWritable: false },
        { pubkey: MESSAGE_TRANSMITTER, isSigner: false, isWritable: true },
        { pubkey: USDC_MINT, isSigner: false, isWritable: true },
      ],
      programId: TOKEN_MESSENGER,
      data,
    });

    const burnTx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, burnTx, [keypair]);

    const messageHash = this.computeMessageHash(sig, nonce);

    console.log(
      `[CCTP] Bridge initiated: ${params.amountUsdc} USDC → Base (tx: ${sig.slice(0, 8)}...)`,
    );

    return {
      solanaTxSignature: sig,
      messageHash,
      estimatedSettlementMs: 20 * 60 * 1000,
    };
  }

  async checkAttestation(
    messageHash: string,
  ): Promise<'pending' | 'complete'> {
    try {
      const res = await fetch(`${ATTESTATION_API}/${messageHash}`);
      if (!res.ok) return 'pending';
      const data = (await res.json()) as { status?: string };
      return data.status === 'complete' ? 'complete' : 'pending';
    } catch {
      return 'pending';
    }
  }

  async mintOnBase(
    _messageBytes: string,
    _attestation: string,
  ): Promise<string> {
    const baseRpc = this.params.baseRpcUrl ?? 'https://mainnet.base.org';
    const BASE_MESSAGE_TRANSMITTER =
      '0xAD09780d193884d503182aD4588450C416D6F9D4';

    const calldata =
      '0x82b7b600' +
      Buffer.from(_messageBytes, 'hex')
        .toString('hex')
        .padEnd(64, '0') +
      Buffer.from(_attestation, 'hex')
        .toString('hex')
        .padEnd(64, '0');

    const res = await fetch(baseRpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendRawTransaction',
        params: [calldata],
      }),
    });
    const json = (await res.json()) as { result?: string; error?: unknown };
    if (json.error) {
      throw new Error(`Base mint failed: ${JSON.stringify(json.error)}`);
    }
    return json.result ?? '';
  }

  private encodeDepositForBurn(
    amount: bigint,
    destinationDomain: number,
    mintRecipient: Buffer,
    burnToken: PublicKey,
    nonce: bigint,
  ): Buffer {
    const data = Buffer.alloc(128);
    data.writeBigUInt64LE(amount, 0);
    data.writeUInt32LE(destinationDomain, 8);
    mintRecipient.copy(data, 12);
    Buffer.from(burnToken.toBytes()).copy(data, 44);
    data.writeBigUInt64LE(nonce, 76);
    return data;
  }

  private computeMessageHash(txSignature: string, nonce: bigint): string {
    const input = `${txSignature}:${nonce.toString()}`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16).padStart(16, '0');
  }
}
