import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server';
import type { FetchLike } from '../src/upstream/client';
import status from './fixtures/status.json';
import statuses from './fixtures/statuses.json';

export const UPSTREAM = 'https://upstream.test/api/fx';
export const ENV = { UPSTREAM_BASE_URL: UPSTREAM, SEARCH_ENABLED: 'false' };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A fake upstream: `route` maps each requested URL to a response. Records every URL it was asked for. */
export function fakeUpstream(route: (url: URL) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    urls.push(url);
    return route(url);
  };
  return { fetch, urls, paths: () => urls.map((url) => `${url.pathname.replace('/api/fx', '')}${url.search}`) };
}

export async function connect(fetch: FetchLike, env: Record<string, string> = ENV) {
  const server = createServer(env, { fetch, log: () => {} });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export type ToolOutcome = { isError: boolean; text: string; data: Record<string, unknown> };

export async function call(client: Client, name: string, args?: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool(args === undefined ? { name } : { name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content[0]?.text ?? '';
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // leave data empty; tests assert on it
  }
  return { isError: result.isError === true, text, data };
}

/** A synthetic 20-item upstream timeline page built from the fictional fixtures (ids 3000000000000000120 down). */
export function timelinePage(options: { size?: number; startId?: bigint; bottom?: string; longText?: boolean } = {}) {
  const size = options.size ?? 20;
  const start = options.startId ?? 3000000000000000120n;
  const templates = [status.status, ...statuses.results];
  const results = Array.from({ length: size }, (_, i) => {
    const template = structuredClone(templates[i % templates.length]!) as Record<string, unknown>;
    const id = String(start - BigInt(i));
    template.id = id;
    template.url = `https://x.com/example_dev/status/${id}`;
    if (options.longText && i === 3) template.text = 'long '.repeat(300);
    return template;
  });
  return { code: 200, results, cursor: { top: 'TOP', bottom: options.bottom ?? 'BOTTOM-1' } };
}
