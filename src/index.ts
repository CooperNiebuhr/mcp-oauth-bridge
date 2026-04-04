// Types
export type { ProviderConfig, ProviderApiClientInterface, UserIdentity, UserProviderTokenRecord } from './types.js';
export type { ApiClientConfig, TokenResponse } from './client/types.js';
export type { CreateBridgeServerOptions } from './server/create-app.js';

// Store interfaces (implement these for custom storage backends)
export type { ClientsStore, TokenStore } from './oauth/interfaces.js';
export type {
  AuthCodeRecord, AccessTokenRecord, RefreshTokenRecord, PendingAuthRecord,
} from './oauth/store.js';

// OAuth (default in-memory implementations)
export { BridgeOAuthProvider } from './oauth/provider.js';
export { OAuthClientsStore, OAuthTokenStore, createStores } from './oauth/store.js';

// Client
export { ProviderApiClient } from './client/api-client.js';
export { getAccessToken, forceRefresh } from './client/token-manager.js';

// Server factory
export { createBridgeServer } from './server/create-app.js';

// Errors
export {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderApiError,
  ProviderNetworkError,
  formatToolError,
} from './errors.js';
