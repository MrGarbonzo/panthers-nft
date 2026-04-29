import { Connection } from '@solana/web3.js';
import { mkdirSync } from 'node:fs';
import { PanthersDb } from './db/panthers-db.js';
import type { StorageBackend } from './db/storage-backend.js';
import { CONFIG } from './db/config-keys.js';
import { PanthersStateAdapter } from './state/adapter.js';
import { initializeSolanaWallet } from './solana/wallet.js';
import { initializeUmi } from './solana/umi-client.js';
import { UsdcMonitor, type InboundTransfer } from './solana/monitor.js';
import { NftMonitor } from './solana/nft-monitor.js';
import { completeSale, addFundsToNft } from './solana/deposit.js';
import { LLMRouter } from './llm/router.js';
import { BirdeyeClient } from './trading/birdeye.js';
import { JupiterClient } from './trading/jupiter.js';
import { TradingLoop } from './trading/loop.js';
import { PublicCacheWriter } from './public/cache.js';
import { PublicBalanceServer } from './public/server.js';
import { AuctionTicker } from './auction/ticker.js';
import { AuctionScheduler } from './auction/scheduler.js';
import { executeP2pSale } from './auction/p2p.js';
import { MarketContext } from './trading/market-context.js';
import { deriveWsUrl, isHeliusUrl } from './solana/rpc.js';
import { PersonaEngine } from './persona/engine.js';
import { WalletMonitor } from './persona/wallet-monitor.js';
import { PersonaContextProvider } from './persona/context-provider.js';
import { burnPanthersNft } from './solana/nft.js';
import { recalculateAllNavs } from './state/nav.js';
import { appendActivity, type PanthersState } from './state/schema.js';
import { XClient } from './social/x-client.js';
import { XPostingLoop } from './social/x-posting-loop.js';
import { MoltbookClient } from './moltbook/client.js';
import { MoltbookPostingLoop } from './moltbook/posting-loop.js';

