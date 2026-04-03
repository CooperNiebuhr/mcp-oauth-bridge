# mcp-server-bridge

Config-driven OAuth 2.1 bridge for building MCP servers over any OAuth 2.0 provider.

Provide a single config object describing your provider's OAuth endpoints and you get a fully compliant [Model Context Protocol](https://modelcontextprotocol.io) server with PKCE, per-user credential isolation, automatic token refresh, and structured error handling — no boilerplate.

## How It Works

```
MCP Client (Claude, etc.)          mcp-server-bridge              Provider API
        │                                │                              │
        │── OAuth 2.1 + PKCE ──────────▶│                              │
        │                                │── OAuth 2.0 ───────────────▶│
        │                                │◀── access + refresh token ──│
        │◀── MCP access token ──────────│                              │
        │                                │                              │
        │── tool call (Bearer token) ──▶│                              │
        │                                │── authenticated request ───▶│
        │◀── tool result ───────────────│◀── API response ────────────│
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
    extraAuthorizeParams: {},          // optional
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

  // Optional: restrict access by org, domain, etc.
  authorizeUser(identity) {
    // Return null to allow, or an error message string to deny
    return null;
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

That's it. Three files, and you have a production-ready MCP server.

## ProviderConfig Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Human-readable provider name |
| `auth.authorizeUrl` | `string` | Yes | Provider's OAuth authorization endpoint |
| `auth.tokenUrl` | `string` | Yes | Provider's OAuth token endpoint |
| `auth.scopes` | `string[]` | Yes | Scopes to request |
| `auth.extraAuthorizeParams` | `Record<string, string>` | No | Extra query params for authorize redirect (e.g. `{ access_type: 'offline' }`) |
| `env.clientId` | `string` | Yes | Name of the env var holding the client ID |
| `env.clientSecret` | `string` | Yes | Name of the env var holding the client secret |
| `callbackPathSegment` | `string` | Yes | URL segment for callback route (`"zoho"` → `/oauth/zoho/callback`) |
| `apiBaseUrl` | `string` | Yes | Provider's API base URL |
| `fetchUserIdentity` | `(accessToken: string) => Promise<UserIdentity>` | Yes | Fetch user info after OAuth exchange |
| `authorizeUser` | `(identity: UserIdentity) => string \| null` | No | Return null to allow, error message to deny |
| `refreshTokenUrl` | `string` | No | Token refresh endpoint if different from `tokenUrl` |
| `mcpServer` | `{ name: string; version: string }` | No | MCP server metadata |

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
- Refresh the access token on 401 responses
- Implement exponential backoff on 429 rate limits (1s → 2s → 4s)
- Throw typed error classes (see below)

## Error Handling

The bridge provides typed error classes so tools can return structured errors that AI agents can reason about:

| Class | Code | Properties | When Thrown |
|-------|------|------------|------------|
| `ProviderAuthError` | `PROVIDER_AUTH_ERROR` | — | Token exchange or refresh failure |
| `ProviderRateLimitError` | `PROVIDER_RATE_LIMIT` | `retryAfter: number \| null` | 429 response from provider |
| `ProviderApiError` | `PROVIDER_API_ERROR` | `statusCode`, `responseBody` | Non-2xx response from provider |
| `ProviderNetworkError` | `PROVIDER_NETWORK_ERROR` | — | Network connectivity failure |

Use `formatToolError()` in your tool catch blocks to return MCP-compliant error responses:

```ts
import { formatToolError } from 'mcp-server-bridge';

server.tool('my_tool', 'Does something', {}, async () => {
  try {
    const data = await client.request('/endpoint');
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (err) {
    return formatToolError(err); // Returns structured { error, code, message }
  }
});
```

## Server Routes

The bridge server mounts these routes automatically:

| Route | Method | Purpose |
|-------|--------|---------|
| `/.well-known/oauth-authorization-server` | GET | OAuth 2.1 metadata discovery |
| `/.well-known/oauth-protected-resource/mcp` | GET | Protected resource metadata |
| `/register` | POST | Dynamic client registration |
| `/authorize` | GET | Authorization (redirects to provider) |
| `/token` | POST | Token endpoint |
| `/revoke` | POST | Token revocation |
| `/oauth/{provider}/callback` | GET | Provider OAuth callback |
| `/health` | GET | Health check |
| `/mcp` | POST | MCP transport (Bearer token protected) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `{PROVIDER}_CLIENT_ID` | Yes | OAuth app client ID (var name set in config) |
| `{PROVIDER}_CLIENT_SECRET` | Yes | OAuth app client secret (var name set in config) |
| `MCP_OAUTH_ISSUER` | Yes | Public URL of your server (e.g. `https://my-mcp.example.com`) |
| `OAUTH_STORE_PATH` | No | Token storage file path (default: `/data/oauth-store.json`) |
| `PORT` | No | Server port (default: `3000`) |

## Deployment

The server is a standard Express app. Deploy it anywhere Node.js runs — Railway, Fly.io, a VPS, etc.

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

## What the Bridge Handles

You don't need to implement any of this:

- **OAuth 2.1 authorization server** with PKCE (S256)
- **Dynamic client registration** per the MCP spec
- **Server-side auth state** (opaque tokens with 10-minute TTL, not base64url in the URL)
- **Per-user credential isolation** — each user gets their own provider tokens
- **Token rotation** — refresh tokens are rotated on every use
- **Automatic token refresh** — 401s trigger a transparent retry with a fresh token
- **Rate limit backoff** — exponential backoff on 429 responses
- **Token garbage collection** — expired tokens are swept every 15 minutes
- **Persistent token storage** — survives server restarts via JSON file


## License

MIT
