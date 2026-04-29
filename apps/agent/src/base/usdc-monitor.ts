import type { PublicClient } from 'viem';
import { parseAbiItem, decodeEventLog } from 'viem';

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface BaseInboundTransfer {
  txHash: `0x${string}`;
  senderWallet: `0x${string}`;
  amountUsdc: number;
  memo: string | null;
  blockNumber: bigint;
}

export interface BaseUsdcMonitorParams {
  publicClient: PublicClient;
  agentWallet: `0x${string}`;
  usdcAddress: `0x${string}`;
  onInboundTransfer: (transfer: BaseInboundTransfer) => Promise<void>;
  pollIntervalMs?: number;
}

/**
 * Monitors ERC-20 USDC Transfer events to the agent's wallet on Base.
 * Uses polling via eth_getLogs (no WebSocket needed — works over x402 HTTP).
 */
export class BaseUsdcMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastBlock: bigint = 0n;
  private readonly processedTxs = new Set<string>();
  private readonly params: BaseUsdcMonitorParams;
  private readonly pollIntervalMs: number;

  constructor(params: BaseUsdcMonitorParams) {
    this.params = params;
    this.pollIntervalMs = params.pollIntervalMs ?? 10_000; // 10s default
  }

  async start(): Promise<void> {
    // Seed with current block
    try {
      this.lastBlock = await this.params.publicClient.getBlockNumber();
      console.log(`[base-usdc] Monitor started at block ${this.lastBlock}`);
    } catch (err) {
      console.error('[base-usdc] Failed to get initial block:', err);
      this.lastBlock = 0n;
    }

    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const currentBlock = await this.params.publicClient.getBlockNumber();
      if (currentBlock <= this.lastBlock) return;

      const logs = await this.params.publicClient.getLogs({
        address: this.params.usdcAddress,
        event: TRANSFER_EVENT,
        args: {
          to: this.params.agentWallet,
        },
        fromBlock: this.lastBlock + 1n,
        toBlock: currentBlock,
      });

      for (const log of logs) {
        const txHash = log.transactionHash;
        if (!txHash || this.processedTxs.has(txHash)) continue;
        this.processedTxs.add(txHash);

        const from = (log.args as any).from as `0x${string}`;
        const value = (log.args as any).value as bigint;
        const amountUsdc = Number(value) / 1_000_000;

        // Try to extract memo from transaction input data
        let memo: string | null = null;
        try {
          const tx = await this.params.publicClient.getTransaction({ hash: txHash });
          if (tx.input && tx.input.length > 138) {
            // ERC-20 transfer has 4 bytes selector + 32 bytes to + 32 bytes amount = 68 bytes (136 hex + 0x)
            // Anything beyond that could be a memo
            const extraData = tx.input.slice(138);
            if (extraData.length > 0) {
              try {
                memo = Buffer.from(extraData, 'hex').toString('utf-8').replace(/\0/g, '').trim() || null;
              } catch {}
            }
          }
        } catch {}

        console.log(
          `[base-usdc] Inbound: ${amountUsdc} USDC from ${from.slice(0, 10)}... tx=${txHash.slice(0, 10)}... memo=${memo}`,
        );

        try {
          await this.params.onInboundTransfer({
            txHash,
            senderWallet: from,
            amountUsdc,
            memo,
            blockNumber: log.blockNumber ?? currentBlock,
          });
        } catch (err) {
          console.error(`[base-usdc] Handler failed for ${txHash}:`, err);
        }
      }

      this.lastBlock = currentBlock;

      // Prune old processed TXs (keep last 1000)
      if (this.processedTxs.size > 1000) {
        const arr = [...this.processedTxs];
        for (let i = 0; i < arr.length - 500; i++) {
          this.processedTxs.delete(arr[i]);
        }
      }
    } catch (err) {
      console.error('[base-usdc] Poll failed:', err);
    }
  }
}