const STALE_SALE_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) throw new Error('DB_PATH environment variable is required');

  const devMode = process.env.DEV_MODE === 'true';
  const storageBackend = process.env.STORAGE_BACKEND ?? 'simple';

  let backend: StorageBackend;
  let vaultKeyManager: import('@idiostasis/core').VaultKeyManager | null = null;
  if (storageBackend === 'idiostasis') {
    const { VaultKeyManager } = await import('@idiostasis/core');
    vaultKeyManager = await VaultKeyManager.load();
    const vaultKey = vaultKeyManager.getKey();
    const { IdiostasisStorageBackend } = await import('./db/idiostasis-backend.js');
    backend = new IdiostasisStorageBackend(dbPath, vaultKey);
    console.log(`Storage backend: Idiostasis (first boot: ${vaultKeyManager.isFirstBoot()})`);
  } else {
    const { SimpleStorageBackend } = await import('./db/simple-backend.js');
    backend = new SimpleStorageBackend(dbPath);
    console.log('Storage backend: Simple (local SQLite)');
  }

  const db = new PanthersDb(backend);
  const adapter = new PanthersStateAdapter();

  const solanaRpcUrl = db.config.get(CONFIG.SOLANA_RPC_URL, {
    envKey: 'SOLANA_RPC_URL',
  });

  const publicCachePath = db.config.get(CONFIG.PUBLIC_CACHE_PATH, {
    envKey: 'PUBLIC_CACHE_PATH',
    defaultValue: '/data/public-cache.json',
  })!;

  const publicPort = Number(db.config.get(CONFIG.PUBLIC_PORT, {
    envKey: 'PUBLIC_PORT',
    defaultValue: '3000',
  }));

  const usdcMint = db.config.get(CONFIG.USDC_MINT, {
    envKey: 'USDC_MINT',
    defaultValue: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  })!;

  const firstBootAt = Number(db.config.get(CONFIG.FIRST_BOOT_AT, {
    defaultValue: String(Date.now()),
  }));

  const cacheWriter = new PublicCacheWriter(publicCachePath);
  const state = await db.loadState(adapter);
  await cacheWriter.write(state).catch((err) =>
    console.error('Initial cache write failed:', err),
  );
  const keypair = initializeSolanaWallet(db);

  // EVM wallet — generated on first boot, stored in DB
  const { initializeEvmWallet } = await import('./wallet/evm-wallet.js');
  const evmWallet = initializeEvmWallet(db);

  let connection: Connection;
  let effectiveRpcUrl: string;
  let effectiveWsUrl: string | undefined;

  if (solanaRpcUrl) {
    connection = new Connection(solanaRpcUrl, 'confirmed');
    effectiveRpcUrl = solanaRpcUrl;
    console.log('Solana RPC: Helius (API key)');
  } else {
    try {
      const { createX402Connection } = await import('./solana/x402-connection.js');
      const { mnemonicToAccount: mta } = await import('viem/accounts');
      const evmPrivKeyHex = Buffer.from(mta(evmWallet.mnemonic).getHdKey().privateKey!).toString('hex');
      const solNetwork = (process.env.SOLANA_NETWORK ?? 'solana-devnet') as 'solana-devnet' | 'solana-mainnet';
      const x402Result = await createX402Connection(evmPrivKeyHex, solNetwork);
      connection = x402Result.connection;
      effectiveRpcUrl = `https://x402.quicknode.com/${solNetwork}`;
      effectiveWsUrl = x402Result.wsUrl;
      console.log(`Solana RPC: QuickNode x402 (${solNetwork})`);
    } catch (x402Err) {
      console.warn(`[x402-rpc] Failed to initialize QuickNode x402: ${x402Err}`);
      const fallbackUrl = 'https://api.devnet.solana.com';
      connection = new Connection(fallbackUrl, 'confirmed');
      effectiveRpcUrl = fallbackUrl;
      console.log('Solana RPC: public devnet (fallback)');
    }
  }

  const umi = initializeUmi(keypair, effectiveRpcUrl);

  console.log(`Solana public key: ${keypair.publicKey.toBase58()}`);
  console.log(
    `Pool totalUsdcDeposited: ${state.pool.totalUsdcDeposited}, totalUsdcCurrentValue: ${state.pool.totalUsdcCurrentValue}`,
  );
  console.log(`NFT count: ${Object.keys(state.nfts).length}`);

  const nftImagesDir = '/data/nft-images';
  try { mkdirSync(nftImagesDir, { recursive: true }); } catch {}

  // Run expired sale cleanup at startup
  {
    const bootState = await db.loadState(adapter);
    const cleaned = db.expireStalePendingSales(bootState);
    if (cleaned !== bootState) {
      const expired = Object.values(cleaned.pendingSales).filter(
        (s) => s.status === 'expired' && bootState.pendingSales[s.saleId]?.status === 'awaiting_payment',
      );
      for (const s of expired) {
        console.log(`[Boot] Expired pending sale ${s.saleId} for wallet ${s.buyerWallet.slice(0, 8)}...`);
      }
      await db.saveState(cleaned, adapter, cacheWriter);
      console.log(`[Boot] Cleaned up ${expired.length} expired pending sale(s)`);
    }
  }

  const publicServer = new PublicBalanceServer({
    cacheWriter,
    connection,
    db,
    adapter,
    port: publicPort,
    devMode,
    startedAt: Date.now(),
    nftImagesDir,
    storageBackend,
    solanaWalletAddress: keypair.publicKey.toBase58(),
    evmWalletAddress: evmWallet.address,
  });
  publicServer.start();

  // Resolve VM domain (auto-discovers from TLS cert in TEE)
  const { resolveSecretvmDomain } = await import('@idiostasis/core');
  const agentDomain = await resolveSecretvmDomain();
  console.log(`[boot] Resolved domain: ${agentDomain}`);

  // ERC-8004 registration
  try {
    if (!agentDomain || agentDomain === 'localhost') {
      console.log(`[registry] Domain is '${agentDomain}' — skipping ERC-8004 registration`);
    } else {
      const { mnemonicToAccount } = await import('viem/accounts');
      const evmAccount = mnemonicToAccount(evmWallet.mnemonic);
      const { ERC8004Client, ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA } = await import('@idiostasis/erc8004-client');
      const baseRpcUrl = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org';
      const port = process.env.PORT ?? '8080';
      const wallet = { address: evmAccount.address, account: evmAccount, signTransaction: async () => '' };
      const registry = new ERC8004Client(baseRpcUrl, ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA, 'base-sepolia');
      const existingTokenId = db.config.get(CONFIG.ERC8004_TOKEN_ID);
      if (!existingTokenId) {
        const result = await registry.register({
          name: 'Panthers Fund',
          description: 'Autonomous AI NFT fund on Solana',
          services: [
            { name: 'discovery', endpoint: `http://${agentDomain}:3001/discover` },
            { name: 'dashboard', endpoint: `http://${agentDomain}:${port}` },
          ],
          wallet,
        });
        db.config.set(CONFIG.ERC8004_TOKEN_ID, result.tokenId.toString());
        console.log(`[registry] registered, token ID: ${result.tokenId}`);
      } else {
        const tokenId = Number(existingTokenId);
        await registry.updateAllEndpoints(tokenId, [
          { name: 'discovery', endpoint: `http://${agentDomain}:3001/discover` },
          { name: 'dashboard', endpoint: `http://${agentDomain}:${port}` },
        ], wallet);
        console.log(`[registry] endpoints updated, token ID: ${existingTokenId}`);
      }
    }
  } catch (err) {
    console.error('[registry] ERC-8004 registration failed (non-fatal):', err);
  }

  // SecretVM x402 client
  let secretVmClient: import('@idiostasis/x402-client').SecretVmClient | null = null;
  try {
    const { X402Client, SecretVmClient } = await import('@idiostasis/x402-client');
    const x402 = new X402Client(evmWallet);
    const secretVmBaseUrl = db.config.get(CONFIG.SECRETVM_BASE_URL, {
      envKey: 'SECRETVM_BASE_URL',
      defaultValue: 'https://secretai.scrtlabs.com',
    })!;
    secretVmClient = new SecretVmClient(evmWallet, x402, secretVmBaseUrl);

    const balance = await secretVmClient.getBalance();
    db.config.set(CONFIG.SECRETVM_BALANCE, String(balance));
    console.log(`[secretvm] Balance: ${balance} (${(balance / 1_000_000).toFixed(2)} USDC)`);

    const vmId = db.config.get(CONFIG.SECRETVM_VM_ID, { envKey: 'SECRETVM_VM_ID' });
    if (vmId) {
      const status = await secretVmClient.getVmStatus(vmId);
      console.log(`[secretvm] VM ${vmId}: ${status.status}`);
    }
  } catch (err) {
    console.error('[secretvm] initialization failed (non-fatal):', err);
  }

  // TEE Attestation — verify this VM at boot
  try {
    const vmDomain = agentDomain !== 'localhost' ? agentDomain : null;
    if (vmDomain) {
      const { checkSecretVm } = await import('secretvm-verify');
      console.log(`[attestation] Verifying ${vmDomain}...`);
      const result = await checkSecretVm(vmDomain);
      const summary = {
        valid: result.valid,
        attestationType: result.attestationType,
        checks: result.checks,
        rtmr3: result.report?.cpu?.rt_mr3 ?? null,
        tlsFingerprint: result.report?.tls_fingerprint ?? null,
        workloadStatus: result.report?.workload?.status ?? null,
        cpuType: result.report?.cpu_type ?? null,
        errors: result.errors ?? [],
        verifiedAt: Date.now(),
      };
      db.config.set(CONFIG.ATTESTATION_RESULT, JSON.stringify(summary));
      console.log(`[attestation] Valid: ${result.valid} | Type: ${result.attestationType} | Workload: ${summary.workloadStatus}`);
    } else {
      console.log('[attestation] SECRETVM_DOMAIN not set — skipping verification');
    }
  } catch (err) {
    console.error('[attestation] Verification failed (non-fatal):', err);
  }

  // Code provenance — link running images to Git commits
  try {
    const vmDomain = agentDomain !== 'localhost' ? agentDomain : null;
    if (vmDomain) {
      const { parseCompose, parseImageRef, resolveImage } = await import('code-provenance');
      console.log('[provenance] Resolving image provenance...');

      // Fetch compose from VM's attestation endpoint (self-signed cert)
      const https = await import('node:https');
      const composeYaml = await new Promise<string>((resolve, reject) => {
        https.get(`https://${vmDomain}:29343/docker-compose`, { rejectUnauthorized: false }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => resolve(data));
          res.on('error', reject);
        }).on('error', reject);
      });

      // Strip HTML wrapping if present
      const yaml = composeYaml
        .replace(/^[\s\S]*?<pre[^>]*>/i, '')
        .replace(/<\/pre>[\s\S]*$/i, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\u200B/g, '')
        .replace(/&#\d+;/g, '')
        .trim();

      const services = parseCompose(yaml);
      const results = await Promise.all(
        services.map(([svc, img]: [string, string]) => resolveImage(svc, parseImageRef(img))),
      );

      const summary = results.map((r: any) => ({
        service: r.service,
        image: r.image,
        repo: r.repo,
        commit: r.commit,
        commitUrl: r.commit_url,
        status: r.status,
        confidence: r.confidence,
      }));
      db.config.set(CONFIG.PROVENANCE_RESULT, JSON.stringify(summary));
      for (const r of summary) {
        console.log(`[provenance] ${r.service}: ${r.status} → ${r.commitUrl || 'unresolved'}`);
      }
    }
  } catch (err) {
    console.error('[provenance] Resolution failed (non-fatal):', err);
  }

  // Idiostasis protocol server (admission, heartbeat, snapshots)
  if (storageBackend === 'idiostasis' && vaultKeyManager) {
    try {
      const {
        resolveTeeInstanceId,
        AdmissionService,
        HeartbeatManager,
        SnapshotManager,
        SecretLabsAttestationProvider,
      } = await import('@idiostasis/core');
      const { createHash, randomBytes } = await import('node:crypto');
      const { generateKeyPairSync, sign: edSign } = await import('node:crypto');
      const { IdiostasisStorageBackend } = await import('./db/idiostasis-backend.js');
      const protocolDb = (backend as InstanceType<typeof IdiostasisStorageBackend>).db;
      const vaultKey = vaultKeyManager.getKey();

      const teeInstanceId = await resolveTeeInstanceId();
      // Dev signer — production uses TEE signing service
      const devKeyPair = generateKeyPairSync('ed25519');
      const signer = async (data: Uint8Array): Promise<Uint8Array> => {
        return new Uint8Array(edSign(null, Buffer.from(data), devKeyPair.privateKey));
      };

      // Self-attest RTMR3
      let agentRtmr3 = protocolDb.getConfig('agent_rtmr3') ?? 'dev-measurement';
      try {
        const provider = new SecretLabsAttestationProvider();
        const quote = await provider.fetchQuote('172.17.0.1');
        const result = await provider.verifyQuote(quote);
        agentRtmr3 = result.rtmr3;
        console.log(`[protocol] Self-attested RTMR3: ${agentRtmr3.slice(0, 16)}...`);
      } catch {
        console.log('[protocol] Self-attestation failed, using fallback RTMR3');
      }

      const guardianRtmr3 = (process.env.GUARDIAN_APPROVED_RTMR3 ?? '')
        .split(',').map(s => s.trim()).filter(Boolean);

      const snapshotManager = new SnapshotManager(protocolDb, vaultKey, teeInstanceId);
      const attestationProvider = new SecretLabsAttestationProvider();

      const protocolConfig = {
        agentApprovedRtmr3: [agentRtmr3],
        guardianApprovedRtmr3: guardianRtmr3,
        heartbeatIntervalMs: 30000,
        livenessFailureThreshold: 6,
        reAttestationIntervalHours: 6,
        dbSnapshotIntervalMs: 600000,
        peerStalenessThresholdMs: 300000,
        minGuardianCount: 2,
        backupJitterMaxMs: 15000,
        reAttestFailureLimit: 2,
        pccsEndpoints: ['https://pccs.scrtlabs.com/dcap-tools/quote-parse'],
      };

      const admissionService = new AdmissionService(
        protocolDb,
        protocolConfig as any,
        vaultKey,
        snapshotManager,
        signer,
        attestationProvider,
      );

      const heartbeatManager = new HeartbeatManager(
        { heartbeatIntervalMs: 30000, livenessFailureThreshold: 6 } as any,
        protocolDb,
        'primary',
      );

      const { HttpServer: ProtocolHttpServer } = await import('./protocol/server.js');
      const protocolServer = new ProtocolHttpServer({
        stateAdapter: adapter as any,
        healthAdapter: { check: async () => ({ healthy: true, severity: 'ok' as const }) },
        teeInstanceId,
        role: 'primary',
        startTime: Date.now(),
        admissionService,
        heartbeatManager,
        db: protocolDb,
        agentRtmr3,
        evmAddress: evmWallet.address,
        vaultKeyManager,
        signer,
        domain: agentDomain,
        snapshotManager,
        onAdmissionComplete: () => {
          console.log('[protocol] Guardian admitted — pushing snapshot');
        },
      });

      const protocolPort = Number(process.env.PROTOCOL_PORT ?? '3001');
      await protocolServer.start(protocolPort);
      console.log(`[protocol] Protocol server listening on :${protocolPort}`);

      // Start heartbeat
      const pingTransport = async (target: string, envelope: any): Promise<boolean> => {
        const url = target.startsWith('http') ? `${target}/ping` : `http://${target}/ping`;
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope),
          });
          return res.ok;
        } catch { return false; }
      };
      heartbeatManager.start({
        transport: pingTransport,
        signer,
        teeInstanceId,
      });

      // Periodic snapshot push
      setInterval(async () => {
        try {
          const guardians = protocolDb.listGuardians('active');
          if (guardians.length === 0) return;
          const snapshot = await snapshotManager.createSnapshot(signer);
          for (const g of guardians) {
            const url = g.networkAddress.startsWith('http')
              ? `${g.networkAddress}/recovery`
              : `http://${g.networkAddress}/recovery`;
            try {
              await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ snapshot }),
              });
            } catch {}
          }
        } catch (err) {
          console.error('[protocol] Snapshot push failed:', err);
        }
      }, 5 * 60 * 1000);

      // Auto-provision guardians
      if (secretVmClient) {
        const erc8004TokenId = db.config.get(CONFIG.ERC8004_TOKEN_ID);

        // Fetch guardian compose template and inject token ID
        if (!protocolDb.getConfig('guardian_compose') && erc8004TokenId) {
          try {
            const composeUrl = process.env.GUARDIAN_COMPOSE_URL
              ?? 'https://raw.githubusercontent.com/MrGarbonzo/idiostasis-protocol/main/docker/docker-compose.secretvm-guardian.yml';
            const composeRes = await fetch(composeUrl, { signal: AbortSignal.timeout(15_000) });
            if (composeRes.ok) {
              const yaml = await composeRes.text();
              const customized = yaml.replace(/ERC8004_TOKEN_ID=\d+/, `ERC8004_TOKEN_ID=${erc8004TokenId}`);
              protocolDb.setConfig('guardian_compose', customized);
              console.log(`[protocol] Guardian compose fetched and customized with token ID ${erc8004TokenId}`);
            }
          } catch (err) {
            console.error('[protocol] Failed to fetch guardian compose:', err);
          }
        }

        // Bootstrap backup_rtmr3 so AutonomousGuardianManager.evaluate() doesn't skip
        if (!protocolDb.getConfig('backup_rtmr3')) {
          protocolDb.setConfig('backup_rtmr3', agentRtmr3);
        }

        // Build guardian VM client adapter
        const svm = secretVmClient;
        const guardianVmClient = {
          createVm: async (params: { name: string; dockerCompose: Uint8Array }) => {
            const result = await svm.createVm({
              name: params.name,
              vmTypeId: 'small',
              dockerComposeYaml: new TextDecoder().decode(params.dockerCompose),
              fsPersistence: true,
            });
            return { vmId: (result as any).id ?? (result as any).vmId, domain: (result as any).vmDomain ?? '' };
          },
          getVmStatus: async (vmId: string) => {
            const s = await svm.getVmStatus(vmId);
            return { status: s.status };
          },
          stopVm: async (vmId: string) => { await svm.stopVm(vmId); },
        };

        const { AutonomousGuardianManager } = await import('@idiostasis/guardian');
        const guardianManager = new AutonomousGuardianManager(
          protocolDb, protocolConfig as any, guardianVmClient,
        );

        // 15 min: first guardian check
        setTimeout(() => {
          console.log('[protocol] Auto-provision check: 15 min elapsed');
          void guardianManager.evaluate().catch(e => console.error('[protocol] Guardian eval failed:', e));
        }, 15 * 60 * 1000);

        // 30 min: second guardian check + start regular loop
        setTimeout(() => {
          console.log('[protocol] Auto-provision check: 30 min elapsed');
          void guardianManager.evaluate().catch(e => console.error('[protocol] Guardian eval failed:', e));
          setInterval(() => {
            void guardianManager.evaluate().catch(e => console.error('[protocol] Guardian eval failed:', e));
          }, 60_000);
        }, 30 * 60 * 1000);

        console.log('[protocol] Guardian auto-provisioning armed (15 min / 30 min)');
      }

    } catch (err) {
      console.error('[protocol] Protocol server failed to start (non-fatal):', err);
    }
  }

  if (devMode) {
    console.log('DEV_MODE=true — storage-only boot');
    console.log('Panthers agent initialized (storage-only mode)');
    return;
  }

  const secretAiKey = db.config.get(CONFIG.SECRET_AI_API_KEY, {
    envKey: 'SECRET_AI_API_KEY',
    required: true,
  })!;

  const secretAiBaseUrl = db.config.get(CONFIG.SECRET_AI_BASE_URL, {
    envKey: 'SECRET_AI_BASE_URL',
    defaultValue: 'https://secretai-rytn.scrtlabs.com:21434',
  })!;

  const coingeckoApiKey = db.config.get(CONFIG.COINGECKO_API_KEY, {
    envKey: 'COINGECKO_API_KEY',
  });

  const agentPublicUrl = db.config.get(CONFIG.AGENT_PUBLIC_URL, {
    envKey: 'AGENT_PUBLIC_URL',
  }) || '';
  if (!agentPublicUrl) {
    console.warn('[Boot] AGENT_PUBLIC_URL not set — NFT metadata URIs will be empty');
  }

  const dailyBurnRate = Number(db.config.get(CONFIG.DAILY_BURN_RATE_USDC, {
    envKey: 'DAILY_BURN_RATE_USDC',
    defaultValue: '2.0',
  }));

  const llmRouter = new LLMRouter(secretAiKey, secretAiBaseUrl, db.config);
  const personaEngine = new PersonaEngine();
  llmRouter.setPersona(personaEngine);
  console.log(`[Boot] Config loaded. SecretAI base: ${secretAiBaseUrl}`);

  const walletMonitor = new WalletMonitor({
    connection,
    agentWallet: keypair.publicKey.toBase58(),
    usdcMintSolana: usdcMint,
  });
  await walletMonitor.start();

  const personaCtx = new PersonaContextProvider({
    db,
    adapter,
    walletMonitor,
    dailyBurnRate: dailyBurnRate,
    firstBootAt,
    agentWallet: keypair.publicKey.toBase58(),
  });

  publicServer.setLlmDependencies(llmRouter, personaCtx);

  const wsUrl = effectiveWsUrl
    ?? (effectiveRpcUrl.startsWith('https://') || effectiveRpcUrl.startsWith('http://') ? deriveWsUrl(effectiveRpcUrl) : undefined);

  if (wsUrl) {
    const monitor = new UsdcMonitor({
      wsUrl,
      rpcUrl: effectiveRpcUrl,
      agentWallet: keypair.publicKey.toBase58(),
      usdcMint,
      onInboundTransfer: async (transfer: InboundTransfer) => {
        const currentState = await db.loadState(adapter);
        const memo = transfer.memo;
        const memoMatch =
          memo !== null ? currentState.pendingSales[memo] : undefined;
        const walletMatch = memoMatch ?? Object.values(currentState.pendingSales).find(
          (s) =>
            s.status === 'awaiting_payment' &&
            s.buyerWallet.toLowerCase() === transfer.senderWallet.toLowerCase() &&
            Date.now() < s.expiresAt,
        );
        const match = walletMatch;
        if (!match) {
          const alreadyPaid = Object.values(currentState.pendingSales).some(
            (s) =>
              s.status === 'paid' &&
              s.buyerWallet.toLowerCase() === transfer.senderWallet.toLowerCase(),
          );
          if (alreadyPaid) {
            console.log(
              `Already-processed transfer from ${transfer.senderWallet.slice(0, 8)}..., skipping`,
            );
            return;
          }
          const amount = transfer.amountUsdc;
          console.log(
            `Donation: ${transfer.txSignature} amount=${amount} from=${transfer.senderWallet.slice(0, 8)}...`,
          );
          const pf = currentState.personalFund ?? {
            totalFeesCollectedUsdc: 0,
            totalDonationsUsdc: 0,
            totalInfraSpendSolanaUsdc: 0,
            totalInfraSpendBaseUsdc: 0,
            lastUpdatedAt: 0,
          };
          const updated: PanthersState = {
            ...currentState,
            personalFund: {
              ...pf,
              totalDonationsUsdc: pf.totalDonationsUsdc + amount,
              lastUpdatedAt: Date.now(),
            },
          };
          await db.saveState(updated, adapter, cacheWriter);
          void xPostingLoop?.onEvent('donation_received', `${amount.toFixed(2)} USDC received`);
          void moltbookLoop.onEvent('donation_received', `${amount.toFixed(2)} USDC received`);
          return;
        }
        if (match.status !== 'awaiting_payment') {
          console.log(
            `Transfer for non-awaiting sale ${match.saleId} (status=${match.status}); ignoring`,
          );
          return;
        }
        if (Date.now() > match.expiresAt) {
          console.log(`Sale ${match.saleId} expired; ignoring transfer`);
          return;
        }

        if (match.listingId) {
          const listing = currentState.p2pListings[match.listingId];
          if (!listing) {
            console.log(`P2P listing not found: ${match.listingId}`);
            return;
          }
          try {
            const result = await executeP2pSale({
              db,
              adapter,
              umi,
              connection,
              agentKeypair: keypair,
              cacheWriter,
              listingId: match.listingId,
              buyerWallet: match.buyerWallet,
              agreedPriceUsdc: transfer.amountUsdc,
              txSignature: transfer.txSignature,
              agentPublicUrl,
              usdcMint,
            });
            console.log(`P2P sale complete: newTokenId=${result.newTokenId}`);
          } catch (err) {
            console.error(`Failed P2P sale ${match.saleId}:`, err);
          }
          return;
        }

        if (match.type === 'add_funds' && match.targetTokenId) {
          try {
            const result = await addFundsToNft({
              db,
              adapter,
              saleId: match.saleId,
              targetTokenId: match.targetTokenId,
              confirmedAmountUsdc: transfer.amountUsdc,
              txSignature: transfer.txSignature,
              cacheWriter,
            });
            console.log(
              `[AddFunds] Completed: tokenId=${result.tokenId} newNav=${result.newNav.toFixed(2)}`,
            );
          } catch (err) {
            console.error(`Failed to add funds for ${match.saleId}:`, err);
          }
        } else {
          try {
            const result = await completeSale({
              db,
              adapter,
              umi,
              rpcUrl: effectiveRpcUrl,
              saleId: match.saleId,
              confirmedAmountUsdc: transfer.amountUsdc,
              txSignature: transfer.txSignature,
              cacheWriter,
              agentPublicUrl,
            });
            const updatedState = await db.loadState(adapter);
            const nft = updatedState.nfts[result.tokenId];
            console.log(
              `Sale completed: tokenId=${result.tokenId} mintAddress=${result.mintAddress} nftIndex=${nft?.nftIndex ?? '?'}`,
            );
            void moltbookLoop.onEvent('nft_minted', `NFT #${result.tokenId} minted`);
          } catch (err) {
            console.error(`Failed to complete sale ${match.saleId}:`, err);
          }
        }
      },
    });
    monitor.start();
    console.log(`[Boot] USDC monitor started (ws: ${wsUrl.split('?')[0]}...)`);
  } else {
    console.log('[Boot] USDC monitor skipped — no WebSocket URL available');
  }

  const nftMonitor = new NftMonitor({
    rpcUrl: effectiveRpcUrl,
    agentWallet: keypair.publicKey.toBase58(),
    onInboundNft: async ({ mintAddress, fromWallet, txSignature }) => {
      const currentState = await db.loadState(adapter);
      const nft = Object.values(currentState.nfts).find(
        (n) => n.mintAddress === mintAddress,
      );
      if (!nft || nft.custodyMode !== 'self') {
        console.log(`[NftMonitor] Unmatched NFT inbound: ${mintAddress}`);
        return;
      }
      const feePct = Number(db.config.get(CONFIG.REDEEM_FEE_PCT, {
        envKey: 'REDEEM_FEE_PCT',
        defaultValue: '0.10',
      }));
      const feesUsdc = nft.currentNav * feePct;
      const withdrawnUsdc = nft.currentNav - feesUsdc;

      try {
        await burnPanthersNft({
          umi,
          mintAddress: nft.mintAddress,
          ownerWallet: keypair.publicKey.toBase58(),
        });
      } catch (err) {
        console.error(`[NftMonitor] Burn failed for ${mintAddress}:`, err);
        return;
      }

      const { [nft.tokenId]: _removed, ...remainingNfts } = currentState.nfts;
      void _removed;

      let nextState: PanthersState = {
        ...currentState,
        nfts: remainingNfts,
        pool: {
          ...currentState.pool,
          totalUsdcDeposited: currentState.pool.totalUsdcDeposited - nft.usdcDeposited,
          totalUsdcCurrentValue: currentState.pool.totalUsdcCurrentValue - nft.currentNav,
        },
        personalFund: {
          ...(currentState.personalFund ?? { totalFeesCollectedUsdc: 0, totalDonationsUsdc: 0, totalInfraSpendSolanaUsdc: 0, totalInfraSpendBaseUsdc: 0, lastUpdatedAt: 0 }),
          totalFeesCollectedUsdc: (currentState.personalFund?.totalFeesCollectedUsdc ?? 0) + feesUsdc,
          lastUpdatedAt: Date.now(),
        },
      };
      nextState = recalculateAllNavs(nextState);
      nextState = appendActivity(nextState, {
        type: 'redeem',
        wallet: fromWallet,
        nftLabel: `Panthers #${nft.nftIndex}`,
        amountUsdc: withdrawnUsdc,
        txSignature,
      });
      await db.saveState(nextState, adapter, cacheWriter);

      console.log(
        `[NftMonitor] Redemption: burned ${mintAddress}, sending ${withdrawnUsdc.toFixed(2)} USDC to ${fromWallet}`,
      );

      try {
        const { processWithdrawal: _ } = await import('./solana/withdraw.js');
        void _;
        const { PublicKey: PK } = await import('@solana/web3.js');
        const {
          createTransferInstruction: cti,
          getAssociatedTokenAddress: gata,
          getOrCreateAssociatedTokenAccount: gocata,
        } = await import('@solana/spl-token');
        const { Transaction: Tx, sendAndConfirmTransaction: sact } =
          await import('@solana/web3.js');

        const usdcPk = new PK(usdcMint);
        const sourceAta = await gata(usdcPk, keypair.publicKey);
        const destAta = await gocata(connection, keypair, usdcPk, new PK(fromWallet));
        const atomicAmount = BigInt(Math.floor(withdrawnUsdc * 1_000_000));
        const tx = new Tx().add(
          cti(sourceAta, destAta.address, keypair.publicKey, atomicAmount),
        );
        await sact(connection, tx, [keypair]);
        console.log(`[NftMonitor] Sent ${withdrawnUsdc.toFixed(2)} USDC to ${fromWallet}`);
      } catch (err) {
        console.error(`[NftMonitor] USDC transfer failed:`, err);
      }
    },
  });
  for (const nft of Object.values(state.nfts)) {
    if (nft.custodyMode === 'agent') nftMonitor.seedKnownMint(nft.mintAddress);
  }
  nftMonitor.start();

  const onBirdeyeSpend = async (amountUsdc: number) => {
    try {
      const s = await db.loadState(adapter);
      const spf = s.personalFund ?? { totalFeesCollectedUsdc: 0, totalDonationsUsdc: 0, totalInfraSpendSolanaUsdc: 0, totalInfraSpendBaseUsdc: 0, lastUpdatedAt: 0 };
      const updated: PanthersState = {
        ...s,
        personalFund: {
          ...spf,
          totalInfraSpendSolanaUsdc: spf.totalInfraSpendSolanaUsdc + amountUsdc,
          lastUpdatedAt: Date.now(),
        },
      };
      await db.saveState(updated, adapter, cacheWriter);
    } catch {}
  };

  const birdeyePaymentRpc = process.env.BIRDEYE_PAYMENT_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

  const birdeye = new BirdeyeClient({
    keypair,
    paymentRpcUrl: birdeyePaymentRpc,
    onSpend: (amount) => void onBirdeyeSpend(amount),
  });
  const jupiterSwapRpc = process.env.JUPITER_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const jupiter = new JupiterClient(connection, keypair, jupiterSwapRpc);
  const xApiKey = db.config.get(CONFIG.X_API_KEY, { envKey: 'X_API_KEY' });
  const xApiSecret = db.config.get(CONFIG.X_API_SECRET, { envKey: 'X_API_SECRET' });
  const xAccessToken = db.config.get(CONFIG.X_ACCESS_TOKEN, { envKey: 'X_ACCESS_TOKEN' });
  const xAccessTokenSecret = db.config.get(CONFIG.X_ACCESS_TOKEN_SECRET, { envKey: 'X_ACCESS_TOKEN_SECRET' });

  let xPostingLoop: XPostingLoop | null = null;
  if (xApiKey && xApiSecret && xAccessToken && xAccessTokenSecret) {
    const xClient = new XClient({
      apiKey: xApiKey,
      apiSecret: xApiSecret,
      accessToken: xAccessToken,
      accessTokenSecret: xAccessTokenSecret,
    });
    xPostingLoop = new XPostingLoop({
      xClient,
      llmRouter,
      personaCtx,
    });
    setInterval(() => void xPostingLoop!.checkDailySurvival(), 6 * 60 * 60 * 1000);
    console.log('[Boot] X posting loop initialized');
  } else {
    console.log('[Boot] X posting skipped — credentials not configured');
  }

  // Moltbook posting loop
  const moltbookClient = new MoltbookClient();
  const moltbookLoop = new MoltbookPostingLoop({
    client: moltbookClient,
    llmRouter,
    personaCtx,
    db,
    adapter,
  });
  await moltbookLoop.initialize();

  // Periodic market update posts
  setInterval(() => {
    void moltbookLoop.onEvent('market_update', 'periodic market observation');
  }, 30 * 60 * 1000);

  // Survival posts on critical/emergency
  setInterval(async () => {
    try {
      const ctx = await personaCtx.getSurvivalContext();
      if (ctx.survivalState === 'critical' || ctx.survivalState === 'emergency') {
        void moltbookLoop.onEvent('survival', `Runway: ${ctx.estimatedRunwayDays.toFixed(1)} days`);
      }
    } catch {}
  }, 6 * 60 * 60 * 1000);

  const paperTrading = db.config.get(CONFIG.PAPER_TRADING, {
    envKey: 'PAPER_TRADING',
    defaultValue: 'true',
  }) === 'true';

  const tradingLoop = new TradingLoop({
    db,
    adapter,
    birdeye,
    jupiter,
    llmRouter,
    connection,
    cacheWriter,
    personaCtx,
    paperTrading,
    onTradeExecuted: (context) => {
      void xPostingLoop?.onEvent('trade_executed', context);
      void moltbookLoop.onEvent('trade_executed', context);
    },
  });
  tradingLoop.start();
  console.log(`Trading loop started (paper trading: ${paperTrading})`);

  const ticker = new AuctionTicker({ db, adapter, cacheWriter });
  ticker.start();
  const scheduler = new AuctionScheduler({ db, adapter, llmRouter, cacheWriter, personaCtx });
  scheduler.start();
  console.log('Auction ticker + scheduler started');

  if (coingeckoApiKey) {
    const market = new MarketContext({ coingeckoApiKey });
    await market.start();
  } else {
    console.log('MarketContext skipped — missing COINGECKO_API_KEY');
  }

  setInterval(async () => {
    try {
      const current = await db.loadState(adapter);
      const next = db.expireStalePendingSales(current);
      if (next !== current) {
        const expired = Object.values(next.pendingSales).filter(
          (s) => s.status === 'expired' && current.pendingSales[s.saleId]?.status === 'awaiting_payment',
        );
        for (const s of expired) {
          console.log(`[Cleanup] Expired pending sale ${s.saleId} for wallet ${s.buyerWallet.slice(0, 8)}...`);
        }
        await db.saveState(next, adapter, cacheWriter);
      }
    } catch (err) {
      console.error('expireStalePendingSales failed:', err);
    }
  }, STALE_SALE_INTERVAL_MS);

  // SecretVM periodic balance check + auto top-up
  if (secretVmClient) {
    const svm = secretVmClient;
    setInterval(async () => {
      try {
        const balance = await svm.getBalance();
        db.config.set(CONFIG.SECRETVM_BALANCE, String(balance));
        const usdcBalance = balance / 1_000_000;
        console.log(`[secretvm] Balance: ${usdcBalance.toFixed(2)} USDC`);
        if (balance < 100_000) { // < 0.10 USDC
          console.log('[secretvm] Balance low, attempting auto top-up of 1 USDC...');
          try {
            await svm.addFunds(1);
            const newBalance = await svm.getBalance();
            db.config.set(CONFIG.SECRETVM_BALANCE, String(newBalance));
            console.log(`[secretvm] Top-up complete. New balance: ${(newBalance / 1_000_000).toFixed(2)} USDC`);
          } catch (topupErr) {
            console.error('[secretvm] Auto top-up failed:', topupErr);
          }
        }
      } catch (err) {
        console.error('[secretvm] Balance check failed:', err);
      }
    }, 30 * 60 * 1000);
  }

  // Seal vault key after all initialization
  if (vaultKeyManager) {
    try {
      await vaultKeyManager.seal();
      console.log('[vault] Vault key sealed');
    } catch (err) {
      console.error('[vault] Failed to seal vault key:', err);
    }
  }

  console.log('Panthers agent initialized');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
