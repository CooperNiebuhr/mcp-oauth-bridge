import { describe, it, expect, beforeEach } from 'vitest';
import { OAuthClientsStore, OAuthTokenStore } from '../src/oauth/store.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

function makeClient(overrides?: Partial<OAuthClientInformationFull>): OAuthClientInformationFull {
  return {
    client_id: 'test-client',
    client_secret: 'test-secret',
    redirect_uris: ['http://localhost:3000/callback'],
    ...overrides,
  } as OAuthClientInformationFull;
}

describe('OAuthClientsStore', () => {
  let store: OAuthClientsStore;

  beforeEach(() => {
    store = new OAuthClientsStore();
  });

  it('returns undefined for unknown client', () => {
    expect(store.getClient('unknown')).toBeUndefined();
  });

  it('registers and retrieves a client', () => {
    const client = makeClient();
    store.registerClient(client);
    expect(store.getClient('test-client')).toEqual(client);
  });

  it('overwrites existing client on re-registration', () => {
    store.registerClient(makeClient({ client_secret: 'old' }));
    store.registerClient(makeClient({ client_secret: 'new' }));
    expect(store.getClient('test-client')?.client_secret).toBe('new');
  });

  it('toEntries returns all registered clients', () => {
    store.registerClient(makeClient({ client_id: 'a' }));
    store.registerClient(makeClient({ client_id: 'b' }));
    const entries = store.toEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map(([id]) => id).sort()).toEqual(['a', 'b']);
  });
});

