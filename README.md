# mcp-server-bridge

Config-driven OAuth 2.1 bridge for building MCP servers over any OAuth 2.0 provider.

Provide a single config object describing your provider's OAuth endpoints and you get a fully compliant [Model Context Protocol](https://modelcontextprotocol.io) server with PKCE, dynamic client registration, per-user credential isolation, automatic token refresh, and structured error handling — no boilerplate.

## How It Works

```
 +-----------+                +------------------+              +--------------+
 |MCP Client |                |mcp-server-bridge |              | Provider API |
 +-----+-----+                +--------+---------+              +------+-------+
       |                               |                               |
       |  (A) Authorization            |                               |
       |                               |                               |
       | ---  authorize (PKCE)  -----> |                               |
       |                               | ---  redirect to login  ----> |
       |                               | <--  auth code  ------------- |
       |                               | ---  exchange code  --------> |
       |                               | <--  provider tokens  ------- |
       | <--  MCP access token  ------ |                               |
       |                               |                               |
       |  (B) Tool Execution           |                               |
       |                               |                               |
       | ---  tool call (Bearer) ----> |                               |
       |                               | ---  authenticated req  ----> |
       |                               | <--  API response  ---------  |
       | <--  tool result  ----------- |                               |
       |                               |                               |
```

The bridge translates between the MCP SDK's OAuth 2.1 requirements and your provider's OAuth 2.0 flow. Your code only defines the provider config and tool handlers.

## Quick Start

Scaffold a new MCP server project interactively:

```bash
npx mcp-server-bridge
```

You'll be prompted for your provider's OAuth URLs, scopes, and user-info endpoint. The CLI generates a complete project with everything wired up.

Then:

```bash
cd your-provider-mcp-server
npm install
cp .env.example .env.local
# Fill in your OAuth client ID and secret
npm run dev
```

## Manual Setup

```bash
npm install mcp-server-bridge @modelcontextprotocol/sdk
```

### 1. Define your provider config

```ts
// src/provider.config.ts
import type { ProviderConfig } from 'mcp-server-bridge';

export const config: ProviderConfig = {
  name: 'HubSpot',

  auth: {
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    scopes: ['crm.objects.contacts.read'],
  },

  env: {
    clientId: 'HUBSPOT_CLIENT_ID',     // env var name, not the value
    clientSecret: 'HUBSPOT_CLIENT_SECRET',
  },

  callbackPathSegment: 'hubspot',      // → /oauth/hubspot/callback
  apiBaseUrl: 'https://api.hubapi.com',

  async fetchUserIdentity(accessToken) {
    const res = await fetch('https://api.hubapi.com/oauth/v1/access-tokens/' + accessToken);
    if (!res.ok) throw new Error('Failed to fetch user info');
    const data = await res.json() as { user_id: string; user: string };
    return { userId: String(data.user_id), email: data.user };
  },

  mcpServer: { name: 'hubspot', version: '1.0.0' },
};
```

### 2. Register your tools

```ts
// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProviderApiClientInterface } from 'mcp-server-bridge';
import { z } from 'zod';
import { formatToolError } from 'mcp-server-bridge';

export function createServer(client: ProviderApiClientInterface): McpServer {
  const server = new McpServer({ name: 'hubspot', version: '1.0.0' });

  server.tool(
    'hubspot_list_contacts',
    'List contacts from HubSpot CRM',
    { limit: z.number().optional().describe('Max results (default 10)') },
    async ({ limit }) => {
      try {
        const data = await client.request<{ results: unknown[] }>(
          '/crm/v3/objects/contacts',
          { limit: String(limit || 10) },
        );
        return { content: [{ type: 'text', text: JSON.stringify(data.results) }] };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  return server;
}
```

### 3. Start the server

```ts
// src/index.ts
import { createBridgeServer } from 'mcp-server-bridge';
import { config } from './provider.config.js';
import { createServer } from './server.js';

const { start } = createBridgeServer({
  config,
  createMcpServer: (client) => createServer(client),
});

start();
```

Three files, and you have a production-ready MCP server.

