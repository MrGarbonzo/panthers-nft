import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { ConfigStore } from './config-store.js';
import type { StorageBackend } from './storage-backend.js';
import { deriveWsUrl, isHeliusUrl } from '../solana/rpc.js';

function createMemoryBackend(): StorageBackend {
  const store = new Map<string, string>();
  return {
    getConfig(key: string): string | null {
      return store.get(key) ?? null;
    },
    setConfig(key: string, value: string): void {
      store.set(key, value);
    },
    getAgentState() {
      return null;
    },
    setAgentState() {},
  };
}

// Test 1 — First boot seeds from env
{
  const backend = createMemoryBackend();
  const config = new ConfigStore(backend);
  process.env.TEST_KEY_CS = 'abc123';
  const value = config.get('test_key_cs', { envKey: 'TEST_KEY_CS' });
  assert.equal(value, 'abc123');
  assert.equal(backend.getConfig('test_key_cs'), 'abc123');
  delete process.env.TEST_KEY_CS;
  console.log('Test 1 OK — First boot seeds from env');
}

// Test 2 — DB wins over env on second boot
{
  const backend = createMemoryBackend();
  const config = new ConfigStore(backend);
  backend.setConfig('test_key2', 'from_db');
  process.env.TEST_KEY2 = 'from_env';
  const value = config.get('test_key2', { envKey: 'TEST_KEY2' });
  assert.equal(value, 'from_db');
  delete process.env.TEST_KEY2;
  console.log('Test 2 OK — DB wins over env');
}

// Test 3 — Default value seeded to DB
{
  const backend = createMemoryBackend();
  const config = new ConfigStore(backend);
  const value = config.get('missing_key', { defaultValue: 'my_default' });
  assert.equal(value, 'my_default');
  assert.equal(backend.getConfig('missing_key'), 'my_default');
  console.log('Test 3 OK — Default seeded to DB');
}

// Test 4 — Required throws
{
  const backend = createMemoryBackend();
  const config = new ConfigStore(backend);
  assert.throws(
    () => config.get('missing_required', { required: true }),
    (err: Error) => err.message.includes('missing_required'),
  );
  console.log('Test 4 OK — Required throws');
}

// Test 5 — JSON round-trip
{
  const backend = createMemoryBackend();
  const config = new ConfigStore(backend);
  const obj = { chat: 'gemma3:4b', trade: 'llama3.3:70b' };
  config.setJson('test_json', obj);
  const result = config.getJson<typeof obj>('test_json', { chat: '', trade: '' });
  assert.equal(result.chat, 'gemma3:4b');
  assert.equal(result.trade, 'llama3.3:70b');
  console.log('Test 5 OK — JSON round-trip');
}

// Test 6 — deriveWsUrl
{
  assert.equal(
    deriveWsUrl('https://mainnet.helius-rpc.com/?api-key=abc'),
    'wss://mainnet.helius-rpc.com/?api-key=abc',
  );
  assert.equal(
    deriveWsUrl('https://api.devnet.solana.com'),
    'wss://api.devnet.solana.com',
  );
  assert.equal(
    deriveWsUrl('http://localhost:8899'),
    'ws://localhost:8899',
  );
  console.log('Test 6 OK — deriveWsUrl');
}

// Test 7 — isHeliusUrl
{
  assert.equal(isHeliusUrl('https://mainnet.helius-rpc.com/?api-key=abc'), true);
  assert.equal(isHeliusUrl('https://rpc.helius.dev/?api-key=abc'), true);
  assert.equal(isHeliusUrl('https://api.mainnet-beta.solana.com'), false);
  assert.equal(isHeliusUrl('https://api.devnet.solana.com'), false);
  console.log('Test 7 OK — isHeliusUrl');
}

console.log('All ConfigStore tests passed');
