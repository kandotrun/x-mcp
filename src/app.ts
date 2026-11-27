/** HTTP surface: the stateless Streamable HTTP MCP endpoint plus health, discovery and landing routes. */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { readConfig, type ConfigEnv } from './config';
import { MAX_REQUEST_BODY_BYTES } from './contract/limits';
import { TOOL_NAMES } from './contract/tools';
import { corsHeaders, jsonResponse, textResponse, withCors } from './http';
import { createServer, type ServerDeps } from './server';
import { VERSION } from './version';

type Bindings = { Bindings: ConfigEnv };

const DESCRIPTION = 'Read-only MCP server for public X/Twitter search and retrieval via twitter.2-38.com.';

export function createApp(deps: ServerDeps = {}): Hono<Bindings> {
  const app = new Hono<Bindings>();

  app.options('*', () => new Response(null, { status: 204, headers: corsHeaders }));

  app.get('/health', (c) =>
    jsonResponse({ ok: true, service: 'x-mcp', version: VERSION, upstreamBaseUrl: readConfig(c.env).upstreamBaseUrl })
  );

  app.get('/.well-known/mcp.json', (c) => {
    const endpoint = `${new URL(c.req.url).origin}/mcp`;
    return jsonResponse({
      name: 'x-mcp',
      version: VERSION,
      description: DESCRIPTION,
      transport: 'streamable-http',
      endpoint,
      mcpServers: { x: { url: endpoint } },
      tools: TOOL_NAMES
    });
  });

  const landing = (origin: string) =>
    textResponse(
      [
        'x-mcp',
        '',
        'Read-only MCP endpoint for public X (Twitter) data via twitter.2-38.com.',
        '',
        'MCP endpoint (Streamable HTTP):',
        `${origin}/mcp`,
        '',
        'Add it to Claude Code:',
        `claude mcp add --transport http --scope user x ${origin}/mcp`,
        '',
        'Try:',
        'get_post {"id":"https://x.com/jack/status/20"}',
        '',
        'Discovery:',
        `${origin}/.well-known/mcp.json`,
        '',
        'Docs: https://github.com/kandotrun/x-mcp',
        ''
      ].join('\n')
    );
  app.get('/', (c) => landing(new URL(c.req.url).origin));
  app.get('/index.txt', (c) => landing(new URL(c.req.url).origin));

  app.post('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES
    });
    const server = createServer(c.env, deps);
    await server.connect(transport);
    return withCors(await transport.handleRequest(c.req.raw));
  });

  // Stateless server: no SSE stream to open (GET) and no session to end (DELETE).
  app.all('/mcp', () =>
    jsonResponse(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless and accepts POST only.' },
        id: null
      },
      405,
      { Allow: 'POST, OPTIONS' }
    )
  );

  app.notFound((c) => jsonResponse({ error: 'not found', mcpEndpoint: `${new URL(c.req.url).origin}/mcp` }, 404));

  return app;
}

export default createApp();