## ProviderConfig Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Human-readable provider name |
| `auth.authorizeUrl` | `string` | Yes | Provider's OAuth authorization endpoint |
| `auth.tokenUrl` | `string` | Yes | Provider's OAuth token endpoint |
| `auth.scopes` | `string[]` | Yes | Scopes to request |
| `auth.scopeDelimiter` | `string` | No | Delimiter for joining scopes in the authorize URL (default: `' '` per RFC 6749 &sect;3.3). Set to `','` for providers like Zoho that use comma-separated scopes. |
| `auth.extraAuthorizeParams` | `Record<string, string>` | No | Extra query params for authorize redirect (e.g. `{ access_type: 'offline' }`) |
| `env.clientId` | `string` | Yes | Name of the env var holding the client ID |
| `env.clientSecret` | `string` | Yes | Name of the env var holding the client secret |
| `callbackPathSegment` | `string` | Yes | URL segment for callback route (`"zoho"` &rarr; `/oauth/zoho/callback`) |
| `apiBaseUrl` | `string` | Yes | Provider's API base URL |
| `fetchUserIdentity` | `(accessToken: string) => Promise<UserIdentity>` | Yes | Fetch user info after OAuth exchange |
| `authorizeUser` | `(identity: UserIdentity) => string \| null` | No | Return null to allow, error message to deny |
| `refreshTokenUrl` | `string` | No | Token refresh endpoint if different from `tokenUrl` |
| `mcpServer` | `{ name: string; version: string }` | No | MCP server metadata |
| `m2m` | `{ getProviderCredentials, scopes? }` | No | Machine-to-machine config (see [M2M Auth](#machine-to-machine-auth) below) |

## Machine-to-Machine Auth

For non-interactive clients (CI pipelines, headless agents), the bridge supports the `client_credentials` grant type. Configure it with the `m2m` option:

```ts
const config: ProviderConfig = {
  // ... standard config ...

  m2m: {
    // Return provider credentials for M2M access.
    // These might come from a service account, a stored token, etc.
    async getProviderCredentials() {
      return {
        accessToken: process.env.SERVICE_ACCOUNT_TOKEN!,
        refreshToken: process.env.SERVICE_ACCOUNT_REFRESH!,
        expiresIn: 3600,
      };
    },
    // Optional: restrict M2M clients to a subset of scopes
    scopes: ['read'],
  },
};
```

M2M clients authenticate by POSTing to `/token` with `grant_type=client_credentials`:

```bash
curl -X POST https://your-bridge.example.com/token \
  -d grant_type=client_credentials \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET
```

> **Note:** The MCP SDK's token handler does not support `client_credentials` server-side, so the bridge installs a thin middleware that intercepts this grant type before the SDK handler runs. All other grant types (`authorization_code`, `refresh_token`) pass through to the SDK unchanged.

## Custom Storage Backends

By default, the bridge uses in-memory Maps with JSON file persistence (configured via `OAUTH_STORE_PATH`). For production deployments that need horizontal scaling or durability, you can inject your own storage:

```ts
import { createBridgeServer } from 'mcp-server-bridge';
import type { ClientsStore, TokenStore } from 'mcp-server-bridge';

const myClientsStore: ClientsStore = { /* your Redis/Postgres/DynamoDB impl */ };
const myTokenStore: TokenStore = { /* your Redis/Postgres/DynamoDB impl */ };

const { start } = createBridgeServer({
  config,
  createMcpServer: (client) => createServer(client),
  stores: { clientsStore: myClientsStore, tokenStore: myTokenStore },
});
```

The `ClientsStore` and `TokenStore` interfaces are exported from the package. The `ClientsStore` interface extends the MCP SDK's `OAuthRegisteredClientsStore`, so implementations are directly compatible with the SDK's registration and auth handlers.

Record types (`AuthCodeRecord`, `AccessTokenRecord`, `RefreshTokenRecord`, `PendingAuthRecord`) are also exported for use in custom store implementations.

## API Client

Every tool handler receives a `ProviderApiClientInterface` with four methods for making authenticated requests to the provider API:

```ts
client.request<T>(endpoint, params?)   // GET
client.create<T>(endpoint, body)       // POST
client.update<T>(endpoint, body)       // PUT
client.remove<T>(endpoint, params?)    // DELETE
```

All methods automatically:
- Include the Bearer authorization header
- Refresh the access token on 401 responses (one transparent retry)
- Implement exponential backoff on 429 rate limits (1s, 2s, 4s)
- Throw typed error classes (see below)

## Error Handling

The bridge provides typed error classes so tools can return structured errors that AI agents can reason about:

| Class | Code | Properties | When Thrown |
|-------|------|------------|------------|
| `ProviderAuthError` | `PROVIDER_AUTH_ERROR` | &mdash; | Token exchange or refresh failure |
| `ProviderRateLimitError` | `PROVIDER_RATE_LIMIT` | `retryAfter: number \| null` | 429 after all retries exhausted |
| `ProviderApiError` | `PROVIDER_API_ERROR` | `statusCode`, `responseBody` | Non-2xx response from provider |
| `ProviderNetworkError` | `PROVIDER_NETWORK_ERROR` | &mdash; | Network connectivity failure |

Use `formatToolError()` in your tool catch blocks to return MCP-compliant error responses:

```ts
import { formatToolError } from 'mcp-server-bridge';

server.tool('my_tool', 'Does something', {}, async () => {
  try {
    const data = await client.request('/endpoint');
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (err) {
    return formatToolError(err);
  }
});
```

## Server Routes

The bridge server mounts these routes automatically:

| Route | Method | Purpose |
|-------|--------|---------|
| `/.well-known/oauth-authorization-server` | GET | OAuth 2.1 metadata discovery (CORS enabled) |
| `/.well-known/oauth-protected-resource/mcp` | GET | Protected resource metadata (CORS enabled) |
| `/register` | POST | Dynamic client registration (rate limited) |
| `/authorize` | GET | Authorization (redirects to provider, rate limited) |
| `/token` | POST | Token endpoint (CORS enabled, rate limited) |
| `/revoke` | POST | Token revocation (CORS enabled, rate limited) |
| `/oauth/{provider}/callback` | GET | Provider OAuth callback |
| `/health` | GET | Health check |
| `/mcp` | POST | MCP transport (Bearer token protected) |

All OAuth endpoints include rate limiting and CORS support via the MCP SDK's built-in handlers. The `/authorize` handler validates redirect URIs per [RFC 8252 &sect;7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3), allowing any port for loopback addresses to support native MCP clients.

## OAuth 2.1 Compliance

The bridge implements these OAuth 2.1 and related spec requirements:

- **PKCE (S256)** &mdash; enforced on all authorization code flows
- **Dynamic client registration** &mdash; [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)
- **Token rotation** &mdash; refresh tokens are rotated on every use
- **Resource indicators** &mdash; [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707) passed through the full auth flow
- **Token revocation** &mdash; [RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)
- **Authorization server metadata** &mdash; [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)
- **Protected resource metadata** &mdash; [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)
- **Redirect URI validation** &mdash; [RFC 8252 &sect;7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3) with loopback port flexibility
- **Scope in token responses** &mdash; [RFC 6749 &sect;5.1](https://datatracker.ietf.org/doc/html/rfc6749#section-5.1)
- **Provider token lifecycle** &mdash; MCP token refresh verifies upstream credentials still exist

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `{PROVIDER}_CLIENT_ID` | Yes | OAuth app client ID (var name set in config) |
| `{PROVIDER}_CLIENT_SECRET` | Yes | OAuth app client secret (var name set in config) |
| `MCP_OAUTH_ISSUER` | Yes | Public URL of your server (e.g. `https://my-mcp.example.com`) |
| `OAUTH_STORE_PATH` | No | Token storage file path (default: `/data/oauth-store.json`). Not used when custom stores are provided. |
| `PORT` | No | Server port (default: `3000`) |

## Deployment

The server is a standard Express app. Deploy it anywhere Node.js runs &mdash; Railway, Fly.io, a VPS, etc.

**Requirements:**
- HTTPS in production (required by OAuth 2.1)
- `MCP_OAUTH_ISSUER` must be the public HTTPS URL
- Provider OAuth app's redirect URI must match your callback URL

**Behind a reverse proxy:**

```ts
const { start } = createBridgeServer({
  config,
  createMcpServer: (client) => createServer(client),
  trustProxy: 1, // Trust one level of proxy (Railway, Nginx, etc.)
});
```

## Testing

```bash
npm test          # Run all tests
npm run test:watch # Watch mode
```

The test suite covers the OAuth token store, provider flow, API client retry logic, token manager caching, and server integration (metadata, registration, token exchange, M2M, bearer auth).

## License

MIT
