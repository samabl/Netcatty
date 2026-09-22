import { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyExternalMcpImport,
  type ExternalMcpImportAction,
} from '../../domain/mcp/externalMcpImport';
import {
  createExternalMcpServerId,
  sanitizeExternalMcpServers,
  type ExternalMcpKeyValue,
  type ExternalMcpServer,
} from '../../domain/mcp/externalMcpServer';
import { STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS } from '../../infrastructure/config/storageKeys';
import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from '../../infrastructure/persistence/localStorageAdapter';
import { decryptField, encryptField } from '../../infrastructure/persistence/secureFieldAdapter';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  fetchExternalMcpStatus,
  getExternalMcpClientBridge,
  syncExternalMcpServers,
  type ExternalMcpServerStatus,
} from '../../infrastructure/ai/mcp/externalMcpBridge';

const EMPTY_SERVERS: ExternalMcpServer[] = [];
const EMPTY_STATUSES: ExternalMcpServerStatus[] = [];

/**
 * Encrypt / decrypt the secret-bearing fields of a server config. Names are
 * not secret; `encryptField` is idempotent, so an unreadable ciphertext is
 * preserved instead of being double-wrapped.
 */
async function mapServerSecrets(
  servers: ExternalMcpServer[],
  transform: (value: string) => Promise<string | undefined>,
): Promise<ExternalMcpServer[]> {
  const mapEntries = async (entries?: ExternalMcpKeyValue[]) => {
    if (!entries?.length) return entries;
    return Promise.all(entries.map(async (entry) => ({
      name: entry.name,
      value: (await transform(entry.value)) ?? entry.value,
    })));
  };

  return Promise.all(servers.map(async (server) => {
    const next: ExternalMcpServer = { ...server };
    if (server.env?.length) next.env = await mapEntries(server.env);
    if (server.headers?.length) next.headers = await mapEntries(server.headers);
    return next;
  }));
}

export function encryptExternalMcpServers(servers: ExternalMcpServer[]): Promise<ExternalMcpServer[]> {
  return mapServerSecrets(servers, encryptField);
}

export function decryptExternalMcpServers(servers: ExternalMcpServer[]): Promise<ExternalMcpServer[]> {
  return mapServerSecrets(servers, decryptField);
}

/** Read + sanitize + decrypt the persisted server list. Never throws. */
export async function readExternalMcpServers(): Promise<ExternalMcpServer[]> {
  try {
    const raw = localStorageAdapter.read<unknown>(STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS);
    return await decryptExternalMcpServers(sanitizeExternalMcpServers(raw));
  } catch {
    return [];
  }
}

/**
 * Sanitize + encrypt + persist the server list. Sanitizing first keeps the
 * stored shape identical to what a read will parse back, and drops stray
 * fields (e.g. headers on a stdio server). Returns the payload for the main
 * process.
 */
export async function writeExternalMcpServers(
  servers: ExternalMcpServer[],
): Promise<ExternalMcpServer[]> {
  const encrypted = await encryptExternalMcpServers(sanitizeExternalMcpServers(servers));
  localStorageAdapter.write(STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS, encrypted);
  return encrypted;
}

export function createExternalMcpServerDraft(): ExternalMcpServer {
  return {
    id: createExternalMcpServerId(),
    name: '',
    enabled: true,
    transport: 'stdio',
    createdAt: Date.now(),
  };
}

export interface ExternalMcpServersState {
  servers: ExternalMcpServer[];
  statuses: ExternalMcpServerStatus[];
  isLoading: boolean;
  /** False when running outside Electron (no MCP client bridge on window). */
  isBridgeAvailable: boolean;
  addServer: (server: ExternalMcpServer) => void;
  /**
   * Apply a JSON import plan in one write: same-name entries replace the
   * existing server in place, new names are appended.
   */
  applyImport: (actions: ExternalMcpImportAction[]) => void;
  updateServer: (server: ExternalMcpServer) => void;
  removeServer: (id: string) => void;
  setServerEnabled: (id: string, enabled: boolean) => void;
  refreshStatuses: () => Promise<void>;
}

/**
 * Owns the user-configured external MCP server list.
 *
 * Storage is the shared source of truth: the settings page and the chat panel
 * each mount this hook, and cross-instance writes propagate through the
 * localStorage adapter change event rather than through React context.
 */
