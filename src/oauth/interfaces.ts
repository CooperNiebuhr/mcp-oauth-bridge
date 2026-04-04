import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { UserProviderTokenRecord } from '../types.js';
import type { AuthCodeRecord, AccessTokenRecord, PendingAuthRecord, RefreshTokenRecord } from './store.js';

/**
 * Storage interface for registered OAuth clients.
 *
 * Extends the MCP SDK's `OAuthRegisteredClientsStore` so implementations
 * are directly usable with the SDK's registration and auth handlers.
 *
 * The default implementation (`OAuthClientsStore`) uses an in-memory Map
 * with optional JSON file persistence. Implement this interface to use
 * a custom backend (Redis, Postgres, DynamoDB, etc.).
 */
export interface ClientsStore extends OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined;
  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull;
}

/**
 * Storage interface for all OAuth token types managed by the bridge.
 *
 * The default implementation (`OAuthTokenStore`) uses in-memory Maps with
 * optional JSON file persistence. Implement this interface to use a custom
 * backend (Redis, Postgres, DynamoDB, etc.).
 *
 * Implementations are responsible for:
 * - Generating cryptographically random tokens (32+ bytes of entropy)
 * - Enforcing TTLs (access tokens: 1h, refresh: 30d, auth codes: 5m, pending auth: 10m)
 * - One-time use semantics for auth codes and pending auths (get-and-delete)
 */
export interface TokenStore {
  // --- Pending auths (server-side state for the OAuth bridge flow) ---
  storePendingAuth(record: Omit<PendingAuthRecord, 'expiresAt'>): string;
  getAndDeletePendingAuth(token: string): PendingAuthRecord | undefined;

  // --- Auth codes ---
  createAuthCode(record: Omit<AuthCodeRecord, 'expiresAt'>): string;
  getAndDeleteAuthCode(code: string): AuthCodeRecord | undefined;
  getCodeChallenge(code: string): string | undefined;

  // --- Access tokens ---
  createAccessToken(clientId: string, scopes: string[], resource?: string): string;
  verifyAccessToken(token: string): AuthInfo | undefined;

  // --- Refresh tokens ---
  createRefreshToken(clientId: string, scopes: string[]): string;
  getRefreshToken(token: string): RefreshTokenRecord | undefined;
  deleteRefreshToken(token: string): void;

  // --- Revocation ---
  revokeToken(token: string): void;

  // --- Per-user provider tokens ---
  setUserProviderToken(mcpClientId: string, record: UserProviderTokenRecord): void;
  getUserProviderToken(mcpClientId: string): UserProviderTokenRecord | undefined;
  updateUserProviderAccessToken(mcpClientId: string, accessToken: string, expiresIn: number): void;

  // --- Maintenance ---
  sweepExpired(): number;
}
