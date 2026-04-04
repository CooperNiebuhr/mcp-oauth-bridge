import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { authorizationHandler, redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Anything with a connect() method — satisfied by both McpServer and Server. */
interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
}
// @ts-expect-error — cors is a transitive dep of the MCP SDK, no types needed
import cors from 'cors';

import { BridgeOAuthProvider } from '../oauth/provider.js';
import { createStores, ACCESS_TOKEN_EXPIRY_S } from '../oauth/store.js';
import type { ClientsStore, TokenStore } from '../oauth/interfaces.js';
import { ProviderApiClient } from '../client/api-client.js';
import type { ProviderConfig, ProviderApiClientInterface, UserIdentity } from '../types.js';
import type { TokenResponse } from '../client/types.js';

export interface CreateBridgeServerOptions {
  config: ProviderConfig;
  /** Factory that receives a ProviderApiClient and returns an McpServer with tools registered. */
  createMcpServer: (client: ProviderApiClientInterface) => ConnectableServer;
  /** Custom store implementations. Defaults to in-memory with JSON file persistence. */
  stores?: { clientsStore: ClientsStore; tokenStore: TokenStore };
  /** Express trust proxy setting (e.g. 1 for Railway). */
  trustProxy?: number | boolean;
  /** Host to bind to (default '0.0.0.0'). */
  host?: string;
}

const TEN_YEARS_S = 10 * 365 * 24 * 3600;

/** Build the fetch request for exchanging an auth code with the upstream provider. */
export function buildProviderTokenRequest(
  config: ProviderConfig,
  params: Record<string, string>,
): { url: string; init: RequestInit } {
  const clientId = process.env[config.env.clientId]!;
  const clientSecret = process.env[config.env.clientSecret]!;
  const useBasic = config.auth.clientAuthMethod === 'basic';
  const useJson = config.auth.tokenContentType === 'json';

  const headers: Record<string, string> = {};

  if (useBasic) {
    headers['Authorization'] = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }

  let body: string;
  if (useJson) {
    headers['Content-Type'] = 'application/json';
    const bodyObj: Record<string, string> = { ...params };
    if (!useBasic) {
      bodyObj.client_id = clientId;
      bodyObj.client_secret = clientSecret;
    }
    body = JSON.stringify(bodyObj);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const bodyParams = new URLSearchParams(params);
    if (!useBasic) {
      bodyParams.set('client_id', clientId);
      bodyParams.set('client_secret', clientSecret);
    }
    body = bodyParams.toString();
  }

  return { url: config.auth.tokenUrl, init: { method: 'POST', headers, body } };
}

