import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { UserProviderTokenRecord } from '../types.js';
import type { ClientsStore, TokenStore } from './interfaces.js';

// --- Expiry constants ---
export const ACCESS_TOKEN_EXPIRY_S = 3600;         // 1 hour
export const REFRESH_TOKEN_EXPIRY_S = 30 * 24 * 3600; // 30 days
export const AUTH_CODE_EXPIRY_S = 300;              // 5 minutes
export const PENDING_AUTH_EXPIRY_S = 600;           // 10 minutes

// --- Record types ---
export interface AuthCodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

export interface PendingAuthRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

// --- JSON persistence shape ---
interface StoreSnapshot {
  clients: Array<[string, OAuthClientInformationFull]>;
  pendingAuths?: Array<[string, PendingAuthRecord]>;
  authCodes: Array<[string, AuthCodeRecord]>;
  accessTokens: Array<[string, AccessTokenRecord]>;
  refreshTokens: Array<[string, RefreshTokenRecord]>;
  userProviderTokens?: Array<[string, UserProviderTokenRecord]>;
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// --- File persistence helpers ---
const STORE_PATH = process.env.OAUTH_STORE_PATH || '/data/oauth-store.json';

function loadSnapshot(): StoreSnapshot | null {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = readFileSync(STORE_PATH, 'utf-8');
      return JSON.parse(raw) as StoreSnapshot;
    }
  } catch (err) {
    console.error(`[oauth] Failed to load store from ${STORE_PATH}:`, err);
  }
  return null;
}

