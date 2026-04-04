import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createBridgeServer } from '../src/server/create-app.js';
import { OAuthClientsStore, OAuthTokenStore } from '../src/oauth/store.js';
import type { ProviderConfig } from '../src/types.js';
import type { Express } from 'express';

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

const m2mConfig: ProviderConfig = {
  ...testConfig,
  m2m: {
    getProviderCredentials: async () => ({
      accessToken: 'm2m-access',
      refreshToken: 'm2m-refresh',
      expiresIn: 3600,
    }),
    scopes: ['read'],
  },
};

describe('Server integration tests', () => {
  let app: Express;
  let clientsStore: OAuthClientsStore;
  let tokenStore: OAuthTokenStore;

  beforeAll(() => {
    process.env.TEST_CLIENT_ID = 'provider-cid';
    process.env.TEST_CLIENT_SECRET = 'provider-csecret';
    process.env.MCP_OAUTH_ISSUER = 'https://bridge.test';
  });

  beforeEach(() => {
    clientsStore = new OAuthClientsStore();
    tokenStore = new OAuthTokenStore();
  });

  function createApp(config: ProviderConfig = testConfig) {
    const result = createBridgeServer({
      config,
      createMcpServer: () => ({ connect: async () => {} }) as any,
      stores: { clientsStore, tokenStore },
    });
    return result.app;
  }

  describe('metadata endpoints', () => {
    it('GET /.well-known/oauth-authorization-server returns metadata with CORS', async () => {
      app = createApp();
      const res = await request(app)
        .get('/.well-known/oauth-authorization-server')
        .set('Origin', 'http://example.com');

      expect(res.status).toBe(200);
      expect(res.body.issuer).toBe('https://bridge.test/'); // URL normalizes with trailing slash
      expect(res.body.authorization_endpoint).toBeDefined();
      expect(res.body.token_endpoint).toBeDefined();
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });

    it('GET /.well-known/oauth-protected-resource/mcp returns resource metadata', async () => {
      app = createApp();
      const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');

      expect(res.status).toBe(200);
      expect(res.body.resource).toBe('https://bridge.test/mcp');
      expect(res.body.authorization_servers).toContain('https://bridge.test/');
    });
  });

  describe('client registration', () => {
    it('POST /register creates a client with id and secret', async () => {
      app = createApp();
      const res = await request(app)
        .post('/register')
        .send({
          redirect_uris: ['http://localhost:3000/callback'],
        });

      expect(res.status).toBe(201);
      expect(res.body.client_id).toBeDefined();
      expect(res.body.client_secret).toBeDefined();
    });
  });

  describe('token endpoint', () => {
    it('exchanges authorization code for tokens with scope', async () => {
      app = createApp();

      // Register a client and create an auth code
      const client = clientsStore.registerClient({
        client_id: 'test-cid',
        client_secret: 'test-csecret',
        redirect_uris: ['http://localhost/cb'],
      } as any);

      const code = tokenStore.createAuthCode({
        clientId: 'test-cid',
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', // SHA256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
        redirectUri: 'http://localhost/cb',
        scopes: ['read', 'write'],
      });

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code,
          code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
          client_id: 'test-cid',
          client_secret: 'test-csecret',
        });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeDefined();
      expect(res.body.refresh_token).toBeDefined();
      expect(res.body.scope).toBe('read write');
    });

    it('exchanges refresh token for new tokens', async () => {
      app = createApp();

      clientsStore.registerClient({
        client_id: 'test-cid',
        client_secret: 'test-csecret',
        redirect_uris: ['http://localhost/cb'],
      } as any);

      const refreshToken = tokenStore.createRefreshToken('test-cid', ['read']);
      tokenStore.setUserProviderToken('test-cid', {
        providerRefreshToken: 'prt',
        providerAccessToken: 'pat',
        providerAccessTokenExpiry: 9999999999,
        identity: { userId: 'u1', email: 'u@test.com' },
      });

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: 'test-cid',
          client_secret: 'test-csecret',
        });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeDefined();
      expect(res.body.refresh_token).toBeDefined();
      expect(res.body.scope).toBe('read');
    });
  });

  describe('M2M client_credentials', () => {
    it('issues tokens when m2m is configured', async () => {
      app = createApp(m2mConfig);

      clientsStore.registerClient({
        client_id: 'm2m-cid',
        client_secret: 'm2m-csecret',
        redirect_uris: [],
      } as any);

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: 'm2m-cid',
          client_secret: 'm2m-csecret',
        });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeDefined();
      expect(res.body.refresh_token).toBeDefined();
      expect(res.body.token_type).toBe('bearer');
      expect(res.body.scope).toBe('read');

      // Verify provider tokens were stored
      const providerTokens = tokenStore.getUserProviderToken('m2m-cid');
      expect(providerTokens).toBeDefined();
      expect(providerTokens!.providerAccessToken).toBe('m2m-access');
    });

    it('rejects client_credentials when m2m is not configured', async () => {
      app = createApp(testConfig); // no m2m

      clientsStore.registerClient({
        client_id: 'cid',
        client_secret: 'csecret',
        redirect_uris: [],
      } as any);

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: 'cid',
          client_secret: 'csecret',
        });

      // SDK rejects with unsupported_grant_type
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unsupported_grant_type');
    });

    it('rejects public clients for client_credentials', async () => {
      app = createApp(m2mConfig);

      clientsStore.registerClient({
        client_id: 'public-cid',
        redirect_uris: ['http://localhost/cb'],
        token_endpoint_auth_method: 'none',
      } as any);

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: 'public-cid',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
    });
  });

  describe('protected MCP endpoint', () => {
    it('rejects requests without bearer token', async () => {
      app = createApp();
      const res = await request(app).post('/mcp').send({});
      expect(res.status).toBe(401);
    });

    it('rejects requests with invalid bearer token', async () => {
      app = createApp();
      const res = await request(app)
        .post('/mcp')
        .set('Authorization', 'Bearer invalid-token')
        .send({});
      // SDK's bearerAuth middleware wraps provider errors as 401 or 500
      expect([401, 500]).toContain(res.status);
    });
  });

  describe('provider token lifecycle', () => {
    it('refresh fails when provider tokens are evicted', async () => {
      app = createApp();

      clientsStore.registerClient({
        client_id: 'test-cid',
        client_secret: 'test-csecret',
        redirect_uris: ['http://localhost/cb'],
      } as any);

      const refreshToken = tokenStore.createRefreshToken('test-cid', ['read']);
      // Deliberately NOT setting provider tokens

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: 'test-cid',
          client_secret: 'test-csecret',
        });

      // SDK token handler wraps provider errors as 400 (OAuthError) or 500 (unexpected)
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('health endpoint', () => {
    it('returns status JSON', async () => {
      app = createApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.provider).toBe('TestProvider');
    });
  });
});

