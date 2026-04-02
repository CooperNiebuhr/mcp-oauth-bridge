export interface ApiClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl: string;
  apiBaseUrl: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  error?: string;
}
