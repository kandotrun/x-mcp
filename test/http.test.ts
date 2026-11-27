import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { TOOL_NAMES } from '../src/contract/tools';
import { VERSION } from '../src/version';
import { ENV, fakeUpstream, json } from './helpers';
import status from './fixtures/status.json';

const ORIGIN = 'https://x.mcp.test';

function mcpRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
};

describe('HTTP routes', () => {
  const app = createApp({ fetch: fakeUpstream(() => json(status)).fetch, log: () => {} });

  it('serves health with the version and upstream base', async () => {
    const response = await app.request('/health', {}, ENV);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'x-mcp', version: VERSION, upstreamBaseUrl: ENV.UPSTREAM_BASE_URL });
  });

  it('serves discovery metadata generated from the tool registry', async () => {
    const response = await app.request(`${ORIGIN}/.well-known/mcp.json`, {}, ENV);
    expect(await response.json()).toMatchObject({
      name: 'x-mcp',
      version: VERSION,
      transport: 'streamable-http',
      endpoint: `${ORIGIN}/mcp`,
      mcpServers: { x: { url: `${ORIGIN}/mcp` } },
      tools: [...TOOL_NAMES]
    });
  });

  it('serves a landing page that shows how to connect', async () => {
    const text = await (await app.request(`${ORIGIN}/`, {}, ENV)).text();
    expect(text).toContain(`claude mcp add --transport http --scope user x ${ORIGIN}/mcp`);
    expect(text).toContain('get_post {"id":"https://x.com/jack/status/20"}');
  });

  it('answers CORS preflight', async () => {
    const response = await app.request('/mcp', { method: 'OPTIONS' }, ENV);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
  });

  it.each(['GET', 'DELETE', 'PUT', 'PATCH'])('rejects %s /mcp with 405 because the server is stateless', async (method) => {
    const response = await app.request('/mcp', { method, headers: { Accept: 'text/event-stream' } }, ENV);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('speaks MCP over stateless Streamable HTTP with CORS headers', async () => {
    const init = await app.request(mcpRequest(initialize), undefined, ENV);
    expect(init.status).toBe(200);
    expect(init.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await init.json()) as { result: { serverInfo: unknown; instructions: string } };
    expect(body.result.serverInfo).toEqual({ name: 'x-mcp', version: VERSION });
    expect(body.result.instructions).toContain('read-only');

    const list = await app.request(
      mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-11-25' }),
      undefined,
      ENV
    );
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);

    const call = await app.request(
      mcpRequest(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_post', arguments: { id: '2000000000000000100' } } },
        { 'mcp-protocol-version': '2025-11-25' }
      ),
      undefined,
      ENV
    );
    const result = ((await call.json()) as { result: { content: { text: string }[] } }).result;
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ post: { id: '2000000000000000100' } });
  });

  it('refuses oversized request bodies before parsing them', async () => {
    const response = await app.request(mcpRequest('x'.repeat(70_000)), undefined, ENV);
    expect(response.status).toBe(413);
  });

  it('caps the number of elements in tool arguments', async () => {
    const args = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    const response = await app.request(
      mcpRequest(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_trends', arguments: args } },
        { 'mcp-protocol-version': '2025-11-25' }
      ),
      undefined,
      ENV
    );
    const result = ((await response.json()) as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maximum of 32 elements/);
  });

  it('bounds upstream requests for a whole JSON-RPC batch, not only per tool call', async () => {
    const fake = fakeUpstream(() => json(status));
    const batchApp = createApp({ fetch: fake.fetch, log: () => {} });
    const batch = Array.from({ length: 30 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'tools/call',
      params: { name: 'get_post', arguments: { id: '2000000000000000100' } }
    }));
    const response = await batchApp.request(mcpRequest(batch, { 'mcp-protocol-version': '2025-11-25' }), undefined, ENV);

    expect(response.status).toBe(200);
    expect(fake.urls.length).toBe(10);
    const results = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }[];
    const rejected = results.filter((entry) => entry.result.isError === true);
    expect(rejected).toHaveLength(20);
    for (const entry of rejected) expect(entry.result.content[0]!.text).toContain('already made 10 upstream requests');
  });

  it('returns a JSON 404 that points at the MCP endpoint', async () => {
    const response = await app.request(`${ORIGIN}/nope`, {}, ENV);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found', mcpEndpoint: `${ORIGIN}/mcp` });
  });
});