describe('buildProviderTokenRequest', () => {
  let buildProviderTokenRequest: typeof import('../src/server/create-app.js').buildProviderTokenRequest;

  beforeAll(async () => {
    const mod = await import('../src/server/create-app.js');
    buildProviderTokenRequest = mod.buildProviderTokenRequest;
  });

  it('sends form-urlencoded with body credentials by default', () => {
    const { url, init } = buildProviderTokenRequest(testConfig, {
      code: 'abc',
      redirect_uri: 'http://localhost/cb',
      grant_type: 'authorization_code',
    });

    expect(url).toBe('https://provider.test/token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe('provider-cid');
    expect(body.get('client_secret')).toBe('provider-csecret');
    expect(body.get('code')).toBe('abc');
  });

  it('sends JSON body when tokenContentType is json', () => {
    const jsonConfig: ProviderConfig = {
      ...testConfig,
      auth: { ...testConfig.auth, tokenContentType: 'json' },
    };

    const { init } = buildProviderTokenRequest(jsonConfig, {
      code: 'abc',
      grant_type: 'authorization_code',
    });

    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.client_id).toBe('provider-cid');
    expect(body.client_secret).toBe('provider-csecret');
    expect(body.code).toBe('abc');
  });

  it('sends Basic auth header when clientAuthMethod is basic', () => {
    const basicConfig: ProviderConfig = {
      ...testConfig,
      auth: { ...testConfig.auth, clientAuthMethod: 'basic' },
    };

    const { init } = buildProviderTokenRequest(basicConfig, {
      code: 'abc',
      grant_type: 'authorization_code',
    });

    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('provider-cid:provider-csecret').toString('base64')}`,
    );

    // Credentials should NOT be in the body
    const body = new URLSearchParams(init.body as string);
    expect(body.has('client_id')).toBe(false);
    expect(body.has('client_secret')).toBe(false);
  });

  it('combines JSON + Basic auth', () => {
    const comboConfig: ProviderConfig = {
      ...testConfig,
      auth: { ...testConfig.auth, tokenContentType: 'json', clientAuthMethod: 'basic' },
    };

    const { init } = buildProviderTokenRequest(comboConfig, {
      code: 'abc',
      grant_type: 'authorization_code',
    });

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toContain('Basic ');

    const body = JSON.parse(init.body as string);
    expect(body.client_id).toBeUndefined();
    expect(body.client_secret).toBeUndefined();
    expect(body.code).toBe('abc');
  });
});
