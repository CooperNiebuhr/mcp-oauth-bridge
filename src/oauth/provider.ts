import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ClientsStore, TokenStore } from './interfaces.js';
import { ACCESS_TOKEN_EXPIRY_S } from './store.js';
import type { ProviderConfig } from '../types.js';

export class BridgeOAuthProvider implements OAuthServerProvider {
  private _clientsStore: ClientsStore;
  private tokenStore: TokenStore;
  private config: ProviderConfig;

  constructor(clientsStore: ClientsStore, tokenStore: TokenStore, config: ProviderConfig) {
    this._clientsStore = clientsStore;
    this.tokenStore = tokenStore;
    this.config = config;
  }

  get clientsStore(): ClientsStore {
    return this._clientsStore;
  }

  getTokenStore(): TokenStore {
    return this.tokenStore;
  }

  async authorize(_client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const providerClientId = process.env[this.config.env.clientId];
    const callbackUrl = process.env[`${this.config.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_OAUTH_CALLBACK_URL`]
      || `${process.env.MCP_OAUTH_ISSUER || 'http://localhost:3000'}/oauth/${this.config.callbackPathSegment}/callback`;

    if (!providerClientId) {
      res.status(500).send(`Server misconfigured: ${this.config.env.clientId} not set`);
      return;
    }

    // Store MCP auth params server-side; use opaque token as provider's state
    const stateToken = this.tokenStore.storePendingAuth({
      clientId: _client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
    });

    const authUrl = new URL(this.config.auth.authorizeUrl);
    authUrl.searchParams.set('scope', this.config.auth.scopes.join(this.config.auth.scopeDelimiter ?? ' '));
    authUrl.searchParams.set('client_id', providerClientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('state', stateToken);

    // Apply any extra provider-specific params (e.g. access_type=offline, prompt=consent)
    if (this.config.auth.extraAuthorizeParams) {
      for (const [key, value] of Object.entries(this.config.auth.extraAuthorizeParams)) {
        authUrl.searchParams.set(key, value);
      }
    }

    console.log(`[oauth] Redirecting to ${this.config.name} login for client ${_client.client_id}`);
    res.redirect(302, authUrl.toString());
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const challenge = this.tokenStore.getCodeChallenge(authorizationCode);
    if (!challenge) {
      throw new Error('Authorization code not found or expired');
    }
    return challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.tokenStore.getAndDeleteAuthCode(authorizationCode);
    if (!record) {
      throw new Error('Authorization code not found, expired, or already used');
    }

    if (record.clientId !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    if (redirectUri && record.redirectUri !== redirectUri) {
      throw new Error('redirect_uri mismatch');
    }

    const effectiveResource = resource?.href ?? record.resource;
    const accessToken = this.tokenStore.createAccessToken(client.client_id, record.scopes, effectiveResource);
    const refreshToken = this.tokenStore.createRefreshToken(client.client_id, record.scopes);

    console.log(`[oauth] Tokens issued for client ${client.client_id}`);

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_EXPIRY_S,
      refresh_token: refreshToken,
      scope: record.scopes.join(' '),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.tokenStore.getRefreshToken(refreshToken);
    if (!record) {
      throw new Error('Refresh token not found or expired');
    }

    if (record.clientId !== client.client_id) {
      throw new Error('Refresh token was not issued to this client');
    }

    // Verify provider credentials still exist before issuing new MCP tokens.
    // If provider tokens were revoked or evicted, the client needs to re-authorize
    // rather than silently receiving MCP tokens that will fail on first API call.
    if (!this.tokenStore.getUserProviderToken(client.client_id)) {
      throw new Error('Provider credentials have been revoked or expired. Please re-authorize.');
    }

    // Rotate: delete old refresh token, issue new pair
    this.tokenStore.deleteRefreshToken(refreshToken);

    const effectiveScopes = scopes?.length ? scopes : record.scopes;
    const newAccessToken = this.tokenStore.createAccessToken(client.client_id, effectiveScopes, resource?.href);
    const newRefreshToken = this.tokenStore.createRefreshToken(client.client_id, effectiveScopes);

    console.log(`[oauth] Tokens refreshed for client ${client.client_id}`);

    return {
      access_token: newAccessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_EXPIRY_S,
      refresh_token: newRefreshToken,
      scope: effectiveScopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const authInfo = this.tokenStore.verifyAccessToken(token);
    if (!authInfo) {
      throw new Error('Access token not found or expired');
    }
    return authInfo;
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.tokenStore.revokeToken(request.token);
  }
}