describe('OAuthTokenStore', () => {
  let store: OAuthTokenStore;

  beforeEach(() => {
    store = new OAuthTokenStore();
  });

  describe('pending auths', () => {
    it('stores and retrieves pending auth (one-time use)', () => {
      const token = store.storePendingAuth({
        clientId: 'c1',
        redirectUri: 'http://localhost/cb',
        codeChallenge: 'challenge123',
        scopes: ['read'],
      });

      const record = store.getAndDeletePendingAuth(token);
      expect(record).toBeDefined();
      expect(record!.clientId).toBe('c1');
      expect(record!.codeChallenge).toBe('challenge123');

      // Second retrieval returns undefined (one-time use)
      expect(store.getAndDeletePendingAuth(token)).toBeUndefined();
    });

    it('returns undefined for unknown token', () => {
      expect(store.getAndDeletePendingAuth('bogus')).toBeUndefined();
    });

    it('preserves resource indicator', () => {
      const token = store.storePendingAuth({
        clientId: 'c1',
        redirectUri: 'http://localhost/cb',
        codeChallenge: 'ch',
        scopes: [],
        resource: 'https://api.example.com/mcp',
      });
      const record = store.getAndDeletePendingAuth(token);
      expect(record!.resource).toBe('https://api.example.com/mcp');
    });
  });

  describe('auth codes', () => {
    it('creates and retrieves auth code (one-time use)', () => {
      const code = store.createAuthCode({
        clientId: 'c1',
        codeChallenge: 'ch',
        redirectUri: 'http://localhost/cb',
        scopes: ['read', 'write'],
      });

      const record = store.getAndDeleteAuthCode(code);
      expect(record).toBeDefined();
      expect(record!.clientId).toBe('c1');
      expect(record!.scopes).toEqual(['read', 'write']);

      // One-time use
      expect(store.getAndDeleteAuthCode(code)).toBeUndefined();
    });

    it('getCodeChallenge returns challenge for valid code', () => {
      const code = store.createAuthCode({
        clientId: 'c1',
        codeChallenge: 'mychallenge',
        redirectUri: 'http://localhost/cb',
        scopes: [],
      });
      expect(store.getCodeChallenge(code)).toBe('mychallenge');
    });

    it('getCodeChallenge returns undefined for unknown code', () => {
      expect(store.getCodeChallenge('unknown')).toBeUndefined();
    });

    it('preserves resource indicator', () => {
      const code = store.createAuthCode({
        clientId: 'c1',
        codeChallenge: 'ch',
        redirectUri: 'http://localhost/cb',
        scopes: [],
        resource: 'https://api.example.com/mcp',
      });
      const record = store.getAndDeleteAuthCode(code);
      expect(record!.resource).toBe('https://api.example.com/mcp');
    });
  });

  describe('access tokens', () => {
    it('creates and verifies access token', () => {
      const token = store.createAccessToken('c1', ['read']);
      const info = store.verifyAccessToken(token);
      expect(info).toBeDefined();
      expect(info!.token).toBe(token);
      expect(info!.clientId).toBe('c1');
      expect(info!.scopes).toEqual(['read']);
      expect(info!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('returns undefined for unknown token', () => {
      expect(store.verifyAccessToken('unknown')).toBeUndefined();
    });

    it('includes resource in AuthInfo when provided', () => {
      const token = store.createAccessToken('c1', ['read'], 'https://api.example.com/mcp');
      const info = store.verifyAccessToken(token);
      expect(info!.resource).toBeInstanceOf(URL);
      expect(info!.resource!.href).toBe('https://api.example.com/mcp');
    });

    it('omits resource in AuthInfo when not provided', () => {
      const token = store.createAccessToken('c1', ['read']);
      const info = store.verifyAccessToken(token);
      expect(info!.resource).toBeUndefined();
    });
  });

  describe('refresh tokens', () => {
    it('creates and retrieves refresh token', () => {
      const token = store.createRefreshToken('c1', ['read']);
      const record = store.getRefreshToken(token);
      expect(record).toBeDefined();
      expect(record!.clientId).toBe('c1');
      expect(record!.scopes).toEqual(['read']);
    });

    it('deletes refresh token', () => {
      const token = store.createRefreshToken('c1', ['read']);
      store.deleteRefreshToken(token);
      expect(store.getRefreshToken(token)).toBeUndefined();
    });

    it('returns undefined for unknown token', () => {
      expect(store.getRefreshToken('unknown')).toBeUndefined();
    });
  });

  describe('revocation', () => {
    it('revokes access and refresh tokens', () => {
      const access = store.createAccessToken('c1', ['read']);
      const refresh = store.createRefreshToken('c1', ['read']);

      store.revokeToken(access);
      store.revokeToken(refresh);

      expect(store.verifyAccessToken(access)).toBeUndefined();
      expect(store.getRefreshToken(refresh)).toBeUndefined();
    });

    it('no-ops for unknown token', () => {
      // Should not throw
      store.revokeToken('unknown');
    });
  });

  describe('user provider tokens', () => {
    it('sets and gets user provider token', () => {
      store.setUserProviderToken('c1', {
        providerRefreshToken: 'prt',
        providerAccessToken: 'pat',
        providerAccessTokenExpiry: 9999999999,
        identity: { userId: 'u1', email: 'u@test.com' },
      });

      const record = store.getUserProviderToken('c1');
      expect(record).toBeDefined();
      expect(record!.providerRefreshToken).toBe('prt');
      expect(record!.identity.email).toBe('u@test.com');
    });

    it('returns undefined for unknown client', () => {
      expect(store.getUserProviderToken('unknown')).toBeUndefined();
    });

    it('updates provider access token', () => {
      store.setUserProviderToken('c1', {
        providerRefreshToken: 'prt',
        providerAccessToken: 'old',
        providerAccessTokenExpiry: 0,
        identity: { userId: 'u1', email: 'u@test.com' },
      });

      store.updateUserProviderAccessToken('c1', 'new-token', 3600);
      const record = store.getUserProviderToken('c1');
      expect(record!.providerAccessToken).toBe('new-token');
      expect(record!.providerAccessTokenExpiry).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('garbage collection', () => {
    it('sweeps expired entries', () => {
      // Create tokens that are already expired by constructing the store
      // with pre-expired data
      const now = Math.floor(Date.now() / 1000);
      const expiredStore = new OAuthTokenStore({
        pendingAuths: [['pa1', { clientId: 'c', redirectUri: 'u', codeChallenge: 'ch', scopes: [], expiresAt: now - 1 }]],
        authCodes: [['ac1', { clientId: 'c', codeChallenge: 'ch', redirectUri: 'u', scopes: [], expiresAt: now - 1 }]],
        accessTokens: [
          ['at-expired', { clientId: 'c', scopes: [], expiresAt: now - 1 }],
          ['at-valid', { clientId: 'c', scopes: [], expiresAt: now + 3600 }],
        ],
        refreshTokens: [['rt1', { clientId: 'c', scopes: [], expiresAt: now - 1 }]],
      });

      const swept = expiredStore.sweepExpired();
      expect(swept).toBe(4); // pa1, ac1, at-expired, rt1

      // Valid token should survive
      expect(expiredStore.verifyAccessToken('at-valid')).toBeDefined();
    });

    it('returns 0 when nothing to sweep', () => {
      store.createAccessToken('c1', ['read']);
      expect(store.sweepExpired()).toBe(0);
    });
  });
});
