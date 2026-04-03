#!/usr/bin/env node

import prompts from 'prompts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Answers {
  providerName: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  userInfoUrl: string;
  userIdPath: string;
  emailPath: string;
  apiBaseUrl: string;
  outputDir: string;
}

async function main() {
  console.log('\n  create-mcp-server — Scaffold a new MCP server with OAuth bridge\n');

  const answers = await prompts([
    {
      type: 'text',
      name: 'providerName',
      message: 'Provider name (e.g. "HubSpot", "Salesforce")',
      validate: (v: string) => v.trim().length > 0 || 'Required',
    },
    {
      type: 'text',
      name: 'authorizeUrl',
      message: 'OAuth authorization URL',
      validate: (v: string) => v.startsWith('https://') || 'Must be an HTTPS URL',
    },
    {
      type: 'text',
      name: 'tokenUrl',
      message: 'OAuth token URL',
      validate: (v: string) => v.startsWith('https://') || 'Must be an HTTPS URL',
    },
    {
      type: 'text',
      name: 'scopes',
      message: 'Scopes (comma-separated)',
      validate: (v: string) => v.trim().length > 0 || 'At least one scope required',
    },
    {
      type: 'text',
      name: 'userInfoUrl',
      message: 'User info endpoint URL (for identity after login)',
      validate: (v: string) => v.startsWith('https://') || 'Must be an HTTPS URL',
    },
    {
      type: 'text',
      name: 'userIdPath',
      message: 'JSON path to user ID in user-info response (e.g. "id", "sub", "users.0.id")',
      initial: 'id',
    },
    {
      type: 'text',
      name: 'emailPath',
      message: 'JSON path to email in user-info response (e.g. "email", "users.0.email")',
      initial: 'email',
    },
    {
      type: 'text',
      name: 'apiBaseUrl',
      message: 'API base URL for provider requests',
      validate: (v: string) => v.startsWith('https://') || 'Must be an HTTPS URL',
    },
    {
      type: 'text',
      name: 'outputDir',
      message: 'Output directory',
      initial: (prev: string, answers: Record<string, string>) =>
        `./${answers.providerName?.toLowerCase().replace(/[^a-z0-9]/g, '-')}-mcp-server`,
    },
  ]) as Answers;

  if (!answers.providerName) {
    console.log('Cancelled.');
    process.exit(1);
  }

  const slug = answers.providerName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const envPrefix = answers.providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const scopesArray = answers.scopes.split(',').map(s => s.trim());
  const dir = answers.outputDir;

  // Create directories
  mkdirSync(join(dir, 'src', 'tools'), { recursive: true });

  // package.json
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `${slug}-mcp-server`,
    version: '1.0.0',
    description: `${answers.providerName} MCP server powered by mcp-oauth-bridge`,
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      build: 'tsc',
      start: 'node --env-file=.env.local dist/index.js',
      dev: 'tsx --env-file=.env.local src/index.ts',
    },
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.27.0',
      'mcp-oauth-bridge': '^0.1.0',
      'zod': '^3.25.0',
    },
    devDependencies: {
      '@types/node': '^22.0.0',
      'tsx': '^4.19.0',
      'typescript': '^5.7.0',
    },
  }, null, 2) + '\n');

  // tsconfig.json
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src'],
  }, null, 2) + '\n');

  // .gitignore
  writeFileSync(join(dir, '.gitignore'), `node_modules/
dist/
*.tsbuildinfo
.env.local
oauth-store.json
`);

  // .env.example
  writeFileSync(join(dir, '.env.example'), `# ${answers.providerName} OAuth app credentials
${envPrefix}_CLIENT_ID=your-client-id
${envPrefix}_CLIENT_SECRET=your-client-secret

# OAuth callback URL (must match provider's redirect URI config)
${envPrefix}_OAUTH_CALLBACK_URL=http://localhost:3000/oauth/${slug}/callback

# MCP OAuth 2.1 issuer URL (public HTTPS in production)
MCP_OAUTH_ISSUER=http://localhost:3000

# Token storage path
OAUTH_STORE_PATH=./oauth-store.json

# Server port
PORT=3000

# Set to true to bypass provider API and return mock data
MOCK_MODE=false
`);

  // src/provider.config.ts
  const fetchUserIdentityCode = generateFetchUserIdentity(answers);
  writeFileSync(join(dir, 'src', 'provider.config.ts'), `import type { ProviderConfig } from 'mcp-oauth-bridge';

export const providerConfig: ProviderConfig = {
  name: '${answers.providerName}',

  auth: {
    authorizeUrl: '${answers.authorizeUrl}',
    tokenUrl: '${answers.tokenUrl}',
    scopes: [${scopesArray.map(s => `'${s}'`).join(', ')}],
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
  },

  env: {
    clientId: '${envPrefix}_CLIENT_ID',
    clientSecret: '${envPrefix}_CLIENT_SECRET',
  },

  callbackPathSegment: '${slug}',
  apiBaseUrl: '${answers.apiBaseUrl}',

${fetchUserIdentityCode}

  mcpServer: { name: '${slug}', version: '1.0.0' },
};
`);

  // src/index.ts
  writeFileSync(join(dir, 'src', 'index.ts'), `import { createBridgeServer } from 'mcp-oauth-bridge';
import { providerConfig } from './provider.config.js';
import { createServer } from './server.js';

const { start } = createBridgeServer({
  config: providerConfig,
  createMcpServer: (client) => createServer(client),
});

start();
`);

  // src/server.ts
  writeFileSync(join(dir, 'src', 'server.ts'), `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProviderApiClientInterface } from 'mcp-oauth-bridge';
import { registerExampleTool } from './tools/example.js';

export function createServer(client: ProviderApiClientInterface): McpServer {
  const server = new McpServer({ name: '${slug}', version: '1.0.0' });

  // Register your tools here
  registerExampleTool(server, client);

  return server;
}
`);

  // src/tools/example.ts
  writeFileSync(join(dir, 'src', 'tools', 'example.ts'), `import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProviderApiClientInterface } from 'mcp-oauth-bridge';
import { formatToolError } from 'mcp-oauth-bridge';

export function registerExampleTool(server: McpServer, client: ProviderApiClientInterface): void {
  server.tool(
    '${slug}_hello',
    'Example tool — replace with real ${answers.providerName} API calls',
    { name: z.string().optional().describe('Name to greet') },
    async ({ name }) => {
      try {
        // Example: make an authenticated API request to the provider
        // const data = await client.request<{ results: unknown[] }>('/api/v1/endpoint', { limit: '10' });

        return {
          content: [{ type: 'text', text: JSON.stringify({ message: \`Hello from ${answers.providerName}! Name: \${name || 'world'}\` }) }],
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
`);

  console.log(`\n  Created ${slug}-mcp-server in ${dir}\n`);
  console.log('  Next steps:');
  console.log(`    cd ${dir}`);
  console.log('    npm install');
  console.log(`    cp .env.example .env.local`);
  console.log(`    # Fill in ${envPrefix}_CLIENT_ID and ${envPrefix}_CLIENT_SECRET`);
  console.log('    npm run dev\n');
}

function generateFetchUserIdentity(answers: Answers): string {
  const { userInfoUrl, userIdPath, emailPath } = answers;

  // Generate a simple dot-path accessor
  const accessCode = (path: string, varName: string) => {
    const parts = path.split('.');
    if (parts.length === 1) {
      return `data.${parts[0]}`;
    }
    // For nested paths like "users.0.id", generate chained access
    let code = 'data';
    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        code += `[${part}]`;
      } else {
        code += `?.${part}`;
      }
    }
    return code;
  };

  return `  async fetchUserIdentity(accessToken: string) {
    const res = await fetch('${userInfoUrl}', {
      headers: { Authorization: \`Bearer \${accessToken}\` },
    });
    if (!res.ok) throw new Error('Failed to fetch user info');
    const data = (await res.json()) as Record<string, any>;
    return {
      userId: String(${accessCode(userIdPath, 'data')} || ''),
      email: String(${accessCode(emailPath, 'data')} || ''),
    };
  },`;
}

main().catch(console.error);
