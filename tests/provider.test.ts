import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BridgeOAuthProvider } from '../src/oauth/provider.js';
import { OAuthClientsStore, OAuthTokenStore } from '../src/oauth/store.js';
import type { ProviderConfig } from '../src/types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const testConfig: ProviderConfig = {
  name: 'TestProvider',
  auth: {
    authorizeUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    scopes: ['read', 'write'],
  },
  env: { clientId: 'TEST_CLIENT_ID', clientSecret: 'TEST_CLIENT_SECRET' },
  callbackPathSegment: 'test',
  apiBaseUrl: 'https://api.provider.test',
  fetchUserIdentity: async () => ({ userId: 'u1', email: 'u@test.com' }),
};

function makeClient(id = 'client-1'): OAuthClientInformationFull {
  return {
    client_id: id,
    client_secret: 'secret',
    redirect_uris: ['http://localhost:3000/callback'],
  } as OAuthClientInformationFull;
}

describe('BridgeOAuthProvider', () => {
  let clientsStore: OAuthClientsStore;
  let tokenStore: OAuthTokenStore;
  let provider: BridgeOAuthProvider;

  beforeEach(() => {
    clientsStore = new OAuthClientsStore();
    tokenStore = new OAuthTokenStore();
    provider = new BridgeOAuthProvider(clientsStore, tokenStore, testConfig);

    // Set env vars the provider expects
    process.env.TEST_CLIENT_ID = 'provider-client-id';
    process.env.TEST_CLIENT_SECRET = 'provider-client-secret';
  });

  describe('authorize', () => {
    it('redirects to provider with correct params', async () => {
      const client = makeClient();
      const redirect = vi.fn();
      const res = { redirect, status: vi.fn().mockReturnThis(), send: vi.fn() } as any;

      await provider.authorize(client, {
        redirectUri: 'http://localhost:3000/callback',
        codeChallenge: 'challenge123',
        state: 'state-abc',
        scopes: ['read'],
      }, res);

      expect(redirect).toHaveBeenCalledOnce();
      const [status, url] = redirect.mock.calls[0];
      expect(status).toBe(302);

      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://provider.test/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('provider-client-id');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('scope')).toBe('read write'); // space-separated default
    });

    it('uses custom scope delimiter', async () => {
      const customConfig = { ...testConfig, auth: { ...testConfig.auth, scopeDelimiter: ',' } };
      const customProvider = new BridgeOAuthProvider(clientsStore, tokenStore, customConfig);
      const redirect = vi.fn();
      const res = { redirect, status: vi.fn().mockReturnThis(), send: vi.fn() } as any;

      await customProvider.authorize(makeClient(), {
        redirectUri: 'http://localhost:3000/callback',
        codeChallenge: 'ch',
        scopes: [],
      }, res);

      const url = new URL(redirect.mock.calls[0][1]);
      expect(url.searchParams.get('scope')).toBe('read,write');
    });

    it('stores resource indicator in pending auth', async () => {
      const redirect = vi.fn();
      const res = { redirect, status: vi.fn().mockReturnThis(), send: vi.fn() } as any;

      await provider.authorize(makeClient(), {
        redirectUri: 'http://localhost:3000/callback',
        codeChallenge: 'ch',
        scopes: [],
        resource: new URL('https://api.example.com/mcp'),
      }, res);

      // Extract the state token from the redirect URL
      const url = new URL(redirect.mock.calls[0][1]);
      const stateToken = url.searchParams.get('state')!;

      // Verify the pending auth has the resource
      const pending = tokenStore.getAndDeletePendingAuth(stateToken);
      expect(pending!.resource).toBe('https://api.example.com/mcp');
    });
  });

  describe('challengeForAuthorizationCode', () => {
    it('returns stored code challenge', async () => {
      const code = tokenStore.createAuthCode({
        clientId: 'c1',
        codeChallenge: 'my-challenge',
        redirectUri: 'http://localhost/cb',
        scopes: [],
      });

      const challenge = await provider.challengeForAuthorizationCode(makeClient(), code);
      expect(challenge).toBe('my-challenge');
    });

    it('throws for unknown code', async () => {
      await expect(
        provider.challengeForAuthorizationCode(makeClient(), 'bogus'),
      ).rejects.toThrow('Authorization code not found or expired');
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('returns tokens with scope', async () => {
      const code = tokenStore.createAuthCode({
        clientId: 'client-1',
        codeChallenge: 'ch',
        redirectUri: 'http://localhost:3000/callback',
        scopes: ['read', 'write'],
      });

      const tokens = await provider.exchangeAuthorizationCode(makeClient(), code);
      expect(tokens.access_token).toBeDefined();
      expect(tokens.refresh_token).toBeDefined();
      expect(tokens.token_type).toBe('bearer');
      expect(tokens.expires_in).toBeGreaterThan(0);
      expect(tokens.scope).toBe('read write');
    });

    it('rejects mismatched client_id', async () => {
      const code = tokenStore.createAuthCode({
        clientId: 'other-client',
        codeChallenge: 'ch',
        redirectUri: 'http://localhost/cb',
        scopes: [],
      });

      await expect(
        provider.exchangeAuthorizationCode(makeClient('client-1'), code),
      ).rejects.toThrow('Authorization code was not issued to this client');
    });

    it('rejects mismatched redirect_uri', async () => {
      const code = tokenStore.createAuthCode({
        clientId: 'client-1',
        codeChallenge: 'ch',
        redirectUri: 'http://localhost:3000/callback',
        scopes: [],
      });

      await expect(
        provider.exchangeAuthorizationCode(makeClient(), code, undefined, 'http://evil.com/cb'),
      ).rejects.toThrow('redirect_uri mismatch');
    });

    it('passes resource through to access token', async () => {
      const code = tokenStore.createAuthCode({
        clientId: 'client-1',
        codeChallenge: 'ch',
        redirectUri: 'http://localhost/cb',
        scopes: ['read'],
        resource: 'https://api.example.com/mcp',
      });

      const tokens = await provider.exchangeAuthorizationCode(makeClient(), code);
      const info = tokenStore.verifyAccessToken(tokens.access_token);
      expect(info!.resource!.href).toBe('https://api.example.com/mcp');
    });

    it('rejects expired/unknown codes', async () => {
      await expect(
        provider.exchangeAuthorizationCode(makeClient(), 'bogus'),
      ).rejects.toThrow('Authorization code not found');
    });
  });

  describe('exchangeRefreshToken', () => {
    it('rotates tokens and returns scope', async () => {
      const oldRefresh = tokenStore.createRefreshToken('client-1', ['read', 'write']);
      // Provider tokens must exist for the lifecycle check
      tokenStore.setUserProviderToken('client-1', {
        providerRefreshToken: 'prt',
        providerAccessToken: 'pat',
        providerAccessTokenExpiry: 9999999999,
        identity: { userId: 'u1', email: 'u@test.com' },
      });

      const tokens = await provider.exchangeRefreshToken(makeClient(), oldRefresh);
      expect(tokens.access_token).toBeDefined();
      expect(tokens.refresh_token).toBeDefined();
      expect(tokens.scope).toBe('read write');

      // Old refresh token is deleted
      expect(tokenStore.getRefreshToken(oldRefresh)).toBeUndefined();
    });

    it('narrows scopes on refresh', async () => {
      const refresh = tokenStore.createRefreshToken('client-1', ['read', 'write']);
      tokenStore.setUserProviderToken('client-1', {
        providerRefreshToken: 'prt',
        providerAccessToken: 'pat',
        providerAccessTokenExpiry: 9999999999,
        identity: { userId: 'u1', email: 'u@test.com' },
      });

      const tokens = await provider.exchangeRefreshToken(makeClient(), refresh, ['read']);
      expect(tokens.scope).toBe('read');
    });

    it('rejects wrong client', async () => {
      const refresh = tokenStore.createRefreshToken('other-client', ['read']);
      tokenStore.setUserProviderToken('other-client', {
        providerRefreshToken: 'prt',
        providerAccessToken: 'pat',
        providerAccessTokenExpiry: 9999999999,
        identity: { userId: 'u1', email: 'u@test.com' },
      });

      await expect(
        provider.exchangeRefreshToken(makeClient('client-1'), refresh),
      ).rejects.toThrow('Refresh token was not issued to this client');
    });

    it('rejects when provider tokens are missing (lifecycle check)', async () => {
      const refresh = tokenStore.createRefreshToken('client-1', ['read']);
      // No provider tokens set — simulates revocation/eviction

      await expect(
        provider.exchangeRefreshToken(makeClient(), refresh),
      ).rejects.toThrow('Provider credentials have been revoked or expired');
    });

    it('passes resource to new access token', async () => {
      const refresh = tokenStore.createRefreshToken('client-1', ['read']);
      tokenStore.setUserProviderToken('client-1', {
        providerRefreshToken: 'prt',
        providerAccessToken: 'pat',
        providerAccessTokenExpiry: 9999999999,
        identity: { userId: 'u1', email: 'u@test.com' },
      });

      const tokens = await provider.exchangeRefreshToken(
        makeClient(), refresh, undefined, new URL('https://api.example.com/mcp'),
      );
      const info = tokenStore.verifyAccessToken(tokens.access_token);
      expect(info!.resource!.href).toBe('https://api.example.com/mcp');
    });
  });

  describe('verifyAccessToken', () => {
    it('returns AuthInfo for valid token', async () => {
      const token = tokenStore.createAccessToken('c1', ['read'], 'https://api.example.com/mcp');
      const info = await provider.verifyAccessToken(token);
      expect(info.clientId).toBe('c1');
      expect(info.scopes).toEqual(['read']);
      expect(info.resource!.href).toBe('https://api.example.com/mcp');
    });

    it('throws for unknown token', async () => {
      await expect(provider.verifyAccessToken('bogus')).rejects.toThrow('Access token not found or expired');
    });
  });

  describe('revokeToken', () => {
    it('deletes the token', async () => {
      const token = tokenStore.createAccessToken('c1', ['read']);
      await provider.revokeToken(makeClient(), { token });
      expect(tokenStore.verifyAccessToken(token)).toBeUndefined();
    });
  });
});