export function createBridgeServer(options: CreateBridgeServerOptions) {
  const { config, createMcpServer, trustProxy, host = '0.0.0.0' } = options;

  // --- OAuth 2.1 setup ---
  const issuerUrl = new URL(process.env.MCP_OAUTH_ISSUER || 'http://localhost:3000');
  const { clientsStore, tokenStore } = options.stores ?? createStores();
  const oauthProvider = new BridgeOAuthProvider(clientsStore, tokenStore, config);

  const oauthMetadata = createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl,
  });

  const app = createMcpExpressApp({ host });
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }

  // --- OAuth routes ---

  // Metadata discovery
  app.get('/.well-known/oauth-authorization-server', cors(), (_req, res) => {
    res.json(oauthMetadata);
  });

  // Protected resource metadata
  app.get('/.well-known/oauth-protected-resource/mcp', cors(), (_req, res) => {
    res.json({
      resource: new URL('/mcp', issuerUrl).href,
      authorization_servers: [issuerUrl.href],
    });
  });

  // Dynamic client registration
  app.use('/register', clientRegistrationHandler({
    clientsStore: oauthProvider.clientsStore,
  }));

  // Authorization endpoint (redirects to provider login)
  app.use('/authorize', authorizationHandler({
    provider: oauthProvider,
  }));

  // --- M2M client_credentials handler ---
  // The MCP SDK's tokenHandler does not support client_credentials server-side
  // (it explicitly throws UnsupportedGrantTypeError). This middleware intercepts
  // client_credentials requests when config.m2m is provided, handling machine-to-machine
  // auth before the SDK handler runs. All other grant types pass through unchanged.
  if (config.m2m) {
    const m2mConfig = config.m2m;
    app.post('/token',
      cors(),
      express.urlencoded({ extended: false }),
      async (req, res, next) => {
        if (req.body?.grant_type !== 'client_credentials') {
          next();
          return;
        }

        try {
          const { client_id, client_secret } = req.body;
          if (!client_id) {
            res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
            return;
          }

          const client = clientsStore.getClient(client_id);
          if (!client) {
            res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
            return;
          }

          // client_credentials requires a confidential client (must have a secret)
          if (!client.client_secret) {
            res.status(400).json({ error: 'invalid_client', error_description: 'Public clients cannot use client_credentials' });
            return;
          }
          if (!client_secret || client.client_secret !== client_secret) {
            res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client_secret' });
            return;
          }
          if (client.client_secret_expires_at && client.client_secret_expires_at < Math.floor(Date.now() / 1000)) {
            res.status(401).json({ error: 'invalid_client', error_description: 'Client secret has expired' });
            return;
          }

          // Obtain provider credentials for M2M access
          const providerCreds = await m2mConfig.getProviderCredentials();
          const m2mScopes = m2mConfig.scopes ?? config.auth.scopes;

          // Store provider tokens so the /mcp endpoint can use them
          tokenStore.setUserProviderToken(client_id, {
            providerRefreshToken: providerCreds.refreshToken,
            providerAccessToken: providerCreds.accessToken,
            providerAccessTokenExpiry: Math.floor(Date.now() / 1000) + (providerCreds.expiresIn ?? 3600),
            identity: { userId: `m2m:${client_id}`, email: `m2m@${config.name.toLowerCase()}` },
          });

          // Issue MCP tokens
          const accessToken = tokenStore.createAccessToken(client_id, m2mScopes);
          const refreshToken = tokenStore.createRefreshToken(client_id, m2mScopes);

          console.log(`[oauth] M2M tokens issued for client ${client_id}`);

          res.setHeader('Cache-Control', 'no-store');
          res.status(200).json({
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: ACCESS_TOKEN_EXPIRY_S,
            refresh_token: refreshToken,
            scope: m2mScopes.join(' '),
          });
        } catch (err) {
          console.error('[oauth] M2M token exchange failed:', err);
          res.status(500).json({ error: 'server_error', error_description: 'Failed to issue M2M credentials' });
        }
      },
    );
  }

  // Token endpoint (handles authorization_code + refresh_token via SDK)
  app.use('/token', tokenHandler({
    provider: oauthProvider,
  }));

  // Token revocation
  app.use('/revoke', revocationHandler({
    provider: oauthProvider,
  }));

  // --- Provider OAuth callback ---
  const callbackPath = `/oauth/${config.callbackPathSegment}/callback`;
  app.get(callbackPath, async (req, res) => {
    try {
      const { code, state, error } = req.query as Record<string, string>;

      if (error) {
        res.status(400).send(`${config.name} login failed: ${error}`);
        return;
      }

      if (!code || !state) {
        res.status(400).send('Missing code or state parameter');
        return;
      }

      // Look up MCP auth params stored server-side
      const pending = tokenStore.getAndDeletePendingAuth(state);
      if (!pending) {
        res.status(400).send('Invalid or expired authorization state');
        return;
      }

      // Validate redirect URI against registered client
      const registeredClient = clientsStore.getClient(pending.clientId);
      if (!registeredClient) {
        res.status(400).send('Unknown client');
        return;
      }
      if (registeredClient.redirect_uris && !registeredClient.redirect_uris.some(uri => redirectUriMatches(pending.redirectUri, uri))) {
        res.status(400).send('Redirect URI does not match registered client');
        return;
      }

      // Exchange provider auth code for tokens
      const callbackUrl = process.env[`${config.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_OAUTH_CALLBACK_URL`]
        || `${process.env.MCP_OAUTH_ISSUER || 'http://localhost:3000'}${callbackPath}`;

      const { url: tokenUrl, init: tokenInit } = buildProviderTokenRequest(config, {
        code,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      });

      const tokenResponse = await fetch(tokenUrl, tokenInit);

      if (!tokenResponse.ok) {
        const text = await tokenResponse.text();
        console.error(`[oauth] ${config.name} token exchange failed: ${text}`);
        res.status(502).send(`Failed to exchange ${config.name} authorization code`);
        return;
      }

      const providerTokens = (await tokenResponse.json()) as TokenResponse & { refresh_token?: string };

      if (providerTokens.error || !providerTokens.access_token) {
        console.error(`[oauth] ${config.name} token error: ${providerTokens.error}`);
        res.status(502).send(`${config.name} returned an error during token exchange`);
        return;
      }

      if (!providerTokens.refresh_token && !config.tokenNeverExpires) {
        console.error(`[oauth] ${config.name} did not return a refresh token`);
        res.status(400).send(`${config.name} did not return a refresh token. You may need to revoke and re-authorize the app, or set tokenNeverExpires if this provider uses non-expiring tokens.`);
        return;
      }

      // Fetch user identity from provider
      let identity: UserIdentity;
      try {
        identity = await config.fetchUserIdentity(providerTokens.access_token);
      } catch (err) {
        console.error(`[oauth] Failed to fetch ${config.name} user info:`, err);
        res.status(502).send(`Failed to verify your ${config.name} identity`);
        return;
      }

      // Optional: authorize user (e.g. org restriction)
      if (config.authorizeUser) {
        const rejection = config.authorizeUser(identity);
        if (rejection) {
          console.log(`[oauth] Rejected user ${identity.email}: ${rejection}`);
          res.status(403).send(`Access denied. ${rejection}`);
          return;
        }
      }

      // Store user's provider tokens keyed to MCP client ID
      const expiresIn = config.tokenNeverExpires
        ? (providerTokens.expires_in || TEN_YEARS_S)
        : (providerTokens.expires_in || 3600);

      tokenStore.setUserProviderToken(pending.clientId, {
        providerRefreshToken: providerTokens.refresh_token ?? null,
        providerAccessToken: providerTokens.access_token,
        providerAccessTokenExpiry: Math.floor(Date.now() / 1000) + expiresIn,
        identity,
      });

      console.log(`[oauth] ${config.name} user verified: ${identity.email} for MCP client ${pending.clientId}`);

      // Complete MCP OAuth flow — generate auth code and redirect back to client
      const mcpAuthCode = tokenStore.createAuthCode({
        clientId: pending.clientId,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        scopes: pending.scopes,
        resource: pending.resource,
      });

      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set('code', mcpAuthCode);
      if (pending.state) {
        redirectUrl.searchParams.set('state', pending.state);
      }

      res.redirect(302, redirectUrl.toString());
    } catch (err) {
      console.error(`[oauth] ${config.name} callback error:`, err);
      res.status(500).send(`Internal error during ${config.name} authentication`);
    }
  });

  // --- Health check ---
  app.get('/health', async (_req, res) => {
    try {
      const response = await fetch(config.apiBaseUrl, { method: 'HEAD' });
      res.json({ status: 'ok', provider: config.name, reachable: response.ok });
    } catch {
      res.json({ status: 'ok', provider: config.name, reachable: false });
    }
  });

  // --- MCP endpoint (protected by OAuth 2.1 Bearer token) ---
  app.post('/mcp',
    requireBearerAuth({ verifier: oauthProvider }),
    async (req, res) => {
      const authInfo = await oauthProvider.verifyAccessToken(
        (req.headers.authorization || '').replace('Bearer ', ''),
      );

      const userTokens = tokenStore.getUserProviderToken(authInfo.clientId);
      if (!userTokens) {
        res.status(403).json({ error: `No ${config.name} credentials found for this session. Please re-authorize.` });
        return;
      }

      const client = new ProviderApiClient({
        clientId: process.env[config.env.clientId]!,
        clientSecret: process.env[config.env.clientSecret]!,
        refreshToken: userTokens.providerRefreshToken ?? userTokens.providerAccessToken ?? '',
        tokenUrl: config.auth.tokenUrl,
        apiBaseUrl: config.apiBaseUrl,
        tokenNeverExpires: config.tokenNeverExpires,
      });

      const server = createMcpServer(client);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  // --- Start function ---
  function start(port?: number) {
    const p = port ?? parseInt(process.env.PORT || '3000', 10);
    app.listen(p, host, () => {
      console.log(`${config.name} MCP server listening on port ${p}`);
      console.log(`MCP endpoint: http://localhost:${p}/mcp`);
      console.log(`Health check: http://localhost:${p}/health`);
      console.log(`OAuth issuer: ${issuerUrl.toString()}`);
    });

    // Periodic garbage collection of expired tokens (every 15 minutes)
    setInterval(() => {
      const swept = tokenStore.sweepExpired();
      if (swept > 0) {
        console.log(`[oauth] Swept ${swept} expired entries`);
      }
    }, 15 * 60 * 1000);
  }

  return { app, start, oauthProvider, tokenStore, clientsStore };
}
