import { mkdirSync } from 'node:fs';
import { PanthersDb } from './db/panthers-db.js';
import type { StorageBackend } from './db/storage-backend.js';
import { CONFIG } from './db/config-keys.js';
import { PanthersStateAdapter } from './state/adapter.js';
import { completeSale, addFundsToNft, redeemNft } from './base/deposit.js';
import { fulfillQueuedRedemptions } from './base/withdraw.js';
import { BaseUsdcMonitor, type BaseInboundTransfer } from './base/usdc-monitor.js';
import { createBaseRpcClients, getUsdcAddress } from './base/rpc.js';
import { LLMRouter } from './llm/router.js';
import { PublicCacheWriter } from './public/cache.js';
import { PublicBalanceServer } from './public/server.js';
import { AuctionTicker } from './auction/ticker.js';
import { AuctionScheduler } from './auction/scheduler.js';
import { MarketContext } from './trading/market-context.js';
import { PersonaEngine } from './persona/engine.js';
import { PersonaContextProvider } from './persona/context-provider.js';
import { WalletMonitor } from './persona/wallet-monitor.js';
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

  const baseNetwork = (db.config.get(CONFIG.BASE_NETWORK, {
    envKey: 'BASE_NETWORK',
    defaultValue: 'base-sepolia',
  }) ?? 'base-sepolia') as 'base' | 'base-sepolia';

  const publicCachePath = db.config.get(CONFIG.PUBLIC_CACHE_PATH, {
    envKey: 'PUBLIC_CACHE_PATH',
    defaultValue: '/data/public-cache.json',
  })!;

  const publicPort = Number(db.config.get(CONFIG.PUBLIC_PORT, {
    envKey: 'PUBLIC_PORT',
    defaultValue: '3000',
  }));

  const usdcAddress = getUsdcAddress(baseNetwork);

  const firstBootAt = Number(db.config.get(CONFIG.FIRST_BOOT_AT, {
    defaultValue: String(Date.now()),
  }));

  const cacheWriter = new PublicCacheWriter(publicCachePath);
  const state = await db.loadState(adapter);
  await cacheWriter.write(state).catch((err) =>
    console.error('Initial cache write failed:', err),
  );

  // EVM wallet — generated on first boot, stored in DB
  const { initializeEvmWallet } = await import('./wallet/evm-wallet.js');
  const evmWallet = initializeEvmWallet(db);

  // Base RPC clients
  const { publicClient, walletClient, chain, account } = await createBaseRpcClients(
    evmWallet.mnemonic,
    baseNetwork,
  );

  console.log(`EVM wallet: ${evmWallet.address}`);
  console.log(`Base network: ${baseNetwork}`);
  console.log(`USDC address: ${usdcAddress}`);
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
    db,
    adapter,
    port: publicPort,
    devMode,
    startedAt: Date.now(),
    nftImagesDir,
    storageBackend,
    evmWalletAddress: evmWallet.address,
  });
  publicServer.start();

  // Resolve VM domain (auto-discovers from TLS cert in TEE)
  const { resolveSecretvmDomain } = await import('@idiostasis/core');
  const agentDomain = await resolveSecretvmDomain();
  console.log(`[boot] Resolved domain: ${agentDomain}`);

  // ERC-8004 registration — fire-and-forget so it never blocks boot
  void (async () => {
    try {
      if (!agentDomain || agentDomain === 'localhost') {
        console.log(`[registry] Domain is '${agentDomain}' — skipping ERC-8004 registration`);
        return;
      }
      const { mnemonicToAccount } = await import('viem/accounts');
      const evmAccount = mnemonicToAccount(evmWallet.mnemonic);
      const { ERC8004Client, ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA } = await import('@idiostasis/erc8004-client');
      const baseRpcUrl = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org';
      const port = process.env.PORT ?? '8080';
      const wallet = { address: evmAccount.address, account: evmAccount, signTransaction: async () => '' };
      const registry = new ERC8004Client(baseRpcUrl, ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA, 'base-sepolia');
      const existingTokenId = db.config.get(CONFIG.ERC8004_TOKEN_ID);
      if (!existingTokenId) {
        const result = await Promise.race([
          registry.register({
            name: 'scrt panther test',
            description: 'Autonomous AI NFT fund on Base',
            services: [
              { name: 'discovery', endpoint: `http://${agentDomain}:3001/discover` },
              { name: 'dashboard', endpoint: `http://${agentDomain}:${port}` },
            ],
            wallet,
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 60_000)),
        ]);
        db.config.set(CONFIG.ERC8004_TOKEN_ID, result.tokenId.toString());
        console.log(`[registry] registered, token ID: ${result.tokenId}`);
      } else {
        const tokenId = Number(existingTokenId);
        await Promise.race([
          registry.updateAllEndpoints(tokenId, [
            { name: 'discovery', endpoint: `http://${agentDomain}:3001/discover` },
            { name: 'dashboard', endpoint: `http://${agentDomain}:${port}` },
          ], wallet),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
        ]);
        console.log(`[registry] endpoints updated, token ID: ${existingTokenId}`);
      }
    } catch (err) {
      console.error('[registry] ERC-8004 registration failed (non-fatal):', err);
    }
  })();

  // x402 client — used for SecretVM, market data, and other x402 services
  let x402Client: import('@idiostasis/x402-client').X402Client | null = null;
  let secretVmClient: import('@idiostasis/x402-client').SecretVmClient | null = null;
  try {
    const { X402Client, SecretVmClient } = await import('@idiostasis/x402-client');
    const x402 = new X402Client(evmWallet);
    x402Client = x402;
    const secretVmBaseUrl = db.config.get(CONFIG.SECRETVM_BASE_URL, {
      envKey: 'SECRETVM_BASE_URL',
      defaultValue: 'https://secretai.scrtlabs.com',
    })!;
    secretVmClient = new SecretVmClient(evmWallet, x402, secretVmBaseUrl);

    let balance: number;
    try {
      balance = await secretVmClient.getBalance();
    } catch (balErr: any) {
      if (String(balErr).includes('404')) {
        // Account doesn't exist yet — create it by adding funds via x402
        console.log('[secretvm] No account yet (404) — creating via add-funds...');
        try {
          await secretVmClient.addFunds(1); // $1 USDC initial deposit
          balance = await secretVmClient.getBalance();
          console.log(`[secretvm] Account created. Balance: ${balance} (${(balance / 1_000_000).toFixed(2)} USDC)`);
        } catch (topupErr) {
          console.error('[secretvm] Initial top-up failed (non-fatal):', topupErr);
          balance = 0;
        }
      } else {
        throw balErr;
      }
    }
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

  // TEE Attestation — verify this VM at boot (30s timeout)
  try {
    const vmDomain = agentDomain !== 'localhost' ? agentDomain : null;
    if (vmDomain) {
      const { checkSecretVm } = await import('secretvm-verify');
      console.log(`[attestation] Verifying ${vmDomain}...`);
      const result = await Promise.race([
        checkSecretVm(vmDomain),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('attestation timeout')), 30_000)),
      ]);
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

  // Code provenance — link running images to Git commits (30s timeout)
  try {
    const vmDomain = agentDomain !== 'localhost' ? agentDomain : null;
    if (vmDomain) {
      const { parseCompose, parseImageRef, resolveImage } = await import('code-provenance');
      console.log('[provenance] Resolving image provenance...');

      const https = await import('node:https');
      const composeYaml = await Promise.race([
        new Promise<string>((resolve, reject) => {
          https.get(`https://${vmDomain}:29343/docker-compose`, { rejectUnauthorized: false }, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => resolve(data));
            res.on('error', reject);
          }).on('error', reject);
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('provenance fetch timeout')), 30_000)),
      ]);

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
      const { generateKeyPairSync, sign: edSign } = await import('node:crypto');
      const { IdiostasisStorageBackend } = await import('./db/idiostasis-backend.js');
      const protocolDb = (backend as InstanceType<typeof IdiostasisStorageBackend>).db;
      const vaultKey = vaultKeyManager.getKey();

      const teeInstanceId = await resolveTeeInstanceId();
      const devKeyPair = generateKeyPairSync('ed25519');
      const signer = async (data: Uint8Array): Promise<Uint8Array> => {
        return new Uint8Array(edSign(null, Buffer.from(data), devKeyPair.privateKey));
      };

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
        livenessFailureThreshold: 10,
        reAttestationIntervalHours: 6,
        dbSnapshotIntervalMs: 600000,
        peerStalenessThresholdMs: 300000,
        minGuardianCount: 1,
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

      // Expose guardian/backup counts to the public dashboard
      publicServer.setProtocolDb(protocolDb as any);

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

        if (!protocolDb.getConfig('backup_rtmr3')) {
          protocolDb.setConfig('backup_rtmr3', agentRtmr3);
        }

        // Store agent's own compose so AutonomousGuardianManager can provision backups
        // Always update — inject current SECRET_AI_API_KEY so backup can boot without env_file
        try {
          const composeUrl = process.env.AGENT_COMPOSE_URL
            ?? 'https://raw.githubusercontent.com/MrGarbonzo/panthers-nft/main/docker/docker-compose.secretvm-test.yml';
          const composeRes = await fetch(composeUrl, { signal: AbortSignal.timeout(15_000) });
          if (composeRes.ok) {
            let compose = await composeRes.text();
            // Inject secrets so backup agent can boot standalone
            const aiKey = process.env.SECRET_AI_API_KEY ?? db.config.get(CONFIG.SECRET_AI_API_KEY);
            const tokenId = db.config.get(CONFIG.ERC8004_TOKEN_ID);
            const injections: string[] = [];
            if (aiKey) injections.push(`- SECRET_AI_API_KEY=${aiKey}`);
            if (tokenId) injections.push(`- ERC8004_TOKEN_ID=${tokenId}`);
            if (injections.length > 0) {
              compose = compose.replace(
                /- SECRET_AI_BASE_URL=/,
                injections.join('\n      ') + '\n      - SECRET_AI_BASE_URL=',
              );
            }
            // Backup agents boot with simple storage — they get state from primary via protocol
            compose = compose.replace(/STORAGE_BACKEND=idiostasis/, 'STORAGE_BACKEND=simple');
            protocolDb.setConfig('agent_compose', compose);
            console.log(`[protocol] Agent compose stored for backup provisioning (${compose.length} bytes)`);
          }
        } catch (err) {
          console.error('[protocol] Failed to fetch agent compose:', err);
        }

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

        // Check every 5 min — provision backup/guardian if needed
        setInterval(() => {
          void guardianManager.evaluate().catch(e => console.error('[protocol] Guardian eval failed:', e));
        }, 5 * 60 * 1000);

        // First check after 3 min (let boot settle)
        setTimeout(() => {
          console.log('[protocol] Initial guardian check');
          void guardianManager.evaluate().catch(e => console.error('[protocol] Guardian eval failed:', e));
        }, 3 * 60 * 1000);

        console.log('[protocol] Guardian auto-provisioning armed (every 5 min)');
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

  // Base RPC URL for balance polling (use public endpoint)
  const baseRpcForPolling = baseNetwork === 'base'
    ? 'https://mainnet.base.org'
    : 'https://sepolia.base.org';

  const walletMonitor = new WalletMonitor({
    evmWalletAddress: evmWallet.address,
    usdcAddress,
    rpcUrl: baseRpcForPolling,
  });
  await walletMonitor.start();

  const personaCtx = new PersonaContextProvider({
    db,
    adapter,
    walletMonitor,
    dailyBurnRate,
    firstBootAt,
    agentWallet: evmWallet.address,
  });

  publicServer.setLlmDependencies(llmRouter, personaCtx);

  // Moltbook posting loop (declared early so USDC monitor callback can reference it)
  const moltbookClient = new MoltbookClient();
  const moltbookLoop = new MoltbookPostingLoop({
    client: moltbookClient,
    llmRouter,
    personaCtx,
    db,
    adapter,
  });
  await moltbookLoop.initialize();

  // X posting loop
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

  // Base USDC monitor — watches for inbound ERC-20 transfers
  const usdcMonitor = new BaseUsdcMonitor({
    publicClient: publicClient as any,
    agentWallet: evmWallet.address as `0x${string}`,
    usdcAddress: usdcAddress as `0x${string}`,
    onInboundTransfer: async (transfer: BaseInboundTransfer) => {
      const currentState = await db.loadState(adapter);
      const memo = transfer.memo;

      // Try memo match first, then wallet match
      const memoMatch = memo !== null ? currentState.pendingSales[memo] : undefined;
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

        // Unmatched transfer — treat as donation
        const amount = transfer.amountUsdc;
        console.log(
          `Donation: ${transfer.txHash} amount=${amount} from=${transfer.senderWallet.slice(0, 8)}...`,
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

      // Handle add-funds vs new purchase
      if (match.type === 'add_funds' && match.targetTokenId) {
        try {
          const result = await addFundsToNft({
            db,
            adapter,
            saleId: match.saleId,
            targetTokenId: match.targetTokenId,
            confirmedAmountUsdc: transfer.amountUsdc,
            txHash: transfer.txHash,
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
            saleId: match.saleId,
            confirmedAmountUsdc: transfer.amountUsdc,
            txHash: transfer.txHash,
            cacheWriter,
            agentPublicUrl,
          });
          const updatedState = await db.loadState(adapter);
          const nft = updatedState.nfts[result.tokenId];
          console.log(
            `Sale completed: tokenId=${result.tokenId} nftIndex=${nft?.nftIndex ?? '?'}`,
          );
          void moltbookLoop.onEvent('nft_minted', `NFT #${nft?.nftIndex ?? '?'} minted`);
        } catch (err) {
          console.error(`Failed to complete sale ${match.saleId}:`, err);
        }
      }
    },
  });
  await usdcMonitor.start();
  console.log(`[Boot] Base USDC monitor started (${baseNetwork})`);

  // Sync WalletMonitor balance to state.liquidUsdcBalance
  setInterval(async () => {
    try {
      const bal = walletMonitor.getBalances().baseUsdcBalance;
      const current = await db.loadState(adapter);
      if (current.liquidUsdcBalance !== bal) {
        await db.saveState({ ...current, liquidUsdcBalance: bal }, adapter, cacheWriter);
      }
    } catch (err) {
      console.error('[BalanceSync] Failed:', err);
    }
  }, 5 * 60 * 1000);

  // Fulfil queued redemptions every 15 minutes
  setInterval(() => {
    void fulfillQueuedRedemptions({
      db, adapter, cacheWriter,
      onFulfilled: (req) => {
        void moltbookLoop.onEvent(
          'redemption_fulfilled',
          `NFT redeemed — ${req.netUsdc.toFixed(2)} USDC released`,
        );
      },
    });
  }, 15 * 60 * 1000);

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

  const ticker = new AuctionTicker({ db, adapter, cacheWriter });
  ticker.start();
  const scheduler = new AuctionScheduler({ db, adapter, llmRouter, cacheWriter, personaCtx });
  scheduler.start();
  console.log('Auction ticker + scheduler started');

  // x402 spending tracker — wraps fetcher to record per-service costs
  const x402SpendTracker = { mycelia: 0, genvox: 0, gloria: 0, secretvm: 0 };
  const trackX402Spend = (url: string, amountUsdc: number) => {
    if (url.includes('myceliasignal')) x402SpendTracker.mycelia += amountUsdc;
    else if (url.includes('genvox')) x402SpendTracker.genvox += amountUsdc;
    else if (url.includes('gloria') || url.includes('itsgloria')) x402SpendTracker.gloria += amountUsdc;
    else if (url.includes('secretai')) x402SpendTracker.secretvm += amountUsdc;
  };

  // Persist x402 spend to DB every 10 minutes
  setInterval(async () => {
    try {
      const s = await db.loadState(adapter);
      const pf = s.personalFund ?? {} as any;
      const totalX402 = x402SpendTracker.mycelia + x402SpendTracker.genvox + x402SpendTracker.gloria + x402SpendTracker.secretvm;
      if (totalX402 > 0) {
        await db.saveState({
          ...s,
          personalFund: {
            ...pf,
            totalInfraSpendBaseUsdc: (pf.totalInfraSpendBaseUsdc ?? 0) + totalX402,
            x402Spend: {
              myceliaUsdc: (pf.x402Spend?.myceliaUsdc ?? 0) + x402SpendTracker.mycelia,
              genvoxUsdc: (pf.x402Spend?.genvoxUsdc ?? 0) + x402SpendTracker.genvox,
              gloriaUsdc: (pf.x402Spend?.gloriaUsdc ?? 0) + x402SpendTracker.gloria,
              secretvmUsdc: (pf.x402Spend?.secretvmUsdc ?? 0) + x402SpendTracker.secretvm,
            },
            lastUpdatedAt: Date.now(),
          },
        }, adapter, cacheWriter);
        // Reset tracker after persisting
        x402SpendTracker.mycelia = 0;
        x402SpendTracker.genvox = 0;
        x402SpendTracker.gloria = 0;
        x402SpendTracker.secretvm = 0;
      }
    } catch (err) {
      console.error('[x402-spend] Failed to persist:', err);
    }
  }, 10 * 60 * 1000);

  let market: MarketContext | null = null;
  const x402Fetcher = x402Client
    ? async (url: string) => {
        const res = await x402Client!.fetchWithPayment(url);
        // Only track cost after successful payment
        let cost = 0.01; // default $0.01 (Mycelia)
        if (url.includes('genvox')) cost = 0.03;
        else if (url.includes('gloria') || url.includes('itsgloria')) cost = 0.03;
        trackX402Spend(url, cost);
        return res;
      }
    : undefined;
  if (x402Fetcher || coingeckoApiKey) {
    market = new MarketContext({
      x402Fetcher,
      coingeckoApiKey: coingeckoApiKey ?? undefined,
    });
    await market.start();
  } else {
    console.log('MarketContext skipped — no x402 client or COINGECKO_API_KEY');
  }

  // Trading loop — hourly heartbeat
  if (market) {
    const { OneInchClient } = await import('./trading/oneinch.js');
    const { TradingLoop } = await import('./trading/loop.js');
    const oneInchClient = new OneInchClient({
      baseNetwork,
      x402ApiUrl: process.env.X402_PRICE_API_URL,
    });
    const tradingLoop = new TradingLoop({
      db, adapter, llmRouter, personaCtx,
      marketCtx: market,
      oneInchClient,
      publicClient: publicClient as any,
      walletClient: walletClient as any,
      cacheWriter,
      baseNetwork,
    });

    const runTradingEval = async () => {
      try {
        // Sync wallet balance before evaluating
        const balances = walletMonitor.getBalances();
        const bal = balances.baseUsdcBalance;
        console.log(`[trading] WalletMonitor balance: ${bal} USDC (updated ${Math.round((Date.now() - balances.baseBalanceUpdatedAt) / 1000)}s ago)`);
        const currentState = await db.loadState(adapter);
        if (currentState.liquidUsdcBalance !== bal) {
          await db.saveState({ ...currentState, liquidUsdcBalance: bal }, adapter, cacheWriter);
        }
        const result = await tradingLoop.evaluate();
        console.log(`[trading] ${result.action}: ${result.reason}`);
        if (result.action !== 'skipped' && result.action !== 'nothing') {
          void moltbookLoop.onEvent('trade_executed', `Trading loop: ${result.action} — ${result.reason}`);
        }
      } catch (err) {
        console.error('[trading] Loop error:', err);
      }
    };

    // First evaluation 2 min after boot, then every 2 hours
    setTimeout(() => void runTradingEval(), 2 * 60 * 1000);
    setInterval(() => void runTradingEval(), 2 * 60 * 60 * 1000);
    console.log('[Boot] Trading loop armed (first eval in 2 min, then every 2 hours)');
  } else {
    console.log('[Boot] Trading loop skipped — no market context');
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
        let balance: number;
        try {
          balance = await svm.getBalance();
        } catch (balErr: any) {
          if (String(balErr).includes('404')) {
            // Account not created yet — create via add-funds
            console.log('[secretvm] No account (404) — creating via add-funds...');
            await svm.addFunds(1);
            balance = await svm.getBalance();
          } else {
            throw balErr;
          }
        }
        db.config.set(CONFIG.SECRETVM_BALANCE, String(balance));
        const usdcBalance = balance / 1_000_000;
        console.log(`[secretvm] Balance: ${usdcBalance.toFixed(2)} USDC`);
        if (balance < 100_000) {
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
