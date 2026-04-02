import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
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
import { createStores } from '../oauth/store.js';
import { ProviderApiClient } from '../client/api-client.js';
import type { ProviderConfig, ProviderApiClientInterface, UserIdentity } from '../types.js';
import type { TokenResponse } from '../client/types.js';

export interface CreateBridgeServerOptions {
  config: ProviderConfig;
  /** Factory that receives a ProviderApiClient and returns an McpServer with tools registered. */
  createMcpServer: (client: ProviderApiClientInterface) => ConnectableServer;
  /** Express trust proxy setting (e.g. 1 for Railway). */
  trustProxy?: number | boolean;
  /** Host to bind to (default '0.0.0.0'). */
  host?: string;
}

export function createBridgeServer(options: CreateBridgeServerOptions) {
  const { config, createMcpServer, trustProxy, host = '0.0.0.0' } = options;

  // --- OAuth 2.1 setup ---
  const issuerUrl = new URL(process.env.MCP_OAUTH_ISSUER || 'http://localhost:3000');
  const { clientsStore, tokenStore } = createStores();
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
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
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

  // Token endpoint
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
      if (registeredClient.redirect_uris && !registeredClient.redirect_uris.includes(pending.redirectUri)) {
        res.status(400).send('Redirect URI does not match registered client');
        return;
      }

      // Exchange provider auth code for tokens
      const providerClientId = process.env[config.env.clientId]!;
      const providerClientSecret = process.env[config.env.clientSecret]!;
      const callbackUrl = process.env[`${config.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_OAUTH_CALLBACK_URL`]
        || `${process.env.MCP_OAUTH_ISSUER || 'http://localhost:3000'}${callbackPath}`;

      const tokenResponse = await fetch(config.auth.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: providerClientId,
          client_secret: providerClientSecret,
          redirect_uri: callbackUrl,
          grant_type: 'authorization_code',
        }).toString(),
      });

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

      if (!providerTokens.refresh_token) {
        console.error(`[oauth] ${config.name} did not return a refresh token`);
        res.status(400).send(`${config.name} did not return a refresh token. You may need to revoke and re-authorize the app.`);
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
      tokenStore.setUserProviderToken(pending.clientId, {
        providerRefreshToken: providerTokens.refresh_token,
        providerAccessToken: providerTokens.access_token,
        providerAccessTokenExpiry: Math.floor(Date.now() / 1000) + (providerTokens.expires_in || 3600),
        identity,
      });

      console.log(`[oauth] ${config.name} user verified: ${identity.email} for MCP client ${pending.clientId}`);

      // Complete MCP OAuth flow — generate auth code and redirect back to client
      const mcpAuthCode = tokenStore.createAuthCode({
        clientId: pending.clientId,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        scopes: pending.scopes,
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
        refreshToken: userTokens.providerRefreshToken,
        tokenUrl: config.auth.tokenUrl,
        apiBaseUrl: config.apiBaseUrl,
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
