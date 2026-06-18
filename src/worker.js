import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as z from 'zod/v4';

const DEFAULT_UPSTREAM_BASE_URL = 'https://twitter.2-38.com/api/fx';
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_COUNT = 100;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, mcp-session-id, Last-Event-ID, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
  'Access-Control-Max-Age': '86400'
};

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  ...corsHeaders
};

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders }
  });
}

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders,
      ...extraHeaders
    }
  });
}

function clampCount(count, fallback = 10) {
  if (count === undefined || count === null) return fallback;
  if (!Number.isFinite(count)) return fallback;
  return Math.max(1, Math.min(MAX_COUNT, Math.trunc(count)));
}

function cleanHandle(handle) {
  const value = String(handle ?? '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,30}$/.test(value)) {
    throw new Error('handle must be a valid X/Twitter handle without spaces');
  }
  return value;
}

function cleanStatusId(id) {
  const value = String(id ?? '').trim();
  if (!/^[0-9]{1,30}$/.test(value)) {
    throw new Error('id must be a numeric X/Twitter status id');
  }
  return value;
}

function appendOptional(params, key, value) {
  if (value === undefined || value === null || value === '') return;
  params.set(key, String(value));
}

function upstreamBaseUrl(env) {
  return (env?.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/, '');
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callFxTwitter(env, pathname, params = new URLSearchParams()) {
  const url = new URL(`${upstreamBaseUrl(env)}${pathname}`);
  url.search = params.toString();

  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'x-mcp/0.1 (+https://x.mcp.2-38.com)'
    },
    cf: { cacheTtl: 0 }
  });

  const contentType = response.headers.get('Content-Type') || '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(async () => ({ raw: await response.text() }))
    : await response.text();

  if (!response.ok) {
    const error = new Error(`FxTwitter upstream returned ${response.status}`);
    error.upstream = { status: response.status, url: url.toString(), body };
    throw error;
  }

  return {
    upstreamUrl: url.toString(),
    status: response.status,
    data: body
  };
}

function toolJson(result) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

function toolError(error) {
  const payload = {
    error: error instanceof Error ? error.message : String(error)
  };
  if (error?.upstream) payload.upstream = error.upstream;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  };
}

async function runTool(fn) {
  try {
    return toolJson(await fn());
  } catch (error) {
    return toolError(error);
  }
}

function createServer(env) {
  const server = new McpServer(
    { name: 'x-mcp', version: '0.1.0' },
    {
      instructions: 'Read-only MCP server for twitter.2-38.com. Tools call https://twitter.2-38.com/api/fx/2/... and return upstream JSON.'
    }
  );

  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  };

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
    async ({ q, feed = 'latest', count = 10, cursor }) => runTool(async () => {
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
    async ({ handle, count = 10, cursor }) => runTool(async () => {
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
    async ({ handle, count = 10, cursor }) => runTool(async () => {
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
    async ({ count = 10 }) => runTool(async () => {
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
    async ({ q, count = 10 }) => runTool(async () => {
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

async function handleMcp(request, env) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createServer(env);
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function wellKnown(request) {
  const origin = new URL(request.url).origin;
  return jsonResponse({
    name: 'x-mcp',
    description: 'Read-only MCP server for twitter.2-38.com FxTwitter API proxy.',
    transport: 'streamable-http',
    endpoint: `${origin}/mcp`,
    mcpServers: {
      x: { url: `${origin}/mcp` }
    },
    tools: [
      'search_posts',
      'get_post',
      'get_profile',
      'get_profile_statuses',
      'get_profile_media',
      'get_trends',
      'typeahead',
      'get_openapi'
    ]
  });
}

function landing(request) {
  const origin = new URL(request.url).origin;
  return textResponse(`x-mcp\n\nRead-only MCP endpoint for twitter.2-38.com.\n\nMCP endpoint:\n${origin}/mcp\n\nExample upstream wrapped by search_posts:\nhttps://twitter.2-38.com/api/fx/2/search?q=from%3Ajack&feed=latest&count=10\n\nDiscovery:\n${origin}/.well-known/mcp.json\n`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'x-mcp', upstreamBaseUrl: upstreamBaseUrl(env) });
    }

    if (url.pathname === '/.well-known/mcp.json') {
      return wellKnown(request);
    }

    if (url.pathname === '/' || url.pathname === '/index.txt') {
      return landing(request);
    }

    if (url.pathname === '/mcp') {
      if (!['POST', 'GET', 'DELETE'].includes(request.method)) {
        return jsonResponse({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, 405, { Allow: 'GET, POST, DELETE, OPTIONS' });
      }
      return handleMcp(request, env);
    }

    return jsonResponse({ error: 'not found', mcpEndpoint: `${url.origin}/mcp` }, 404);
  }
};