export function useExternalMcpServersState(options: { syncToMain?: boolean } = {}): ExternalMcpServersState {
  const { syncToMain = true } = options;
  const [servers, setServers] = useState<ExternalMcpServer[]>(EMPTY_SERVERS);
  const [statuses, setStatuses] = useState<ExternalMcpServerStatus[]>(EMPTY_STATUSES);
  const [isLoading, setIsLoading] = useState(true);
  const serversRef = useRef<ExternalMcpServer[]>(EMPTY_SERVERS);
  const lastPersistedRef = useRef<string | null>(null);

  const pushToMain = useCallback(async (payload: ExternalMcpServer[]) => {
    if (!syncToMain) return;
    const next = await syncExternalMcpServers(netcattyBridge.get(), payload);
    setStatuses(next);
  }, [syncToMain]);

  const adoptServers = useCallback((next: ExternalMcpServer[]) => {
    serversRef.current = next;
    setServers(next);
  }, []);

  /** Persist (encrypted) then push the same payload to the main process. */
  const commit = useCallback((next: ExternalMcpServer[]) => {
    adoptServers(next);
    void (async () => {
      try {
        const payload = await writeExternalMcpServers(next);
        lastPersistedRef.current = JSON.stringify(payload);
        await pushToMain(payload);
      } catch {
        // A failed write leaves storage untouched; keep the in-memory edit.
      }
    })();
  }, [adoptServers, pushToMain]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await readExternalMcpServers();
      if (cancelled) return;
      adoptServers(loaded);
      setIsLoading(false);
      lastPersistedRef.current = localStorageAdapter.readString(
        STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS,
      );
      await pushToMain(await encryptExternalMcpServers(loaded));
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptServers, pushToMain]);

  useEffect(() => {
    const handleChanged = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (key && key !== STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS) return;
      const raw = localStorageAdapter.readString(STORAGE_KEY_AI_EXTERNAL_MCP_SERVERS);
      if (raw === lastPersistedRef.current) return;
      lastPersistedRef.current = raw;
      void (async () => {
        const loaded = await readExternalMcpServers();
        adoptServers(loaded);
      })();
    };
    globalThis.addEventListener?.(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handleChanged);
    window.addEventListener?.('storage', handleChanged);
    return () => {
      globalThis.removeEventListener?.(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handleChanged);
      window.removeEventListener?.('storage', handleChanged);
    };
  }, [adoptServers]);

  const addServer = useCallback((server: ExternalMcpServer) => {
    commit([...serversRef.current, server]);
  }, [commit]);

  const applyImport = useCallback((actions: ExternalMcpImportAction[]) => {
    if (actions.length === 0) return;
    commit(applyExternalMcpImport(serversRef.current, actions));
  }, [commit]);

  const updateServer = useCallback((server: ExternalMcpServer) => {
    commit(serversRef.current.map((candidate) => (
      candidate.id === server.id ? { ...server, updatedAt: Date.now() } : candidate
    )));
  }, [commit]);

  const removeServer = useCallback((id: string) => {
    commit(serversRef.current.filter((candidate) => candidate.id !== id));
  }, [commit]);

  const setServerEnabled = useCallback((id: string, enabled: boolean) => {
    commit(serversRef.current.map((candidate) => (
      candidate.id === id ? { ...candidate, enabled, updatedAt: Date.now() } : candidate
    )));
  }, [commit]);

  /**
   * Re-push the current config, which is how a server stuck in `error` state
   * retries: the manager only reconnects when `setServers` sees a changed
   * fingerprint or a non-connected entry.
   */
  const refreshStatuses = useCallback(async () => {
    if (syncToMain) {
      await pushToMain(await encryptExternalMcpServers(serversRef.current));
      return;
    }
    setStatuses(await fetchExternalMcpStatus(netcattyBridge.get()));
  }, [pushToMain, syncToMain]);

  return {
    servers,
    statuses,
    isLoading,
    isBridgeAvailable: getExternalMcpClientBridge(netcattyBridge.get()) !== null,
    addServer,
    applyImport,
    updateServer,
    removeServer,
    setServerEnabled,
    refreshStatuses,
  };
}