function saveSnapshot(snapshot: StoreSnapshot): void {
  try {
    const dir = dirname(STORE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[oauth] Failed to save store to ${STORE_PATH}:`, err);
  }
}

// --- Clients Store ---
export class OAuthClientsStore implements ClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private persistFn: () => void;

  constructor(initial?: Array<[string, OAuthClientInformationFull]>, persistFn?: () => void) {
    if (initial) {
      for (const [k, v] of initial) this.clients.set(k, v);
    }
    this.persistFn = persistFn ?? (() => {});
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    this.clients.set(client.client_id, client);
    this.persistFn();
    return client;
  }

  toEntries(): Array<[string, OAuthClientInformationFull]> {
    return [...this.clients.entries()];
  }
}

// --- Token Store ---
export class OAuthTokenStore implements TokenStore {
  private pendingAuths = new Map<string, PendingAuthRecord>();
  private authCodes = new Map<string, AuthCodeRecord>();
  private accessTokens = new Map<string, AccessTokenRecord>();
  private refreshTokens = new Map<string, RefreshTokenRecord>();
  private userProviderTokens = new Map<string, UserProviderTokenRecord>();
  private persistFn: () => void;

  constructor(
    initial?: {
      pendingAuths?: Array<[string, PendingAuthRecord]>;
      authCodes?: Array<[string, AuthCodeRecord]>;
      accessTokens?: Array<[string, AccessTokenRecord]>;
      refreshTokens?: Array<[string, RefreshTokenRecord]>;
      userProviderTokens?: Array<[string, UserProviderTokenRecord]>;
    },
    persistFn?: () => void,
  ) {
    if (initial?.pendingAuths) for (const [k, v] of initial.pendingAuths) this.pendingAuths.set(k, v);
    if (initial?.authCodes) for (const [k, v] of initial.authCodes) this.authCodes.set(k, v);
    if (initial?.accessTokens) for (const [k, v] of initial.accessTokens) this.accessTokens.set(k, v);
    if (initial?.refreshTokens) for (const [k, v] of initial.refreshTokens) this.refreshTokens.set(k, v);
    if (initial?.userProviderTokens) for (const [k, v] of initial.userProviderTokens) this.userProviderTokens.set(k, v);
    this.persistFn = persistFn ?? (() => {});
  }

  // --- Pending auths (server-side state for OAuth bridge) ---
  storePendingAuth(record: Omit<PendingAuthRecord, 'expiresAt'>): string {
    const token = generateToken();
    this.pendingAuths.set(token, { ...record, expiresAt: nowSeconds() + PENDING_AUTH_EXPIRY_S });
    this.persistFn();
    return token;
  }

  getAndDeletePendingAuth(token: string): PendingAuthRecord | undefined {
    const record = this.pendingAuths.get(token);
    if (!record) return undefined;
    this.pendingAuths.delete(token);
    this.persistFn();
    if (record.expiresAt < nowSeconds()) return undefined;
    return record;
  }

  // --- Auth codes ---
  createAuthCode(record: Omit<AuthCodeRecord, 'expiresAt'>): string {
    const code = generateToken();
    this.authCodes.set(code, { ...record, expiresAt: nowSeconds() + AUTH_CODE_EXPIRY_S });
    this.persistFn();
    return code;
  }

  getAndDeleteAuthCode(code: string): AuthCodeRecord | undefined {
    const record = this.authCodes.get(code);
    if (!record) return undefined;
    this.authCodes.delete(code);
    this.persistFn();
    if (record.expiresAt < nowSeconds()) return undefined;
    return record;
  }

  getCodeChallenge(code: string): string | undefined {
    return this.authCodes.get(code)?.codeChallenge;
  }

  // --- Access tokens ---
  createAccessToken(clientId: string, scopes: string[], resource?: string): string {
    const token = generateToken();
    this.accessTokens.set(token, { clientId, scopes, resource, expiresAt: nowSeconds() + ACCESS_TOKEN_EXPIRY_S });
    this.persistFn();
    return token;
  }

  verifyAccessToken(token: string): AuthInfo | undefined {
    const record = this.accessTokens.get(token);
    if (!record) return undefined;
    if (record.expiresAt < nowSeconds()) {
      this.accessTokens.delete(token);
      this.persistFn();
      return undefined;
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      ...(record.resource ? { resource: new URL(record.resource) } : {}),
    };
  }

  // --- Refresh tokens ---
  createRefreshToken(clientId: string, scopes: string[]): string {
    const token = generateToken();
    this.refreshTokens.set(token, { clientId, scopes, expiresAt: nowSeconds() + REFRESH_TOKEN_EXPIRY_S });
    this.persistFn();
    return token;
  }

  getRefreshToken(token: string): RefreshTokenRecord | undefined {
    const record = this.refreshTokens.get(token);
    if (!record) return undefined;
    if (record.expiresAt < nowSeconds()) {
      this.refreshTokens.delete(token);
      this.persistFn();
      return undefined;
    }
    return record;
  }

  deleteRefreshToken(token: string): void {
    this.refreshTokens.delete(token);
    this.persistFn();
  }

  // --- Revocation ---
  revokeToken(token: string): void {
    this.accessTokens.delete(token);
    this.refreshTokens.delete(token);
    this.persistFn();
  }

  // --- Per-user provider tokens ---
  setUserProviderToken(mcpClientId: string, record: UserProviderTokenRecord): void {
    this.userProviderTokens.set(mcpClientId, record);
    this.persistFn();
  }

  getUserProviderToken(mcpClientId: string): UserProviderTokenRecord | undefined {
    return this.userProviderTokens.get(mcpClientId);
  }

  updateUserProviderAccessToken(mcpClientId: string, accessToken: string, expiresIn: number): void {
    const record = this.userProviderTokens.get(mcpClientId);
    if (record) {
      record.providerAccessToken = accessToken;
      record.providerAccessTokenExpiry = nowSeconds() + expiresIn;
      this.persistFn();
    }
  }

  // --- Garbage collection ---
  sweepExpired(): number {
    const now = nowSeconds();
    let swept = 0;
    const maps: Map<string, { expiresAt: number }>[] = [
      this.pendingAuths,
      this.authCodes,
      this.accessTokens,
      this.refreshTokens,
    ];
    for (const map of maps) {
      for (const [key, record] of map) {
        if (record.expiresAt < now) {
          map.delete(key);
          swept++;
        }
      }
    }
    if (swept > 0) this.persistFn();
    return swept;
  }

  // --- Serialization ---
  toSnapshot(): {
    pendingAuths: Array<[string, PendingAuthRecord]>;
    authCodes: Array<[string, AuthCodeRecord]>;
    accessTokens: Array<[string, AccessTokenRecord]>;
    refreshTokens: Array<[string, RefreshTokenRecord]>;
    userProviderTokens: Array<[string, UserProviderTokenRecord]>;
  } {
    return {
      pendingAuths: [...this.pendingAuths.entries()],
      authCodes: [...this.authCodes.entries()],
      accessTokens: [...this.accessTokens.entries()],
      refreshTokens: [...this.refreshTokens.entries()],
      userProviderTokens: [...this.userProviderTokens.entries()],
    };
  }
}

// --- Factory: creates both stores with shared persistence ---
export function createStores(): { clientsStore: OAuthClientsStore; tokenStore: OAuthTokenStore } {
  const snapshot = loadSnapshot();

  let clientsStore: OAuthClientsStore;
  let tokenStore: OAuthTokenStore;

  const persist = () => {
    const data: StoreSnapshot = {
      clients: clientsStore.toEntries(),
      ...tokenStore.toSnapshot(),
    };
    saveSnapshot(data);
  };

  clientsStore = new OAuthClientsStore(snapshot?.clients, persist);
  tokenStore = new OAuthTokenStore(
    snapshot ? {
      pendingAuths: snapshot.pendingAuths,
      authCodes: snapshot.authCodes,
      accessTokens: snapshot.accessTokens,
      refreshTokens: snapshot.refreshTokens,
      userProviderTokens: snapshot.userProviderTokens,
    } : undefined,
    persist,
  );

  if (snapshot) {
    console.log(`[oauth] Loaded store from ${STORE_PATH}`);
  }

  return { clientsStore, tokenStore };
}
