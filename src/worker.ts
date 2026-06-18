import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import * as z from 'zod/v4';

const DEFAULT_UPSTREAM_BASE_URL = 'https://twitter.2-38.com/api/fx';
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_COUNT = 100;

const TOOL_NAMES = [
  'search_posts',
  'get_post',
  'get_profile',
  'get_profile_statuses',
  'get_profile_media',
  'get_trends',
  'typeahead',
  'get_openapi'
] as const;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, mcp-session-id, Last-Event-ID, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
  'Access-Control-Max-Age': '86400'
} satisfies Record<string, string>;

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  ...corsHeaders
} satisfies Record<string, string>;

type HonoBindings = {
  Bindings: Env;
};

type UpstreamResult = {
  upstreamUrl: string;
  status: number;
  data: unknown;
};

type UpstreamErrorDetails = {
  status: number;
  url: string;
  body: unknown;
};

class UpstreamError extends Error {
  readonly upstream: UpstreamErrorDetails;

  constructor(message: string, upstream: UpstreamErrorDetails) {
    super(message);
    this.name = 'UpstreamError';
    this.upstream = upstream;
  }
}

function jsonResponse(payload: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...jsonHeaders, ...Object.fromEntries(new Headers(extraHeaders)) }
  });
}

function textResponse(text: string, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders,
      ...Object.fromEntries(new Headers(extraHeaders))
    }
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function clampCount(count: number | undefined | null, fallback = 10): number {
  if (count === undefined || count === null) return fallback;
  if (!Number.isFinite(count)) return fallback;
  return Math.max(1, Math.min(MAX_COUNT, Math.trunc(count)));
}

function cleanHandle(handle: unknown): string {
  const value = String(handle ?? '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,30}$/.test(value)) {
    throw new Error('handle must be a valid X/Twitter handle without spaces');
  }
  return value;
}

function cleanStatusId(id: unknown): string {
  const value = String(id ?? '').trim();
  if (!/^[0-9]{1,30}$/.test(value)) {
    throw new Error('id must be a numeric X/Twitter status id');
  }
  return value;
}

function appendOptional(params: URLSearchParams, key: string, value: string | undefined | null): void {
  if (value === undefined || value === null || value === '') return;
  params.set(key, value);
}

function upstreamBaseUrl(env: Env): string {
  return (env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/, '');
}

async function fetchWithTimeout(url: URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url.toString(), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseUpstreamBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return response.text();
  }

  try {
    return await response.json();
  } catch {
    return { raw: await response.text() };
  }
}

async function callFxTwitter(
  env: Env,
  pathname: string,
  params = new URLSearchParams()
): Promise<UpstreamResult> {
  const url = new URL(`${upstreamBaseUrl(env)}${pathname}`);
  url.search = params.toString();

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'x-mcp/0.1 (+https://x.mcp.2-38.com)'
    },
    cf: { cacheTtl: 0 }
  });

  const body = await parseUpstreamBody(response);

  if (!response.ok) {
    throw new UpstreamError(`FxTwitter upstream returned ${response.status}`, {
      status: response.status,
      url: url.toString(),
      body
    });
  }

  return {
    upstreamUrl: url.toString(),
    status: response.status,
    data: body
  };
}

function toolJson(result: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

function toolError(error: unknown): CallToolResult {
  const payload: Record<string, unknown> = {
    error: error instanceof Error ? error.message : String(error)
  };
  if (error instanceof UpstreamError) {
    payload.upstream = error.upstream;
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  };
}

async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return toolJson(await fn());
  } catch (error) {
    return toolError(error);
  }
}

