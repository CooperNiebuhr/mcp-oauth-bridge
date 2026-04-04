/**
 * Configuration for a single OAuth 2.0 provider that the bridge wraps.
 * This is the only thing a consumer needs to provide — everything else
 * (OAuth 2.1 authorization server, PKCE, token store, GC) is handled by the bridge.
 */
export interface ProviderConfig {
  /** Human-readable provider name (e.g. "Zoho CRM", "HubSpot", "Salesforce"). */
  name: string;

  /** OAuth 2.0 endpoints on the upstream provider. */
  auth: {
    /** Full URL to provider's authorization endpoint. */
    authorizeUrl: string;
    /** Full URL to provider's token endpoint. */
    tokenUrl: string;
    /** Scopes to request from the provider. */
    scopes: string[];
    /** Delimiter used to join scopes in the authorize URL (default: ' ' per RFC 6749 §3.3). */
    scopeDelimiter?: string;
    /** Content type for the token exchange request (default: 'form'). Set to 'json' for providers like Notion and Linear that require JSON. */
    tokenContentType?: 'form' | 'json';
    /** How to send client credentials in the token exchange (default: 'body'). Set to 'basic' for providers that require HTTP Basic auth (e.g. Stripe). */
    clientAuthMethod?: 'body' | 'basic';
    /** Additional query params for the authorize redirect (e.g. { access_type: "offline" }). */
    extraAuthorizeParams?: Record<string, string>;
  };

  /** Environment variable NAMES for the provider's OAuth app credentials. */
  env: {
    clientId: string;      // e.g. "ZOHO_CLIENT_ID"
    clientSecret: string;  // e.g. "ZOHO_CLIENT_SECRET"
  };

  /** Path segment for the OAuth callback route (e.g. "zoho" → /oauth/zoho/callback). */
  callbackPathSegment: string;

  /** Provider's API base URL for making authenticated requests. */
  apiBaseUrl: string;

  /**
   * Fetch user identity after the provider token exchange succeeds.
   * Receives the provider's access token, returns a UserIdentity.
   * This is where each provider's user-info endpoint and response shape are handled.
   */
  fetchUserIdentity: (accessToken: string) => Promise<UserIdentity>;

  /**
   * Optional: validate whether a user is allowed to access this MCP server.
   * Return null if allowed, or an error message string if denied.
   */
  authorizeUser?: (identity: UserIdentity) => string | null;

  /**
   * Set to true for providers that issue non-expiring access tokens with no refresh token
   * (e.g. ClickUp, Notion, Linear, Todoist, Figma, Slack user tokens).
   *
   * When enabled:
   * - The callback handler accepts responses without a refresh_token
   * - The access token is stored with a far-future expiry
   * - 401 responses throw ProviderAuthError instead of attempting refresh (user must re-authorize)
   */
  tokenNeverExpires?: boolean;

  /** Token refresh endpoint if different from auth.tokenUrl. */
  refreshTokenUrl?: string;

  /** MCP server name and version for the McpServer constructor. */
  mcpServer?: { name: string; version: string };

  /**
   * Machine-to-machine configuration. When provided, enables the client_credentials
   * grant type for non-interactive MCP clients (CI pipelines, headless agents, etc.).
   *
   * The MCP SDK's token handler does not support client_credentials server-side,
   * so the bridge installs a thin middleware that intercepts this grant type before
   * the SDK handler runs. All other grant types pass through unchanged.
   */
  m2m?: {
    /** Returns provider credentials for machine-to-machine access. */
    getProviderCredentials: () => Promise<{
      accessToken: string;
      refreshToken: string;
      expiresIn?: number;
    }>;
    /** Scopes to grant M2M clients (defaults to config.auth.scopes). */
    scopes?: string[];
  };
}

/** User identity returned by the provider after OAuth login. */
export interface UserIdentity {
  userId: string;
  email: string;
  /** Arbitrary extra fields (orgId, displayName, tenantId, etc.). */
  [key: string]: unknown;
}

/** Interface for the provider API client — implemented by ProviderApiClient. */
export interface ProviderApiClientInterface {
  request<T>(endpoint: string, params?: Record<string, string>): Promise<T>;
  update<T>(endpoint: string, body: Record<string, unknown>): Promise<T>;
  create<T>(endpoint: string, body: Record<string, unknown>): Promise<T>;
  remove<T>(endpoint: string, params?: Record<string, string>): Promise<T>;
}

/** Per-user provider credentials stored after successful OAuth callback. */
export interface UserProviderTokenRecord {
  providerRefreshToken: string | null;
  providerAccessToken: string | null;
  providerAccessTokenExpiry: number; // seconds since epoch
  identity: UserIdentity;
}
