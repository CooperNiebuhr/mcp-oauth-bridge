export interface ApiClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl: string;
  apiBaseUrl: string;
  /** When true, skip token refresh — the provider token never expires. */
  tokenNeverExpires?: boolean;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  error?: string;
}