function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: 'x-mcp', version: '0.1.0' },
    {
      instructions:
        'Read-only MCP server for twitter.2-38.com. Tools call https://twitter.2-38.com/api/fx/2/... and return upstream JSON.'
    }
  );

  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  } as const;

  server.registerTool(
    'search_posts',
    {
      title: 'Search X posts via FxTwitter',
      description: 'Calls https://twitter.2-38.com/api/fx/2/search. Example: q="from:jack", feed="latest", count=10.',
      annotations: readOnlyAnnotations,
      inputSchema: {
        q: z.string().min(1).max(500).describe('FxTwitter/X search query, e.g. from:jack, #hashtag, or keywords'),
        feed: z.enum(['latest', 'top']).default('latest').describe('Search feed type'),
        count: z.number().int().min(1).max(MAX_COUNT).default(10).describe('Number of posts to request'),
        cursor: z.string().max(500).optional().describe('Optional pagination cursor from a previous response')
      }
    },
    async ({ q, feed = 'latest', count = 10, cursor }) =>
      runTool(async () => {
        const params = new URLSearchParams();
        params.set('q', q);
        params.set('feed', feed);
        params.set('count', String(clampCount(count)));
        appendOptional(params, 'cursor', cursor);
        return callFxTwitter(env, '/2/search', params);
      })
  );

  server.registerTool(
    'get_post',
    {
      title: 'Get X post by status id',
      description: 'Calls https://twitter.2-38.com/api/fx/2/status/:id.',
      annotations: readOnlyAnnotations,
      inputSchema: {
        id: z.string().regex(/^[0-9]{1,30}$/).describe('Numeric X/Twitter status id')
      }
    },
    async ({ id }) => runTool(async () => callFxTwitter(env, `/2/status/${cleanStatusId(id)}`))
  );

  server.registerTool(
    'get_profile',
    {
      title: 'Get X profile',
      description: 'Calls https://twitter.2-38.com/api/fx/2/profile/:handle.',
      annotations: readOnlyAnnotations,
      inputSchema: {
        handle: z.string().min(1).max(30).describe('X/Twitter handle, with or without @')
      }
    },
    async ({ handle }) => runTool(async () => callFxTwitter(env, `/2/profile/${cleanHandle(handle)}`))
  );

  server.registerTool(
    'get_profile_statuses',
    {
      title: 'Get profile posts',
      description: 'Calls https://twitter.2-38.com/api/fx/2/profile/:handle/statuses.',
      annotations: readOnlyAnnotations,
      inputSchema: {
        handle: z.string().min(1).max(30).describe('X/Twitter handle, with or without @'),
        count: z.number().int().min(1).max(MAX_COUNT).default(10).describe('Number of posts to request'),
        cursor: z.string().max(500).optional().describe('Optional pagination cursor from a previous response')
      }
    },
    async ({ handle, count = 10, cursor }) =>
      runTool(async () => {
        const params = new URLSearchParams();
        params.set('count', String(clampCount(count)));
        appendOptional(params, 'cursor', cursor);
        return callFxTwitter(env, `/2/profile/${cleanHandle(handle)}/statuses`, params);
      })
  );

  server.registerTool(
    'get_profile_media',
    {
      title: 'Get profile media posts',
      description: 'Calls https://twitter.2-38.com/api/fx/2/profile/:handle/media.',
      annotations: readOnlyAnnotations,
      inputSchema: {
        handle: z.string().min(1).max(30).describe('X/Twitter handle, with or without @'),
        count: z.number().int().min(1).max(MAX_COUNT).default(10).describe('Number of media posts to request'),
        cursor: z.string().max(500).optional().describe('Optional pagination cursor from a previous response')
      }
    },
    async ({ handle, count = 10, cursor }) =>
      runTool(async () => {
        const params = new URLSearchParams();
        params.set('count', String(clampCount(count)));
        appendOptional(params, 'cursor', cursor);
        return callFxTwitter(env, `/2/profile/${cleanHandle(handle)}/media`, params);
      })
  );

  server.registerTool(
    'get_trends',
    {
      title: 'Get X trends',
      description: 'Calls https://twitter.2-38.com/api/fx/2/trends.',
      annotations: readOnlyAnnotations,
      inputSchema: {
        count: z.number().int().min(1).max(MAX_COUNT).default(10).describe('Number of trends to request')
      }
    },
    async ({ count = 10 }) =>
      runTool(async () => {
        const params = new URLSearchParams();
        params.set('count', String(clampCount(count)));
        return callFxTwitter(env, '/2/trends', params);
      })
  );

  server.registerTool(
    'typeahead',
    {
      title: 'X typeahead',
      description: 'Calls https://twitter.2-38.com/api/fx/2/typeahead.',
      annotations: readOnlyAnnotations,
      inputSchema: {
        q: z.string().min(1).max(200).describe('Typeahead query'),
        count: z.number().int().min(1).max(MAX_COUNT).default(10).describe('Number of suggestions to request')
      }
    },
    async ({ q, count = 10 }) =>
      runTool(async () => {
        const params = new URLSearchParams();
        params.set('q', q);
        params.set('count', String(clampCount(count)));
        return callFxTwitter(env, '/2/typeahead', params);
      })
  );

  server.registerTool(
    'get_openapi',
    {
      title: 'Get upstream OpenAPI document',
      description: 'Calls https://twitter.2-38.com/api/fx/2/openapi.json.',
      annotations: readOnlyAnnotations,
      inputSchema: {}
    },
    async () => runTool(async () => callFxTwitter(env, '/2/openapi.json'))
  );

  return server;
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createServer(env);
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  return withCors(response);
}

function wellKnown(request: Request): Response {
  const origin = new URL(request.url).origin;
  return jsonResponse({
    name: 'x-mcp',
    description: 'Read-only MCP server for twitter.2-38.com FxTwitter API proxy.',
    transport: 'streamable-http',
    endpoint: `${origin}/mcp`,
    mcpServers: {
      x: { url: `${origin}/mcp` }
    },
    tools: TOOL_NAMES
  });
}

function landing(request: Request): Response {
  const origin = new URL(request.url).origin;
  return textResponse(`x-mcp\n\nRead-only MCP endpoint for twitter.2-38.com.\n\nMCP endpoint:\n${origin}/mcp\n\nExample upstream wrapped by search_posts:\nhttps://twitter.2-38.com/api/fx/2/search?q=from%3Ajack&feed=latest&count=10\n\nDiscovery:\n${origin}/.well-known/mcp.json\n`);
}

const app = new Hono<HonoBindings>();

app.options('*', () => new Response(null, { status: 204, headers: corsHeaders }));

app.get('/health', (c) => jsonResponse({ ok: true, service: 'x-mcp', upstreamBaseUrl: upstreamBaseUrl(c.env) }));

app.get('/.well-known/mcp.json', (c) => wellKnown(c.req.raw));

app.get('/', (c) => landing(c.req.raw));
app.get('/index.txt', (c) => landing(c.req.raw));

app.all('/mcp', async (c) => {
  if (!['POST', 'GET', 'DELETE'].includes(c.req.method)) {
    return jsonResponse(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
      405,
      { Allow: 'GET, POST, DELETE, OPTIONS' }
    );
  }
  return handleMcp(c.req.raw, c.env);
});

app.notFound((c) => jsonResponse({ error: 'not found', mcpEndpoint: `${new URL(c.req.url).origin}/mcp` }, 404));

export default app;
