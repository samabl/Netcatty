import test from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS } from '../../infrastructure/config/storageKeys.ts';
import {
  decryptExternalMcpServers,
  encryptExternalMcpServers,
  readExternalMcpServers,
  writeExternalMcpServers,
} from './useExternalMcpServersState.ts';
import type { ExternalMcpServer } from '../../domain/mcp/externalMcpServer.ts';

const ENC_PREFIX = 'enc:v1:';

function createStorage(): Storage {
  const backing = new Map<string, string>();
  return {
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(key: string) {
      return backing.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null;
    },
    removeItem(key: string) {
      backing.delete(key);
    },
    setItem(key: string, value: string) {
      backing.set(key, value);
    },
  };
}

const encode = (value: string) => ENC_PREFIX + Buffer.from(value, 'utf8').toString('base64');
const decode = (value: string) => Buffer.from(value.slice(ENC_PREFIX.length), 'base64').toString('utf8');

function installEnv() {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = createStorage();
  const netcatty = {
    credentialsEncrypt: async (value: string) => encode(value),
    credentialsDecrypt: async (value: string) => decode(value),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: { netcatty }, configurable: true });
  return {
    storage,
    restore() {
      if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
      else Reflect.deleteProperty(globalThis, 'localStorage');
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

function server(overrides: Partial<ExternalMcpServer> = {}): ExternalMcpServer {
  return {
    id: 's1',
    name: 'Files',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    ...overrides,
  };
}

test('writeExternalMcpServers persists ciphertext and returns the sync payload', async (t) => {
  const env = installEnv();
  t.after(() => env.restore());

  const payload = await writeExternalMcpServers([
    server({
      env: [{ name: 'TOKEN', value: 'super-secret' }],
      headers: [{ name: 'Ignored', value: 'nope' }],
    }),
  ]);

  const raw = env.storage.getItem(STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS) ?? '';
  assert.ok(raw.length > 0);
  assert.doesNotMatch(raw, /super-secret/);
  assert.equal(payload[0].env?.[0].value, encode('super-secret'));
  // stdio servers keep env only; the stray headers field is dropped on sanitize.
  assert.equal(payload[0].headers, undefined);
});

test('readExternalMcpServers decrypts persisted secrets', async (t) => {
  const env = installEnv();
  t.after(() => env.restore());

  await writeExternalMcpServers([server({ env: [{ name: 'TOKEN', value: 'shh' }] })]);
  const loaded = await readExternalMcpServers();

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'Files');
  assert.deepEqual(loaded[0].env, [{ name: 'TOKEN', value: 'shh' }]);
});

test('readExternalMcpServers tolerates missing and corrupt storage', async (t) => {
  const env = installEnv();
  t.after(() => env.restore());

  assert.deepEqual(await readExternalMcpServers(), []);

  env.storage.setItem(STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS, '{not json');
  assert.deepEqual(await readExternalMcpServers(), []);

  env.storage.setItem(STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS, JSON.stringify([{ name: '' }, 5]));
  assert.deepEqual(await readExternalMcpServers(), []);
});

test('encrypt/decrypt round-trip leaves plaintext untouched without a bridge', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'window');
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  });

  const servers = await encryptExternalMcpServers([server({ env: [{ name: 'A', value: 'plain' }] })]);
  assert.equal(servers[0].env?.[0].value, 'plain');
  const back = await decryptExternalMcpServers(servers);
  assert.equal(back[0].env?.[0].value, 'plain');
});
